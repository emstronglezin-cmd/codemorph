// ============================================================
// CodeMorph AI Engine — Plan Normalizer
// PHASE 46 : corrections structurelles appliquées au PLAN, à la source
// ------------------------------------------------------------
// Les défauts constatés sur plusieurs conversions ne venaient pas du modèle mais
// de la façon dont le plan était ASSEMBLÉ :
//
//   1. `code-planner.rnPackageJson()` déclare une liste de dépendances FIGÉE,
//      alors que les templates statiques évoluent. `src/lib/storage.ts` importe
//      `@react-native-async-storage/async-storage`, jamais déclaré → dépendance
//      absente du manifeste à chaque conversion.
//   2. Deux composants écrivent des services avec DEUX conventions différentes :
//        • code-planner            → `src/services/<nom-minuscule>.service.ts`
//        • business-layer-extractor → `src/services/<camelCase>.ts`
//      → deux fichiers pour la même fonctionnalité.
//   3. Rien ne garantissait l'unicité des chemins du plan.
//
// Ce module s'exécute sur le plan AVANT livraison. Il est déterministe, n'appelle
// aucun modèle, et ne supprime du code que lorsque la duplication est démontrée
// (même service, chemins différents) — en conservant l'implémentation la plus
// complète et en journalisant la décision.
// ============================================================
import type { GeneratedFile } from '../models/ir.types';

/** Résultat de la normalisation, pour traçabilité. */
export interface PlanNormalizationReport {
  addedDependencies:    string[];
  unknownDependencies:  string[];
  deduplicatedServices: Array<{ kept: string; dropped: string; service: string }>;
  duplicatePaths:       Array<{ path: string; kept: 'first' | 'richest' }>;
  entryRouteFixed:      boolean;
  /** PHASE 48 — groupes de routes supprimés car dépourvus d'écran. */
  prunedRouteGroups:    string[];
  /** PHASE 48 — écrans retirés du layout racine faute de fichier cible. */
  removedLayoutScreens: string[];
  notes:                string[];
}

/**
 * Registre des paquets connus avec une version compatible Expo SDK 50 /
 * React Native 0.73 (celle déclarée par `rnPackageJson`).
 *
 * On n'INVENTE jamais de version : un paquet absent de ce registre est signalé
 * dans `unknownDependencies` et reste à la charge du validateur d'intégrité.
 */
const KNOWN_PACKAGES: Record<string, string> = {
  '@react-native-async-storage/async-storage': '1.21.0',
  '@react-native-community/netinfo':           '11.1.0',
  'react-native-safe-area-context':            '4.8.2',
  'react-native-screens':                      '~3.29.0',
  'react-native-gesture-handler':              '~2.14.0',
  'react-native-reanimated':                   '~3.6.2',
  'expo-status-bar':                           '~1.11.1',
  'expo-constants':                            '~15.4.5',
  'expo-linking':                              '~6.2.2',
  'expo-splash-screen':                        '~0.26.4',
  'expo-font':                                 '~11.10.3',
  'expo-image-picker':                         '~14.7.1',
  'expo-localization':                         '~14.8.3',
  'i18n-js':                                   '^4.3.2',
  'date-fns':                                  '^3.3.1',
  'zod':                                       '^3.22.4',
};

/** Modules natifs Node : jamais à déclarer. */
const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'crypto', 'dns', 'events', 'fs', 'http', 'https',
  'module', 'net', 'os', 'path', 'querystring', 'stream', 'timers', 'tls', 'url', 'util', 'zlib',
]);

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;

function isSource(p: string): boolean {
  return SOURCE_EXTENSIONS.some((e) => p.endsWith(e));
}

/** Nom du paquet pour un spécificateur nu (gère les scopes). */
function packageNameOf(spec: string): string {
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/');
  return (spec.split('/')[0] ?? '') as string;
}

/** Extrait les spécificateurs d'imports « nus » (ni relatifs, ni alias). */
function collectBareImports(files: GeneratedFile[]): Set<string> {
  const used = new Set<string>();
  const patterns = [
    /from\s*['"]([^'"]+)['"]/g,
    /import\s*['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const f of files) {
    if (!isSource(f.path)) continue;
    for (const re of patterns) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(f.content)) !== null) {
        const spec = m[1] ?? '';
        if (!spec) continue;
        if (spec.startsWith('.') || spec.startsWith('@/') || spec.startsWith('~/')) continue;
        if (spec.startsWith('node:')) continue;
        const pkg = packageNameOf(spec);
        if (!pkg || NODE_BUILTINS.has(pkg)) continue;
        used.add(pkg);
      }
    }
  }
  return used;
}

