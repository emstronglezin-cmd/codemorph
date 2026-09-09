// ============================================================
// CodeMorph AI Engine — Conversion Fidelity Engine (Phase 29)
//
// Compare le SOURCE (fichiers Dart/Flutter originaux) avec la
// CIBLE (fichiers React Native générés) sur 12 axes mesurables.
//
// DIFFÉRENCE vs fidelity-comparator.ts existant :
//   • fidelity-comparator.ts compare IR vs fichiers générés
//     (mesure la fidélité IR → code, pas source → code)
//   • fidelity-engine.ts compare RAW SOURCE vs ZIP généré
//     (mesure la fidélité réelle source → cible finale)
//
// 12 AXES :
//   1.  screens       — écrans/pages (présence + structure)
//   2.  navigation    — routes et flux de navigation
//   3.  ui_components — composants UI (widgets → components)
//   4.  business_logic — logique métier (validations, transformations)
//   5.  api_calls     — endpoints API (méthodes, URLs, params)
//   6.  state_mgmt    — gestion d'état (Bloc/Riverpod → Zustand/Redux)
//   7.  services      — services et repositories
//   8.  data_models   — modèles/types/DTOs
//   9.  assets        — images, fonts, traductions
//   10. config_env    — configuration, env vars, build files
//   11. dependencies  — dépendances clés préservées
//   12. features      — fonctionnalités détectées dans source
//
// SCORE FINAL :
//   N/A exclu du dénominateur
//   Score = somme(poids × score_axe) / somme(poids_axes_applicables)
// ============================================================

import type { GeneratedFile } from '../models/ir.types';

// ── Types ────────────────────────────────────────────────────────────────────

export type FidelityAxis =
  | 'screens'
  | 'navigation'
  | 'ui_components'
  | 'business_logic'
  | 'api_calls'
  | 'state_mgmt'
  | 'services'
  | 'data_models'
  | 'assets'
  | 'config_env'
  | 'dependencies'
  | 'features';

export type AxisStatus = 'measured' | 'na' | 'partial';

export interface AxisResult {
  axis:         FidelityAxis;
  status:       AxisStatus;
  score:        number | null;   // null = N/A
  weight:       number;          // poids relatif (0..1)
  sourceCount:  number;          // éléments dans source
  targetCount:  number;          // éléments dans cible
  identical:    string[];        // présents et équivalents
  transformed:  string[];        // présents mais adaptés (correct)
  missing:      string[];        // présents en source, absents en cible
  added:        string[];        // présents en cible, absents en source
  unverifiable: string[];        // impossibles à mesurer automatiquement
  details:      string;          // description textuelle
}

export interface FidelityReport {
  jobId:               string;
  timestamp:           string;
  sourceFramework:     string;
  targetFramework:     string;
  sourceFileCount:     number;
  targetFileCount:     number;
  // Scores
  overallFidelityScore: number;   // 0-100, excluant les N/A
  axes:                AxisResult[];
  // Résumé
  applicableAxes:      FidelityAxis[];
  naAxes:              FidelityAxis[];
  totalIdentical:      number;
  totalTransformed:    number;
  totalMissing:        number;
  totalAdded:          number;
  // Verdict
  verdict:             'EXCELLENT' | 'GOOD' | 'PARTIAL' | 'POOR' | 'FAILED';
  verdictReason:       string;
  // Timing
  computedInMs:        number;
}

// ── Poids par axe ────────────────────────────────────────────────────────────
const AXIS_WEIGHTS: Record<FidelityAxis, number> = {
  screens:        0.20,  // écrans = cœur de l'app
  business_logic: 0.15,  // logique = critique
  api_calls:      0.12,  // API = critique pour fonctionnement
  services:       0.10,  // services = important
  state_mgmt:     0.10,  // state = important
  navigation:     0.08,  // navigation = important
  ui_components:  0.08,  // UI = visible
  data_models:    0.07,  // types = support
  features:       0.05,  // features = fonctionnel
  dependencies:   0.03,  // deps = support
  config_env:     0.01,  // config = infra
  assets:         0.01,  // assets = ressources
};

