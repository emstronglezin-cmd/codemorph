/**
 * canonical-ir.ts — PHASE 50
 *
 * Représentation intermédiaire CANONIQUE des symboles, chemins, types,
 * méthodes et routes.
 *
 * ## Pourquoi ce module existe
 *
 * AVANT ce module, le moteur contenait TROIS mappings Dart→TypeScript
 * indépendants et DEUX logiques de chemins indépendantes :
 *
 *   1. `dart-transpiler.ts`  → `TYPE_MAP` + `mapType()`
 *   2. `code-planner.ts`     → `dartTypeToTS()`
 *   3. `ir-generator.ts`     → `mapDartType()`
 *
 * Conséquences mesurées sur des conversions réelles :
 *
 *   • `code-planner` écrivait `${f.name}: ${f.type}` SANS mapper le type, donc
 *     un champ Dart `bool` produisait `title: bool` en TypeScript → échec de la
 *     compilation.
 *   • Le même fichier comparait `f.type === 'boolean'` (nom TypeScript) pour
 *     décider de générer `toggle()` et le compteur, alors que l'IR peut porter
 *     le nom Dart `bool`. Quand l'IR venait du modèle d'IA (aucune
 *     normalisation), la comparaison ne matchait jamais : le service exposait
 *     `getAll()` et `add()` mais PAS `toggle()`, alors que les écrans
 *     l'appelaient.
 *   • `dart-transpiler.transpileImport()` recopiait le chemin Dart source
 *     (`../widgets/task_tile`) comme spécificateur d'import, alors que le
 *     fichier généré vit à `src/components/TaskTile.tsx`.
 *
 * La cause commune : chaque générateur réinventait la traduction des symboles
 * au lieu de consulter une source unique de vérité.
 *
 * ## Contrat de ce module
 *
 *   • `mapDartTypeToTS()` est le SEUL mapping de types. Il est idempotent :
 *     il accepte un type Dart OU déjà TypeScript et renvoie toujours du
 *     TypeScript. Aucun générateur ne doit écrire un type d'IR brut.
 *   • `buildSymbolTable()` est construit sur la liste RÉELLE des fichiers
 *     générés (`GeneratedFile.path` / `fromPath`), jamais sur une convention
 *     devinée. Si un symbole n'a pas de fichier, il est explicitement marqué
 *     `NOT_CONVERTED` — jamais deviné, jamais laissé en import cassé.
 *   • `relativeSpecifier()` calcule le chemin relatif avec la casse exacte du
 *     fichier cible.
 */

import type { GeneratedFile, IRDocument } from '../models/ir.types';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Mapping Dart → TypeScript. C'est la seule table de types du moteur.
 * Les clés TypeScript y figurent aussi, ce qui rend le mapping idempotent.
 */
const DART_TO_TS: Readonly<Record<string, string>> = {
  // Dart
  String: 'string',
  int: 'number',
  double: 'number',
  num: 'number',
  bool: 'boolean',
  dynamic: 'unknown',
  Object: 'object',
  void: 'void',
  Never: 'never',
  DateTime: 'string',
  Duration: 'number',
  // TypeScript — rend le mapping idempotent
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  unknown: 'unknown',
  object: 'object',
  never: 'never',
  any: 'unknown',
};

/** Types conteneurs Dart traduits par une règle, pas par la table. */
const CONTAINER_PREFIXES = ['List', 'Set', 'Iterable', 'Map', 'Future', 'Stream'] as const;

export type SymbolKind =
  | 'model' | 'service' | 'component' | 'screen' | 'store'
  | 'hook' | 'util' | 'config' | 'asset' | 'other';

export interface CanonicalMethod {
  name: string;
  params: Array<{ name: string; type: string }>;
  returnType: string;
}

