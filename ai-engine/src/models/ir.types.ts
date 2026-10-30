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
  /**
   * Résumé structurel généré AVANT la troncature du sourceCode.
   * Garantit que screens/services/stores/models sont transmis à l'IR generator
   * même si le sourceCode est tronqué pour respecter les limites de tokens.
   * Format :  "STRUCTURAL_SUMMARY:\n screens=N, services=M, ..."
   */
  structuralSummary?: string | undefined;
  /**
   * URL de progression — si fourni, le pipeline envoie des mises à jour HTTP POST
   * pendant la conversion (phase actuelle, fichiers X/Y, appels AI, durée, etc.)
   * Format : POST { jobId, phase, filesDone, filesTotal, aiCalls, elapsedMs, message }
   */
  progressUrl?: string | undefined;
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
  // ── PHASE 2.5 (NOUVEAU): ApplicationSpec — source de vérité ──────────────
  applicationSpec?:      ApplicationSpec;
  // ── PHASE 6 (NOUVEAU): Content Validation — SHELL detection ──────────────
  contentValidation?:    ContentValidationReport;
  // ── PHASE 12 (NOUVEAU): Delivery Check — READY / NEEDS_REPAIR ────────────
  deliveryCheck?:        DeliveryCheckResult;
  // ── PHASE 48 : la validation réellement exécutée est exposée au client ─────
  fidelityValidation?:   FidelityValidationSummary;
  validationChecks?:     ValidationCheckResult[];
  validationDurationMs?: number;
  // ── PHASE 44 : rapport d'intégrité structurelle (déterministe, sans IA) ──
  integrityReport?:      ProjectIntegrityReport;
  // ── PHASE 8 fonctionnelle (NOUVEAU): Résultats des tests fonctionnels ─────
  testResults?:          TestResultsReport;
  // ── PHASE FINALE: Compilation, ZIP, Rapport ──────────────────────────────
  compilationResult?: {
    success:          boolean;
    errorsCount:      number;
    warningsCount:    number;
    filesFixed:       number;
    dartAvailable:    boolean;
    flutterAvailable: boolean;
    duration:         number;
  };
  zipResult?: {
    success:    boolean;
    zipPath:    string;
    fileCount:  number;
    totalBytes: number;
    duration:   number;
    error?:     string | undefined;
  };
  conversionReport?: {
    text:     string;
    json:     string;
    markdown: string;
    html:     string;
  };
  // ── PHASE 36: Pipeline sémantique (gros projets, free tier) — rapport ─────
  phase36Report?: Phase36ReportSummary;
}

/** Résumé observable du pipeline sémantique Phase 36 (joint au callback backend). */
export interface Phase36ReportSummary {
  used:           boolean;
  chunkCount:     number;
  resumedChunks:  number;
  cacheHits:      number;
  cacheMisses:    number;
  tokensUsed:     number;
  mergeStatus:    string;
  duplicatesRemoved: number;
  coherenceIssues: number;
  coherenceCritical: number;
  coherenceFixed: number;
  durationMs:     number;
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
  // Axes de mesure (0-100 chacun, ou null si N/A) — PHASE 27: 10 axes + N/A support
  businessLogic: number | null;  // null = N/A (absent du projet source)
  navigation:    number | null;
  api:           number | null;
  repositories:  number | null;  // axe ajouté pour cohérence avec layer-detector
  services:      number | null;
  stores:        number | null;
  components:    number | null;
  models:        number | null;
  uiFidelity:    number | null;
  // ── PHASE 27: axes supplémentaires ────────────────────────
  dataLayer:     number | null;  // couverture couche données (entités, migrations, relations)
  assets:        number | null;  // assets recréés (images, fonts, icons)
  functional:    number | null;  // fonctionnalités testables (auth, navigation, formulaires)
  overall:       number;         // moyenne pondérée — calculée UNIQUEMENT sur axes applicables
  // Metadata
  applicableAxes:   string[];    // axes avec score réel (SOURCE_PRESENT = true)
  naAxes:           string[];    // axes N/A (SOURCE_PRESENT = false)
  detectedFramework?: string | undefined;
  stateManagements?:  string[] | undefined;
  // Détail par axe
  details:       IRFidelityDetail[];
}

