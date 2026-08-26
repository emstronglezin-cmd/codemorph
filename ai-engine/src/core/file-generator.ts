// ============================================================
// CodeMorph AI Engine — File Generator (Per-File Faithful Conversion)
//
// OBJECTIF: Générer CHAQUE fichier individuellement avec:
//   1. Le code source COMPLET du fichier correspondant injecté dans le prompt
//   2. Validation du contenu après chaque génération
//   3. Retry automatique si vide / trop court / markdown fence non nettoyé
//   4. Jamais produire de placeholder, TODO masqué, ou contenu tronqué
//
// STRATÉGIE GROQ:
//   - llama-3.3-70b-versatile : 131 072 tokens context window
//   - Max output: 4096 tokens par appel → fichiers > 300 lignes = chunking
//   - Rate limit protection: 300ms entre appels
//
// VALIDATION:
//   - Minimum 30% de la longueur source (en lignes)
//   - Pas de fence markdown résiduelle
//   - Pas de "// TODO: implement" ou "// Replace this with"
//   - Au moins 1 export valide (export default / export const / export function)
// ============================================================

import type { AIProvider }     from './ai-provider';
import { cleanLLMOutput }      from './output-cleaner';
import { needsChunking, convertLargeFile } from './file-chunker';

// ── Types ──────────────────────────────────────────────────────────────────

export interface FileGenerationRequest {
  /** Nom logique du fichier à générer (ex: "LoginScreen", "AuthStore") */
  name:            string;
  /** Chemin cible dans le projet RN (ex: "app/login.tsx") */
  targetPath:      string;
  /** Type de fichier cible */
  fileType:        'screen' | 'store' | 'service' | 'repository' | 'model' | 'component' | 'hook' | 'util' | 'config';
  /** Code source complet du fichier Dart/Flutter correspondant */
  sourceContent:   string;
  /** Chemin source original */
  sourcePath:      string;
  /** Framework cible */
  targetFramework: string;
  /** Contexte additionnel: imports disponibles, dépendances, etc. */
  context?:        string | undefined;
}

export interface FileGenerationResult {
  path:       string;
  content:    string;
  language:   'typescript';
  fromPath:   string;
  warnings:   string[];
  success:    boolean;
  retries:    number;
  sourceLines: number;
  targetLines: number;
}

// ── Constantes de validation ───────────────────────────────────────────────

