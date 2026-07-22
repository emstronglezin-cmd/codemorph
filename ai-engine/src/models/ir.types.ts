// ============================================================
// CodeMorph AI Engine — IR Types (format industriel)
// ============================================================

export interface IRDocument {
  projectMeta:        IRProjectMeta;
  architecture:       IRArchitecture;
  uiGraph:            IRUIGraph;
  backendGraph:       IRBackendGraph;
  dataLayer:          IRDataLayer;
  dependencyMap:      IRDependencyMap;
  conversionPlan:     IRConversionStep[];
  validation:         IRValidation;
  // ── PHASE 22: Prompt Maître V2 — enrichissement IR ──────
  assets?:            IRAssets;
  permissions?:       IRPermissions;
  envVars?:           IREnvVar[];
  externalConnections?: IRExternalConnection[];
  // ── PHASE 23: Prompt Architecte Ultime V3 ───────────────
  knowledgeGraph?:    IRKnowledgeGraph;   // Phase 3 — graphe global des artefacts
  designTokens?:      IRDesignTokens;     // Phase 6 — fidélité visuelle
}

export interface IRProjectMeta {
  name:           string;
  type:           'web' | 'mobile' | 'backend' | 'fullstack' | 'library';
  sourceStack:    string;
  targetStack:    string;
  complexityScore: number;          // 0-100
  description?:   string;
  version?:       string;
  sourceFiles:    number;
  totalLines:     number;
  detectedFrameworks: string[];
}

export interface IRArchitecture {
  modules:  IRModule[];
  layers:   string[];
  patterns: string[];
}

export interface IRModule {
  name:         string;
  path:         string;
  type:         'feature' | 'shared' | 'core' | 'infra' | 'ui';
  dependencies: string[];
  exports:      string[];
  complexity:   number;
}

export interface IRUIGraph {
  screens:       IRScreen[];
  components:    IRComponent[];
  navigationFlow: IRNavFlow[];
  stateFlow:     IRStateFlow[];
}

export interface IRScreen {
  id:           string;
  name:         string;
  path:         string;
  route?:       string;
  components:   string[];
  guards?:      string[];
  params?:      Record<string, string>;
  // ── PHASE 22: Prompt Maître V2 — compréhension métier ──
  purpose?:     string;             // objectif métier de l'écran
  businessRole?: string;            // rôle fonctionnel dans l'app
  dataFields?:  string[];           // données affichées / manipulées
  businessLogic?: string[];         // règles métier identifiées
  states?:      string[];           // états UI (loading, error, empty, success…)
  userEvents?:  string[];           // événements utilisateur (onTap, onChange…)
  apiCalls?:    string[];           // appels API identifiés
  validations?: string[];           // règles de validation du formulaire
  errors?:      string[];           // cas d'erreurs gérés
}

export interface IRComponent {
  id:       string;
  name:     string;
  type:     'page' | 'layout' | 'feature' | 'ui' | 'shared' | 'widget';
  props?:   IRProp[];
  state?:   IRStateSlice[];
  children?: string[];
  styling?: string[];
}

export interface IRProp {
  name:     string;
  type:     string;
  required: boolean;
  default?: string;
}

export interface IRStateSlice {
  name:    string;
  type:    string;
  initial: string;
}

export interface IRNavFlow {
  from:    string;
  to:      string;
  trigger: string;
  guard?:  string;
  params?: Record<string, string>;
}

export interface IRStateFlow {
  store:     string;
  actions:   string[];
  selectors: string[];
  effects?:  string[];
}

export interface IRBackendGraph {
  routes:      IRRoute[];
  services:    IRService[];
  entities:    IREntity[];
  middlewares: IRMiddleware[];
}

export interface IRRoute {
  method:      'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path:        string;
  handler:     string;
  guards?:     string[];
  middlewares?: string[];
  body?:       string;
  response?:   string;
}

export interface IRService {
  name:         string;
  methods:      IRMethod[];
  dependencies: string[];
  injectable?:  boolean;
}

export interface IRMethod {
  name:       string;
  params:     IRParam[];
  returnType: string;
  async:      boolean;
}

export interface IRParam {
  name: string;
  type: string;
}

export interface IREntity {
  name:       string;
  table?:     string;
  fields:     IRField[];
  relations?: IRRelation[];
  indexes?:   string[];
}

export interface IRField {
  name:      string;
  type:      string;
  nullable?: boolean;
  unique?:   boolean;
  default?:  string;
  primary?:  boolean;
}

export interface IRRelation {
  type:   'oneToOne' | 'oneToMany' | 'manyToMany' | 'manyToOne';
  target: string;
  field:  string;
  eager?: boolean;
}

export interface IRMiddleware {
  name:  string;
  scope: 'global' | 'module' | 'route';
  type:  'auth' | 'logging' | 'validation' | 'rate-limit' | 'cors' | 'custom';
}

export interface IRDataLayer {
  models:        IREntity[];
  relationships: IRRelation[];
  migrations:    IRMigration[];
}