export interface IRFidelityDetail {
  axis:           string;   // nom de l'axe (ex. "navigation")
  score:          number | null;  // 0-100, ou null si N/A
  sourceCount:    number;   // nombre d'éléments dans la source
  generatedCount: number;   // nombre d'éléments générés
  losses:         string[]; // éléments manquants ou dégradés (noms/ids)
  notes?:         string | undefined;   // commentaire libre
  // ── N/A support ─────────────────────────────────────────────
  sourcePresent:  boolean;  // true = couche présente dans source, false = N/A
  applicable:     boolean;  // true = score calculé, false = N/A (exclu du dénominateur)
  status:         'applicable' | 'na' | 'partial' | 'missing';
  // ── Pipeline trace ───────────────────────────────────────────
  pipelineTrace?: {
    sourceCount:    number;   // éléments détectés dans source
    astCount:       number;   // éléments détectés par AST
    irCount:        number;   // éléments dans l'IR
    plannedCount:   number;   // éléments planifiés
    generatedCount: number;   // fichiers générés
    validatedCount: number;   // fichiers validés (imports OK)
  } | undefined;
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

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  APPLICATION SPEC — Source of truth for faithful reconstruction             ║
// ║  Built in Phase 1-3 BEFORE any file generation                              ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

export interface ApplicationSpec {
  // ── App metadata ────────────────────────────────────────
  app: {
    name:        string;
    version?:    string;
    platform:    'mobile' | 'web' | 'desktop' | 'backend';
    architecture: string;       // e.g. "Feature-based + Clean Architecture"
    sourceFramework: string;
    targetFramework: string;
  };

  // ── Navigation ──────────────────────────────────────────
  navigation: {
    pattern:    string;         // "GoRouter ShellRoute" / "expo-router Stack" etc.
    routes:     AppSpecRoute[];
    guards:     string[];       // auth guards, redirects
    deepLinks?: string[];
  };

  // ── Screens (UI) ───────────────────────────────────────
  screens: AppSpecScreen[];

  // ── Components ──────────────────────────────────────────
  components: AppSpecComponent[];

  // ── Data models ─────────────────────────────────────────
  models: AppSpecModel[];

  // ── API layer ───────────────────────────────────────────
  api: {
    baseUrl:    string;         // real URL extracted from source
    authType:   string;         // "Bearer JWT" / "API-Key" etc.
    headers:    Record<string, string>;
    endpoints:  AppSpecEndpoint[];
  };

  // ── Services ────────────────────────────────────────────
  services: AppSpecService[];

  // ── State management ────────────────────────────────────
  state: AppSpecStore[];

  // ── Authentication ──────────────────────────────────────
  auth: {
    type:              string;  // "OTP+Phone" / "email+password" / "OAuth2" etc.
    loginFlow:         string[];
    logoutFlow:        string[];
    tokenStorage:      string;  // "SecureStorage" / "AsyncStorage" etc.
    sessionPersistence: boolean;
    guards:            string[];
  };

  // ── External services ───────────────────────────────────
  externalServices: AppSpecExternalService[];

  // ── Configuration (NO secrets printed) ─────────────────
  config: {
    envVars: AppSpecEnvVar[];   // key + description + required (value NEVER printed)
    buildConfig: Record<string, string>;
    featureFlags: Record<string, boolean>;
  };

  // ── Assets ──────────────────────────────────────────────
  assets: {
    images: string[];
    icons:  string[];
    fonts:  string[];
    theme: {
      colors:     Record<string, string>;   // real hex values from source
      typography: Record<string, unknown>;
      spacing:    Record<string, number>;
    };
  };

  // ── Permissions ─────────────────────────────────────────
  permissions: {
    android?: string[];
    ios?:     string[];
  };

  // ── Critical info that must NOT be replaced by placeholders ─
  criticalValues: {
    key:         string;   // e.g. "API_BASE_URL"
    value:       string;   // real value from source
    source:      string;   // e.g. "lib/services/api_service.dart:12"
    isSecret:    boolean;  // if true, value is masked in reports
  }[];

