// ============================================================
// CodeMorph AI Engine — Business Layer Extractor
// PHASE 29: Extraction et conversion des couches métier
//
// PROBLÈME:
//   Le moteur générait des squelettes pour repositories/services/providers
//   basés uniquement sur les métadonnées IR (noms de méthodes sans implémentation).
//   La logique métier (règles de validation, transformations, caching, offline, etc.)
//   était PERDUE lors de la conversion.
//
// SOLUTION:
//   1. Extraire chaque fichier métier du code source brut
//   2. Classifier son type (service, repository, provider, validator, etc.)
//   3. Injecter le contenu source COMPLET dans le prompt LLM
//   4. Générer la version cible COMPLÈTE avec toute la logique préservée
//   5. Jamais produire un squelette vide quand le source est disponible
//
// COUCHES MÉTIER COUVERTES:
//   - repositories  : accès données (API/DB calls, DTOs, mappings)
//   - services      : logique métier (calculs, règles, transformations)
//   - providers     : injection de dépendances, state management
//   - validators    : règles de validation de formulaires/données
//   - exceptions    : gestion d'erreurs spécifiques au domaine
//   - models        : data classes, DTOs, value objects
//   - utils/helpers : fonctions utilitaires
//   - middleware    : intercepteurs, guards
//   - hooks         : custom hooks React/Flutter state
//   - cache         : stratégies de mise en cache
//   - offline       : logique hors-ligne, sync
//   - networking    : configuration HTTP, intercepteurs
// ============================================================

import type { AIProvider } from './ai-provider';
import { cleanLLMOutput }  from './output-cleaner';
import { needsChunking, convertLargeFile } from './file-chunker';

// ── Types ──────────────────────────────────────────────────────────────────

export type BusinessLayerType =
  | 'repository'
  | 'service'
  | 'provider'
  | 'validator'
  | 'exception'
  | 'model'
  | 'util'
  | 'helper'
  | 'middleware'
  | 'hook'
  | 'cache'
  | 'offline'
  | 'networking'
  | 'store'
  | 'bloc'
  | 'cubit'
  | 'interactor'
  | 'usecase'
  | 'controller'
  | 'datasource'
  | 'mapper'
  | 'factory'
  | 'unknown';

export interface SourceBusinessFile {
  path:        string;
  content:     string;
  layerType:   BusinessLayerType;
  className?:  string | undefined;  // classe principale du fichier
  lineCount:   number;
  charCount:   number;
}

export interface ConvertedBusinessFile {
  sourcePath:    string;
  targetPath:    string;
  content:       string;
  layerType:     BusinessLayerType;
  lineCount:     number;
  sourceLines:   number;
  preservationRatio: number;    // generated/source lines ratio
  hadChunking:   boolean;
  todosInserted: number;
  success:       boolean;
  error?:        string;
}

export interface BusinessLayerExtractionResult {
  sourceFiles:    SourceBusinessFile[];
  convertedFiles: ConvertedBusinessFile[];
  totalFiles:     number;
  successCount:   number;
  failedCount:    number;
  layerStats:     Record<BusinessLayerType, number>;
}

// ── Patterns de classification des fichiers métier ────────────────────────
// Chaque entrée = { pathPattern, contentPattern, type }

interface ClassificationRule {
  pathPattern:     RegExp;
  contentPatterns: RegExp[];
  type:            BusinessLayerType;
  priority:        number; // plus haut = vérifié en premier
}