const MARKDOWN_FENCE_RE      = /^```[\w]*\s*$/m;
const PLACEHOLDER_PATTERNS   = [
  /\/\/ TODO: implement/i,
  /\/\/ TODO: add implementation/i,
  /\/\/ Replace this with/i,
  /\/\/ Add your implementation here/i,
  /throw UnimplementedError\(\)/,
  /console\.log\('TODO'\)/i,
];
// Patterns indiquant un output de fallback chunker (source préservée en commentaires)
const CHUNKER_FALLBACK_PATTERNS = [
  /\/\/ TODO\(codeMorph\): CONVERSION INCOMPLETE/,
  /\/\*[\s\S]*?ORIGINAL SOURCE \(dart\)/,
  /\/\/ TODO: Implement .+ in react-native\/typescript/,
];
const VALID_EXPORT_RE        = /export\s+(default|const|function|class|interface|type|enum)\s+\w/;
const MIN_PRESERVATION_RATIO = 0.25; // au moins 25% des lignes source

// ── Détection si un output est valide ─────────────────────────────────────

function isOutputValid(
  content:     string,
  sourceLines: number,
  fileType:    string,
): { valid: boolean; reason?: string } {
  if (!content || content.length < 50) {
    return { valid: false, reason: `too short (${content.length} chars)` };
  }

  // Vérifier absence de fences markdown résiduelles
  if (MARKDOWN_FENCE_RE.test(content)) {
    return { valid: false, reason: 'markdown fence residual detected' };
  }

  // Détecter output chunker-fallback: source Dart préservée en commentaires /* */
  // Ces fichiers ont 0% de code TypeScript réel — invalides même si longs
  for (const pat of CHUNKER_FALLBACK_PATTERNS) {
    if (pat.test(content)) {
      return { valid: false, reason: 'output is chunker fallback (dart source in comments — not real TypeScript)' };
    }
  }

  const allLines  = content.split('\n');
  const codeLines = allLines.filter((l) => {
    const t = l.trim();
    return t.length > 0 && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('#');
  });

  // Un output avec moins de 5 lignes de vrai code TypeScript est invalide
  // (même si le fichier est long — c'est du rembourrage de commentaires)
  if (codeLines.length < 5 && fileType !== 'config') {
    return { valid: false, reason: `only ${codeLines.length} real code lines (rest is comments/stubs)` };
  }

  const lines = allLines.filter((l) => l.trim().length > 0);

  // Vérifier ratio de préservation (sauf pour configs et utils courts)
  // TRANSPILE: screen/component Flutter (300-500L) → RN (~100-150L) — ratio faible est normal
  // On exclut screen/component du ratio check; on vérifie juste > 40 lignes
  if (sourceLines > 20 && !['config', 'util', 'hook', 'screen', 'component'].includes(fileType)) {
    const ratio = lines.length / sourceLines;
    if (ratio < MIN_PRESERVATION_RATIO) {
      return { valid: false, reason: `too short relative to source (${lines.length}/${sourceLines} lines = ${(ratio * 100).toFixed(0)}%)` };
    }
  }
  if (['screen', 'component'].includes(fileType) && lines.length < 40) {
    return { valid: false, reason: `screen too short (${lines.length} lines) — need >=40 for real RN screen` };
  }

  // Vérifier présence d'un export valide pour les fichiers TS
  if (!VALID_EXPORT_RE.test(content) && fileType !== 'config') {
    return { valid: false, reason: 'no valid TypeScript export found' };
  }

  // Compter les placeholders problématiques
  const placeholderCount = PLACEHOLDER_PATTERNS.filter((p) => p.test(content)).length;
  if (placeholderCount > 2) {
    return { valid: false, reason: `too many placeholders (${placeholderCount})` };
  }

  return { valid: true };
}

// ── Prompts de conversion par type de fichier ──────────────────────────────

function buildSystemPrompt(fileType: string, targetFramework: string): string {
  const framework = targetFramework.toLowerCase().includes('native') ? 'React Native (Expo)' : 'React';
  const stateLib  = 'Zustand';

  const baseRules = `You are an expert ${framework} developer specializing in migrating Flutter/Dart apps.

ABSOLUTE RULES:
1. Output ONLY valid TypeScript/TSX — no markdown fences, no explanations, no comments about the conversion
2. Convert EVERY function, method, class, and property from the source — nothing can be omitted
3. Preserve ALL business logic, error handling, loading states, API calls, and data transformations
4. NEVER use "// TODO: implement", "throw new Error('not implemented')", or placeholder logic
5. If you cannot convert something faithfully, add a comment: // [CodeMorph] NEEDS MANUAL REVIEW: <reason>
6. The output file must be runnable TypeScript — valid syntax, proper imports
7. All async operations must be converted (Future<T> → Promise<T>, then/catch, etc.)`;

  const typeSpecific: Record<string, string> = {
    screen: `
SCREEN CONVERSION RULES:
- Convert Flutter Widget to React Native functional component with StyleSheet
- Map Flutter layout widgets: Column→View+flexDirection:column, Row→View+flexDirection:row, Container→View, Expanded→flex:1
- Convert StatefulWidget state to useState/useEffect hooks
- Convert Provider/Riverpod reads to Zustand store hooks (useXxxStore())
- Keep ALL navigation calls (context.go() → router.push(), context.pop() → router.back())
- Preserve ALL form validation, text controllers, focus nodes
- Map Flutter form widgets: TextField→TextInput, ElevatedButton→TouchableOpacity, etc.
- Keep ALL conditional rendering (if/else, ternary operators)`,

    store: `
