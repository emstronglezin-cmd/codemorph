// ============================================================
// CodeMorph AI Engine — File Chunker
// PHASE 28: Découpage et réassemblage des gros fichiers sources
//
// PROBLÈME:
//   Quand un fichier source dépasse la limite du modèle LLM (2048-8192 tokens),
//   le LLM résume/compresse le fichier (576 lignes → 125 lignes).
//   Ce comportement est INTERDIT.
//
// SOLUTION:
//   1. Détecter si un fichier dépasse la limite par tier
//   2. Découper en blocs logiques (classes, fonctions, méthodes)
//   3. Convertir chaque bloc indépendamment
//   4. Réassembler les blocs en préservant toute la logique
//   5. Vérifier que le résultat est complet (pas de perte)
//
// RÈGLE ABSOLUE:
//   Si une fonction ne peut pas être convertie → créer un TODO clair
//   JAMAIS produire une version simplifiée ou supprimée
// ============================================================

import type { AIProvider, ChatMessage } from './ai-provider';
import { cleanLLMOutput } from './output-cleaner';

// ── Seuils de chunking par tier ────────────────────────────────────────────
// Ces valeurs correspondent aux limites réelles des modèles
export const CHUNK_THRESHOLDS = {
  'static':       0,       // pas de génération
  'free-groq':    3_000,   // ~750 tokens — Groq est très limité
  'platform':     12_000,  // ~3000 tokens
  'pro-openai':   30_000,  // ~7500 tokens
  'pro-anthropic':30_000,  // ~7500 tokens
} as const;

// ── Types ──────────────────────────────────────────────────────────────────

export interface SourceChunk {
  index:     number;       // index du chunk (0-based)
  content:   string;       // contenu du chunk
  startLine: number;       // ligne de début dans le fichier original
  endLine:   number;       // ligne de fin dans le fichier original
  type:      ChunkType;    // type de bloc
  name:      string;       // nom identifiant (ex: "MyClass", "fetchUser")
  language:  string;       // 'dart' | 'typescript' | 'kotlin' | etc.
}

export type ChunkType =
  | 'class'
  | 'function'
  | 'method'
  | 'interface'
  | 'enum'
  | 'import-block'
  | 'export-block'
  | 'module'
  | 'namespace'
  | 'constant-block'
  | 'comment-block'
  | 'misc';

export interface ChunkConversionResult {
  chunk:        SourceChunk;
  converted:    string;
  success:      boolean;
  tokensUsed:   number;
  error?:       string;
  hasTodoFallback: boolean; // true si une fonction ne pouvait pas être convertie
}

export interface AssemblyResult {
  content:          string;  // fichier complet réassemblé
  totalChunks:      number;
  successfulChunks: number;
  failedChunks:     number;
  todosInserted:    number;  // nombre de TODO insérés pour fonctions non-convertibles
  sourceLines:      number;
  generatedLines:   number;
  preservationRatio: number; // % de logique préservée
}

// ============================================================
// DÉTECTEUR DE BLOCS LOGIQUES
// Découpe un fichier source en unités logiques indépendantes
// ============================================================

/**
 * Découpe un fichier source en chunks logiques
 * Supporte: Dart, TypeScript, JavaScript, Kotlin, Swift
 */