export interface IRMigration {
  name:        string;
  description: string;
  order:       number;
  sql?:        string;
}

export interface IRDependencyMap {
  keep:    string[];
  replace: IRReplacement[];
  remove:  string[];
  add:     string[];
}

export interface IRReplacement {
  from:   string;
  to:     string;
  reason: string;
}

export interface IRConversionStep {
  step:            number;
  phase:           'parse' | 'analyze' | 'map' | 'generate' | 'validate';
  action:          string;
  target:          string;
  details?:        string;
  estimatedTime?:  string;
  dependencies?:   number[];
}

export interface IRValidation {
  buildable:     boolean;
  testsRequired: boolean;
  riskLevel:     'low' | 'medium' | 'high' | 'critical';
  warnings?:     string[];
  blockers?:     string[];
  coverage?:     number;
  // ── PHASE 22: Prompt Maître V2 — métriques source vs généré ──
  sourceMetrics?: IRSourceMetrics;
}

// ── PHASE 22: Métriques de fidélité source vs généré ────────────────────────
export interface IRSourceMetrics {
  screensCount:   number;
  modelsCount:    number;
  servicesCount:  number;
  endpointsCount: number;
  storesCount:    number;
  assetsCount:    number;
  featuresDetected: string[];
}

// ── PHASE 22: Enrichissement IR — assets, permissions, env, connexions ──────

export interface IRAssets {
  images:  IRAsset[];
  icons:   IRAsset[];
  fonts:   IRAsset[];
  other:   IRAsset[];
}

export interface IRAsset {
  name:    string;
  path:    string;
  type:    string;
  usedIn?: string[];
}

export interface IRPermissions {
  android?: string[];
  ios?:     string[];
  web?:     string[];
}

export interface IREnvVar {
  key:          string;
  description:  string;
  required:     boolean;
  defaultValue?: string;
  example?:     string;
}

export interface IRExternalConnection {
  name:     string;
  type:     'rest-api' | 'graphql' | 'websocket' | 'grpc' | 'firebase' | 'supabase' | 'appwrite' | 'database' | 'storage' | 'auth' | 'push-notification' | 'analytics' | 'other';
  url?:     string;
  authType?: 'bearer' | 'api-key' | 'oauth2' | 'none';
  methods?: string[];
}

// ── Conversion context passed through pipeline ──────────
export interface ConversionContext {
  jobId:          string;
  projectId:      string;
  sourceCode:     string;
  sourceLanguage: string;
  sourceFramework: string;
  targetFramework: string;
  userGoal?:      string;
  options:        ConversionOptions;
}

export interface ConversionOptions {
  preserveComments:  boolean;
  generateTests:     boolean;
  strictMode:        boolean;
  addTypeAnnotations: boolean;
  targetFramework?:  string;
}

export interface ConversionResult {
  jobId:       string;
  ir:          IRDocument;
  files:       GeneratedFile[];
  summary:     ConversionSummary;
  tokensUsed:  number;
  durationMs:  number;
  // FIX PHASE 20 — Exposer le tier et modèle IA utilisés pour affichage côté frontend
  aiTier?:    string;
  aiModel?:   string;
  // ── PHASE 23: Score de fidélité multi-axes + rapport auto-correction ─────
  fidelityScore?:        IRFidelityScore;
  autoCorrectionReport?: IRAutoCorrectReport;
}

export interface GeneratedFile {
  path:        string;
  content:     string;
  language:    string;
  fromPath?:   string;
  warnings?:   string[];
}

export interface ConversionSummary {
  totalFiles:      number;
  successfulFiles: number;
  failedFiles:     number;
  totalLines:      number;
  convertedLines:  number;
  skippedFiles:    string[];
}

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  PHASE 23 — Prompt Architecte Ultime V3                                    ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

// ── Phase 3 : Knowledge Graph ─────────────────────────────────────────────────
// Graphe liant tous les artefacts de l'application :
//   Écrans ↔ Navigation ↔ Stores ↔ Services ↔ Repositories ↔ API ↔ Modèles
//   ↔ Assets ↔ EnvVars ↔ Connexions externes ↔ Règles métier

export interface IRKnowledgeGraph {
  nodes:    IRKnowledgeNode[];
  edges:    IRKnowledgeEdge[];
  metadata: IRKnowledgeGraphMeta;
}

export interface IRKnowledgeGraphMeta {
  totalNodes:      number;
  totalEdges:      number;
  buildTimestamp:  string;  // ISO 8601
  version:         string;  // ex. "3.0"
}

export type IRKnowledgeNodeType =
  | 'screen'
  | 'store'
  | 'service'
  | 'repository'
  | 'model'
  | 'api-endpoint'
  | 'asset'
  | 'env-var'
  | 'external-connection'
  | 'business-rule'
  | 'navigation'
  | 'component'
  | 'middleware'
  | 'config';

