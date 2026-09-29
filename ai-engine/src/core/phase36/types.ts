// ============================================================
// CodeMorph AI Engine — PHASE 36: Types du pipeline sémantique
//
// ProjectManifest  : représentation structurée GLOBALE du projet (analyse statique, 0 token IA)
// SemanticChunk    : groupe de fichiers SÉMANTIQUEMENT liés (navigation, auth, models…)
// ModuleIR         : IR extraite pour un chunk donné
// GlobalIR         : fusion réconciliée de toutes les ModuleIR
// ============================================================

// ── Provider IA structurel minimal (AIProvider le satisfait ; fake en tests) ──
export interface SemanticAIProvider {
  chat(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    maxTokens?: number,
    dartMeta?: unknown,
    jobId?: string,
  ): Promise<{ content: string; tokensUsed: number }>;
  getModel(): string;
}

// ── Rôles sémantiques de fichiers ─────────────────────────────────────────────
export type FileSemanticRole =
  | 'navigation'
  | 'auth'
  | 'model'
  | 'service'
  | 'state'
  | 'screen'
  | 'component'
  | 'utility'
  | 'config'
  | 'backend'
  | 'test'
  | 'doc'
  | 'asset-config'
  | 'misc';

export const SEMANTIC_ROLE_ORDER: readonly FileSemanticRole[] = [
  // Ordre de conversion : d'abord ce qui est dépendu, ensuite ce qui dépend.
  'config',
  'model',
  'utility',
  'service',
  'backend',
  'state',
  'component',
  'auth',
  'screen',
  'navigation',
  'test',
  'doc',
  'asset-config',
  'misc',
];

/** Fichier tel qu'analysé statiquement (aucun appel IA). */
export interface ManifestFile {
  path: string;
  role: FileSemanticRole;
  chars: number;
  lines: number;
  classes: string[];
  functions: string[];
  imports: string[];
  exports: string[];
  /** Hash SHA-256 (tronqué) du contenu — clé du cache par module */
  contentHash: string;
}

/** Arête de dépendance entre deux fichiers du projet. */
export interface ManifestRelation {
  from: string; // fichier qui importe
  to: string;   // fichier importé (résolu dans le projet)
}

/** Groupe sémantique (catégorie de fichiers liés). */
export interface SemanticModule {
  id: string;              // ex: 'models', 'navigation', 'auth'
  role: FileSemanticRole;
  files: ManifestFile[];
  totalChars: number;
  /** Modules dont CE module dépend (ids) */
  dependsOn: string[];
  /** Modules qui dépendent de CE module (ids) */
  dependents: string[];
}

/** Chunk sémantique = unité de travail envoyée au modèle. */
export interface SemanticChunk {
  id: string;                 // ex: 'chunk-03-models-2'
  index: number;              // ordre global d'exécution (0-based)
  moduleId: string;
  role: FileSemanticRole;
  files: ManifestFile[];
  /** Contenus complets des fichiers (aucune perte — la totalité du projet est couverte) */
  filesContent: Record<string, string>;
  /** Fichiers surdimensionnés découpés logiquement → parts (path → '1/3') */
  fileParts: Record<string, string>;
  estimatedTokens: number;
  /** Dépendances sortantes résolues : fichiers requis (dans d'autres chunks) */
  externalDeps: string[];
  /** Dépendances entrantes : fichiers d'autres chunks qui dépendent de nous */
  reverseDeps: string[];
}

/** Représentation GLOBALE du projet — la source de vérité de l'analyse. */
export interface ProjectManifest {
  projectId: string;
  sourceFramework: string;
  targetFramework: string;
  totalFiles: number;
  totalChars: number;
  totalLines: number;
  files: ManifestFile[];
  /** Inventaires par rôle (path → rôle) */
  roleCounts: Record<string, number>;
  /** Relations import→fichier résolues à l'intérieur du projet */
  relations: ManifestRelation[];
  /** Modules sémantiques (groupes) */
  modules: SemanticModule[];
  /** Signals globaux détectés par l'AST (state mgmt, navigation, auth…) */
  statePatterns: string[];
  navigationPattern: string;
  authPatterns: string[];
  storagePatterns: string[];
  apiPatterns: string[];
  externalServices: string[];
  envVarKeys: string[];
  dependencies: string[];
}

// ── ModuleIR — résultat d'analyse d'un chunk ──────────────────────────────────

