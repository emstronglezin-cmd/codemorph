// ============================================================
// CodeMorph AI Engine — Conversion Report (v2 — N/A-aware)
// PHASE 9: Rapport de conversion format exact
//
// Format de sortie:
// =========================
// CONVERSION REPORT
// Business Logic      : XX% | N/A
// Navigation          : XX% | N/A
// Repositories        : XX% | N/A
// Services            : XX% | N/A
// Stores              : XX% | N/A
// API                 : XX% | N/A
// UI Fidelity         : XX% | N/A
// Compilation         : ✅ / ❌
// Round-trip          : XX%
// Files Generated     : N
// Files Auto-Repaired : N
// Warnings            : N
// Errors Fixed        : N
// Overall Fidelity    : XX%  (N axes applicables, M N/A)
// Compilation Status  : PASS / FAIL
// Ready For Production: YES / NO
// =========================
// ============================================================

import { splitDeliverableFiles } from './canonical-ir';
import type {
  IRFidelityScore, IRFidelityDetail, IRAutoCorrectReport, GeneratedFile,
} from '../models/ir.types';
import type { CompilationResult } from './dart-compiler';
import type { RoundTripResult }   from './round-trip-fidelity';

// ── Types ──────────────────────────────────────────────────────────────────

/** Score ou null (N/A) */
type NullableScore = number | null;

/**
 * PHASE 48 — validation réellement exécutée, telle qu'observée.
 * Le rapport utilisateur doit dire la même chose que les contrôles : un projet
 * pouvait auparavant être présenté comme réussi alors qu'aucun test ni build
 * n'avait tourné.
 */
/** PHASE 51 — ce dont la règle de production a besoin du delivery check. */
export interface ReportDeliverySection {
  status:   'READY' | 'NEEDS_REPAIR';
  blockers: string[];
}

/** PHASE 51 — ce dont la règle de production a besoin des tests fonctionnels. */
export interface ReportFunctionalSection {
  tests: Array<{ feature: string; status: 'PASS' | 'PARTIAL' | 'FAIL' | 'NOT_TESTABLE' }>;
}

/**
 * PHASE 51 — tests fonctionnels dont l'échec bloque la livraison.
 *
 * Ce sont les capacités sans lesquelles l'application générée ne peut pas
 * fonctionner du tout. Les autres (auth, API, state, configuration, services
 * externes) sont dégradées mais ne rendent pas le livraison dangereuse.
 */
export const CRITICAL_FUNCTIONAL_FEATURES: ReadonlySet<string> = new Set([
  'App bootstrap (entry point)',
  'Navigation (routing)',
  'Data models (TypeScript interfaces/types)',
  'Services (business logic layer)',
  'Screens (UI components)',
  'TypeScript compilation (static check)',
  'No source-language residuals (Dart/Flutter imports)',
]);

/**
 * PHASE 51 — Résultat de la règle de production, avec les raisons explicites.
 *
 * Le statut est calculé à partir des RÉSULTATS RÉELS (contrôles exécutés,
 * blockers, tests fonctionnels, erreurs TypeScript), jamais à partir du seul
 * score de fidélité.
 */
export interface ProductionReadiness {
  ready:    boolean;
  /** Raisons précises du blocage — vide si et seulement si `ready` est vrai. */
  blockers: string[];
}

