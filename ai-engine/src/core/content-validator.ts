// ============================================================
// CodeMorph AI Engine — Content Validator
// PHASE 6: SHELL file detection + content quality scoring
//
// RULES (ABSOLUTE):
//   - A file with "Error: 401" → status = 'shell_401'  → score = 0
//   - A file with only source imports → status = 'source_residual' → score = 0
//   - An empty file → status = 'empty' → score = 0
//   - A file with only TODOs/placeholders → status = 'incomplete' → score ≤ 20
//   - A valid scaffold (e.g. package.json, tsconfig) → status = 'scaffold' → score = 100
//   - A properly converted file → status = 'converted' → score 40-100
//
// CRITICAL: SHELL files must NEVER be counted as 'converted' in scoring.
// ============================================================

import type {
  FileContentValidation, FileContentStatus, ContentValidationReport,
} from '../models/ir.types';
import type { GeneratedFile } from '../models/ir.types';

// ── Shell markers — presence of ANY of these → shell_401 ──────────────────
const SHELL_MARKERS: RegExp[] = [
  /Error:\s*401\s*status\s*code/i,
  // NOTE: 'CONVERSION INCOMPLETE' removed — FileGenerator uses this in fallback headers
  // and those files should be classified as 'incomplete', not 'shell_401'
  /AI\s+conversion\s+failed/i,
  /HTTP\s+401/i,
  /Unauthorized.*401/i,
];

// ── "Not implemented" markers ────────────────────────────────────────────────
const NOT_IMPLEMENTED_PATTERNS: RegExp[] = [
  /throw\s+new\s+Error\s*\(\s*['"]Not\s+implemented['"]\s*\)/i,
  /throw\s+new\s+Error\s*\(\s*['"]TODO['"]\s*\)/i,
  /\/\/\s*TODO:\s*implement/i,
  /\/\/\s*TODO:\s*Implement/i,
  /NotImplementedError/i,
];

// ── Source language import patterns (should NOT exist in target) ─────────────
type SourceLang = 'dart' | 'swift' | 'kotlin' | 'objc';
const SOURCE_IMPORT_PATTERNS: Record<SourceLang, RegExp[]> = {
  dart:   [
    /^import\s+'package:[^']+\.dart'/m,
    /^import\s+"package:[^"]+\.dart"/m,
    /^import\s+'dart:/m,
    /^import\s+"dart:/m,
  ],
  swift:  [/^import\s+Foundation\b/m, /^import\s+UIKit\b/m, /^import\s+SwiftUI\b/m],
  kotlin: [/^import\s+android\./m, /^import\s+androidx\./m],
  objc:   [/#import\s+<UIKit\//m],
};

// ── Placeholder patterns ──────────────────────────────────────────────────────
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /https?:\/\/example\.com/i,
  /YOUR_API_KEY/i,
  /YOUR_BASE_URL/i,
  /INSERT_.*_HERE/i,
  /\bPLACEHOLDER\b/i,
  /\bdummy\b/i,
];

// ── Known scaffold files (intentionally minimal) ─────────────────────────────
const SCAFFOLD_PATTERNS: RegExp[] = [
  /package\.json$/,
  /tsconfig\.json$/,
  /babel\.config\.(js|ts)$/,
  /app\.json$/,
  /\.env\.example$/,
  /README\.md$/,
  /metro\.config\.(js|ts)$/,
  /\.gitignore$/,
  /eslint\.config\.(js|ts)$/,
];

// ── Meaningful code line detector ─────────────────────────────────────────────
function countCodeLines(content: string): number {
  return content
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;                  // blank
      if (trimmed.startsWith('//')) return false;  // comment
      if (trimmed.startsWith('/*')) return false;  // block comment start
      if (trimmed.startsWith('*'))  return false;  // block comment line
      if (trimmed.startsWith('#'))  return false;  // hash comment
      return true;
    }).length;
}