export interface CanonicalSymbol {
  /** Nom tel qu'il apparaît dans la source (ex. `Task`, `TaskService`). */
  name: string;
  kind: SymbolKind;
  /** Fichier de sortie réel, ou `null` si le symbole n'a pas été converti. */
  outputFile: string | null;
  /** Chemin source d'origine, si connu. */
  sourceFile: string | null;
  /** Noms exportés par le fichier de sortie. */
  exportedNames: string[];
  /** Méthodes connues (services, stores). */
  methods: CanonicalMethod[];
  /** Propriétés connues (modèles). */
  properties: Array<{ name: string; type: string; nullable: boolean }>;
}

export interface SymbolTable {
  byName: Map<string, CanonicalSymbol>;
  /** Chemin de sortie indexé par chemin source normalisé. */
  bySourcePath: Map<string, string>;
  /** Tous les fichiers de sortie, chemin exact. */
  outputFiles: string[];
}

export interface UnresolvedImport {
  file: string;
  specifier: string;
  /** Ce que le spécificateur visait, quand on a pu l'identifier. */
  intendedSymbol: string | null;
}

// ── Mapping de types (seule source de vérité) ────────────────────────────────

/**
 * Traduit un type Dart en TypeScript. Idempotent : un type déjà TypeScript
 * est renvoyé tel quel. Gère les conteneurs imbriqués et la nullabilité.
 *
 * `mapDartTypeToTS('bool')`            → `'boolean'`
 * `mapDartTypeToTS('boolean')`         → `'boolean'`   (idempotent)
 * `mapDartTypeToTS('List<String>')`    → `'string[]'`
 * `mapDartTypeToTS('Map<String,int>')` → `'Record<string, number>'`
 * `mapDartTypeToTS('Future<Task?>')`   → `'Promise<Task | null>'`
 */
export function mapDartTypeToTS(raw: string): string {
  const input = (raw ?? '').trim();
  if (input.length === 0) return 'unknown';

  // Nullabilité Dart : suffixe `?`.
  let nullable = false;
  let body = input;
  if (body.endsWith('?')) {
    nullable = true;
    body = body.slice(0, -1).trim();
  }

  const mapped = mapCoreType(body);
  if (!nullable) return mapped;
  // `T[]` nullable reste un tableau : la nullabilité porte sur le tableau.
  return `(${mapped}) | null`;
}

function mapCoreType(body: string): string {
  // Conteneurs génériques.
  const generic = /^([A-Za-z_][\w]*)\s*<(.+)>$/s.exec(body);
  if (generic) {
    const name = generic[1] ?? '';
    const inner = generic[2] ?? '';
    if (CONTAINER_PREFIXES.includes(name as typeof CONTAINER_PREFIXES[number])) {
      return mapContainerType(name, inner);
    }
  }

  const direct = DART_TO_TS[body];
  if (direct !== undefined) return direct;

  // Tableau déjà TypeScript (`Task[]`).
  if (body.endsWith('[]')) return `${mapCoreType(body.slice(0, -2).trim())}[]`;

  // Union déjà TypeScript (`string | null`).
  if (body.includes('|')) {
    return body
      .split('|')
      .map((part) => {
        const p = part.trim();
        return p === 'null' || p === 'undefined' ? p : mapCoreType(p);
      })
      .join(' | ');
  }

  // Nom de classe / interface : conservé tel quel.
  return body;
}

