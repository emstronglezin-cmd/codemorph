// ============================================================
// CodeMorph AI Engine — Import Verifier
// PHASE 28: Vérification et correction automatique des imports
//
// PROBLÈME:
//   Après génération, les fichiers TypeScript contiennent souvent :
//   - Imports vers des fichiers qui n'existent pas
//   - Imports avec mauvais nom (default vs named export)
//   - Imports relatifs avec mauvais chemin
//   - Imports de packages manquants
//
// SOLUTION:
//   1. Indexer tous les fichiers générés avec leurs exports
//   2. Pour chaque fichier, analyser tous les imports
//   3. Détecter les imports cassés (fichier inexistant ou export absent)
//   4. Corriger automatiquement :
//      - Chemin incorrect → chercher le bon fichier
//      - Default vs named → corriger la syntaxe
//      - Package manquant → ajouter un TODO d'installation
//   5. Reporter les imports non résolus
// ============================================================

import type { GeneratedFile } from '../models/ir.types';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ImportStatement {
  raw:          string;   // ligne import originale
  moduleSpec:   string;   // le chemin/package importé (ex: '../lib/api', 'react')
  isRelative:   boolean;  // true si commence par ./ ou ../
  isAbsolute:   boolean;  // true si commence par @/ ou ~/
  importedNames: string[]; // noms importés (default, {A, B, C})
  hasDefault:   boolean;  // true si import X from ...
  hasNamed:     boolean;  // true si import { X } from ...
  hasNamespace: boolean;  // true si import * as X from ...
  defaultAlias?: string;  // alias du default import (X dans import X from)
  namespaceAlias?: string; // alias du namespace (X dans import * as X)
  lineNumber:   number;   // ligne dans le fichier
}

export interface ExportInfo {
  filePath:       string;  // chemin dans le projet généré
  defaultExport?: string | undefined;  // nom de l'export default (ex: 'MyComponent')
  namedExports:   string[]; // exports nommés { A, B, C }
  hasDefaultExport: boolean;
}

export interface ImportFixResult {
  filePath:         string;
  originalImport:   string;
  fixedImport:      string;
  fixType:          'path-correction' | 'syntax-correction' | 'removed' | 'todo-added' | 'unchanged';
  reason:           string;
}

export interface VerificationReport {
  filesAnalyzed:   number;
  importsChecked:  number;
  importsFailed:   number;
  importsFixed:    number;
  importsUnresolved: number;
  fixes:           ImportFixResult[];
  unresolvedImports: Array<{ file: string; import: string; reason: string }>;
}

// ── Packages npm connus (évite de les marquer comme "cassés") ─────────────
const KNOWN_NPM_PACKAGES = new Set([
  'react', 'react-dom', 'react-native', 'react-router-dom',
  'expo', 'expo-router', 'expo-linking', 'expo-image-picker',
  '@react-navigation/native', '@react-navigation/stack', '@react-navigation/bottom-tabs',
  '@react-native-async-storage/async-storage', '@react-native-community/netinfo',
  'zustand', 'axios', 'dayjs', 'lodash', 'immer',
  '@tanstack/react-query', '@tanstack/react-table',
  '@nestjs/common', '@nestjs/core', '@nestjs/config', '@nestjs/jwt',
  '@nestjs/passport', '@nestjs/swagger', '@nestjs/typeorm',
  'typeorm', 'pg', 'reflect-metadata', 'rxjs', 'class-validator', 'class-transformer',
  'pino', 'dotenv',
  'firebase', '@react-native-firebase/app', '@react-native-firebase/auth',
  '@react-native-firebase/firestore',
  'styled-components', '@emotion/react', '@emotion/styled',
  'react-hook-form', 'zod', 'yup', 'joi',
  'moment', 'date-fns',
  'socket.io', 'socket.io-client',
  '@stripe/stripe-js', '@stripe/react-stripe-js',
  'chart.js', 'recharts',
  'framer-motion', 'react-spring',
]);

