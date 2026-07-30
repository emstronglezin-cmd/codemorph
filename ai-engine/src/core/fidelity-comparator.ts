// ============================================================
// CodeMorph AI Engine — Fidelity Comparator (Source ↔ Generated)
// PHASE 28: Comparaison granulaire Source ↔ Généré
//
// PROBLÈME:
//   Le score de fidélité existant compare uniquement des comptages de fichiers.
//   Un vrai comparateur doit descendre au niveau :
//   - Classe (présente dans source ? présente en généré ?)
//   - Fonction / méthode (préservée ? signature correcte ?)
//   - Interface / type (conservé ?)
//   - Repository / Service / Provider (recréé ?)
//   - Business rule / validation (implémentée ?)
//
// SOLUTION:
//   1. Extraire le "profil" du code source (classes, fonctions, méthodes, etc.)
//   2. Extraire le "profil" du code généré
//   3. Comparer les deux profils
//   4. Produire un score détaillé par catégorie
//   5. Lister précisément les éléments manquants
// ============================================================

import type { GeneratedFile } from '../models/ir.types';

// ── Types du comparateur ──────────────────────────────────────────────────

export interface CodeElement {
  name:       string;    // nom de l'élément
  type:       ElementType;
  signature?: string;   // signature complète si disponible
  filePath?:  string;   // fichier d'origine
  isPublic:   boolean;  // exported ?
  isAsync:    boolean;  // async ?
  params?:    string[]; // paramètres (pour fonctions/méthodes)
  returnType?: string;  // type de retour
}

export type ElementType =
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'function'
  | 'method'
  | 'property'
  | 'constant'
  | 'service'
  | 'repository'
  | 'provider'
  | 'validator'
  | 'middleware'
  | 'hook'
  | 'store'
  | 'model'
  | 'controller'
  | 'guard'
  | 'pipe'
  | 'decorator'
  | 'module';

export interface CodeProfile {
  language:    string;
  totalFiles:  number;
  elements:    CodeElement[];
  byType:      Record<ElementType, CodeElement[]>;
  stats: {
    classes:     number;
    interfaces:  number;
    functions:   number;
    methods:     number;
    services:    number;
    repositories: number;
    providers:   number;
    validators:  number;
    stores:      number;
    models:      number;
    hooks:       number;
    middleware:  number;
    controllers: number;
  };
}

export interface ElementComparison {
  name:         string;
  type:         ElementType;
  inSource:     boolean;
  inGenerated:  boolean;
  match:        'exact' | 'partial' | 'missing' | 'extra';
  sourceFile?:  string | undefined;
  generatedFile?: string | undefined;
  note?:        string | undefined;
}

export interface FidelityComparatorResult {
  // Scores par catégorie (0-100)
  scores: {
    classes:       number;
    interfaces:    number;
    functions:     number;
    services:      number;
    repositories:  number;
    providers:     number;
    validators:    number;
    stores:        number;
    models:        number;
    hooks:         number;
    middleware:    number;
    controllers:   number;
    overall:       number;
  };
  // Détail des comparaisons
  comparisons:     ElementComparison[];
  // Éléments manquants dans le généré
  missing:         CodeElement[];
  // Éléments supplémentaires dans le généré (non présents dans source)
  extra:           CodeElement[];
  // Source profile
  sourceProfile:   CodeProfile;
  // Generated profile
  generatedProfile: CodeProfile;
  // Rapport formaté
  report:          string;
}

// ── Profil d'extraction — Source Dart/Flutter ─────────────────────────────

/**
 * Extrait le profil d'un projet Flutter/Dart depuis son contenu source
 */
export function extractSourceProfile(
  sourceCode: string,
  language:   string = 'dart',
): CodeProfile {
  const elements: CodeElement[] = [];
  const fileBlocks = splitIntoFileBlocks(sourceCode);

  for (const { path, content } of fileBlocks) {
    const fileElements = extractElementsFromFile(content, language, path);
    elements.push(...fileElements);
  }

  return buildProfile(elements, language, fileBlocks.length);
}

