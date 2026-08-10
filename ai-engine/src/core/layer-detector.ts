/**
 * layer-detector.ts — SOURCE_PRESENT detection per layer
 *
 * Analyse le projet SOURCE (sourceCode + AST + Architecture) pour déterminer
 * quelles couches sont réellement présentes avant de calculer le score.
 *
 * Règle fondamentale :
 *   - SOURCE_PRESENT = true  → couche applicable, score calculé normalement
 *   - SOURCE_PRESENT = false → STATUS = "N/A", score = null (jamais 0% ni 100%)
 *
 * Multi-framework : Flutter / React Native / Vue / React / Angular / plain TS
 */

import type { ASTResult }  from './ast-analyzer';
import type { ArchResult } from './architecture-detector';

// ── Types ───────────────────────────────────────────────────────────────────

export interface LayerPresence {
  businessLogic: boolean;
  navigation:    boolean;
  api:           boolean;
  repositories:  boolean;
  services:      boolean;
  stores:        boolean;
  components:    boolean;
  models:        boolean;
  uiFidelity:    boolean;
  dataLayer:     boolean;
  assets:        boolean;
  functional:    boolean;
}

/** Counters réels extraits de la source (pour pipelineTrace) */
export interface LayerCounts {
  businessLogicFiles:  number;
  navigationFiles:     number;
  apiFiles:            number;
  repositoryFiles:     number;
  serviceFiles:        number;
  storeFiles:          number;
  componentFiles:      number;
  modelFiles:          number;
  screenFiles:         number;
  dataLayerFiles:      number;
  assetFiles:          number;
  httpCallSites:       number;
  stateManagements:    string[];  // ['Riverpod', 'Bloc', 'Zustand', ...]
  detectedFramework:   string;    // 'flutter' | 'react-native' | 'vue' | 'react' | 'unknown'
}

export interface LayerDetectionResult {
  presence: LayerPresence;
  counts:   LayerCounts;
}

// ── Patterns ─────────────────────────────────────────────────────────────────

/** Patterns de chemins de fichier par type, indépendants du framework */
const PATH_PATTERNS = {
  // UI
  screens:    /\/(screens?|pages?|views?|app)\//i,
  components: /\/(widgets?|components?|ui)\//i,
  // Business
  services:   /\/(services?|usecases?|interactors?)\//i,
  repositories: /\/(repo(?:sitori(?:es|y))?|datasources?|dao)\//i,
  // State
  stores:     /\/(stores?|blocs?|cubits?|providers?|notifiers?|contexts?|atoms?|slices?)\//i,
  // API / Network
  api:        /\/(api|network|http|remote|client|endpoints?|graphql)\//i,
  // Data
  models:     /\/(models?|entities?|dtos?|schemas?|types?)\//i,
  migrations: /\/(migrations?|seeds?|database)\//i,
  // Assets
  assets:     /\/(assets?|images?|fonts?|icons?|public|static)\//i,
  // Navigation
  navigation: /\/(navigation|router|routing|routes?|stack)\//i,
};

