// ============================================================
// CodeMorph AI Engine — LLM Output Cleaner
// PHASE 28: Post-processeur pour nettoyer les sorties brutes du LLM
//
// PROBLÈME:
//   Les LLMs ajoutent souvent du texte parasitaire autour du code réel :
//   - Blocs markdown (```typescript ... ```)
//   - Notes explicatives ("Here is the component...", "This file...")
//   - Instructions ("Replace this with...", "Add your...")
//   - Marqueurs inutiles ("Note:", "Example:", "Output:")
//   - Textes de description avant/après le code
//
// SOLUTION:
//   1. Détecter si le contenu est entouré de fences markdown → les retirer
//   2. Détecter les préambules LLM → les supprimer
//   3. Détecter les épilogue LLM → les supprimer
//   4. Si le résultat ne commence pas par du code valide → tenter extraction
//   5. Mesurer le ratio de compression (ligne source vs lignes nettoyées)
//   6. Logger toutes les modifications opérées
// ============================================================

export interface CleanResult {
  content:       string;  // code nettoyé
  wasModified:   boolean; // true si quelque chose a été retiré
  removedChars:  number;  // chars supprimés
  linesRemoved:  number;  // lignes supprimées
  operations:    string[]; // liste des opérations appliquées
}

// ── Patterns de détection des sorties LLM parasitaires ───────────────────────
// Chaque pattern identifie un type de pollution spécifique