// Préfixes de packages connus
const KNOWN_NPM_PREFIXES = [
  '@mui/', '@chakra-ui/', '@radix-ui/', '@headlessui/',
  '@stripe/', '@firebase/', '@google/', '@sentry/',
  '@react-native-community/', '@expo/', 'expo-',
  'react-native-', '@shopify/', '@gorhom/',
];

// ── Parseur d'imports TypeScript ──────────────────────────────────────────

/**
 * Parse toutes les déclarations import d'un fichier TypeScript
 */
export function parseImports(content: string): ImportStatement[] {
  const imports: ImportStatement[] = [];
  const lines   = content.split('\n');

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum] ?? '';
    const trimmed = line.trim();

    if (!trimmed.startsWith('import ') && !trimmed.startsWith('export ')) continue;

    // Parser les différents patterns d'import

    // Pattern 1: import X from 'module'
    const defaultOnly = trimmed.match(/^import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
    if (defaultOnly?.[1] && defaultOnly?.[2]) {
      imports.push({
        raw:           trimmed,
        moduleSpec:    defaultOnly[2],
        isRelative:    isRelativePath(defaultOnly[2]),
        isAbsolute:    isAbsolutePath(defaultOnly[2]),
        importedNames: [defaultOnly[1]],
        hasDefault:    true,
        hasNamed:      false,
        hasNamespace:  false,
        defaultAlias:  defaultOnly[1],
        lineNumber:    lineNum,
      });
      continue;
    }

    // Pattern 2: import { A, B, C } from 'module'
    const namedOnly = trimmed.match(/^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
    if (namedOnly?.[1] && namedOnly?.[2]) {
      const names = namedOnly[1].split(',').map((n) => n.trim().split(' as ')[0]?.trim() ?? '').filter(Boolean);
      imports.push({
        raw:           trimmed,
        moduleSpec:    namedOnly[2],
        isRelative:    isRelativePath(namedOnly[2]),
        isAbsolute:    isAbsolutePath(namedOnly[2]),
        importedNames: names,
        hasDefault:    false,
        hasNamed:      true,
        hasNamespace:  false,
        lineNumber:    lineNum,
      });
      continue;
    }

    // Pattern 3: import X, { A, B } from 'module'
    const mixed = trimmed.match(/^import\s+(\w+)\s*,\s*\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
    if (mixed?.[1] && mixed?.[2] && mixed?.[3]) {
      const names = mixed[2].split(',').map((n) => n.trim().split(' as ')[0]?.trim() ?? '').filter(Boolean);
      imports.push({
        raw:           trimmed,
        moduleSpec:    mixed[3],
        isRelative:    isRelativePath(mixed[3]),
        isAbsolute:    isAbsolutePath(mixed[3]),
        importedNames: [mixed[1], ...names],
        hasDefault:    true,
        hasNamed:      true,
        hasNamespace:  false,
        defaultAlias:  mixed[1],
        lineNumber:    lineNum,
      });
      continue;
    }

    // Pattern 4: import * as X from 'module'
    const namespace = trimmed.match(/^import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
    if (namespace?.[1] && namespace?.[2]) {
      imports.push({
        raw:           trimmed,
        moduleSpec:    namespace[2],
        isRelative:    isRelativePath(namespace[2]),
        isAbsolute:    isAbsolutePath(namespace[2]),
        importedNames: [namespace[1]],
        hasDefault:    false,
        hasNamed:      false,
        hasNamespace:  true,
        namespaceAlias: namespace[1],
        lineNumber:    lineNum,
      });
      continue;
    }

    // Pattern 5: import 'module' (side-effect)
    const sideEffect = trimmed.match(/^import\s+['"]([^'"]+)['"]/);
    if (sideEffect?.[1]) {
      imports.push({
        raw:           trimmed,
        moduleSpec:    sideEffect[1],
        isRelative:    isRelativePath(sideEffect[1]),
        isAbsolute:    isAbsolutePath(sideEffect[1]),
        importedNames: [],
        hasDefault:    false,
        hasNamed:      false,
        hasNamespace:  false,
        lineNumber:    lineNum,
      });
    }
  }

  return imports;
}

function isRelativePath(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../');
}

function isAbsolutePath(spec: string): boolean {
  return spec.startsWith('@/') || spec.startsWith('~/') || spec.startsWith('src/');
}

// ── Indexeur d'exports ────────────────────────────────────────────────────

/**
 * Construit un index de tous les exports des fichiers générés
 */
export function buildExportIndex(files: GeneratedFile[]): Map<string, ExportInfo> {
  const index = new Map<string, ExportInfo>();

  for (const file of files) {
    if (!file.content) continue;

    const ext = file.path.split('.').pop()?.toLowerCase() ?? '';
    if (!['ts', 'tsx', 'js', 'jsx'].includes(ext)) continue;

    const info = extractExports(file.content, file.path);
    index.set(file.path, info);

    // Indexer aussi sans extension pour la résolution des imports
    const withoutExt = file.path.replace(/\.(ts|tsx|js|jsx)$/, '');
    index.set(withoutExt, info);
  }

  return index;
}

/**
 * Extrait les exports d'un fichier TypeScript
 */
function extractExports(content: string, filePath: string): ExportInfo {
  const namedExports: string[] = [];
  let defaultExport: string | undefined;
  let hasDefaultExport = false;

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();

    // export default function/class/const
    const defaultFunc = trimmed.match(/^export\s+default\s+(?:function|class|const)?\s*(\w+)/);
    if (defaultFunc?.[1]) {
      defaultExport = defaultFunc[1];
      hasDefaultExport = true;
      continue;
    }

    // export default X
    const defaultId = trimmed.match(/^export\s+default\s+(\w+)/);
    if (defaultId?.[1]) {
      defaultExport = defaultId[1];
      hasDefaultExport = true;
      continue;
    }

    // export { A, B, C }
    const namedBlock = trimmed.match(/^export\s+\{([^}]+)\}/);
    if (namedBlock?.[1]) {
      const names = namedBlock[1].split(',').map((n) => n.trim().split(' as ')[0]?.trim() ?? '').filter(Boolean);
      namedExports.push(...names);
      continue;
    }

    // export const/function/class/interface/type/enum X
    const namedDecl = trimmed.match(/^export\s+(?:const|function|class|interface|type|enum|abstract\s+class)\s+(\w+)/);
    if (namedDecl?.[1]) {
      namedExports.push(namedDecl[1]);
    }

    // export async function X
    const asyncFunc = trimmed.match(/^export\s+async\s+function\s+(\w+)/);
    if (asyncFunc?.[1]) {
      namedExports.push(asyncFunc[1]);
    }
  }

  return { filePath, defaultExport, namedExports, hasDefaultExport };
}