export function chunkSourceFile(
  content:  string,
  language: string,
  fileName?: string,
): SourceChunk[] {
  const lines  = content.split('\n');
  const chunks: SourceChunk[] = [];

  // ── Import block ──────────────────────────────────────────
  const importLines: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (
      trimmed.startsWith('import ') ||
      trimmed.startsWith('export { ') ||
      trimmed.startsWith('// ignore:') ||
      trimmed.startsWith('// @dart') ||
      !trimmed
    ) {
      if (trimmed) importLines.push(line);
      i++;
    } else {
      break;
    }
  }

  if (importLines.length > 0) {
    chunks.push({
      index:     0,
      content:   importLines.join('\n'),
      startLine: 0,
      endLine:   importLines.length - 1,
      type:      'import-block',
      name:      'imports',
      language,
    });
  }

  // ── Blocs logiques (classes, fonctions, enums) ────────────
  const remainingLines = lines.slice(i);
  const logicalBlocks = extractLogicalBlocks(remainingLines, language, i, fileName);
  chunks.push(...logicalBlocks);

  console.log(`[FileChunker] ${fileName ?? language}: ${chunks.length} chunks extracted from ${lines.length} lines`);
  chunks.forEach((c, idx) => {
    const lineCount = c.content.split('\n').length;
    console.log(`  [${idx}] ${c.type} "${c.name}" — ${lineCount} lines (L${c.startLine}-${c.endLine})`);
  });

  return chunks;
}

/**
 * Extrait les blocs logiques d'un ensemble de lignes
 * Utilise la détection de profondeur de parenthèses/accolades
 */
function extractLogicalBlocks(
  lines:    string[],
  language: string,
  lineOffset: number,
  _fileName?: string,
): SourceChunk[] {
  const blocks: SourceChunk[] = [];
  let chunkIndex = 1; // 0 est réservé pour les imports

  let i = 0;
  while (i < lines.length) {
    const line      = lines[i] ?? '';
    const trimmed   = line.trim();

    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      i++;
      continue;
    }

    // Détecter le début d'un bloc logique
    const blockDef = detectBlockStart(trimmed, language);
    if (!blockDef) {
      i++;
      continue;
    }

    // Trouver la fin du bloc (matching braces)
    const blockLines: string[] = [];
    const startIdx = i;
    let depth = 0;
    let inBlock = false;

    // Récupérer les lignes de commentaire avant le bloc
    let commentStart = startIdx;
    while (commentStart > 0) {
      const prevLine = (lines[commentStart - 1] ?? '').trim();
      if (prevLine.startsWith('//') || prevLine.startsWith('*') || prevLine.startsWith('/*') || prevLine.startsWith('*/') || !prevLine) {
        commentStart--;
      } else {
        break;
      }
    }

    // Inclure les commentaires précédents
    for (let c = commentStart; c < startIdx; c++) {
      blockLines.push(lines[c] ?? '');
    }

    while (i < lines.length) {
      const currentLine = lines[i] ?? '';
      blockLines.push(currentLine);

      // Compter les accolades/parenthèses pour Dart/TS/Kotlin
      for (const char of currentLine) {
        if (char === '{' || (language === 'dart' && char === '(')) {
          if (char === '{') { depth++; inBlock = true; }
        }
        if (char === '}') {
          if (depth > 0) depth--;
        }
      }

      // Fin du bloc quand depth = 0 et on a déjà ouvert
      if (inBlock && depth === 0) {
        i++;
        break;
      }

      // Dart: fin de fonction par ';' au niveau 0
      if (!inBlock && language === 'dart' && currentLine.trim().endsWith(';')) {
        i++;
        break;
      }

      i++;
    }

    if (blockLines.length > 0) {
      blocks.push({
        index:     chunkIndex++,
        content:   blockLines.join('\n'),
        startLine: lineOffset + commentStart,
        endLine:   lineOffset + i - 1,
        type:      blockDef.type,
        name:      blockDef.name,
        language,
      });
    }
  }

  return blocks;
}

interface BlockStartInfo {
  type: ChunkType;
  name: string;
}

/**
 * Détecte si une ligne marque le début d'un bloc logique
 */