// Blocs markdown ```lang ... ```
const MARKDOWN_FENCE_OPEN  = /^```[a-zA-Z0-9]*\s*\n/;
const MARKDOWN_FENCE_CLOSE = /\n```\s*$/;
// Fence multilignes complètes
const MARKDOWN_FENCE_FULL = /^```[a-zA-Z0-9]*\s*\n([\s\S]*?)\n```\s*$/;
// Inline fences dans le contenu
const MARKDOWN_FENCE_INLINE = /^```[a-zA-Z0-9]*$/gm;

// Préambules LLM typiques (lignes de texte avant le code)
const LLM_PREAMBLE_PATTERNS: RegExp[] = [
  /^Here(?:'s| is) (?:the|a|an?) (?:complete |full |entire |updated |converted )?/i,
  /^(?:This is|Below is|The following is) (?:the|a|an?) /i,
  /^I(?:'ve| have) (?:created|generated|written|converted|implemented)/i,
  /^(?:Sure|Certainly|Of course|Absolutely)[,!.]/i,
  /^(?:Here's|Here is) your/i,
  /^(?:The|A) (?:complete|full|generated|converted) (?:code|file|component|screen|module)/i,
  /^Let me (?:create|generate|write|convert)/i,
  /^(?:Now|Let's) (?:create|generate|write|convert)/i,
  /^(?:Generated|Converting|Converted|Creating|Created):?\s/i,
  /^As (?:requested|per|per the|per your)/i,
  /^Based on (?:the|your|this)/i,
  /^For (?:the|your) .{3,50} (?:screen|component|file|module|page):/i,
  /^\/\/ (?:Note:|NOTE:|Here's|Here is|This is the|This file|This component)/i,
  /^\/\* (?:Note:|NOTE:|Here's|Here is|This is the|This file)/i,
];

// Épilogue LLM typiques (lignes de texte après le code)
const LLM_EPILOGUE_PATTERNS: RegExp[] = [
  /^(?:This|The) (?:component|screen|file|module|code) (?:includes|provides|handles|implements|uses)/i,
  /^Note(?:s)?:/i,
  /^(?:Key )?(?:features|points|highlights):/i,
  /^(?:Make sure|Remember|Don't forget|Be sure) to/i,
  /^You (?:can|may|should|could|might|need to)/i,
  /^To use this/i,
  /^This (?:will|should|must|can)/i,
  /^(?:Feel free|Please) to/i,
  /^(?:Also|Additionally|Furthermore|Moreover),/i,
  /^(?:The|This) (?:above|following) code/i,
  /^(?:Replace|Update|Modify|Change|Configure)/i,
  /^(?:Don't|Do not) (?:forget|miss)/i,
  /^import (?:statements|paths) (?:may|might|should|need to|must)/i,
];

// Lignes de contenu générique à supprimer (même au milieu du code)
const INLINE_NOISE_PATTERNS: RegExp[] = [
  /^\s*\/\/ Replace this with (?:your|the|actual)/i,
  /^\s*\/\/ Add (?:your|the) (?:actual|real) (?:content|logic|code|implementation) here/i,
  /^\s*\/\/ TODO: (?:Replace|Add|Update|Modify|Configure|Implement) (?:with|your|the|this)/i,
  /^\s*\/\/ Example (?:implementation|usage|code)[:;]?\s*$/i,
  /^\s*\/\/ \.{3,}\s*$/,  // // ...
  /^\s*\{?\s*\/\* Replace this \*\/\s*\}?/i,
  /^\s*\/\/ Note: (?:This|The|You|Replace|Update|Add|Make)/i,
  /^\s*\/\/ \[(?:PLACEHOLDER|TODO|FIXME|REPLACE ME)\]/i,
];

// Marqueurs d'instructions qui ne sont pas du code
const INSTRUCTION_MARKERS: RegExp[] = [
  /^\s*(?:Output|Result|Code|File|Generated)[:\s]+$/i,
  /^-{3,}\s*$/,  // --- séparateurs
  /^={3,}\s*$/,  // === séparateurs
  /^#{1,3} /,    // titres markdown # ## ###
];

// ── Détecteur de début de code TypeScript/JavaScript/React valide ────────────
function isCodeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  const CODE_STARTERS = [
    /^import\s/,
    /^export\s/,
    /^const\s/,
    /^let\s/,
    /^var\s/,
    /^function\s/,
    /^class\s/,
    /^interface\s/,
    /^type\s/,
    /^enum\s/,
    /^\/\//,      // commentaire de code légitime
    /^\/\*/,      // commentaire bloc
    /^\s*\*\s/,   // continuation bloc commentaire
    /^@/,         // décorateur
    /^import {/,
    /^import \*/,
    /^import React/,
    /^\{/,        // début objet
    /^return /,
    /^async /,
    /^await /,
    /^if\s?\(/,
    /^for\s?\(/,
    /^while\s?\(/,
    /^switch\s?\(/,
    /^try\s*\{/,
    /^\}/,         // fermeture bloc
    /^<[A-Z]/,    // JSX component
    /^<!DOCTYPE/i,
    /^module\.exports/,
    /^describe\(/,
    /^it\(/,
    /^test\(/,
    /^jest\./,
    /^'use strict'/,
    /^#/,         // shebang ou précompilateur
  ];
  return CODE_STARTERS.some((p) => p.test(trimmed));
}

// ── Détecteur de prose (texte non-code) ────────────────────────────────────
function isProseText(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  // Un commentaire est du texte dans le code — pas de la prose
  if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return false;

  // Prose: phrase normale en anglais avec verbes
  const PROSE_PATTERNS = [
    /^[A-Z][a-z]+ (?:is|are|was|were|will|can|should|may|might|have|has|had|provides|includes|handles|implements|uses|creates|generates|returns|accepts|takes|makes|gives|shows|displays|renders|allows|enables|lets|needs|requires|contains|does|performs|converts|transforms)/,
    /\bthis (?:component|screen|file|module|function|class|hook)\b/i,
    /\byou (?:can|should|must|need to|may|might)\b/i,
    /\bNote(?:s)?:/i,
    /\b(?:replace|update|modify|configure|change) (?:this|the|it)\b/i,
    /\b(?:make sure|don't forget|remember) to\b/i,
  ];
  return PROSE_PATTERNS.some((p) => p.test(trimmed));
}

// ============================================================
// FONCTION PRINCIPALE: cleanLLMOutput
// ============================================================
export function cleanLLMOutput(raw: string, context?: string): CleanResult {
  const operations: string[] = [];
  const originalLength = raw.length;
  const originalLines = raw.split('\n').length;
  let content = raw;

  // ── Étape 1: Normaliser les fins de ligne ──────────────────
  content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // ── Étape 2: Détecter et extraire depuis fences markdown ───
  const fenceMatch = content.match(MARKDOWN_FENCE_FULL);
  if (fenceMatch?.[1]) {
    const extracted = fenceMatch[1];
    operations.push(`REMOVED: markdown fence (${content.length - extracted.length} chars stripped)`);
    content = extracted;
  } else {
    // Fence open/close partiels
    let hadFence = false;
    if (MARKDOWN_FENCE_OPEN.test(content)) {
      content = content.replace(MARKDOWN_FENCE_OPEN, '');
      hadFence = true;
    }
    if (MARKDOWN_FENCE_CLOSE.test(content)) {
      content = content.replace(MARKDOWN_FENCE_CLOSE, '');
      hadFence = true;
    }
    if (hadFence) {
      operations.push('REMOVED: markdown fence delimiters (open/close)');
    }
  }

  // ── Étape 3: Supprimer les fences inline résiduelles ───────
  const inlineFenceCount = (content.match(MARKDOWN_FENCE_INLINE) ?? []).length;
  if (inlineFenceCount > 0) {
    content = content.replace(MARKDOWN_FENCE_INLINE, '');
    operations.push(`REMOVED: ${inlineFenceCount} inline markdown fence(s)`);
  }

  // ── Étape 4: Supprimer le préambule LLM (lignes avant le code) ─
  const lines = content.split('\n');
  let codeStartIdx = 0;

  // Trouver la première vraie ligne de code
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    // Vide → ignorer
    if (!trimmed) {
      if (codeStartIdx === i) codeStartIdx = i + 1;
      continue;
    }

    // Preamble pattern → supprimer
    const isPreamble = LLM_PREAMBLE_PATTERNS.some((p) => p.test(trimmed));
    if (isPreamble) {
      codeStartIdx = i + 1;
      operations.push(`REMOVED preamble line: "${trimmed.slice(0, 60)}..."`);
      continue;
    }

    // Instruction marker → supprimer
    const isMarker = INSTRUCTION_MARKERS.some((p) => p.test(trimmed));
    if (isMarker) {
      codeStartIdx = i + 1;
      operations.push(`REMOVED marker: "${trimmed.slice(0, 60)}"`);
      continue;
    }

    // Ligne de code → on s'arrête
    if (isCodeLine(line)) break;

    // Prose → supprimer
    if (isProseText(trimmed)) {
      codeStartIdx = i + 1;
      operations.push(`REMOVED prose line: "${trimmed.slice(0, 60)}..."`);
      continue;
    }

    // Si on atteint une ligne qui ressemble à du code
    break;
  }

  if (codeStartIdx > 0) {
    content = lines.slice(codeStartIdx).join('\n');
  }

  // ── Étape 5: Supprimer l'épilogue LLM (lignes après le code) ─
  const contentLines = content.split('\n');
  let codeEndIdx = contentLines.length;

  for (let i = contentLines.length - 1; i >= Math.max(0, contentLines.length - 20); i--) {
    const line = contentLines[i] ?? '';
    const trimmed = line.trim();

    if (!trimmed) {
      codeEndIdx = i;
      continue;
    }

    const isEpilogue = LLM_EPILOGUE_PATTERNS.some((p) => p.test(trimmed));
    if (isEpilogue) {
      codeEndIdx = i;
      operations.push(`REMOVED epilogue line: "${trimmed.slice(0, 60)}..."`);
      continue;
    }

    // Ligne de prose à la fin
    if (isProseText(trimmed)) {
      codeEndIdx = i;
      operations.push(`REMOVED trailing prose: "${trimmed.slice(0, 60)}..."`);
      continue;
    }

    // Fence résiduelle
    if (/^```/.test(trimmed)) {
      codeEndIdx = i;
      operations.push('REMOVED trailing fence delimiter');
      continue;
    }

    break;
  }

  if (codeEndIdx < contentLines.length) {
    content = contentLines.slice(0, codeEndIdx).join('\n');
  }

  // ── Étape 6: Supprimer les lignes de bruit inline ──────────
  const finalLines = content.split('\n');
  const cleanedLines: string[] = [];
  let noiseCount = 0;

  for (const line of finalLines) {
    const isNoise = INLINE_NOISE_PATTERNS.some((p) => p.test(line));
    if (isNoise) {
      noiseCount++;
      // Remplacer par un TODO structuré plutôt que supprimer complètement
      const match = line.match(/\/\/ (.{10,80})/);
      if (match?.[1]) {
        cleanedLines.push(`  // TODO(codeMorph): ${match[1]} — implement based on source logic`);
      }
      continue;
    }
    cleanedLines.push(line);
  }

  if (noiseCount > 0) {
    operations.push(`REPLACED: ${noiseCount} inline noise line(s) with structured TODOs`);
    content = cleanedLines.join('\n');
  }

  // ── Étape 7: Normaliser les lignes vides excessives ─────────
  const tooManyBlanks = /\n{4,}/g;
  if (tooManyBlanks.test(content)) {
    content = content.replace(/\n{4,}/g, '\n\n\n');
    operations.push('NORMALIZED: excessive blank lines (max 3 consecutive)');
  }

  // ── Étape 8: Trim final ──────────────────────────────────────
  content = content.trim();
  if (content && !content.endsWith('\n')) {
    content += '\n';
  }

  const finalLines2 = content.split('\n').length;
  const removedChars  = originalLength - content.length;
  const linesRemoved  = originalLines - finalLines2;
  const wasModified   = operations.length > 0;

  // ── Log de compression ───────────────────────────────────────
  if (wasModified) {
    const compressionPct = Math.round((removedChars / Math.max(originalLength, 1)) * 100);
    console.log(`[OutputCleaner] ${context ?? 'file'}: ${operations.length} operations, -${linesRemoved} lines (-${compressionPct}%)`);
    if (linesRemoved > 10) {
      console.warn(`[OutputCleaner] ⚠️  Large cleanup for ${context}: removed ${linesRemoved} lines. This indicates heavy LLM pollution.`);
    }
  }

  return { content, wasModified, removedChars, linesRemoved, operations };
}