// ── Résolveur de chemin relatif ────────────────────────────────────────────

/**
 * Résout un chemin relatif depuis un fichier source vers sa cible
 */
function resolveRelativePath(fromFile: string, importSpec: string): string {
  const fromDir = fromFile.split('/').slice(0, -1).join('/');
  const parts   = importSpec.split('/');
  const result  = fromDir.split('/');

  for (const part of parts) {
    if (part === '..') {
      result.pop();
    } else if (part !== '.') {
      result.push(part);
    }
  }

  return result.join('/');
}

/**
 * Cherche le bon fichier dans l'index quand le chemin exact ne matche pas
 */
function findBestMatch(
  spec:        string,
  fromFile:    string,
  exportIndex: Map<string, ExportInfo>,
): string | null {
  // Essayer avec différentes extensions
  const extensions = ['.tsx', '.ts', '.jsx', '.js'];
  const resolved   = resolveRelativePath(fromFile, spec);

  for (const ext of extensions) {
    const candidate = resolved + ext;
    if (exportIndex.has(candidate)) return candidate;
    if (exportIndex.has(resolved)) return resolved;
  }

  // Chercher par nom de fichier seul (cas où le chemin est incorrect mais le fichier existe)
  const fileName = spec.split('/').pop() ?? '';
  if (fileName) {
    for (const [path] of exportIndex) {
      if (path.endsWith(`/${fileName}`) || path.endsWith(`/${fileName}.ts`) || path.endsWith(`/${fileName}.tsx`)) {
        return path;
      }
    }
  }

  return null;
}