/**
 * 1. RÉCONCILIATION DU MANIFESTE.
 *
 * Ajoute au `package.json` généré toute dépendance réellement importée par les
 * fichiers du plan et absente du manifeste, à condition qu'elle figure au
 * registre des versions connues. Les paquets inconnus sont SIGNALÉS, pas devinés.
 */
export function reconcileManifest(files: GeneratedFile[]): {
  files: GeneratedFile[];
  added: string[];
  unknown: string[];
} {
  const idx = files.findIndex((f) => f.path === 'package.json');
  if (idx === -1) return { files, added: [], unknown: [] };
  const pkgFile = files[idx];
  if (!pkgFile) return { files, added: [], unknown: [] };

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(pkgFile.content) as Record<string, unknown>;
  } catch {
    // Manifeste invalide : on ne touche à rien, le validateur le signalera.
    return { files, added: [], unknown: [] };
  }

  const deps = { ...((pkg['dependencies'] ?? {}) as Record<string, string>) };
  const dev  = { ...((pkg['devDependencies'] ?? {}) as Record<string, string>) };
  const declared = new Set([...Object.keys(deps), ...Object.keys(dev)]);

  const used = collectBareImports(files);
  const added:   string[] = [];
  const unknown: string[] = [];

  for (const pkgName of [...used].sort()) {
    if (declared.has(pkgName)) continue;
    const version = KNOWN_PACKAGES[pkgName];
    if (version === undefined) {
      unknown.push(pkgName);
      continue;
    }
    deps[pkgName] = version;
    added.push(pkgName);
  }

  if (added.length === 0) return { files, added, unknown };

  const next = [...files];
  next[idx] = {
    ...pkgFile,
    content: JSON.stringify({ ...pkg, dependencies: deps }, null, 2),
  };
  return { files: next, added, unknown };
}

/** Nom normalisé d'un service, indépendant de la convention de fichier. */
function serviceIdentity(filePath: string): string | null {
  const m = /(?:^|\/)services\/([^/]+)\.(ts|tsx|js|jsx)$/.exec(filePath.replace(/\\/g, '/'));
  if (!m) return null;
  const base = m[1] ?? '';
  return base
    .replace(/\.service$/i, '')
    .replace(/[-_\s]/g, '')
    .toLowerCase();
}

/**
 * 2. DÉDUPLICATION DES SERVICES.
 *
 * Deux composants du moteur écrivent des services avec des conventions
 * différentes, produisant deux fichiers pour la même fonctionnalité. On regroupe
 * par identité de service et on ne conserve que l'implémentation la plus
 * complète — la suppression n'intervient que lorsque la duplication est
 * démontrée (même identité), et elle est journalisée.
 */
export function deduplicateServices(files: GeneratedFile[]): {
  files: GeneratedFile[];
  deduplicated: PlanNormalizationReport['deduplicatedServices'];
} {
  const groups = new Map<string, GeneratedFile[]>();
  for (const f of files) {
    const id = serviceIdentity(f.path);
    if (!id) continue;
    const list = groups.get(id) ?? [];
    list.push(f);
    groups.set(id, list);
  }

  const deduplicated: PlanNormalizationReport['deduplicatedServices'] = [];
  const dropPaths = new Set<string>();

  for (const [id, list] of groups) {
    if (list.length < 2) continue;
    // Conserver l'implémentation la plus riche (le plus de lignes de code).
    const score = (f: GeneratedFile): number =>
      f.content.split('\n').filter((l) => {
        const t = l.trim();
        return t && !t.startsWith('//') && !t.startsWith('*');
      }).length;
    const sorted = [...list].sort((a, b) => score(b) - score(a));
    const kept = sorted[0];
    if (!kept) continue;
    for (const other of sorted.slice(1)) {
      if (!other) continue;
      dropPaths.add(other.path);
      deduplicated.push({ kept: kept.path, dropped: other.path, service: id });
    }
  }

  if (dropPaths.size === 0) return { files, deduplicated };
  return { files: files.filter((f) => !dropPaths.has(f.path)), deduplicated };
}