// ============================================================
// VÉRIFICATEUR D'ANTI-SUMMARISATION
// Détecte quand le LLM a compressé/résumé un fichier de grande taille
// ============================================================

export interface CompressionWarning {
  detected:        boolean;
  sourceLines:     number;
  generatedLines:  number;
  compressionRatio: number; // 0-1 (1 = identique, 0.1 = 10% conservé)
  severity:        'none' | 'mild' | 'moderate' | 'severe' | 'critical';
  message:         string;
}

/**
 * Détecte si le LLM a résumé/compressé un fichier source
 * @param sourceContent  Le contenu du fichier source original
 * @param generated      Le code généré par le LLM
 * @returns CompressionWarning avec diagnostic
 */
export function detectCompression(
  sourceContent: string,
  generated:     string,
  fileName?:     string,
): CompressionWarning {
  const sourceLines = sourceContent.split('\n').filter((l) => l.trim()).length;
  const generatedLines = generated.split('\n').filter((l) => l.trim()).length;

  if (sourceLines === 0) {
    return {
      detected: false, sourceLines: 0, generatedLines,
      compressionRatio: 1, severity: 'none', message: 'No source content',
    };
  }

  const compressionRatio = generatedLines / sourceLines;

  let severity: CompressionWarning['severity'];
  let detected = false;

  if (compressionRatio >= 0.7) {
    severity = 'none';
  } else if (compressionRatio >= 0.5) {
    severity = 'mild';
    detected = true;
  } else if (compressionRatio >= 0.3) {
    severity = 'moderate';
    detected = true;
  } else if (compressionRatio >= 0.15) {
    severity = 'severe';
    detected = true;
  } else {
    severity = 'critical';
    detected = true;
  }

  const message = detected
    ? `⚠️  COMPRESSION DETECTED in ${fileName ?? 'file'}: ${sourceLines} source lines → ${generatedLines} generated lines (${Math.round(compressionRatio * 100)}% preserved). Severity: ${severity.toUpperCase()}`
    : `✓ No compression in ${fileName ?? 'file'}: ${sourceLines} → ${generatedLines} lines`;

  if (detected) {
    console.warn(`[OutputCleaner] ${message}`);
  }

  return { detected, sourceLines, generatedLines, compressionRatio, severity, message };
}

