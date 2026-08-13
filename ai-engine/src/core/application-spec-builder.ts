// ============================================================
// CodeMorph AI Engine — Application Spec Builder
// PHASE 1-3: Exhaustive source analysis → Application Spec
//
// RULE: Must run BEFORE any code generation.
// The ApplicationSpec becomes the single source of truth
// for the entire reconstruction.
//
// Phases covered:
//   Phase 1: Exhaustive source scan
//   Phase 2: Build Application Spec (structured representation)
//   Phase 3: Extract critical values (URLs, configs, never placeholder)
// ============================================================

import type {
  ApplicationSpec, AppSpecRoute, AppSpecScreen, AppSpecComponent,
  AppSpecModel, AppSpecEndpoint, AppSpecService, AppSpecStore,
  AppSpecExternalService, AppSpecEnvVar,
} from '../models/ir.types';
import type { ASTResult } from './ast-analyzer';
import type { ArchResult } from './architecture-detector';
import type { IRGenerationResult } from './ir-generator';

// ── File marker splitter ─────────────────────────────────────────────────────
function splitSourceFiles(sourceCode: string): Map<string, string> {
  const result = new Map<string, string>();
  const filePattern = /\/\/\s*(?:=+\s*)?FILE:\s*(.+?)(?:\s*=+)?\n([\s\S]*?)(?=\/\/\s*(?:=+\s*)?FILE:|$)/g;
  let match: RegExpExecArray | null;
  while ((match = filePattern.exec(sourceCode)) !== null) {
    const path    = (match[1] ?? '').trim();
    const content = (match[2] ?? '').trim();
    if (path && content) result.set(path, content);
  }
  return result;
}