/**
 * Extrait le profil d'un projet généré depuis ses fichiers
 */
export function extractGeneratedProfile(
  files:    GeneratedFile[],
  language: string = 'typescript',
): CodeProfile {
  const elements: CodeElement[] = [];

  for (const file of files) {
    if (!file.content) continue;
    const ext = file.path.split('.').pop()?.toLowerCase() ?? '';
    if (!['ts', 'tsx', 'js', 'jsx'].includes(ext)) continue;

    const fileElements = extractElementsFromFile(file.content, language, file.path);
    elements.push(...fileElements);
  }

  return buildProfile(elements, language, files.length);
}

// ── Extracteur d'éléments par fichier ─────────────────────────────────────

function extractElementsFromFile(
  content:  string,
  language: string,
  filePath: string,
): CodeElement[] {
  const elements: CodeElement[] = [];
  const lines     = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line    = lines[i] ?? '';
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    const el = detectElementStart(trimmed, language, filePath, i, lines);
    if (el) elements.push(el);
  }

  return elements;
}

function detectElementStart(
  trimmed:  string,
  language: string,
  filePath: string,
  lineIdx:  number,
  lines:    string[],
): CodeElement | null {
  // ── TypeScript / JavaScript ──────────────────────────────
  if (['typescript', 'javascript', 'tsx', 'jsx'].includes(language)) {
    // Classe
    const classMatch = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
    if (classMatch?.[1]) {
      return {
        name:     classMatch[1],
        type:     classifyClass(classMatch[1], filePath),
        filePath,
        isPublic: trimmed.includes('export'),
        isAsync:  false,
      };
    }

    // Interface
    const ifaceMatch = trimmed.match(/^(?:export\s+)?interface\s+(\w+)/);
    if (ifaceMatch?.[1]) {
      return { name: ifaceMatch[1], type: 'interface', filePath, isPublic: trimmed.includes('export'), isAsync: false };
    }

    // Type alias
    const typeMatch = trimmed.match(/^(?:export\s+)?type\s+(\w+)\s*=/);
    if (typeMatch?.[1]) {
      return { name: typeMatch[1], type: 'type', filePath, isPublic: trimmed.includes('export'), isAsync: false };
    }

    // Enum
    const enumMatch = trimmed.match(/^(?:export\s+)?(?:const\s+)?enum\s+(\w+)/);
    if (enumMatch?.[1]) {
      return { name: enumMatch[1], type: 'enum', filePath, isPublic: trimmed.includes('export'), isAsync: false };
    }

    // Fonction exportée
    const funcMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
    if (funcMatch?.[1]) {
      return {
        name:      funcMatch[1],
        type:      classifyFunction(funcMatch[1], filePath),
        filePath,
        isPublic:  trimmed.includes('export'),
        isAsync:   trimmed.includes('async'),
        params:    funcMatch[2] ? [funcMatch[2]] : [],
      };
    }

    // Arrow function const
    const arrowMatch = trimmed.match(/^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(/);
    if (arrowMatch?.[1]) {
      return {
        name:     arrowMatch[1],
        type:     classifyFunction(arrowMatch[1], filePath),
        filePath,
        isPublic: trimmed.includes('export'),
        isAsync:  trimmed.includes('async'),
      };
    }

    // Méthode de classe (indentée)
    if (/^\s{2,}(?:public\s+|private\s+|protected\s+)?(?:async\s+)?(\w+)\s*\([^)]*\)/.test(lines[lineIdx] ?? '')) {
      const methodMatch = (lines[lineIdx] ?? '').match(/^\s+(?:public\s+|private\s+|protected\s+)?(?:async\s+)?(\w+)\s*\(([^)]*)\)/);
      if (methodMatch?.[1] && !['constructor', 'if', 'for', 'while', 'switch'].includes(methodMatch[1])) {
        return {
          name:      methodMatch[1],
          type:      'method',
          filePath,
          isPublic:  !(lines[lineIdx] ?? '').includes('private') && !(lines[lineIdx] ?? '').includes('protected'),
          isAsync:   (lines[lineIdx] ?? '').includes('async'),
          params:    methodMatch[2] ? [methodMatch[2]] : [],
        };
      }
    }

    // Hook React (useXxx)
    const hookMatch = trimmed.match(/^(?:export\s+)?(?:function|const)\s+(use[A-Z]\w+)/);
    if (hookMatch?.[1]) {
      return {
        name:     hookMatch[1],
        type:     'hook',
        filePath,
        isPublic: trimmed.includes('export'),
        isAsync:  trimmed.includes('async'),
      };
    }
  }

  // ── Dart ──────────────────────────────────────────────
  if (language === 'dart') {
    const classMatch = trimmed.match(/^(?:abstract\s+)?class\s+(\w+)/);
    if (classMatch?.[1]) {
      return {
        name:     classMatch[1],
        type:     classifyDartClass(classMatch[1]),
        filePath,
        isPublic: !classMatch[1].startsWith('_'),
        isAsync:  false,
      };
    }

    const enumMatch = trimmed.match(/^enum\s+(\w+)/);
    if (enumMatch?.[1]) {
      return { name: enumMatch[1], type: 'enum', filePath, isPublic: true, isAsync: false };
    }

    // Méthode Dart
    const methodMatch = trimmed.match(/^(?:Future<[^>]+>|void|String|int|double|bool|List|Map|Widget|dynamic)\s+(\w+)\s*\(/);
    if (methodMatch?.[1] && methodMatch[1] !== 'main') {
      return {
        name:     methodMatch[1],
        type:     'function',
        filePath,
        isPublic: !methodMatch[1].startsWith('_'),
        isAsync:  trimmed.startsWith('Future') || trimmed.includes('async'),
      };
    }
  }

  return null;
}