ZUSTAND STORE CONVERSION RULES:
- Convert StateNotifier<S>/ChangeNotifier to create<State>() Zustand pattern
- Map state fields directly (final bool isLoading → isLoading: boolean)
- Convert ALL async methods (Future<void> method() → method: async () => {})
- Use set() for state updates (state = state.copyWith(...) → set({...}))
- Keep ALL error handling (try/catch blocks must be preserved)
- Import AsyncStorage for persistent state
- Export: export const useXxxStore = create<XxxState>(...)`,

    service: `
SERVICE CONVERSION RULES:
- Convert Dart service class to TypeScript class or exported functions
- Keep ALL HTTP calls (Dio/http → fetch or axios)
- Preserve ALL request/response parsing and data mapping
- Convert Dart exceptions to TypeScript Error classes
- Keep ALL retry logic, caching, interceptors
- Export the service as singleton or class`,

    repository: `
REPOSITORY CONVERSION RULES:
- Convert Dart repository class to TypeScript class
- Keep ALL API endpoint calls with exact URLs and HTTP methods
- Preserve ALL request body mapping (toJson()) and response parsing (fromJson())
- Convert Dart DTOs to TypeScript interfaces
- Keep ALL error handling and network error types
- Import and use the api client (import api from '../lib/api')`,

    model: `
MODEL/TYPE CONVERSION RULES:
- Convert Dart data classes to TypeScript interfaces and/or classes
- Convert ALL fields with proper TypeScript types (String→string, int→number, bool→boolean, List<T>→T[])
- Convert nullable types (String? → string | null | undefined)
- Add fromJson() static method if Dart class has it
- Add toJson() method if Dart class has it
- Export all interfaces and types`,

    component: `
COMPONENT CONVERSION RULES:
- Convert Flutter Widget to React Native functional component
- Convert props (positional/named params) to TypeScript interface props
- Map all Flutter styling to React Native StyleSheet
- Keep ALL callback props and event handlers
- Export as default export`,

    hook: `
HOOK CONVERSION RULES:
- Convert Dart utility functions/mixins to React custom hooks (use prefix)
- Preserve ALL logic and computations
- Return proper TypeScript types
- Export the hook function`,

    util: `
UTILITY CONVERSION RULES:
- Convert Dart utility functions to TypeScript
- Keep ALL logic — no simplification
- Use proper TypeScript return types
- Export each utility function`,

    config: `
CONFIG CONVERSION RULES:
- Convert Dart constants/config to TypeScript
- Keep ALL values and environment variable references
- Use process.env for environment variables`,
  };

  return `${baseRules}${typeSpecific[fileType] ?? typeSpecific['util']!}

IMPORTS TO USE (${framework}):
- React Native: import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, FlatList, ActivityIndicator, Alert } from 'react-native'
- Expo Router: import { useRouter, useLocalSearchParams } from 'expo-router'
- ${stateLib}: import { create } from 'zustand'
- Storage: import AsyncStorage from '@react-native-async-storage/async-storage'
- API client: import api from '../lib/api' (axios instance with baseURL already set)
- Types: import type { XxxModel } from '../types/xxx.types'`;
}

function buildUserPrompt(req: FileGenerationRequest, attempt = 0): string {
  // Budget source: 8000 chars pour Groq 8000 TPM (≈2000 tokens input source)
  // Le system prompt (~600 tokens) + source (~2000) + context (~200) + output (2800) ≈ 5600 tokens total
  // Cela reste dans la limite 8000 TPM par requête
  const MAX_SOURCE_CHARS = 8_000;
  const truncatedSource = req.sourceContent.length > MAX_SOURCE_CHARS
    ? req.sourceContent.slice(0, MAX_SOURCE_CHARS) + `\n// [source truncated at ${MAX_SOURCE_CHARS} chars — implement remaining methods following the same patterns above]`
    : req.sourceContent;

  const retryWarning = attempt > 0
    ? `\n\nCRITICAL: Previous attempt returned ONLY comments or TODO stubs — that is WRONG.\nYou MUST output real TypeScript/TSX code, not Dart code in comment blocks.\nEvery method from the source must be implemented in TypeScript. No /* dart source */ blocks.\n`
    : '';

  return `Convert the following Dart/Flutter ${req.fileType} to ${req.targetFramework}.${retryWarning}

TARGET FILE: ${req.targetPath}
SOURCE FILE: ${req.sourcePath}

SOURCE CODE (${req.sourceContent.split('\n').length} lines):
\`\`\`dart
${truncatedSource}
\`\`\`
${req.context ? `\nADDITIONAL CONTEXT:\n${req.context}\n` : ''}
Output ONLY the complete TypeScript file content for ${req.targetPath}.
Do NOT wrap the source in /* */ comment blocks.
Do not include any markdown fences, explanations, or file path headers.
Every function/method from the Dart source must appear as real TypeScript code.`;
}

