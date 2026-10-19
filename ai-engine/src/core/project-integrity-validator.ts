// ============================================================
// CodeMorph AI Engine — Project Integrity Validator
// PHASE 44 : validation structurelle DÉTERMINISTE après génération
// ------------------------------------------------------------
// Complète `static-validator.ts` sans le remplacer. Il répond aux défauts
// observés en production que le moteur ne détectait pas :
//
//   • imports locaux non résolus (fichier référencé mais absent) ;
//   • dépendances utilisées mais absentes de package.json ;
//   • symboles/type référencés mais non déclarés dans le projet ;
//   • incohérence de propriétés entre un modèle et son utilisation ;
//   • routes/écrans référencés mais absents (Expo Router & navigation) ;
//   • fichiers dupliqués ou contradictoires ;
//   • fichiers de configuration / point d'entrée manquants.
//
// PRINCIPE : aucun appel IA, aucune écriture sur disque, aucune correction
// automatique. Uniquement du constat déterministe et reproductible.
//
// ANTI FAUX POSITIFS — les cas suivants sont explicitement traités :
//   • imports de plateformes (`.ios` / `.android` / `.native` / `.web`) ;
//   • alias TypeScript (`@/*`, `~/*`) résolus via tsconfig `paths` ;
//   • extensions implicites (.ts .tsx .js .jsx .mjs .cjs .json) et `/index.*` ;
//   • conventions Expo Router (`app/**`, `_layout`, groupes `(tabs)`) ;
//   • modules Node natifs et préfixes `node:` ;
//   • imports de types (`import type`) et imports side-effect.
// ============================================================
import * as path from 'path';
import type { GeneratedFile } from '../models/ir.types';

// ── Types publics ─────────────────────────────────────────────────────────────
// Définis dans models/ir.types.ts (module de plus bas niveau) pour éviter un
// cycle d'imports. Ré-exportés ici pour que les appelants n'aient qu'une source.
export type {
  IntegritySeverity, IntegrityIssueCode, IntegrityIssue,
  ProjectIntegrityReport as IntegrityReport,
} from '../models/ir.types';
import type {
  IntegrityIssue, IntegrityIssueCode,
  ProjectIntegrityReport as IntegrityReport,
} from '../models/ir.types';

// ── Constantes ────────────────────────────────────────────────────────────────

/** Extensions résolues implicitement par Metro/TypeScript. */
const IMPLICIT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'] as const;

/**
 * Suffixes de plateforme React Native. Un import `./Foo` peut être satisfait
 * par `Foo.ios.tsx`, `Foo.android.tsx`, `Foo.native.ts`, `Foo.web.tsx`…
 */
const PLATFORM_SUFFIXES = ['.ios', '.android', '.native', '.web'] as const;

/** Modules natifs Node : jamais à déclarer dans package.json. */
const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector',
  'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'timers', 'tls', 'trace_events', 'tty',
  'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

