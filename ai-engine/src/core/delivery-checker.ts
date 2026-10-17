// ============================================================
// CodeMorph AI Engine — Delivery Checker
// PHASE 12: READY vs NEEDS_REPAIR evaluation
//
// STATUS = READY only if ALL mandatory checks pass:
//   ✅ Compilation passed (or NOT_TESTABLE with acceptable reason)
//   ✅ Zero source-language imports in target files
//   ✅ Zero SHELL_401 critical files (screens/services/stores/models)
//   ✅ Zero missing critical functionalities
//   ✅ Navigation functional
//   ✅ API layer present (or explicitly marked NOT_AVAILABLE with reason)
//   ✅ Configuration transferred (no placeholder URLs)
//
// STATUS = NEEDS_REPAIR if any of the above fail.
// The checker explains EXACTLY what blocks READY status.
// ============================================================

import type {
  GeneratedFile, IRFidelityScore, ContentValidationReport,
  StaticValidationResult, DeliveryCheckResult, ApplicationSpec,
  ProjectIntegrityReport,
} from '../models/ir.types';

// ── Critical file patterns that MUST be converted (not shells) ──────────────
const CRITICAL_FILE_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /\/(app|screens?)\/[^/]+\.(tsx?|jsx?)$/, category: 'screen' },
  { pattern: /\.service\.(ts|js)$/, category: 'service' },
  { pattern: /\.store\.(ts|js)$/,   category: 'store'   },
  { pattern: /\.types\.(ts|js)$|\/types\/[^/]+\.(ts|js)$/, category: 'model' },
  { pattern: /\/api\/[^/]+\.(ts|js)$|apiService/, category: 'api-service' },
];

// ── Check: has real navigation ────────────────────────────────────────────────
function checkNavigation(files: GeneratedFile[]): { pass: boolean; detail: string } {
  // Prioriser app/_layout.tsx (root layout Stack) sur app/(tabs)/_layout.tsx (tabs layout)
  const rootLayoutFile = files.find((f) => /^app\/_layout\.tsx?$/.test(f.path));
  const anyLayoutFile  = files.find((f) => /_layout\.tsx?$/.test(f.path));
  const layoutFile     = rootLayoutFile ?? anyLayoutFile;

  const hasNavContent = layoutFile
    ? layoutFile.content.includes('Stack.Screen') || layoutFile.content.includes('Tab.Screen') || layoutFile.content.includes('Drawer.Navigator')
    : false;

  if (!layoutFile) {
    return { pass: false, detail: 'No _layout.tsx / navigation root file found' };
  }
  if (!hasNavContent) {
    // ── FIX PHASE 45 — FAUX POSITIF sur Expo Router ────────────────────────
    // Expo Router est un routeur BASÉ SUR LES FICHIERS : `<Stack />` seul est
    // parfaitement valide, les routes sont dérivées de l'arborescence `app/`.
    // Exiger `Stack.Screen` déclarait à tort NEEDS_REPAIR tout projet Expo
    // Router correct. On n'accepte l'absence de Screen explicite que s'il existe
    // réellement des fichiers de route sous app/ — sinon l'échec est conservé.
    const routeFiles = files.filter((f) =>
      /^app\//.test(f.path) &&
      /\.(tsx?|jsx?)$/.test(f.path) &&
      !/_layout\.(tsx?|jsx?)$/.test(f.path));
    if (routeFiles.length > 0) {
      return {
        pass: true,
        detail: `Expo Router file-based navigation (${layoutFile.path}) with ` +
                `${routeFiles.length} route file(s) — explicit Screen definitions are optional`,
      };
    }
    return { pass: false, detail: `${layoutFile.path} exists but has no Screen definitions` };
  }
  const screenCount = (layoutFile.content.match(/Stack\.Screen|Tab\.Screen/g) ?? []).length;
  return { pass: true, detail: `Navigation root (${layoutFile.path}) found with ${screenCount} screen(s)` };
}