export interface IRKnowledgeNode {
  id:        string;                  // identifiant unique stable (slug)
  type:      IRKnowledgeNodeType;
  name:      string;
  path?:     string;                  // chemin de fichier source (si applicable)
  metadata?: Record<string, unknown>; // données contextuelles libres
}

export type IRKnowledgeEdgeRelation =
  | 'navigates-to'      // écran → écran
  | 'uses-store'        // écran/composant → store
  | 'calls-service'     // écran/store → service
  | 'calls-api'         // service → api-endpoint
  | 'uses-model'        // service/store → model
  | 'uses-asset'        // écran/composant → asset
  | 'requires-env'      // service/config → env-var
  | 'connects-to'       // service → external-connection
  | 'enforces-rule'     // écran/service → business-rule
  | 'depends-on'        // générique : dépendance module
  | 'guarded-by'        // route → middleware/guard
  | 'persisted-by'      // model → repository
  | 'provided-by';      // store/service → provider/injection

export interface IRKnowledgeEdge {
  from:      string;                    // IRKnowledgeNode.id source
  to:        string;                    // IRKnowledgeNode.id cible
  relation:  IRKnowledgeEdgeRelation;
  weight?:   number;                    // 0-1 — fréquence / importance
  metadata?: Record<string, unknown>;
}

// ── Phase 6 : Design Tokens (fidélité visuelle) ───────────────────────────────

export interface IRDesignTokens {
  colors:     IRColorToken[];
  typography: IRTypographyToken[];
  spacing:    IRSpacingToken[];
  borderRadius?: IRBorderRadiusToken[];
  shadows?:   IRShadowToken[];
  animations?: IRAnimationToken[];
  // Palette nommée extraite de l'app source (ex. primary, secondary, error…)
  palette?:   Record<string, string>;
}

export interface IRColorToken {
  name:   string;    // ex. "primary", "background", "textPrimary"
  value:  string;    // ex. "#1A73E8" ou "rgba(0,0,0,0.87)"
  dark?:  string;    // valeur en dark mode si détectée
  usedIn?: string[]; // nœuds Knowledge Graph qui utilisent ce token
}

export interface IRTypographyToken {
  name:       string;   // ex. "heading1", "bodyMedium", "caption"
  fontFamily?: string;  // ex. "Roboto", "SF Pro Display"
  fontSize?:  number;   // en sp/dp/px logiques
  fontWeight?: number | string; // ex. 700 | "bold"
  lineHeight?: number;
  letterSpacing?: number;
}

export interface IRSpacingToken {
  name:  string;   // ex. "xs", "sm", "md", "lg", "xl"
  value: number;   // en unités logiques (dp/px)
}

export interface IRBorderRadiusToken {
  name:  string;   // ex. "card", "button", "chip"
  value: number;
}

export interface IRShadowToken {
  name:      string;   // ex. "cardElevation", "fabShadow"
  elevation?: number;  // Android elevation
  cssValue?:  string;  // ex. "0 2px 8px rgba(0,0,0,0.2)"
}

export interface IRAnimationToken {
  name:     string;   // ex. "pageTransition", "fadeIn"
  duration: number;   // ms
  curve?:   string;   // ex. "easeInOut", "spring"
}

// ── Phase 7 : Score de fidélité multi-axes ────────────────────────────────────

export interface IRFidelityScore {
  // Axes de mesure (0-100 chacun)
  businessLogic: number;  // couverture règles métier
  navigation:    number;  // routes / transitions conservées
  api:           number;  // endpoints + méthodes HTTP conservés
  stores:        number;  // stores/state conservés
  components:    number;  // composants UI conservés
  models:        number;  // modèles de données conservés
  uiFidelity:    number;  // fidélité visuelle (tokens + layout)
  overall:       number;  // moyenne pondérée — indicateur principal
  // Détail par axe
  details:       IRFidelityDetail[];
}

export interface IRFidelityDetail {
  axis:           string;   // nom de l'axe (ex. "navigation")
  score:          number;   // 0-100
  sourceCount:    number;   // nombre d'éléments dans la source
  generatedCount: number;   // nombre d'éléments générés
  losses:         string[]; // éléments manquants ou dégradés (noms/ids)
  notes?:         string;   // commentaire libre
}

// ── Phase 8 : Rapport auto-correction ────────────────────────────────────────

export interface IRAutoCorrectReport {
  iterations:       number;   // nombre d'itérations effectuées
  maxIterations:    number;   // limite configurée (ex. 3)
  initialScore:     number;   // overall score avant correction
  finalScore:       number;   // overall score après dernière itération
  scoreHistory:     IRScoreSnapshot[];  // évolution du score
  improvements:     string[];           // éléments corrigés avec succès
  remainingLosses:  string[];           // éléments toujours manquants
  completedAt:      string;             // ISO 8601
}

export interface IRScoreSnapshot {
  iteration: number;
  score:     number;   // overall à cette itération
  delta:     number;   // gain vs itération précédente
  filesRegenerated: number;
}