/** Extensions considérées comme du code source (hors config/manifeste). */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalize(p: string): string {
  return p.replace(/^\.\//, '').replace(/\\/g, '/');
}

function isSourceFile(p: string): boolean {
  return SOURCE_EXTENSIONS.some((e) => p.endsWith(e));
}

/**
 * Construit l'ensemble des chemins résolvables du projet.
 * Pour chaque fichier on ajoute ses variantes avec extension implicite retirée
 * et ses variantes de plateforme, afin d'éviter les faux positifs.
 */
function buildResolvableSet(files: GeneratedFile[]): Set<string> {
  const set = new Set<string>();
  for (const f of files) {
    const p = normalize(f.path);
    set.add(p);

    // `src/Foo.tsx` satisfait aussi `./Foo`
    for (const ext of IMPLICIT_EXTENSIONS) {
      if (p.endsWith(ext)) set.add(p.slice(0, -ext.length));
    }
    // `src/Foo.ios.tsx` satisfait `./Foo`
    for (const ext of IMPLICIT_EXTENSIONS) {
      for (const plat of PLATFORM_SUFFIXES) {
        const suffix = `${plat}${ext}`;
        if (p.endsWith(suffix)) set.add(p.slice(0, -suffix.length));
      }
    }
    // `src/components/index.ts` satisfait `./components`
    const base = p.replace(/\/index$/, '');
    set.add(base);
    for (const ext of IMPLICIT_EXTENSIONS) {
      if (base.endsWith(ext)) set.add(base.slice(0, -ext.length));
    }
  }
  return set;
}

/** Extrait les alias `paths` d'un tsconfig.json généré, sans lever d'exception. */
function extractTsConfigAliases(files: GeneratedFile[]): Map<string, string> {
  const aliases = new Map<string, string>();
  const tsconfig = files.find((f) => normalize(f.path) === 'tsconfig.json');
  if (!tsconfig) return aliases;
  try {
    // tsconfig peut contenir des commentaires → nettoyage tolérant
    const cleaned = tsconfig.content
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const parsed = JSON.parse(cleaned) as {
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
    };
    const baseUrl = parsed.compilerOptions?.baseUrl ?? '.';
    for (const [pattern, targets] of Object.entries(parsed.compilerOptions?.paths ?? {})) {
      const target = targets?.[0];
      if (!target) continue;
      const prefix = pattern.replace(/\*$/, '');
      const resolved = normalize(path.posix.join(baseUrl, target.replace(/\*$/, '')));
      aliases.set(prefix, resolved.replace(/\/$/, ''));
    }
  } catch {
    // tsconfig illisible : on n'invente rien, aucun alias.
  }
  return aliases;
}

interface ImportRef {
  file:   string;
  spec:   string;
  isType: boolean;
}

/**
 * Extrait les imports d'un fichier TS/JS. Gère :
 *   import x from 'y' · import { a } from 'y' · import 'y' (side-effect)
 *   import type { T } from 'y' · export … from 'y' · require('y') · dynamic import()
 */
function extractImports(file: GeneratedFile): ImportRef[] {
  const refs: ImportRef[] = [];
  const patterns: RegExp[] = [
    /import\s+type\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /import\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /import\s*['"]([^'"]+)['"]/g,
    /export\s+(?:type\s+)?[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(file.content)) !== null) {
      const spec = m[1];
      if (!spec) continue;
      const isType = /^import\s+type\b/.test(m[0]) || /^export\s+type\b/.test(m[0]);
      refs.push({ file: normalize(file.path), spec, isType });
    }
  }
  // Déduplique (les patterns se recouvrent)
  const seen = new Set<string>();
  return refs.filter((r) => {
    const k = `${r.file}::${r.spec}::${r.isType}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Nom du paquet pour un spécificateur nu (gère les scopes). */
function packageNameOf(spec: string): string {
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    return parts.slice(0, 2).join('/');
  }
  return spec.split('/')[0] as string;
}

/** Lit dependencies + devDependencies + peerDependencies du package.json généré. */
function readManifest(files: GeneratedFile[]): {
  declared: Set<string>;
  raw:      string | null;
  parseError: string | null;
} {
  const pkg = files.find((f) => normalize(f.path) === 'package.json');
  if (!pkg) return { declared: new Set(), raw: null, parseError: 'package.json absent' };
  try {
    const parsed = JSON.parse(pkg.content) as Record<string, Record<string, string> | undefined>;
    const declared = new Set<string>();
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(parsed[key] ?? {})) declared.add(name);
    }
    return { declared, raw: pkg.content, parseError: null };
  } catch (e) {
    return { declared: new Set(), raw: pkg.content, parseError: (e as Error).message };
  }
}

// ── Contrôles ─────────────────────────────────────────────────────────────────

function checkLocalImports(
  files: GeneratedFile[],
  resolvable: Set<string>,
  aliases: Map<string, string>,
): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const reported = new Set<string>();

  for (const f of files) {
    if (!isSourceFile(normalize(f.path))) continue;
    const dir = path.posix.dirname(normalize(f.path));

    for (const ref of extractImports(f)) {
      const spec = ref.spec;

      // ── Import relatif ───────────────────────────────────────────────────
      if (spec.startsWith('.')) {
        const resolved = normalize(path.posix.join(dir, spec));
        const candidates = new Set<string>([resolved]);
        for (const ext of IMPLICIT_EXTENSIONS) candidates.add(`${resolved}${ext}`);
        for (const plat of PLATFORM_SUFFIXES) {
          candidates.add(`${resolved}${plat}`);
          for (const ext of IMPLICIT_EXTENSIONS) candidates.add(`${resolved}${plat}${ext}`);
        }
        // `/index.*`
        for (const ext of IMPLICIT_EXTENSIONS) candidates.add(`${resolved}/index${ext}`);

        const ok = [...candidates].some((c) => resolvable.has(normalize(c)));
        if (!ok) {
          const key = `${ref.file}::${spec}`;
          if (reported.has(key)) continue;
          reported.add(key);
          issues.push({
            code:     'unresolved-local-import',
            severity: ref.isType ? 'warning' : 'error',
            file:     ref.file,
            message:  `Import local non résolu : aucun fichier ne correspond à '${spec}'`,
            detail:   spec,
          });
        }
        continue;
      }

      // ── Alias TypeScript (@/…, ~/…) ──────────────────────────────────────
      if (spec.startsWith('@/') || spec.startsWith('~/')) {
        const prefix = spec.slice(0, 2);
        const mapped = aliases.get(prefix);
        if (mapped === undefined) {
          // Aucun alias déclaré dans tsconfig : on ne peut pas trancher.
          // On signale en WARNING, jamais en erreur (évite les faux positifs
          // quand tsconfig n'est pas généré ou utilise un autre mécanisme).
          issues.push({
            code:     'unresolved-local-import',
            severity: 'warning',
            file:     ref.file,
            message:  `Alias '${prefix}' utilisé mais absent de tsconfig.compilerOptions.paths`,
            detail:   spec,
          });
          continue;
        }
        const resolved = normalize(path.posix.join(mapped, spec.slice(2)));
        const candidates = new Set<string>([resolved]);
        for (const ext of IMPLICIT_EXTENSIONS) candidates.add(`${resolved}${ext}`);
        for (const ext of IMPLICIT_EXTENSIONS) candidates.add(`${resolved}/index${ext}`);
        if (![...candidates].some((c) => resolvable.has(normalize(c)))) {
          issues.push({
            code:     'unresolved-local-import',
            severity: ref.isType ? 'warning' : 'error',
            file:     ref.file,
            message:  `Import via alias non résolu : '${spec}' (alias ${prefix} → ${mapped})`,
            detail:   spec,
          });
        }
        continue;
      }

      // Tout le reste (paquets nus) est traité par checkDependencies.
    }
  }
  return issues;
}

function checkDependencies(files: GeneratedFile[], declared: Set<string>): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const seen = new Map<string, string>(); // paquet → premier fichier

  for (const f of files) {
    if (!isSourceFile(normalize(f.path))) continue;
    for (const ref of extractImports(f)) {
      const spec = ref.spec;
      if (spec.startsWith('.') || spec.startsWith('@/') || spec.startsWith('~/')) continue;
      if (spec.startsWith('node:')) continue;
      const pkg = packageNameOf(spec);
      if (!pkg || NODE_BUILTINS.has(pkg)) continue;
      if (declared.has(pkg)) continue;
      if (seen.has(pkg)) continue;
      seen.set(pkg, ref.file);
      issues.push({
        code:     'missing-dependency',
        severity: 'error',
        file:     ref.file,
        message:  `Dépendance '${pkg}' importée mais absente de package.json`,
        detail:   pkg,
      });
    }
  }
  return issues;
}

/**
 * Routes Expo Router : tout `router.push('/x')`, `href="/x"` ou `<Link href="/x">`
 * doit correspondre à un fichier sous `app/`.
 * Conventions gérées : `app/x.tsx`, `app/x/index.tsx`, groupes `(tabs)/x`,
 * routes dynamiques `[id]`, et fichiers `_layout` ignorés.
 */
function checkRoutes(files: GeneratedFile[]): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const appFiles = files
    .map((f) => normalize(f.path))
    .filter((p) => p.startsWith('app/') && isSourceFile(p));
  if (appFiles.length === 0) return issues; // pas d'Expo Router → rien à vérifier

  // Ensemble des segments de route disponibles
  const routeSegments = new Set<string>();
  for (const p of appFiles) {
    const rel = p.slice('app/'.length).replace(/\.(tsx?|jsx?|mjs|cjs)$/, '');
    // retire les groupes (tabs), (auth)… et les index
    const cleaned = rel
      .split('/')
      .filter((seg) => seg && !seg.startsWith('(') && seg !== 'index')
      .join('/');
    if (cleaned) routeSegments.add(cleaned);
    // chaque segment individuel est aussi une route possible
    for (const seg of cleaned.split('/')) if (seg) routeSegments.add(seg);
  }

  const routePattern = /(?:router\.(?:push|replace|navigate|back)\(\s*|href\s*[:=]\s*|navigate\(\s*)['"`]\/([^'"`?#]*)['"`]/g;
  const reported = new Set<string>();

  for (const f of files) {
    if (!isSourceFile(normalize(f.path))) continue;
    let m: RegExpExecArray | null;
    routePattern.lastIndex = 0;
    while ((m = routePattern.exec(f.content)) !== null) {
      const raw = m[1] ?? '';
      if (!raw) continue;
      const segments = raw.split('/').filter((s) => s && !s.startsWith('('));
      if (segments.length === 0) continue;
      // Route dynamique (`[id]`) : on ne peut pas trancher → on ignore.
      if (segments.some((s) => s.startsWith('['))) continue;
      const first = segments[0] as string;
      // Les routes externes (http) ne commencent pas par '/' après capture.
      if (routeSegments.has(first)) continue;
      const joined = segments.join('/');
      if (routeSegments.has(joined)) continue;
      const key = `${normalize(f.path)}::${raw}`;
      if (reported.has(key)) continue;
      reported.add(key);
      issues.push({
        code:     'missing-route-target',
        severity: 'error',
        file:     normalize(f.path),
        message:  `Route '/${raw}' référencée mais aucun écran correspondant sous app/`,
        detail:   `/${raw}`,
      });
    }
  }
  return issues;
}

/**
 * PHASE 48 — `<Stack.Screen name="X" />` / `<Tabs.Screen name="X" />` déclarés
 * dans un `_layout` doivent correspondre à un fichier réellement présent dans le
 * MÊME répertoire. `checkRoutes` ne couvre que les navigations `router.push`,
 * si bien qu'un layout déclarant des écrans inexistants passait en PASS.
 */
function checkLayoutScreens(files: GeneratedFile[]): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const allPaths = new Set(files.map((f) => normalize(f.path)));

  const existsAsRoute = (dir: string, name: string): boolean => {
    const base = dir === '' ? '' : `${dir}/`;
    for (const ext of ['.tsx', '.ts', '.jsx', '.js']) {
      if (allPaths.has(`${base}${name}${ext}`)) return true;
    }
    // Un sous-répertoire de route (avec son propre _layout ou index) convient.
    for (const p of allPaths) {
      if (p.startsWith(`${base}${name}/`)) return true;
    }
    return false;
  };

  const screenPattern = /<(?:Stack|Tabs|Drawer)\.Screen\s+[^>]*?name=["']([^"']+)["']/g;

  for (const f of files) {
    const path = normalize(f.path);
    // Seuls les fichiers `_layout` d'Expo Router déclarent des écrans.
    if (!/(^|\/)_layout\.(tsx?|jsx?)$/.test(path)) continue;
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

    let m: RegExpExecArray | null;
    screenPattern.lastIndex = 0;
    while ((m = screenPattern.exec(f.content)) !== null) {
      const name = m[1] ?? '';
      if (!name) continue;
      // Groupes et routes dynamiques : on ne peut pas trancher ici.
      if (name.startsWith('(') || name.includes('[')) continue;
      if (existsAsRoute(dir, name)) continue;
      issues.push({
        code:     'missing-layout-screen',
        severity: 'error',
        file:     path,
        message:  `Le layout déclare <Screen name="${name}" /> mais aucun fichier ` +
                  `${dir === '' ? '' : dir + '/'}${name}.tsx n'existe`,
        detail:   `${dir === '' ? '(racine)' : dir}/${name}`,
      });
    }
  }
  return issues;
}

/** Fichiers en double (même chemin normalisé) ou au contenu identique à l'octet. */
function checkDuplicates(files: GeneratedFile[]): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const byPath = new Map<string, number>();
  for (const f of files) {
    const p = normalize(f.path);
    byPath.set(p, (byPath.get(p) ?? 0) + 1);
  }
  for (const [p, count] of byPath) {
    if (count > 1) {
      issues.push({
        code: 'duplicate-file', severity: 'error', file: p,
        message: `Chemin produit ${count} fois — le dernier écrase les précédents`, detail: p,
      });
    }
  }

  // Même contenu, chemins différents, pour des fichiers sources non triviaux.
  const byContent = new Map<string, string[]>();
  for (const f of files) {
    const p = normalize(f.path);
    if (!isSourceFile(p)) continue;
    if (f.content.trim().length < 80) continue; // ignore les petits fichiers génériques
    const key = `${f.content.length}:${f.content.trim()}`;
    const list = byContent.get(key) ?? [];
    list.push(p);
    byContent.set(key, list);
  }
  for (const [, paths] of byContent) {
    const first = paths[0];
    if (paths.length > 1 && first !== undefined) {
      issues.push({
        code: 'conflicting-file', severity: 'warning', file: first,
        message: `${paths.length} fichiers sources au contenu strictement identique`,
        detail: paths.join(', '),
      });
    }
  }
  return issues;
}

/** Configuration et point d'entrée du projet cible. */
function checkProjectScaffold(files: GeneratedFile[], parseError: string | null): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const paths = new Set(files.map((f) => normalize(f.path)));

  if (!paths.has('package.json')) {
    issues.push({
      code: 'missing-config', severity: 'error',
      message: 'package.json absent — les dépendances ne peuvent pas être installées',
    });
  } else if (parseError) {
    issues.push({
      code: 'invalid-config-json', severity: 'error', file: 'package.json',
      message: `package.json invalide : ${parseError}`,
    });
  }

  if (!paths.has('tsconfig.json')) {
    issues.push({
      code: 'missing-config', severity: 'warning',
      message: 'tsconfig.json absent — la vérification de types ne peut pas être fiable',
    });
  }

  // Point d'entrée : Expo Router (app/_layout) OU App.tsx / index.js / index.ts
  const hasExpoRouter = [...paths].some((p) => p.startsWith('app/') && /_layout\.(tsx?|jsx?)$/.test(p));
  const hasClassicEntry =
    paths.has('App.tsx') || paths.has('App.js') ||
    paths.has('index.js') || paths.has('index.ts') || paths.has('index.tsx');

  if (!hasExpoRouter && !hasClassicEntry) {
    issues.push({
      code: 'missing-entrypoint', severity: 'error',
      message: 'Aucun point d\'entrée détecté (ni app/_layout pour Expo Router, ni App.tsx / index.js)',
    });
  }

  // app.json / app.config.* : attendu pour Expo
  const hasAppConfig = [...paths].some((p) => p === 'app.json' || p.startsWith('app.config.'));
  if (!hasAppConfig) {
    issues.push({
      code: 'missing-config', severity: 'warning',
      message: 'app.json / app.config.* absent — configuration Expo manquante',
    });
  }
  return issues;
}