/**
 * 3. UNICITÉ DES CHEMINS.
 *
 * Un même chemin produit deux fois fait silently perdre du code à l'écriture du
 * ZIP. On conserve le plus riche et on journalise.
 */
export function deduplicatePaths(files: GeneratedFile[]): {
  files: GeneratedFile[];
  duplicates: PlanNormalizationReport['duplicatePaths'];
} {
  const byPath = new Map<string, GeneratedFile[]>();
  for (const f of files) {
    const list = byPath.get(f.path) ?? [];
    list.push(f);
    byPath.set(f.path, list);
  }
  const duplicates: PlanNormalizationReport['duplicatePaths'] = [];
  const out: GeneratedFile[] = [];
  for (const [p, list] of byPath) {
    if (list.length === 1) {
      const only = list[0];
      if (only) out.push(only);
      continue;
    }
    const kept = [...list].sort((a, b) => b.content.length - a.content.length)[0];
    if (kept) out.push(kept);
    duplicates.push({ path: p, kept: 'richest' });
  }
  return { files: out, duplicates };
}

/**
 * 4. COHÉRENCE ROUTE D'ENTRÉE / FICHIERS.
 *
 * `app/index.tsx` redirige via `router.replace('/<slug>')`. Si aucun fichier
 * `app/<slug>.tsx` n'existe, l'application démarre sur une route morte. On
 * recible alors la redirection sur un écran réellement présent.
 */
export function fixEntryRoute(files: GeneratedFile[]): { files: GeneratedFile[]; fixed: boolean } {
  const entryIdx = files.findIndex((f) => f.path === 'app/index.tsx');
  if (entryIdx === -1) return { files, fixed: false };
  const entry = files[entryIdx];
  if (!entry) return { files, fixed: false };

  const m = /router\s*\.\s*replace\(\s*['"]\/([^'"]+)['"]\s*\)/.exec(entry.content)
    ?? /<Redirect\s+[^>]*href\s*=\s*["'`]\/([^"'`]+)["'`]/.exec(entry.content);
  if (!m) return { files, fixed: false };
  const target = m[1] ?? '';
  if (!target) return { files, fixed: false };

  const exists = files.some((f) => {
    const p = f.path.replace(/\\/g, '/');
    return p === `app/${target}.tsx` || p === `app/${target}.ts`
      || p === `app/${target}/index.tsx` || p === `app/${target}/index.ts`;
  });
  if (exists) return { files, fixed: false };

  // Choisir un écran réellement présent, en excluant les layouts et l'entrée.
  const candidate = files
    .map((f) => f.path.replace(/\\/g, '/'))
    .filter((p) => /^app\/[^/]+\.tsx?$/.test(p) && !/_layout\./.test(p) && p !== 'app/index.tsx')
    .map((p) => p.replace(/^app\//, '').replace(/\.tsx?$/, ''))
    .sort()[0];
  if (!candidate) return { files, fixed: false };

  const next = [...files];
  next[entryIdx] = {
    ...entry,
    content: entry.content
      .replace(/(router\s*\.\s*replace\(\s*['"])\/[^'"]+(['"]\s*\))/, `$1/${candidate}$2`)
      .replace(/(<Redirect\s+[^>]*href\s*=\s*["'`])\/[^"'`]+(["'`])/, `$1/${candidate}$2`),
  };
  return { files: next, fixed: true };
}

/**
 * Point d'entrée : normalise un plan de fichiers générés.
 * Pur et déterministe — aucun appel modèle, aucune écriture disque.
 */
/**
 * PHASE 48 — Un groupe de routes Expo Router (`app/(tabs)/`, `app/(auth)/`…)
 * dont le seul fichier est `_layout.tsx` ne contient AUCUN écran : son layout
 * déclare pourtant des `<Screen name="…" />` qui ne résolvent vers rien.
 *
 * Le gabarit `RN_TAB_LAYOUT` était émis inconditionnellement alors qu'aucun
 * écran n'était jamais placé dans `app/(tabs)/`. On supprime donc le groupe
 * vide plutôt que d'inventer un écran factice.
 */