// ── Classifieurs sémantiques ───────────────────────────────────────────────

function classifyClass(name: string, filePath: string): ElementType {
  const lower = name.toLowerCase();
  const path  = filePath.toLowerCase();

  if (/service$/i.test(name) || path.includes('.service'))  return 'service';
  if (/repository$|repo$/i.test(name) || path.includes('.repository')) return 'repository';
  if (/provider$/i.test(name) || path.includes('.provider')) return 'provider';
  if (/validator$/i.test(name) || path.includes('.validator')) return 'validator';
  if (/middleware$/i.test(name) || path.includes('.middleware')) return 'middleware';
  if (/controller$/i.test(name) || path.includes('.controller')) return 'controller';
  if (/guard$/i.test(name) || path.includes('.guard')) return 'guard';
  if (/pipe$/i.test(name) || path.includes('.pipe')) return 'pipe';
  if (/module$/i.test(name) || path.includes('.module')) return 'module';
  if (/store$/i.test(name) || lower.includes('store') || path.includes('.store')) return 'store';
  if (/entity$|model$/i.test(name) || path.includes('.entity') || path.includes('model')) return 'model';
  return 'class';
}

function classifyFunction(name: string, filePath: string): ElementType {
  if (/^use[A-Z]/.test(name)) return 'hook';
  const path = filePath.toLowerCase();
  if (path.includes('.service')) return 'method';
  if (path.includes('store')) return 'method';
  return 'function';
}

function classifyDartClass(name: string): ElementType {
  if (/Service$/i.test(name))     return 'service';
  if (/Repository$|Repo$/i.test(name)) return 'repository';
  if (/Provider$/i.test(name))    return 'provider';
  if (/Validator$/i.test(name))   return 'validator';
  if (/Bloc$|Cubit$/i.test(name)) return 'store';
  if (/Store$|GetxController$/i.test(name)) return 'store';
  if (/Middleware$/i.test(name))  return 'middleware';
  if (/Model$|Entity$/i.test(name)) return 'model';
  if (/Widget$|Screen$|Page$/i.test(name)) return 'class';
  return 'class';
}

// ── Constructeur de profil ─────────────────────────────────────────────────