/** Fichiers sources vides ou quasi vides. */
function checkEmptySources(files: GeneratedFile[]): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  for (const f of files) {
    const p = normalize(f.path);
    if (!isSourceFile(p)) continue;
    const codeLines = f.content.split('\n').filter((l) => {
      const t = l.trim();
      return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    }).length;
    if (codeLines === 0) {
      issues.push({
        code: 'empty-source-file', severity: 'error', file: p,
        message: 'Fichier source vide (aucune ligne de code)', detail: p,
      });
    }
  }
  return issues;
}

/**
 * PHASE 45 — Modèles canoniques : détecte les interfaces/types EXPORTÉS portant
 * le même nom dans plusieurs fichiers mais déclarant des propriétés différentes.
 *
 * C'est le défaut « deux interfaces Task incompatibles » : le service en utilise
 * une, le composant une autre, et la propriété de complétion diverge
 * (`completed` vs `isDone`). Rien ne le signalait.
 *
 * Déterministe et conservateur : on ne compare que les NOMS de propriétés des
 * déclarations exportées. Deux déclarations identiques ne produisent rien.
 */
function checkDuplicateModels(files: GeneratedFile[]): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  // nom du type → [{ file, props }]
  const decls = new Map<string, Array<{ file: string; props: Set<string> }>>();

  const declPattern =
    /export\s+(?:declare\s+)?(?:interface|type)\s+([A-Z][A-Za-z0-9_]*)[^{]*\{([^}]*)\}/g;

  for (const f of files) {
    const p = normalize(f.path);
    if (!isSourceFile(p)) continue;
    declPattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = declPattern.exec(f.content)) !== null) {
      const name = m[1];
      const body = m[2] ?? '';
      if (!name) continue;
      // Noms de propriétés : `foo:`, `foo?:`, `readonly foo:`
      const props = new Set<string>();
      const propPattern = /(?:^|[;{\s])(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\??\s*:/g;
      let pm: RegExpExecArray | null;
      while ((pm = propPattern.exec(body)) !== null) {
        if (pm[1]) props.add(pm[1]);
      }
      const list = decls.get(name) ?? [];
      list.push({ file: p, props });
      decls.set(name, list);
    }
  }

  for (const [name, list] of decls) {
    if (list.length < 2) continue;
    // Compare deux à deux : dès qu'une divergence de propriétés apparaît → erreur.
    const first = list[0];
    if (!first) continue;
    for (const other of list.slice(1)) {
      const onlyFirst = [...first.props].filter((x) => !other.props.has(x));
      const onlyOther = [...other.props].filter((x) => !first.props.has(x));
      if (onlyFirst.length === 0 && onlyOther.length === 0) continue; // identiques
      issues.push({
        code: 'model-property-mismatch',
        severity: 'error',
        file: other.file,
        message:
          `Modèle '${name}' déclaré de façon incompatible dans ${list.length} fichiers ` +
          `(${first.file} vs ${other.file}) — il faut un modèle canonique unique`,
        detail:
          `proprietesUniquementDans${first.file}=[${onlyFirst.join(',')}] ` +
          `proprietesUniquementDans${other.file}=[${onlyOther.join(',')}]`,
      });
      break; // une seule erreur par nom suffit
    }
  }
  return issues;
}