function detectBlockStart(trimmed: string, language: string): BlockStartInfo | null {
  // ── TypeScript / JavaScript ──────────────────────────────
  if (['typescript', 'javascript', 'tsx', 'jsx'].includes(language)) {
    // Classe
    const classMatch = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
    if (classMatch?.[1]) return { type: 'class', name: classMatch[1] };

    // Interface
    const interfaceMatch = trimmed.match(/^(?:export\s+)?interface\s+(\w+)/);
    if (interfaceMatch?.[1]) return { type: 'interface', name: interfaceMatch[1] };

    // Enum
    const enumMatch = trimmed.match(/^(?:export\s+)?(?:const\s+)?enum\s+(\w+)/);
    if (enumMatch?.[1]) return { type: 'enum', name: enumMatch[1] };

    // Fonction exportée
    const funcMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
    if (funcMatch?.[1]) return { type: 'function', name: funcMatch[1] };

    // Arrow function const
    const arrowMatch = trimmed.match(/^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(/);
    if (arrowMatch?.[1]) return { type: 'function', name: arrowMatch[1] };

    // Type alias
    const typeMatch = trimmed.match(/^(?:export\s+)?type\s+(\w+)\s*=/);
    if (typeMatch?.[1]) return { type: 'interface', name: typeMatch[1] };

    // Namespace / Module
    const nsMatch = trimmed.match(/^(?:export\s+)?(?:namespace|module)\s+(\w+)/);
    if (nsMatch?.[1]) return { type: 'namespace', name: nsMatch[1] };
  }

  // ── Dart ────────────────────────────────────────────────
  if (language === 'dart') {
    // Classe
    const classMatch = trimmed.match(/^(?:abstract\s+)?class\s+(\w+)/);
    if (classMatch?.[1]) return { type: 'class', name: classMatch[1] };

    // Enum
    const enumMatch = trimmed.match(/^enum\s+(\w+)/);
    if (enumMatch?.[1]) return { type: 'enum', name: enumMatch[1] };

    // Mixin
    const mixinMatch = trimmed.match(/^mixin\s+(\w+)/);
    if (mixinMatch?.[1]) return { type: 'class', name: mixinMatch[1] };

    // Extension
    const extMatch = trimmed.match(/^extension\s+(\w+)/);
    if (extMatch?.[1]) return { type: 'class', name: extMatch[1] };

    // Top-level function
    const funcMatch = trimmed.match(/^(?:Future|void|String|int|double|bool|List|Map|Widget|dynamic)\s+(\w+)\s*\(/);
    if (funcMatch?.[1]) return { type: 'function', name: funcMatch[1] };
  }

  // ── Kotlin ──────────────────────────────────────────────
  if (language === 'kotlin') {
    const classMatch = trimmed.match(/^(?:data\s+|sealed\s+|abstract\s+|open\s+)?class\s+(\w+)/);
    if (classMatch?.[1]) return { type: 'class', name: classMatch[1] };

    const funcMatch = trimmed.match(/^(?:suspend\s+)?fun\s+(\w+)/);
    if (funcMatch?.[1]) return { type: 'function', name: funcMatch[1] };

    const objectMatch = trimmed.match(/^(?:companion\s+)?object\s+(\w+)/);
    if (objectMatch?.[1]) return { type: 'class', name: objectMatch[1] };
  }

  return null;
}

// ============================================================
// CONVERTISSEUR DE CHUNK PAR CHUNK
// ============================================================

/**
 * Convertit un chunk source en code cible via le LLM
 * Si la conversion échoue → insère un TODO structuré (jamais suppression)
 */
export async function convertChunk(
  chunk:           SourceChunk,
  ai:              AIProvider,
  targetFramework: string,
  sourceFramework: string,
  fileContext:     string,  // nom du fichier et rôle
  irContext?:      string,  // contexte IR optionnel
): Promise<ChunkConversionResult> {
  const tier = ai.getTier();

  // Static tier → TODO fallback immédiat
  if (tier === 'static') {
    return {
      chunk,
      converted:      generateTodoFallback(chunk, targetFramework),
      success:        false,
      tokensUsed:     0,
      hasTodoFallback: true,
      error:          'Static tier — no LLM conversion possible',
    };
  }

  // Imports → convertir directement (simple mapping)
  if (chunk.type === 'import-block') {
    const converted = convertImports(chunk.content, sourceFramework, targetFramework);
    return { chunk, converted, success: true, tokensUsed: 0, hasTodoFallback: false };
  }

  // Construire le prompt de conversion du chunk
  const systemPrompt = buildChunkSystemPrompt(targetFramework, sourceFramework);
  const userPrompt   = buildChunkUserPrompt(chunk, targetFramework, fileContext, irContext);

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: userPrompt   },
  ];

  const maxTokens = Math.min(2048, Math.ceil(chunk.content.split('\n').length * 15));

  try {
    const response = await ai.chat(messages, maxTokens);
    const raw      = response.content ?? '';
    const cleaned  = cleanLLMOutput(raw, `chunk:${chunk.name}`).content;

    if (!cleaned || cleaned.trim().length < 20) {
      // Réponse vide → TODO fallback
      console.warn(`[FileChunker] Empty LLM response for chunk "${chunk.name}" → TODO fallback`);
      return {
        chunk,
        converted:       generateTodoFallback(chunk, targetFramework),
        success:         false,
        tokensUsed:      response.tokensUsed,
        hasTodoFallback: true,
        error:           'Empty LLM response',
      };
    }

    return {
      chunk,
      converted:       cleaned,
      success:         true,
      tokensUsed:      response.tokensUsed,
      hasTodoFallback: false,
    };

  } catch (err) {
    const error = (err as Error).message;
    console.error(`[FileChunker] Chunk conversion failed for "${chunk.name}": ${error} → TODO fallback`);

    return {
      chunk,
      converted:       generateTodoFallback(chunk, targetFramework),
      success:         false,
      tokensUsed:      0,
      hasTodoFallback: true,
      error,
    };
  }
}

