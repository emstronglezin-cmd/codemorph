// ============================================================
// CodeMorph AI Engine — PHASE 36: Global Context Builder
//
// Chaque requête envoyée au modèle reçoit :
//   A. GLOBAL CONTEXT — représentation compacte et structurée du projet
//      ENTIER (inventaires + architecture + relations), JAMAIS le code complet.
//   B. CONTENU COMPLET du module traité (le chunk).
//   C. SIGNATURES des dépendances nécessaires (imports/exports/classes/methods
//      des fichiers dont dépend le chunk — pas leur corps complet).
//   D. NOTES des modules déjà analysés lorsque pertinents.
//
// Le contexte global est budgété (AI_GLOBAL_CONTEXT_TOKENS) et compressé
// intelligemment : on réduit la taille SANS réduire l'information nécessaire
// au raisonnement.
// ============================================================

import { estimateTokens, getPhase36Config } from './config';
import type { ModuleIR, ProjectManifest, SemanticChunk } from './types';

/** Signature compacte d'un fichier : exports, classes, fonctions, imports clés. */
function fileSignature(manifest: ProjectManifest, path: string): string {
  const f = manifest.files.find((x) => x.path === path);
  if (!f) return `- ${path} (détails non disponibles)`;
  const parts = [
    `- ${path} [${f.role}]`,
    f.exports.length > 0 ? `  exports: ${f.exports.slice(0, 8).join(', ')}` : '',
    f.classes.length > 0 ? `  classes: ${f.classes.slice(0, 8).join(', ')}` : '',
    f.functions.length > 0 ? `  functions: ${f.functions.slice(0, 10).join(', ')}` : '',
  ].filter(Boolean);
  return parts.join('\n');
}

/**
 * Bloc GLOBAL CONTEXT — compact, structuré, budgété.
 * Contient : méta, inventaires par rôle (noms réels), architecture détectée,
 * relations inter-modules, variables d'env, dépendances externes.
 */
export function renderGlobalContext(manifest: ProjectManifest, maxTokens?: number): string {
  const cfg = getPhase36Config();
  const budget = maxTokens ?? cfg.globalContextTokens;

  const inv = manifest.roleCounts;
  const inventoryLines: string[] = [];
  for (const role of Object.keys(inv).sort()) {
    const roleFiles = manifest.files.filter((f) => f.role === role);
    const names = roleFiles
      .map((f) => f.path.split('/').pop()?.replace(/\.(dart|tsx?|jsx?)$/, '') ?? f.path)
      .slice(0, 14)
      .join(', ');
    const more = roleFiles.length > 14 ? ` … (+${roleFiles.length - 14})` : '';
    inventoryLines.push(`${role}(${inv[role]}): ${names}${more}`);
  }

  const moduleLines = manifest.modules
    .filter((m) => m.dependsOn.length > 0)
    .slice(0, 12)
    .map((m) => `${m.id} → depends on: ${m.dependsOn.join(', ')}`);

  const lines: string[] = [
    `GLOBAL PROJECT CONTEXT (compressed — full source NOT included)`,
    `project=${manifest.projectId} stack=${manifest.sourceFramework} → ${manifest.targetFramework}`,
    `scale=${manifest.totalFiles} files / ${manifest.totalLines} lines`,
    `navigation=${manifest.navigationPattern} | state=${manifest.statePatterns.join(',') || 'none'} | auth=${manifest.authPatterns.join(',') || 'none'} | storage=${manifest.storagePatterns.join(',') || 'none'}`,
    `external=${manifest.externalServices.join(',') || 'none'} | api=${manifest.apiPatterns.slice(0, 6).join(',') || 'none'}`,
    ``,
    `FILE INVENTORY BY ROLE:`,
    ...inventoryLines.map((l) => `  ${l}`),
  ];

  if (moduleLines.length > 0) {
    lines.push(``, `MODULE DEPENDENCIES:`, ...moduleLines.map((l) => `  ${l}`));
  }

  if (manifest.envVarKeys.length > 0) {
    lines.push(``, `ENV VARS: ${manifest.envVarKeys.slice(0, 15).join(', ')}`);
  }
  if (manifest.dependencies.length > 0) {
    lines.push(`DEPENDENCIES: ${manifest.dependencies.slice(0, 20).join(', ')}`);
  }

  // ── Garde-fou budget : compresser l'inventaire (noms → compteurs) si trop long ──
  let context = lines.join('\n');
  if (estimateTokens(context) > budget) {
    const compact: string[] = [
      `GLOBAL PROJECT CONTEXT (compressed — full source NOT included)`,
      `project=${manifest.projectId} stack=${manifest.sourceFramework} → ${manifest.targetFramework}`,
      `scale=${manifest.totalFiles} files / ${manifest.totalLines} lines`,
      `navigation=${manifest.navigationPattern} | state=${manifest.statePatterns.join(',') || 'none'} | auth=${manifest.authPatterns.join(',') || 'none'}`,
      `FILE COUNTS BY ROLE: ${Object.entries(inv).map(([r, n]) => `${r}=${n}`).join(', ')}`,
    ];
    if (moduleLines.length > 0) {
      compact.push(`MODULE DEPENDENCIES:`, ...moduleLines.slice(0, 8).map((l) => `  ${l}`));
    }
    if (manifest.envVarKeys.length > 0) {
      compact.push(`ENV VARS: ${manifest.envVarKeys.slice(0, 12).join(', ')}`);
    }
    context = compact.join('\n');
  }

  return context;
}

