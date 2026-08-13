// ============================================================
// CodeMorph AI Engine — Static Validator
// PHASE 7: Post-generation static validation
//
// Checks:
//   1. TypeScript compilation (tsc --noEmit) when available
//   2. Broken imports (path resolution)
//   3. Source language imports in target files
//   4. Empty/shell files
//   5. Critical TODOs (function bodies that are pure TODO)
//   6. References to undefined symbols
//   7. Missing routes (routes referenced but not found)
// ============================================================

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { GeneratedFile } from '../models/ir.types';
import type { StaticValidationResult } from '../models/ir.types';

// ── Source language import patterns ─────────────────────────────────────────
const SOURCE_IMPORT_REGEXES: Array<{ pattern: RegExp; lang: string }> = [
  // Dart
  { pattern: /^import\s+['"]package:[^'"]+\.dart['"]/m,   lang: 'dart'   },
  { pattern: /^import\s+['"]dart:[^'"]+['"]/m,             lang: 'dart'   },
  // Swift
  { pattern: /^import\s+Foundation\b/m,                    lang: 'swift'  },
  { pattern: /^import\s+UIKit\b/m,                         lang: 'swift'  },
  // Kotlin/Android
  { pattern: /^import\s+android\./m,                       lang: 'kotlin' },
  // Flutter-specific in TypeScript context
  { pattern: /from\s+['"]flutter['"]/m,                    lang: 'flutter' },
  { pattern: /from\s+['"]riverpod['"]/m,                   lang: 'dart'   },
  { pattern: /from\s+['"]go_router['"]/m,                  lang: 'dart'   },
];

// ── Critical TODO detection (function body = only TODO) ──────────────────────
  /(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*(?:=>\s*)?)\s*\{[\s\n]*\/\/\s*TODO[^\n]*\n[\s\n]*\}/g;

// ── Detect broken relative imports ───────────────────────────────────────────
function detectBrokenImports(files: GeneratedFile[]): string[] {
  const filePaths   = new Set(files.map((f) => f.path));
  const broken: string[] = [];

  for (const file of files) {
    const importPattern = /(?:import|from)\s+['"](\.[^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = importPattern.exec(file.content)) !== null) {
      const importPath = m[1] ?? '';
      if (!importPath) continue;

      // Resolve relative path
      const fileDir   = path.dirname(file.path);
      const resolved  = path.normalize(path.join(fileDir, importPath));
      // Try common extensions
      const candidates = [resolved, `${resolved}.ts`, `${resolved}.tsx`, `${resolved}.js`, `${resolved}/index.ts`, `${resolved}/index.tsx`];
      const exists = candidates.some((c) => filePaths.has(c));
      if (!exists && !importPath.includes('node_modules') && !importPath.startsWith('@')) {
        broken.push(`${file.path}: cannot resolve '${importPath}'`);
      }
    }
  }
  return broken;
}

// ── Detect source language imports in all files ──────────────────────────────
function detectSourceImports(files: GeneratedFile[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    for (const { pattern, lang } of SOURCE_IMPORT_REGEXES) {
      const matches = file.content.match(new RegExp(pattern.source, 'gm'));
      if (matches) {
        for (const match of matches) {
          found.push(`${file.path} [${lang}]: ${match.trim()}`);
        }
      }
    }
  }
  return found;
}

// ── Detect empty/shell files ─────────────────────────────────────────────────
function detectEmptyFiles(files: GeneratedFile[]): string[] {
  return files
    .filter((f) => {
      const codeLines = f.content.split('\n').filter((l) => {
        const t = l.trim();
        return t && !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*') && !t.startsWith('#');
      }).length;
      return codeLines < 2;
    })
    .map((f) => f.path);
}

// ── Detect critical TODOs (entire function body is a TODO) ───────────────────
function detectCriticalTodos(files: GeneratedFile[]): string[] {
  const critical: string[] = [];
  for (const file of files) {
    // File is ALL todos (no real code)
    const codeLines = file.content.split('\n').filter((l) => {
      const t = l.trim();
      return t && !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*');
    });
    const todoLines = file.content.split('\n').filter((l) => /\/\/\s*TODO:/i.test(l)).length;
    if (codeLines.length > 0 && todoLines / codeLines.length > 0.5) {
      critical.push(`${file.path}: ${todoLines} TODOs out of ${codeLines} code lines (>50%)`);
    }
  }
  return critical;
}

// ── Detect undefined refs ─────────────────────────────────────────────────────
// Light check: function calls whose functions are never defined in the project
function detectUndefinedRefs(files: GeneratedFile[]): string[] {
  // Collect all exported function/class names
  const exported = new Set<string>();
  for (const file of files) {
    const exportPattern = /export\s+(?:default\s+)?(?:function|class|const|interface|type)\s+(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = exportPattern.exec(file.content)) !== null) {
      if (m[1]) exported.add(m[1]);
    }
  }
  // Simple: just check for common undefined patterns
  const found: string[] = [];
  for (const file of files) {
    // Check for calls to undefined store (zustand pattern)
    if (/use\w+Store/.test(file.content)) {
      const storeRefs = file.content.match(/use(\w+)Store/g) ?? [];
      for (const ref of storeRefs) {
        const storeName = ref.replace('use', '').replace('Store', '');
        const isExported = [...exported].some((e) => e.toLowerCase().includes(storeName.toLowerCase()));
        if (!isExported) {
          found.push(`${file.path}: ${ref} referenced but store not found in project`);
        }
      }
    }
  }
  return found;
}

// ── Detect missing routes ─────────────────────────────────────────────────────
function detectMissingRoutes(files: GeneratedFile[]): string[] {
  const missing: string[] = [];
  
  // Find layout file (Expo Router _layout.tsx)
  const layoutFile = files.find((f) => /_layout\.tsx?$/.test(f.path));
  if (!layoutFile) return [];

  // Extract screen names from layout
  const screenNamePattern = /Stack\.Screen\s+name=['"]([^'"]+)['"]/g;
  const referencedScreens: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = screenNamePattern.exec(layoutFile.content)) !== null) {
    if (m[1]) referencedScreens.push(m[1]);
  }

  // Check each referenced screen has a corresponding file
  for (const screenName of referencedScreens) {
    const screenFile = files.find((f) =>
      f.path.includes(`app/${screenName}`) || f.path.includes(`app/${screenName}.tsx`)
    );
    if (!screenFile) {
      missing.push(`Route '${screenName}' referenced in _layout.tsx but no screen file found`);
    }
  }
  return missing;
}

// ── TypeScript compilation check (runs tsc if node_modules exists) ────────────
async function attemptTsCompilation(
  files: GeneratedFile[],
  workDir: string,
): Promise<StaticValidationResult['tsCompilation']> {
  // Write files to temp dir
  let tmpDir = '';
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemorph-tsc-'));

    // Write all files
    for (const file of files) {
      const filePath = path.join(tmpDir, file.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, file.content, 'utf-8');
    }

    // Write minimal tsconfig for validation
    const tsConfig = {
      compilerOptions: {
        target: 'ES2020',
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-native',
        strict: false,
        noEmit: true,
        skipLibCheck: true,
        allowJs: true,
        esModuleInterop: true,
        resolveJsonModule: true,
      },
      include: ['**/*.ts', '**/*.tsx'],
      exclude: ['node_modules'],
    };
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify(tsConfig, null, 2));

    // Run tsc
    const tscBin = path.join(workDir, 'node_modules', '.bin', 'tsc');
    const hasTsc = fs.existsSync(tscBin);
    if (!hasTsc) {
      return { attempted: false, success: false, errors: [], warnings: [] };
    }

    try {
      execSync(`${tscBin} --noEmit`, { cwd: tmpDir, stdio: 'pipe', timeout: 30_000 });
      return { attempted: true, success: true, errors: [], warnings: [] };
    } catch (tscErr: unknown) {
      const output = (tscErr as { stdout?: Buffer; stderr?: Buffer })?.stdout?.toString() ?? '';
      const errors = output
        .split('\n')
        .filter((l) => /error TS/.test(l))
        .slice(0, 20);
      const warnings = output
        .split('\n')
        .filter((l) => /warning/i.test(l))
        .slice(0, 10);
      return { attempted: true, success: false, errors, warnings };
    }
  } catch {
    return { attempted: false, success: false, errors: [], warnings: [] };
  } finally {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

// ── Main: run static validation ───────────────────────────────────────────────
export async function runStaticValidation(
  files:          GeneratedFile[],
  workDir:        string = process.cwd(),
  _sourceLanguage: string = 'dart',
): Promise<StaticValidationResult> {
  console.log(`\n[StaticValidator] === Phase 7: Static Validation ===`);
  console.log(`[StaticValidator] Validating ${files.length} files...`);

  // Run all checks in parallel (except tsc which needs temp dir)
  const brokenImports  = detectBrokenImports(files);
  const sourceImports  = detectSourceImports(files);
  const emptyFiles     = detectEmptyFiles(files);
  const criticalTodos  = detectCriticalTodos(files);
  const undefinedRefs  = detectUndefinedRefs(files);
  const missingRoutes  = detectMissingRoutes(files);

  // TypeScript compilation (attempted only if tsc available)
  const tsCompilation  = await attemptTsCompilation(files, workDir);

  const overallPassed =
    tsCompilation.success !== false
    && sourceImports.length === 0
    && emptyFiles.length === 0;

  console.log(`[StaticValidator] TypeScript: ${tsCompilation.attempted ? (tsCompilation.success ? '✅' : `❌ ${tsCompilation.errors.length} errors`) : '⏭️  not attempted'}`);
  console.log(`[StaticValidator] Broken imports: ${brokenImports.length === 0 ? '✅' : `❌ ${brokenImports.length}`}`);
  console.log(`[StaticValidator] Source imports: ${sourceImports.length === 0 ? '✅' : `❌ ${sourceImports.length}`}`);
  console.log(`[StaticValidator] Empty files: ${emptyFiles.length === 0 ? '✅' : `❌ ${emptyFiles.length}`}`);
  console.log(`[StaticValidator] Critical TODOs: ${criticalTodos.length === 0 ? '✅' : `⚠️  ${criticalTodos.length}`}`);
  console.log(`[StaticValidator] Missing routes: ${missingRoutes.length === 0 ? '✅' : `❌ ${missingRoutes.length}`}`);
  console.log(`[StaticValidator] Overall: ${overallPassed ? '✅ PASSED' : '❌ FAILED'}`);
  console.log(`[StaticValidator] ==========================================\n`);

  return {
    tsCompilation,
    brokenImports,
    sourceImports,
    emptyFiles,
    criticalTodos,
    undefinedRefs,
    missingRoutes,
    overallPassed,
  };
}

// ── Quick sync version (no tsc) ───────────────────────────────────────────────
export function runStaticValidationSync(
  files: GeneratedFile[],
  _sourceLanguage: string = 'dart',
): Omit<StaticValidationResult, 'tsCompilation'> & { tsCompilation: null } {
  const brokenImports  = detectBrokenImports(files);
  const sourceImports  = detectSourceImports(files);
  const emptyFiles     = detectEmptyFiles(files);
  const criticalTodos  = detectCriticalTodos(files);
  const undefinedRefs  = detectUndefinedRefs(files);
  const missingRoutes  = detectMissingRoutes(files);

  const overallPassed =
    sourceImports.length === 0 && emptyFiles.length === 0;

  return {
    tsCompilation:  null,
    brokenImports,
    sourceImports,
    emptyFiles,
    criticalTodos,
    undefinedRefs,
    missingRoutes,
    overallPassed,
  };
}