// ── Detect source language imports in target content ─────────────────────────
function detectSourceImports(content: string, sourceLanguage = 'dart'): string[] {
  const patterns = SOURCE_IMPORT_PATTERNS[sourceLanguage as SourceLang] ?? SOURCE_IMPORT_PATTERNS.dart;
  const found: string[] = [];
  for (const pat of patterns) {
    const matches = content.match(new RegExp(pat.source, 'gm'));
    if (matches) found.push(...matches);
  }
  return found;
}

// ── Validate a single file ────────────────────────────────────────────────────
export function validateFileContent(
  file:           GeneratedFile,
  sourceLanguage: string = 'dart',
): FileContentValidation {
  const content    = file.content ?? '';
  const path       = file.path;
  const linesTotal = content.split('\n').length;
  const linesCode  = countCodeLines(content);

  // ── Check: scaffold file ─────────────────────────────────────────────────
  if (SCAFFOLD_PATTERNS.some((p) => p.test(path))) {
    return {
      path, status: 'scaffold', language: file.language,
      linesTotal, linesCode, todosCount: 0, placeholdersCount: 0,
      sourceImports: [], shellMarkers: [], isValid: true, score: 100,
    };
  }

  // ── Check: empty ──────────────────────────────────────────────────────────
  // RÈGLE: 'empty' = contenu absent ou trivial (< 10 chars non-blancs)
  // Un fichier entièrement composé de commentaires TODO/fallback = 'incomplete'
  // (le contenu source est préservé en commentaires — mieux que rien)
  const trimmedContent = content.trim();
  if (!trimmedContent || trimmedContent.length < 10) {
    return {
      path, status: 'empty', language: file.language,
      linesTotal, linesCode: 0, todosCount: 0, placeholdersCount: 0,
      sourceImports: [], shellMarkers: [], isValid: false, score: 0,
    };
  }

  // ── Check: SHELL_401 ─────────────────────────────────────────────────────
  const shellMarkers: string[] = [];
  for (const pat of SHELL_MARKERS) {
    if (pat.test(content)) {
      shellMarkers.push(pat.source);
    }
  }

  // Also check for: file is mostly comments containing Dart code
  // Heuristic: if >80% of lines are comments AND content has Dart import patterns in comments
  const commentLines = content.split('\n').filter((l) => l.trim().startsWith('//') || l.trim().startsWith('/*') || l.trim().startsWith('*')).length;
  const isDartInComments = /\/\/\s*import\s+'package:/.test(content) || /\/\/\s*class\s+\w+\s+(extends|implements)/i.test(content);
  const isShell401ByContent = shellMarkers.length > 0 || (linesTotal > 5 && commentLines / linesTotal > 0.7 && isDartInComments);

  if (isShell401ByContent) {
    return {
      path, status: 'shell_401', language: file.language,
      linesTotal, linesCode,
      todosCount:       (content.match(/\/\/\s*TODO:/gi) ?? []).length,
      placeholdersCount: 0,
      sourceImports:    detectSourceImports(content, sourceLanguage),
      shellMarkers,
      isValid: false, score: 0,
    };
  }

  // ── Count TODOs ───────────────────────────────────────────────────────────
  const todosCount = (content.match(/\/\/\s*TODO:/gi) ?? []).length +
                     (content.match(/\/\/\s*FIXME:/gi) ?? []).length;

  // ── Count placeholders ────────────────────────────────────────────────────
  let placeholdersCount = 0;
  for (const pat of PLACEHOLDER_PATTERNS) {
    if (pat.test(content)) placeholdersCount++;
  }

  // ── Detect not-implemented patterns ──────────────────────────────────────
  const notImplementedCount = NOT_IMPLEMENTED_PATTERNS.filter((p) => p.test(content)).length;

  // ── Detect source imports ─────────────────────────────────────────────────
  const sourceImports = detectSourceImports(content, sourceLanguage);

  // ── Classify ──────────────────────────────────────────────────────────────
  let status: FileContentStatus;
  let score: number;

  // Source residual: file in target language but has source-lang imports
  if (sourceImports.length > 0 && linesCode < 5) {
    status = 'source_residual';
    score  = 0;
  } else if (sourceImports.length > 3) {
    // Many source imports → effectively a shell with source code pasted
    status = 'source_residual';
    score  = 5;
  } else if (linesCode < 3 && (todosCount > 0 || notImplementedCount > 0)) {
    status = 'incomplete';
    score  = 10;
  } else {
    // Calculate quality score
    // Base: ratio of code to total lines
    const codeRatio = Math.min(1, linesCode / Math.max(linesTotal, 1));
    // Penalty for TODOs
    const todoPenalty = Math.min(50, todosCount * 10);
    // Penalty for placeholders
    const placeholderPenalty = Math.min(30, placeholdersCount * 10);
    // Penalty for not-implemented
    const notImplPenalty = Math.min(40, notImplementedCount * 20);
    // Penalty for source imports
    const sourceImportPenalty = Math.min(50, sourceImports.length * 15);
    // Penalty lourde si le fichier contient des blocs de source Dart préservée en commentaires
    // (signe d'un output chunker-fallback non converti)
    const hasChunkerFallback = /\/\/ TODO\(codeMorph\): CONVERSION INCOMPLETE/.test(content) ||
                               /\/\*[\s\S]*?ORIGINAL SOURCE \(dart\)/.test(content);
    const chunkerFallbackPenalty = hasChunkerFallback ? 60 : 0;

    const rawScore = Math.round(codeRatio * 100) - todoPenalty - placeholderPenalty - notImplPenalty - sourceImportPenalty - chunkerFallbackPenalty;
    score = Math.max(0, Math.min(100, rawScore));

    // Classify
    // RÈGLE STRICTE: 'converted' exige:
    //   - score >= 60
    //   - 0 TODO(codeMorph) (pas de blocs fallback chunker)
    //   - 0 imports source (pas de Dart dans le TypeScript)
    //   - Au moins 10 lignes de code réel (évite les stubs avec 1-2 lignes)
    if (score >= 60 && todosCount === 0 && sourceImports.length === 0 && linesCode >= 10 && !hasChunkerFallback) {
      status = 'converted';
    } else if (score >= 30 || linesCode >= 5) {
      status = 'incomplete';
    } else {
      status = 'incomplete';
    }
  }

  const isValid = (status as string) === 'converted' || (status as string) === 'scaffold';

  return {
    path, status, language: file.language,
    linesTotal, linesCode, todosCount, placeholdersCount,
    sourceImports, shellMarkers, isValid, score,
  };
}