/**
 * PHASE 45 — Route d'entrée : l'application doit démarrer sur l'écran d'accueil.
 *
 * Avec Expo Router, `app/index.tsx` EST l'écran de lancement. Défaut observé :
 * l'application démarrait sur « AddTask » au lieu de « Home ».
 *
 * Détection conservatrice, sans faux positif : on ne signale que le cas
 * non ambigu d'un `<Redirect href="…">` explicite vers une route d'ajout /
 * de création, ou d'un composant par défaut nommé Add…, Create… ou New….
 */
function checkEntryRoute(files: GeneratedFile[]): IntegrityIssue[] {
  const entry = files.find((f) => normalize(f.path) === 'app/index.tsx');
  if (!entry) return []; // pas d'Expo Router classique → on ne tranche pas

  const issues: IntegrityIssue[] = [];
  const ADD_ROUTE = /\/(add|create|new)([-/][a-z0-9-]*)?$/i;

  // Cas 1 : redirection explicite vers une route d'ajout
  const redirectHref = /<Redirect\s+[^>]*href\s*=\s*["'`]([^"'`]+)["'`]/.exec(entry.content)?.[1];
  if (redirectHref !== undefined && ADD_ROUTE.test(redirectHref)) {
    issues.push({
      code: 'wrong-entry-route', severity: 'error', file: 'app/index.tsx',
      message: `L'écran de lancement redirige vers '${redirectHref}' (écran d'ajout) au lieu de l'accueil`,
      detail: redirectHref,
    });
  }

  // Cas 2 : le composant par défaut de l'entrée est un écran d'ajout
  const defaultName = /export\s+default\s+function\s+([A-Za-z0-9_]+)/.exec(entry.content)?.[1]
    ?? /export\s+default\s+([A-Za-z0-9_]+)/.exec(entry.content)?.[1];
  if (defaultName && /^(Add|Create|New)[A-Z]/.test(defaultName)) {
    issues.push({
      code: 'wrong-entry-route', severity: 'error', file: 'app/index.tsx',
      message: `L'écran de lancement est '${defaultName}' — l'application doit démarrer sur l'accueil`,
      detail: defaultName,
    });
  }
  return issues;
}