function mapContainerType(name: string, inner: string): string {
  const splitTopLevel = (s: string): string[] => {
    const out: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of s) {
      if (ch === '<') depth++;
      else if (ch === '>') depth--;
      if (ch === ',' && depth === 0) {
        out.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    out.push(current);
    return out.map((x) => x.trim()).filter((x) => x.length > 0);
  };

  switch (name) {
    case 'List':
    case 'Set':
    case 'Iterable': {
      const parts = splitTopLevel(inner);
      return `${mapDartTypeToTS(parts[0] ?? 'unknown')}[]`;
    }
    case 'Map': {
      const parts = splitTopLevel(inner);
      return `Record<string, ${mapDartTypeToTS(parts[1] ?? 'unknown')}>`;
    }
    case 'Future':
      return `Promise<${mapDartTypeToTS(inner)}>`;
    case 'Stream':
      return `AsyncIterable<${mapDartTypeToTS(inner)}>`;
    default:
      return 'unknown';
  }
}

/** Vrai si le type est déjà un type TypeScript primitif reconnu. */
export function isTypeScriptPrimitive(type: string): boolean {
  const base = type.replace(/\?$/, '').trim();
  return ['string', 'number', 'boolean', 'unknown', 'never', 'void', 'object'].includes(base);
}

/**
 * Ramène un type à sa forme primitive nue, sans nullabilité ni union.
 * `'(boolean) | null'` → `'boolean'`, `'string | undefined'` → `'string'`.
 */
function barePrimitive(type: string): string {
  const mapped = mapDartTypeToTS(type);
  const parts = mapped.split('|').map((x) => x.trim().replace(/^\(|\)$/g, ''));
  const meaningful = parts.filter((x) => x !== 'null' && x !== 'undefined');
  const first = meaningful[0] ?? mapped;
  return meaningful.every((x) => x === first) ? first : mapped;
}

/**
 * Prédicat canonique : « ce champ est-il un booléen ? ».
 * Accepte Dart ET TypeScript, nullable ou non — c'est ce qui manquait dans
 * `code-planner`, où `f.type === 'boolean'` ne matchait jamais un `bool` Dart.
 */
export function isBooleanType(type: string): boolean {
  return barePrimitive(type) === 'boolean';
}

/** Prédicat canonique : « ce champ est-il une chaîne ? ». */
export function isStringType(type: string): boolean {
  return barePrimitive(type) === 'string';
}

/** Prédicat canonique : « ce champ est-il numérique ? ». */
export function isNumericType(type: string): boolean {
  return barePrimitive(type) === 'number';
}

// ── Chemins ──────────────────────────────────────────────────────────────────

/** Normalise un chemin : séparateurs POSIX, sans `./`, sans extension. */
export function normalizePath(p: string): string {
  let out = (p ?? '').replace(/\\/g, '/').trim();
  while (out.startsWith('./')) out = out.slice(2);
  return out;
}

/** Chemin source sans préfixe `lib/` ni extension, en minuscules : clé de lookup. */
function sourceKey(p: string): string {
  return normalizePath(p)
    .replace(/^lib\//, '')
    .replace(/\.(dart|ts|tsx|js|jsx)$/, '')
    .toLowerCase();
}

/** Nom de base sans extension. */
function baseName(p: string): string {
  const n = normalizePath(p);
  const last = n.split('/').pop() ?? n;
  return last.replace(/\.(dart|ts|tsx|js|jsx)$/, '');
}

/** `task_tile` → `TaskTile`, `taskService` → `TaskService`. */
export function toPascalCase(name: string): string {
  return name
    .replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ''))
    .replace(/^(.)/, (_, c: string) => c.toUpperCase());
}

/**
 * Chemin relatif POSIX de `fromFile` vers `toFile`, sans extension, avec la
 * casse EXACTE du fichier cible. Préfixé `./` quand nécessaire.
 */
export function relativeSpecifier(fromFile: string, toFile: string): string {
  const fromDir = normalizePath(fromFile).split('/').slice(0, -1);
  const toParts = normalizePath(toFile).replace(/\.(ts|tsx|js|jsx)$/, '').split('/');

  let i = 0;
  while (i < fromDir.length && i < toParts.length && fromDir[i] === toParts[i]) i++;

  const ups = fromDir.length - i;
  const downs = toParts.slice(i);
  const parts = [...Array.from({ length: ups }, () => '..'), ...downs];
  const spec = parts.join('/');
  return spec.startsWith('.') ? spec : `./${spec}`;
}