  // ── Missing information (must be reported) ──────────────
  missingInfo: {
    key:         string;
    description: string;
    impact:      'critical' | 'high' | 'medium' | 'low';
  }[];
}

export interface AppSpecRoute {
  path:       string;
  screen:     string;
  params?:    Record<string, string>;
  guard?:     string;
  isShell?:   boolean;   // ShellRoute / bottom nav tab
  children?:  AppSpecRoute[];
}

export interface AppSpecScreen {
  name:        string;
  sourcePath:  string;
  route:       string;
  purpose:     string;         // business purpose
  components:  string[];       // components used
  stores:      string[];       // stores/providers consumed
  apiCalls:    string[];       // API calls made
  states:      string[];       // loading/error/empty/success states
  userEvents:  string[];       // button presses, form submits etc.
  validations: string[];       // form validation rules
  specialFeatures: string[];   // GPS, camera, scanner etc.
}

export interface AppSpecComponent {
  name:       string;
  sourcePath: string;
  type:       'shared' | 'feature' | 'layout';
  props:      { name: string; type: string; required: boolean }[];
  description: string;
}

export interface AppSpecModel {
  name:       string;
  sourcePath: string;
  fields: {
    name:     string;
    type:     string;
    nullable: boolean;
    example?: string;
  }[];
  enums?: Record<string, string[]>;
  relationships?: string[];
}

export interface AppSpecEndpoint {
  name:        string;
  method:      'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path:        string;         // relative path e.g. "/auth/initiate"
  fullUrl?:    string;         // base_url + path
  auth:        boolean;
  requestBody?: Record<string, string>;
  queryParams?: Record<string, string>;
  responseType: string;        // e.g. "AuthResponse" / "TripModel[]"
  errorCodes?:  string[];
  usedBy:      string[];       // screens/stores that use this endpoint
}

export interface AppSpecService {
  name:         string;
  sourcePath:   string;
  responsibility: string;
  methods: {
    name:       string;
    params:     string[];
    returns:    string;
    isAsync:    boolean;
  }[];
  dependencies: string[];
}

export interface AppSpecStore {
  name:         string;
  sourcePath:   string;
  stateType:    string;        // state shape
  initialState: Record<string, unknown>;
  actions:      string[];
  selectors:    string[];
  persistence:  boolean;
  effects?:     string[];      // side effects (timers, subscriptions)
}

export interface AppSpecExternalService {
  name:         string;
  type:         'firebase' | 'supabase' | 'rest-api' | 'websocket' | 'sms' | 'push' | 'payment' | 'analytics' | 'other';
  configKeys:   string[];      // config keys needed (values masked if secret)
  description:  string;
  usedFor:      string[];
}

export interface AppSpecEnvVar {
  key:          string;
  description:  string;
  required:     boolean;
  example?:     string;        // safe example value (NOT the real secret)
  foundInSource: boolean;      // true = found in source code
  sourceLocation?: string;     // file:line where it was found
}

// ── Content Validation (Phase 6 — SHELL file detection) ──────────────────────

export type FileContentStatus =
  | 'converted'    // file has real target-language content
  | 'shell_401'    // AI call failed (HTTP 401), contains only source in comment
  | 'incomplete'   // partial conversion with TODOs/placeholders
  | 'empty'        // empty file
  | 'scaffold'     // valid scaffold (intentionally minimal, e.g. config files)
  | 'source_residual'; // contains imports from source language

export interface FileContentValidation {
  path:            string;
  status:          FileContentStatus;
  language:        string;
  linesTotal:      number;
  linesCode:       number;     // actual code lines (non-comment, non-blank)
  todosCount:      number;
  placeholdersCount: number;
  sourceImports:   string[];   // e.g. ["import 'package:flutter/material.dart'"]
  shellMarkers:    string[];   // "Error: 401", "CONVERSION INCOMPLETE" etc.
  isValid:         boolean;    // true only if status === 'converted' || 'scaffold'
  score:           number;     // 0-100 content quality score
}

export interface ContentValidationReport {
  totalFiles:       number;
  convertedFiles:   number;    // status === 'converted'
  shellFiles:       number;    // status === 'shell_401'
  incompleteFiles:  number;    // status === 'incomplete'
  emptyFiles:       number;    // status === 'empty'
  scaffoldFiles:    number;    // status === 'scaffold'
  sourceResidual:   number;    // status === 'source_residual'
  totalTodos:       number;
  totalPlaceholders: number;
  totalSourceImports: number;
  conversionRate:   number;    // convertedFiles / totalFiles * 100
  files:            FileContentValidation[];
}

// ── Static Validation (Phase 7) ──────────────────────────────────────────────

// ── PHASE 47 : résultat PAR CONTRÔLE, réellement exécuté ──────────────────────
// Une vérification non exécutée n'est JAMAIS une réussite : elle vaut NOT_RUN.

export type ValidationCheckStatus = 'PASS' | 'FAIL' | 'NOT_RUN';

export type ValidationCheckId =
  | 'local-imports'      // résolution des imports locaux
  | 'dependencies'       // modules/dépendances déclarés
  | 'typescript'         // tsc --noEmit (cibles TypeScript)
  | 'config-entrypoint'  // fichiers de configuration + point d'entrée
  | 'routes'             // routes générées vs écrans présents
  | 'source-imports'     // imports du langage source résiduels
  | 'empty-files'        // fichiers sources vides
  | 'tests'              // tests disponibles du projet généré
  | 'build'              // compilation / export du projet
  | 'source-entities'    // modèles/services/écrans/composants source survivants
  // PHASE 50
  | 'service-contract'   // méthodes appelées par les écrans existent sur les services
  // PHASE 51
  | 'syntax';            // syntaxe TS/TSX de chaque fichier généré

/**
 * PHASE 48 — entités extraites de la source, utilisées pour vérifier qu'elles
 * survivent réellement dans le projet généré. Réutilise `SourceAnalysis`.
 */
export interface SourceEntities {
  models:   string[];
  services: string[];
  screens:  string[];
  widgets:  string[];
}

export interface ValidationCheckResult {
  id:          ValidationCheckId;
  status:      ValidationCheckStatus;
  /** Durée réelle d'exécution en ms (0 pour NOT_RUN). */
  durationMs:  number;
  errors:      string[];
  warnings:    string[];
  /** Fichiers concernés (chemins uniquement, jamais de contenu). */
  files:       string[];
  /** Pourquoi le contrôle n'a pas été exécuté (uniquement si NOT_RUN). */
  notRunReason?: string;
  detail?:     string;
}

export interface StaticValidationResult {
  /**
   * PHASE 47 — résultats par contrôle. Présent dès que la validation a tourné.
   * Optionnel pour ne casser aucun appelant existant.
   */
  checks?: ValidationCheckResult[];
  /** Durée totale réelle de la validation post-génération, en ms. */
  validationDurationMs?: number;
  tsCompilation: {
    attempted:  boolean;
    success:    boolean;
    errors:     string[];
    warnings:   string[];
    /**
     * PHASE 45 — Modules externes (react-native, expo…) impossibles à résoudre
     * parce que les dépendances du projet GÉNÉRÉ ne sont pas installées dans le
     * répertoire temporaire de validation. Ces erreurs ne sont PAS comptées
     * comme des échecs : elles sont déclarées « non vérifiables ».
     * `undefined` signifie que le champ n'a pas été renseigné (ancien appelant).
     */
    unverifiableModules?: string[];
  };
  brokenImports: string[];       // import paths that resolve to nothing
  sourceImports: string[];       // imports from source language (Dart, Swift etc.)
  emptyFiles:    string[];       // files with no real content
  criticalTodos: string[];       // TODOs that block functionality
  undefinedRefs: string[];       // calls to undefined functions/variables
  missingRoutes: string[];       // routes referenced but not defined
  overallPassed: boolean;
}

// ── Delivery Status (Phase 12) ────────────────────────────────────────────────

export type DeliveryStatus = 'READY' | 'NEEDS_REPAIR';

// ── PHASE 44 : Project Integrity (validation structurelle déterministe) ───────
// Défini ICI (et non dans project-integrity-validator.ts) pour éviter un cycle
// d'imports : le validateur importe déjà GeneratedFile depuis ce module.

export type IntegritySeverity = 'error' | 'warning' | 'info';

export type IntegrityIssueCode =
  | 'unresolved-local-import'
  | 'missing-dependency'
  | 'undeclared-symbol'
  | 'model-property-mismatch'
  | 'missing-route-target'
  | 'duplicate-file'
  | 'conflicting-file'
  | 'missing-config'
  | 'missing-entrypoint'
  | 'invalid-config-json'
  | 'empty-source-file'
  // PHASE 45
  | 'wrong-entry-route'
  | 'form-not-wired'
  // PHASE 48
  | 'missing-layout-screen'
  // PHASE 50
  /** Un écran appelle une méthode que le service ne définit pas. */
  | 'missing-service-method'
  /** Méthode appelée avec un nombre d'arguments incompatible. */
  | 'service-arity-mismatch'
  /** Un symbole source n'a pas été converti (marqué NOT_CONVERTED). */
  | 'unconverted-symbol';

export interface IntegrityIssue {
  code:     IntegrityIssueCode;
  severity: IntegritySeverity;
  file?:    string;
  message:  string;
  /** Valeur brute en cause (import, paquet, symbole…) — jamais de code source. */
  detail?:  string;
}

export interface ProjectIntegrityReport {
  issues:        IntegrityIssue[];
  errorCount:    number;
  warningCount:  number;
  infoCount:     number;
  passed:        boolean;
  /** Statut de livraison honnête, distinct du score de fidélité. */
  verdict:       'PASS' | 'PASS_WITH_WARNINGS' | 'FAIL';
  checkedFiles:  number;
  byCode:        Partial<Record<IntegrityIssueCode, number>>;
}

// ── PHASE 47 : décomposition honnête du score de fidélité ─────────────────────
// Chaque composant est soit une mesure réelle (0-100), soit `null` = NON MESURÉ.
// Un composant non mesuré n'est JAMAIS compté comme 100.

export interface FidelityScoreBreakdown {
  /** Couverture des éléments source (écrans, modèles, services…). */
  sourceCoverage:        number | null;
  /** Cohérence structurelle (imports, routes, config, doublons). */
  structuralCoherence:   number | null;
  /** Préservation fonctionnelle (flux, formulaires, état). */
  functionalPreservation: number | null;
  /** Validation statique (tsc + imports + dépendances). */
  staticValidation:      number | null;
  /** Tests réellement exécutés. null = aucun test exécuté. */
  testsExecuted:         number | null;
  /** Compilation effectivement réussie. null = jamais tentée. */
  compilationSucceeded:  number | null;
}

// ── PHASE 48 : verdict réellement exposé au client ────────────────────────────
// Le verdict plafonné était calculé puis perdu dans une variable locale du
// pipeline : ni le rapport JSON ni le rapport utilisateur ne le voyaient.

export interface FidelityValidationSummary {
  /** Score de fidélité après plafonnement par les contrôles critiques. */
  overallFidelityScore: number;
  verdict:              'EXCELLENT' | 'GOOD' | 'PARTIAL' | 'POOR' | 'FAILED';
  verdictReason:        string;
  /** true uniquement si aucun contrôle critique n'est FAIL ni NOT_RUN. */
  fullyValidated:       boolean;
  failedCritical?:      string[];
  notRunCritical?:      string[];
  scoreBreakdown?:      FidelityScoreBreakdown;
}

export interface DeliveryCheckResult {
  status:            DeliveryStatus;
  score:             number;         // real fidelity score (0-100)
  compilationPassed: boolean;
  noSourceImports:   boolean;
  noShellCritical:   boolean;
  noMissingCritical: boolean;
  navigationFunctional: boolean;
  apiLayerPresent:   boolean;
  configTransferred: boolean;
  blockers:          string[];       // what prevents READY status
  warnings:          string[];       // non-blocking issues
  readyChecklist:    { item: string; passed: boolean; detail?: string }[];
  // ── PHASE 44 : intégrité structurelle déterministe ──────────────────────
  /** Verdict du validateur d'intégrité (imports, dépendances, routes…). */
  integrityVerdict?:  'PASS' | 'PASS_WITH_WARNINGS' | 'FAIL';
  integrityErrors?:   number;
  integrityWarnings?: number;
  /**
   * true si une compilation TypeScript a RÉELLEMENT été tentée.
   * Distinct de `compilationPassed` : une compilation non tentée ne doit plus
   * être comptée comme réussie.
   */
  compilationTested?: boolean;
}

// ── Test Results (Phase 8) ────────────────────────────────────────────────────

export type TestStatus = 'PASS' | 'PARTIAL' | 'FAIL' | 'NOT_TESTABLE';

export interface FunctionalTestResult {
  feature:     string;
  status:      TestStatus;
  detail:      string;
  blockedBy?:  string;    // what prevents testing / passing
}

export interface TestResultsReport {
  totalTests:       number;
  passed:           number;
  partial:          number;
  failed:           number;
  notTestable:      number;
  overallStatus:    TestStatus;
  tests:            FunctionalTestResult[];
}