// ── Générateur principal ───────────────────────────────────────────────────

export async function generateSingleFile(
  req:        FileGenerationRequest,
  ai:         AIProvider,
  delayMs?:   number,
): Promise<FileGenerationResult> {
  const tier        = ai.getTier();
  const sourceLines = req.sourceContent.split('\n').filter((l) => l.trim()).length;
  const warnings:   string[] = [];
  let   retries     = 0;

  console.log(`[FileGenerator] Generating ${req.fileType}: ${req.targetPath} (source: ${sourceLines} lines)`);

  // Délai optionnel pour rate limiting
  if (delayMs && delayMs > 0) {
    await new Promise((r) => setTimeout(r, delayMs));
  }

  // Vérifier si chunking nécessaire (fichier source > 12 000 chars)
  const needsChunk = needsChunking(req.sourceContent, tier);
  if (needsChunk) {
    console.log(`[FileGenerator] Large source (${req.sourceContent.length} chars) for "${req.name}" — activating chunker`);
    try {
      const chunkedResult = await convertLargeFile(
        req.sourceContent,
        'dart',
        req.targetFramework,
        'flutter',
        ai,
        `${req.name} (${req.fileType})`,
      );
      const content = chunkedResult.content;
      const cleaned = cleanLLMOutput(content, `chunked:${req.name}`).content;

      if (cleaned && cleaned.length > 100) {
        return {
          path:        req.targetPath,
          content:     cleaned,
          language:    'typescript',
          fromPath:    req.sourcePath,
          warnings:    chunkedResult.todosInserted > 0 ? [`${chunkedResult.todosInserted} TODO(s) inserted during chunked conversion`] : [],
          success:     true,
          retries:     0,
          sourceLines,
          targetLines: cleaned.split('\n').length,
        };
      }
    } catch (chunkErr) {
      console.warn(`[FileGenerator] Chunker failed for "${req.name}": ${(chunkErr as Error).message} — falling back to direct generation`);
    }
  }

  // Génération directe avec retry
  const system = buildSystemPrompt(req.fileType, req.targetFramework);

  const maxTokens = tier === 'free-groq' ? 2800 // 8000 TPM: 2800 output + ~5200 input = dans les limites
    : tier === 'platform'  ? 8192
    : 8192;

  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Pas de délai additionnel — le GroqRateLimiter dans ai-provider.ts gère l'espacement
      console.log(`[FileGenerator] Retry ${attempt}/${MAX_RETRIES} for "${req.name}"...`);
    }

    // buildUserPrompt avec l'index d'attempt pour renforcer le message sur retry
    const userMsg = buildUserPrompt(req, attempt);

    try {
      const res = await ai.chat(
        [{ role: 'system', content: system }, { role: 'user', content: userMsg }],
        maxTokens,
        { filePath: req.sourcePath, fileType: req.fileType },
      );

      let content = res.content || '';

      // Nettoyage des fences markdown
      const cleanResult = cleanLLMOutput(content, `file:${req.name}`);
      content = cleanResult.content;

      // Validation
      const validation = isOutputValid(content, sourceLines, req.fileType);
      if (validation.valid) {
        if (attempt > 0) retries = attempt;
        const targetLines = content.split('\n').length;
        console.log(`[FileGenerator] ✅ ${req.name} → ${req.targetPath} (${sourceLines}→${targetLines} lines, attempt=${attempt + 1})`);
        return {
          path:        req.targetPath,
          content,
          language:    'typescript',
          fromPath:    req.sourcePath,
          warnings,
          success:     true,
          retries,
          sourceLines,
          targetLines,
        };
      }

      console.warn(`[FileGenerator] ⚠️  Attempt ${attempt + 1}/${MAX_RETRIES + 1} invalid for "${req.name}": ${validation.reason}`);

    } catch (err) {
      console.warn(`[FileGenerator] ⚠️  Attempt ${attempt + 1} failed for "${req.name}": ${(err as Error).message}`);
      if (attempt === MAX_RETRIES) {
        // Toutes les tentatives échouées — fallback avec source préservée
        return buildFallbackResult(req, sourceLines, `${MAX_RETRIES + 1} attempts failed: ${(err as Error).message}`);
      }
    }
  }

  // MAX_RETRIES atteint sans résultat valide
  console.error(`[FileGenerator] ❌ All ${MAX_RETRIES + 1} attempts failed for "${req.name}" — using fallback`);
  return buildFallbackResult(req, sourceLines, `all ${MAX_RETRIES + 1} attempts produced invalid output`);
}

