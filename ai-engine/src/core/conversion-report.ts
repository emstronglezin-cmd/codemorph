// ============================================================
// CodeMorph AI Engine — Conversion Report
// PHASE 9: Rapport de conversion format exact
//
// Format de sortie:
// =========================
// CONVERSION REPORT
// Business Logic      : XX%
// Navigation          : XX%
// Repositories        : XX%
// Services            : XX%
// Stores              : XX%
// API                 : XX%
// UI Fidelity         : XX%
// Compilation         : ✅ / ❌
// Round-trip          : XX%
// Files Generated     : N
// Files Auto-Repaired : N
// Warnings            : N
// Errors Fixed        : N
// Overall Fidelity    : XX%
// Compilation Status  : PASS / FAIL
// Ready For Production: YES / NO
// =========================
// ============================================================

import type {
  IRFidelityScore, IRAutoCorrectReport, GeneratedFile,
} from '../models/ir.types';
import type { CompilationResult } from './dart-compiler';
import type { RoundTripResult }   from './round-trip-fidelity';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ConversionReport {
  // 15 métriques
  businessLogic:      number;  // %
  navigation:         number;  // %
  repositories:       number;  // %
  services:           number;  // %
  stores:             number;  // %
  api:                number;  // %
  uiFidelity:         number;  // %
  compilation:        boolean; // pass/fail
  roundTrip:          number;  // %
  filesGenerated:     number;  // count
  filesAutoRepaired:  number;  // count
  warnings:           number;  // count
  errorsFixed:        number;  // count
  overallFidelity:    number;  // %
  compilationStatus:  'PASS' | 'FAIL' | 'SKIPPED';
  readyForProduction: boolean;

  // Données complémentaires
  projectName?:       string | undefined;
  conversionType?:    string | undefined;
  duration?:          number | undefined;
  aiTier?:            string | undefined;
  timestamp?:         string | undefined;
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
}): ConversionReport {
  const {
    fidelityScore, autoCorrectionReport, files,
    compilationResult, roundTripResult,
    projectName, conversionType, duration, aiTier,
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

  // Warnings = fichiers avec warnings + pertes restantes
  const fileWarnings      = files.filter((f) => (f.warnings?.length ?? 0) > 0).length;
  const remainingLosses   = autoCorrectionReport.remainingLosses?.length ?? 0;
  const totalWarnings     = fileWarnings + Math.min(remainingLosses, 20);

  // Errors fixed = corrections effectuées par l'auto-correcter + import verifier + compilateur
  const autoCorrFixes     = autoCorrectionReport.improvements?.length ?? 0;
  const compilFixes       = compilationResult?.filesFixed ?? 0;
  const errorsFixed       = autoCorrFixes + compilFixes;

  // Files auto-repaired = fichiers qui ont eu au moins une correction
  const filesAutoRepaired = files.filter((f) =>
    (f.warnings?.some((w) => w.includes('OutputCleaner') || w.includes('fixed') || w.includes('import'))) ?? false
  ).length + compilFixes;

  // Compilation
  const compilPass   = compilationResult ? compilationResult.success : null;
  const compilStatus: ConversionReport['compilationStatus'] =
    compilationResult === undefined ? 'SKIPPED'
    : compilPass ? 'PASS' : 'FAIL';

  // Round-trip score
  const roundTripScore = roundTripResult?.averageScore ?? 0;

  // Repository score: utiliser dataLayer si disponible, sinon axe api comme proxy
  const repositoriesScore = repoFiles > 0
    ? Math.min(100, Math.round((repoFiles / Math.max(1, svcFiles + 1)) * 100))
    : fidelityScore.dataLayer;

  // Services score: utiliser api comme base
  const servicesScore = svcFiles > 0
    ? Math.min(100, fidelityScore.api + (svcFiles > 2 ? 10 : 0))
    : fidelityScore.api;

  // Overall: moyenne pondérée améliorée avec compilation
  const compilBonus   = compilStatus === 'PASS' ? 5 : compilStatus === 'SKIPPED' ? 0 : -10;
  const roundTripBonus = roundTripScore > 0 ? Math.round(roundTripScore * 0.1) : 0;
  const rawOverall    = fidelityScore.overall + compilBonus + roundTripBonus;
  const overallFidelity = Math.max(0, Math.min(100, rawOverall));

  // Ready for production: score ≥ 80% + compilation OK + pas d'erreurs critiques
  const readyForProduction =
    overallFidelity >= 80 &&
    compilStatus !== 'FAIL' &&
    (compilationResult?.errors.filter((e) => e.severity === 'error').length ?? 0) === 0;

  return {
    businessLogic:     fidelityScore.businessLogic,
    navigation:        fidelityScore.navigation,
    repositories:      repositoriesScore,
    services:          servicesScore,
    stores:            fidelityScore.stores,
    api:               fidelityScore.api,
    uiFidelity:        fidelityScore.uiFidelity,
    compilation:       compilStatus === 'PASS' || compilStatus === 'SKIPPED',
    roundTrip:         roundTripScore,
    filesGenerated:    files.length,
    filesAutoRepaired,
    warnings:          totalWarnings,
    errorsFixed,
    overallFidelity,
    compilationStatus: compilStatus,
    readyForProduction,
    ...(projectName !== undefined ? { projectName } : {}),
    ...(conversionType !== undefined ? { conversionType } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(aiTier !== undefined ? { aiTier } : {}),
    timestamp:         new Date().toISOString(),
  };
}

// ── Formater le rapport en texte (format exact demandé) ─────────────────

export function formatConversionReport(report: ConversionReport): string {
  const bar = (score: number): string => {
    const pct = Math.min(100, Math.max(0, score));
    const filled = Math.round(pct / 10);
    return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${String(pct).padStart(3)}%`;
  };

  const compilIcon = report.compilationStatus === 'PASS' ? '✅'
    : report.compilationStatus === 'FAIL' ? '❌'
    : '⏭️ ';

  const lines = [
    ``,
    `=========================`,
    `CONVERSION REPORT`,
    ...(report.projectName ? [`Project           : ${report.projectName}`] : []),
    ...(report.conversionType ? [`Conversion         : ${report.conversionType}`] : []),
    ...(report.aiTier ? [`AI Tier            : ${report.aiTier}`] : []),
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
    `Compilation Status : ${report.compilationStatus}`,
    `Ready For Production: ${report.readyForProduction ? '✅ YES' : '❌ NO'}`,
    ...(report.duration ? [`Duration           : ${Math.round(report.duration / 1000)}s`] : []),
    ...(report.timestamp ? [`Generated At       : ${report.timestamp}`] : []),
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
  const icon = (score: number): string =>
    score >= 80 ? '✅' : score >= 50 ? '⚠️' : '❌';

  const rows = [
    ['Business Logic',  report.businessLogic],
    ['Navigation',      report.navigation],
    ['Repositories',    report.repositories],
    ['Services',        report.services],
    ['Stores',          report.stores],
    ['API',             report.api],
    ['UI Fidelity',     report.uiFidelity],
    ['Round-trip',      report.roundTrip],
    ['Overall',         report.overallFidelity],
  ] as const;

  const tableRows = rows.map(([name, score]) =>
    `| ${icon(score)} **${name}** | ${score}% | ${'█'.repeat(Math.round(score / 10))}${'░'.repeat(10 - Math.round(score / 10))} |`
  ).join('\n');

  return `# CodeMorph Conversion Report

${report.projectName ? `**Project:** ${report.projectName}  ` : ''}
${report.conversionType ? `**Conversion:** ${report.conversionType}  ` : ''}
${report.aiTier ? `**AI Tier:** ${report.aiTier}  ` : ''}
${report.timestamp ? `**Generated:** ${report.timestamp}  ` : ''}

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

## Summary

**Overall Fidelity: ${report.overallFidelity}%** — ${
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
  const colorForScore = (score: number): string =>
    score >= 80 ? '#0BA66A' : score >= 50 ? '#F57C00' : '#D32F2F';

  const metrics = [
    ['Business Logic',  report.businessLogic],
    ['Navigation',      report.navigation],
    ['Repositories',    report.repositories],
    ['Services',        report.services],
    ['Stores',          report.stores],
    ['API',             report.api],
    ['UI Fidelity',     report.uiFidelity],
    ['Round-trip',      report.roundTrip],
  ] as const;

  const metricRows = metrics.map(([name, score]) => `
    <tr>
      <td>${name}</td>
      <td>
        <div style="background:#eee;border-radius:4px;height:16px;width:200px">
          <div style="background:${colorForScore(score)};height:16px;width:${score * 2}px;border-radius:4px"></div>
        </div>
      </td>
      <td style="color:${colorForScore(score)};font-weight:bold">${score}%</td>
    </tr>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>CodeMorph Conversion Report${report.projectName ? ` — ${report.projectName}` : ''}</title>
  <style>
    body { font-family: 'Segoe UI', sans-serif; max-width: 800px; margin: 40px auto; color: #1A1A2E; }
    h1 { color: #B83A3A; border-bottom: 2px solid #B83A3A; padding-bottom: 8px; }
    h2 { color: #1A1A2E; margin-top: 32px; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0; }
    td, th { padding: 10px 14px; border-bottom: 1px solid #E5E7EB; text-align: left; }
    th { background: #F5F6FA; font-weight: 600; }
    .badge { padding: 4px 10px; border-radius: 12px; font-weight: bold; font-size: 13px; }
    .pass { background: #E6F7F0; color: #0BA66A; }
    .fail { background: #FFEBEE; color: #D32F2F; }
    .skip { background: #FFF3E0; color: #F57C00; }
    .overall { font-size: 32px; font-weight: 700; color: ${colorForScore(report.overallFidelity)}; }
    .summary-box { border: 2px solid ${report.readyForProduction ? '#0BA66A' : '#F57C00'}; 
                   background: ${report.readyForProduction ? '#E6F7F0' : '#FFF3E0'};
                   border-radius: 8px; padding: 16px 20px; margin: 24px 0; }
  </style>
</head>
<body>
  <h1>🔄 CodeMorph Conversion Report</h1>
  ${report.projectName ? `<p><strong>Project:</strong> ${report.projectName}</p>` : ''}
  ${report.conversionType ? `<p><strong>Conversion:</strong> ${report.conversionType}</p>` : ''}
  ${report.aiTier ? `<p><strong>AI Tier:</strong> ${report.aiTier}</p>` : ''}
  ${report.timestamp ? `<p><strong>Generated:</strong> ${report.timestamp}</p>` : ''}

  <h2>📊 Fidelity Scores</h2>
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

  <h2>🎯 Overall Result</h2>
  <div class="summary-box">
    <p class="overall">${report.overallFidelity}% Overall Fidelity</p>
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