// ── Vérificateur principal ────────────────────────────────────────────────

/**
 * Vérifie et corrige automatiquement les imports d'une liste de fichiers générés
 */
export function verifyAndFixImports(files: GeneratedFile[]): {
  files:  GeneratedFile[];
  report: VerificationReport;
} {
  console.log(`\n[ImportVerifier] ===== IMPORT VERIFICATION START =====`);
  console.log(`[ImportVerifier] Analyzing ${files.length} files...`);

  const exportIndex = buildExportIndex(files);
  const fixedFiles: GeneratedFile[] = [];
  const report: VerificationReport = {
    filesAnalyzed:     0,
    importsChecked:    0,
    importsFailed:     0,
    importsFixed:      0,
    importsUnresolved: 0,
    fixes:             [],
    unresolvedImports: [],
  };

  for (const file of files) {
    const ext = file.path.split('.').pop()?.toLowerCase() ?? '';
    if (!['ts', 'tsx', 'js', 'jsx'].includes(ext) || !file.content) {
      fixedFiles.push(file);
      continue;
    }

    report.filesAnalyzed++;

    const { fixedContent, fileFixes, fileUnresolved } = fixFileImports(
      file.content,
      file.path,
      exportIndex,
    );

    report.importsChecked  += fileFixes.length + fileUnresolved.length;
    report.importsFailed   += fileFixes.filter((f) => f.fixType !== 'unchanged').length;
    report.importsFixed    += fileFixes.filter((f) => f.fixType !== 'unchanged' && f.fixType !== 'todo-added').length;
    report.importsUnresolved += fileUnresolved.length;
    report.fixes.push(...fileFixes);
    report.unresolvedImports.push(...fileUnresolved.map((u) => ({
      file: file.path, import: u, reason: 'Module not found in generated files',
    })));

    const wasModified = fixedContent !== file.content;
    fixedFiles.push({
      ...file,
      content:  fixedContent,
      warnings: [
        ...(file.warnings ?? []),
        ...(wasModified ? [`ImportVerifier: fixed ${fileFixes.filter((f) => f.fixType !== 'unchanged').length} import(s)`] : []),
        ...(fileUnresolved.length > 0 ? [`ImportVerifier: ${fileUnresolved.length} unresolved import(s)`] : []),
      ],
    });
  }

  // ── Rapport final ─────────────────────────────────────────
  console.log(`[ImportVerifier] Files analyzed:    ${report.filesAnalyzed}`);
  console.log(`[ImportVerifier] Imports checked:   ${report.importsChecked}`);
  console.log(`[ImportVerifier] Imports fixed:     ${report.importsFixed}`);
  console.log(`[ImportVerifier] Unresolved:        ${report.importsUnresolved}`);

  if (report.unresolvedImports.length > 0) {
    console.warn(`[ImportVerifier] ⚠️  Unresolved imports:`);
    report.unresolvedImports.slice(0, 10).forEach((u) => {
      console.warn(`  → ${u.file}: import '${u.import}'`);
    });
  }

  console.log(`[ImportVerifier] ===== IMPORT VERIFICATION END =====\n`);

  return { files: fixedFiles, report };
}

// ── Correction des imports d'un fichier ───────────────────────────────────

