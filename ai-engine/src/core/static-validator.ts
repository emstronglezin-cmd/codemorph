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
import type {
  StaticValidationResult, ValidationCheckResult, SourceEntities,
} from '../models/ir.types';
import { validateProjectIntegrity } from './project-integrity-validator';

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
    // FIX PHASE 46 — FAUX POSITIF : `tsconfig.json` est du JSON minifié sur une
    // seule ligne. Il était systématiquement signalé comme « fichier vide », ce
    // qui faisait échouer `overallPassed` sur toutes les conversions. On ne
    // contrôle que les fichiers SOURCES ; les manifestes/configs JSON sont validés
    // par ailleurs (project-integrity-validator : invalid-config-json).
    .filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f.path))
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

    // ── PHASE 45 : localisation robuste du binaire tsc ──────────────────────
    // AVANT : `path.join(workDir, 'node_modules', '.bin', 'tsc')` uniquement.
    // Avec des workspaces npm, `tsc` est HOISTÉ à la racine du monorepo : depuis
    // `ai-engine/`, le chemin n'existe pas et la fonction retournait
    // silencieusement `attempted: false` — la compilation n'était donc jamais
    // tentée, sans aucun signal.
    // On remonte maintenant l'arborescence, avec repli sur require.resolve.
    let tscBin: string | null = null;
    let dir = path.resolve(workDir);
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, 'node_modules', '.bin', 'tsc');
      if (fs.existsSync(candidate)) { tscBin = candidate; break; }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!tscBin) {
      try {
        // Repli : le paquet typescript résolu depuis ce module.
        const tsEntry = require.resolve('typescript/package.json', { paths: [workDir, __dirname] });
        const bin = path.join(path.dirname(tsEntry), 'bin', 'tsc');
        if (fs.existsSync(bin)) tscBin = bin;
      } catch { /* non résolu */ }
    }
    if (!tscBin) {
      console.warn('[StaticValidator] tsc introuvable — compilation NON tentée (signalé, pas ignoré)');
      return { attempted: false, success: false, errors: [], warnings: [] };
    }

    // ── PHASE 46 : rendre les dépendances RÉELLEMENT disponibles ────────────
    // Le dépôt fournit `react`, `@types/react` et `typescript`. En liant son
    // `node_modules` au répertoire de validation, ces paquets sont résolus pour
    // de vrai : `React.JSX.Element` et `useState<T>()` sont alors vérifiés au
    // lieu de produire des erreurs en cascade. Seuls les paquets réellement
    // absents (react-native, expo…) restent déclarés comme modules ambiants.
    // Plus on résout réellement, moins il y a d'angles morts.
    try {
      let nmDir = path.resolve(workDir);
      let foundNm: string | null = null;
      for (let i = 0; i < 8; i++) {
        const candidate = path.join(nmDir, 'node_modules');
        if (fs.existsSync(candidate)) { foundNm = candidate; break; }
        const parent = path.dirname(nmDir);
        if (parent === nmDir) break;
        nmDir = parent;
      }
      if (foundNm) {
        const link = path.join(tmpDir, 'node_modules');
        if (!fs.existsSync(link)) {
          fs.symlinkSync(foundNm, link, process.platform === 'win32' ? 'junction' : 'dir');
        }
      }
    } catch {
      // Échec de liaison : on continue, les paquets absents seront ambiants.
    }

    try {
      const cmd = tscBin.endsWith('.js') ? `node "${tscBin}" --noEmit` : `"${tscBin}" --noEmit`;
      execSync(cmd, { cwd: tmpDir, stdio: 'pipe', timeout: 60_000 });
      return { attempted: true, success: true, errors: [], warnings: [] };
    } catch (tscErr: unknown) {
      const output = (tscErr as { stdout?: Buffer; stderr?: Buffer })?.stdout?.toString() ?? '';
      const allErrors = output.split('\n').filter((l) => /error TS/.test(l));

      // ── PHASE 45 : classification honnête des erreurs ────────────────────
      // Le projet GÉNÉRÉ n'a pas ses node_modules dans ce répertoire temporaire.
      // `tsc` signale donc « Cannot find module 'react-native' » pour chaque
      // dépendance externe. Compter cela comme un échec produirait un faux
      // négatif systématique ; l'ignorer produirait un faux positif.
      // On sépare donc :
      //   • erreurs sur des modules EXTERNES (spécificateur non relatif)
      //     → « non vérifiable sans installer les dépendances » ;
      //   • tout le reste (imports relatifs, types, symboles indéfinis)
      //     → vrais échecs, qui font échouer la validation.
      const EXTERNAL_MODULE = /Cannot find module '([^'.][^']*)'|Cannot find module "([^".][^"]*)"/;
      const external: string[] = [];
      const real:     string[] = [];
      for (const line of allErrors) {
        const m = EXTERNAL_MODULE.exec(line);
        if (m) external.push((m[1] ?? m[2] ?? '').trim());
        else real.push(line);
      }
      const unverifiableModules = [...new Set(external.filter(Boolean))];

      const warnings = output
        .split('\n')
        .filter((l) => /warning/i.test(l))
        .slice(0, 10);

      // ── PHASE 46 : second passage avec déclarations ambiantes ──────────────
      // Un module externe non résolu ne produit pas seulement « Cannot find
      // module » : il CASCADE. `TouchableOpacityProps` devient inconnu, donc
      // `interface ButtonProps extends TouchableOpacityProps` n'hérite de rien,
      // et chaque accès à `disabled`/`style` remonte en TS2339. Sans ce second
      // passage, TOUTE conversion React Native échouait sur des erreurs qui ne
      // sont pas des défauts du code généré.
      //
      // On déclare les paquets manquants comme modules ambiants (types permissifs)
      // puis on relance tsc UNE fois. Les erreurs restantes sont alors de vraies
      // incohérences LOCALES. Limitation assumée et déclarée : les API de ces
      // paquets ne sont PAS vérifiées — d'où `unverifiableModules`.
      if (unverifiableModules.length > 0) {
        const ambient = unverifiableModules
          .map((m) => `declare module '${m}';`)
          .join('\n');
        fs.writeFileSync(
          path.join(tmpDir, 'codemorph-ambient.d.ts'),
          `// Généré par CodeMorph : les dépendances du projet ne sont pas installées\n` +
          `// dans ce répertoire de validation. Ces déclarations évitent les erreurs en\n` +
          `// cascade ; les API de ces paquets ne sont DONC PAS vérifiées.\n${ambient}\n`,
        );
        try {
          const cmd2 = tscBin.endsWith('.js') ? `node "${tscBin}" --noEmit` : `"${tscBin}" --noEmit`;
          execSync(cmd2, { cwd: tmpDir, stdio: 'pipe', timeout: 60_000 });
          return {
            attempted: true, success: true, errors: [], warnings, unverifiableModules,
          };
        } catch (tscErr2: unknown) {
          const out2 = (tscErr2 as { stdout?: Buffer })?.stdout?.toString() ?? '';
          // Une déclaration ambiante rend le MODULE permissif, mais pas ses
          // ESPACES DE NOMS de types : `React.JSX.Element` remonte en TS2694
          // (« Namespace '"react"' has no exported member 'JSX' ») uniquement
          // parce que `@types/react` n'est pas installé. On écarte donc les
          // erreurs qui citent explicitement un module déclaré ambiant — et
          // uniquement celles-là : toute autre erreur reste un échec réel.
          // tsc écrit le nom du module entre guillemets SIMPLES ou DOUBLES selon
          // le diagnostic (`'"react"'` pour TS2694, `'react'` pour TS2307).
          const ambientNames = unverifiableModules.flatMap((m) => [`'${m}'`, `"${m}"`, m]);
          //
          // LIMITE ASSUMÉE ET DOCUMENTÉE : une déclaration ambiante rend un
          // module permissif en position de VALEUR, mais pas en position de TYPE.
          // `interface ButtonProps extends TouchableOpacityProps` produit donc
          // TS2709 (« Cannot use namespace … as a type ») puis des TS2339 en
          // cascade sur `ButtonProps` lui-même — le nom ambiant n'apparaît même
          // plus dans le message.
          //
          // Sans installer `react-native`/`expo`, ces fichiers ne sont PAS
          // vérifiables. On exclut donc les erreurs issues de fichiers qui
          // importent un module non installé, et on le déclare explicitement via
          // `unverifiableModules`. Les fichiers qui n'en dépendent pas (modèles,
          // services, état) restent INTÉGRALEMENT vérifiés.
          const ambientSet = new Set(unverifiableModules);
          const unverifiableFiles = new Set<string>();
          for (const file of files) {
            if (!/\.(ts|tsx|js|jsx)$/.test(file.path)) continue;
            const specs = file.content.match(/from\s*['"]([^'"]+)['"]/g) ?? [];
            const importsAmbient = specs.some((sp) => {
              const spec = sp.replace(/^from\s*['"]/, '').replace(/['"]$/, '');
              const pkgName = spec.startsWith('@')
                ? spec.split('/').slice(0, 2).join('/')
                : (spec.split('/')[0] ?? '');
              return !spec.startsWith('.') && ambientSet.has(pkgName);
            });
            if (importsAmbient) unverifiableFiles.add(file.path);
          }
          const realErrors = out2
            .split('\n')
            .filter((l) => /error TS/.test(l))
            .filter((l) => !ambientNames.some((n) => l.includes(n)))
            .filter((l) => ![...unverifiableFiles].some((fp) => l.startsWith(fp)));
          return {
            attempted: true,
            success:   realErrors.length === 0,
            errors:    realErrors.slice(0, 20),
            warnings,
            unverifiableModules,
          };
        }
      }

      return {
        attempted: true,
        // Le succès ne dépend QUE des erreurs réellement vérifiables.
        success:   real.length === 0,
        errors:    real.slice(0, 20),
        warnings,
        unverifiableModules,
      };
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
// ── PHASE 48 : survie des entités source ─────────────────────────────────────
// Un projet généré peut être structurellement impeccable (imports résolus, tsc
// vert, routes cohérentes) et ne pourtant contenir AUCUNE des entités métier de
// la source. Sans ce contrôle, une telle conversion était rapportée PASS.

const SUFFIXES = /(?:screen|service|widget|model|repository|controller|manager|impl|view|page)$/i;

/** `TaskTile` / `task-tile` / `Task Tile` → `tasktile`. */
function normEntity(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

/** Nom de base sans suffixe de rôle : `TaskService` → `task`. */
function baseEntity(name: string): string {
  const n = normEntity(name);
  return n.replace(SUFFIXES, '') || n;
}

export interface MissingSourceEntity {
  kind:     'model' | 'service' | 'screen' | 'widget';
  name:     string;
  expected: string;
}

export function detectMissingSourceEntities(
  files:    GeneratedFile[],
  entities: SourceEntities,
): MissingSourceEntity[] {
  const missing: MissingSourceEntity[] = [];
  const code      = files.map((f) => f.content).join('\n');
  const pathsNorm = files.map((f) => normEntity(f.path.replace(/\.[^.]+$/, '')));
  const inPath    = (needle: string): boolean => pathsNorm.some((p) => p.includes(needle));

  // Modèles : on exige une DÉCLARATION du type, pas une simple occurrence.
  for (const m of entities.models) {
    const declared = new RegExp(
      `\\b(?:interface|type|class)\\s+${m.replace(/[^A-Za-z0-9_]/g, '')}\\b`).test(code);
    if (!declared) missing.push({ kind: 'model', name: m, expected: `interface|type|class ${m}` });
  }

  // Services : un fichier dont le chemin porte le nom de base, ou une déclaration.
  for (const sv of entities.services) {
    const base = baseEntity(sv);
    const ok   = base.length > 1 && inPath(base) ||
      new RegExp(`\\b(?:class|const|function)\\s+${sv.replace(/[^A-Za-z0-9_]/g, '')}\\b`).test(code);
    if (!ok) missing.push({ kind: 'service', name: sv, expected: `fichier ou déclaration pour ${sv}` });
  }

  // Écrans et composants : un fichier dont le chemin porte le nom de base.
  for (const sc of entities.screens) {
    const base = baseEntity(sc);
    if (!(base.length > 1 && inPath(base))) {
      missing.push({ kind: 'screen', name: sc, expected: `écran ${sc} (route/fichier *${base}*)` });
    }
  }
  for (const w of entities.widgets) {
    const base = baseEntity(w);
    if (!(base.length > 1 && inPath(base))) {
      missing.push({ kind: 'widget', name: w, expected: `composant ${w} (fichier *${base}*)` });
    }
  }
  return missing;
}

export async function runStaticValidation(
  files:          GeneratedFile[],
  workDir:        string = process.cwd(),
  _sourceLanguage: string = 'dart',
  /**
   * PHASE 48 — entités de la source. Sans elles, le contrôle `source-entities`
   * reste NOT_RUN : il ne peut pas deviner ce que la source contenait.
   */
  sourceEntities?: SourceEntities,
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
  const tscStart       = Date.now();
  const tsCompilation  = await attemptTsCompilation(files, workDir);
  const tscMs          = Date.now() - tscStart;

  const overallPassed =
    tsCompilation.success !== false
    && sourceImports.length === 0
    && emptyFiles.length === 0;

  // ── PHASE 47 : résultats PAR CONTRÔLE ──────────────────────────────────────
  // On RÉUTILISE les détecteurs existants (ci-dessus) et le validateur
  // d'intégrité déjà présent — aucun validateur parallèle n'est créé. Chaque
  // contrôle produit PASS / FAIL / NOT_RUN avec sa durée réelle.
  const integrityStart = Date.now();
  const integrity      = validateProjectIntegrity(files);
  const integrityMs    = Date.now() - integrityStart;

  const filesFor = (code: string): string[] =>
    integrity.issues.filter((i) => i.code === code && i.file).map((i) => i.file as string);

  const typeChecksApply = files.some((f) => /\.(ts|tsx)$/.test(f.path));
  // Une liste d'entités vide ne prouve rien : le contrôle est NOT_RUN, pas PASS.
  const entitiesKnown = !!sourceEntities &&
    (sourceEntities.models.length + sourceEntities.services.length +
     sourceEntities.screens.length + sourceEntities.widgets.length) > 0;
  const missingSourceEntities = entitiesKnown && sourceEntities
    ? detectMissingSourceEntities(files, sourceEntities) : [];

  const checks: ValidationCheckResult[] = [
    {
      id: 'local-imports',
      status: (brokenImports.length + (integrity.byCode['unresolved-local-import'] ?? 0)) === 0
        ? 'PASS' : 'FAIL',
      durationMs: integrityMs,
      errors: [
        ...brokenImports,
        ...integrity.issues.filter((i) => i.code === 'unresolved-local-import').map((i) => i.message),
      ].slice(0, 30),
      warnings: [],
      files: [...new Set([...filesFor('unresolved-local-import')])],
      detail: 'Résolution des imports locaux contre les chemins réellement produits',
    },
    {
      id: 'dependencies',
      status: (integrity.byCode['missing-dependency'] ?? 0) === 0 ? 'PASS' : 'FAIL',
      durationMs: integrityMs,
      errors: integrity.issues.filter((i) => i.code === 'missing-dependency').map((i) => i.message).slice(0, 30),
      warnings: [],
      files: filesFor('missing-dependency'),
      detail: 'Dépendances importées présentes dans le manifeste',
    },
    {
      id: 'typescript',
      // Une compilation non tentée est NOT_RUN, jamais PASS.
      status: !typeChecksApply ? 'NOT_RUN'
        : tsCompilation.attempted ? (tsCompilation.success ? 'PASS' : 'FAIL')
        : 'NOT_RUN',
      durationMs: tsCompilation.attempted ? tscMs : 0,
      errors: tsCompilation.errors,
      warnings: tsCompilation.warnings,
      files: [],
      ...(tsCompilation.attempted
        ? {}
        : { notRunReason: typeChecksApply
            ? 'binaire tsc introuvable dans cet environnement'
            : 'cible sans TypeScript' }),
      detail: tsCompilation.unverifiableModules?.length
        ? `tsc --noEmit exécuté ; ${tsCompilation.unverifiableModules.length} module(s) externe(s) ` +
          `non vérifiable(s) sans leurs dépendances : ${tsCompilation.unverifiableModules.slice(0, 5).join(', ')}`
        : 'tsc --noEmit sur les fichiers générés',
    },
    {
      id: 'config-entrypoint',
      status: ((integrity.byCode['missing-config'] ?? 0) +
               (integrity.byCode['missing-entrypoint'] ?? 0) +
               (integrity.byCode['invalid-config-json'] ?? 0)) === 0 ? 'PASS' : 'FAIL',
      durationMs: integrityMs,
      errors: integrity.issues
        .filter((i) => ['missing-config', 'missing-entrypoint', 'invalid-config-json'].includes(i.code))
        .map((i) => i.message).slice(0, 30),
      warnings: [],
      files: [],
      detail: 'Manifeste, tsconfig, configuration Expo et point d\'entrée',
    },
    {
      id: 'routes',
      status: ((integrity.byCode['missing-route-target'] ?? 0) +
               (integrity.byCode['wrong-entry-route'] ?? 0) + missingRoutes.length) === 0 ? 'PASS' : 'FAIL',
      durationMs: integrityMs,
      errors: [
        ...missingRoutes,
        ...integrity.issues
          .filter((i) => ['missing-route-target', 'wrong-entry-route'].includes(i.code))
          .map((i) => i.message),
      ].slice(0, 30),
      warnings: [],
      files: [...new Set([...filesFor('missing-route-target'), ...filesFor('wrong-entry-route')])],
      detail: 'Routes référencées vs écrans réellement présents',
    },
    {
      id: 'source-imports',
      status: sourceImports.length === 0 ? 'PASS' : 'FAIL',
      durationMs: integrityMs,
      errors: sourceImports.slice(0, 30),
      warnings: [],
      files: [],
      detail: 'Imports du langage source résiduels dans la cible',
    },
    {
      id: 'empty-files',
      status: emptyFiles.length === 0 ? 'PASS' : 'FAIL',
      durationMs: integrityMs,
      errors: emptyFiles.slice(0, 30),
      warnings: [],
      files: emptyFiles,
      detail: 'Fichiers sources vides ou sans code',
    },
    {
      // PHASE 48 — les entités métier de la source survivent-elles ?
      id: 'source-entities',
      status: !entitiesKnown ? 'NOT_RUN'
        : missingSourceEntities.length === 0 ? 'PASS' : 'FAIL',
      durationMs: integrityMs,
      errors: missingSourceEntities.map((m) =>
        `${m.kind} source « ${m.name} » absent du projet généré — attendu : ${m.expected}`).slice(0, 40),
      warnings: [],
      files: [],
      ...(entitiesKnown
        ? {}
        : { notRunReason: sourceEntities
            ? 'aucune entité métier extraite de la source — rien à comparer'
            : 'entités de la source non transmises au validateur' }),
      detail: sourceEntities
        ? `modèles ${sourceEntities.models.length}, services ${sourceEntities.services.length}, ` +
          `écrans ${sourceEntities.screens.length}, composants ${sourceEntities.widgets.length}`
        : 'Survie des modèles, services, écrans et composants de la source',
    },
    {
      // PHASE 50 — contrat service ↔ écrans, et symboles source non convertis.
      // CRITIQUE : un écran qui appelle une méthode inexistante, ou un import
      // marqué NOT_CONVERTED, produit un projet qui ne compile pas chez le
      // destinataire. Ce contrôle doit donc bloquer la validation complète.
      id: 'service-contract',
      status: ((integrity.byCode['missing-service-method'] ?? 0)
        + (integrity.byCode['unconverted-symbol'] ?? 0)) === 0 ? 'PASS' : 'FAIL',
      durationMs: integrityMs,
      errors: integrity.issues
        .filter((i) => i.code === 'missing-service-method' || i.code === 'unconverted-symbol')
        .map((i) => i.message).slice(0, 30),
      warnings: [],
      files: [
        ...new Set([
          ...filesFor('missing-service-method'),
          ...filesFor('unconverted-symbol'),
        ]),
      ],
      detail: 'Méthodes appelées par les écrans présentes sur les services ; symboles source convertis',
    },
    {
      // Aucun test n'est généré ni exécuté pour le projet cible : NOT_RUN explicite.
      id: 'tests', status: 'NOT_RUN', durationMs: 0, errors: [], warnings: [], files: [],
      notRunReason: 'aucun test n\'est généré pour le projet cible ; aucun runner exécuté',
      detail: 'Tests unitaires / composants du projet généré',
    },
    {
      // Aucun build ni export Expo n'est exécuté dans cet environnement.
      id: 'build', status: 'NOT_RUN', durationMs: 0, errors: [], warnings: [], files: [],
      notRunReason: 'ni build ni export Expo exécuté (dépendances du projet non installées)',
      detail: 'Build / export du projet cible',
    },
  ];

  console.log(`[StaticValidator] TypeScript: ${tsCompilation.attempted ? (tsCompilation.success ? '✅' : `❌ ${tsCompilation.errors.length} errors`) : '⏭️  not attempted'}`);
  console.log(`[StaticValidator] Broken imports: ${brokenImports.length === 0 ? '✅' : `❌ ${brokenImports.length}`}`);
  console.log(`[StaticValidator] Source imports: ${sourceImports.length === 0 ? '✅' : `❌ ${sourceImports.length}`}`);
  console.log(`[StaticValidator] Empty files: ${emptyFiles.length === 0 ? '✅' : `❌ ${emptyFiles.length}`}`);
  console.log(`[StaticValidator] Critical TODOs: ${criticalTodos.length === 0 ? '✅' : `⚠️  ${criticalTodos.length}`}`);
  console.log(`[StaticValidator] Missing routes: ${missingRoutes.length === 0 ? '✅' : `❌ ${missingRoutes.length}`}`);
  console.log(`[StaticValidator] --- Résultats par contrôle (PHASE 47) ---`);
  for (const c of checks) {
    const icon = c.status === 'PASS' ? '✅' : c.status === 'FAIL' ? '❌' : '⏭️ ';
    const extra = c.status === 'NOT_RUN' ? ` (${c.notRunReason ?? 'raison inconnue'})`
      : c.status === 'FAIL' ? ` — ${c.errors.length} erreur(s)` : '';
    console.log(`[StaticValidator] ${icon} ${c.id}: ${c.status} [${c.durationMs}ms]${extra}`);
  }
  console.log(`[StaticValidator] Durée totale de validation: ${tscMs + integrityMs}ms`);
  console.log(`[StaticValidator] Overall: ${overallPassed ? '✅ PASSED' : '❌ FAILED'}`);
  console.log(`[StaticValidator] ==========================================\n`);

  return {
    checks,
    validationDurationMs: tscMs + integrityMs,
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
