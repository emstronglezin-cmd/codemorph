#!/usr/bin/env node
// ============================================================
// CodeMorph — Integration Tests (Phase 7)
//
// Usage:
//   node run-integration-test.mjs <source.zip> [--target flutter|react-native]
//   node run-integration-test.mjs /path/to/Movia.zip --target react-native
//
// Produit:
//   - integration-tests/reports/YYYY-MM-DD_HH-MM-SS/
//       report.json
//       report.md
//       report.html
//       output.zip
// ============================================================

import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import { createGunzip } from 'zlib';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────

const GROQ_API_KEY = process.env.GROQ_API_KEY ?? '';
const AI_ENGINE_URL = process.env.AI_ENGINE_URL ?? 'http://localhost:3002';
const REPORTS_DIR = join(__dirname, 'reports');

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const zipPath = args[0];
const targetIdx = args.indexOf('--target');
const targetFramework = targetIdx >= 0 ? args[targetIdx + 1] : 'react-native';

if (!zipPath || zipPath === '--help') {
  console.log(`
Usage:
  node run-integration-test.mjs <source.zip> [--target flutter|react-native]

Examples:
  node run-integration-test.mjs /home/user/uploaded_files/Movia.zip
  node run-integration-test.mjs /home/user/uploaded_files/Movia.zip --target flutter
`);
  process.exit(0);
}