const CLASSIFICATION_RULES: ClassificationRule[] = [
  // Repositories (accès données — priorité max)
  {
    priority: 100,
    pathPattern: /(?:repository|repo|datasource|data_source)/i,
    contentPatterns: [
      /(?:class|abstract)\s+\w*(?:Repository|Repo|DataSource)\b/,
      /\bimplements\s+\w*(?:Repository|Repo|DataSource)\b/,
    ],
    type: 'repository',
  },
  // Services (logique métier)
  {
    priority: 90,
    pathPattern: /service/i,
    contentPatterns: [
      /(?:class|abstract)\s+\w*Service\b/,
      /\bimplements\s+\w*Service\b/,
      /\bprovideRepository\b|\binjectable\b|\b@Injectable\b/i,
    ],
    type: 'service',
  },
  // BLoC (Flutter state management)
  {
    priority: 85,
    pathPattern: /\.bloc\.dart$|\/blocs?\//i,
    contentPatterns: [
      /\bextends\s+Bloc\s*</,
      /\bextends\s+Cubit\s*</,
      /\bBloc\b|\bBlocBase\b/,
    ],
    type: 'bloc',
  },
  // Cubit (Flutter state management simplifié)
  {
    priority: 84,
    pathPattern: /\.cubit\.dart$|\/cubits?\//i,
    contentPatterns: [
      /\bextends\s+Cubit\s*</,
    ],
    type: 'cubit',
  },
  // Providers (Riverpod/Provider Flutter, NestJS, React Context)
  {
    priority: 80,
    pathPattern: /provider/i,
    contentPatterns: [
      /\bStateNotifier\b|\bChangeNotifier\b|\bProvider\b/,
      /\bprovideFactory\b|\bprovideValue\b/i,
      /\b@Injectable\b|\b@Provider\b/,
    ],
    type: 'provider',
  },
  // Use Cases / Interactors (Clean Architecture)
  {
    priority: 78,
    pathPattern: /(?:use_?case|usecase|interactor)/i,
    contentPatterns: [
      /(?:class|abstract)\s+\w*(?:UseCase|Interactor|UseCaseImpl)\b/,
      /\bimplements\s+\w*UseCase\b/,
    ],
    type: 'usecase',
  },
  // Validators
  {
    priority: 75,
    pathPattern: /(?:validator|validation)/i,
    contentPatterns: [
      /(?:class|abstract)\s+\w*(?:Validator|Validation)\b/,
      /\bFormValidator\b|\bValidationRule\b|\bInputValidator\b/,
    ],
    type: 'validator',
  },
  // Exceptions / Errors
  {
    priority: 70,
    pathPattern: /(?:exception|error|failure)/i,
    contentPatterns: [
      /\bextends\s+(?:Exception|Error|Failure)\b/,
      /(?:class|abstract)\s+\w*(?:Exception|Error|Failure)\b/,
    ],
    type: 'exception',
  },
  // Models / Entities / DTOs
  {
    priority: 65,
    pathPattern: /(?:model|entity|dto|request|response|data_class)/i,
    contentPatterns: [
      /\bfromJson\b|\btoJson\b|\bfromMap\b|\btoMap\b/,
      /\b@Entity\b|\b@Table\b|\bEntityBase\b/,
      /\bcopyWith\b.*\btoMap\b|\bfromJson\b.*\bcopyWith\b/s,
    ],
    type: 'model',
  },
  // Mappers (transformation de données)
  {
    priority: 62,
    pathPattern: /mapper/i,
    contentPatterns: [
      /(?:class|abstract)\s+\w*Mapper\b/,
      /\bmap\b.*\bfrom\b|\bfromEntity\b|\btoEntity\b/i,
    ],
    type: 'mapper',
  },
  // Hooks (React/Flutter)
  {
    priority: 60,
    pathPattern: /(?:hook|use_)/i,
    contentPatterns: [
      /\bfunction\s+use[A-Z]\w+\b/,
      /\bconst\s+use[A-Z]\w+\b/,
      /\buseHook\b|\buseCallback\b|\buseEffect\b|\buseState\b/,
    ],
    type: 'hook',
  },
  // Middleware / Guards / Interceptors
  {
    priority: 55,
    pathPattern: /(?:middleware|guard|interceptor|filter)/i,
    contentPatterns: [
      /\bimplements\s+(?:NestMiddleware|CanActivate|NestInterceptor|ExceptionFilter)\b/,
      /(?:class|abstract)\s+\w*(?:Middleware|Guard|Interceptor|Filter)\b/,
      /\b@Injectable\b.*\buse\b|\bconfigure\b/,
    ],
    type: 'middleware',
  },
  // Cache
  {
    priority: 50,
    pathPattern: /(?:cache|cach)/i,
    contentPatterns: [
      /(?:class|abstract)\s+\w*Cache\b/,
      /\bcacheData\b|\bcachedValue\b|\bCacheService\b/,
    ],
    type: 'cache',
  },
  // Offline / Sync
  {
    priority: 48,
    pathPattern: /(?:offline|sync|local_?storage)/i,
    contentPatterns: [
      /\boffline\b.*\b(?:data|sync|first)\b/i,
      /\bSyncService\b|\bLocalDatabase\b|\bOfflineManager\b/,
    ],
    type: 'offline',
  },
  // Networking
  {
    priority: 45,
    pathPattern: /(?:network|api_?client|http_?client|dio_?client)/i,
    contentPatterns: [
      /\bDioClient\b|\bHttpClient\b|\bApiClient\b|\bNetworkManager\b/,
      /\bBaseOptions\b|\bInterceptorsWrapper\b|\bRequestOptions\b/,
    ],
    type: 'networking',
  },
  // Utils / Helpers
  {
    priority: 30,
    pathPattern: /(?:util|helper|extension|mixin)/i,
    contentPatterns: [
      /\bextension\s+\w+\s+on\b/,       // Dart extensions
      /\bexport function\b|\bexport const\b/,
    ],
    type: 'util',
  },
  // Store (Zustand, MobX, Redux)
  {
    priority: 20,
    pathPattern: /\.store\./i,
    contentPatterns: [
      /\bcreate\b.*\bZustand\b|\buseStore\b|\bMobXStore\b/i,
      /\bconst\s+use\w+Store\b/,
    ],
    type: 'store',
  },
];

