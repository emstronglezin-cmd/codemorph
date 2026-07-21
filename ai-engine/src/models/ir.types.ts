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