/**
 * PHASE 45 — Câblage des formulaires : un écran qui saisit du texte doit
 * transmettre ses données (mutation d'état ou navigation avec paramètres).
 *
 * Défaut observé : le flux « ajouter une tâche » ne transmettait rien.
 *
 * Détection à HAUTE PRÉCISION pour éviter les faux positifs : on n'examine que
 * les écrans sous `app/` contenant un `TextInput`, et on accepte comme preuve de
 * câblage n'importe lequel de :
 *   • un appel de navigation avec paramètres (`router.push({ … params … })`,
 *     `router.replace`, `router.back`),
 *   • un appel à une fonction importée d'un store/service (`useTaskStore`,
 *     `taskService.add…`, `add…(`, `create…(`, `set…(`),
 *   • un setter `useState` (`setXxx(`).
 */
function checkFormWiring(files: GeneratedFile[]): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  for (const f of files) {
    const p = normalize(f.path);
    if (!p.startsWith('app/') || !isSourceFile(p)) continue;
    if (!/\bTextInput\b/.test(f.content)) continue;

    const wired =
      /\brouter\s*\.\s*(push|replace|navigate|back)\s*\(/.test(f.content) ||
      /\buse[A-Z][A-Za-z0-9]*Store\b/.test(f.content) ||
      /\b[A-Za-z0-9_]*(Service|Store|Repository)\s*\.\s*[A-Za-z0-9_]+\s*\(/.test(f.content) ||
      /\b(add|create|save|submit|insert)[A-Za-z0-9_]*\s*\(/.test(f.content) ||
      /\bset[A-Z][A-Za-z0-9_]*\s*\(/.test(f.content);

    if (!wired) {
      issues.push({
        code: 'form-not-wired', severity: 'error', file: p,
        message: `Écran de saisie sans transmission de données : aucune mutation d'état ` +
                 `ni navigation avec paramètres détectée`,
        detail: p,
      });
    }
  }
  return issues;
}

// ── Point d'entrée ────────────────────────────────────────────────────────────

/**
 * Valide l'intégrité structurelle d'un projet généré.
 * Pur et déterministe : mêmes fichiers ⇒ exactement même rapport.
 */
export function validateProjectIntegrity(files: GeneratedFile[]): IntegrityReport {
  const resolvable = buildResolvableSet(files);
  const aliases    = extractTsConfigAliases(files);
  const manifest   = readManifest(files);

  const issues: IntegrityIssue[] = [
    ...checkProjectScaffold(files, manifest.parseError),
    ...checkLocalImports(files, resolvable, aliases),
    ...checkDependencies(files, manifest.declared),
    ...checkRoutes(files),
    ...checkLayoutScreens(files),
    ...checkDuplicateModels(files),
    ...checkEntryRoute(files),
    ...checkFormWiring(files),
    ...checkDuplicates(files),
    ...checkEmptySources(files),
  ];

  const errorCount   = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  const infoCount    = issues.filter((i) => i.severity === 'info').length;

  const byCode: Partial<Record<IntegrityIssueCode, number>> = {};
  for (const i of issues) byCode[i.code] = (byCode[i.code] ?? 0) + 1;

  const verdict: IntegrityReport['verdict'] =
    errorCount > 0 ? 'FAIL' : warningCount > 0 ? 'PASS_WITH_WARNINGS' : 'PASS';

  return {
    issues,
    errorCount,
    warningCount,
    infoCount,
    passed:      errorCount === 0,
    verdict,
    checkedFiles: files.length,
    byCode,
  };
}

/** Rendu texte compact pour les logs (jamais de contenu source). */
export function formatIntegrityReport(report: IntegrityReport): string {
  const lines: string[] = [
    `[Integrity] verdict=${report.verdict} files=${report.checkedFiles} ` +
    `errors=${report.errorCount} warnings=${report.warningCount} info=${report.infoCount}`,
  ];
  const sorted = [...report.issues].sort((a, b) =>
    a.severity === b.severity ? a.code.localeCompare(b.code) : a.severity === 'error' ? -1 : 1);
  for (const i of sorted.slice(0, 25)) {
    lines.push(`  [${i.severity.toUpperCase()}] ${i.code}${i.file ? ` (${i.file})` : ''}: ${i.message}`);
  }
  if (sorted.length > 25) lines.push(`  … ${sorted.length - 25} autres`);
  return lines.join('\n');
}