// Patterns pour détecter les fichiers à EXCLURE (UI pur, tests, config)
const EXCLUDED_PATH_PATTERNS: RegExp[] = [
  /\.test\.\w+$/,
  /\.spec\.\w+$/,
  /_test\.\w+$/,
  /\/test\//,
  /\/tests\//,
  /\/\__tests__\//,
  /\.config\.\w+$/,
  /pubspec\.yaml$/,
  /package\.json$/,
  /tsconfig\.json$/,
  /\.gradle$/,
  /AndroidManifest/,
  /Info\.plist$/,
  /\.(png|jpg|jpeg|gif|svg|webp|ttf|otf|woff|woff2|mp3|mp4|wav)$/i,
  /l10n|localization|i18n|intl/i,          // traductions
  /\/generated\//i,                         // code généré automatiquement
  /\.g\.dart$/,                             // Dart generated files
  /\.freezed\.dart$/,                       // Freezed generated
  /\.gr\.dart$/,                            // Auto Route generated
];

// ── Classification ────────────────────────────────────────────────────────

export function classifySourceFile(
  path: string,
  content: string,
): BusinessLayerType {
  // Vérifier les exclusions d'abord
  if (EXCLUDED_PATH_PATTERNS.some((p) => p.test(path))) return 'unknown';

  // Tester les règles par priorité décroissante
  const sorted = [...CLASSIFICATION_RULES].sort((a, b) => b.priority - a.priority);

  for (const rule of sorted) {
    const pathMatch = rule.pathPattern.test(path);
    if (!pathMatch) continue;
    // Vérifier au moins un pattern de contenu (ou accepter si path suffit)
    const contentOk = rule.contentPatterns.length === 0
      || rule.contentPatterns.some((cp) => cp.test(content));
    if (contentOk) return rule.type;
  }

  // Fallback: contenu uniquement
  for (const rule of sorted) {
    const contentOk = rule.contentPatterns.some((cp) => cp.test(content));
    if (contentOk) return rule.type;
  }

  return 'unknown';
}

// ── Extraction du nom de classe principal ─────────────────────────────────