/**
 * Bloc DEPENDENCY SIGNATURES — signatures des fichiers dont le chunk dépend,
 * situés dans d'autres chunks. On ne renvoie que ce qui est pertinent.
 */
export function renderDependencyContext(
  manifest: ProjectManifest,
  chunk: SemanticChunk,
  analyzedSummaries: Map<string, ModuleIR>,
  maxTokens?: number,
): string {
  const cfg = getPhase36Config();
  const budget = maxTokens ?? cfg.depContextTokens;
  if (chunk.externalDeps.length === 0) return '';

  const sections: string[] = [];
  let current = `DEPENDENCY SIGNATURES (from other modules — signatures only, full code comes with each module's own conversion):`;

  for (const depPath of chunk.externalDeps.slice(0, 12)) {
    const sig = fileSignature(manifest, depPath);
    sections.push(sig);
  }

  // Ajouter les notes des modules déjà analysés qui fournissent ces dépendances
  for (const [, ir] of analyzedSummaries.entries()) {
    if (ir.notes.length === 0) continue;
    const relevant = chunk.externalDeps.some((d) => ir.files.includes(d));
    if (relevant) {
      sections.push(`analyzed notes from ${ir.moduleId}: ${ir.notes.slice(0, 4).join(' | ')}`);
    }
  }

  let body = sections.join('\n');
  // Budget : retirer des sections jusqu'à rentrer
  let list = [...sections];
  while (estimateTokens(current + body) > budget && list.length > 1) {
    list = list.slice(0, -1);
    body = list.join('\n') + `\n(+${sections.length - list.length} more dependencies omitted)`;
  }

  if (list.length === 0) return '';
  return `${current}\n${body}`;
}

/** Résumé compact d'une ModuleIR pour injection dans les chunks suivants (point D). */
export function moduleIRSummary(ir: ModuleIR): string {
  const parts: string[] = [];
  if (ir.screens.length > 0) parts.push(`screens: ${ir.screens.map((s) => s.name).join(', ')}`);
  if (ir.components.length > 0) parts.push(`components: ${ir.components.map((c) => c.name).slice(0, 8).join(', ')}`);
  if (ir.services.length > 0) parts.push(`services: ${ir.services.map((s) => s.name).join(', ')}`);
  if (ir.models.length > 0) parts.push(`models: ${ir.models.map((m) => m.name).join(', ')}`);
  if (ir.stateFlow.length > 0) parts.push(`stores: ${ir.stateFlow.map((s) => s.store).join(', ')}`);
  if (ir.routes.length > 0) parts.push(`routes: ${ir.routes.map((r) => `${r.method} ${r.path}`).slice(0, 6).join(', ')}`);
  if (ir.apiCalls.length > 0) parts.push(`apiCalls: ${ir.apiCalls.map((a) => `${a.method} ${a.url}`).slice(0, 6).join(', ')}`);
  return parts.join(' | ');
}