export interface IRScreenEntry {
  id: string;
  name: string;
  path: string;
  route: string;
  components: string[];
  purpose: string;
  businessLogic: string[];
  apiCalls: string[];
  states: string[];
}

export interface IRComponentEntry {
  id: string;
  name: string;
  type: string;
  path: string;
  props: Array<{ name: string; type: string; required: boolean }>;
  children: string[];
}

export interface IRNavEdge {
  from: string;
  to: string;
  trigger: string;
  guard: string;
}

export interface IRStateEntry {
  store: string;
  path: string;
  type: string;
  stateShape: string;
  actions: string[];
}

export interface IRRouteEntry {
  method: string;
  path: string;
  handler: string;
  guards: string[];
  middlewares: string[];
}

export interface IRServiceEntry {
  name: string;
  path: string;
  methods: Array<{ name: string; params: string[]; returnType: string; async: boolean }>;
  dependencies: string[];
}

export interface IRModelEntry {
  name: string;
  path: string;
  table: string;
  fields: Array<{ name: string; type: string; nullable: boolean; unique: boolean; primary: boolean }>;
  relations: Array<{ target: string; type: string; field: string }>;
}

export interface IRApiCallEntry {
  method: string;
  url: string;
  usedBy: string;   // screen/service qui effectue l'appel
}

export interface ModuleIR {
  chunkId: string;
  moduleId: string;
  role: FileSemanticRole;
  /** Fichiers couverts par cette analyse */
  files: string[];
  contentHashes: string[];
  screens: IRScreenEntry[];
  components: IRComponentEntry[];
  navigationFlow: IRNavEdge[];
  stateFlow: IRStateEntry[];
  routes: IRRouteEntry[];
  services: IRServiceEntry[];
  models: IRModelEntry[];
  apiCalls: IRApiCallEntry[];
  envVars: string[];
  /** Relations observées entre entités de CE module (screen→service, service→model…) */
  relations: Array<{ from: string; to: string; kind: string }>;
  /** Notes libres pour la passe de cohérence */
  notes: string[];
  tokensUsed: number;
  cacheHit: boolean;
  durationMs: number;
}

// ── Rapport de fusion ──────────────────────────────────────────────────────────

export interface MergeReport {
  modulesMerged: number;
  duplicatesRemoved: number;
  conflictsResolved: string[];
  screens: number;
  components: number;
  navigationFlow: number;
  stateFlow: number;
  routes: number;
  services: number;
  models: number;
  apiCalls: number;
  relations: number;
  status: 'success' | 'partial' | 'failed';
}

/** Fusion réconciliée de toutes les ModuleIR — source de vérité du projet converti. */
export interface GlobalIR {
  screens: IRScreenEntry[];
  components: IRComponentEntry[];
  navigationFlow: IRNavEdge[];
  stateFlow: IRStateEntry[];
  routes: IRRouteEntry[];
  services: IRServiceEntry[];
  models: IRModelEntry[];
  apiCalls: IRApiCallEntry[];
  envVars: string[];
  relations: Array<{ from: string; to: string; kind: string }>;
  moduleProvenance: Record<string, string[]>; // entité → chunks qui la déclarent
}

// ── Cohérence ──────────────────────────────────────────────────────────────────

export type CoherenceIssueKind =
  | 'nav-unknown-target'
  | 'nav-unknown-source'
  | 'screen-missing-component'
  | 'missing-service-ref'
  | 'missing-model-ref'
  | 'route-without-screen'
  | 'duplicate-entity'
  | 'empty-analysis'
  | 'env-undeclared';

export interface CoherenceIssue {
  kind: CoherenceIssueKind;
  severity: 'critical' | 'warning';
  entity: string;
  detail: string;
  autoFixable: boolean;
}

export interface CoherenceReport {
  issues: CoherenceIssue[];
  criticalCount: number;
  warningCount: number;
  fixedCount: number;
  checkedAt: string;
}

// ── État de reprise (resume) ───────────────────────────────────────────────────

export type ChunkStatus = 'pending' | 'running' | 'done' | 'failed';

export interface ChunkStateEntry {
  chunkId: string;
  status: ChunkStatus;
  attempts: number;
  moduleIR?: ModuleIR | undefined;
  error?: string | undefined;
  updatedAt: string;
}

export interface PipelineRunState {
  projectId: string;
  sourceHash: string;
  totalChunks: number;
  chunks: Record<string, ChunkStateEntry>;
  startedAt: string;
  updatedAt: string;
}