function buildProfile(elements: CodeElement[], language: string, fileCount: number): CodeProfile {
  const byType: Record<ElementType, CodeElement[]> = {
    class: [], interface: [], type: [], enum: [],
    function: [], method: [], property: [], constant: [],
    service: [], repository: [], provider: [], validator: [],
    middleware: [], hook: [], store: [], model: [],
    controller: [], guard: [], pipe: [], decorator: [], module: [],
  };

  for (const el of elements) {
    (byType[el.type] ?? byType['class']).push(el);
  }

  return {
    language,
    totalFiles: fileCount,
    elements,
    byType,
    stats: {
      classes:      byType.class.length,
      interfaces:   byType.interface.length + byType.type.length,
      functions:    byType.function.length,
      methods:      byType.method.length,
      services:     byType.service.length,
      repositories: byType.repository.length,
      providers:    byType.provider.length,
      validators:   byType.validator.length,
      stores:       byType.store.length,
      models:       byType.model.length,
      hooks:        byType.hook.length,
      middleware:   byType.middleware.length,
      controllers:  byType.controller.length,
    },
  };
}

// ── Splitter de fichiers source ────────────────────────────────────────────

function splitIntoFileBlocks(sourceCode: string): Array<{ path: string; content: string }> {
  const filePattern = /\/\/\s*(?:=+\s*)?FILE:\s*(.+?)(?:\s*=+)?\n([\s\S]*?)(?=\/\/\s*(?:=+\s*)?FILE:|$)/g;
  const blocks: Array<{ path: string; content: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = filePattern.exec(sourceCode)) !== null) {
    const path    = (match[1] ?? '').trim();
    const content = (match[2] ?? '').trim();
    if (path && content) blocks.push({ path, content });
  }

  // Si aucun marqueur FILE → traiter comme un seul fichier
  if (blocks.length === 0 && sourceCode.trim()) {
    blocks.push({ path: 'source.dart', content: sourceCode });
  }

  return blocks;
}

// ── Comparateur principal ─────────────────────────────────────────────────

/**
 * Compare le profil source avec le profil généré
 * Retourne un score de fidélité granulaire et la liste des manquants
 */
export function compareFidelity(
  sourceProfile:    CodeProfile,
  generatedProfile: CodeProfile,
): FidelityComparatorResult {
  const comparisons: ElementComparison[] = [];
  const missing:     CodeElement[]       = [];
  const extra:       CodeElement[]       = [];

  // ── Comparer les éléments publics du source avec le généré ─
  const sourceElements  = sourceProfile.elements.filter((e) => e.isPublic);
  const generatedNames  = new Set(generatedProfile.elements.map((e) => normalizeName(e.name)));

  for (const srcEl of sourceElements) {
    const normalized = normalizeName(srcEl.name);
    const inGenerated = generatedNames.has(normalized);

    comparisons.push({
      name:         srcEl.name,
      type:         srcEl.type,
      inSource:     true,
      inGenerated,
      match:        inGenerated ? 'exact' : 'missing',
      sourceFile:   srcEl.filePath,
    });

    if (!inGenerated) {
      missing.push(srcEl);
    }
  }

  // ── Détecter les éléments extra dans le généré ─────────────
  const sourceNames = new Set(sourceElements.map((e) => normalizeName(e.name)));
  for (const genEl of generatedProfile.elements) {
    if (!sourceNames.has(normalizeName(genEl.name))) {
      extra.push(genEl);
    }
  }

  // ── Calculer les scores par catégorie ─────────────────────
  const scores = computeCategoryScores(sourceProfile, generatedProfile);

  // ── Construire le rapport ──────────────────────────────────
  const report = buildComparisonReport(scores, missing, extra, sourceProfile, generatedProfile);

  return { scores, comparisons, missing, extra, sourceProfile, generatedProfile, report };
}

// ── Calcul des scores ─────────────────────────────────────────────────────