function buildFallbackResult(req: FileGenerationRequest, sourceLines: number, reason: string): FileGenerationResult {
  // Fallback: stub TypeScript MINIMAL et propre — JAMAIS de source Dart en commentaires.
  // Un stub propre est classé INCOMPLETE (pas SHELL_401 ou source_residual).
  const name = req.name;
  const ft   = req.fileType;

  let fallback: string;

  if (ft === 'screen') {
    fallback =
`import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

// [CodeMorph] NEEDS_MANUAL_REVIEW — source: ${req.sourcePath} (${sourceLines} lines)
// Reason: ${reason}
export default function ${name}() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>${name.replace(/Screen$/i, '')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  title: { fontSize: 20, fontWeight: 'bold' },
});
`;
  } else if (ft === 'store') {
    fallback =
`import { create } from 'zustand';

// [CodeMorph] NEEDS_MANUAL_REVIEW — source: ${req.sourcePath} (${sourceLines} lines)
// Reason: ${reason}
interface ${name}State {
  isLoading: boolean;
  error: string | null;
  reset: () => void;
}

export const use${name.startsWith('use') ? name.slice(3) : name}Store = create<${name}State>((set) => ({
  isLoading: false,
  error: null,
  reset: () => set({ isLoading: false, error: null }),
}));
`;
  } else if (ft === 'model') {
    fallback =
`// [CodeMorph] NEEDS_MANUAL_REVIEW — source: ${req.sourcePath} (${sourceLines} lines)
// Reason: ${reason}
export interface ${name} {
  id: string | number;
  createdAt?: string;
  [key: string]: unknown;
}

export function ${name.charAt(0).toLowerCase() + name.slice(1)}FromJson(json: Record<string, unknown>): ${name} {
  return { id: (json['id'] as string | number) ?? '' };
}

export function ${name.charAt(0).toLowerCase() + name.slice(1)}ToJson(obj: ${name}): Record<string, unknown> {
  return { ...obj };
}
`;
  } else if (ft === 'service' || ft === 'repository') {
    fallback =
`// [CodeMorph] NEEDS_MANUAL_REVIEW — source: ${req.sourcePath} (${sourceLines} lines)
// Reason: ${reason}
import api from '../lib/api';

export class ${name} {
  // Methods from ${req.sourcePath} need manual conversion
  async getAll(): Promise<unknown[]> {
    const res = await api.get('/');
    return res.data;
  }
}

export const ${name.charAt(0).toLowerCase() + name.slice(1)} = new ${name}();
export default ${name.charAt(0).toLowerCase() + name.slice(1)};
`;
  } else if (ft === 'component') {
    fallback =
`import React from 'react';
import { View, Text } from 'react-native';

// [CodeMorph] NEEDS_MANUAL_REVIEW — source: ${req.sourcePath} (${sourceLines} lines)
// Reason: ${reason}
interface ${name}Props {
  [key: string]: unknown;
}

export default function ${name}(_props: ${name}Props) {
  return <View><Text>${name}</Text></View>;
}
`;
  } else {
    fallback =
`// [CodeMorph] NEEDS_MANUAL_REVIEW — source: ${req.sourcePath} (${sourceLines} lines)
// Reason: ${reason}
export const ${name.charAt(0).toLowerCase() + name.slice(1)} = {};
export default ${name.charAt(0).toLowerCase() + name.slice(1)};
`;
  }

  return {
    path:        req.targetPath,
    content:     fallback,
    language:    'typescript',
    fromPath:    req.sourcePath,
    warnings:    [`CONVERSION INCOMPLETE: ${reason}`],
    success:     false,
    retries:     3,
    sourceLines,
    targetLines: fallback.split('\n').length,
  };
}