export function extractMainClassName(content: string): string | undefined {
  // Dart: class MyService extends/implements ...
  const dartClass = /(?:abstract\s+)?class\s+(\w+)(?:\s+extends|\s+implements|\s+with|\s*\{)/.exec(content);
  if (dartClass?.[1]) return dartClass[1];

  // TypeScript: export class MyService
  const tsClass = /export\s+(?:abstract\s+)?class\s+(\w+)/.exec(content);
  if (tsClass?.[1]) return tsClass[1];

  // TypeScript: export default class
  const tsDefaultClass = /export\s+default\s+class\s+(\w+)/.exec(content);
  if (tsDefaultClass?.[1]) return tsDefaultClass[1];

  // Kotlin: class MyService
  const kotlinClass = /(?:abstract\s+|sealed\s+|data\s+|open\s+)?class\s+(\w+)/.exec(content);
  if (kotlinClass?.[1]) return kotlinClass[1];

  return undefined;
}

// ── Extraction des fichiers métier depuis le sourceCode brut ──────────────

export function extractBusinessLayerFiles(sourceCode: string): SourceBusinessFile[] {
  const result: SourceBusinessFile[] = [];

  // Pattern pour les blocs de fichiers dans le sourceCode concaténé
  // Format: // === FILE: path/to/file.ext ===\n<content>
  const filePattern = /\/\/\s*(?:=+\s*)?FILE:\s*(.+?)(?:\s*=+)?\n([\s\S]*?)(?=\/\/\s*(?:=+\s*)?FILE:|$)/g;
  let match: RegExpExecArray | null;

  while ((match = filePattern.exec(sourceCode)) !== null) {
    const path    = (match[1] ?? '').trim();
    const content = (match[2] ?? '').trim();
    if (!path || !content) continue;

    const layerType = classifySourceFile(path, content);
    if (layerType === 'unknown') continue; // Ignorer les fichiers UI purs et non-classifiables

    result.push({
      path,
      content,
      layerType,
      className: extractMainClassName(content),
      lineCount: content.split('\n').length,
      charCount: content.length,
    });
  }

  return result;
}

// ── Génération du chemin cible selon le type de couche ────────────────────

export function generateTargetPath(
  sourcePath:      string,
  layerType:       BusinessLayerType,
  targetFramework: string,
  _className?:     string | undefined,
): string {
  const norm = targetFramework.toLowerCase().replace(/[\s_-]/g, '');
  const isReact = norm === 'react';
  const isNest = norm === 'nestjs';

  // Extraire le nom de base du fichier source
  const baseName = sourcePath.split('/').pop()?.replace(/\.\w+$/, '') ?? 'unknown';
  const cleanName = baseName
    .replace(/_bloc$/, '')
    .replace(/_cubit$/, '')
    .replace(/_repository$/, '_repository')
    .replace(/_service$/, '_service')
    .replace(/_provider$/, '')
    .replace(/_validator$/, '_validator')
    .replace(/_impl$/, '')
    .replace(/_impl_/g, '_');

  // Convertir snake_case en camelCase
  const toCamelCase = (s: string) => s.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
  const camel = toCamelCase(cleanName);

  if (isNest) {
    // NestJS structure: src/modules/<name>/<name>.<type>.ts
    const modName = camel.replace(/Service$|Repository$|Controller$|Module$/, '').toLowerCase();
    switch (layerType) {
      case 'service':      return `src/modules/${modName}/${modName}.service.ts`;
      case 'repository':   return `src/modules/${modName}/${modName}.repository.ts`;
      case 'controller':   return `src/modules/${modName}/${modName}.controller.ts`;
      case 'validator':    return `src/modules/${modName}/dto/create-${modName}.dto.ts`;
      case 'model':        return `src/entities/${camel}.entity.ts`;
      case 'middleware':   return `src/common/middleware/${camel}.middleware.ts`;
      case 'exception':    return `src/common/exceptions/${camel}.exception.ts`;
      case 'util':         return `src/common/utils/${camel}.util.ts`;
      default:             return `src/modules/${modName}/${camel}.ts`;
    }
  }

  if (isReact) {
    switch (layerType) {
      case 'service':
      case 'repository':
      case 'datasource':   return `src/services/${camel}.ts`;
      case 'store':
      case 'provider':
      case 'bloc':
      case 'cubit':        return `src/stores/${camel}.store.ts`;
      case 'validator':    return `src/validators/${camel}.ts`;
      case 'model':
      case 'mapper':       return `src/types/${camel}.types.ts`;
      case 'hook':         return `src/hooks/${camel}.ts`;
      case 'middleware':   return `src/middleware/${camel}.ts`;
      case 'exception':    return `src/errors/${camel}.ts`;
      case 'util':
      case 'helper':       return `src/utils/${camel}.ts`;
      case 'cache':        return `src/cache/${camel}.ts`;
      case 'offline':      return `src/offline/${camel}.ts`;
      case 'networking':   return `src/lib/${camel}.ts`;
      default:             return `src/${camel}.ts`;
    }
  }

  // React Native (default)
  switch (layerType) {
    case 'service':
    case 'repository':
    case 'datasource':   return `src/services/${camel}.ts`;
    case 'store':
    case 'provider':
    case 'bloc':
    case 'cubit':        return `src/stores/${camel}.store.ts`;
    case 'validator':    return `src/validators/${camel}.ts`;
    case 'model':
    case 'mapper':       return `src/types/${camel}.types.ts`;
    case 'hook':         return `src/hooks/${camel}.ts`;
    case 'middleware':   return `src/middleware/${camel}.ts`;
    case 'exception':    return `src/errors/${camel}.ts`;
    case 'util':
    case 'helper':       return `src/utils/${camel}.ts`;
    case 'cache':        return `src/cache/${camel}.ts`;
    case 'offline':      return `src/offline/${camel}.ts`;
    case 'networking':   return `src/lib/${camel}.ts`;
    case 'usecase':
    case 'interactor':   return `src/usecases/${camel}.ts`;
    default:             return `src/${camel}.ts`;
  }
}

// ── Prompt de conversion par type de couche ───────────────────────────────

function buildConversionPrompt(
  file:            SourceBusinessFile,
  targetFramework: string,
  targetPath:      string,
): { system: string; user: string } {
  const norm = targetFramework.toLowerCase().replace(/[\s_-]/g, '');
  const isRN  = norm === 'reactnative' || norm === 'rn';
  const isNest = norm === 'nestjs';
  const targetLabel = isRN ? 'React Native (Expo) + TypeScript' : isNest ? 'NestJS + TypeScript' : 'React + TypeScript';

  // Instructions spécifiques par type de couche
  const layerInstructions: Partial<Record<BusinessLayerType, string>> = {
    repository: `Convert this ${file.layerType.toUpperCase()} to ${targetLabel}.
RULES:
- Keep EVERY method — no method must be removed
- Replace Flutter-specific packages (dio → axios, shared_preferences → AsyncStorage)
- Preserve all API endpoints, HTTP methods, request/response types
- Keep all error handling (try/catch, specific error types)
- Keep all data mapping/transformation logic
- Output file path: ${targetPath}`,

    service: `Convert this ${file.layerType.toUpperCase()} to ${targetLabel}.
RULES:
- Keep EVERY method and business rule — no logic must be lost
- Preserve all validation logic, calculations, transformations
- Keep all error cases and exception handling
- Replace Flutter dependencies with RN/TS equivalents
- Output file path: ${targetPath}`,

    bloc: `Convert this Flutter BLoC to a ${targetLabel} Zustand store.
RULES:
- Map each BLoC event → Zustand action
- Map each BLoC state → Zustand state slice
- Preserve all async logic (fetchData, submitForm, etc.)
- Keep all error handling and loading states
- The output is a Zustand store (create<StateType>(...))
- Output file path: ${targetPath}`,

    cubit: `Convert this Flutter Cubit to a ${targetLabel} Zustand store.
RULES:
- Map each Cubit method → Zustand action
- Map each Cubit state field → Zustand state field
- Preserve all business logic and side effects
- Keep all error handling and loading states
- Output file path: ${targetPath}`,

    provider: `Convert this Flutter Provider/Riverpod to a ${targetLabel} Zustand store or React Context.
RULES:
- Preserve all state fields and computed values
- Convert ChangeNotifier methods → Zustand actions
- Keep all business logic and notifications
- Output file path: ${targetPath}`,

    validator: `Convert this validator to ${targetLabel}.
RULES:
- Preserve EVERY validation rule exactly
- Keep all error messages (translate if needed)
- Keep all field validation patterns (regex, length, format)
- Output yup/zod validation schema or equivalent
- Output file path: ${targetPath}`,

    model: `Convert this data model/DTO to ${targetLabel} TypeScript interfaces.
RULES:
- Preserve ALL fields exactly (no field must be missing)
- Keep nullability (nullable fields → optional ?)
- Add fromJSON/toJSON if original has fromMap/toMap
- Keep copyWith pattern if present
- Output file path: ${targetPath}`,

    exception: `Convert this exception/error class to ${targetLabel}.
RULES:
- Preserve all error codes, messages, metadata
- Map Dart exceptions → TypeScript Error subclasses
- Keep all error handling patterns
- Output file path: ${targetPath}`,

    middleware: `Convert this middleware/guard/interceptor to ${targetLabel}.
RULES:
- Preserve all request/response interception logic
- Keep all authentication checks
- Keep all logging and error handling
- Output file path: ${targetPath}`,

    util: `Convert this utility/helper to ${targetLabel}.
RULES:
- Preserve ALL utility functions
- Keep all edge cases and null checks
- Convert Dart-specific syntax to TypeScript
- Output file path: ${targetPath}`,

    hook: `Convert this to a ${targetLabel} custom hook.
RULES:
- Preserve all state management logic
- Keep all side effects and cleanup
- Convert Flutter widget lifecycle → React hooks (useEffect, useState)
- Output file path: ${targetPath}`,

    cache: `Convert this cache layer to ${targetLabel}.
RULES:
- Preserve all caching strategies (TTL, invalidation, etc.)
- Replace Flutter storage (SharedPreferences) → AsyncStorage or in-memory
- Keep all cache key patterns
- Output file path: ${targetPath}`,

    offline: `Convert this offline/sync logic to ${targetLabel}.
RULES:
- Preserve all offline-first strategies
- Keep all sync logic and conflict resolution
- Replace Flutter storage → AsyncStorage / MMKV equivalent
- Output file path: ${targetPath}`,

    networking: `Convert this networking/HTTP configuration to ${targetLabel}.
RULES:
- Preserve all HTTP client configuration (timeouts, headers, base URL)
- Convert Dio interceptors → Axios interceptors
- Keep all authentication token injection
- Keep all error response handling
- Output file path: ${targetPath}`,
  };

  const specificInstructions = layerInstructions[file.layerType]
    ?? `Convert this ${file.layerType.toUpperCase()} from ${file.path.split('.').pop()?.toUpperCase() ?? 'source'} to ${targetLabel}. Output file path: ${targetPath}`;

  const system = `You are an expert software architect specializing in cross-framework code migration.
Your task is to perform a COMPLETE and FAITHFUL conversion of source code.

ABSOLUTE RULES:
1. NEVER summarize — every function/method must appear in the output
2. NEVER delete business logic — if conversion is impossible, add: // TODO(codeMorph): CONVERSION INCOMPLETE — <reason>
3. NEVER invent functionality not in the source
4. Output ONLY the complete TypeScript file content — no markdown fences, no explanations
5. The output file must be compilable TypeScript
6. The output line count should be at least 60% of the source line count`;

  const user = `${specificInstructions}

SOURCE FILE (${file.path}, ${file.lineCount} lines):
\`\`\`
${file.content}
\`\`\`

Convert the COMPLETE source above to ${targetLabel}.
Preserve ALL logic. Output ONLY the TypeScript file content.`;

  return { system, user };
}

// ── Convertisseur principal ────────────────────────────────────────────────

export async function convertBusinessLayerFile(
  file:            SourceBusinessFile,
  ai:              AIProvider,
  targetFramework: string,
): Promise<ConvertedBusinessFile> {
  const targetPath = generateTargetPath(file.path, file.layerType, targetFramework, file.className);
  const tier = ai.getTier();

  // Tier statique → pas de conversion AI
  if (tier === 'static') {
    return {
      sourcePath: file.path,
      targetPath,
      content: `// TODO(codeMorph): Conversion requires AI tier (current: static)\n// Source: ${file.path}\n// Layer: ${file.layerType}\n`,
      layerType: file.layerType,
      lineCount: 3,
      sourceLines: file.lineCount,
      preservationRatio: 0,
      hadChunking: false,
      todosInserted: 1,
      success: false,
      error: 'static tier — no AI conversion',
    };
  }

  try {
    let content: string;
    let hadChunking = false;
    let todosInserted = 0;

    // Vérifier si chunking nécessaire
    if (needsChunking(file.content, tier)) {
      console.log(`[BizLayerExtractor] Large file "${file.path}" (${file.charCount} chars) — activating chunker`);
      const assemblyResult = await convertLargeFile(
        file.content,
        file.path.split('.').pop() ?? 'dart',  // langage source
        targetFramework,
        'flutter',  // source framework (par défaut)
        ai,
        `${file.className ?? file.path} (${file.layerType})`,
      );
      content = assemblyResult.content;
      hadChunking = true;
      todosInserted = assemblyResult.todosInserted;
    } else {
      // Conversion directe
      const { system, user } = buildConversionPrompt(file, targetFramework, targetPath);

      // Budget tokens selon le tier
      const maxResponseTokens = tier === 'free-groq' ? 1500
        : tier === 'platform' ? 3000
        : 6000; // pro tiers

      const res = await ai.chat(
        [{ role: 'system', content: system }, { role: 'user', content: user }],
        maxResponseTokens,
      );
      content = res.content || '';
    }

    // Nettoyage obligatoire
    const cleanResult = cleanLLMOutput(content, `biz:${file.layerType}:${file.path}`);
    content = cleanResult.content;

    if (!content || content.length < 50) {
      throw new Error(`Empty or too short output (${content.length} chars)`);
    }

    const generatedLines = content.split('\n').length;
    const preservationRatio = file.lineCount > 0 ? generatedLines / file.lineCount : 0;

    // Avertir si ratio de compression trop faible
    if (preservationRatio < 0.4 && file.lineCount > 30) {
      console.warn(`[BizLayerExtractor] ⚠️  Compression warning for "${file.path}": ${file.lineCount} → ${generatedLines} lines (ratio: ${(preservationRatio * 100).toFixed(0)}%)`);
    }

    console.log(`[BizLayerExtractor] ✅ "${file.path}" → "${targetPath}" (${file.lineCount} → ${generatedLines} lines, ${(preservationRatio * 100).toFixed(0)}% preserved)`);

    return {
      sourcePath: file.path,
      targetPath,
      content,
      layerType: file.layerType,
      lineCount: generatedLines,
      sourceLines: file.lineCount,
      preservationRatio,
      hadChunking,
      todosInserted,
      success: true,
    };
  } catch (err) {
    const errMsg = (err as Error).message;
    console.error(`[BizLayerExtractor] ❌ Failed to convert "${file.path}": ${errMsg}`);

    // Fallback: insérer TODO avec contenu source préservé
    const fallbackContent = `// TODO(codeMorph): CONVERSION INCOMPLETE — ${file.layerType.toUpperCase()} "${file.className ?? file.path}"
// Error: ${errMsg}
// Original source preserved below for manual conversion:
/*
 * SOURCE FILE: ${file.path}
 * LAYER TYPE: ${file.layerType}
 * LINES: ${file.lineCount}
 *
${file.content.split('\n').slice(0, 50).map((l) => ` * ${l}`).join('\n')}
${file.lineCount > 50 ? ` * ... (${file.lineCount - 50} more lines — see source file)` : ''}
 */
`;

    return {
      sourcePath: file.path,
      targetPath,
      content: fallbackContent,
      layerType: file.layerType,
      lineCount: fallbackContent.split('\n').length,
      sourceLines: file.lineCount,
      preservationRatio: 0,
      hadChunking: false,
      todosInserted: 1,
      success: false,
      error: errMsg,
    };
  }
}

// ── Pipeline d'extraction + conversion complet ────────────────────────────

export async function extractAndConvertBusinessLayers(
  sourceCode:      string,
  ai:              AIProvider,
  targetFramework: string,
  maxFilesPerTier?: Partial<Record<string, number>>,
): Promise<BusinessLayerExtractionResult> {
  console.log(`\n[BizLayerExtractor] ══════ BUSINESS LAYER EXTRACTION (Phase 29) ══════`);

  // 1. Extraire tous les fichiers métier
  const sourceFiles = extractBusinessLayerFiles(sourceCode);
  console.log(`[BizLayerExtractor] Extracted ${sourceFiles.length} business layer files from source`);

  // Stats par type
  const layerStats: Record<BusinessLayerType, number> = {} as Record<BusinessLayerType, number>;
  for (const f of sourceFiles) {
    layerStats[f.layerType] = (layerStats[f.layerType] ?? 0) + 1;
  }
  const statLines = Object.entries(layerStats)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');
  console.log(`[BizLayerExtractor] Layer distribution:\n${statLines}`);

  if (sourceFiles.length === 0) {
    console.warn(`[BizLayerExtractor] No business layer files found. Check source code format (expected // === FILE: ... === markers).`);
    return {
      sourceFiles: [],
      convertedFiles: [],
      totalFiles: 0,
      successCount: 0,
      failedCount: 0,
      layerStats,
    };
  }

  // 2. Appliquer la limite par tier (éviter de surcharger les modèles gratuits)
  const tier = ai.getTier();
  const defaultLimits: Record<string, number> = {
    'static':        0,
    'free-groq':     8,   // maximum 8 fichiers métier pour Groq (rate limit)
    'platform':      30,  // 30 fichiers pour le tier plateforme
    'pro-openai':    100, // illimité pratiquement
    'pro-anthropic': 100,
  };
  const maxFiles = maxFilesPerTier?.[tier] ?? defaultLimits[tier] ?? 15;
  const filesToProcess = sourceFiles.slice(0, maxFiles);

  if (filesToProcess.length < sourceFiles.length) {
    console.warn(`[BizLayerExtractor] ⚠️  Tier "${tier}": processing only ${filesToProcess.length}/${sourceFiles.length} files (limit: ${maxFiles})`);
  }

  // 3. Convertir chaque fichier
  const convertedFiles: ConvertedBusinessFile[] = [];
  let successCount = 0;
  let failedCount = 0;

  // Groq: pause entre les appels pour éviter le rate limit
  const GROQ_DELAY_MS = 600;

  for (let i = 0; i < filesToProcess.length; i++) {
    const file = filesToProcess[i]!;
    console.log(`[BizLayerExtractor] Converting [${i + 1}/${filesToProcess.length}] ${file.layerType}: ${file.path}`);

    const result = await convertBusinessLayerFile(file, ai, targetFramework);
    convertedFiles.push(result);

    if (result.success) {
      successCount++;
    } else {
      failedCount++;
    }

    // Rate limit protection pour Groq
    if (tier === 'free-groq' && i < filesToProcess.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, GROQ_DELAY_MS));
    }
  }

  console.log(`[BizLayerExtractor] ══════ EXTRACTION COMPLETE ══════`);
  console.log(`[BizLayerExtractor] Total: ${filesToProcess.length} files | ✅ ${successCount} success | ❌ ${failedCount} failed`);
  console.log(`[BizLayerExtractor] ════════════════════════════════\n`);

  return {
    sourceFiles,
    convertedFiles,
    totalFiles: filesToProcess.length,
    successCount,
    failedCount,
    layerStats,
  };
}