// ── Validate all files in a batch ────────────────────────────────────────────
export function validateAllFiles(
  files:          GeneratedFile[],
  sourceLanguage: string = 'dart',
): ContentValidationReport {
  const validations = files.map((f) => validateFileContent(f, sourceLanguage));

  const totalFiles        = validations.length;
  const convertedFiles    = validations.filter((v) => v.status === 'converted').length;
  const shellFiles        = validations.filter((v) => v.status === 'shell_401').length;
  const incompleteFiles   = validations.filter((v) => v.status === 'incomplete').length;
  const emptyFiles        = validations.filter((v) => v.status === 'empty').length;
  const scaffoldFiles     = validations.filter((v) => v.status === 'scaffold').length;
  const sourceResidual    = validations.filter((v) => v.status === 'source_residual').length;
  const totalTodos        = validations.reduce((sum, v) => sum + v.todosCount, 0);
  const totalPlaceholders = validations.reduce((sum, v) => sum + v.placeholdersCount, 0);
  const totalSourceImports = validations.reduce((sum, v) => sum + v.sourceImports.length, 0);

  const conversionRate = totalFiles > 0
    ? Math.round((convertedFiles + scaffoldFiles) / totalFiles * 100)
    : 0;

  console.log(`\n[ContentValidator] ===== CONTENT VALIDATION REPORT =====`);
  console.log(`  Total files      : ${totalFiles}`);
  console.log(`  Converted        : ${convertedFiles}  ✅`);
  console.log(`  Scaffold (valid) : ${scaffoldFiles}  ✅`);
  console.log(`  Incomplete       : ${incompleteFiles}  ⚠️`);
  console.log(`  SHELL_401        : ${shellFiles}  ❌`);
  console.log(`  Source Residual  : ${sourceResidual}  ❌`);
  console.log(`  Empty            : ${emptyFiles}  ❌`);
  console.log(`  Total TODOs      : ${totalTodos}`);
  console.log(`  Placeholders     : ${totalPlaceholders}`);
  console.log(`  Source imports   : ${totalSourceImports} (must be 0 for READY status)`);
  console.log(`  Conversion rate  : ${conversionRate}%`);

  if (shellFiles > 0) {
    const shellPaths = validations.filter((v) => v.status === 'shell_401').map((v) => v.path);
    console.warn(`[ContentValidator] ❌ SHELL_401 files (must be reconverted):`);
    shellPaths.forEach((p) => console.warn(`  - ${p}`));
  }
  if (sourceResidual > 0) {
    const residualPaths = validations.filter((v) => v.status === 'source_residual').map((v) => v.path);
    console.warn(`[ContentValidator] ❌ Source-residual files (Dart imports in TypeScript):`);
    residualPaths.forEach((p) => console.warn(`  - ${p}`));
  }
  console.log(`[ContentValidator] ==========================================\n`);

  return {
    totalFiles, convertedFiles, shellFiles, incompleteFiles,
    emptyFiles, scaffoldFiles, sourceResidual,
    totalTodos, totalPlaceholders, totalSourceImports,
    conversionRate,
    files: validations,
  };
}

