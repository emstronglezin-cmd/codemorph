// ============================================================
// CodeMorph AI Engine — Functional Test Runner (Phase 8)
// Évalue les fonctionnalités principales de l'application
// convertie et produit un TestResultsReport avec statuts
// PASS / PARTIAL / FAIL / NOT_TESTABLE.
//
// RÈGLE ABSOLUE :
//   - NOT_TESTABLE ≠ PASS (jamais converti)
//   - Un test FAIL ne bloque pas les tests suivants
//   - Un SHELL file → test FAIL automatique pour la feature
// ============================================================

import type {
  GeneratedFile,
  IRFidelityScore,
  ContentValidationReport,
  ApplicationSpec,
  TestResultsReport,
  FunctionalTestResult,
  TestStatus,
} from '../models/ir.types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function hasFile(files: GeneratedFile[], pattern: RegExp): boolean {
  return files.some((f) => pattern.test(f.path));
}

function hasFileWithContent(files: GeneratedFile[], pathPattern: RegExp, contentPattern: RegExp): boolean {
  return files.some(
    (f) => pathPattern.test(f.path) && contentPattern.test(f.content),
  );
}

function isShell(file: GeneratedFile): boolean {
  const SHELL_MARKERS = [
    /Error:\s*401\s*status\s*code/i,
    /CONVERSION\s*INCOMPLETE/i,
    /AI\s*conversion\s*failed/i,
    /HTTP\s*401/i,
    /Error: 4\d\d/,
  ];
  // Heuristic: >70% comment lines AND dart code in comments
  const lines = file.content.split('\n');
  const commentLines = lines.filter((l) => /^\s*(\/\/|\/\*|\*)/.test(l)).length;
  const commentRatio = lines.length > 0 ? commentLines / lines.length : 0;
  const hasDartInComments = /\/\/.*import\s+'package:|\/\/.*class\s+\w+\s+(extends|with|implements)/.test(file.content);
  if (commentRatio > 0.7 && hasDartInComments) return true;
  return SHELL_MARKERS.some((re) => re.test(file.content));
}



function hasRealApiUrl(files: GeneratedFile[]): boolean {
  return files.some((f) =>
    /https?:\/\/(?!example\.com|localhost|YOUR_|TODO|MOCK|dummy)[a-zA-Z0-9.-]+/.test(f.content),
  );
}

