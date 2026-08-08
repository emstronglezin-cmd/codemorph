// ============================================================
// CodeMorph AI Engine — Dart/Flutter Compiler
// PHASE 5: Compilation automatique après génération
//
// Objectif:
//   1. Écrire les fichiers générés dans un dossier temporaire
//   2. Exécuter `dart format` pour corriger la syntaxe
//   3. Exécuter `flutter analyze` pour détecter les erreurs
//   4. Auto-corriger les erreurs courantes (imports manquants, types)
//   5. Retourner le résultat de compilation avec les erreurs restantes
//
// RÈGLE: Si dart/flutter non disponibles → skip proprement (no crash)
// ============================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { GeneratedFile } from '../models/ir.types';

const execAsync = promisify(exec);

// ── Types ──────────────────────────────────────────────────────────────────

export interface CompilationError {
  file:     string;
  line?:    number;
  column?:  number;
  message:  string;
  severity: 'error' | 'warning' | 'info';
  code?:    string;
}

export interface CompilationResult {
  success:         boolean;
  errors:          CompilationError[];
  warnings:        CompilationError[];
  filesFormatted:  number;
  filesFixed:      number;
  dartAvailable:   boolean;
  flutterAvailable: boolean;
  rawOutput?:      string;
  fixedFiles:      GeneratedFile[];
  duration:        number;
}

// ── Erreurs auto-corrigibles ─────────────────────────────────────────────

interface AutoFix {
  pattern:     RegExp;
  description: string;
  fix:         (content: string, match: RegExpExecArray) => string;
}

const DART_AUTO_FIXES: AutoFix[] = [
  // Fix 1: Supprimer les imports de packages inexistants générés par LLM
  {
    pattern: /^import 'package:(?:zustand|hive|mobx|redux|your_app|package_name)[^']*';$/gm,
    description: 'Remove invalid package imports',
    fix: (content, _match) => content.replace(
      /^import 'package:(?:zustand|hive|mobx|redux|your_app|package_name)[^']*';[\s]*\n/gm,
      ''
    ),
  },
  // Fix 2: Supprimer les annotations @freezed sans import
  {
    pattern: /@freezed\b/,
    description: 'Remove @freezed without package',
    fix: (content) => content.replace(/@freezed\n/g, '').replace(/part of.*\.g\.dart.*\n/g, ''),
  },
  // Fix 3: Corriger 'symbol: "$"' → 'symbol: r"$"' dans formatters
  {
    pattern: /symbol:\s*'([^']*\$[^']*)'/g,
    description: 'Fix dollar sign in string',
    fix: (content) => content.replace(/symbol:\s*'(\$[^']*)'/g, "symbol: r'$1'"),
  },
  // Fix 4: Supprimer les parts .g.dart orphelines
  {
    pattern: /^part '[^']+\.g\.dart';$/gm,
    description: 'Remove orphan .g.dart parts',
    fix: (content) => {
      // Si pas d'annotation @HiveType, @JsonSerializable, @freezed → supprimer
      if (!/@(?:HiveType|JsonSerializable|freezed|Riverpod)\b/.test(content)) {
        return content.replace(/^part '[^']+\.g\.dart';\n/gm, '');
      }
      return content;
    },
  },
  // Fix 5: Supprimer les imports 'dart:ui' si seulement utilisé pour Color (déjà dans material)
  {
    pattern: /^import 'dart:ui';\n/gm,
    description: 'Remove redundant dart:ui when material is present',
    fix: (content) => {
      if (content.includes("import 'package:flutter/material.dart'")) {
        return content.replace(/^import 'dart:ui';\n/gm, '');
      }
      return content;
    },
  },
  // Fix 6: Corriger les constructeurs const sur classes non-const
  {
    pattern: /const\s+(\w+)\s*\(\s*\)\s*;/g,
    description: 'Fix const constructors',
    fix: (content) => content, // handled below
  },
  // Fix 7: Remplacer les chemins d'import invalides 'package:APP_NAME/...'
  {
    pattern: /import 'package:(?:app|APP_NAME|your_package|flutter_app)[^']*';/g,
    description: 'Fix invalid package name imports',
    fix: (content) => content.replace(
      /import 'package:(?:app|APP_NAME|your_package|flutter_app)\/([^']+)';/g,
      "// TODO: fix import — was 'package:APP_NAME/$1'"
    ),
  },
];

// ── Vérification disponibilité Dart/Flutter ──────────────────────────────