// ── Extract real API base URL from source ────────────────────────────────────
function extractBaseUrl(sourceFiles: Map<string, string>): string {
  // Priority 1: api_service.dart or similar
  for (const [path, content] of sourceFiles) {
    if (/api[_\s]?service|http[_\s]?client|dio[_\s]?config/i.test(path)) {
      const patterns = [
        /(?:baseUrl|_baseUrl|BASE_URL|kBaseUrl)\s*(?:=|:)\s*['"`]([^'"`,\s]{8,})['"`]/,
        /Uri\.parse\s*\(\s*['"`]([^'"`,\s]{8,})['"`]\s*\)/,
        /(?:baseUrl)\s*[:=]\s*['"`](https?:\/\/[^'"`,\s]+)['"`]/,
      ];
      for (const pat of patterns) {
        const m = content.match(pat);
        if (m?.[1] && m[1].startsWith('http')) return m[1];
      }
    }
  }
  // Priority 2: any file with https:// 
  for (const [, content] of sourceFiles) {
    const m = content.match(/['"`](https?:\/\/[a-zA-Z0-9._/-]{10,})['"`]/);
    if (m?.[1]) return m[1];
  }
  return '';
}

// ── Extract API endpoints from Dart source ───────────────────────────────────
function extractApiEndpoints(sourceFiles: Map<string, string>, baseUrl: string): AppSpecEndpoint[] {
  const endpoints: AppSpecEndpoint[] = [];
  const seen = new Set<string>();

  for (const [path, content] of sourceFiles) {
    if (!/service|repository|api|http|client/i.test(path)) continue;

    // Dart methods that call HTTP
    const methodPattern = /(?:Future<[^>]+>|Future)\s+(\w+)\s*\([^)]*\)\s*(?:async\s*)?\{[\s\S]*?(?:_dio|dio|http)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`,\s]+)['"`]/g;
    let m: RegExpExecArray | null;

    while ((m = methodPattern.exec(content)) !== null) {
      const methodName = m[1] ?? 'unknown';
      const httpMethod = (m[2] ?? 'GET').toUpperCase() as AppSpecEndpoint['method'];
      const endpointPath = m[3] ?? '';
      const key = `${httpMethod}:${endpointPath}`;
      if (seen.has(key)) continue;
      seen.add(key);

      endpoints.push({
        name:         methodName,
        method:       httpMethod,
        path:         endpointPath,
        fullUrl:      baseUrl ? `${baseUrl}${endpointPath}` : endpointPath,
        auth:         /(?:Authorization|Bearer|token|accessToken)/i.test(content),
        responseType: 'unknown',
        usedBy:       [],
      });
    }

    // Also scan for string endpoint paths (simpler patterns)
    const simpleEndpoint = /(?:get|post|put|patch|delete)\s*\(\s*['"`](\/[a-z][a-z0-9/_{}-]*)['"`]/gi;
    while ((m = simpleEndpoint.exec(content)) !== null) {
      const endpointPath = m[1] ?? '';
      // Detect method from context
      const httpMatch = content.slice(Math.max(0, (m.index ?? 0) - 10), (m.index ?? 0) + 10).match(/(get|post|put|patch|delete)/i);
      const httpMethod = (httpMatch?.[1] ?? 'GET').toUpperCase() as AppSpecEndpoint['method'];
      const key = `${httpMethod}:${endpointPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const funcNameMatch = content.slice(0, m.index ?? 0).match(/(\w+)\s*\([^)]*\)\s*(?:async\s*)?\{[^{]*$/);
      endpoints.push({
        name:         funcNameMatch?.[1] ?? `endpoint_${endpoints.length + 1}`,
        method:       httpMethod,
        path:         endpointPath,
        fullUrl:      baseUrl ? `${baseUrl}${endpointPath}` : endpointPath,
        auth:         /Authorization|Bearer|token/i.test(content),
        responseType: 'unknown',
        usedBy:       [],
      });
    }
  }
  return endpoints;
}

// ── Extract models from Dart source ─────────────────────────────────────────
function extractModels(sourceFiles: Map<string, string>): AppSpecModel[] {
  const models: AppSpecModel[] = [];

  for (const [path, content] of sourceFiles) {
    if (!/model|entity|dto/i.test(path)) continue;

    // Dart class extraction
    const classPattern = /class\s+(\w+)(?:\s+extends\s+\w+)?\s*\{([\s\S]*?)\n\}/g;
    let m: RegExpExecArray | null;

    while ((m = classPattern.exec(content)) !== null) {
      const className = m[1] ?? '';
      const classBody = m[2] ?? '';
      if (!className || className.length < 2) continue;

      // Extract fields: "final String fieldName;" or "late String fieldName;"
      const fields: AppSpecModel['fields'] = [];
      const fieldPattern = /(?:final\s+|late\s+)?(\w+(?:<[^>]+>)?)\s+(\w+)\s*[;=]/g;
      let fm: RegExpExecArray | null;
      while ((fm = fieldPattern.exec(classBody)) !== null) {
        const type = fm[1] ?? 'dynamic';
        const name = fm[2] ?? '';
        if (!name || /^(?:static|const|factory|super|this)$/.test(name)) continue;
        fields.push({
          name,
          type,
          nullable: type.endsWith('?'),
        });
      }

      // Extract enums
      const enums: Record<string, string[]> = {};
      const enumPattern = /enum\s+(\w+)\s*\{([^}]+)\}/g;
      let em: RegExpExecArray | null;
      while ((em = enumPattern.exec(content)) !== null) {
        const enumName = em[1] ?? '';
        const enumVals = (em[2] ?? '').split(',').map((v) => v.trim().split(';')[0]?.trim() ?? '').filter(Boolean);
        if (enumName) enums[enumName] = enumVals;
      }

      if (fields.length > 0) {
        models.push({
          name:       className,
          sourcePath: path,
          fields,
          ...(Object.keys(enums).length > 0 ? { enums } : {}),
        });
      }
    }
  }
  return models;
}

// ── Extract screens from Dart source ─────────────────────────────────────────
function extractScreens(sourceFiles: Map<string, string>): AppSpecScreen[] {
  const screens: AppSpecScreen[] = [];

  for (const [path, content] of sourceFiles) {
    if (!/screen|page|view/i.test(path)) continue;

    // Screen name from class definition
    const classMatch = content.match(/class\s+(\w+(?:Screen|Page|View))/);
    if (!classMatch?.[1]) continue;
    const screenName = classMatch[1];

    // Extract API calls
    const apiCalls: string[] = [];
    const apiCallPattern = /ref\.(?:read|watch|listen)\s*\(\s*(\w+)(?:Provider|Notifier)\.notifier\)/g;
    let m: RegExpExecArray | null;
    while ((m = apiCallPattern.exec(content)) !== null) {
      if (m[1]) apiCalls.push(m[1]);
    }

    // Extract providers/stores used
    const stores: string[] = [];
    const providerPattern = /(?:ref\.watch|ref\.read|ref\.listen)\s*\(\s*(\w+(?:Provider|Notifier))/g;
    while ((m = providerPattern.exec(content)) !== null) {
      if (m[1] && !stores.includes(m[1])) stores.push(m[1]);
    }

    // Detect states (loading/error/empty)
    const states: string[] = [];
    if (/loading/i.test(content)) states.push('loading');
    if (/error/i.test(content))   states.push('error');
    if (/empty/i.test(content))   states.push('empty');
    if (/success/i.test(content)) states.push('success');

    // Detect special features
    const specialFeatures: string[] = [];
    if (/FlutterMap|MapLibre|GoogleMap/i.test(content))   specialFeatures.push('map');
    if (/MobileScanner|QrScanner|camera/i.test(content))   specialFeatures.push('camera/scanner');
    if (/Geolocator|LocationService|gps/i.test(content))   specialFeatures.push('gps');
    if (/TabController|TabBar/i.test(content))             specialFeatures.push('tabs');
    if (/DraggableScrollableSheet/i.test(content))         specialFeatures.push('draggable-sheet');
    if (/TextField|TextFormField/i.test(content))          specialFeatures.push('form');

    // Extract user events
    const userEvents: string[] = [];
    if (/onTap\s*:/i.test(content))        userEvents.push('onTap');
    if (/onPressed\s*:/i.test(content))    userEvents.push('onPressed');
    if (/onChanged\s*:/i.test(content))    userEvents.push('onChange');
    if (/onSubmitted\s*:/i.test(content))  userEvents.push('onSubmit');

    screens.push({
      name:            screenName,
      sourcePath:      path,
      route:           path.replace(/lib\/features\/(\w+)\/presentation\/screens\//, '/$1').replace('_screen.dart', ''),
      purpose:         `${screenName} — extracted from ${path}`,
      components:      [],
      stores,
      apiCalls,
      states,
      userEvents,
      validations:     [],
      specialFeatures,
    });
  }
  return screens;
}

// ── Extract services from Dart source ────────────────────────────────────────
function extractServices(sourceFiles: Map<string, string>): AppSpecService[] {
  const services: AppSpecService[] = [];

  for (const [path, content] of sourceFiles) {
    if (!/service/i.test(path)) continue;

    const classMatch = content.match(/class\s+(\w+Service)/);
    if (!classMatch?.[1]) continue;
    const serviceName = classMatch[1];

    // Extract public methods
    const methods: AppSpecService['methods'] = [];
    const methodPattern = /(?:Future<([^>]+)>|Future|void|String|bool|int|List<[^>]+>)\s+(\w+)\s*\(([^)]*)\)\s*(?:async\s*)?\{/g;
    let m: RegExpExecArray | null;
    while ((m = methodPattern.exec(content)) !== null) {
      const returns = m[1] ?? m[0]?.match(/^(\w+)/)?.[1] ?? 'void';
      const methodName = m[2] ?? '';
      const paramsStr  = m[3] ?? '';
      if (!methodName || methodName === 'build' || methodName.startsWith('_')) continue;
      const params = paramsStr.split(',')
        .map((p) => p.trim().split(/\s+/).pop() ?? '')
        .filter(Boolean);
      methods.push({ name: methodName, params, returns, isAsync: /Future/i.test(m[0] ?? '') });
    }

    services.push({
      name:             serviceName,
      sourcePath:       path,
      responsibility:   `Service extracted from ${path}`,
      methods:          methods.slice(0, 20),
      dependencies:     [],
    });
  }
  return services;
}

// ── Extract stores/providers from Dart (Riverpod) ────────────────────────────
function extractStores(sourceFiles: Map<string, string>): AppSpecStore[] {
  const stores: AppSpecStore[] = [];

  for (const [path, content] of sourceFiles) {
    if (!/provider|notifier|bloc|cubit|store/i.test(path)) continue;

    // StateNotifier classes
    const classPattern = /class\s+(\w+(?:Notifier|Bloc|Cubit))\s+extends\s+\w+<(\w+)>/g;
    let m: RegExpExecArray | null;
    while ((m = classPattern.exec(content)) !== null) {
      const storeName  = m[1] ?? '';
      const stateType  = m[2] ?? 'unknown';
      if (!storeName) continue;

      // Extract actions (public methods)
      const actions: string[] = [];
      const methodPattern = /(?:Future<void>|void|Future)\s+(\w+)\s*\([^)]*\)\s*(?:async\s*)?\{/g;
      let mm: RegExpExecArray | null;
      while ((mm = methodPattern.exec(content)) !== null) {
        const name = mm[1] ?? '';
        if (name && !name.startsWith('_') && !['build', 'dispose', 'init'].includes(name)) {
          actions.push(name);
        }
      }

      // Detect persistence (SharedPreferences, SecureStorage, Hive etc.)
      const persistence = /SharedPreferences|SecureStorage|Hive|Drift|Isar/i.test(content);

      // Detect effects (timers, streams)
      const effects: string[] = [];
      if (/Timer\.periodic|Timer\(/i.test(content)) effects.push('periodic-timer');
      if (/Stream\.|StreamSubscription/i.test(content)) effects.push('stream-subscription');
      if (/socket|WebSocket/i.test(content)) effects.push('websocket');

      stores.push({
        name:         storeName,
        sourcePath:   path,
        stateType,
        initialState: {},
        actions:      actions.slice(0, 20),
        selectors:    [],
        persistence,
        ...(effects.length > 0 ? { effects } : {}),
      });
    }
  }
  return stores;
}

// ── Extract theme/colors from Dart ─────────────────────────────────────────
function extractTheme(sourceFiles: Map<string, string>): ApplicationSpec['assets']['theme'] {
  const colors: Record<string, string> = {};
  const typography: Record<string, unknown> = {};
  const spacing: Record<string, number> = {};

  for (const [path, content] of sourceFiles) {
    if (!/theme|color|style|constant/i.test(path)) continue;

    // Extract Color(0xFFRRGGBB) → #RRGGBB
    const colorNamePat = /(?:static\s+const\s+)?(?:Color\s+)?(\w+)\s*=\s*(?:const\s+)?Color\s*\(\s*0xFF([0-9A-Fa-f]{6})\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = colorNamePat.exec(content)) !== null) {
      const name = m[1] ?? '';
      const hex  = m[2] ?? '';
      if (name && hex && !/^[_A-Z]{2,}$/.test(name)) {
        colors[name] = `#${hex}`;
      }
    }

    // Extract FontFamily
    const fontMatch = content.match(/fontFamily:\s*['"`]([^'"`,]+)['"`]/);
    if (fontMatch?.[1]) {
      typography['fontFamily'] = fontMatch[1];
    }

    // Extract fontSize constants
    const fontSizePat = /(?:const\s+)?(?:double\s+)?(\w*[Ff]ont\w*|kFont\w+|fontSize\w*)\s*=\s*([\d.]+)/g;
    while ((m = fontSizePat.exec(content)) !== null) {
      if (m[1] && m[2]) typography[m[1]] = parseFloat(m[2]);
    }
  }

  return { colors, typography, spacing };
}

// ── Extract critical configuration values ────────────────────────────────────
function extractCriticalValues(
  sourceFiles: Map<string, string>,
): ApplicationSpec['criticalValues'] {
  const values: ApplicationSpec['criticalValues'] = [];
  const seen = new Set<string>();

  // Patterns to find config values (key = value)
  const configPatterns: Array<{ pattern: RegExp; isSecret: boolean }> = [
    { pattern: /(?:baseUrl|BASE_URL|kBaseUrl|_baseUrl)\s*(?:=|:)\s*['"`](https?:\/\/[^'"`,\s]+)['"`]/g, isSecret: false },
    { pattern: /(?:apiKey|API_KEY|_apiKey)\s*(?:=|:)\s*['"`]([^'"`,\s]{10,})['"`]/g, isSecret: true  },
    { pattern: /(?:projectId|PROJECT_ID)\s*(?:=|:)\s*['"`]([^'"`,\s]{5,})['"`]/g,  isSecret: false },
    { pattern: /(?:bucketName|BUCKET_NAME|storageBucket)\s*(?:=|:)\s*['"`]([^'"`,\s]+)['"`]/g, isSecret: false },
    { pattern: /(?:senderId|SENDER_ID|fcmSenderId)\s*(?:=|:)\s*['"`]([^'"`,\s]+)['"`]/g, isSecret: false },
    { pattern: /(?:clientId|CLIENT_ID)\s*(?:=|:)\s*['"`]([^'"`,\s]+)['"`]/g, isSecret: true  },
    { pattern: /(?:socketUrl|WS_URL|wsUrl)\s*(?:=|:)\s*['"`](wss?:\/\/[^'"`,\s]+)['"`]/g, isSecret: false },
  ];

  for (const [filePath, content] of sourceFiles) {
    for (const { pattern, isSecret } of configPatterns) {
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(content)) !== null) {
        const key   = m[0]?.match(/(\w+)\s*(?:=|:)/)?.[1] ?? 'unknown';
        const value = m[1] ?? '';
        if (!value || seen.has(`${key}:${value}`)) continue;
        seen.add(`${key}:${value}`);
        values.push({
          key,
          value:    isSecret ? '[SECRET — masked in report]' : value,
          source:   filePath,
          isSecret,
        });
      }
    }
  }
  return values;
}

// ── Extract routes from GoRouter ─────────────────────────────────────────────
function extractRoutes(sourceFiles: Map<string, string>): AppSpecRoute[] {
  const routes: AppSpecRoute[] = [];
  const seen = new Set<string>();

  for (const [path, content] of sourceFiles) {
    if (!/router|routing|go_router/i.test(path)) continue;

    // GoRoute patterns: GoRoute(path: '/login', builder: ...LoginScreen)
    const goRoutePattern = /GoRoute\s*\(\s*path:\s*['"`]([^'"`,\s]+)['"`][\s\S]*?(?:builder|pageBuilder)[^(]*\([^)]*\)\s*(?:=>|{)[^}]*?(\w+Screen|\w+Page)/g;
    let m: RegExpExecArray | null;
    while ((m = goRoutePattern.exec(content)) !== null) {
      const routePath  = m[1] ?? '';
      const screenName = m[2] ?? '';
      if (!routePath || seen.has(routePath)) continue;
      seen.add(routePath);
      routes.push({ path: routePath, screen: screenName });
    }

    // Simpler: path: '/login' anywhere
    const simplePathPat = /path:\s*['"`](\/[a-z][a-z0-9/_-]*)['"`]/g;
    while ((m = simplePathPat.exec(content)) !== null) {
      const routePath = m[1] ?? '';
      if (!routePath || seen.has(routePath)) continue;
      seen.add(routePath);
      routes.push({ path: routePath, screen: routePath.slice(1).replace(/\//g, '_') + 'Screen' });
    }
  }
  return routes;
}

// ── Extract external services ─────────────────────────────────────────────────
function extractExternalServices(
  sourceFiles: Map<string, string>,
  ast: ASTResult,
): AppSpecExternalService[] {
  const services: AppSpecExternalService[] = [];

  // From AST
  for (const svc of ast.externalServices) {
    const type: AppSpecExternalService['type'] =
      /firebase/i.test(svc)    ? 'firebase'  :
      /supabase/i.test(svc)    ? 'supabase'  :
      /socket\.io|ws:/i.test(svc) ? 'websocket' :
      /sms|otp|infobip/i.test(svc) ? 'sms'    :
      /fcm|push|notification/i.test(svc) ? 'push' :
      /stripe|paypal|payment/i.test(svc) ? 'payment' :
      'other';
    services.push({
      name:        svc,
      type,
      configKeys:  [],
      description: `External service detected: ${svc}`,
      usedFor:     [],
    });
  }

  // Detect from source code
  const detections: Array<{ pattern: RegExp; name: string; type: AppSpecExternalService['type'] }> = [
    { pattern: /firebase_auth|FirebaseAuth/i,            name: 'Firebase Auth',     type: 'firebase'  },
    { pattern: /cloud_firestore|FirebaseFirestore/i,     name: 'Cloud Firestore',   type: 'firebase'  },
    { pattern: /firebase_storage|FirebaseStorage/i,      name: 'Firebase Storage',  type: 'firebase'  },
    { pattern: /firebase_messaging|FirebaseMessaging/i,  name: 'Firebase Messaging', type: 'push'    },
    { pattern: /infobip|InfoBip/i,                       name: 'Infobip SMS',       type: 'sms'       },
    { pattern: /twilio|Twilio/i,                         name: 'Twilio SMS',        type: 'sms'       },
    { pattern: /socket\.io|WebSocket/i,                  name: 'WebSocket',         type: 'websocket' },
    { pattern: /stripe|Stripe/i,                         name: 'Stripe',            type: 'payment'   },
    { pattern: /supabase|Supabase/i,                     name: 'Supabase',          type: 'supabase'  },
  ];

  const allCode = Array.from(sourceFiles.values()).join('\n');
  const existingNames = new Set(services.map((s) => s.name));

  for (const { pattern, name, type } of detections) {
    if (pattern.test(allCode) && !existingNames.has(name)) {
      existingNames.add(name);
      services.push({ name, type, configKeys: [], description: `Detected in source code`, usedFor: [] });
    }
  }
  return services;
}

// ── Extract components from Dart ─────────────────────────────────────────────
function extractComponents(sourceFiles: Map<string, string>): AppSpecComponent[] {
  const components: AppSpecComponent[] = [];

  for (const [path, content] of sourceFiles) {
    if (!/widget|component/i.test(path)) continue;

    const classPattern = /class\s+(\w+(?:Widget|Component|Card|Button|Item|Bar|Badge|Chip))/g;
    let m: RegExpExecArray | null;
    while ((m = classPattern.exec(content)) !== null) {
      const name = m[1] ?? '';
      if (!name) continue;
      components.push({
        name,
        sourcePath: path,
        type:       'shared',
        props:      [],
        description: `Widget extracted from ${path}`,
      });
    }
  }
  return components;
}

// ── Extract env vars ─────────────────────────────────────────────────────────
function extractEnvVars(
  sourceFiles: Map<string, string>,
  ast: ASTResult,
): AppSpecEnvVar[] {
  const vars: AppSpecEnvVar[] = [];
  const seen = new Set<string>();

  // From AST
  for (const key of ast.envVarKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    vars.push({
      key,
      description: `Environment variable detected in source`,
      required:    true,
      foundInSource: true,
    });
  }

  // Scan for dotenv patterns
  const envPattern = /(?:dotenv\.env\[|const String\s+)?['"`]([A-Z][A-Z0-9_]{3,})['"`](?:\s*\]|\s*=)/g;
  const allCode = Array.from(sourceFiles.values()).join('\n');
  let m: RegExpExecArray | null;
  while ((m = envPattern.exec(allCode)) !== null) {
    const key = m[1] ?? '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    vars.push({
      key,
      description: `Env variable found in source code`,
      required:    true,
      foundInSource: true,
    });
  }

  return vars;
}

// ────────────────────────────────────────────────────────────────────────────
// MAIN: buildApplicationSpec
// ────────────────────────────────────────────────────────────────────────────

export function buildApplicationSpec(
  sourceCode:    string,
  ast:           ASTResult,
  arch:          ArchResult,
  irResult:      IRGenerationResult,
  ctx: { sourceFramework: string; targetFramework: string; projectId: string },
): ApplicationSpec {
  console.log(`\n[AppSpecBuilder] === Phase 1-3: Building Application Spec ===`);

  const sourceFiles = splitSourceFiles(sourceCode);
  console.log(`[AppSpecBuilder] Source files parsed: ${sourceFiles.size}`);

  // ── Phase 3: Extract critical URLs and configurations ──────────────────────
  const baseUrl       = extractBaseUrl(sourceFiles);
  const criticalValues = extractCriticalValues(sourceFiles);
  console.log(`[AppSpecBuilder] Base URL detected: ${baseUrl || '(none)'}`);
  console.log(`[AppSpecBuilder] Critical values found: ${criticalValues.length}`);

  // ── Extract all layers ──────────────────────────────────────────────────────
  const screens   = extractScreens(sourceFiles);
  const routes    = extractRoutes(sourceFiles);
  const models    = extractModels(sourceFiles);
  const services  = extractServices(sourceFiles);
  const stores    = extractStores(sourceFiles);
  const components = extractComponents(sourceFiles);
  const externalServices = extractExternalServices(sourceFiles, ast);
  const envVars   = extractEnvVars(sourceFiles, ast);
  const theme     = extractTheme(sourceFiles);
  const endpoints = extractApiEndpoints(sourceFiles, baseUrl);

  console.log(`[AppSpecBuilder] Extracted:`);
  console.log(`  screens=${screens.length} routes=${routes.length} models=${models.length}`);
  console.log(`  services=${services.length} stores=${stores.length} components=${components.length}`);
  console.log(`  endpoints=${endpoints.length} envVars=${envVars.length} externalServices=${externalServices.length}`);
  console.log(`  colors=${Object.keys(theme.colors).length}`);

  // ── Detect auth type ────────────────────────────────────────────────────────
  const allSourceCode = Array.from(sourceFiles.values()).join('\n');
  const authType =
    /OTP|otp|verifyCode|VerifyOtp/i.test(allSourceCode) ? 'OTP + Phone number' :
    /google.*sign|GoogleSignIn/i.test(allSourceCode)    ? 'Google OAuth2'       :
    /facebook.*login|FacebookLogin/i.test(allSourceCode) ? 'Facebook OAuth2'    :
    /email.*password|signInWithEmailAndPassword/i.test(allSourceCode) ? 'Email + Password' :
    'JWT Bearer Token';

  const tokenStorage =
    /flutter_secure_storage|SecureStorage/i.test(allSourceCode) ? 'SecureStorage' :
    /shared_preferences|SharedPreferences/i.test(allSourceCode) ? 'SharedPreferences' :
    'AsyncStorage';

  // ── Build auth flow from screens ────────────────────────────────────────────
  const loginScreen  = screens.find((s) => /login/i.test(s.name));
  const otpScreen    = screens.find((s) => /otp/i.test(s.name));
  const loginFlow    = [
    loginScreen?.name   ?? 'login',
    ...(otpScreen ? [otpScreen.name] : []),
    'authenticated',
  ];

  // ── Detect missing info ─────────────────────────────────────────────────────
  const missingInfo: ApplicationSpec['missingInfo'] = [];
  if (!baseUrl) {
    missingInfo.push({
      key:         'API_BASE_URL',
      description: 'No API base URL found in source code. Services cannot be reconstructed without it.',
      impact:      'critical',
    });
  }
  if (externalServices.length > 0 && envVars.length === 0) {
    missingInfo.push({
      key:         'EXTERNAL_SERVICE_CONFIG',
      description: `${externalServices.length} external services detected but no env vars found. Configuration keys needed.`,
      impact:      'high',
    });
  }

  // ── Build navigation spec ────────────────────────────────────────────────────
  const navPattern = ast.navigationPattern || 'unknown';
  const hasShellRoute = /ShellRoute|BottomNav/i.test(allSourceCode);

  const spec: ApplicationSpec = {
    app: {
      name:             ctx.projectId,
      platform:         'mobile',
      architecture:     arch.pattern ?? 'Feature-based',
      sourceFramework:  ctx.sourceFramework,
      targetFramework:  ctx.targetFramework,
    },
    navigation: {
      pattern:    navPattern,
      routes:     routes.length > 0 ? routes : irResult.ir.uiGraph?.navigationFlow?.map((nf) => ({
        path:   nf.from,
        screen: nf.to,
        guard:  nf.guard,
      } as AppSpecRoute)) ?? [],
      guards:     [
        ...(hasShellRoute ? ['AuthGuard (redirect to login if not authenticated)'] : []),
        ...ast.authPatterns,
      ],
    },
    screens,
    components,
    models: models.length > 0 ? models :
      (irResult.ir.dataLayer?.models ?? []).map((m) => ({
        name:       m.name,
        sourcePath: 'from IR',
        fields:     (m.fields ?? []).map((f) => ({ name: f.name, type: f.type, nullable: !!f.nullable })),
      })),
    api: {
      baseUrl,
      authType:  /Bearer|JWT/i.test(authType) ? 'Bearer JWT' : authType,
      headers:   { 'Content-Type': 'application/json', ...(baseUrl ? { Authorization: 'Bearer <token>' } : {}) },
      endpoints: endpoints.length > 0 ? endpoints :
        (irResult.ir.backendGraph?.routes ?? []).map((r) => ({
          name:         r.handler,
          method:       r.method,
          path:         r.path,
          fullUrl:      baseUrl ? `${baseUrl}${r.path}` : r.path,
          auth:         r.guards?.includes('auth') ?? false,
          responseType: r.response ?? 'unknown',
          usedBy:       [],
        })),
    },
    services,
    state: stores,
    auth: {
      type:              authType,
      loginFlow,
      logoutFlow:        ['clear_token', 'clear_user', 'navigate_to_login'],
      tokenStorage,
      sessionPersistence: /persist|SharedPreferences|SecureStorage/i.test(allSourceCode),
      guards:            ['isAuthenticated', ...(hasShellRoute ? ['shellRouteGuard'] : [])],
    },
    externalServices,
    config: {
      envVars,
      buildConfig:  {},
      featureFlags: {},
    },
    assets: {
      images: ast.assetFiles.filter((f) => /\.(png|jpg|jpeg|webp|gif)$/i.test(f)),
      icons:  ast.assetFiles.filter((f) => /\.(svg|ico)$/i.test(f)),
      fonts:  ast.assetFiles.filter((f) => /\.(ttf|otf|woff|woff2)$/i.test(f)),
      theme,
    },
    permissions: {
      ...(/CAMERA|ACCESS_FINE_LOCATION|READ_EXTERNAL_STORAGE/gi.test(allSourceCode)
        ? { android: (allSourceCode.match(/android\.permission\.(\w+)/g) ?? []).map((p) => p.replace('android.permission.', '')) }
        : {}),
      ...(/NSCameraUsageDescription|NSLocationWhenInUseUsageDescription/gi.test(allSourceCode)
        ? { ios: (allSourceCode.match(/NS\w+UsageDescription/g) ?? []) as string[] }
        : {}),
    },
    criticalValues,
    missingInfo,
  };

  console.log(`[AppSpecBuilder] ApplicationSpec built successfully`);
  console.log(`  screens=${spec.screens.length} routes=${spec.navigation.routes.length}`);
  console.log(`  api.endpoints=${spec.api.endpoints.length} api.baseUrl=${spec.api.baseUrl || '(none)'}`);
  console.log(`  stores=${spec.state.length} services=${spec.services.length}`);
  console.log(`  models=${spec.models.length} externalServices=${spec.externalServices.length}`);
  console.log(`  criticalValues=${spec.criticalValues.length} missingInfo=${spec.missingInfo.length}`);
  if (spec.missingInfo.length > 0) {
    for (const mi of spec.missingInfo) {
      console.warn(`[AppSpecBuilder] MISSING [${mi.impact.toUpperCase()}]: ${mi.key} — ${mi.description}`);
    }
  }
  console.log(`[AppSpecBuilder] === Phase 1-3 Complete ===\n`);
  return spec;
}

// ── Helper: summarize spec for IR prompt injection ───────────────────────────
export function summarizeSpecForPrompt(spec: ApplicationSpec): string {
  const lines = [
    `APPLICATION_SPEC_SUMMARY:`,
    `  app: ${spec.app.name} (${spec.app.sourceFramework} → ${spec.app.targetFramework})`,
    `  screens: ${spec.screens.map((s) => s.name).join(', ')}`,
    `  routes: ${spec.navigation.routes.map((r) => r.path).join(', ')}`,
    `  api_base_url: ${spec.api.baseUrl || 'NOT_FOUND'}`,
    `  api_endpoints: ${spec.api.endpoints.map((e) => `${e.method} ${e.path}`).join(', ')}`,
    `  services: ${spec.services.map((s) => s.name).join(', ')}`,
    `  stores: ${spec.state.map((s) => s.name).join(', ')}`,
    `  models: ${spec.models.map((m) => m.name).join(', ')}`,
    `  auth_type: ${spec.auth.type}`,
    `  auth_token_storage: ${spec.auth.tokenStorage}`,
    `  external_services: ${spec.externalServices.map((s) => s.name).join(', ')}`,
    `  theme_colors: ${Object.keys(spec.assets.theme.colors).length} colors`,
    spec.missingInfo.length > 0
      ? `  MISSING_CRITICAL: ${spec.missingInfo.filter((m) => m.impact === 'critical').map((m) => m.key).join(', ')}`
      : '',
  ].filter(Boolean);
  return lines.join('\n');
}