// ── Check: API layer is present ───────────────────────────────────────────────
function checkApiLayer(
  files: GeneratedFile[],
  contentReport: ContentValidationReport,
): { pass: boolean; detail: string } {
  const apiFiles = files.filter((f) =>
    /service|api|client/i.test(f.path) &&
    /\.(ts|js)$/.test(f.path)
  );

  if (apiFiles.length === 0) {
    return { pass: false, detail: 'No API service files found' };
  }

  // Check they're not all shells
  const shellApiFiles = contentReport.files.filter((v) =>
    (v.status === 'shell_401' || v.status === 'source_residual') &&
    /service|api|client/i.test(v.path)
  ).length;

  if (shellApiFiles === apiFiles.length) {
    return {
      pass: false,
      detail: `${shellApiFiles}/${apiFiles.length} API service file(s) are SHELL_401 — no real API layer`,
    };
  }

  const realApiFiles = apiFiles.length - shellApiFiles;
  return { pass: true, detail: `${realApiFiles} real API service file(s) found` };
}

// ── Check: configuration transferred ─────────────────────────────────────────
function checkConfig(
  files: GeneratedFile[],
  appSpec?: ApplicationSpec,
): { pass: boolean; detail: string } {
  const blockers: string[] = [];

  // Check for placeholder URLs
  const allContent = files.map((f) => f.content).join('\n');
  if (/https?:\/\/example\.com/i.test(allContent)) {
    blockers.push('Placeholder URL "example.com" found — real API URL not transferred');
  }
  if (/YOUR_API_KEY/i.test(allContent)) {
    blockers.push('Placeholder YOUR_API_KEY found');
  }
  if (/YOUR_BASE_URL/i.test(allContent)) {
    blockers.push('Placeholder YOUR_BASE_URL found');
  }

  // If we have AppSpec with a real base URL, verify it's in the generated files
  if (appSpec?.api.baseUrl && appSpec.api.baseUrl.startsWith('http')) {
    const baseUrlInTarget = files.some((f) =>
      f.content.includes(appSpec.api.baseUrl)
    );
    if (!baseUrlInTarget) {
      blockers.push(`Real API base URL "${appSpec.api.baseUrl}" not found in generated files`);
    }
  }

  if (blockers.length > 0) {
    return { pass: false, detail: blockers.join('; ') };
  }
  return { pass: true, detail: 'Configuration appears correctly transferred' };
}

// ── Check: no critical shell files ─────────────────────────────────────────
function checkNoShellCritical(
  contentReport: ContentValidationReport,
): { pass: boolean; detail: string; count: number } {
  const shellCritical = contentReport.files.filter((v) => {
    if (v.status !== 'shell_401' && v.status !== 'source_residual') return false;
    return CRITICAL_FILE_PATTERNS.some((cp) => cp.pattern.test(v.path));
  });

  if (shellCritical.length === 0) {
    return { pass: true, detail: 'No critical SHELL_401 files', count: 0 };
  }
  const categories = shellCritical.map((f) => {
    const cat = CRITICAL_FILE_PATTERNS.find((cp) => cp.pattern.test(f.path))?.category ?? 'unknown';
    return `${f.path} (${cat})`;
  });
  return {
    pass:   false,
    detail: `${shellCritical.length} critical SHELL file(s): ${categories.slice(0, 5).join(', ')}`,
    count:  shellCritical.length,
  };
}