export function pruneEmptyRouteGroups(files: GeneratedFile[]): {
  files:   GeneratedFile[];
  pruned:  string[];
} {
  const pruned: string[] = [];
  const groupOf = (p: string): string | null => {
    const m = p.match(/^(.*\/\([^)]+\))\//);
    return m?.[1] ?? null;
  };

  const byGroup = new Map<string, string[]>();
  for (const f of files) {
    const g = groupOf(f.path);
    if (!g) continue;
    byGroup.set(g, [...(byGroup.get(g) ?? []), f.path]);
  }

  const drop = new Set<string>();
  for (const [group, paths] of byGroup) {
    const others = paths.filter((p) => !/(^|\/)_layout\.(tsx?|jsx?)$/.test(p));
    if (others.length > 0) continue;
    for (const p of paths) {
      if (/(^|\/)_layout\.(tsx?|jsx?)$/.test(p)) { drop.add(p); pruned.push(p); }
    }
    void group;
  }
  if (drop.size === 0) return { files, pruned };
  return { files: files.filter((f) => !drop.has(f.path)), pruned };
}

/**
 * PHASE 48 — Réconcilie les écrans déclarés dans `app/_layout.tsx` avec les
 * fichiers réellement présents.
 *
 * Supprimer un groupe de routes vide sans mettre à jour le layout racine
 * laissait un `<Stack.Screen name="(tabs)" />` pointant vers rien. Le validateur
 * le signalait ensuite comme route cassée : la correction d'un défaut en
 * produisait un autre. On retire donc les déclarations sans cible.
 */
export function reconcileRootLayout(files: GeneratedFile[]): {
  files:    GeneratedFile[];
  removed:  string[];
} {
  const removed: string[] = [];
  const paths = new Set(files.map((f) => f.path));
  const exists = (name: string): boolean => {
    for (const ext of ['.tsx', '.ts', '.jsx', '.js']) if (paths.has(`app/${name}${ext}`)) return true;
    for (const p of paths) if (p.startsWith(`app/${name}/`)) return true;
    return false;
  };

  const next = files.map((f) => {
    if (f.path !== 'app/_layout.tsx') return f;
    let content = f.content;
    // Éléments auto-fermants : <Stack.Screen name="X" ... />
    content = content.replace(
      /<(Stack|Tabs|Drawer)\.Screen\s+[^>]*?name=["']([^"']+)["'][^>]*?\/>/g,
      (whole: string, _tag: string, name: string) => {
        if (exists(name)) return whole;
        removed.push(name);
        return '';
      },
    );
    return content === f.content ? f : { ...f, content };
  });

  return { files: next, removed };
}

export function normalizePlan(files: GeneratedFile[]): {
  files:  GeneratedFile[];
  report: PlanNormalizationReport;
} {
  const notes: string[] = [];

  const manifest = reconcileManifest(files);
  if (manifest.added.length > 0) {
    notes.push(`Dépendances ajoutées au manifeste : ${manifest.added.join(', ')}`);
  }
  if (manifest.unknown.length > 0) {
    notes.push(
      `Dépendances importées mais SANS version connue (non ajoutées, à déclarer) : ` +
      `${manifest.unknown.join(', ')}`,
    );
  }

  const services = deduplicateServices(manifest.files);
  for (const d of services.deduplicated) {
    notes.push(`Service '${d.service}' en double : conservé ${d.kept}, écarté ${d.dropped}`);
  }

  const paths = deduplicatePaths(services.files);
  for (const d of paths.duplicates) {
    notes.push(`Chemin en double '${d.path}' : conservée la version la plus complète`);
  }

  const entry = fixEntryRoute(paths.files);
  if (entry.fixed) notes.push("Route d'entrée reciblée sur un écran réellement présent");

  const groups = pruneEmptyRouteGroups(entry.files);
  for (const p of groups.pruned) {
    notes.push(`Groupe de routes vide supprimé : ${p} (aucun écran dans ce groupe)`);
  }

  const layout = reconcileRootLayout(groups.files);
  for (const name of layout.removed) {
    notes.push(`Écran retiré du layout racine car sans fichier correspondant : ${name}`);
  }

  return {
    files: layout.files,
    report: {
      addedDependencies:    manifest.added,
      unknownDependencies:  manifest.unknown,
      deduplicatedServices: services.deduplicated,
      duplicatePaths:       paths.duplicates,
      entryRouteFixed:      entry.fixed,
      prunedRouteGroups:    groups.pruned,
      removedLayoutScreens: layout.removed,
      notes,
    },
  };
}