export function evaluateProductionReadiness(input: {
  fidelityScore:       number;
  compilationStatus:   'PASS' | 'FAIL' | 'SKIPPED';
  typeScriptErrors:    string[];
  validation?:         ReportValidationSection;
  deliveryCheck?:      ReportDeliverySection;
  testResults?:        ReportFunctionalSection;
}): ProductionReadiness {
  const blockers: string[] = [];

  // 1. Une erreur TypeScript bloque la livraison.
  if (input.typeScriptErrors.length > 0) {
    blockers.push(
      `${input.typeScriptErrors.length} erreur(s) TypeScript : ` +
      input.typeScriptErrors.slice(0, 3).join(' | '),
    );
  }

  // 2. Une compilation SKIPPED n'est JAMAIS une réussite.
  if (input.compilationStatus === 'SKIPPED') {
    blockers.push(
      'Compilation non exécutée (SKIPPED) — une compilation ignorée ne peut pas ' +
      'être comptée comme réussie',
    );
  } else if (input.compilationStatus === 'FAIL') {
    blockers.push('Compilation en échec');
  }

  // 3. Un blocker actif du delivery check bloque la livraison.
  if (input.deliveryCheck) {
    if (input.deliveryCheck.status === 'NEEDS_REPAIR') {
      blockers.push(`Delivery check : NEEDS_REPAIR`);
    }
    for (const b of input.deliveryCheck.blockers) blockers.push(`Blocker : ${b}`);
  }

  // 4. Un contrôle critique FAIL bloque ; un critique NOT_RUN bloque aussi,
  //    car « non exécuté » n'est pas « réussi ».
  if (input.validation) {
    for (const id of input.validation.failedCritical) {
      blockers.push(`Contrôle critique en échec : ${id}`);
    }
    for (const id of input.validation.notRunCritical) {
      blockers.push(`Contrôle critique non exécuté : ${id}`);
    }
  }

  // 5. Un test fonctionnel CRITIQUE en échec bloque la livraison.
  if (input.testResults) {
    for (const t of input.testResults.tests) {
      if (t.status === 'FAIL' && CRITICAL_FUNCTIONAL_FEATURES.has(t.feature)) {
        blockers.push(`Test fonctionnel critique en échec : ${t.feature}`);
      }
    }
  }

  // 6. Le score reste une condition nécessaire, jamais suffisante.
  if (input.fidelityScore < 80) {
    blockers.push(`Fidélité ${input.fidelityScore}% < 80%`);
  }

  return { ready: blockers.length === 0, blockers };
}

/**
 * PHASE 51 — Statut explicite du round-trip.
 *
 * ## Le défaut corrigé
 *
 * `const roundTripScore = roundTripResult?.averageScore ?? 0;` rendait
 * indistinguables « jamais exécuté » et « exécuté, score 0 % ». Le rapport
 * affichait `Round-trip : 0 %`, ce qui se lit comme une mesure d'échec alors
 * qu'aucune mesure n'a été prise.
 *
 * Constat vérifié dans le code : `runRoundTripFidelity()` existe dans
 * `round-trip-fidelity.ts`, mais **le pipeline ne l'appelle jamais** (le module
 * n'est référencé que par `conversion-report.ts`, pour le type). Le statut réel
 * est donc `NOT_RUN` — la capacité est implémentée, elle n'est pas câblée.
 */
export type RoundTripStatus =
  /** La conversion inverse n'existe pas dans le moteur. */
  | 'NOT_IMPLEMENTED'
  /** La direction de conversion ne permet pas de round-trip. */
  | 'NOT_APPLICABLE'
  /** Implémenté et applicable, mais non lancé sur ce job. */
  | 'NOT_RUN'
  /** Exécuté, score sous le seuil. */
  | 'FAIL'
  /** Exécuté, score au-dessus du seuil. */
  | 'PASS';

/** Seuil au-dessus duquel un round-trip exécuté est considéré comme réussi. */
export const ROUND_TRIP_PASS_THRESHOLD = 70;

/**
 * Déduit le statut réel du round-trip. Un résultat absent n'est JAMAIS
 * converti en score mesuré, et un score de 0 n'est jamais présenté comme une
 * réussite.
 */
export function deriveRoundTripStatus(
  result: { averageScore: number } | undefined,
  opts?: { applicable?: boolean; implemented?: boolean },
): RoundTripStatus {
  if (opts?.implemented === false) return 'NOT_IMPLEMENTED';
  if (opts?.applicable === false) return 'NOT_APPLICABLE';
  if (!result) return 'NOT_RUN';
  return result.averageScore >= ROUND_TRIP_PASS_THRESHOLD ? 'PASS' : 'FAIL';
}

export interface ReportValidationSection {
  fullyValidated: boolean;
  durationMs:     number;
  failedCritical: string[];
  notRunCritical: string[];
  checks: Array<{
    id:         string;
    status:     'PASS' | 'FAIL' | 'NOT_RUN';
    durationMs: number;
    errors:     number;
    reason?:    string;
  }>;
}

export interface ConversionReport {
  /** PHASE 48 — présent dès que la validation post-génération a tourné. */
  validation?: ReportValidationSection;
  // 15 métriques principales (null = N/A)
  businessLogic:      NullableScore;
  navigation:         NullableScore;
  repositories:       NullableScore;
  services:           NullableScore;
  stores:             NullableScore;
  api:                NullableScore;
  uiFidelity:         NullableScore;
  compilation:        boolean;
  roundTrip:          number;
  /** PHASE 51 — statut réel, distinct du score. `roundTrip: 0` avec un statut
   *  `NOT_RUN` ne doit jamais être lu comme un round-trip échoué. */
  roundTripStatus:    RoundTripStatus;
  filesGenerated:     number;
  /** PHASE 51 — rapports internes, hors ZIP applicatif. */
  reportFiles:        number;
  filesAutoRepaired:  number;
  warnings:           number;
  errorsFixed:        number;
  overallFidelity:    number;  // calculé uniquement sur axes applicables
  compilationStatus:  'PASS' | 'FAIL' | 'SKIPPED';
  readyForProduction: boolean;
  /** PHASE 51 — raisons précises du blocage (vide ⇔ prêt pour la production). */
  productionBlockers: string[];