function fixFileImports(
  content:     string,
  filePath:    string,
  exportIndex: Map<string, ExportInfo>,
): { fixedContent: string; fileFixes: ImportFixResult[]; fileUnresolved: string[] } {
  const imports     = parseImports(content);
  const lines       = content.split('\n');
  const fixes:      ImportFixResult[] = [];
  const unresolved: string[]          = [];

  for (const imp of imports) {
    // ── Packages npm connus → OK, pas de fix nécessaire ──────
    if (!imp.isRelative && !imp.isAbsolute) {
      const isKnown = KNOWN_NPM_PACKAGES.has(imp.moduleSpec) ||
        KNOWN_NPM_PREFIXES.some((p) => imp.moduleSpec.startsWith(p));

      if (!isKnown) {
        // Package inconnu → ajouter un TODO mais ne pas casser l'import
        fixes.push({
          filePath,
          originalImport: imp.raw,
          fixedImport:    imp.raw,
          fixType:        'unchanged',
          reason:         `npm package '${imp.moduleSpec}' — verify it's installed`,
        });
      }
      continue;
    }

    // ── Import relatif → vérifier existence ──────────────────
    if (imp.isRelative) {
      const resolved  = resolveRelativePath(filePath, imp.moduleSpec);
      const hasFile   = exportIndex.has(resolved) ||
        exportIndex.has(resolved + '.ts')  ||
        exportIndex.has(resolved + '.tsx') ||
        exportIndex.has(resolved + '/index.ts') ||
        exportIndex.has(resolved + '/index.tsx');

      if (hasFile) {
        // Vérifier la cohérence default/named si possible
        const exportInfo = exportIndex.get(resolved)
          ?? exportIndex.get(resolved + '.ts')
          ?? exportIndex.get(resolved + '.tsx');

        if (exportInfo) {
          const fix = checkImportConsistency(imp, exportInfo, filePath);
          if (fix) {
            fixes.push(fix);
            // Appliquer le fix dans les lignes
            if (imp.lineNumber < lines.length) {
              lines[imp.lineNumber] = fix.fixedImport;
            }
          } else {
            fixes.push({
              filePath, originalImport: imp.raw, fixedImport: imp.raw,
              fixType: 'unchanged', reason: 'Import OK',
            });
          }
        }
        continue;
      }

      // Fichier non trouvé → chercher une alternative
      const bestMatch = findBestMatch(imp.moduleSpec, filePath, exportIndex);

      if (bestMatch) {
        // Calculer le chemin relatif correct
        const fixedSpec  = computeRelativePath(filePath, bestMatch);
        const fixedLine  = imp.raw.replace(imp.moduleSpec, fixedSpec);
        fixes.push({
          filePath,
          originalImport: imp.raw,
          fixedImport:    fixedLine,
          fixType:        'path-correction',
          reason:         `'${imp.moduleSpec}' → '${fixedSpec}' (found at ${bestMatch})`,
        });
        if (imp.lineNumber < lines.length) {
          lines[imp.lineNumber] = fixedLine;
        }
      } else {
        // Impossible à résoudre
        unresolved.push(imp.moduleSpec);
        const todoComment = `// TODO(import-verifier): Cannot resolve '${imp.moduleSpec}' — file may need to be created\n// ${imp.raw}`;
        if (imp.lineNumber < lines.length) {
          lines[imp.lineNumber] = todoComment;
        }
        fixes.push({
          filePath,
          originalImport: imp.raw,
          fixedImport:    todoComment,
          fixType:        'todo-added',
          reason:         `Module '${imp.moduleSpec}' not found in generated files`,
        });
      }
    }
  }

  return {
    fixedContent: lines.join('\n'),
    fileFixes:    fixes,
    fileUnresolved: unresolved,
  };
}

/**
 * Vérifie la cohérence default vs named export
 */
function checkImportConsistency(
  imp:        ImportStatement,
  exportInfo: ExportInfo,
  filePath:   string,
): ImportFixResult | null {
  // Import default mais le module n'a pas d'export default
  if (imp.hasDefault && !imp.hasNamed && !exportInfo.hasDefaultExport) {
    if (exportInfo.namedExports.length > 0) {
      // Convertir en named import
      const names = imp.importedNames.join(', ');
      const fixedLine = `import { ${names} } from '${imp.moduleSpec}';`;
      return {
        filePath,
        originalImport: imp.raw,
        fixedImport:    fixedLine,
        fixType:        'syntax-correction',
        reason:         `'${imp.moduleSpec}' has no default export — converted to named import { ${names} }`,
      };
    }
  }

  // Import named mais le module n'a que l'export default
  if (!imp.hasDefault && imp.hasNamed && exportInfo.hasDefaultExport && exportInfo.namedExports.length === 0) {
    const defaultName = exportInfo.defaultExport ?? imp.importedNames[0] ?? 'Component';
    const fixedLine   = `import ${defaultName} from '${imp.moduleSpec}';`;
    return {
      filePath,
      originalImport: imp.raw,
      fixedImport:    fixedLine,
      fixType:        'syntax-correction',
      reason:         `'${imp.moduleSpec}' only has default export — converted to: import ${defaultName}`,
    };
  }

  return null; // Pas de correction nécessaire
}