// ── Extraction de profil source (Dart/Flutter) ────────────────────────────────

interface SourceProfile {
  screens:        string[];
  routes:         string[];
  apiEndpoints:   string[];
  services:       string[];
  repositories:   string[];
  stateClasses:   string[];   // Bloc, Cubit, Notifier, Provider
  models:         string[];
  widgets:        string[];
  features:       string[];
  envVars:        string[];
  dependencies:   string[];
  assets:         string[];
  totalFiles:     number;
  dartFiles:      string[];
}

function extractSourceProfile(sourceCode: string): SourceProfile {
  const lines    = sourceCode.split('\n');
  const profile: SourceProfile = {
    screens: [], routes: [], apiEndpoints: [], services: [],
    repositories: [], stateClasses: [], models: [], widgets: [],
    features: [], envVars: [], dependencies: [], assets: [],
    totalFiles: 0, dartFiles: [],
  };

  let currentFile = '';
  let inPubspec   = false;
  let inDeps      = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Tracker le fichier courant
    const fileMarker = rawLine.match(/\/\/\s*=+\s*FILE:\s*(.+?)\s*=+/);
    if (fileMarker?.[1]) {
      currentFile = fileMarker[1].trim();
      profile.totalFiles++;
      if (currentFile.endsWith('.dart')) profile.dartFiles.push(currentFile);
      inPubspec = currentFile === 'pubspec.yaml' || currentFile.includes('pubspec.yaml');
      inDeps = false;
      continue;
    }

    // Pubspec: extraire dépendances
    if (inPubspec) {
      if (/^dependencies:\s*$/.test(line)) { inDeps = true; continue; }
      if (/^dev_dependencies:\s*$/.test(line)) { inDeps = false; continue; }
      if (inDeps && /^\s+\w/.test(rawLine)) {
        const dep = line.split(':')[0]?.trim();
        if (dep && dep !== 'flutter' && dep !== 'sdk') {
          profile.dependencies.push(dep);
        }
      }
      continue;
    }

    // Écrans
    if (/class\s+\w+Screen\s+extends/.test(line) || /class\s+\w+Page\s+extends/.test(line) ||
        /class\s+\w+View\s+extends/.test(line)) {
      const m = line.match(/class\s+(\w+(?:Screen|Page|View))\s+extends/);
      if (m?.[1]) profile.screens.push(m[1]);
    }

    // Widgets
    if (/class\s+\w+Widget\s+extends/.test(line) || /class\s+\w+Card\s+extends/.test(line)) {
      const m = line.match(/class\s+(\w+)\s+extends/);
      if (m?.[1]) profile.widgets.push(m[1]);
    }

    // Routes / navigation
    if (/GoRoute\s*\(|MaterialPageRoute|CupertinoPageRoute|context\.go\s*\(|Navigator\.push/.test(line)) {
      const pathM = line.match(/path:\s*['"]([^'"]+)['"]/);
      if (pathM?.[1]) profile.routes.push(pathM[1]);
      else if (/context\.go\s*\(['"]([^'"]+)['"]/.test(line)) {
        const m2 = line.match(/context\.go\s*\(['"]([^'"]+)['"]/);
        if (m2?.[1]) profile.routes.push(m2[1]);
      }
    }

    // API calls
    if (/http\.get\s*\(|http\.post\s*\(|http\.put\s*\(|http\.delete\s*\(|dio\.get\s*\(|dio\.post\s*\(/.test(line) ||
        /client\.get\s*\(|client\.post\s*\(|_dio\./.test(line)) {
      const urlM = line.match(/['"](\/(api\/)?[a-zA-Z0-9\/\-_]+)['"]/);
      if (urlM?.[1]) profile.apiEndpoints.push(urlM[1]);
      else profile.apiEndpoints.push(`${currentFile}:${line.trim().slice(0, 40)}`);
    }

    // Services
    if (/class\s+\w+Service\s/.test(line) || /class\s+\w+Api\s/.test(line)) {
      const m = line.match(/class\s+(\w+(?:Service|Api))\s/);
      if (m?.[1]) profile.services.push(m[1]);
    }

    // Repositories
    if (/class\s+\w+Repository/.test(line) || /class\s+\w+Repo\s/.test(line)) {
      const m = line.match(/class\s+(\w+(?:Repository|Repo))\s/);
      if (m?.[1]) profile.repositories.push(m[1]);
    }

    // State management
    if (/class\s+\w+Bloc\s|class\s+\w+Cubit\s|class\s+\w+Notifier\s|class\s+\w+Provider\s|class\s+\w+Store\s/.test(line)) {
      const m = line.match(/class\s+(\w+)\s/);
      if (m?.[1]) profile.stateClasses.push(m[1]);
    }

    // Models / DTOs
    if (/class\s+\w+Model\s|class\s+\w+Dto\s|class\s+\w+Entity\s|class\s+\w+Response\s/.test(line)) {
      const m = line.match(/class\s+(\w+(?:Model|Dto|Entity|Response))\s/);
      if (m?.[1]) profile.models.push(m[1]);
    }

    // Env vars
    if (/const\s+\w+\s*=\s*dotenv\.|dotenv\.env\[|String\.fromEnvironment\(/.test(line)) {
      const m = line.match(/['"]([A-Z_][A-Z0-9_]{2,})['"]/);
      if (m?.[1]) profile.envVars.push(m[1]);
    }

    // Assets (pubspec assets section)
    if (/assets\/|fonts\/|images\//.test(line)) {
      const m = line.match(/(assets\/[^\s'"]+|fonts\/[^\s'"]+|images\/[^\s'"]+)/);
      if (m?.[1]) profile.assets.push(m[1]);
    }

    // Features (commentaires de features)
    if (/\/\/\s*(?:feature|Feature|FEATURE):\s*(.+)/.test(line)) {
      const m = line.match(/\/\/\s*(?:feature|Feature|FEATURE):\s*(.+)/);
      if (m?.[1]) profile.features.push(m[1].trim());
    }
  }

  // Dédupliquer
  for (const key of Object.keys(profile) as Array<keyof SourceProfile>) {
    if (Array.isArray(profile[key])) {
      (profile as unknown as Record<string, unknown>)[key] = [...new Set(profile[key] as string[])];
    }
  }

  return profile;
}

// ── Extraction de profil cible (React Native / TypeScript) ───────────────────

interface TargetProfile {
  screens:        string[];
  routes:         string[];
  apiEndpoints:   string[];
  services:       string[];
  stores:         string[];   // Zustand stores
  models:         string[];
  components:     string[];
  envVars:        string[];
  dependencies:   string[];
  assets:         string[];
  totalFiles:     number;
  tsxFiles:       string[];
}

function extractTargetProfile(files: GeneratedFile[]): TargetProfile {
  const profile: TargetProfile = {
    screens: [], routes: [], apiEndpoints: [], services: [],
    stores: [], models: [], components: [], envVars: [], dependencies: [],
    assets: [], totalFiles: files.length, tsxFiles: [],
  };

  for (const file of files) {
    const path    = file.path;
    const content = file.content ?? '';
    const lines   = content.split('\n');

    if (path.endsWith('.tsx') || path.endsWith('.ts')) {
      profile.tsxFiles.push(path);
    }

    // Détecter les écrans (app/*.tsx, screens/*.tsx, pages/*.tsx)
    if (/(?:app|screens?|pages?)\/[\w\-]+\.tsx?$/.test(path) && !/_layout/.test(path)) {
      const name = path.split('/').pop()?.replace(/\.(tsx?|jsx?)$/, '') ?? '';
      if (name) profile.screens.push(name);
    }

    // Package.json: dépendances
    if (path === 'package.json') {
      try {
        const pkg = JSON.parse(content) as Record<string, unknown>;
        const deps = { ...(pkg['dependencies'] as Record<string, string> ?? {}),
                       ...(pkg['devDependencies'] as Record<string, string> ?? {}) };
        profile.dependencies.push(...Object.keys(deps));
      } catch { /* ignore */ }
    }

    // .env
    if (path.includes('.env')) {
      for (const line of lines) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
        if (m?.[1]) profile.envVars.push(m[1]);
      }
    }

    for (const rawLine of lines) {
      const line = rawLine.trim();

      // Routes (react-navigation, expo-router)
      if (/name:\s*['"]([^'"]+)['"]/.test(line) || /href:\s*['"]([^'"]+)['"]/.test(line) ||
          /route:\s*['"]([^'"]+)['"]/.test(line)) {
        const m = line.match(/['"](\/?[a-zA-Z0-9\/\-_]+)['"]/);
        if (m?.[1] && m[1].startsWith('/')) profile.routes.push(m[1]);
      }

      // API calls
      if (/fetch\s*\(|axios\.(get|post|put|delete|patch)\s*\(|api\.(get|post|put|delete)\s*\(/.test(line)) {
        const urlM = line.match(/['"](\/(api\/)?[a-zA-Z0-9\/\-_]+)['"]/);
        if (urlM?.[1]) profile.apiEndpoints.push(urlM[1]);
        else profile.apiEndpoints.push(`${path}:${line.slice(0, 40)}`);
      }

      // Services
      if (/class\s+\w+Service\s/.test(line)) {
        const m = line.match(/class\s+(\w+Service)\s/);
        if (m?.[1]) profile.services.push(m[1]);
      }

      // Zustand stores
      if (/create\s*\(\s*(?:set|get|subscribeWithSelector)/.test(line) ||
          /useStore\s*=\s*create/.test(line) || /\.store\.ts$/.test(path)) {
        const storeM = path.match(/(\w+)\.store\.ts$/);
        if (storeM?.[1]) profile.stores.push(storeM[1]);
      }

      // Models / interfaces
      if (/^(?:export\s+)?interface\s+\w+/.test(line) || /^(?:export\s+)?type\s+\w+\s*=/.test(line)) {
        const m = line.match(/(?:interface|type)\s+(\w+)/);
        if (m?.[1] && m[1].length > 2) profile.models.push(m[1]);
      }

      // Components
      if (/^(?:export\s+)?(?:default\s+)?function\s+[A-Z]\w+/.test(line) ||
          /^const\s+[A-Z]\w+\s*=\s*(?:React\.memo|memo)/.test(line)) {
        const m = line.match(/function\s+([A-Z]\w+)|const\s+([A-Z]\w+)\s*=/);
        const name = m?.[1] ?? m?.[2];
        if (name && name.length > 2) profile.components.push(name);
      }

      // Assets
      if (/require\s*\(['"](\.\.\/)*(assets|images|fonts)\//.test(line)) {
        const m = line.match(/require\s*\(['"]([^'"]+)['"]/);
        if (m?.[1]) profile.assets.push(m[1]);
      }
    }
  }

  // Dédupliquer
  for (const key of Object.keys(profile) as Array<keyof TargetProfile>) {
    if (Array.isArray(profile[key])) {
      (profile as unknown as Record<string, unknown>)[key] = [...new Set(profile[key] as string[])];
    }
  }

  return profile;
}

// ── Normalisation des noms pour comparaison fuzzy ────────────────────────────

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/screen|page|view|widget|component|bloc|cubit|provider|notifier|service|repository|repo|store|model|dto|entity/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function fuzzyMatch(sourceNames: string[], targetNames: string[]): {
  identical:    string[];
  missing:      string[];
  added:        string[];
} {
  const normalizedTarget = new Map(targetNames.map((n) => [normalizeName(n), n]));
  const normalizedSource = new Map(sourceNames.map((n) => [normalizeName(n), n]));

  const identical: string[] = [];
  const missing: string[] = [];
  const added: string[] = [];
  const matchedTargetKeys = new Set<string>();

  for (const src of sourceNames) {
    const normSrc = normalizeName(src);
    if (normalizedTarget.has(normSrc)) {
      identical.push(src);
      matchedTargetKeys.add(normSrc);
    } else {
      // Recherche partielle (substring)
      let found = false;
      for (const [normTgt, tgt] of normalizedTarget) {
        if (normSrc.length >= 3 && normTgt.includes(normSrc) || normSrc.includes(normTgt)) {
          identical.push(`${src}→${tgt}`);
          matchedTargetKeys.add(normTgt);
          found = true;
          break;
        }
      }
      if (!found) missing.push(src);
    }
  }

  for (const [normTgt, tgt] of normalizedTarget) {
    if (!matchedTargetKeys.has(normTgt) && !normalizedSource.has(normTgt)) {
      added.push(tgt);
    }
  }

  return { identical, missing, added };
}

// ── Calcul d'un axe ───────────────────────────────────────────────────────────

function computeAxis(
  axis:         FidelityAxis,
  sourceItems:  string[],
  targetItems:  string[],
  isApplicable?: boolean,
): AxisResult {
  const applicable = isApplicable !== undefined ? isApplicable : sourceItems.length > 0;

  if (!applicable) {
    return {
      axis,
      status:       'na',
      score:        null,
      weight:       AXIS_WEIGHTS[axis],
      sourceCount:  sourceItems.length,
      targetCount:  targetItems.length,
      identical:    [],
      transformed:  [],
      missing:      [],
      added:        targetItems.slice(0, 10),
      unverifiable: [],
      details:      `N/A — no ${axis} detected in source`,
    };
  }

  const { identical, missing, added } = fuzzyMatch(sourceItems, targetItems);

  // Score = (identical + transformed) / sourceItems.length
  const preserved = identical.length;
  const score = sourceItems.length > 0
    ? Math.round((preserved / sourceItems.length) * 100)
    : 100;

  return {
    axis,
    status:       'measured',
    score:        Math.min(100, score),
    weight:       AXIS_WEIGHTS[axis],
    sourceCount:  sourceItems.length,
    targetCount:  targetItems.length,
    identical,
    transformed:  [],  // à remplir par comparaison sémantique si disponible
    missing:      missing.slice(0, 20),
    added:        added.slice(0, 20),
    unverifiable: [],
    details:      `${identical.length}/${sourceItems.length} preserved (${score}%)`,
  };
}

// ── Fonction principale ───────────────────────────────────────────────────────

export function computeFidelityReport(params: {
  jobId:           string;
  sourceCode:      string;
  generatedFiles:  GeneratedFile[];
  sourceFramework: string;
  targetFramework: string;
}): FidelityReport {
  const startMs = Date.now();
  const { jobId, sourceCode, generatedFiles, sourceFramework, targetFramework } = params;

  const src = extractSourceProfile(sourceCode);
  const tgt = extractTargetProfile(generatedFiles);

  // Calculer chaque axe
  const axes: AxisResult[] = [

    // 1. Écrans
    computeAxis('screens', src.screens, tgt.screens, src.screens.length > 0),

    // 2. Navigation
    computeAxis('navigation', src.routes, tgt.routes, src.routes.length > 0),

    // 3. UI Components
    computeAxis('ui_components', src.widgets, tgt.components),

    // 4. Business Logic — compare services et repos avec stores
    computeAxis('business_logic',
      [...src.services, ...src.repositories],
      [...tgt.services, ...tgt.stores],
      src.services.length + src.repositories.length > 0
    ),

    // 5. API Calls
    computeAxis('api_calls', src.apiEndpoints, tgt.apiEndpoints, src.apiEndpoints.length > 0),

    // 6. State Management
    computeAxis('state_mgmt', src.stateClasses, tgt.stores, src.stateClasses.length > 0),

    // 7. Services
    computeAxis('services', src.services, tgt.services, src.services.length > 0),

    // 8. Data Models
    computeAxis('data_models', src.models, tgt.models, src.models.length > 0),

    // 9. Assets
    computeAxis('assets', src.assets, tgt.assets, src.assets.length > 0),

    // 10. Config/Env
    computeAxis('config_env', src.envVars, tgt.envVars, src.envVars.length > 0),

    // 11. Dependencies
    computeAxis('dependencies',
      src.dependencies.slice(0, 30),
      tgt.dependencies.slice(0, 50),
      src.dependencies.length > 0
    ),

    // 12. Features
    computeAxis('features', src.features, [], src.features.length > 0),
  ];

  // Score global (pondéré, N/A exclus)
  const applicableAxes   = axes.filter((a) => a.status === 'measured');
  const naAxes           = axes.filter((a) => a.status === 'na');
  const totalWeight      = applicableAxes.reduce((s, a) => s + a.weight, 0);
  const weightedScore    = applicableAxes.reduce((s, a) => s + (a.score ?? 0) * a.weight, 0);
  const overallFidelityScore = totalWeight > 0
    ? Math.round(weightedScore / totalWeight)
    : 0;

  // Totaux
  const totalIdentical   = axes.reduce((s, a) => s + a.identical.length, 0);
  const totalTransformed = axes.reduce((s, a) => s + a.transformed.length, 0);
  const totalMissing     = axes.reduce((s, a) => s + a.missing.length, 0);
  const totalAdded       = axes.reduce((s, a) => s + a.added.length, 0);

  // Verdict
  let verdict: FidelityReport['verdict'];
  let verdictReason: string;
  if (overallFidelityScore >= 85) {
    verdict = 'EXCELLENT';
    verdictReason = 'All key elements faithfully reproduced';
  } else if (overallFidelityScore >= 70) {
    verdict = 'GOOD';
    verdictReason = `${totalMissing} elements missing but core structure preserved`;
  } else if (overallFidelityScore >= 50) {
    verdict = 'PARTIAL';
    verdictReason = `${totalMissing} elements missing — conversion incomplete`;
  } else if (overallFidelityScore >= 20) {
    verdict = 'POOR';
    verdictReason = `Major elements missing — fidelity insufficient (${overallFidelityScore}%)`;
  } else {
    verdict = 'FAILED';
    verdictReason = `Conversion failed to reproduce source application (${overallFidelityScore}%)`;
  }

  return {
    jobId,
    timestamp:           new Date().toISOString(),
    sourceFramework,
    targetFramework,
    sourceFileCount:     src.totalFiles,
    targetFileCount:     tgt.totalFiles,
    overallFidelityScore,
    axes,
    applicableAxes:      applicableAxes.map((a) => a.axis),
    naAxes:              naAxes.map((a) => a.axis),
    totalIdentical,
    totalTransformed,
    totalMissing,
    totalAdded,
    verdict,
    verdictReason,
    computedInMs:        Date.now() - startMs,
  };
}

// ── Source Analysis (profil détaillé du source) ───────────────────────────────

export interface SourceAnalysis {
  jobId:           string;
  timestamp:       string;
  sourceFramework: string;
  totalFiles:      number;
  dartFiles:       number;
  screens:         string[];
  routes:          string[];
  services:        string[];
  repositories:    string[];
  stateClasses:    string[];
  models:          string[];
  widgets:         string[];
  apiEndpoints:    string[];
  dependencies:    string[];
  envVars:         string[];
  assets:          string[];
  features:        string[];
  complexity: {
    screenCount:   number;
    serviceCount:  number;
    stateCount:    number;
    apiCount:      number;
    totalChars:    number;
    level:         'small' | 'medium' | 'large' | 'xlarge';
  };
}

export function analyzeSource(jobId: string, sourceCode: string, sourceFramework: string): SourceAnalysis {
  const profile = extractSourceProfile(sourceCode);
  const totalChars = sourceCode.length;

  const screenCount  = profile.screens.length;
  const serviceCount = profile.services.length + profile.repositories.length;
  const stateCount   = profile.stateClasses.length;
  const apiCount     = profile.apiEndpoints.length;

  let level: SourceAnalysis['complexity']['level'] = 'small';
  if (screenCount > 20 || totalChars > 200_000) level = 'xlarge';
  else if (screenCount > 10 || totalChars > 80_000) level = 'large';
  else if (screenCount > 5 || totalChars > 20_000) level = 'medium';

  return {
    jobId,
    timestamp:        new Date().toISOString(),
    sourceFramework,
    totalFiles:       profile.totalFiles,
    dartFiles:        profile.dartFiles.length,
    screens:          profile.screens,
    routes:           profile.routes,
    services:         profile.services,
    repositories:     profile.repositories,
    stateClasses:     profile.stateClasses,
    models:           profile.models,
    widgets:          profile.widgets,
    apiEndpoints:     profile.apiEndpoints,
    dependencies:     profile.dependencies,
    envVars:          profile.envVars,
    assets:           profile.assets,
    features:         profile.features,
    complexity: { screenCount, serviceCount, stateCount, apiCount, totalChars, level },
  };
}

// ── Formats de sortie ─────────────────────────────────────────────────────────

export function fidelityReportToMarkdown(report: FidelityReport): string {
  const lines: string[] = [];
  const icon = (s: number | null) => {
    if (s === null) return '⬜';
    if (s >= 85) return '🟢';
    if (s >= 70) return '🟡';
    if (s >= 50) return '🟠';
    return '🔴';
  };

  lines.push('# CodeMorph Fidelity Report');
  lines.push('');
  lines.push(`**Job**: ${report.jobId}`);
  lines.push(`**Date**: ${report.timestamp}`);
  lines.push(`**Conversion**: ${report.sourceFramework} → ${report.targetFramework}`);
  lines.push(`**Source files**: ${report.sourceFileCount} | **Target files**: ${report.targetFileCount}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`## Overall Fidelity Score: ${icon(report.overallFidelityScore)} **${report.overallFidelityScore}%**`);
  lines.push('');
  lines.push(`**Verdict**: ${report.verdict} — ${report.verdictReason}`);
  lines.push('');

  lines.push('## Axes Summary');
  lines.push('');
  lines.push('| Axis | Score | Source | Target | Missing | Added |');
  lines.push('|------|-------|--------|--------|---------|-------|');
  for (const ax of report.axes) {
    const scoreStr = ax.score === null ? 'N/A' : `${icon(ax.score)} ${ax.score}%`;
    lines.push(`| ${ax.axis} | ${scoreStr} | ${ax.sourceCount} | ${ax.targetCount} | ${ax.missing.length} | ${ax.added.length} |`);
  }

  lines.push('');
  lines.push('## Totals');
  lines.push(`- **Identical**: ${report.totalIdentical}`);
  lines.push(`- **Transformed correctly**: ${report.totalTransformed}`);
  lines.push(`- **Missing** (in source, absent from target): ${report.totalMissing}`);
  lines.push(`- **Added** (in target, absent from source): ${report.totalAdded}`);
  lines.push(`- **N/A axes** (excluded from score): ${report.naAxes.join(', ') || 'none'}`);
  lines.push('');

  lines.push('## Detail by Axis');
  lines.push('');
  for (const ax of report.axes) {
    if (ax.status === 'na') continue;
    lines.push(`### ${ax.axis} — ${ax.score}%`);
    if (ax.missing.length > 0) {
      lines.push('**Missing elements**:');
      ax.missing.slice(0, 10).forEach((m) => lines.push(`  - ❌ ${m}`));
    }
    if (ax.added.length > 0) {
      lines.push('**Added elements** (not in source):');
      ax.added.slice(0, 5).forEach((a) => lines.push(`  - ➕ ${a}`));
    }
    lines.push('');
  }

  lines.push(`---`);
  lines.push(`*Computed in ${report.computedInMs}ms*`);

  return lines.join('\n');
}

export function fidelityReportToHTML(report: FidelityReport): string {
  const scoreColor = (s: number | null): string => {
    if (s === null) return '#888';
    if (s >= 85) return '#22c55e';
    if (s >= 70) return '#f59e0b';
    if (s >= 50) return '#f97316';
    return '#ef4444';
  };

  const verdictColor: Record<FidelityReport['verdict'], string> = {
    EXCELLENT: '#22c55e', GOOD: '#84cc16', PARTIAL: '#f59e0b', POOR: '#f97316', FAILED: '#ef4444',
  };

  const axisRows = report.axes.map((ax) => {
    const score = ax.score === null ? 'N/A' : `${ax.score}%`;
    const color = scoreColor(ax.score);
    return `
    <tr>
      <td><strong>${ax.axis}</strong></td>
      <td style="color:${color};font-weight:bold">${score}</td>
      <td>${ax.sourceCount}</td>
      <td>${ax.targetCount}</td>
      <td style="color:#ef4444">${ax.missing.length > 0 ? ax.missing.slice(0, 3).join(', ') + (ax.missing.length > 3 ? `… +${ax.missing.length - 3}` : '') : '—'}</td>
      <td style="color:#22c55e">${ax.added.length > 0 ? ax.added.slice(0, 3).join(', ') + (ax.added.length > 3 ? `… +${ax.added.length - 3}` : '') : '—'}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>CodeMorph Fidelity Report — ${report.jobId}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#0f172a; color:#e2e8f0; padding:2rem; }
  .card { background:#1e293b; border-radius:12px; padding:1.5rem; margin-bottom:1.5rem; border:1px solid #334155; }
  h1 { color:#f1f5f9; font-size:1.8rem; }
  h2 { color:#94a3b8; font-size:1.1rem; text-transform:uppercase; letter-spacing:.05em; }
  .score-big { font-size:4rem; font-weight:800; }
  .verdict { display:inline-block; padding:.4rem 1rem; border-radius:6px; font-weight:700; font-size:1rem; }
  table { width:100%; border-collapse:collapse; }
  th { text-align:left; color:#64748b; font-size:.85rem; padding:.5rem; border-bottom:1px solid #334155; }
  td { padding:.5rem; border-bottom:1px solid #1e293b; font-size:.9rem; }
  .meta { color:#64748b; font-size:.85rem; }
  .stat { display:inline-block; margin-right:2rem; }
  .stat .num { font-size:1.8rem; font-weight:700; }
  .stat .label { font-size:.8rem; color:#64748b; }
</style>
</head>
<body>
<div class="card">
  <h1>CodeMorph Fidelity Report</h1>
  <p class="meta">Job: <strong>${report.jobId}</strong> &nbsp;|&nbsp; ${report.timestamp}</p>
  <p class="meta">${report.sourceFramework} → ${report.targetFramework} &nbsp;|&nbsp; ${report.sourceFileCount} source files → ${report.targetFileCount} target files</p>
</div>

<div class="card">
  <h2>Overall Score</h2>
  <div class="score-big" style="color:${scoreColor(report.overallFidelityScore)}">${report.overallFidelityScore}%</div>
  <span class="verdict" style="background:${verdictColor[report.verdict]}20;color:${verdictColor[report.verdict]};border:1px solid ${verdictColor[report.verdict]}">${report.verdict}</span>
  <p style="margin-top:.5rem;color:#94a3b8">${report.verdictReason}</p>
  <div style="margin-top:1rem">
    <span class="stat"><span class="num" style="color:#22c55e">${report.totalIdentical}</span><br><span class="label">Identical</span></span>
    <span class="stat"><span class="num" style="color:#84cc16">${report.totalTransformed}</span><br><span class="label">Transformed</span></span>
    <span class="stat"><span class="num" style="color:#ef4444">${report.totalMissing}</span><br><span class="label">Missing</span></span>
    <span class="stat"><span class="num" style="color:#3b82f6">${report.totalAdded}</span><br><span class="label">Added</span></span>
    <span class="stat"><span class="num" style="color:#888">${report.naAxes.length}</span><br><span class="label">N/A axes</span></span>
  </div>
</div>

<div class="card">
  <h2>Axes Detail</h2>
  <table>
    <thead><tr><th>Axis</th><th>Score</th><th>Source</th><th>Target</th><th>Missing</th><th>Added</th></tr></thead>
    <tbody>${axisRows}</tbody>
  </table>
</div>

<p class="meta">Computed in ${report.computedInMs}ms &nbsp;|&nbsp; Applicable axes: ${report.applicableAxes.join(', ')}</p>
</body>
</html>`;
}