function computeCategoryScores(
  src: CodeProfile,
  gen: CodeProfile,
): FidelityComparatorResult['scores'] {
  const ratio = (srcCount: number, genCount: number): number => {
    if (srcCount === 0) return 100;
    if (genCount === 0) return 0;
    return Math.min(100, Math.round((genCount / srcCount) * 100));
  };

  const classes      = ratio(src.stats.classes,      gen.stats.classes);
  const interfaces   = ratio(src.stats.interfaces,   gen.stats.interfaces);
  const functions    = ratio(src.stats.functions + src.stats.methods, gen.stats.functions + gen.stats.methods);
  const services     = ratio(src.stats.services,     gen.stats.services);
  const repositories = ratio(src.stats.repositories, gen.stats.repositories);
  const providers    = ratio(src.stats.providers,    gen.stats.providers);
  const validators   = ratio(src.stats.validators,   gen.stats.validators);
  const stores       = ratio(src.stats.stores,       gen.stats.stores);
  const models       = ratio(src.stats.models,       gen.stats.models);
  const hooks        = ratio(src.stats.hooks,        gen.stats.hooks);
  const middleware   = ratio(src.stats.middleware,   gen.stats.middleware);
  const controllers  = ratio(src.stats.controllers,  gen.stats.controllers);

  // Overall = moyenne pondérée par importance métier
  const weights = {
    services: 3, repositories: 3, classes: 2, functions: 2,
    models: 2, stores: 2, controllers: 2, validators: 1.5,
    providers: 1.5, middleware: 1, interfaces: 1, hooks: 1,
  };
  const scoreMap = { services, repositories, classes, functions, models, stores, controllers, validators, providers, middleware, interfaces, hooks };
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
  const overall = Math.round(
    Object.entries(weights).reduce((sum, [key, w]) => sum + (scoreMap[key as keyof typeof scoreMap] ?? 0) * w, 0)
    / totalWeight
  );

  return { classes, interfaces, functions, services, repositories, providers, validators, stores, models, hooks, middleware, controllers, overall };
}

/**
 * Normalise un nom pour la comparaison (case-insensitive, sans suffixes communs)
 */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    // Retirer les suffixes de migration (Dart → TS)
    .replace(/service$/, '')
    .replace(/repository$|repo$/, '')
    .replace(/provider$/, '')
    .replace(/bloc$|cubit$/, 'store')
    .replace(/getxcontroller$/, 'store')
    .replace(/screen$|page$|view$/, '')
    .replace(/widget$/, '')
    .replace(/model$|entity$/, '')
    .replace(/validator$/, '')
    .replace(/controller$/, '')
    .replace(/middleware$/, '');
}

// ── Rapport formaté ───────────────────────────────────────────────────────