/**
 * Calcule le chemin relatif de fromFile vers toFile
 */
function computeRelativePath(fromFile: string, toFile: string): string {
  const fromParts = fromFile.split('/').slice(0, -1);
  const toParts   = toFile.replace(/\.(ts|tsx|js|jsx)$/, '').split('/');

  let commonLength = 0;
  while (
    commonLength < fromParts.length &&
    commonLength < toParts.length &&
    fromParts[commonLength] === toParts[commonLength]
  ) {
    commonLength++;
  }

  const ups   = fromParts.length - commonLength;
  const downs = toParts.slice(commonLength);

  const parts = [...Array(ups).fill('..'), ...downs];
  const rel   = parts.join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

// ── Type checker léger (sans tsc) ─────────────────────────────────────────

export interface TypeIssue {
  filePath:  string;
  line:      number;
  message:   string;
  severity:  'error' | 'warning';
}

/**
 * Détection légère de problèmes TypeScript sans exécuter tsc
 * Couvre les cas les plus courants que le LLM introduit
 */
export function detectTypeIssues(files: GeneratedFile[]): TypeIssue[] {
  const issues: TypeIssue[] = [];

  for (const file of files) {
    if (!file.content) continue;
    const ext = file.path.split('.').pop()?.toLowerCase() ?? '';
    if (!['ts', 'tsx'].includes(ext)) continue;

    const lines = file.content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';

      // Détecter: any implicite sans type annotation
      if (/:\s*any\b/.test(line) && !line.trim().startsWith('//')) {
        issues.push({
          filePath: file.path, line: i + 1,
          message: `Implicit 'any' type — consider using 'unknown' or a specific type`,
          severity: 'warning',
        });
      }

      // Détecter: require() dans TypeScript strict
      if (/\brequire\s*\(/.test(line) && !line.trim().startsWith('//')) {
        issues.push({
          filePath: file.path, line: i + 1,
          message: `CommonJS require() in TypeScript — convert to ES import`,
          severity: 'error',
        });
      }

      // Détecter: async sans await ni return
      if (/\basync\s+function\b/.test(line)) {
        const funcBody = lines.slice(i, i + 20).join('\n');
        if (!funcBody.includes('await') && !funcBody.includes('return') && !funcBody.includes('Promise')) {
          issues.push({
            filePath: file.path, line: i + 1,
            message: `async function without await/return — may be unintentional`,
            severity: 'warning',
          });
        }
      }

      // Détecter: non-null assertion excessive
      if ((line.match(/!/g) ?? []).length > 3 && !line.trim().startsWith('//')) {
        issues.push({
          filePath: file.path, line: i + 1,
          message: `Multiple non-null assertions (!) — consider proper type narrowing`,
          severity: 'warning',
        });
      }

      // Détecter: console.log qui traîne
      if (/\bconsole\.log\b/.test(line) && !line.trim().startsWith('//')) {
        issues.push({
          filePath: file.path, line: i + 1,
          message: `console.log() in production code — remove or replace with logger`,
          severity: 'warning',
        });
      }
    }
  }

  return issues;
}

/**
 * Génère un rapport de vérification TypeScript lisible
 */
export function formatTypeReport(issues: TypeIssue[]): string {
  if (issues.length === 0) return '✅ No TypeScript issues detected';

  const errors   = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;

  const lines = [
    `TypeScript Issues: ${errors} errors, ${warnings} warnings`,
    '',
    ...issues.slice(0, 20).map((i) =>
      `  [${i.severity.toUpperCase()}] ${i.filePath}:${i.line} — ${i.message}`
    ),
  ];

  if (issues.length > 20) {
    lines.push(`  ... and ${issues.length - 20} more issues`);
  }

  return lines.join('\n');
}