// ============================================================
// ASSEMBLEUR DE CHUNKS CONVERTIS
// ============================================================

/**
 * Réassemble les chunks convertis en un fichier complet
 * Garantit la préservation de toute la logique (via TODOs si nécessaire)
 */
export function assembleChunks(
  results:    ChunkConversionResult[],
  _targetFramework: string,
  originalLines: number,
): AssemblyResult {
  const parts: string[] = [];
  let todosInserted     = 0;
  let successfulChunks  = 0;
  let failedChunks      = 0;

  for (const result of results) {
    if (result.hasTodoFallback) {
      todosInserted++;
      failedChunks++;
    } else {
      successfulChunks++;
    }
    parts.push(result.converted);
  }

  // Réassembler avec séparateurs de section clairs
  const assembled = parts.join('\n\n');
  const generatedLines = assembled.split('\n').length;

  // Calcul du ratio de préservation
  // Un TODO compte comme 50% préservé (logique marquée mais non convertie)
  const todoWeight = 0.5;
  const preservationRatio = results.length === 0 ? 1
    : (successfulChunks + failedChunks * todoWeight) / results.length;

  const result: AssemblyResult = {
    content:          assembled,
    totalChunks:      results.length,
    successfulChunks,
    failedChunks,
    todosInserted,
    sourceLines:      originalLines,
    generatedLines,
    preservationRatio: Math.min(1, preservationRatio),
  };

  console.log(`[FileChunker] Assembly: ${successfulChunks}/${results.length} chunks ok, ${todosInserted} TODOs, ${generatedLines}/${originalLines} lines`);

  return result;
}

// ============================================================
// PIPELINE PRINCIPAL: convertLargeFile
// Orchestration complète: détect → chunk → convert → assemble
// ============================================================

/**
 * Convertit un grand fichier source en le découpant en chunks
 * C'est la fonction principale à appeler depuis code-planner.ts
 *
 * @param sourceContent  Contenu du fichier source
 * @param sourceLanguage 'dart' | 'typescript' | 'kotlin'
 * @param targetFramework 'react-native' | 'react' | 'nestjs'
 * @param sourceFramework 'flutter' | 'angular' | etc.
 * @param ai             AIProvider instance
 * @param fileContext    Description du fichier (path + rôle)
 * @param irContext      Contexte IR optionnel pour guider la conversion
 */