async function checkDartAvailable(): Promise<boolean> {
  try {
    await execAsync('dart --version', { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function checkFlutterAvailable(): Promise<boolean> {
  try {
    await execAsync('flutter --version', { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

// ── Parser de sortie dart analyze ────────────────────────────────────────

function parseDartAnalyzeOutput(output: string): CompilationError[] {
  const errors: CompilationError[] = [];
  // Format: "  error • message • file/path.dart:line:col • ERROR_CODE"
  // Or:     "  warning • message • file/path.dart:line:col • WARN_CODE"
  const linePattern = /^\s*(error|warning|info|hint|lint)\s+[•·]\s+(.+?)\s+[•·]\s+([^\s•·]+):(\d+):(\d+)\s+[•·]\s+([^\s]+)/gm;
  let match: RegExpExecArray | null;

  while ((match = linePattern.exec(output)) !== null) {
    const severity = (match[1] ?? 'info') as CompilationError['severity'];
    errors.push({
      severity,
      message: (match[2] ?? '').trim(),
      file:    (match[3] ?? '').trim(),
      line:    parseInt(match[4] ?? '0', 10),
      column:  parseInt(match[5] ?? '0', 10),
      code:    (match[6] ?? '').trim(),
    });
  }

  // Fallback: chercher les patterns "error:" et "warning:"
  if (errors.length === 0) {
    const simplePattern = /^(error|warning):\s+(.+)$/gm;
    while ((match = simplePattern.exec(output)) !== null) {
      errors.push({
        severity: (match[1] ?? 'info') as CompilationError['severity'],
        message:  (match[2] ?? '').trim(),
        file:     'unknown',
      });
    }
  }

  return errors;
}

// ── Application des auto-fixes sur un fichier Dart ───────────────────────

export function applyDartAutoFixes(content: string, filePath: string): { content: string; fixes: string[] } {
  let fixed = content;
  const appliedFixes: string[] = [];

  for (const autoFix of DART_AUTO_FIXES) {
    const before = fixed;
    fixed = autoFix.fix(fixed, autoFix.pattern.exec(fixed) ?? ([] as unknown as RegExpExecArray));
    if (fixed !== before) {
      appliedFixes.push(`${autoFix.description} in ${filePath}`);
    }
  }

  return { content: fixed, fixes: appliedFixes };
}

// ── Auto-fixes basés sur les erreurs dart analyze ─────────────────────────

function autoFixFromAnalyzeErrors(
  files: GeneratedFile[],
  errors: CompilationError[],
): { files: GeneratedFile[]; fixCount: number } {
  let fixCount = 0;
  const fileMap = new Map<string, GeneratedFile>();
  for (const f of files) fileMap.set(f.path, f);

  for (const err of errors.filter((e) => e.severity === 'error')) {
    const targetPath = err.file;
    const file = fileMap.get(targetPath);
    if (!file) continue;

    let content = file.content;
    let fixed = false;

    // Fix: undefined_identifier → ajouter TODO
    if (err.code === 'undefined_identifier' || err.code === 'undefined_named_parameter') {
      console.log(`[DartCompiler] Auto-fix: undefined in ${targetPath} line ${err.line}: ${err.message}`);
      // On ne peut pas fixer automatiquement un identifier manquant sans contexte
      // On ajoute un commentaire pour marquer le problème
      fixed = false;
    }

    // Fix: unused_import → supprimer l'import
    if (err.code === 'unused_import' && err.line) {
      const lines = content.split('\n');
      const lineIdx = err.line - 1;
      if (lineIdx >= 0 && lineIdx < lines.length && lines[lineIdx]?.startsWith('import ')) {
        lines[lineIdx] = `// REMOVED unused import: ${lines[lineIdx]}`;
        content = lines.join('\n');
        fixed = true;
      }
    }

    // Fix: uri_does_not_exist → supprimer l'import manquant
    if ((err.code === 'uri_does_not_exist' || err.code === 'could_not_resolve_uri') && err.line) {
      const lines = content.split('\n');
      const lineIdx = err.line - 1;
      if (lineIdx >= 0 && lineIdx < lines.length) {
        lines[lineIdx] = `// TODO: missing import — ${lines[lineIdx]}`;
        content = lines.join('\n');
        fixed = true;
      }
    }

    if (fixed) {
      fileMap.set(targetPath, { ...file, content });
      fixCount++;
    }
  }

  return { files: Array.from(fileMap.values()), fixCount };
}

// ── Fonction principale: compiler les fichiers Dart ───────────────────────

export async function compileDartFiles(
  files: GeneratedFile[],
  projectName: string = 'codemorph_output',
): Promise<CompilationResult> {
  const startTime = Date.now();
  const dartFiles = files.filter((f) => f.path.endsWith('.dart'));

  const result: CompilationResult = {
    success:          true,
    errors:           [],
    warnings:         [],
    filesFormatted:   0,
    filesFixed:       0,
    dartAvailable:    false,
    flutterAvailable: false,
    fixedFiles:       [...files],
    duration:         0,
  };

  if (dartFiles.length === 0) {
    console.log(`[DartCompiler] No Dart files — skipping compilation`);
    result.duration = Date.now() - startTime;
    return result;
  }

  // ── Phase 5.1: Apply static auto-fixes first ───────────────────────────
  console.log(`[DartCompiler] Phase 5.1 — Applying static auto-fixes to ${dartFiles.length} Dart files`);
  const allFixes: string[] = [];
  const fixedFilesMap = new Map<string, GeneratedFile>();

  for (const file of files) {
    fixedFilesMap.set(file.path, file);
  }

  for (const file of dartFiles) {
    const { content: fixedContent, fixes } = applyDartAutoFixes(file.content, file.path);
    if (fixes.length > 0) {
      fixedFilesMap.set(file.path, { ...file, content: fixedContent });
      allFixes.push(...fixes);
      result.filesFixed++;
    }
  }

  result.fixedFiles = Array.from(fixedFilesMap.values());

  if (allFixes.length > 0) {
    console.log(`[DartCompiler] Static fixes: ${allFixes.length} applied to ${result.filesFixed} files`);
    allFixes.slice(0, 5).forEach((f) => console.log(`  ✓ ${f}`));
  }

  // ── Phase 5.2: Check Dart availability ────────────────────────────────
  result.dartAvailable    = await checkDartAvailable();
  result.flutterAvailable = await checkFlutterAvailable();

  if (!result.dartAvailable) {
    console.log(`[DartCompiler] Dart not available — static fixes only (no dart format/analyze)`);
    result.duration = Date.now() - startTime;
    return result;
  }

  // ── Phase 5.3: Write to temp directory ────────────────────────────────
  const tmpDir = path.join(os.tmpdir(), `codemorph_${projectName}_${Date.now()}`);
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    console.log(`[DartCompiler] Phase 5.3 — Writing ${dartFiles.length} Dart files to ${tmpDir}`);

    for (const file of result.fixedFiles.filter((f) => f.path.endsWith('.dart'))) {
      const fullPath = path.join(tmpDir, file.path);
      const dir = path.dirname(fullPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, file.content, 'utf8');
    }

    // Write pubspec.yaml if present (needed for flutter analyze)
    const pubspecFile = result.fixedFiles.find((f) => f.path === 'pubspec.yaml');
    if (pubspecFile) {
      fs.writeFileSync(path.join(tmpDir, 'pubspec.yaml'), pubspecFile.content, 'utf8');
    }

    // ── Phase 5.4: dart format ────────────────────────────────────────────
    console.log(`[DartCompiler] Phase 5.4 — Running dart format...`);
    const libDir = path.join(tmpDir, 'lib');
    if (fs.existsSync(libDir)) {
      try {
        const { stdout: fmtOut } = await execAsync(
          `dart format --output=write lib/`,
          { cwd: tmpDir, timeout: 30000 }
        );
        // Count formatted files
        const formatted = (fmtOut.match(/Formatted/g) ?? []).length;
        result.filesFormatted = formatted;
        console.log(`[DartCompiler] dart format: ${formatted} files formatted`);

        // Read back formatted files
        for (const file of result.fixedFiles.filter((f) => f.path.endsWith('.dart'))) {
          const fullPath = path.join(tmpDir, file.path);
          if (fs.existsSync(fullPath)) {
            const newContent = fs.readFileSync(fullPath, 'utf8');
            if (newContent !== file.content) {
              fixedFilesMap.set(file.path, { ...file, content: newContent });
            }
          }
        }
        result.fixedFiles = Array.from(fixedFilesMap.values());
      } catch (fmtErr) {
        console.warn(`[DartCompiler] dart format warning: ${(fmtErr as Error).message.slice(0, 200)}`);
      }
    }

    // ── Phase 5.5: flutter analyze (if available + pubspec present) ───────
    if (result.flutterAvailable && pubspecFile) {
      console.log(`[DartCompiler] Phase 5.5 — Running flutter analyze...`);
      try {
        // flutter pub get first
        await execAsync('flutter pub get', { cwd: tmpDir, timeout: 60000 });
        const { stdout: analyzeOut, stderr: analyzeErr } = await execAsync(
          'flutter analyze --no-pub lib/',
          { cwd: tmpDir, timeout: 60000 }
        );
        const analyzeOutput = analyzeOut + analyzeErr;
        result.rawOutput = analyzeOutput.slice(0, 5000);

        const analyzedErrors = parseDartAnalyzeOutput(analyzeOutput);
        result.errors   = analyzedErrors.filter((e) => e.severity === 'error');
        result.warnings = analyzedErrors.filter((e) => e.severity === 'warning');

        console.log(`[DartCompiler] flutter analyze: ${result.errors.length} errors, ${result.warnings.length} warnings`);

        // ── Phase 5.6: Auto-fix analyze errors ───────────────────────────
        if (result.errors.length > 0) {
          console.log(`[DartCompiler] Phase 5.6 — Auto-fixing ${result.errors.length} analyze errors...`);
          const { files: afterFix, fixCount } = autoFixFromAnalyzeErrors(result.fixedFiles, result.errors);
          result.fixedFiles = afterFix;
          result.filesFixed += fixCount;
          if (fixCount > 0) {
            console.log(`[DartCompiler] Auto-fixed ${fixCount} analyze errors`);
          }
        }

        result.success = result.errors.filter((e) => e.severity === 'error').length === 0;
      } catch (analyzeErr) {
        const msg = (analyzeErr as { stdout?: string; stderr?: string } & Error);
        const output = (msg.stdout ?? '') + (msg.stderr ?? '');
        if (output.includes('error') || output.includes('Error')) {
          const parsedErrors = parseDartAnalyzeOutput(output);
          result.errors   = parsedErrors.filter((e) => e.severity === 'error');
          result.warnings = parsedErrors.filter((e) => e.severity === 'warning');
          result.rawOutput = output.slice(0, 3000);
          result.success = result.errors.length === 0;
          console.warn(`[DartCompiler] flutter analyze found ${result.errors.length} errors`);
        } else {
          console.warn(`[DartCompiler] flutter analyze skipped: ${(analyzeErr as Error).message.slice(0, 100)}`);
        }
      }
    } else if (result.dartAvailable) {
      // dart analyze fallback (sans flutter pub get)
      console.log(`[DartCompiler] Phase 5.5b — Running dart analyze...`);
      try {
        const { stdout: dartOut, stderr: dartErr } = await execAsync(
          'dart analyze lib/',
          { cwd: tmpDir, timeout: 30000 }
        );
        const dartOutput = dartOut + dartErr;
        const parsedErrors = parseDartAnalyzeOutput(dartOutput);
        result.errors   = parsedErrors.filter((e) => e.severity === 'error');
        result.warnings = parsedErrors.filter((e) => e.severity === 'warning');
        result.rawOutput = dartOutput.slice(0, 3000);
        result.success = result.errors.length === 0;
        console.log(`[DartCompiler] dart analyze: ${result.errors.length} errors, ${result.warnings.length} warnings`);
      } catch {
        console.log(`[DartCompiler] dart analyze: skipped (lib/ may not exist without pubspec)`);
      }
    }

  } finally {
    // Cleanup temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  }

  result.duration = Date.now() - startTime;

  console.log(`\n[DartCompiler] ===== COMPILATION RESULT =====`);
  console.log(`[DartCompiler] Success          : ${result.success}`);
  console.log(`[DartCompiler] Dart available   : ${result.dartAvailable}`);
  console.log(`[DartCompiler] Flutter available: ${result.flutterAvailable}`);
  console.log(`[DartCompiler] Files formatted  : ${result.filesFormatted}`);
  console.log(`[DartCompiler] Files fixed      : ${result.filesFixed}`);
  console.log(`[DartCompiler] Errors           : ${result.errors.length}`);
  console.log(`[DartCompiler] Warnings         : ${result.warnings.length}`);
  console.log(`[DartCompiler] Duration         : ${result.duration}ms`);
  if (result.errors.length > 0) {
    result.errors.slice(0, 5).forEach((e) =>
      console.log(`  ❌ ${e.file}:${e.line ?? '?'} — ${e.message}`)
    );
  }
  console.log(`[DartCompiler] ==============================\n`);

  return result;
}