function hasSourceResiduals(files: GeneratedFile[]): boolean {
  return files.some((f) =>
    /import\s+['"]package:[a-z_]+\//.test(f.content) ||
    /import\s+['"]dart:[a-z]+/.test(f.content),
  );
}

// ── Test definitions ─────────────────────────────────────────────────────────

interface TestDef {
  feature: string;
  run: (
    files:             GeneratedFile[],
    fidelityScore:     IRFidelityScore | undefined,
    contentValidation: ContentValidationReport | undefined,
    appSpec:           ApplicationSpec | undefined,
  ) => FunctionalTestResult;
}

const TESTS: TestDef[] = [

  // ── T01: App launches ─────────────────────────────────────────────────────
  {
    feature: 'App bootstrap (entry point)',
    run(files) {
      const hasEntry = hasFile(files, /\/(app|index|_layout)\.(tsx?|jsx?)$/)
        || hasFile(files, /App\.(tsx?|jsx?)$/);
      if (!hasEntry) {
        return { feature: 'App bootstrap (entry point)', status: 'FAIL', detail: 'No entry file found (app.tsx / App.tsx / _layout.tsx / index.tsx)' };
      }
      const entryFile = files.find((f) => /\/(app|index|_layout)\.(tsx?|jsx?)$/.test(f.path) || /App\.(tsx?|jsx?)$/.test(f.path))!;
      if (isShell(entryFile)) {
        return { feature: 'App bootstrap (entry point)', status: 'FAIL', detail: 'Entry file is a SHELL_401 — not generated', blockedBy: 'SHELL_401' };
      }
      return { feature: 'App bootstrap (entry point)', status: 'PASS', detail: `Entry point found: ${entryFile.path}` };
    },
  },

  // ── T02: Navigation ───────────────────────────────────────────────────────
  {
    feature: 'Navigation (routing)',
    run(files, fidelityScore, _cv, _appSpec) {
      const layoutFiles = files.filter((f) => /_layout\.(tsx?|jsx?)$/.test(f.path));
      if (layoutFiles.length === 0) {
        return { feature: 'Navigation (routing)', status: 'FAIL', detail: 'No _layout.tsx files found (Expo Router structure missing)' };
      }
      const shellLayouts = layoutFiles.filter(isShell).length;
      if (shellLayouts === layoutFiles.length) {
        return { feature: 'Navigation (routing)', status: 'FAIL', detail: `All ${layoutFiles.length} layout files are SHELL_401`, blockedBy: 'SHELL_401' };
      }
      const navScore = fidelityScore?.navigation ?? null;
      if (navScore !== null && navScore >= 80) {
        return { feature: 'Navigation (routing)', status: 'PASS', detail: `${layoutFiles.length - shellLayouts}/${layoutFiles.length} layouts valid, nav score=${navScore}%` };
      }
      if (navScore !== null && navScore >= 40) {
        return { feature: 'Navigation (routing)', status: 'PARTIAL', detail: `${layoutFiles.length - shellLayouts}/${layoutFiles.length} layouts valid, nav score=${navScore}%` };
      }
      return {
        feature: 'Navigation (routing)',
        status: layoutFiles.length - shellLayouts >= 1 ? 'PARTIAL' : 'FAIL',
        detail: `${layoutFiles.length - shellLayouts}/${layoutFiles.length} valid layouts, nav score=${navScore ?? 'N/A'}%`,
      };
    },
  },

  // ── T03: Authentication ───────────────────────────────────────────────────
  {
    feature: 'Authentication (login / logout / session)',
    run(files, _fs, _cv, appSpec) {
      // If no auth in source, NOT_TESTABLE
      if (appSpec && appSpec.auth?.type === 'none') {
        return { feature: 'Authentication (login / logout / session)', status: 'NOT_TESTABLE', detail: 'Source app has no authentication' };
      }
      const authFiles = files.filter((f) =>
        /auth|login|logout|session|token/i.test(f.path),
      );
      if (authFiles.length === 0) {
        return { feature: 'Authentication (login / logout / session)', status: 'FAIL', detail: 'No auth-related files found' };
      }
      const shellAuth = authFiles.filter(isShell).length;
      if (shellAuth === authFiles.length) {
        return { feature: 'Authentication (login / logout / session)', status: 'FAIL', detail: `All ${authFiles.length} auth files are SHELL_401`, blockedBy: 'SHELL_401' };
      }
      const hasLoginHandler = hasFileWithContent(files, /auth|login/i, /signIn|login|authenticate|token/i);
      const hasLogoutHandler = hasFileWithContent(files, /auth|logout/i, /signOut|logout|clearToken/i);
      const hasTokenStorage = hasFileWithContent(files, /./, /AsyncStorage|SecureStore|localStorage|sessionStorage/i);
      const checks = [hasLoginHandler, hasLogoutHandler, hasTokenStorage].filter(Boolean).length;
      if (checks === 3) return { feature: 'Authentication (login / logout / session)', status: 'PASS', detail: `${authFiles.length - shellAuth}/${authFiles.length} auth files valid, login+logout+token storage detected` };
      if (checks >= 1) return { feature: 'Authentication (login / logout / session)', status: 'PARTIAL', detail: `${checks}/3 auth mechanisms detected (login=${hasLoginHandler}, logout=${hasLogoutHandler}, storage=${hasTokenStorage})` };
      return { feature: 'Authentication (login / logout / session)', status: 'FAIL', detail: 'Auth files present but no login/logout/token patterns detected' };
    },
  },

  // ── T04: API Layer ────────────────────────────────────────────────────────
  {
    feature: 'API / Network layer',
    run(files, fidelityScore, _cv, _appSpec) {
      const apiFiles = files.filter((f) =>
        /api|service|http|client|axios|fetch/i.test(f.path),
      );
      if (apiFiles.length === 0) {
        return { feature: 'API / Network layer', status: 'FAIL', detail: 'No API service files found' };
      }
      const shellApi = apiFiles.filter(isShell).length;
      if (shellApi === apiFiles.length) {
        return { feature: 'API / Network layer', status: 'FAIL', detail: `All ${apiFiles.length} API files are SHELL_401`, blockedBy: 'SHELL_401' };
      }
      const hasRealUrl = hasRealApiUrl(files);
      const hasAxiosOrFetch = hasFileWithContent(files, /api|service/i, /axios|fetch\(|createClient|new\s+HttpClient/i);
      const hasSourceResidual = hasSourceResiduals(files);
      const apiScore = fidelityScore?.api ?? null;
      // Detect placeholder URLs
      const hasPlaceholders = files.some((f) =>
        /YOUR_API_URL|example\.com\/api|YOUR_BASE_URL|http:\/\/localhost:3000/.test(f.content),
      );
      if (hasSourceResidual) {
        return { feature: 'API / Network layer', status: 'FAIL', detail: 'Dart/Flutter imports detected in API files — conversion incomplete', blockedBy: 'SOURCE_RESIDUAL' };
      }
      if (hasRealUrl && hasAxiosOrFetch && !hasPlaceholders) {
        return { feature: 'API / Network layer', status: 'PASS', detail: `${apiFiles.length - shellApi}/${apiFiles.length} API files valid, real URL + axios/fetch detected, score=${apiScore ?? 'N/A'}%` };
      }
      if (hasAxiosOrFetch) {
        const detail = hasPlaceholders ? 'Placeholder URLs detected (YOUR_API_URL / example.com)' : 'Real URL not detected — may need configuration';
        return { feature: 'API / Network layer', status: 'PARTIAL', detail };
      }
      return { feature: 'API / Network layer', status: 'FAIL', detail: 'API files present but no axios/fetch usage detected' };
    },
  },

  // ── T05: Data Models ──────────────────────────────────────────────────────
  {
    feature: 'Data models (TypeScript interfaces/types)',
    run(files, fidelityScore, _cv_nav?, _appSpec_nav?) {
      const modelFiles = files.filter((f) =>
        /\.types\.(ts|js)$|\/types\/|\/models\/|\.model\.(ts|js)$/.test(f.path),
      );
      if (modelFiles.length === 0) {
        return { feature: 'Data models (TypeScript interfaces/types)', status: 'FAIL', detail: 'No model/type files found' };
      }
      const shellModels = modelFiles.filter(isShell).length;
      const validModels = modelFiles.length - shellModels;
      const hasInterfaces = hasFileWithContent(files, /types|models/i, /interface\s+\w+|type\s+\w+\s*=|export\s+type\s+\w+/i);
      const modelScore = fidelityScore?.models ?? null;
      if (shellModels === modelFiles.length) {
        return { feature: 'Data models (TypeScript interfaces/types)', status: 'FAIL', detail: `All ${modelFiles.length} model files are SHELL_401`, blockedBy: 'SHELL_401' };
      }
      if (validModels > 0 && hasInterfaces) {
        const status: TestStatus = (modelScore !== null && modelScore >= 80) ? 'PASS' : 'PARTIAL';
        return { feature: 'Data models (TypeScript interfaces/types)', status, detail: `${validModels}/${modelFiles.length} model files valid with TS interfaces, score=${modelScore ?? 'N/A'}%` };
      }
      return { feature: 'Data models (TypeScript interfaces/types)', status: 'PARTIAL', detail: `${validModels}/${modelFiles.length} model files valid but no TS interface patterns` };
    },
  },

  // ── T06: State Management ─────────────────────────────────────────────────
  {
    feature: 'State management (Zustand stores)',
    run(files, fidelityScore) {
      const storeFiles = files.filter((f) => /\.store\.(ts|js)$|\/stores?\//i.test(f.path));
      if (storeFiles.length === 0) {
        // Check if source used stores at all
        return { feature: 'State management (Zustand stores)', status: 'NOT_TESTABLE', detail: 'No store files found — may not be applicable to this project' };
      }
      const shellStores = storeFiles.filter(isShell).length;
      if (shellStores === storeFiles.length) {
        return { feature: 'State management (Zustand stores)', status: 'FAIL', detail: `All ${storeFiles.length} store files are SHELL_401`, blockedBy: 'SHELL_401' };
      }
      const hasZustand = hasFileWithContent(files, /store/i, /create\s*\(|zustand|createStore|useStore/i);
      const storeScore = fidelityScore?.stores ?? null;
      const validStores = storeFiles.length - shellStores;
      if (hasZustand && validStores > 0) {
        const status: TestStatus = (storeScore !== null && storeScore >= 70) ? 'PASS' : 'PARTIAL';
        return { feature: 'State management (Zustand stores)', status, detail: `${validStores}/${storeFiles.length} stores valid, Zustand detected, score=${storeScore ?? 'N/A'}%` };
      }
      return { feature: 'State management (Zustand stores)', status: 'PARTIAL', detail: `${validStores}/${storeFiles.length} store files valid but Zustand pattern not detected` };
    },
  },

  // ── T07: Services ─────────────────────────────────────────────────────────
  {
    feature: 'Services (business logic layer)',
    run(files, fidelityScore) {
      const serviceFiles = files.filter((f) => /\.service\.(ts|js)$|\/services?\//i.test(f.path));
      if (serviceFiles.length === 0) {
        return { feature: 'Services (business logic layer)', status: 'FAIL', detail: 'No service files found' };
      }
      const shellServices = serviceFiles.filter(isShell).length;
      if (shellServices === serviceFiles.length) {
        return { feature: 'Services (business logic layer)', status: 'FAIL', detail: `All ${serviceFiles.length} service files are SHELL_401`, blockedBy: 'SHELL_401' };
      }
      const serviceScore = fidelityScore?.services ?? null;
      const validServices = serviceFiles.length - shellServices;
      const status: TestStatus = validServices === serviceFiles.length
        ? (serviceScore !== null && serviceScore >= 70 ? 'PASS' : 'PARTIAL')
        : (validServices > 0 ? 'PARTIAL' : 'FAIL');
      return { feature: 'Services (business logic layer)', status, detail: `${validServices}/${serviceFiles.length} service files valid, score=${serviceScore ?? 'N/A'}%` };
    },
  },

  // ── T08: Screens ──────────────────────────────────────────────────────────
  {
    feature: 'Screens (UI components)',
    run(files, fidelityScore) {
      const screenPattern = /\/(screens?|pages?)\//i;
      const screenExclude = /_layout|index\.(tsx?|jsx?)$/;
      const screenFiles = files.filter((f) => screenPattern.test(f.path) && !screenExclude.test(f.path));
      if (screenFiles.length === 0) {
        return { feature: 'Screens (UI components)', status: 'FAIL', detail: 'No screen files found' };
      }
      const shellScreens = screenFiles.filter(isShell).length;
      if (shellScreens === screenFiles.length) {
        return { feature: 'Screens (UI components)', status: 'FAIL', detail: `All ${screenFiles.length} screens are SHELL_401`, blockedBy: 'SHELL_401' };
      }
      const hasComponents = hasFileWithContent(files, screenPattern, /return\s*\(|React\.FC|export\s+default\s+function\s+\w+/i);
      const uiScore = fidelityScore?.uiFidelity ?? null;
      const validScreens = screenFiles.length - shellScreens;
      if (validScreens > 0 && hasComponents) {
        const status: TestStatus = (uiScore !== null && uiScore >= 70) ? 'PASS' : 'PARTIAL';
        return { feature: 'Screens (UI components)', status, detail: `${validScreens}/${screenFiles.length} screens valid, React components detected, uiFidelity=${uiScore ?? 'N/A'}%` };
      }
      return { feature: 'Screens (UI components)', status: 'PARTIAL', detail: `${validScreens}/${screenFiles.length} screens valid` };
    },
  },

  // ── T09: TypeScript compilation (static) ──────────────────────────────────
  {
    feature: 'TypeScript compilation (static check)',
    run(files) {
      const tsFiles = files.filter((f) => /\.(tsx?|jsx?)$/.test(f.path));
      if (tsFiles.length === 0) {
        return { feature: 'TypeScript compilation (static check)', status: 'NOT_TESTABLE', detail: 'No TypeScript/JSX files found' };
      }
      // Check source residuals (Dart imports in TS files)
      const sourceImports = tsFiles.filter((f) =>
        /import\s+['"]package:[a-z_]+\//.test(f.content) ||
        /import\s+['"]dart:[a-z]+/.test(f.content),
      );
      if (sourceImports.length > 0) {
        return {
          feature: 'TypeScript compilation (static check)',
          status: 'FAIL',
          detail: `${sourceImports.length} file(s) with Dart imports in TypeScript: ${sourceImports.slice(0, 3).map((f) => f.path).join(', ')}`,
          blockedBy: 'SOURCE_IMPORTS',
        };
      }
      // Check for obvious syntax issues
      const shellTs = tsFiles.filter(isShell).length;
      const shellRatio = shellTs / tsFiles.length;
      if (shellRatio > 0.5) {
        return {
          feature: 'TypeScript compilation (static check)',
          status: 'FAIL',
          detail: `${shellTs}/${tsFiles.length} TS files are SHELL_401 (>50%) — compilation would fail`,
          blockedBy: 'SHELL_401',
        };
      }
      if (shellTs > 0) {
        return {
          feature: 'TypeScript compilation (static check)',
          status: 'PARTIAL',
          detail: `${tsFiles.length - shellTs}/${tsFiles.length} TS files appear valid, ${shellTs} SHELL files may cause errors`,
        };
      }
      return {
        feature: 'TypeScript compilation (static check)',
        status: 'PASS',
        detail: `${tsFiles.length} TS/JSX files — no Dart imports, no SHELL files detected (runtime tsc not executed)`,
      };
    },
  },

  // ── T10: Configuration transfer ───────────────────────────────────────────
  {
    feature: 'Configuration (env vars, API keys, base URLs)',
    run(files, _fs, _cv, appSpec) {
      const configFiles = files.filter((f) =>
        /\.env|app\.config|app\.json|constants\.|config\./i.test(f.path),
      );
      if (configFiles.length === 0) {
        return { feature: 'Configuration (env vars, API keys, base URLs)', status: 'FAIL', detail: 'No configuration files found (.env, app.config, constants.ts, etc.)' };
      }
      // Check for placeholder values
      const placeholderCount = files.reduce((acc, f) => {
        const matches = f.content.match(/YOUR_API_KEY|YOUR_BASE_URL|example\.com\/api|PLACEHOLDER|TODO.*URL/gi);
        return acc + (matches?.length ?? 0);
      }, 0);
      const hasRealUrl = hasRealApiUrl(files);
      const sourceBaseUrl = appSpec?.api?.baseUrl;
      const urlPreserved = sourceBaseUrl
        ? files.some((f) => f.content.includes(sourceBaseUrl))
        : hasRealUrl;
      if (placeholderCount > 3) {
        return { feature: 'Configuration (env vars, API keys, base URLs)', status: 'FAIL', detail: `${placeholderCount} placeholder values detected — real config not transferred` };
      }
      if (urlPreserved && placeholderCount === 0) {
        return { feature: 'Configuration (env vars, API keys, base URLs)', status: 'PASS', detail: `Config files present, real URLs preserved, no placeholders` };
      }
      return { feature: 'Configuration (env vars, API keys, base URLs)', status: 'PARTIAL', detail: `Config files present, ${placeholderCount} placeholders, URL preserved=${urlPreserved}` };
    },
  },

  // ── T11: External services (Firebase, Infobip, etc.) ─────────────────────
  {
    feature: 'External services integration',
    run(files, _fs, _cv, appSpec) {
      const extServices = appSpec?.externalServices ?? [];
      if (extServices.length === 0) {
        // Try to auto-detect
        const hasFirebase = hasFileWithContent(files, /./, /firebase|initializeApp|getAuth|getFirestore/i);
        if (!hasFirebase) {
          return { feature: 'External services integration', status: 'NOT_TESTABLE', detail: 'No external services detected in source' };
        }
        return { feature: 'External services integration', status: 'PARTIAL', detail: 'Firebase patterns detected but ApplicationSpec not available for full validation' };
      }
      const results: string[] = [];
      let passed = 0;
      let failed = 0;
      for (const svc of extServices.slice(0, 5)) {
        const svcName = svc.name ?? svc.type ?? 'unknown';
        const hasIntegration = files.some((f) =>
          new RegExp(svcName.toLowerCase().replace(/[^a-z0-9]/g, '.*'), 'i').test(f.content),
        );
        if (hasIntegration) {
          passed++;
          results.push(`${svcName}=✅`);
        } else {
          failed++;
          results.push(`${svcName}=❌`);
        }
      }
      const status: TestStatus = failed === 0 ? 'PASS' : passed > 0 ? 'PARTIAL' : 'FAIL';
      return { feature: 'External services integration', status, detail: `External services: ${results.join(', ')}` };
    },
  },

  // ── T12: Source residuals (final gate) ────────────────────────────────────
  {
    feature: 'No source-language residuals (Dart/Flutter imports)',
    run(files) {
      const tsFiles = files.filter((f) => /\.(tsx?|jsx?)$/.test(f.path));
      const dartImports = tsFiles.filter((f) =>
        /import\s+['"]package:[a-z_]+\//.test(f.content),
      );
      const dartLangImports = tsFiles.filter((f) =>
        /import\s+['"]dart:[a-z]+/.test(f.content),
      );
      const flutterRefs = tsFiles.filter((f) =>
        /from\s+['"]flutter_|from\s+['"]riverpod\/|from\s+['"]go_router\//.test(f.content),
      );
      const total = dartImports.length + dartLangImports.length + flutterRefs.length;
      if (total === 0) {
        return { feature: 'No source-language residuals (Dart/Flutter imports)', status: 'PASS', detail: 'No Dart/Flutter imports found in TypeScript files' };
      }
      const examples = [
        ...dartImports.slice(0, 2).map((f) => f.path),
        ...flutterRefs.slice(0, 2).map((f) => f.path),
      ];
      return {
        feature: 'No source-language residuals (Dart/Flutter imports)',
        status: 'FAIL',
        detail: `${total} file(s) with Dart/Flutter residuals: ${examples.join(', ')}`,
        blockedBy: 'SOURCE_RESIDUAL',
      };
    },
  },
];

// ── Compute overall status ────────────────────────────────────────────────────

function computeOverallStatus(tests: FunctionalTestResult[]): TestStatus {
  const actionable = tests.filter((t) => t.status !== 'NOT_TESTABLE');
  if (actionable.length === 0) return 'NOT_TESTABLE' as TestStatus;
  const allPass = actionable.every((t) => t.status === 'PASS');
  if (allPass) return 'PASS' as TestStatus;
  const anyFail = actionable.some((t) => t.status === 'FAIL');
  const anyPartial = actionable.some((t) => t.status === 'PARTIAL');
  if (!anyFail && anyPartial) return 'PARTIAL' as TestStatus;
  if (anyFail) {
    const failCount = actionable.filter((t) => t.status === 'FAIL').length;
    return failCount > actionable.length / 2 ? 'FAIL' : 'PARTIAL';
  }
  return 'PARTIAL' as TestStatus;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Run all Phase 8 functional tests and produce a TestResultsReport.
 * Tests are deterministic (no network calls) — they inspect the generated
 * file set for structural evidence of each feature.
 *
 * RÈGLE : NOT_TESTABLE ≠ PASS, SHELL files → FAIL automatique.
 */
export function buildFunctionalTestResults(
  files:             GeneratedFile[],
  fidelityScore:     IRFidelityScore | undefined,
  contentValidation: ContentValidationReport | undefined,
  appSpec:           ApplicationSpec | undefined,
): TestResultsReport {
  const results: FunctionalTestResult[] = TESTS.map((t) =>
    t.run(files, fidelityScore, contentValidation, appSpec),
  );

  const passed      = results.filter((r) => r.status === 'PASS').length;
  const partial     = results.filter((r) => r.status === 'PARTIAL').length;
  const failed      = results.filter((r) => r.status === 'FAIL').length;
  const notTestable = results.filter((r) => r.status === 'NOT_TESTABLE').length;
  const overallStatus = computeOverallStatus(results);

  return {
    totalTests:    results.length,
    passed,
    partial,
    failed,
    notTestable,
    overallStatus,
    tests:         results,
  };
}

/**
 * Format a TestResultsReport as a human-readable string for console output.
 */
export function formatTestResultsReport(report: TestResultsReport): string {
  const lines: string[] = [];
  const statusIcon = (s: string) =>
    s === 'PASS' ? '✅' : s === 'PARTIAL' ? '🔶' : s === 'FAIL' ? '❌' : '⬜';

  lines.push('');
  lines.push('══════════════════ FUNCTIONAL TEST RESULTS (Phase 8) ══════════════════');
  lines.push(`  Total: ${report.totalTests} | PASS: ${report.passed} | PARTIAL: ${report.partial} | FAIL: ${report.failed} | N/A: ${report.notTestable}`);
  lines.push(`  Overall: ${statusIcon(report.overallStatus)} ${report.overallStatus}`);
  lines.push('────────────────────────────────────────────────────────────────────────');
  for (const t of report.tests) {
    const icon = statusIcon(t.status);
    lines.push(`  ${icon} ${t.status.padEnd(12)} ${t.feature}`);
    lines.push(`              ${t.detail}`);
    if (t.blockedBy) {
      lines.push(`              ⛔ Blocked by: ${t.blockedBy}`);
    }
  }
  lines.push('════════════════════════════════════════════════════════════════════════');
  lines.push('');
  return lines.join('\n');
}