// ── Main: delivery check ──────────────────────────────────────────────────────
export function runDeliveryCheck(
  files:          GeneratedFile[],
  fidelityScore:  IRFidelityScore,
  contentReport:  ContentValidationReport,
  staticResult:   StaticValidationResult | null,
  appSpec?:       ApplicationSpec,
  // PHASE 44 — rapport d'intégrité structurelle (déterministe, sans IA).
  // Optionnel : les appelants existants continuent de fonctionner.
  integrity?:     ProjectIntegrityReport,
): DeliveryCheckResult {
  console.log(`\n[DeliveryChecker] === Phase 12: Delivery Check ===`);

  // ── Run all checks ────────────────────────────────────────────────────────
  const navCheck       = checkNavigation(files);
  const apiCheck       = checkApiLayer(files, contentReport);
  const configCheck    = checkConfig(files, appSpec);
  const shellCheck     = checkNoShellCritical(contentReport);

  // PHASE 44 — distinction explicite entre « compilation réussie » et
  // « compilation jamais tentée ». AVANT : non tentée ⇒ compilationPassed=true,
  // ce qui faisait passer READY un projet qui n'avait jamais été compilé.
  // `compilationPassed` conserve sa sémantique historique (ne bloque pas READY),
  // mais `compilationTested` expose la vérité et la checklist l'affiche.
  const compilationTested = staticResult?.tsCompilation.attempted === true;
  const compilationPassed = compilationTested
    ? staticResult!.tsCompilation.success
    : true; // NOT_TESTABLE → ne bloque pas READY, mais n'est PAS une réussite

  const noSourceImports = (staticResult?.sourceImports.length ?? contentReport.totalSourceImports) === 0;

  // ── Build checklist ───────────────────────────────────────────────────────
  const readyChecklist: DeliveryCheckResult['readyChecklist'] = [
    {
      item:   'TypeScript compilation',
      passed: compilationPassed,
      detail: compilationTested
        ? (staticResult!.tsCompilation.success ? 'Passed' : `${staticResult!.tsCompilation.errors.length} error(s)`)
        // PHASE 44 — libellé explicite : « non testé » n'est pas « réussi ».
        : 'NOT TESTED (tsc not run in this environment) — not a pass',
    },
    // ── PHASE 44 : contrôles d'intégrité structurelle déterministe ──────────
    // Ces items étaient ABSENTS de la checklist : brokenImports, dépendances
    // manquantes et routes cassées ne bloquaient jamais le statut READY.
    ...(integrity ? [
      {
        item:   'Local imports resolve',
        passed: (integrity.byCode['unresolved-local-import'] ?? 0) === 0,
        detail: (integrity.byCode['unresolved-local-import'] ?? 0) === 0
          ? 'All relative/alias imports resolve to a generated file'
          : `${integrity.byCode['unresolved-local-import']} unresolved local import(s)`,
      },
      {
        item:   'Dependencies declared in package.json',
        passed: (integrity.byCode['missing-dependency'] ?? 0) === 0,
        detail: (integrity.byCode['missing-dependency'] ?? 0) === 0
          ? 'Every imported package is declared in the manifest'
          : `${integrity.byCode['missing-dependency']} package(s) imported but not declared`,
      },
      {
        item:   'Navigation targets exist',
        passed: (integrity.byCode['missing-route-target'] ?? 0) === 0,
        detail: (integrity.byCode['missing-route-target'] ?? 0) === 0
          ? 'Every referenced route has a matching screen'
          : `${integrity.byCode['missing-route-target']} route(s) point to a missing screen`,
      },
      {
        item:   'Canonical models (no duplicate incompatible types)',
        passed: (integrity.byCode['model-property-mismatch'] ?? 0) === 0,
        detail: (integrity.byCode['model-property-mismatch'] ?? 0) === 0
          ? 'No exported type is declared with conflicting properties'
          : `${integrity.byCode['model-property-mismatch']} type(s) declared incompatibly in several files`,
      },
      {
        item:   'Project scaffold complete',
        passed: ((integrity.byCode['missing-config'] ?? 0) +
                 (integrity.byCode['missing-entrypoint'] ?? 0) +
                 (integrity.byCode['invalid-config-json'] ?? 0)) === 0,
        detail: `manifest/entrypoint/config issues: ${
          (integrity.byCode['missing-config'] ?? 0) +
          (integrity.byCode['missing-entrypoint'] ?? 0) +
          (integrity.byCode['invalid-config-json'] ?? 0)}`,
      },
    ] : []),
    {
      item:   'No source-language imports in target',
      passed: noSourceImports,
      detail: noSourceImports
        ? 'Clean — no Dart/Swift/Kotlin imports in TypeScript files'
        : `${contentReport.totalSourceImports} source import(s) found in target files`,
    },
    {
      item:   'No critical SHELL files',
      passed: shellCheck.pass,
      detail: shellCheck.detail,
    },
    {
      item:   'Navigation functional',
      passed: navCheck.pass,
      detail: navCheck.detail,
    },
    {
      item:   'API layer present',
      passed: apiCheck.pass,
      detail: apiCheck.detail,
    },
    {
      item:   'Configuration transferred',
      passed: configCheck.pass,
      detail: configCheck.detail,
    },
    {
      item:   'Conversion coverage ≥ 50% (converted+scaffold+incomplete)',
      // Calcul élargi: un fichier "incomplete" avec vrai code compte comme couvert
      // Les stubs purs (linesCode < 5) restent des échecs
      passed: (() => {
        const covered = contentReport.convertedFiles + contentReport.scaffoldFiles + contentReport.incompleteFiles;
        const total   = contentReport.totalFiles;
        return total > 0 && (covered / total) >= 0.50;
      })(),
      detail: (() => {
        const covered = contentReport.convertedFiles + contentReport.scaffoldFiles + contentReport.incompleteFiles;
        const total   = contentReport.totalFiles;
        const rate    = total > 0 ? Math.round(covered / total * 100) : 0;
        return `Coverage: ${rate}% (${covered}/${total} files: ${contentReport.convertedFiles} converted + ${contentReport.scaffoldFiles} scaffold + ${contentReport.incompleteFiles} incomplete)`;
      })(),
    },
    {
      item:   'Fidelity score ≥ 40%',
      passed: fidelityScore.overall >= 40,
      detail: `Overall fidelity: ${fidelityScore.overall}%`,
    },
  ];

  // ── Collect blockers ─────────────────────────────────────────────────────
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!compilationPassed && staticResult?.tsCompilation.attempted) {
    blockers.push(`TypeScript compilation failed: ${staticResult.tsCompilation.errors.slice(0, 3).join(' | ')}`);
  }
  if (!noSourceImports) {
    blockers.push(`${contentReport.totalSourceImports} source-language import(s) in target files — prevents compilation`);
  }
  if (!shellCheck.pass) {
    blockers.push(shellCheck.detail);
  }
  if (!navCheck.pass) {
    blockers.push(`Navigation: ${navCheck.detail}`);
  }
  if (!apiCheck.pass) {
    warnings.push(`API layer: ${apiCheck.detail}`);  // warning, not blocker (external API may be unavailable)
  }
  if (!configCheck.pass) {
    blockers.push(`Config: ${configCheck.detail}`);
  }
  // Vérification de la couverture réelle (converted+scaffold+incomplete)
  {
    const covered = contentReport.convertedFiles + contentReport.scaffoldFiles + contentReport.incompleteFiles;
    const total   = contentReport.totalFiles;
    const rate    = total > 0 ? Math.round(covered / total * 100) : 0;
    if (rate < 50) {
      blockers.push(`Coverage too low: ${rate}% (${covered}/${total} files covered, need ≥50%)`);
    }
  }
  if (fidelityScore.overall < 40) {
    blockers.push(`Fidelity score too low: ${fidelityScore.overall}% (need ≥40%)`);
  }

  // ── PHASE 44 : les erreurs d'intégrité sont des blockers ──────────────────
  // Un import qui ne résout pas, une dépendance absente du manifeste ou une
  // route cassée empêchent le projet de tourner : READY est interdit.
  if (integrity) {
    for (const code of ['unresolved-local-import', 'missing-dependency', 'missing-route-target',
                        'duplicate-file', 'invalid-config-json', 'missing-config',
                        'missing-entrypoint', 'empty-source-file',
                        // PHASE 45 — deux modèles incompatibles (ex. deux `Task`
                        // avec `completed` vs `isDone`) cassent le flux utilisateur.
                        'model-property-mismatch',
                        // PHASE 45 — flux utilisateur cassé
                        'wrong-entry-route', 'form-not-wired'] as const) {
      const n = integrity.byCode[code] ?? 0;
      if (n > 0) blockers.push(`Integrity: ${n} × ${code}`);
    }
    for (const code of ['conflicting-file'] as const) {
      const n = integrity.byCode[code] ?? 0;
      if (n > 0) warnings.push(`Integrity: ${n} × ${code}`);
    }
  }

  // Non-blocking warnings
  if (contentReport.totalTodos > 20) {
    warnings.push(`High TODO count: ${contentReport.totalTodos} TODOs in generated files`);
  }
  if (contentReport.incompleteFiles > 5) {
    warnings.push(`${contentReport.incompleteFiles} incomplete files (may need manual review)`);
  }

  // ── Determine status ──────────────────────────────────────────────────────
  const status: DeliveryCheckResult['status'] = blockers.length === 0 ? 'READY' : 'NEEDS_REPAIR';

  // ── Log ───────────────────────────────────────────────────────────────────
  console.log(`[DeliveryChecker] CHECKLIST:`);
  for (const item of readyChecklist) {
    console.log(`  ${item.passed ? '✅' : '❌'} ${item.item}: ${item.detail}`);
  }
  if (warnings.length > 0) {
    console.log(`[DeliveryChecker] WARNINGS:`);
    for (const w of warnings) console.warn(`  ⚠️  ${w}`);
  }
  console.log(`[DeliveryChecker] STATUS: ${status === 'READY' ? '✅ READY' : `❌ NEEDS_REPAIR (${blockers.length} blocker(s))`}`);
  if (blockers.length > 0) {
    for (const b of blockers) console.error(`  ❌ ${b}`);
  }
  console.log(`[DeliveryChecker] ==========================================\n`);

  return {
    status,
    score:              fidelityScore.overall,
    compilationPassed,
    noSourceImports,
    noShellCritical:    shellCheck.pass,
    noMissingCritical:  shellCheck.count === 0,
    navigationFunctional: navCheck.pass,
    apiLayerPresent:    apiCheck.pass,
    configTransferred:  configCheck.pass,
    blockers,
    warnings,
    readyChecklist,
    ...(integrity ? {
      integrityVerdict:  integrity.verdict,
      integrityErrors:   integrity.errorCount,
      integrityWarnings: integrity.warningCount,
    } : {}),
    compilationTested,
  };
}

// ── Format delivery report for output ────────────────────────────────────────
export function formatDeliveryReport(result: DeliveryCheckResult): string {
  const statusLine = result.status === 'READY'
    ? '✅ READY — Application can be delivered'
    : `❌ NEEDS_REPAIR — ${result.blockers.length} blocker(s) must be fixed`;

  const lines = [
    `DELIVERY STATUS: ${statusLine}`,
    `─────────────────────────────────────────`,
    `Fidelity Score    : ${result.score}%`,
    `─────────────────────────────────────────`,
    `MANDATORY CHECKS:`,
    ...result.readyChecklist.map((item) =>
      `  ${item.passed ? '✅' : '❌'} ${item.item}${item.detail ? ` — ${item.detail}` : ''}`
    ),
  ];

  if (result.blockers.length > 0) {
    lines.push('', 'BLOCKERS (must fix):');
    for (const b of result.blockers) {
      lines.push(`  ❌ ${b}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push('', 'WARNINGS (non-blocking):');
    for (const w of result.warnings) {
      lines.push(`  ⚠️  ${w}`);
    }
  }

  return lines.join('\n');
}