function buildComparisonReport(
  scores:     FidelityComparatorResult['scores'],
  missing:    CodeElement[],
  extra:      CodeElement[],
  src:        CodeProfile,
  gen:        CodeProfile,
): string {
  const bar = (score: number): string =>
    '█'.repeat(Math.round(score / 10)) + '░'.repeat(10 - Math.round(score / 10));

  const lines: string[] = [
    '',
    '════════════════════════════════════════════════════',
    '  FIDELITY COMPARATOR — SOURCE ↔ GENERATED (Phase 28)',
    '════════════════════════════════════════════════════',
    `  Source files:     ${src.totalFiles} files, ${src.elements.length} elements`,
    `  Generated files:  ${gen.totalFiles} files, ${gen.elements.length} elements`,
    '',
    '  CATEGORY SCORES:',
    `  ${'Architecture'.padEnd(16)} [${bar(scores.classes)}] ${String(scores.classes).padStart(3)}%  src=${src.stats.classes} gen=${gen.stats.classes}`,
    `  ${'Services'.padEnd(16)} [${bar(scores.services)}] ${String(scores.services).padStart(3)}%  src=${src.stats.services} gen=${gen.stats.services}`,
    `  ${'Repositories'.padEnd(16)} [${bar(scores.repositories)}] ${String(scores.repositories).padStart(3)}%  src=${src.stats.repositories} gen=${gen.stats.repositories}`,
    `  ${'Providers'.padEnd(16)} [${bar(scores.providers)}] ${String(scores.providers).padStart(3)}%  src=${src.stats.providers} gen=${gen.stats.providers}`,
    `  ${'Validators'.padEnd(16)} [${bar(scores.validators)}] ${String(scores.validators).padStart(3)}%  src=${src.stats.validators} gen=${gen.stats.validators}`,
    `  ${'Models'.padEnd(16)} [${bar(scores.models)}] ${String(scores.models).padStart(3)}%  src=${src.stats.models} gen=${gen.stats.models}`,
    `  ${'Stores'.padEnd(16)} [${bar(scores.stores)}] ${String(scores.stores).padStart(3)}%  src=${src.stats.stores} gen=${gen.stats.stores}`,
    `  ${'Controllers'.padEnd(16)} [${bar(scores.controllers)}] ${String(scores.controllers).padStart(3)}%  src=${src.stats.controllers} gen=${gen.stats.controllers}`,
    `  ${'Hooks'.padEnd(16)} [${bar(scores.hooks)}] ${String(scores.hooks).padStart(3)}%  src=${src.stats.hooks} gen=${gen.stats.hooks}`,
    `  ${'Middleware'.padEnd(16)} [${bar(scores.middleware)}] ${String(scores.middleware).padStart(3)}%  src=${src.stats.middleware} gen=${gen.stats.middleware}`,
    `  ${'Functions'.padEnd(16)} [${bar(scores.functions)}] ${String(scores.functions).padStart(3)}%  src=${src.stats.functions} gen=${gen.stats.functions}`,
    `  ${'Interfaces'.padEnd(16)} [${bar(scores.interfaces)}] ${String(scores.interfaces).padStart(3)}%  src=${src.stats.interfaces} gen=${gen.stats.interfaces}`,
    '  ────────────────────────────────────────────────',
    `  ${'OVERALL'.padEnd(16)} [${bar(scores.overall)}] ${String(scores.overall).padStart(3)}%`,
    '════════════════════════════════════════════════════',
  ];

  if (missing.length > 0) {
    lines.push('', `  MISSING ELEMENTS (${missing.length} total):`)
    const grouped = groupByType(missing);
    for (const [type, els] of Object.entries(grouped)) {
      lines.push(`  [${type.toUpperCase()}] ${els.map((e) => e.name).join(', ')}`);
    }
  }

  if (extra.length > 0 && extra.length <= 20) {
    lines.push('', `  EXTRA ELEMENTS in generated (${extra.length}):`,
      `  ${extra.map((e) => e.name).join(', ')}`);
  }

  lines.push('════════════════════════════════════════════════════', '');
  return lines.join('\n');
}

function groupByType(elements: CodeElement[]): Record<string, CodeElement[]> {
  const result: Record<string, CodeElement[]> = {};
  for (const el of elements) {
    if (!result[el.type]) result[el.type] = [];
    result[el.type]!.push(el);
  }
  return result;
}

// ── Intégration pipeline ──────────────────────────────────────────────────

/**
 * Point d'entrée principal: compare source code ↔ generated files
 * À appeler depuis pipeline.ts après la génération
 */
export function runFidelityComparison(
  sourceCode:      string,
  generatedFiles:  GeneratedFile[],
  sourceLanguage:  string = 'dart',
): FidelityComparatorResult {
  console.log(`\n[FidelityComparator] Starting Source ↔ Generated comparison...`);

  const sourceProfile    = extractSourceProfile(sourceCode, sourceLanguage);
  const generatedProfile = extractGeneratedProfile(generatedFiles, 'typescript');
  const result           = compareFidelity(sourceProfile, generatedProfile);

  console.log(result.report);

  console.log(`[FidelityComparator] Overall fidelity: ${result.scores.overall}%`);
  if (result.missing.length > 0) {
    console.warn(`[FidelityComparator] ⚠️  ${result.missing.length} elements missing from generated code`);
  }

  return result;
}