export async function convertLargeFile(
  sourceContent:   string,
  sourceLanguage:  string,
  targetFramework: string,
  sourceFramework: string,
  ai:              AIProvider,
  fileContext:     string,
  irContext?:      string,
): Promise<AssemblyResult> {
  const tier      = ai.getTier();
  const threshold = CHUNK_THRESHOLDS[tier] ?? CHUNK_THRESHOLDS['platform'];
  const lines     = sourceContent.split('\n');

  console.log(`[FileChunker] convertLargeFile — ${fileContext}: ${lines.length} lines, tier=${tier}, threshold=${threshold} chars`);

  // ── Cas 1: Fichier dans les limites → conversion directe ──
  if (sourceContent.length <= threshold) {
    console.log(`[FileChunker] File within limit (${sourceContent.length} <= ${threshold}) — no chunking needed`);
    // Retourner un résultat factice signalant qu'il faut la conversion normale
    return {
      content:          '',  // vide = signal pour caller d'utiliser la conversion directe
      totalChunks:      0,
      successfulChunks: 0,
      failedChunks:     0,
      todosInserted:    0,
      sourceLines:      lines.length,
      generatedLines:   0,
      preservationRatio: 1,
    };
  }

  console.log(`[FileChunker] ⚠️  Large file detected (${sourceContent.length} > ${threshold} chars) — chunking required`);

  // ── Cas 2: Fichier trop grand → découper en chunks ────────
  const chunks = chunkSourceFile(sourceContent, sourceLanguage, fileContext);

  if (chunks.length === 0) {
    // Impossible de découper → conversion par tranches naïves
    return convertByNaiveChunks(sourceContent, ai, targetFramework, sourceFramework, fileContext, threshold, irContext);
  }

  // ── Convertir chaque chunk ────────────────────────────────
  const results: ChunkConversionResult[] = [];

  for (const chunk of chunks) {
    console.log(`[FileChunker] Converting chunk ${chunk.index + 1}/${chunks.length}: ${chunk.type} "${chunk.name}" (${chunk.content.length} chars)`);

    const result = await convertChunk(
      chunk, ai, targetFramework, sourceFramework, fileContext, irContext,
    );
    results.push(result);

    // Pause entre les chunks pour respecter les rate limits Groq
    if (tier === 'free-groq' && chunk.index < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // ── Assembler les chunks convertis ───────────────────────
  return assembleChunks(results, targetFramework, lines.length);
}

// ── Conversion naïve par tranches de taille fixe ───────────────────────────
async function convertByNaiveChunks(
  sourceContent:   string,
  ai:              AIProvider,
  targetFramework: string,
  sourceFramework: string,
  fileContext:     string,
  chunkSize:       number,
  irContext?:      string,
): Promise<AssemblyResult> {
  const lines  = sourceContent.split('\n');
  const linesPerChunk = Math.max(30, Math.floor(chunkSize / 80)); // ~80 chars/line average

  const naiveChunks: SourceChunk[] = [];
  let chunkIdx = 0;

  for (let i = 0; i < lines.length; i += linesPerChunk) {
    const chunkLines = lines.slice(i, i + linesPerChunk);
    naiveChunks.push({
      index:     chunkIdx++,
      content:   chunkLines.join('\n'),
      startLine: i,
      endLine:   Math.min(i + linesPerChunk - 1, lines.length - 1),
      type:      'misc',
      name:      `section_${chunkIdx}`,
      language:  'unknown',
    });
  }

  console.log(`[FileChunker] Naive chunking: ${naiveChunks.length} chunks of ~${linesPerChunk} lines each`);

  const results: ChunkConversionResult[] = [];
  for (const chunk of naiveChunks) {
    const result = await convertChunk(chunk, ai, targetFramework, sourceFramework, fileContext, irContext);
    results.push(result);

    if (ai.getTier() === 'free-groq') {
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  return assembleChunks(results, targetFramework, lines.length);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Génère un TODO structuré pour les chunks non convertibles
 * RÈGLE: jamais supprimer — toujours marquer clairement
 */
function generateTodoFallback(chunk: SourceChunk, targetFramework: string): string {
  const lineCount = chunk.content.split('\n').length;
  const lang = targetFramework === 'nestjs' ? 'typescript' : 'typescript';

  return `// ============================================================
// TODO(codeMorph): CONVERSION INCOMPLETE — ${chunk.type.toUpperCase()} "${chunk.name}"
// Source: ${chunk.language} ${chunk.type} — ${lineCount} lines (L${chunk.startLine}-${chunk.endLine})
// Reason: Could not convert automatically (model limit or complexity)
// Action Required: Manual conversion needed
// Original logic preserved below as reference comment
// ============================================================

/*
 * ORIGINAL SOURCE (${chunk.language}):
${chunk.content.split('\n').map((l) => ` * ${l}`).join('\n')}
 */

// TODO: Implement ${chunk.name} in ${targetFramework}/${lang}
// The original ${chunk.type} had the following structure:
// - Name: ${chunk.name}
// - Type: ${chunk.type}
// - Lines: ${lineCount}
// Preserve ALL business logic from the original source above.
`;
}

/**
 * Convertit les imports d'un langage source vers le langage cible
 * Mapping statique — ne nécessite pas de LLM
 */
function convertImports(
  dartImports:   string,
  sourceFramework: string,
  targetFramework: string,
): string {
  const lines   = dartImports.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // ── Dart → React Native mappings ────────────────────────
    if (sourceFramework.toLowerCase().includes('flutter') || trimmed.startsWith('import \'package:')) {
      const converted = convertDartImport(trimmed, targetFramework);
      if (converted) result.push(converted);
      continue;
    }

    // ── Imports génériques → conserver avec adaptation ──────
    result.push(`// Original import: ${trimmed}`);
  }

  return result.join('\n');
}

function convertDartImport(dartImport: string, targetFramework: string): string | null {
  // Extraire le package
  const packageMatch = dartImport.match(/^import '([^']+)'/);
  if (!packageMatch?.[1]) return `// ${dartImport}`;

  const pkg = packageMatch[1];

  // Ignorer les imports dart:core (built-in)
  if (pkg.startsWith('dart:')) return `// dart:${pkg.slice(5)} — built-in, no import needed in ${targetFramework}`;

  // Mapping des packages Flutter courants
  const FLUTTER_TO_RN: Record<string, string> = {
    'package:flutter/material.dart':          `import React from 'react';`,
    'package:flutter/widgets.dart':           `import React from 'react';`,
    'package:flutter/cupertino.dart':         `import { /* iOS components */ } from 'react-native';`,
    'package:get/get.dart':                   `import { useNavigation } from '@react-navigation/native';`,
    'package:provider/provider.dart':         `import { /* zustand store */ } from '../stores';`,
    'package:riverpod/riverpod.dart':         `// Riverpod → Zustand (see src/stores/)`,
    'package:flutter_riverpod/flutter_riverpod.dart': `// Riverpod → Zustand (see src/stores/)`,
    'package:dio/dio.dart':                   `import { apiClient } from '../lib/api';`,
    'package:http/http.dart':                 `import { apiClient } from '../lib/api';`,
    'package:shared_preferences/shared_preferences.dart': `import AsyncStorage from '@react-native-async-storage/async-storage';`,
    'package:hive/hive.dart':                 `import AsyncStorage from '@react-native-async-storage/async-storage';`,
    'package:firebase_core/firebase_core.dart': `import firebase from '@react-native-firebase/app';`,
    'package:firebase_auth/firebase_auth.dart': `import auth from '@react-native-firebase/auth';`,
    'package:cloud_firestore/cloud_firestore.dart': `import firestore from '@react-native-firebase/firestore';`,
    'package:flutter_bloc/flutter_bloc.dart': `// BLoC → Zustand (see src/stores/)`,
    'package:go_router/go_router.dart':       `import { useRouter } from 'expo-router';`,
    'package:image_picker/image_picker.dart': `import * as ImagePicker from 'expo-image-picker';`,
    'package:url_launcher/url_launcher.dart': `import { openURL } from 'expo-linking';`,
    'package:intl/intl.dart':                 `import dayjs from 'dayjs';`,
  };

  if (FLUTTER_TO_RN[pkg]) return FLUTTER_TO_RN[pkg] ?? null;

  // Import relatif (fichier local du projet)
  if (pkg.startsWith('package:') && pkg.includes('/')) {
    const parts = pkg.split('/');
    const fileName = parts[parts.length - 1]?.replace('.dart', '') ?? '';
    return `// TODO(import): convert '${pkg}' → import { ${toCamelCase(fileName)} } from '../${fileName}';`;
  }

  // Import relatif Dart
  if (!pkg.startsWith('package:') && !pkg.startsWith('dart:')) {
    const fileName = pkg.replace('.dart', '');
    return `// TODO(import): convert relative import '${pkg}' → import from './${fileName}'`;
  }

  return `// TODO(import): map package '${pkg}' to ${targetFramework} equivalent`;
}

function toCamelCase(str: string): string {
  return str.split('_').map((s, i) => i === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)).join('');
}

// ── Builders de prompt ───────────────────────────────────────────────────────

function buildChunkSystemPrompt(targetFramework: string, sourceFramework: string): string {
  const target = targetFramework === 'react-native' ? 'React Native (Expo) + TypeScript'
    : targetFramework === 'react' ? 'React + TypeScript + TailwindCSS'
    : targetFramework === 'nestjs' ? 'NestJS + TypeScript'
    : targetFramework;  return `You are an AI Software Architect converting ${sourceFramework} code to ${target}.

ABSOLUTE RULES FOR CHUNK CONVERSION:
1. Convert the provided code chunk COMPLETELY — preserve ALL business logic
2. NEVER simplify, summarize, or truncate — every function body must be fully converted
3. NEVER delete functions — if you can't convert a function, wrap in TODO comment
4. Output ONLY valid ${target} code — no markdown, no explanations, no notes
5. Maintain the same public API surface (same function names, same behavior)
6. If a function references other chunks, add TODO import comment
7. Return ONLY the code content — start with import statements if needed`;
}

function buildChunkUserPrompt(
  chunk:           SourceChunk,
  targetFramework: string,
  fileContext:     string,
  irContext?:      string,
): string {
  const chunkDesc = `${chunk.type} "${chunk.name}" (${chunk.content.split('\n').length} lines, L${chunk.startLine}-${chunk.endLine})`;

  return `Convert this ${chunk.language} ${chunkDesc} to ${targetFramework}.

FILE CONTEXT: ${fileContext}
${irContext ? `IR CONTEXT:\n${irContext}\n` : ''}
IMPORTANT:
- Preserve ALL methods and functions from the source
- Keep ALL business logic intact
- Use TypeScript strict mode
- If source calls APIs, use apiClient from '../lib/api'
- If source uses state, use appropriate ${targetFramework === 'nestjs' ? 'NestJS patterns' : 'Zustand store'}

SOURCE CODE TO CONVERT:
\`\`\`${chunk.language}
${chunk.content}
\`\`\`

Return ONLY the converted ${targetFramework} TypeScript code, no explanations.`;
}

// ── Estimation du besoin de chunking ─────────────────────────────────────────

/**
 * Détermine si un fichier source nécessite d'être chunké
 * Basé sur la taille et le tier AI
 */
export function needsChunking(
  sourceContent: string,
  tier:          string,
): boolean {
  const threshold = CHUNK_THRESHOLDS[tier as keyof typeof CHUNK_THRESHOLDS] ?? CHUNK_THRESHOLDS['platform'];
  return threshold > 0 && sourceContent.length > threshold;
}