// ============================================================
// EXTRACTEUR DE CODE DEPUIS CONTENU MIXTE
// Quand le LLM mêle code et explications, on extrait seulement le code
// ============================================================

/**
 * Extrait uniquement les blocs de code d'un contenu mixte (prose + code)
 * Utile quand le LLM insère du texte explicatif DANS le code
 */
export function extractCodeBlocks(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let inCodeSection = true; // on commence en assumant qu'on est dans du code

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    // Fence markdown → commence/termine une section code
    if (/^```[a-zA-Z0-9]*$/.test(trimmed)) {
      inCodeSection = !inCodeSection;
      continue; // skip la fence elle-même
    }

    // Si on est dans un bloc code délimité → tout garder
    if (!inCodeSection) {
      result.push(line);
      continue;
    }

    // Hors fence : décider ligne par ligne
    if (!trimmed) {
      result.push(line); // garder les lignes vides
      continue;
    }

    // Ligne de code légitime → garder
    if (isCodeLine(line)) {
      inCodeSection = true;
      result.push(line);
      continue;
    }

    // Prose évidente → supprimer si pas déjà dans un commentaire
    if (isProseText(trimmed) && !trimmed.startsWith('//') && !trimmed.startsWith('*')) {
      continue; // skip
    }

    // Garder par défaut
    result.push(line);
  }

  return result.join('\n').trim();
}

// ============================================================
// NETTOYEUR DE BATCH — applique sur un tableau de GeneratedFile
// ============================================================

import type { GeneratedFile } from '../models/ir.types';

export interface BatchCleanResult {
  files:          GeneratedFile[];
  totalModified:  number;
  totalLinesRemoved: number;
  totalCharsRemoved: number;
  compressionAlerts: Array<{ path: string; severity: string; message: string }>;
}

/**
 * Nettoie tous les fichiers générés d'un plan de code
 * À appeler après generateScreenFile() et avant le packaging ZIP
 */
export function cleanGeneratedFiles(files: GeneratedFile[]): BatchCleanResult {
  const cleanedFiles: GeneratedFile[] = [];
  let totalModified = 0;
  let totalLinesRemoved = 0;
  let totalCharsRemoved = 0;
  const compressionAlerts: BatchCleanResult['compressionAlerts'] = [];

  for (const file of files) {
    if (!file.content) {
      cleanedFiles.push(file);
      continue;
    }

    // Ne pas nettoyer les fichiers JSON, CSS, markdown, binaires
    const ext = file.path.split('.').pop()?.toLowerCase() ?? '';
    if (['json', 'css', 'md', 'txt', 'png', 'jpg', 'svg', 'ico', 'env', 'example'].includes(ext)) {
      cleanedFiles.push(file);
      continue;
    }

    const result = cleanLLMOutput(file.content, file.path);

    if (result.wasModified) {
      totalModified++;
      totalLinesRemoved  += result.linesRemoved;
      totalCharsRemoved  += result.removedChars;

      cleanedFiles.push({
        ...file,
        content: result.content,
        warnings: [
          ...(file.warnings ?? []),
          `OutputCleaner: removed ${result.linesRemoved} LLM noise lines (${result.operations.length} operations)`,
        ],
      });
    } else {
      cleanedFiles.push(file);
    }
  }

  if (totalModified > 0) {
    console.log(`\n[OutputCleaner] ===== BATCH CLEAN REPORT =====`);
    console.log(`[OutputCleaner] Files cleaned   : ${totalModified}/${files.length}`);
    console.log(`[OutputCleaner] Lines removed   : ${totalLinesRemoved}`);
    console.log(`[OutputCleaner] Chars removed   : ${totalCharsRemoved}`);
    if (compressionAlerts.length > 0) {
      console.warn(`[OutputCleaner] Compression alerts: ${compressionAlerts.length}`);
      compressionAlerts.forEach((a) => console.warn(`  [${a.severity.toUpperCase()}] ${a.path}`));
    }
    console.log(`[OutputCleaner] ==============================\n`);
  }

  return { files: cleanedFiles, totalModified, totalLinesRemoved, totalCharsRemoved, compressionAlerts };
}