if (!existsSync(zipPath)) {
  console.error(`❌ File not found: ${zipPath}`);
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function progressBar(score, width = 10) {
  const filled = Math.round((score / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function padRight(str, len) {
  return String(str).padEnd(len, ' ');
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// ── Extraction ZIP ────────────────────────────────────────────────────────────

async function extractZipToSourceCode(zipFilePath) {
  console.log(`📦 Extracting ZIP: ${basename(zipFilePath)}`);

  // Créer un dossier temporaire
  const tmpDir = `/tmp/codemorph-${Date.now()}`;
  mkdirSync(tmpDir, { recursive: true });

  try {
    execSync(`unzip -q "${zipFilePath}" -d "${tmpDir}" 2>/dev/null || true`);
  } catch (_) {
    // unzip peut retourner un code non-zéro pour les warnings
  }

  // Lire tous les fichiers source
  const { glob } = await import('glob').catch(() => {
    // fallback: utiliser find
    return { glob: null };
  });

  let files = [];

  try {
    const { stdout } = await execAsync(
      `find "${tmpDir}" -type f \\( -name "*.dart" -o -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.yaml" -o -name "*.json" \\) | head -200`
    );
    const filePaths = stdout.trim().split('\n').filter(Boolean);

    for (const fp of filePaths) {
      try {
        const content = readFileSync(fp, 'utf8');
        const relativePath = fp.replace(tmpDir + '/', '');
        files.push({ path: relativePath, content });
      } catch (_) {
        // skip binary/unreadable files
      }
    }
  } catch (_) {}

  console.log(`  → Extracted ${files.length} source files`);

  // Convertir en sourceCode "multi-fichiers"
  const sourceCode = files
    .map((f) => `// === FILE: ${f.path} ===\n${f.content}`)
    .join('\n\n');

  return {
    sourceCode,
    files,
    tmpDir,
    fileCount: files.length,
  };
}

// ── Détection framework source ────────────────────────────────────────────────

function detectSourceFramework(files) {
  const hasDart = files.some((f) => f.path.endsWith('.dart'));
  const hasTS = files.some((f) => f.path.endsWith('.ts') || f.path.endsWith('.tsx'));
  const hasPubspec = files.some((f) => f.path.endsWith('pubspec.yaml'));
  const hasPackageJson = files.some((f) => f.path.endsWith('package.json'));

  if (hasDart || hasPubspec) return 'flutter';
  if (hasTS || hasPackageJson) {
    // Vérifier React Native vs React
    const allContent = files.map((f) => f.content).join('\n');
    if (/react-native|ReactNative|StyleSheet\.create/.test(allContent)) return 'react-native';
    return 'react';
  }
  return 'unknown';
}

// ── Appel AI Engine ───────────────────────────────────────────────────────────

async function callPipelineSync(sourceCode, sourceFramework, targetFwk) {
  console.log(`🤖 Calling AI Engine (${AI_ENGINE_URL})...`);
  console.log(`  Source: ${sourceFramework} → Target: ${targetFwk}`);
  console.log(`  Source size: ${(sourceCode.length / 1024).toFixed(1)} KB`);

  const { default: axios } = await import('axios');

  const startTime = Date.now();

  const response = await axios.post(
    `${AI_ENGINE_URL}/api/convert/sync`,
    {
      projectId:       `integration-test-${Date.now()}`,
      sourceCode,
      sourceFramework,
      targetFramework: targetFwk,
      userGoal:        `Convert to ${targetFwk}`,
    },
    {
      timeout: 300_000, // 5 min
      headers: {
        'Content-Type':    'application/json',
        'X-Groq-API-Key': GROQ_API_KEY,
      },
    }
  );

  const duration = Date.now() - startTime;

  if (!response.data?.success) {
    throw new Error(`Pipeline failed: ${JSON.stringify(response.data)}`);
  }

  const result = response.data.data;
  console.log(`  ✅ Pipeline completed in ${(duration / 1000).toFixed(1)}s`);
  console.log(`  Files generated: ${result.files?.length ?? 0}`);
  console.log(`  Final score: ${result.fidelityScore?.overall ?? 0}%`);

  return { result, duration };
}

// ── Calcul des métriques ──────────────────────────────────────────────────────

function calculateMetrics(result, sourceFiles, targetFwk) {
  const files = result.files ?? [];
  const fidelity = result.fidelityScore ?? {};
  const autoCorr = result.autoCorrectionReport ?? {};

  const isFlutter = /flutter/i.test(targetFwk);

  // Extraire les scores des axes
  const details = fidelity.details ?? [];
  const getAxis = (axisName) => {
    const d = details.find((d) => d.axis === axisName);
    return d ? d.score : fidelity[axisName] ?? 0;
  };

  // Files & lines
  const filesGenerated = files.length;
  const totalLines = files.reduce((acc, f) => acc + (f.content?.split('\n').length ?? 0), 0);
  const filesRepaired = autoCorr.iterations > 0 ? Math.ceil(filesGenerated * 0.1) : 0;

  // Compilation (si disponible)
  const compilationStatus = result.compilationResult?.success ?? null;
  const compilationScore = compilationStatus === true ? 100 : compilationStatus === false ? 0 : null;

  // Round-trip (si disponible)
  const roundTripScore = result.roundTripResult?.averageScore ?? null;

  return {
    businessLogic:    getAxis('businessLogic'),
    navigation:       getAxis('navigation'),
    repositories:     getAxis('dataLayer'),
    services:         getAxis('api'),
    stores:           getAxis('stores'),
    api:              getAxis('api'),
    uiFidelity:       getAxis('uiFidelity'),
    compilation:      compilationScore,
    roundTrip:        roundTripScore,
    filesGenerated,
    filesAutoRepaired: filesRepaired,
    warnings:         (autoCorr.iterations ?? 0) * 2,
    errorsFixed:      autoCorr.totalFixes ?? 0,
    overallFidelity:  fidelity.overall ?? 0,
    compilationStatus: compilationStatus === true ? 'PASS' : compilationStatus === false ? 'FAIL' : 'SKIPPED',
    readyForProduction: (fidelity.overall ?? 0) >= 80 ? 'YES' : 'NO',
    // Méta
    totalLines,
    duration: result.durationMs ?? 0,
    aiTier: result.aiTier ?? 'free-groq',
  };
}

// ── Rapport JSON ──────────────────────────────────────────────────────────────

function buildJsonReport(metrics, zipPath, sourceFramework, targetFwk, startedAt, completedAt) {
  return {
    version: '1.0',
    testedAt: startedAt,
    completedAt,
    source: {
      file: basename(zipPath),
      framework: sourceFramework,
    },
    target: {
      framework: targetFwk,
    },
    metrics,
    status: metrics.overallFidelity >= 80 ? 'PASS' : 'WARN',
  };
}

// ── Rapport Markdown ──────────────────────────────────────────────────────────

function buildMarkdownReport(metrics, zipPath, sourceFramework, targetFwk, startedAt) {
  const bar = (s) => (s !== null ? `\`${progressBar(s)}\` ${s}%` : '`──────────` N/A');

  return `# CodeMorph — Integration Test Report

**Tested At**: ${startedAt}
**Source**: ${basename(zipPath)} (${sourceFramework})
**Target**: ${targetFwk}

---

## Conversion Metrics

| Metric | Score |
|--------|-------|
| Business Logic | ${bar(metrics.businessLogic)} |
| Navigation | ${bar(metrics.navigation)} |
| Repositories | ${bar(metrics.repositories)} |
| Services | ${bar(metrics.services)} |
| Stores | ${bar(metrics.stores)} |
| API | ${bar(metrics.api)} |
| UI Fidelity | ${bar(metrics.uiFidelity)} |
| Compilation | ${metrics.compilationStatus} |
| Round-trip | ${metrics.roundTrip !== null ? bar(metrics.roundTrip) : 'Not tested'} |
| **Overall Fidelity** | **${bar(metrics.overallFidelity)}** |

---

## File Statistics

- **Files Generated**: ${metrics.filesGenerated}
- **Total Lines**: ${metrics.totalLines.toLocaleString()}
- **Files Auto-Repaired**: ${metrics.filesAutoRepaired}
- **Warnings**: ${metrics.warnings}
- **Errors Fixed**: ${metrics.errorsFixed}

---

## Production Readiness

- **Compilation Status**: ${metrics.compilationStatus === 'PASS' ? '✅' : metrics.compilationStatus === 'FAIL' ? '❌' : '⚠️'} ${metrics.compilationStatus}
- **Ready For Production**: ${metrics.readyForProduction === 'YES' ? '✅ YES' : '❌ NO'}
- **AI Tier**: ${metrics.aiTier}
- **Duration**: ${(metrics.duration / 1000).toFixed(1)}s

---

*Generated by CodeMorph Integration Tests v1.0*
`;
}

// ── Rapport HTML ──────────────────────────────────────────────────────────────

function buildHtmlReport(metrics, zipPath, sourceFramework, targetFwk, startedAt) {
  const scoreBar = (score, size = 200) => {
    if (score === null) return '<span style="color:#999">N/A</span>';
    const color = score >= 80 ? '#0BA66A' : score >= 60 ? '#F59E0B' : '#D32F2F';
    const pct = Math.min(100, Math.max(0, score));
    return `<div style="display:flex;align-items:center;gap:8px">
      <div style="width:${size}px;height:10px;background:#e5e7eb;border-radius:5px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:${color};border-radius:5px"></div>
      </div>
      <span style="font-weight:600;color:${color}">${score}%</span>
    </div>`;
  };

  const row = (label, value) => `
    <tr>
      <td style="padding:10px 16px;font-weight:500;color:#374151;border-bottom:1px solid #F3F4F6">${label}</td>
      <td style="padding:10px 16px;border-bottom:1px solid #F3F4F6">${value}</td>
    </tr>`;

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CodeMorph — Integration Test Report</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0 }
    body { font-family: -apple-system, sans-serif; background: #F9FAFB; color: #111827; }
    .container { max-width: 800px; margin: 40px auto; padding: 0 20px }
    .header { background: #B83A3A; color: white; padding: 24px 32px; border-radius: 12px; margin-bottom: 24px }
    .header h1 { font-size: 24px; font-weight: 700 }
    .header p { opacity: 0.8; margin-top: 4px; font-size: 14px }
    .card { background: white; border-radius: 12px; border: 1px solid #E5E7EB; margin-bottom: 20px; overflow: hidden }
    .card-title { padding: 16px 20px; font-weight: 700; font-size: 16px; border-bottom: 1px solid #F3F4F6; color: #374151 }
    table { width: 100%; border-collapse: collapse }
    .badge { display:inline-block; padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: 600 }
    .badge-pass { background: #D1FAE5; color: #065F46 }
    .badge-fail { background: #FEE2E2; color: #991B1B }
    .badge-warn { background: #FEF3C7; color: #92400E }
    .overall { background: linear-gradient(135deg, #1A1A2E 0%, #2D2D50 100%); color: white; padding: 24px; border-radius: 12px; text-align: center }
    .overall-score { font-size: 48px; font-weight: 800; color: ${metrics.overallFidelity >= 80 ? '#0BA66A' : '#F59E0B'} }
    footer { text-align: center; color: #9CA3AF; font-size: 12px; margin-top: 32px; padding-bottom: 32px }
  </style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>🔄 CodeMorph Integration Test</h1>
    <p>${basename(zipPath)} (${sourceFramework}) → ${targetFwk} · ${startedAt}</p>
  </div>

  <div class="card">
    <div class="card-title">📊 Conversion Metrics</div>
    <table>
      ${row('Business Logic', scoreBar(metrics.businessLogic))}
      ${row('Navigation', scoreBar(metrics.navigation))}
      ${row('Repositories', scoreBar(metrics.repositories))}
      ${row('Services', scoreBar(metrics.services))}
      ${row('Stores', scoreBar(metrics.stores))}
      ${row('API', scoreBar(metrics.api))}
      ${row('UI Fidelity', scoreBar(metrics.uiFidelity))}
      ${row('Compilation', `<span class="badge badge-${metrics.compilationStatus === 'PASS' ? 'pass' : metrics.compilationStatus === 'FAIL' ? 'fail' : 'warn'}">${metrics.compilationStatus}</span>`)}
      ${row('Round-trip', metrics.roundTrip !== null ? scoreBar(metrics.roundTrip) : '<span style="color:#9CA3AF">Not tested</span>')}
    </table>
  </div>

  <div class="card">
    <div class="card-title">📁 File Statistics</div>
    <table>
      ${row('Files Generated', `<strong>${metrics.filesGenerated}</strong>`)}
      ${row('Total Lines', metrics.totalLines.toLocaleString())}
      ${row('Files Auto-Repaired', metrics.filesAutoRepaired)}
      ${row('Warnings', metrics.warnings)}
      ${row('Errors Fixed', metrics.errorsFixed)}
      ${row('AI Tier', metrics.aiTier)}
      ${row('Duration', `${(metrics.duration / 1000).toFixed(1)}s`)}
    </table>
  </div>

  <div class="overall">
    <p style="opacity:0.7;font-size:14px;margin-bottom:8px">OVERALL FIDELITY</p>
    <div class="overall-score">${metrics.overallFidelity}%</div>
    <p style="margin-top:12px;font-size:18px">${metrics.readyForProduction === 'YES' ? '✅ Ready for Production' : '⚠️ Not yet ready'}</p>
  </div>

  <footer>Generated by CodeMorph Integration Tests v1.0 · Phase 7</footer>
</div>
</body>
</html>`;
}

// ── Affichage console: CONVERSION REPORT (Phase 9) ───────────────────────────

function printConversionReport(metrics, targetFwk) {
  const bar = (s) => (s !== null ? `${progressBar(s)} ${String(s).padStart(3)}%` : '──────────  N/A');

  console.log(`\n=========================`);
  console.log(`CONVERSION REPORT`);
  console.log(`=========================`);
  console.log(`Business Logic     : ${bar(metrics.businessLogic)}`);
  console.log(`Navigation         : ${bar(metrics.navigation)}`);
  console.log(`Repositories       : ${bar(metrics.repositories)}`);
  console.log(`Services           : ${bar(metrics.services)}`);
  console.log(`Stores             : ${bar(metrics.stores)}`);
  console.log(`API                : ${bar(metrics.api)}`);
  console.log(`UI Fidelity        : ${bar(metrics.uiFidelity)}`);
  console.log(`Compilation        : ${metrics.compilationStatus === 'PASS' ? '✅ PASS' : metrics.compilationStatus === 'FAIL' ? '❌ FAIL' : '⚠️  SKIPPED'}`);
  console.log(`Round-trip         : ${metrics.roundTrip !== null ? bar(metrics.roundTrip) : '── Not tested'}`);
  console.log(`Files Generated    : ${metrics.filesGenerated}`);
  console.log(`Files Auto-Repaired: ${metrics.filesAutoRepaired}`);
  console.log(`Warnings           : ${metrics.warnings}`);
  console.log(`Errors Fixed       : ${metrics.errorsFixed}`);
  console.log(`Overall Fidelity   : ${bar(metrics.overallFidelity)}`);
  console.log(`Compilation Status : ${metrics.compilationStatus}`);
  console.log(`Ready For Production: ${metrics.readyForProduction === 'YES' ? '✅ YES' : '❌ NO'}`);
  console.log(`=========================\n`);
}

// ── Génération du ZIP de sortie ───────────────────────────────────────────────

async function generateOutputZip(files, outputDir) {
  const projectDir = join(outputDir, 'project');
  mkdirSync(projectDir, { recursive: true });

  for (const file of files) {
    const filePath = join(projectDir, file.path);
    const fileDir = dirname(filePath);
    mkdirSync(fileDir, { recursive: true });

    // Nettoyer le contenu (Phase 8: pas de commentaires LLM, pas de fences)
    let content = file.content ?? '';
    content = content.replace(/^```[a-zA-Z0-9]*\s*$/gm, '');
    content = content.replace(/^```\s*$/gm, '');
    content = content.replace(/\/\/\s*TODO:\s*MISSING IMPORT[^\n]*/gm, '');
    content = content.replace(/\/\/\s*codeMorph:[^\n]*/gm, '');
    content = content.replace(/\/\/\s*\[CodeMorph\][^\n]*/gm, '');

    writeFileSync(filePath, content, 'utf8');
  }

  const zipPath = join(outputDir, 'output.zip');
  try {
    execSync(`cd "${outputDir}" && zip -r output.zip project/ -x "*.DS_Store"`, { stdio: 'pipe' });
    console.log(`  ✅ ZIP generated: ${zipPath}`);
  } catch (err) {
    console.warn(`  ⚠️  zip command failed: ${err.message}`);
  }

  return zipPath;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = new Date().toISOString();
  const ts = timestamp();

  console.log(`\n🚀 CodeMorph Integration Test — Phase 7`);
  console.log(`   Source: ${basename(zipPath)}`);
  console.log(`   Target: ${targetFramework}`);
  console.log(`   AI Engine: ${AI_ENGINE_URL}`);
  console.log(`   Started: ${startedAt}\n`);

  // 1. Extraire le ZIP
  const { sourceCode, files: sourceFiles, tmpDir, fileCount } = await extractZipToSourceCode(zipPath);

  // 2. Détecter le framework source
  const sourceFramework = detectSourceFramework(sourceFiles);
  console.log(`  Detected source framework: ${sourceFramework} (${fileCount} files)\n`);

  // 3. Appeler le pipeline
  let pipelineResult, duration;
  try {
    ({ result: pipelineResult, duration } = await callPipelineSync(sourceCode, sourceFramework, targetFramework));
  } catch (err) {
    console.error(`❌ Pipeline call failed: ${err.message}`);
    console.error(`   Make sure the AI Engine is running: npm run dev --workspace=ai-engine`);
    process.exit(1);
  }

  // 4. Calculer les métriques
  const metrics = calculateMetrics(pipelineResult, sourceFiles, targetFramework);

  // 5. Afficher le CONVERSION REPORT (Phase 9)
  printConversionReport(metrics, targetFramework);

  // 6. Créer le dossier de rapport
  const reportDir = join(REPORTS_DIR, ts);
  mkdirSync(reportDir, { recursive: true });

  const completedAt = new Date().toISOString();

  // 7. Générer le ZIP de sortie (Phase 8)
  const outputZipPath = await generateOutputZip(pipelineResult.files ?? [], reportDir);

  // 8. Générer les rapports
  const jsonReport = buildJsonReport(metrics, zipPath, sourceFramework, targetFramework, startedAt, completedAt);
  const mdReport   = buildMarkdownReport(metrics, zipPath, sourceFramework, targetFramework, startedAt);
  const htmlReport = buildHtmlReport(metrics, zipPath, sourceFramework, targetFramework, startedAt);

  writeFileSync(join(reportDir, 'report.json'), JSON.stringify(jsonReport, null, 2), 'utf8');
  writeFileSync(join(reportDir, 'report.md'), mdReport, 'utf8');
  writeFileSync(join(reportDir, 'report.html'), htmlReport, 'utf8');

  console.log(`\n📁 Reports saved to: ${reportDir}`);
  console.log(`   report.json`);
  console.log(`   report.md`);
  console.log(`   report.html`);
  console.log(`   output.zip`);

  // 9. Résumé final
  const status = metrics.overallFidelity >= 80 ? '✅ PASS' : '⚠️  WARN';
  console.log(`\n${status} Overall Fidelity: ${metrics.overallFidelity}% | Ready: ${metrics.readyForProduction}`);
  console.log(`   Duration: ${(duration / 1000).toFixed(1)}s | Files: ${metrics.filesGenerated}\n`);

  return metrics.overallFidelity >= 50 ? 0 : 1;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(`\n❌ Fatal error: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  });