// ── Utilitaires pour les autres modules ──────────────────────────────────

/** Retourne la liste des types de couches importants (services, repositories, providers, validators) */
export const CRITICAL_LAYER_TYPES: BusinessLayerType[] = [
  'repository', 'service', 'provider', 'validator', 'bloc', 'cubit', 'usecase',
];

/** Vérifie si un résultat de conversion a une bonne fidélité */
export function isHighFidelity(result: ConvertedBusinessFile): boolean {
  return result.success && result.preservationRatio >= 0.5;
}

/** Génère un rapport texte de l'extraction */
export function formatExtractionReport(result: BusinessLayerExtractionResult): string {
  const lines: string[] = [
    `════════════════════════════════════════════════`,
    `  BUSINESS LAYER EXTRACTION REPORT (Phase 29)`,
    `════════════════════════════════════════════════`,
    `  Total files extracted : ${result.totalFiles}`,
    `  Successful conversions: ${result.successCount}`,
    `  Failed conversions    : ${result.failedCount}`,
    ``,
    `  Layer breakdown:`,
  ];

  const sortedLayers = Object.entries(result.layerStats)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a);

  for (const [layer, count] of sortedLayers) {
    const converted = result.convertedFiles.filter((f) => f.layerType === layer as BusinessLayerType);
    const ok = converted.filter((f) => f.success).length;
    const bar = '█'.repeat(Math.min(10, count)) + '░'.repeat(Math.max(0, 10 - count));
    lines.push(`  ${layer.padEnd(14)} [${bar}]  ${count} files (${ok} converted)`);
  }

  if (result.convertedFiles.length > 0) {
    const avgRatio = result.convertedFiles
      .filter((f) => f.success)
      .reduce((sum, f) => sum + f.preservationRatio, 0) / Math.max(1, result.successCount);
    lines.push(``, `  Avg preservation ratio: ${(avgRatio * 100).toFixed(0)}%`);
  }

  lines.push(`════════════════════════════════════════════════`);
  return lines.join('\n');
}