// ── Extraction des fichiers source depuis le code concatené ───────────────

export interface SourceFileBlock {
  path:    string;
  content: string;
}

export function extractSourceBlocks(sourceCode: string): SourceFileBlock[] {
  const blocks: SourceFileBlock[] = [];
  // Supporte les deux formats: "// === FILE: path ===" et "// FILE: path"
  const pattern = /\/\/\s*(?:=+\s*)?FILE:\s*(.+?)(?:\s*=+)?\n([\s\S]*?)(?=\/\/\s*(?:=+\s*)?FILE:|$)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(sourceCode)) !== null) {
    const path    = (match[1] ?? '').trim();
    const content = (match[2] ?? '').trim();
    if (path && content && content.length > 20) {
      blocks.push({ path, content });
    }
  }

  return blocks;
}

/** Trouver le bloc source correspondant à un fichier cible par nom fuzzy */
export function findSourceBlock(
  sourcePath:   string,
  sourceBlocks: SourceFileBlock[],
): SourceFileBlock | undefined {
  // Correspondance exacte d'abord
  const exact = sourceBlocks.find((b) => b.path === sourcePath || b.path.endsWith(sourcePath));
  if (exact) return exact;

  // Correspondance par nom de fichier sans extension
  const targetBase = sourcePath.split('/').pop()?.replace(/\.[^.]+$/, '').toLowerCase() ?? '';
  if (!targetBase) return undefined;

  // Fuzzy: normaliser les noms (snake_case ↔ camelCase ↔ PascalCase)
  const normalize = (s: string) => s.toLowerCase().replace(/[_\-\s]/g, '');
  const targetNorm = normalize(targetBase);

  return sourceBlocks.find((b) => {
    const srcBase = b.path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? '';
    return normalize(srcBase) === targetNorm;
  });
}

// ── Générateur batch avec rate limiting ───────────────────────────────────

export interface BatchGenerationResult {
  files:        FileGenerationResult[];
  successCount: number;
  failedCount:  number;
  totalFiles:   number;
}

export async function generateFileBatch(
  requests: FileGenerationRequest[],
  ai:       AIProvider,
): Promise<BatchGenerationResult> {
  const tier    = ai.getTier();
  // NOTE: le rate limiting Groq (35s entre requêtes) est géré par GroqRateLimiter
  // dans ai-provider.ts — on ne passe plus de delayMs ici pour éviter les doubles attentes.
  const results: FileGenerationResult[] = [];
  let successCount = 0;
  let failedCount  = 0;

  console.log(`\n[FileGenerator] ══════ BATCH GENERATION: ${requests.length} files (tier=${tier}) ══════`);

  for (let i = 0; i < requests.length; i++) {
    const req = requests[i]!;
    console.log(`[FileGenerator] [${i + 1}/${requests.length}] ${req.fileType}: ${req.targetPath}`);

    const result = await generateSingleFile(req, ai, 0); // délai géré par GroqRateLimiter
    results.push(result);

    if (result.success) successCount++;
    else failedCount++;
  }

  console.log(`[FileGenerator] ══════ BATCH DONE: ${successCount}✅ ${failedCount}❌ / ${requests.length} ══════\n`);

  return {
    files: results,
    successCount,
    failedCount,
    totalFiles: requests.length,
  };
}