// ── Shell-aware file counter (for scoring) ────────────────────────────────────
// Returns the count of files that have REAL content (not shells)
export function countRealFiles(
  files:          GeneratedFile[],
  pathPattern:    RegExp,
  sourceLanguage: string = 'dart',
): number {
  return files
    .filter((f) => pathPattern.test(f.path))
    .filter((f) => {
      const v = validateFileContent(f, sourceLanguage);
      return v.isValid || v.status === 'incomplete';
    })
    .length;
}

// ── Count fully converted files matching a pattern ─────────────────────────
export function countConvertedFiles(
  files:          GeneratedFile[],
  pathPattern:    RegExp,
  sourceLanguage: string = 'dart',
): number {
  return files
    .filter((f) => pathPattern.test(f.path))
    .filter((f) => {
      const v = validateFileContent(f, sourceLanguage);
      return v.status === 'converted' || v.status === 'scaffold';
    })
    .length;
}

// ── Format report for logging ────────────────────────────────────────────────
export function formatContentReport(report: ContentValidationReport): string {
  const lines = [
    `CONTENT VALIDATION REPORT`,
    `─────────────────────────────────────────`,
    `Total files        : ${report.totalFiles}`,
    `Converted (valid)  : ${report.convertedFiles + report.scaffoldFiles} (${report.conversionRate}%)`,
    `  - Converted      : ${report.convertedFiles}`,
    `  - Scaffold       : ${report.scaffoldFiles}`,
    `Incomplete         : ${report.incompleteFiles}`,
    `SHELL_401 (failed) : ${report.shellFiles}  ← COUNTED AS MISSING`,
    `Source residual    : ${report.sourceResidual}  ← COMPILATION BLOCKER`,
    `Empty              : ${report.emptyFiles}`,
    `─────────────────────────────────────────`,
    `TODOs total        : ${report.totalTodos}`,
    `Placeholders       : ${report.totalPlaceholders}`,
    `Source imports     : ${report.totalSourceImports}`,
    `─────────────────────────────────────────`,
    `Conversion rate    : ${report.conversionRate}%`,
  ];

  if (report.shellFiles > 0 || report.sourceResidual > 0) {
    lines.push('', 'BLOCKING ISSUES:');
    if (report.shellFiles > 0) {
      lines.push(`  ${report.shellFiles} SHELL_401 file(s) — AI failed during generation`);
    }
    if (report.sourceResidual > 0) {
      lines.push(`  ${report.sourceResidual} file(s) with source-language imports — prevents TypeScript compilation`);
    }
    if (report.totalSourceImports > 0) {
      lines.push(`  ${report.totalSourceImports} total source-language import(s) in target files`);
    }
  }

  return lines.join('\n');
}