// ── Table de symboles ────────────────────────────────────────────────────────

/** Déduit la nature d'un symbole depuis son chemin de sortie. */
export function kindFromOutputPath(path: string): SymbolKind {
  const p = normalizePath(path).toLowerCase();
  if (/(^|\/)models?\//.test(p) || /\.types\.tsx?$/.test(p)) return 'model';
  if (/services?\//.test(p)) return 'service';
  if (/stores?\//.test(p)) return 'store';
  if (/hooks?\//.test(p)) return 'hook';
  if (/(^|\/)app\//.test(p) || /screens?\//.test(p)) return 'screen';
  if (/components?\//.test(p) || /\.tsx$/.test(p)) return 'component';
  if (/(lib|utils?)\//.test(p)) return 'util';
  if (/(theme|constants|config)/.test(p)) return 'config';
  return 'other';
}

const EXPORT_RE = [
  /export\s+(?:default\s+)?(?:abstract\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)/g,
];

/** Noms exportés par un fichier généré, lus dans son contenu réel. */
export function extractExportedNames(content: string): string[] {
  const names = new Set<string>();
  for (const re of EXPORT_RE) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const n = m[1];
      if (n) names.add(n);
    }
  }
  return [...names];
}

const METHOD_RE = /^\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*[^{;]+)?\s*[{;]/gm;

/** Méthodes d'une classe générée, avec paramètres typés canoniquement. */
export function extractMethods(content: string): CanonicalMethod[] {
  const out: CanonicalMethod[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  METHOD_RE.lastIndex = 0;
  while ((m = METHOD_RE.exec(content)) !== null) {
    const name = m[1] ?? '';
    const rawParams = m[2] ?? '';
    if (!name || /^(if|for|while|switch|catch|return|function|constructor)$/.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);

    const params = rawParams
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((p) => {
        const colon = p.indexOf(':');
        if (colon < 0) return { name: p, type: 'unknown' };
        return {
          name: p.slice(0, colon).trim().replace(/^\.\.\./, ''),
          type: mapDartTypeToTS(p.slice(colon + 1)),
        };
      });

    const retMatch = /\)\s*:\s*([^{;]+)/.exec(m[0] ?? '');
    out.push({
      name,
      params,
      returnType: retMatch?.[1] ? mapDartTypeToTS(retMatch[1]) : 'void',
    });
  }
  return out;
}

/**
 * Construit la table de symboles canonique à partir des fichiers RÉELLEMENT
 * générés. C'est la source unique de vérité pour : quel symbole vit dans quel
 * fichier, quels noms il exporte, quelles méthodes il expose, et quel
 * spécificateur d'import utiliser.
 */
export function buildSymbolTable(files: GeneratedFile[]): SymbolTable {
  const byName = new Map<string, CanonicalSymbol>();
  const bySourcePath = new Map<string, string>();
  const outputFiles: string[] = [];

  for (const file of files) {
    const path = normalizePath(file.path);
    if (path.length === 0) continue;
    outputFiles.push(path);

    if (file.fromPath) bySourcePath.set(sourceKey(file.fromPath), path);

    const exported = extractExportedNames(file.content);
    const kind = kindFromOutputPath(path);
    const stem = toPascalCase(baseName(path).replace(/\.(types|service|store|screen)$/i, ''));

    const symbol: CanonicalSymbol = {
      name: stem,
      kind,
      outputFile: path,
      sourceFile: file.fromPath ? normalizePath(file.fromPath) : null,
      exportedNames: exported,
      methods: kind === 'service' || kind === 'store' ? extractMethods(file.content) : [],
      properties: [],
    };

    // Les noms exportés priment sur le nom déduit du fichier.
    for (const n of exported) {
      if (!byName.has(n)) byName.set(n, { ...symbol, name: n });
    }
    if (!byName.has(stem)) byName.set(stem, symbol);

    // Un fichier source peut aussi être retrouvé par son propre nom.
    if (file.fromPath) {
      const srcStem = toPascalCase(baseName(file.fromPath));
      if (!byName.has(srcStem)) byName.set(srcStem, { ...symbol, name: srcStem });
    }
  }

  return { byName, bySourcePath, outputFiles };
}

/** Résout un nom de symbole (ex. `Task`, `TaskService`, `task_tile`). */
export function resolveSymbol(table: SymbolTable, name: string): CanonicalSymbol | null {
  const direct = table.byName.get(name);
  if (direct) return direct;
  const pascal = toPascalCase(name);
  return table.byName.get(pascal) ?? null;
}

/**
 * Résout un chemin source Dart (ex. `../widgets/task_tile.dart` ou
 * `lib/services/task_service.dart`) vers le fichier de sortie réel.
 * Renvoie `null` si aucune correspondance : l'appelant doit alors signaler
 * `NOT_CONVERTED` plutôt que d'émettre un import cassé.
 */
export function resolveSourcePath(table: SymbolTable, dartPath: string): string | null {
  const clean = normalizePath(dartPath).replace(/\.(dart|ts|tsx|js|jsx)$/, '');
  const exact = table.bySourcePath.get(sourceKey(clean));
  if (exact) return exact;

  // Repli sur le nom de base : `../widgets/task_tile` → `TaskTile`.
  const stem = toPascalCase(baseName(clean));
  return resolveSymbol(table, stem)?.outputFile ?? null;
}

// ── Réécriture des imports d'un fichier généré ───────────────────────────────

// La clause d'import est bornée à une seule ligne : `[\s\S]*?` traversait les
// retours à la ligne et capturait du code voisin dans les messages de diagnostic.
const LOCAL_IMPORT_RE =
  /import\s+(?:type\s+)?([^\n]*?)\s+from\s+['"](\.[^'"]*)['"]\s*;?/g;

const EXTERNAL_PACKAGES = new Set([
  'react', 'react-native', 'expo', 'expo-router', 'expo-status-bar', 'expo-constants',
  'expo-linking', 'expo-asset', 'expo-font', 'expo-splash-screen', 'react-native-screens',
  'react-native-safe-area-context', '@react-native-async-storage/async-storage',
  'zustand', 'axios', 'query-string',
]);

/**
 * Réécrit TOUS les imports locaux d'un fichier généré pour qu'ils pointent
 * vers des fichiers réellement présents, avec la casse exacte.
 *
 * C'est la correction générale du défaut « import vers `widgets/task_tile`
 * alors que le fichier généré est `src/components/TaskTile.tsx` » : au lieu
 * d'ajouter une exception par projet, tout import local est résolu contre la
 * table de symboles construite sur la sortie réelle.
 *
 * Un import non résoluble n'est JAMAIS laissé tel quel : il est commenté et
 * rapporté dans `unresolved`, pour que la validation bloquante le voie.
 */
export function rewriteLocalImports(
  file: GeneratedFile,
  table: SymbolTable,
): { content: string; unresolved: UnresolvedImport[]; rewritten: number } {
  const unresolved: UnresolvedImport[] = [];
  let rewritten = 0;

  const content = file.content.replace(
    LOCAL_IMPORT_RE,
    (whole, clause: string, specifier: string) => {
      // Résolution directe : le spécificateur vise déjà un fichier existant.
      const directTarget = resolveRelativeTarget(file.path, specifier, table);
      if (directTarget) {
        const fixed = relativeSpecifier(file.path, directTarget);
        if (fixed !== specifier) rewritten++;
        return whole.replace(specifier, fixed);
      }

      // Le spécificateur est un chemin SOURCE Dart recopié tel quel.
      const viaSource = resolveSourcePath(table, specifier);
      if (viaSource) {
        rewritten++;
        return whole.replace(specifier, relativeSpecifier(file.path, viaSource));
      }

      // Dernier recours : le nom du fichier correspond à un symbole connu.
      const stem = toPascalCase(baseName(specifier));
      const symbol = resolveSymbol(table, stem);
      if (symbol?.outputFile && symbol.outputFile !== normalizePath(file.path)) {
        rewritten++;
        return whole.replace(
          specifier,
          relativeSpecifier(file.path, symbol.outputFile),
        );
      }

      unresolved.push({
        file: normalizePath(file.path),
        specifier,
        intendedSymbol: stem || null,
      });
      const names = clause.trim().replace(/^\{|\}$/g, '').trim() || stem;
      return `// NOT_CONVERTED: import '${specifier}' — aucun fichier généré ne fournit « ${names} ».\n// À résoudre manuellement : le symbole source n'a pas été converti.`;
    },
  );

  return { content, unresolved, rewritten };
}

/** Retire l'extension de module d'un chemin. */
function stripModuleExtension(p: string): string {
  return p.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');
}

/**
 * Résout un spécificateur relatif (`./x`, `../y/z`) contre la liste RÉELLE
 * des fichiers générés. Renvoie le chemin avec la casse exacte du fichier
 * cible, ou `null`.
 *
 * La comparaison est faite SANS extension et SANS sensibilité à la casse :
 * un import écrit `../src/components/notecard` doit retrouver le fichier
 * réellement présent `src/components/NoteCard.tsx`.
 */
export function resolveRelativeTarget(
  fromFile: string,
  specifier: string,
  table: SymbolTable,
): string | null {
  const fromDir = normalizePath(fromFile).split('/').slice(0, -1);
  const stack = [...fromDir];
  for (const part of specifier.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  const candidate = stack.join('/');
  // Un import de répertoire (`./theme`) vise le barrel `index` de ce répertoire.
  const candidates = [candidate, `${candidate}/index`];
  const bare = candidates.map(stripModuleExtension);
  const wanted = bare.map((x) => x.toLowerCase());

  // Correspondance exacte (casse comprise) d'abord.
  const exact = table.outputFiles.find((f) => bare.includes(stripModuleExtension(f)));
  if (exact) return exact;

  // Puis insensible à la casse : on renvoie la casse RÉELLE du fichier.
  const loose = table.outputFiles.find(
    (f) => wanted.includes(stripModuleExtension(f).toLowerCase()),
  );
  return loose ?? null;
}

/** Vrai si le spécificateur est un paquet externe (non local). */
export function isExternalSpecifier(specifier: string): boolean {
  if (specifier.startsWith('.')) return false;
  const root = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : (specifier.split('/')[0] ?? specifier);
  return EXTERNAL_PACKAGES.has(root);
}

// ── Normalisation centrale de l'IR ───────────────────────────────────────────

/** Nombre de types réécrits, pour le rapport. */
export interface IrNormalizationResult {
  ir: IRDocument;
  changed: number;
  /** Types bruts rencontrés, pour le journal (jamais de contenu source). */
  rewritten: string[];
}

/**
 * PHASE 50 — Normalise TOUS les types de l'IR en TypeScript canonique.
 *
 * C'est le correctif du défaut « `bool` en sortie TypeScript ». Il existait
 * trois mappings Dart→TS, et surtout AUCUNE normalisation sur le chemin où
 * l'IR est produit par le modèle d'IA : les types renvoyés par le LLM
 * (`bool`, `String`, `List<Task>`) traversaient tels quels jusqu'aux
 * générateurs. Le chemin statique, lui, mappait déjà — d'où l'écart entre les
 * validations hors ligne (vertes) et les conversions réelles (cassées).
 *
 * La normalisation est appliquée à l'entrée de `CodePlanner.plan()`, donc en
 * amont de TOUS les générateurs, quelle que soit la provenance de l'IR.
 */
export function normalizeIrTypes(ir: IRDocument): IrNormalizationResult {
  const rewritten: string[] = [];
  let changed = 0;

  const fix = (type: string | undefined): string | undefined => {
    if (typeof type !== 'string' || type.length === 0) return type;
    const mapped = mapDartTypeToTS(type);
    if (mapped !== type) {
      changed++;
      rewritten.push(`${type} → ${mapped}`);
    }
    return mapped;
  };

  for (const model of ir.dataLayer?.models ?? []) {
    for (const field of model.fields ?? []) {
      const next = fix(field.type);
      if (next !== undefined) field.type = next;
    }
  }

  // Signatures de services, si l'IR en porte.
  const services = (ir.backendGraph as { services?: Array<{ methods?: Array<{
    params?: Array<{ type?: string }>; returnType?: string;
  }> }> } | undefined)?.services;
  for (const svc of services ?? []) {
    for (const method of svc.methods ?? []) {
      for (const param of method.params ?? []) {
        const next = fix(param.type);
        if (next !== undefined) param.type = next;
      }
      const ret = fix(method.returnType);
      if (ret !== undefined) method.returnType = ret;
    }
  }

  return { ir, changed, rewritten };
}

// ── PHASE 51 — comptage canonique des fichiers ───────────────────────────────

/** Préfixe des artefacts internes, qui ne font pas partie de l'application. */
export const INTERNAL_REPORT_PREFIX = '_codemorph-reports/';

/** Vrai pour un artefact interne (rapports CodeMorph), pas pour du code livré. */
export function isInternalReportFile(path: string): boolean {
  return normalizePath(path).startsWith(INTERNAL_REPORT_PREFIX);
}

export interface FileSplit {
  /** Fichiers de l'application générée — ce que contient le ZIP. */
  deliverable: GeneratedFile[];
  /** Rapports internes injectés après la création du ZIP. */
  reports:     GeneratedFile[];
}

/**
 * PHASE 51 — Sépare les fichiers livrables des rapports internes.
 *
 * ## Le défaut corrigé
 *
 * Le ZIP était construit AVANT l'injection des rapports internes, puis ces
 * rapports étaient ajoutés à la liste retournée au client. Le ZIP annonçait
 * donc 30 fichiers pendant que le callback en annonçait 34 — deux nombres
 * issus de deux étapes différentes, sans qu'aucun des deux ne le dise.
 *
 * Tous les comptes (rapport, journaux, ZIP, callback) doivent désormais être
 * dérivés de cette seule fonction.
 */
export function splitDeliverableFiles(files: GeneratedFile[]): FileSplit {
  const deliverable: GeneratedFile[] = [];
  const reports: GeneratedFile[] = [];
  for (const f of files) {
    if (isInternalReportFile(f.path)) reports.push(f);
    else deliverable.push(f);
  }
  return { deliverable, reports };
}

/**
 * Vérifie que le nombre de fichiers du ZIP correspond au nombre de fichiers
 * livrables. Une divergence signifie que le ZIP et le rapport ne décrivent pas
 * le même état — elle doit être signalée, jamais ignorée.
 */
export function reconcileFileCounts(
  zipFileCount: number,
  files: GeneratedFile[],
): { consistent: boolean; zip: number; deliverable: number; reports: number; detail: string } {
  const split = splitDeliverableFiles(files);
  const deliverable = split.deliverable.filter((f) => !!f.content).length;
  const consistent = zipFileCount === deliverable;
  return {
    consistent,
    zip: zipFileCount,
    deliverable,
    reports: split.reports.length,
    detail: consistent
      ? `ZIP ${zipFileCount} fichier(s) == livrables ${deliverable} (+${split.reports.length} rapport(s) interne(s))`
      : `INCOHÉRENCE : ZIP ${zipFileCount} fichier(s) != livrables ${deliverable} ` +
        `(+${split.reports.length} rapport(s) interne(s))`,
  };
}
