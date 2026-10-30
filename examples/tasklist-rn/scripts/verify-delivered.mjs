#!/usr/bin/env node
/**
 * Vérification indépendante du projet livré — PHASE 52.
 *
 * Ce script ne fait confiance à AUCUN rapport du moteur : il relit les fichiers
 * sur disque. Sortie : une ligne par contrôle avec PASS / FAIL et la preuve.
 *
 * Usage : node scripts/verify-delivered.mjs [dir]
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, dirname, posix, relative } from 'path';

const ROOT = process.argv[2] ?? '.';
const results = [];
const record = (name, pass, detail) => {
  results.push({ name, status: pass ? 'PASS' : 'FAIL', detail });
};

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.expo' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const allFiles = walk(ROOT).map((f) => relative(ROOT, f).split('\\').join('/'));
const allLower = new Map(allFiles.map((f) => [f.toLowerCase(), f]));
const code = allFiles.filter((f) => /\.(ts|tsx)$/.test(f) && !/__tests__\//.test(f));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// ── 1. Imports locaux ────────────────────────────────────────────────────────
{
  const broken = [];
  let total = 0;
  for (const file of code) {
    const src = read(file);
    const re = /(?:import|export)[\s\S]*?from\s+['"](\.[^'"]*)['"]/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const spec = m[1];
      total++;
      const target = posix.normalize(posix.join(dirname(file), spec));
      const candidates = [target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`, `${target}/index.tsx`];
      const hit = candidates.find((c) => allLower.has(c.toLowerCase()));
      if (!hit) {
        broken.push(`${file} → ${spec} (aucun fichier)`);
        continue;
      }
      // Casse exacte : le fichier résolu doit avoir EXACTEMENT la casse écrite.
      const real = allLower.get(hit.toLowerCase());
      if (real !== hit) broken.push(`${file} → ${spec} (casse : écrit « ${hit} », réel « ${real} »)`);
    }
  }
  record('1. Imports locaux résolvent (chemin + casse exacte)', broken.length === 0,
    `${total} imports locaux, ${broken.length} cassé(s)${broken.length ? ' : ' + broken.join(' ; ') : ''}`);
}

// ── 2. Dépendances déclarées ─────────────────────────────────────────────────
{
  const pkg = JSON.parse(read('package.json'));
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
  const missing = new Set();
  for (const file of allFiles.filter((f) => /\.(ts|tsx|js)$/.test(f))) {
    const src = read(file);
    const re = /(?:import|export)[\s\S]*?from\s+['"]([^.'"][^'"]*)['"]/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const spec = m[1];
      const root = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (root && !declared.has(root)) missing.add(`${root} (dans ${file})`);
    }
  }
  record('2. Toute dépendance importée est déclarée', missing.size === 0,
    missing.size === 0 ? `${declared.size} dépendances déclarées, 0 import non déclaré`
      : [...missing].join(' ; '));
}

// ── 3. Modèle unique et champ de complétion unique ───────────────────────────
{
  const decls = [];
  const completionFields = new Set();
  for (const file of code) {
    const src = read(file);
    for (const m of src.matchAll(/export\s+(?:interface|type)\s+(Task\w*)\b/g)) decls.push(`${m[1]} (${file})`);
    for (const m of src.matchAll(/\b(isDone|completed|done|finished)\s*[?:]/g)) completionFields.add(m[1]);
  }
  const unique = decls.filter((d) => d.startsWith('Task '));
  record('3. Un seul modèle Task, un seul champ de complétion',
    unique.length === 1 && completionFields.size <= 1,
    `déclarations Task* : [${decls.join(', ') || 'aucune'}] ; champs de complétion : [${[...completionFields].join(', ') || 'aucun'}]`);
}

// ── 4. Routes Expo Router ────────────────────────────────────────────────────
{
  const layoutPath = allFiles.find((f) => f === 'app/_layout.tsx');
  const declared = [];
  if (layoutPath) {
    const src = read(layoutPath);
    for (const m of src.matchAll(/<Stack\.Screen\s+name=["']([^"']+)["']/g)) declared.push(m[1]);
  }
  const present = allFiles
    .filter((f) => /^app\/[^/]+\.(tsx|ts)$/.test(f) && !/_layout/.test(f))
    .map((f) => f.replace(/^app\//, '').replace(/\.(tsx|ts)$/, ''))
    .sort();
  const missingRoute = declared.filter((d) => !present.includes(d));
  const undeclared = present.filter((p) => !declared.includes(p));
  const hasIndex = present.includes('index');
  record('4. Routes déclarées == fichiers présents, accueil en app/index.tsx',
    missingRoute.length === 0 && undeclared.length === 0 && hasIndex,
    `déclarées [${declared.sort().join(', ')}] ; fichiers [${present.join(', ')}] ; ` +
    `manquantes [${missingRoute.join(', ')}] ; non déclarées [${undeclared.join(', ')}]`);
}

// ── 5. Aucune fonction passée en paramètre de route ──────────────────────────
{
  const offenders = [];
  for (const file of code) {
    const src = read(file);
    for (const m of src.matchAll(/router\.(push|replace|navigate)\s*\(\s*\{[\s\S]{0,200}?\}/g)) {
      if (/=>|function\s*\(/.test(m[0])) offenders.push(`${file} : ${m[0].slice(0, 80)}`);
    }
    if (/router\.(back|push|replace)\s*\(\s*(\(\s*\)\s*=>|function)/.test(src)) offenders.push(`${file} : callback en paramètre`);
  }
  record('5. Aucune fonction transmise par la navigation', offenders.length === 0,
    offenders.length === 0 ? '0 callback dans les paramètres de route' : offenders.join(' ; '));
}

// ── 6. Contrat du service complet + instance partagée ────────────────────────
{
  const svcPath = allFiles.find((f) => /services\/.*service\.ts$/.test(f));
  if (!svcPath) {
    record('6. Contrat du service complet', false, 'aucun fichier de service trouvé');
  } else {
    const src = read(svcPath);
    const needed = ['getAll', 'add', 'toggle', 'remove', 'subscribe'];
    const missing = needed.filter((n) => !new RegExp(`\\b${n}\\s*\\(`).test(src));
    const shared = /export\s+const\s+\w+\s*=\s*new\s+\w+Service\s*\(/.test(src);
    // Aucune instance créée dans les écrans.
    const strayInstances = code
      .filter((f) => !/services\//.test(f))
      .filter((f) => /new\s+\w*Service\s*\(/.test(read(f)));
    record('6. Contrat du service complet + instance partagée unique',
      missing.length === 0 && shared && strayInstances.length === 0,
      `méthodes manquantes [${missing.join(', ')}] ; singleton exporté : ${shared} ; ` +
      `instances créées dans les écrans : [${strayInstances.join(', ')}]`);
  }
}

// ── 7. Aucun placeholder NEEDS MANUAL REVIEW ni TODO essentiel ───────────────
{
  const offenders = [];
  for (const file of code) {
    const src = read(file);
    if (/NEEDS_MANUAL_REVIEW|NEEDS MANUAL REVIEW|SHELL_401/.test(src)) offenders.push(file);
  }
  record('7. Aucun placeholder NEEDS MANUAL REVIEW', offenders.length === 0,
    offenders.length === 0 ? '0 placeholder' : offenders.join(', '));
}

// ── Sortie ───────────────────────────────────────────────────────────────────
let failed = 0;
console.log('\n=== VÉRIFICATION INDÉPENDANTE DU PROJET LIVRÉ ===\n');
for (const r of results) {
  const icon = r.status === 'PASS' ? '✅' : '❌';
  console.log(`${icon} ${r.status}  ${r.name}`);
  console.log(`        ${r.detail}\n`);
  if (r.status === 'FAIL') failed++;
}
console.log(`Résultat : ${results.length - failed}/${results.length} contrôles PASS`);
process.exit(failed === 0 ? 0 : 1);