  // N/A metadata
  applicableAxes:     string[];   // axes avec score réel
  naAxes:             string[];   // axes N/A (exclus du dénominateur)
  detectedFramework?: string | undefined;
  stateManagements?:  string[] | undefined;

  // Détails par axe pour le rapport enrichi
  axisDetails?:       IRFidelityDetail[] | undefined;

  // Données complémentaires
  projectName?:       string | undefined;
  conversionType?:    string | undefined;
  duration?:          number | undefined;
  aiTier?:            string | undefined;
  timestamp?:         string | undefined;
}

// ── Helper : formater un score N/A-aware ─────────────────────────────────

function fmtScore(score: NullableScore): string {
  if (score === null) return 'N/A';
  return `${score}%`;
}

function barScore(score: NullableScore, width = 10): string {
  if (score === null) return '──────────';
  const pct    = Math.min(100, Math.max(0, score));
  const filled = Math.round(pct / width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

// ── Calculer le rapport depuis les résultats du pipeline ─────────────────

export function buildConversionReport(params: {
  fidelityScore:       IRFidelityScore;
  autoCorrectionReport: IRAutoCorrectReport;
  files:               GeneratedFile[];
  compilationResult?:  CompilationResult;
  roundTripResult?:    RoundTripResult;
  projectName?:        string;
  conversionType?:     string;
  duration?:           number;
  aiTier?:             string;
  /** PHASE 48 — contrôles réellement exécutés. */
  validation?:         ReportValidationSection;
  /** PHASE 51 — évaluation de livraison (blockers) et tests fonctionnels. */
  deliveryCheck?:      ReportDeliverySection;
  testResults?:        ReportFunctionalSection;
}): ConversionReport {
  const {
    fidelityScore, autoCorrectionReport, files,
    compilationResult, roundTripResult,
    projectName, conversionType, duration, aiTier, validation,
    deliveryCheck, testResults,
  } = params;

  // Compter les repositories et services générés
  const isDart = files.some((f) => f.path.endsWith('.dart'));
  const repoFiles = files.filter((f) =>
    isDart
      ? /repositories?\/[^/]+\.dart$/.test(f.path) || /_repository\.dart$/.test(f.path)
      : /\.repository\.(ts|js)$/.test(f.path) || /repositories?\/[^/]+\.(ts|js)$/.test(f.path)
  ).length;

  const svcFiles = files.filter((f) =>
    isDart
      ? /services?\/[^/]+\.dart$/.test(f.path) || /_service\.dart$/.test(f.path)
      : /\.service\.(ts|js)$/.test(f.path) || /services?\/[^/]+\.(ts|js)$/.test(f.path)
  ).length;

  // Warnings et erreurs
  const fileWarnings    = files.filter((f) => (f.warnings?.length ?? 0) > 0).length;
  const remainingLosses = autoCorrectionReport.remainingLosses?.length ?? 0;
  const totalWarnings   = fileWarnings + Math.min(remainingLosses, 20);

  const autoCorrFixes   = autoCorrectionReport.improvements?.length ?? 0;
  const compilFixes     = compilationResult?.filesFixed ?? 0;
  const errorsFixed     = autoCorrFixes + compilFixes;

  const filesAutoRepaired = files.filter((f) =>
    (f.warnings?.some((w) => w.includes('OutputCleaner') || w.includes('fixed') || w.includes('import'))) ?? false
  ).length + compilFixes;

  // Compilation
  const compilPass   = compilationResult ? compilationResult.success : null;
  const compilStatus: ConversionReport['compilationStatus'] =
    compilationResult === undefined ? 'SKIPPED'
    : compilPass ? 'PASS' : 'FAIL';

  // Round-trip
  const roundTripScore = roundTripResult?.averageScore ?? 0;
  // PHASE 51 — la capacité existe (`runRoundTripFidelity`) mais le pipeline ne
  // l'appelle pas : aucun résultat n'est donc produit sur ce chemin.
  const roundTripStatus = deriveRoundTripStatus(roundTripResult, {
    implemented: true,
    applicable:  true,
  });

  // Scores N/A-aware : utiliser directement les valeurs de fidelityScore (qui sont déjà null si N/A)
  // Pour repositories et services : utiliser les axes dédiés du nouveau scoring
  const repositoriesScore: NullableScore = fidelityScore.repositories !== undefined
    ? fidelityScore.repositories
    : (repoFiles > 0
        ? Math.min(100, Math.round((repoFiles / Math.max(1, svcFiles + 1)) * 100))
        : (fidelityScore.dataLayer ?? null));

  const servicesScore: NullableScore = fidelityScore.services !== undefined
    ? fidelityScore.services
    : (svcFiles > 0
        ? Math.min(100, (fidelityScore.api ?? 0) + (svcFiles > 2 ? 10 : 0))
        : (fidelityScore.api ?? null));

  // Overall : fidelityScore.overall est déjà calculé sur axes applicables uniquement
  // On y ajoute un bonus compilation (sans dépasser 100)
  const compilBonus    = compilStatus === 'PASS' ? 5 : compilStatus === 'SKIPPED' ? 0 : -10;
  const roundTripBonus = roundTripScore > 0 ? Math.round(roundTripScore * 0.1) : 0;
  const rawOverall     = fidelityScore.overall + compilBonus + roundTripBonus;
  const overallFidelity = Math.max(0, Math.min(100, rawOverall));

  // ── PHASE 51 : Ready for production ────────────────────────────────────────
  // AVANT :
  //   overallFidelity >= 80 && compilStatus !== 'FAIL' && (erreurs ?? 0) === 0
  // Trois défauts : (a) `!== 'FAIL'` laissait passer SKIPPED ; (b) la règle ne
  // consultait NI le delivery check NI les blockers NI les tests fonctionnels ;
  // (c) `compilationResult` provient de l'étape de build, souvent absente, donc
  // les erreurs TypeScript trouvées par le validateur statique n'étaient pas
  // vues. Résultat observé : « Ready For Production: YES » avec NEEDS_REPAIR,
  // 1 blocker actif et une erreur TS1005.
  const tsErrorsFromBuild = (compilationResult?.errors ?? [])
    .filter((e) => e.severity === 'error')
    .map((e) => e.message);
  const tsErrorsFromChecks = (validation?.checks ?? [])
    .filter((c) => c.id === 'typescript' && c.status === 'FAIL')
    .flatMap((c) => [c.reason ?? 'erreur TypeScript détectée par le contrôle statique']);

  const readiness = evaluateProductionReadiness({
    fidelityScore:     overallFidelity,
    compilationStatus: compilStatus,
    typeScriptErrors:  [...tsErrorsFromBuild, ...tsErrorsFromChecks],
    ...(validation ? { validation } : {}),
    ...(deliveryCheck ? { deliveryCheck } : {}),
    ...(testResults ? { testResults } : {}),
  });
  const readyForProduction = readiness.ready;

  return {
    ...(validation ? { validation } : {}),
    businessLogic:     fidelityScore.businessLogic ?? null,
    navigation:        fidelityScore.navigation    ?? null,
    repositories:      repositoriesScore,
    services:          servicesScore,
    stores:            fidelityScore.stores        ?? null,
    api:               fidelityScore.api           ?? null,
    uiFidelity:        fidelityScore.uiFidelity    ?? null,
    // PHASE 51 — AVANT : `=== 'PASS' || === 'SKIPPED'`, donc une compilation
    // ignorée était comptabilisée comme réussie. Un contrôle non exécuté n'est
    // pas un contrôle réussi.
    compilation:       compilStatus === 'PASS',
    roundTrip:         roundTripScore,
    roundTripStatus,
    // PHASE 51 — AVANT : `files.length`, qui incluait les rapports internes
    // injectés APRÈS la création du ZIP. Le rapport annonçait donc 34 fichiers
    // quand le ZIP en contenait 30. Le compte livré est désormais dérivé de la
    // même fonction que celle du ZIP.
    filesGenerated:    splitDeliverableFiles(files).deliverable.filter((f) => !!f.content).length,
    reportFiles:       splitDeliverableFiles(files).reports.length,
    filesAutoRepaired,
    warnings:          totalWarnings,
    errorsFixed,
    overallFidelity,
    compilationStatus: compilStatus,
    readyForProduction,
    productionBlockers: readiness.blockers,
    applicableAxes:    fidelityScore.applicableAxes ?? [],
    naAxes:            fidelityScore.naAxes ?? [],
    ...(fidelityScore.detectedFramework !== undefined ? { detectedFramework: fidelityScore.detectedFramework } : {}),
    ...(fidelityScore.stateManagements?.length ? { stateManagements: fidelityScore.stateManagements } : {}),
    ...(fidelityScore.details?.length ? { axisDetails: fidelityScore.details } : {}),
    ...(projectName  !== undefined ? { projectName }  : {}),
    ...(conversionType !== undefined ? { conversionType } : {}),
    ...(duration     !== undefined ? { duration }     : {}),
    ...(aiTier       !== undefined ? { aiTier }       : {}),
    timestamp:         new Date().toISOString(),
  };
}

// ── Formater le rapport en texte (format exact demandé) ─────────────────

export function formatConversionReport(report: ConversionReport): string {
  const bar = (score: NullableScore): string => {
    if (score === null) return `──────────  N/A`;
    const pct    = Math.min(100, Math.max(0, score));
    const filled = Math.round(pct / 10);
    return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${String(pct).padStart(3)}%`;
  };

  const compilIcon = report.compilationStatus === 'PASS' ? '✅'
    : report.compilationStatus === 'FAIL' ? '❌'
    : '⏭️ ';

  // Construire les lignes d'axes N/A
  const naSection = report.naAxes.length > 0
    ? [``, `Axes N/A           : ${report.naAxes.join(', ')}`,
       `Score sur          : ${report.applicableAxes.join(', ')}`]
    : [];

  // Détail pipeline par axe (si disponible)
  const pipelineSection: string[] = [];
  if (report.axisDetails && report.axisDetails.length > 0) {
    pipelineSection.push('', '--- Pipeline Trace ---');
    for (const d of report.axisDetails) {
      if (!d.applicable) {
        pipelineSection.push(`  ${d.axis.padEnd(14)} N/A`);
        continue;
      }
      const tr = d.pipelineTrace;
      if (tr) {
        pipelineSection.push(
          `  ${d.axis.padEnd(14)} SRC=${tr.sourceCount} AST=${tr.astCount} IR=${tr.irCount}` +
          ` PLAN=${tr.plannedCount} GEN=${tr.generatedCount} VAL=${tr.validatedCount}` +
          `  → ${fmtScore(d.score)}`
        );
      } else {
        pipelineSection.push(`  ${d.axis.padEnd(14)} → ${fmtScore(d.score)}`);
      }
    }
  }

  const lines = [
    ``,
    `=========================`,
    `CONVERSION REPORT`,
    ...(report.projectName    ? [`Project           : ${report.projectName}`] : []),
    ...(report.conversionType ? [`Conversion         : ${report.conversionType}`] : []),
    ...(report.aiTier         ? [`AI Tier            : ${report.aiTier}`] : []),
    ...(report.detectedFramework ? [`Framework          : ${report.detectedFramework}`] : []),
    ...(report.stateManagements?.length ? [`State Management   : ${report.stateManagements.join(', ')}`] : []),
    ``,
    `Business Logic     : ${bar(report.businessLogic)}`,
    `Navigation         : ${bar(report.navigation)}`,
    `Repositories       : ${bar(report.repositories)}`,
    `Services           : ${bar(report.services)}`,
    `Stores             : ${bar(report.stores)}`,
    `API                : ${bar(report.api)}`,
    `UI Fidelity        : ${bar(report.uiFidelity)}`,
    ``,
    `Compilation        : ${compilIcon} ${report.compilationStatus}`,
    `Round-trip         : ${bar(report.roundTrip)}`,
    ``,
    `Files Generated    : ${report.filesGenerated}`,
    `Files Auto-Repaired: ${report.filesAutoRepaired}`,
    `Warnings           : ${report.warnings}`,
    `Errors Fixed       : ${report.errorsFixed}`,
    ``,
    `Overall Fidelity   : ${bar(report.overallFidelity)}`,
    ...naSection,
    `Compilation Status : ${report.compilationStatus}`,
    `Ready For Production: ${report.readyForProduction ? '✅ YES' : '❌ NO'}`,
    ...(report.duration   ? [`Duration           : ${Math.round(report.duration / 1000)}s`] : []),
    ...(report.timestamp  ? [`Generated At       : ${report.timestamp}`] : []),
    ...pipelineSection,
    `=========================`,
    ``,
  ];

  return lines.join('\n');
}

// ── Formater le rapport en JSON ──────────────────────────────────────────

export function formatConversionReportJSON(report: ConversionReport): string {
  return JSON.stringify(report, null, 2);
}

// ── Formater le rapport en Markdown ──────────────────────────────────────

export function formatConversionReportMarkdown(report: ConversionReport): string {
  const icon = (score: NullableScore): string =>
    score === null ? '⬜' : score >= 80 ? '✅' : score >= 50 ? '⚠️' : '❌';

  const rows: [string, NullableScore][] = [
    ['Business Logic', report.businessLogic],
    ['Navigation',     report.navigation],
    ['Repositories',   report.repositories],
    ['Services',       report.services],
    ['Stores',         report.stores],
    ['API',            report.api],
    ['UI Fidelity',    report.uiFidelity],
    ['Round-trip',     report.roundTrip],
    ['Overall',        report.overallFidelity],
  ];

  const tableRows = rows.map(([name, score]) => {
    const scoreStr = score === null ? 'N/A' : `${score}%`;
    const barStr   = barScore(score);
    return `| ${icon(score)} **${name}** | ${scoreStr} | \`${barStr}\` |`;
  }).join('\n');

  // Section N/A
  const naSection = report.naAxes.length > 0
    ? `\n### Axes N/A (absents du projet source)\n\n` +
      `Les axes suivants ont été exclus du calcul du score global :\n\n` +
      report.naAxes.map((a) => `- **${a}** — absent du projet source`).join('\n') + '\n\n' +
      `> Score global calculé uniquement sur : ${report.applicableAxes.join(', ')}\n`
    : '';

  // Pipeline trace
  let pipelineSection = '';
  if (report.axisDetails && report.axisDetails.length > 0) {
    const pipelineRows = report.axisDetails
      .filter((d) => d.applicable)
      .map((d) => {
        const tr = d.pipelineTrace;
        if (!tr) return `| ${d.axis} | — | — | — | — | — | — | ${fmtScore(d.score)} |`;
        return `| ${d.axis} | ${tr.sourceCount} | ${tr.astCount} | ${tr.irCount} | ${tr.plannedCount} | ${tr.generatedCount} | ${tr.validatedCount} | ${fmtScore(d.score)} |`;
      }).join('\n');

    pipelineSection = `\n## Pipeline Trace\n\n` +
      `| Axis | SOURCE | AST | IR | PLANNED | GENERATED | VALIDATED | SCORE |\n` +
      `|------|--------|-----|-----|---------|-----------|-----------|-------|\n` +
      pipelineRows + '\n';
  }

  return `# CodeMorph Conversion Report

${report.projectName    ? `**Project:** ${report.projectName}  \n` : ''}${
  report.conversionType ? `**Conversion:** ${report.conversionType}  \n` : ''}${
  report.aiTier         ? `**AI Tier:** ${report.aiTier}  \n` : ''}${
  report.detectedFramework ? `**Framework:** ${report.detectedFramework}  \n` : ''}${
  report.stateManagements?.length ? `**State Management:** ${report.stateManagements.join(', ')}  \n` : ''}${
  report.timestamp      ? `**Generated:** ${report.timestamp}  \n` : ''}

## Fidelity Scores

| Metric | Score | Visual |
|--------|-------|--------|
${tableRows}

## Conversion Statistics

| Metric | Value |
|--------|-------|
| Files Generated | ${report.filesGenerated} |
| Files Auto-Repaired | ${report.filesAutoRepaired} |
| Warnings | ${report.warnings} |
| Errors Fixed | ${report.errorsFixed} |
| Compilation Status | ${report.compilationStatus} |
| Ready For Production | ${report.readyForProduction ? '✅ YES' : '❌ NO'} |
${report.duration ? `| Duration | ${Math.round(report.duration / 1000)}s |` : ''}
${naSection}
${pipelineSection}
## Summary

**Overall Fidelity: ${report.overallFidelity}%** (${report.applicableAxes.length} axes applicables) — ${
  report.overallFidelity >= 90 ? 'Excellent conversion quality' :
  report.overallFidelity >= 75 ? 'Good conversion quality — minor review needed' :
  report.overallFidelity >= 50 ? 'Partial conversion — review required' :
  'Low fidelity — significant manual work needed'
}

${report.readyForProduction
  ? '✅ **Production Ready** — This conversion meets quality standards.'
  : '⚠️ **Review Required** — Some issues need attention before production use.'}
`;
}

// ── Formater le rapport en HTML ───────────────────────────────────────────

export function formatConversionReportHTML(report: ConversionReport): string {
  const colorForScore = (score: NullableScore): string =>
    score === null ? '#9E9E9E' : score >= 80 ? '#0BA66A' : score >= 50 ? '#F57C00' : '#D32F2F';

  const metrics: [string, NullableScore][] = [
    ['Business Logic', report.businessLogic],
    ['Navigation',     report.navigation],
    ['Repositories',   report.repositories],
    ['Services',       report.services],
    ['Stores',         report.stores],
    ['API',            report.api],
    ['UI Fidelity',    report.uiFidelity],
    ['Round-trip',     report.roundTrip],
  ];

  const metricRows = metrics.map(([name, score]) => {
    const isNA    = score === null;
    const pct     = isNA ? 0 : Math.min(100, Math.max(0, score));
    const color   = colorForScore(score);
    const display = isNA ? 'N/A' : `${score}%`;
    const barWidth = isNA ? 0 : pct * 2;
    const naStyle = isNA ? 'font-style:italic;color:#9E9E9E' : '';
    return `
    <tr>
      <td>${name}</td>
      <td>
        ${isNA
          ? `<span style="${naStyle}">absent du source</span>`
          : `<div style="background:#eee;border-radius:4px;height:16px;width:200px">
               <div style="background:${color};height:16px;width:${barWidth}px;border-radius:4px"></div>
             </div>`}
      </td>
      <td style="color:${color};font-weight:bold;${naStyle}">${display}</td>
    </tr>`;
  }).join('\n');

  // Table pipeline trace
  const pipelineRows = (report.axisDetails ?? []).map((d) => {
    const tr    = d.pipelineTrace;
    const color = colorForScore(d.score);
    if (!d.applicable || !tr) {
      return `<tr><td>${d.axis}</td><td colspan="6" style="color:#9E9E9E;font-style:italic">N/A — absent du source</td><td>N/A</td></tr>`;
    }
    return `<tr>
      <td>${d.axis}</td>
      <td>${tr.sourceCount}</td><td>${tr.astCount}</td><td>${tr.irCount}</td>
      <td>${tr.plannedCount}</td><td>${tr.generatedCount}</td><td>${tr.validatedCount}</td>
      <td style="color:${color};font-weight:bold">${fmtScore(d.score)}</td>
    </tr>`;
  }).join('\n');

  // Section N/A
  const naSection = report.naAxes.length > 0
    ? `<div style="background:#F5F5F5;border-left:4px solid #9E9E9E;padding:12px 16px;margin:16px 0;border-radius:0 4px 4px 0">
         <strong>Axes N/A (exclus du score global) :</strong>
         <span style="color:#9E9E9E">${report.naAxes.join(', ')}</span><br>
         <strong>Score calculé sur :</strong> ${report.applicableAxes.join(', ')}
       </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>CodeMorph Conversion Report${report.projectName ? ` — ${report.projectName}` : ''}</title>
  <style>
    body { font-family: 'Segoe UI', sans-serif; max-width: 900px; margin: 40px auto; color: #1A1A2E; }
    h1 { color: #B83A3A; border-bottom: 2px solid #B83A3A; padding-bottom: 8px; }
    h2 { color: #1A1A2E; margin-top: 32px; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0; }
    td, th { padding: 10px 14px; border-bottom: 1px solid #E5E7EB; text-align: left; }
    th { background: #F5F6FA; font-weight: 600; }
    .badge { padding: 4px 10px; border-radius: 12px; font-weight: bold; font-size: 13px; }
    .pass  { background: #E6F7F0; color: #0BA66A; }
    .fail  { background: #FFEBEE; color: #D32F2F; }
    .skip  { background: #FFF3E0; color: #F57C00; }
    .overall { font-size: 32px; font-weight: 700; color: ${colorForScore(report.overallFidelity)}; }
    .summary-box { border: 2px solid ${report.readyForProduction ? '#0BA66A' : '#F57C00'};
                   background: ${report.readyForProduction ? '#E6F7F0' : '#FFF3E0'};
                   border-radius: 8px; padding: 16px 20px; margin: 24px 0; }
    .na-row td { color: #9E9E9E; font-style: italic; }
  </style>
</head>
<body>
  <h1>🔄 CodeMorph Conversion Report</h1>
  ${report.projectName    ? `<p><strong>Project:</strong> ${report.projectName}</p>` : ''}
  ${report.conversionType ? `<p><strong>Conversion:</strong> ${report.conversionType}</p>` : ''}
  ${report.aiTier         ? `<p><strong>AI Tier:</strong> ${report.aiTier}</p>` : ''}
  ${report.detectedFramework ? `<p><strong>Framework:</strong> ${report.detectedFramework}</p>` : ''}
  ${report.stateManagements?.length ? `<p><strong>State Management:</strong> ${report.stateManagements.join(', ')}</p>` : ''}
  ${report.timestamp      ? `<p><strong>Generated:</strong> ${report.timestamp}</p>` : ''}

  <h2>📊 Fidelity Scores</h2>
  ${naSection}
  <table>
    <thead><tr><th>Metric</th><th>Progress</th><th>Score</th></tr></thead>
    <tbody>${metricRows}</tbody>
  </table>

  <h2>📋 Conversion Statistics</h2>
  <table>
    <tr><th>Metric</th><th>Value</th></tr>
    <tr><td>Files Generated</td><td><strong>${report.filesGenerated}</strong></td></tr>
    <tr><td>Files Auto-Repaired</td><td>${report.filesAutoRepaired}</td></tr>
    <tr><td>Warnings</td><td>${report.warnings}</td></tr>
    <tr><td>Errors Fixed</td><td>${report.errorsFixed}</td></tr>
    <tr><td>Compilation</td>
        <td><span class="badge ${report.compilationStatus === 'PASS' ? 'pass' : report.compilationStatus === 'FAIL' ? 'fail' : 'skip'}">${report.compilationStatus}</span></td></tr>
    ${report.duration ? `<tr><td>Duration</td><td>${Math.round(report.duration / 1000)}s</td></tr>` : ''}
  </table>

  <h2>🔬 Pipeline Trace (SOURCE → AST → IR → PLANNED → GENERATED → VALIDATED)</h2>
  <table>
    <thead>
      <tr><th>Axis</th><th>SOURCE</th><th>AST</th><th>IR</th><th>PLANNED</th><th>GENERATED</th><th>VALIDATED</th><th>SCORE</th></tr>
    </thead>
    <tbody>${pipelineRows}</tbody>
  </table>

  <h2>🎯 Overall Result</h2>
  <div class="summary-box">
    <p class="overall">${report.overallFidelity}% Overall Fidelity</p>
    <p style="color:#666;font-size:14px">${report.applicableAxes.length} axes applicables
      ${report.naAxes.length > 0 ? ` — ${report.naAxes.length} axes N/A : ${report.naAxes.join(', ')}` : ''}</p>
    <p><strong>Ready For Production:</strong> ${report.readyForProduction ? '✅ YES' : '❌ NO'}</p>
    <p>${
      report.overallFidelity >= 90 ? '🏆 Excellent conversion quality — all major features preserved' :
      report.overallFidelity >= 75 ? '✅ Good conversion quality — minor review recommended' :
      report.overallFidelity >= 50 ? '⚠️ Partial conversion — review required before use' :
      '❌ Low fidelity — significant manual work needed'
    }</p>
  </div>
</body>
</html>`;
}


/**
 * PHASE 48 — section Markdown décrivant ce qui a VRAIMENT été vérifié.
 *
 * Fonction autonome plutôt qu'un fragment injecté dans le template existant :
 * le rapport utilisateur doit refléter les contrôles exécutés, sans quoi un
 * projet sans test ni build exécuté continuait d'être présenté comme réussi.
 */
export function formatValidationSection(validation?: ReportValidationSection): string {
  const v = validation;
  if (!v) return '';
  const icon = (st: string): string =>
    st === 'PASS' ? '✅ PASS' : st === 'FAIL' ? '❌ FAIL' : '⏭️ NOT_RUN';

  const rows = v.checks
    .map((c) => `| ${c.id} | ${icon(c.status)} | ${c.durationMs} ms | ${c.errors} |`)
    .join('\n');

  const failed = v.failedCritical.length > 0
    ? `\n**Contrôles critiques en ÉCHEC :** ${v.failedCritical.join(', ')}\n` : '';
  const notRun = v.notRunCritical.length > 0
    ? `**Contrôles critiques NON EXÉCUTÉS :** ${v.notRunCritical.join(', ')}\n` : '';
  const warning = v.fullyValidated ? '' :
    `\n> Un contrôle non exécuté n'est pas un contrôle réussi. Cette conversion ne\n` +
    `> peut pas être déclarée entièrement validée tant que les contrôles ci-dessus\n` +
    `> n'ont pas été exécutés avec succès.\n`;

  return `\n## Validation réellement exécutée\n\n` +
    `**Projet entièrement validé : ${v.fullyValidated ? '✅ OUI' : '❌ NON'}** — durée ${v.durationMs} ms\n\n` +
    `| Contrôle | Statut | Durée | Erreurs |\n|----------|--------|-------|---------|\n` +
    `${rows}\n${failed}${notRun}${warning}`;
}