/** Patterns de CONTENU signifiant la présence d'une couche */
const CONTENT_PATTERNS = {
  httpCalls: [
    // HTTP clients flutter
    /http\.get\s*\(/i,
    /http\.post\s*\(/i,
    /http\.put\s*\(/i,
    /http\.delete\s*\(/i,
    /dio\.get\s*\(/i,
    /dio\.post\s*\(/i,
    /Dio\s*\(/,
    // fetch API / axios (RN / Vue / React)
    /fetch\s*\(\s*['"`]/i,
    /axios\.(get|post|put|delete|patch)\s*\(/i,
    /axios\.create\s*\(/i,
    /\$http\.(get|post|put|delete)\s*\(/i,  // Angular
    /useQuery\s*\(/,
    /useMutation\s*\(/,
    /ApiClient\./,
    /ApiService\./,
    /RestClient\./,
    /NetworkService\./,
    /httpClient\.(get|post|put|delete)/i,
  ],
  repositories: [
    /class\s+\w+Repository/,
    /implements\s+\w+Repository/,
    /Repository<\w+>/,
    /extends\s+BaseRepository/,
    /final\s+\w+Repository\s+_?\w+/,  // Flutter field injection
    /\w+Repository\s*\(/,             // constructor usage
    /repository\.save\s*\(/i,
    /repository\.find\s*\(/i,
    /repository\.delete\s*\(/i,
    /DataSource\s*\{/,
    /RemoteDataSource/,
    /LocalDataSource/,
  ],
  businessLogic: [
    // Use cases
    /class\s+\w+UseCase/,
    /class\s+\w+Interactor/,
    // Domain services (signal fort — doit avoir "Domain" dans le nom)
    /class\s+\w+Domain/,
    /class\s+\w+DomainService/,
    // State transitions
    /on<\w+Event>/,               // Bloc events
    /emit\s*\(\s*\w+State/,       // Cubit/Bloc emit
    // Validation
    /validator\.\w+\s*\(/i,
    /Validators\.\w+\s*\(/i,
    /FormValidator/,
    // Business calculations
    /calculateTotal/i,
    /computePrice/i,
    /processOrder/i,
    /applyDiscount/i,
    // Conditional logic on entities
    /if\s*\(\s*\w+\.(status|role|type|state)\s*===?\s*/,
  ],
  storeManagement: {
    riverpod: [/StateNotifierProvider/, /NotifierProvider/, /Provider\.family/, /riverpod/, /ref\.watch/, /ref\.read/],
    bloc:     [/extends\s+Bloc</, /extends\s+Cubit</, /BlocProvider/, /BlocBuilder/, /BlocConsumer/],
    provider: [/ChangeNotifierProvider/, /extends\s+ChangeNotifier/, /Consumer\s*\(/, /Provider\.of\s*\(/],
    zustand:  [/create\s*\(\s*\(set/, /zustand/, /useStore\s*\(/, /createSlice\s*\(/],
    redux:    [/createStore\s*\(/, /combineReducers/, /useDispatch\s*\(/, /useSelector\s*\(/, /createSlice\s*\(/, /configureStore\s*\(/],
    mobx:     [/observable\s*\(/, /action\s*\(/, /makeObservable/, /@observable/, /@action/],
    jotai:    [/atom\s*\(/, /useAtom\s*\(/],
    pinia:    [/defineStore\s*\(/, /usePinia/, /store\.state/],
    context:  [/createContext\s*\(/, /useContext\s*\(/, /Context\.Provider/],
    recoil:   [/atom\s*\(\s*\{/, /selector\s*\(\s*\{/, /RecoilRoot/],
    getx:     [/GetxController/, /GetBuilder/, /Obx\s*\(/, /Get\.put\s*\(/],
  },
  models: [
    /class\s+\w+(?:Model|Entity|DTO|Dto|Response|Request)\s*(?:extends|implements|\{)/,
    /fromJson\s*\(Map/,          // Flutter Dart
    /toJson\s*\(\)/,
    /fromMap\s*\(Map/,
    /@Entity\s*\(/,              // TypeORM / JPA
    /@Column\s*\(/,
    /interface\s+\w+(?:DTO|Dto|Model|Response|Request|Schema)/,
    /type\s+\w+(?:DTO|Dto|Model|Response|Request)\s*=/,
    /z\.object\s*\(\s*\{/,       // Zod schemas
    /yup\.(object|string|number)/,
    /Joi\.(object|string|number)/,
    /copyWith\s*\(\s*\{/,        // Flutter immutable models
    /freezed/,                   // Freezed codegen
    /equatable/,                 // Equatable
  ],
  dataLayer: [
    /SharedPreferences/i,
    /SQLite\|sqflite/i,
    /Hive\.\w+/,
    /floor\s+@Database/i,
    /drift\s+@DriftDatabase/i,
    /@Database\s*\(/,            // TypeORM / Room
    /createConnection\s*\(/,
    /DataSource\s*\(\s*\{/,      // TypeORM
    /mongoose\.(connect|model|Schema)/i,
    /prisma\.\w+\.findMany/i,
    /sequelize\.\w+/i,
    /knex\s*\(/i,
    /Migration\s+class/i,
    /implements\s+Migration/,
  ],
  navigation: [
    // Flutter
    /GoRouter\s*\(/,
    /MaterialApp\s*\(/,
    /Navigator\.push/,
    /Navigator\.pushNamed/,
    /AutoRouter/,
    /GetMaterialApp/,
    // RN
    /createStackNavigator\s*\(/,
    /createBottomTabNavigator\s*\(/,
    /NavigationContainer/,
    /useNavigation\s*\(/,
    /useNavigate\s*\(/,          // React Router
    // Vue
    /createRouter\s*\(/,
    /createWebHistory\s*\(/,
    /RouterView/,
    // Angular
    /RouterModule\.forRoot/,
    // Generic
    /routes\s*:\s*\[/,
    /path\s*:\s*['"`]\//,
  ],
  assets: [
    /assets\s*:\s*\[/,           // Flutter pubspec
    /Image\.asset\s*\(/,
    /Image\.network\s*\(/,
    /AssetImage\s*\(/,
    /require\s*\(\s*['"].*\.(png|jpg|svg|gif|webp)/i,
    /import.*\.(png|jpg|svg|gif|webp|ttf|otf)/i,
    /fontFamily\s*:\s*['"`]\w/,
    /GoogleFonts\./,
    /fonts\s*:\s*\[/,            // Flutter pubspec fonts
  ],
};

// ── Framework detection ────────────────────────────────────────────────────

function detectFramework(
  sourceCode: string,
  astResult: ASTResult,
  allPaths: string[],
): string {
  const code = sourceCode.slice(0, 50_000); // top of file only for speed

  // Flutter — .dart files + pubspec
  const hasDartFiles = allPaths.some((p) => p.endsWith('.dart'));
  if (hasDartFiles || /pubspec\.yaml/.test(allPaths.join(' '))) return 'flutter';
  if (/flutter_lints|flutter_test|MaterialApp/.test(code)) return 'flutter';

  // React Native
  if (/react-native|ReactNative|StyleSheet\.create/.test(code)) return 'react-native';
  if (allPaths.some((p) => /app\.(tsx|jsx)$/.test(p))) return 'react-native';
  if (/metro\.config/.test(allPaths.join(' '))) return 'react-native';

  // Vue
  if (/<template>/.test(code) || /defineComponent|createApp/.test(code)) return 'vue';
  if (/\.vue$/.test(allPaths.join(' '))) return 'vue';

  // Angular
  if (/@Component\s*\(\s*\{|@NgModule|@Injectable/.test(code)) return 'angular';

  // React (web)
  if (/React\.createElement|ReactDOM\.render|createRoot/.test(code)) return 'react';
  if (allPaths.some((p) => /\.tsx$/.test(p))) return 'react';

  // AST-based fallbacks
  const statePatterns = astResult.statePatterns ?? [];
  if (statePatterns.some((p) => /riverpod|bloc|provider|flutter/i.test(p))) return 'flutter';
  if (statePatterns.some((p) => /redux|zustand|mobx|jotai/i.test(p))) return 'react-native';

  return 'unknown';
}

// ── Helper: count file matches in source paths ─────────────────────────────

function countPathMatches(paths: string[], pattern: RegExp): number {
  return paths.filter((p) => pattern.test(p)).length;
}

/** Count content pattern matches across the source code */
function countContentMatches(sourceCode: string, patterns: RegExp[]): number {
  let total = 0;
  for (const p of patterns) {
    const matches = sourceCode.match(p);
    if (matches) total += matches.length;
  }
  return total;
}

/** Check if ANY of the patterns match in the source code */
function anyMatch(sourceCode: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(sourceCode));
}

// ── Main detector ──────────────────────────────────────────────────────────

/**
 * Détecte la présence de chaque couche dans le projet SOURCE.
 *
 * @param sourceCode  - Source code brut (peut être tronqué mais on fait de notre mieux)
 * @param astResult   - Résultat de l'AST analyzer
 * @param archResult  - Résultat de l'architecture detector
 */
export function detectSourceLayers(
  sourceCode: string,
  astResult:  ASTResult,
  archResult: ArchResult,
): LayerDetectionResult {
  // ── Extraire tous les chemins de fichiers ───────────────────────────────
  const allPaths = astResult.files.map((f) => f.path);
  const code     = sourceCode; // alias (pas de troncature ici — c'est au pipeline de gérer ça)

  // ── Détecter le framework ───────────────────────────────────────────────
  const detectedFramework = detectFramework(sourceCode, astResult, allPaths);

  // ── Compter les fichiers par couche ─────────────────────────────────────

  // Navigation
  const navigationFiles =
    countPathMatches(allPaths, PATH_PATTERNS.navigation) +
    countPathMatches(allPaths, /router|navigation|_layout|stack|tabs/i);
  const hasNavigationContent = anyMatch(code, CONTENT_PATTERNS.navigation);
  const hasNavByArch = archResult.hasRouter;

  // Screens (pour UI fidelity)
  const screenFiles = countPathMatches(allPaths, PATH_PATTERNS.screens);

  // Components
  const componentFiles =
    countPathMatches(allPaths, PATH_PATTERNS.components) +
    countPathMatches(allPaths, /\/(ui|shared\/widgets?|common\/components?)\//i);

  // Services
  const serviceFiles =
    countPathMatches(allPaths, PATH_PATTERNS.services) +
    // aussi: fichiers nommés *service* / *_service*
    allPaths.filter((p) => /service/i.test(p.split('/').pop() ?? '')).length;
  const serviceFilesDeduped = Math.min(serviceFiles, new Set(allPaths.filter((p) => /service/i.test(p))).size);

  // Repositories
  const repositoryFiles =
    countPathMatches(allPaths, PATH_PATTERNS.repositories) +
    allPaths.filter((p) => /repo/i.test(p.split('/').pop() ?? '')).length;
  const repositoryFilesDeduped = Math.min(repositoryFiles, new Set(allPaths.filter((p) => /repo/i.test(p))).size);
  const hasRepositoryContent = anyMatch(code, CONTENT_PATTERNS.repositories);

  // API / HTTP calls
  const apiFiles =
    countPathMatches(allPaths, PATH_PATTERNS.api) +
    allPaths.filter((p) => /api|client|http|remote/i.test(p.split('/').pop() ?? '')).length;
  const apiFilesDeduped = Math.min(apiFiles, new Set(allPaths.filter((p) => /api|client|http|remote/i.test(p))).size);
  const httpCallSites = countContentMatches(code, CONTENT_PATTERNS.httpCalls);
  const hasApiByArch  = archResult.hasAPI;

  // Stores / State management
  const storeFiles =
    countPathMatches(allPaths, PATH_PATTERNS.stores) +
    allPaths.filter((p) => /store|bloc|cubit|provider|notifier|slice|atom/i.test(p.split('/').pop() ?? '')).length;
  const storeFilesDeduped = Math.min(storeFiles, new Set(allPaths.filter((p) => /store|bloc|cubit|provider|notifier|slice|atom/i.test(p))).size);
  const hasStateByArch = archResult.hasState;

  // Detect which state management systems are present
  const stateManagements: string[] = [];
  if (anyMatch(code, CONTENT_PATTERNS.storeManagement.riverpod)) stateManagements.push('Riverpod');
  if (anyMatch(code, CONTENT_PATTERNS.storeManagement.bloc))     stateManagements.push('Bloc/Cubit');
  if (anyMatch(code, CONTENT_PATTERNS.storeManagement.provider)) stateManagements.push('Provider');
  if (anyMatch(code, CONTENT_PATTERNS.storeManagement.zustand))  stateManagements.push('Zustand');
  if (anyMatch(code, CONTENT_PATTERNS.storeManagement.redux))    stateManagements.push('Redux');
  if (anyMatch(code, CONTENT_PATTERNS.storeManagement.mobx))     stateManagements.push('MobX');
  if (anyMatch(code, CONTENT_PATTERNS.storeManagement.jotai))    stateManagements.push('Jotai');
  if (anyMatch(code, CONTENT_PATTERNS.storeManagement.pinia))    stateManagements.push('Pinia');
  if (anyMatch(code, CONTENT_PATTERNS.storeManagement.context))  stateManagements.push('Context');
  if (anyMatch(code, CONTENT_PATTERNS.storeManagement.recoil))   stateManagements.push('Recoil');
  if (anyMatch(code, CONTENT_PATTERNS.storeManagement.getx))     stateManagements.push('GetX');

  // Models
  const modelFiles =
    countPathMatches(allPaths, PATH_PATTERNS.models) +
    allPaths.filter((p) => /model|entity|dto|schema/i.test(p.split('/').pop() ?? '')).length;
  const modelFilesDeduped = Math.min(modelFiles, new Set(allPaths.filter((p) => /model|entity|dto|schema/i.test(p))).size);
  const hasModelContent = anyMatch(code, CONTENT_PATTERNS.models);

  // Data Layer
  const dataLayerFilesDeduped = new Set(allPaths.filter((p) => /database|migration|sqlite|prisma|typeorm/i.test(p))).size;
  // (dataLayerFiles combiné avec migrations — utiliser dataLayerFilesDeduped uniquement)
  const hasDataLayerContent = anyMatch(code, CONTENT_PATTERNS.dataLayer);
  const hasDBByArch = archResult.hasDB;

  // Assets
  const assetFiles = countPathMatches(allPaths, PATH_PATTERNS.assets);
  const hasAssetContent = anyMatch(code, CONTENT_PATTERNS.assets);

  // Business Logic — détection stricte
  // Signal FORT : fichiers dans domain/, usecase, interactor (structure explicite)
  const hasUseCases = allPaths.some((p) => /usecase|interactor|\/domain\//i.test(p));
  // Signal FORT contenu : UseCase class, Bloc events, calculs métier (patterns resserrés)
  const hasBusinessLogicContent = anyMatch(code, CONTENT_PATTERNS.businessLogic);
  const businessLogicFiles = archResult.modules.filter((m) => m.role === 'business').reduce((s, m) => s + m.files.length, 0);

  // Functional (auth, forms, error handling)
  const hasFunctionalContent =
    /auth|login|signup|register/i.test(code) ||
    /Form\s*\(/i.test(code) ||
    /catch\s*\(/.test(code);

  // ── Construire LayerCounts ──────────────────────────────────────────────
  const counts: LayerCounts = {
    businessLogicFiles:  businessLogicFiles + (hasUseCases ? 1 : 0),
    navigationFiles:     navigationFiles,
    apiFiles:            apiFilesDeduped,
    repositoryFiles:     repositoryFilesDeduped,
    serviceFiles:        serviceFilesDeduped,
    storeFiles:          storeFilesDeduped,
    componentFiles,
    modelFiles:          modelFilesDeduped,
    screenFiles,
    dataLayerFiles:      dataLayerFilesDeduped,
    assetFiles,
    httpCallSites,
    stateManagements,
    detectedFramework,
  };

  // ── Construire LayerPresence ────────────────────────────────────────────
  //
  // Règles de présence : au moins UN signal fort (fichier OU contenu) suffit.
  // Thresholds bas intentionnels : mieux vaut un faux positif (évaluer une couche absente)
  // qu'un faux négatif (ignorer une couche présente).

  const presence: LayerPresence = {
    // Navigation : présente si fichier nav OU pattern nav dans le code OU ArchResult.hasRouter
    navigation: navigationFiles > 0 || hasNavigationContent || hasNavByArch || screenFiles >= 2,

    // API : présente UNIQUEMENT si vraiment des appels HTTP existent
    // → 0 call = N/A (jamais de score fabricé pour une app frontend-only)
    api: httpCallSites >= 2 || apiFilesDeduped >= 1 || hasApiByArch,

    // Repositories : présents UNIQUEMENT si un pattern repository existe
    repositories: repositoryFilesDeduped >= 1 || hasRepositoryContent,

    // Services : présents si des fichiers service OU du contenu service
    // Threshold bas car les apps frontend ont souvent des "services" (auth service, storage service...)
    services: serviceFilesDeduped >= 1 || (serviceFiles > 0),

    // Stores : présents si state management détecté dans le code OU dossier stores/
    stores: storeFilesDeduped >= 1 || stateManagements.length > 0 || hasStateByArch,

    // Components : présents si des widgets/composants existent (ou des screens = ils contiennent des composants)
    components: componentFiles >= 1 || screenFiles >= 1,

    // Models : présents si des modèles/entités existent
    models: modelFilesDeduped >= 1 || hasModelContent,

    // Business Logic : présent uniquement si use cases / domain / transformations significatives
    // Un projet frontend simple n'a PAS de business logic au sens strict
    businessLogic: businessLogicFiles >= 2 || hasUseCases || hasBusinessLogicContent,

    // UI Fidelity : présent dès qu'il y a des screens OU des composants
    uiFidelity: screenFiles >= 1 || componentFiles >= 1,

    // Data Layer : présent uniquement si DB / migrations / ORM
    dataLayer: dataLayerFilesDeduped >= 1 || hasDataLayerContent || hasDBByArch,

    // Assets : présents si des fichiers assets OU des références dans le code
    assets: assetFiles >= 1 || hasAssetContent,

    // Functional : présent si auth / forms / error handling
    functional: hasFunctionalContent || screenFiles >= 2,
  };

  return { presence, counts };
}

/**
 * Retourne un résumé lisible de la détection pour les logs / rapports
 */
export function summarizeLayerPresence(result: LayerDetectionResult): string {
  const { presence, counts } = result;
  const lines: string[] = [
    `Framework détecté : ${counts.detectedFramework}`,
    `State management  : ${counts.stateManagements.length > 0 ? counts.stateManagements.join(', ') : 'N/A'}`,
    '',
    'Couches SOURCE :',
  ];

  const axes = Object.entries(presence) as [keyof LayerPresence, boolean][];
  for (const [layer, present] of axes) {
    const status = present ? '✅ APPLICABLE' : '⛔ N/A';
    lines.push(`  ${layer.padEnd(14)} ${status}`);
  }

  lines.push('');
  lines.push(`Fichiers : screens=${counts.screenFiles} services=${counts.serviceFiles} stores=${counts.storeFiles} ` +
             `components=${counts.componentFiles} repos=${counts.repositoryFiles} models=${counts.modelFiles} ` +
             `api=${counts.apiFiles} assets=${counts.assetFiles} data=${counts.dataLayerFiles}`);
  lines.push(`HTTP calls détectés : ${counts.httpCallSites}`);

  return lines.join('\n');
}
