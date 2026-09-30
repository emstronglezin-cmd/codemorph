// ============================================================
// CodeMorph AI Engine — PHASE 36: Semantic Chunker
//
// Découpage SÉMANTIQUE (jamais un slice arbitraire de caractères) :
//   1. Les fichiers sont groupés par rôle sémantique (models, services,
//      state, screens, navigation, auth, config…)
//   2. Les groupes sont ordonnés par dépendance (ce qui est dépendu d'abord)
//   3. Dans un groupe, les fichiers sont empaquetés sous le budget tokens
//      (AI_CHUNK_SIZE_TOKENS) — un fichier n'est JAMAIS coupé en plein milieu
//      sauf s'il dépasse seul le budget : il est alors découpé en PARTIES
//      LOGIQUES (classes/fonctions/imports) via le FileChunker Phase 28.
//   4. La TOTALITÉ du contenu source est couverte — aucun fichier supprimé,
//      aucune troncature silencieuse.
// ============================================================

import { estimateTokens, getPhase36Config } from './config';
import type { ManifestFile, ProjectManifest, SemanticChunk } from './types';

// ── Découpe logique SANS PERTE d'un fichier surdimensionné ────────────────────
// Principes :
//   • On coupe uniquement en FIN de bloc logique (accolades top-level refermées)
//     → jamais au milieu d'une classe/fonction.
//   • Chaque ligne du fichier va dans EXACTEMENT une partie → concat(lignes des
//     parties) === contenu original : zéro troncature silencieuse.
//   • Garde-fou : un bloc individuel plus grand que 3× le budget est coupé en
//     fin de ligne (jamais au milieu d'une ligne) pour respecter le budget.
function splitFileLogically(path: string, content: string, budgetTokens: number): string[] {
  void path;
  const lines = content.split('\n');
  const parts: string[] = [];
  let bucket: string[] = [];
  let bucketTokens = 0;
  let depth = 0;

  const pushBucket = (): void => {
    if (bucket.length === 0) return;
    parts.push(bucket.join('\n'));
    bucket = [];
    bucketTokens = 0;
  };

  for (const line of lines) {
    bucket.push(line);
    bucketTokens += Math.ceil((line.length / 4) * 1.08);
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
    // Coupure logique : fin d'un bloc top-level ET budget atteint
    if (depth === 0 && bucketTokens >= budgetTokens) pushBucket();
    // Garde-fou : bloc individuel gigantesque → coupure d'urgence en fin de ligne
    else if (depth > 0 && bucketTokens >= budgetTokens * 3) pushBucket();
  }
  pushBucket();
  return parts.length > 0 ? parts : [content];
}

export interface ChunkPlan {
  chunks: SemanticChunk[];
  totalEstimatedTokens: number;
}

/**
 * Construit les chunks sémantiques à partir du manifest.
 * - ordre: modules dans l'ordre sémantique (config → models → … → navigation)
 * - packing sous budget: plusieurs petits fichiers par chunk
 * - oversized: fichier seul > budget → parties logiques (fileParts renseigné)
 */
export function buildSemanticChunks(manifest: ProjectManifest): ChunkPlan {
  const cfg = getPhase36Config();
  const budgetTokens = cfg.chunkSizeTokens;

  const chunks: SemanticChunk[] = [];
  let globalIndex = 0;

  for (const module of manifest.modules) {
    // Trier les fichiers du module: d'abord ceux qui sont importés par d'autres
    // (degree entrant), ensuite par taille décroissante pour un packing efficace.
    const indegree = new Map<string, number>();
    for (const rel of manifest.relations) {
      indegree.set(rel.to, (indegree.get(rel.to) ?? 0) + 1);
    }
    const sorted = [...module.files].sort((a, b) => {
      const degA = indegree.get(a.path) ?? 0;
      const degB = indegree.get(b.path) ?? 0;
      if (degA !== degB) return degB - degA;
      return b.chars - a.chars;
    });

    let currentFiles: ManifestFile[] = [];
    let currentTokens = 0;
    let partCounter = 0;

    const flush = () => {
      if (currentFiles.length === 0) return;
      partCounter++;
      chunks.push({
        id: `chunk-${String(globalIndex).padStart(2, '0')}-${module.id}-${partCounter}`,
        index: globalIndex++,
        moduleId: module.id,
        role: module.role,
        files: currentFiles,
        filesContent: {},
        fileParts: {},
        estimatedTokens: currentTokens,
        externalDeps: [],
        reverseDeps: [],
      });
      currentFiles = [];
      currentTokens = 0;
    };

    for (const file of sorted) {
      const fileTokens = estimateTokens(file.chars.toString().padEnd(8, 'x')); // approximation basée sur chars
      const realTokens = Math.ceil((file.chars / 4) * 1.08);

      // ── Fichier surdimensionné : parts logiques, jamais de coupure arbitraire ──
      if (realTokens > budgetTokens) {
        flush();
        // sera traité par le caller (semantic-pipeline) qui a accès au contenu via sourceCode
        chunks.push({
          id: `chunk-${String(globalIndex).padStart(2, '0')}-${module.id}-OVERSIZE-${file.path}`,
          index: globalIndex++,
          moduleId: module.id,
          role: module.role,
          files: [file],
          filesContent: {},
          fileParts: { [file.path]: 'OVERSIZE' }, // marqué — traité au moment du rendu
          estimatedTokens: realTokens,
          externalDeps: [],
          reverseDeps: [],
        });
        continue;
      }

      // ── Packing : le fichier tient-il dans le chunk courant ? ──
      if (currentTokens + realTokens > budgetTokens && currentFiles.length > 0) {
        flush();
      }
      currentFiles.push(file);
      currentTokens += realTokens;
      void fileTokens;
    }
    flush();
  }

  // ── Dépendances inter-chunks (résolues via les relations du manifest) ─────
  const chunkOfPath = new Map<string, SemanticChunk>();
  for (const c of chunks) {
    for (const f of c.files) chunkOfPath.set(f.path, c);
  }
  for (const rel of manifest.relations) {
    const fromChunk = chunkOfPath.get(rel.from);
    const toChunk   = chunkOfPath.get(rel.to);
    if (fromChunk && toChunk && fromChunk.id !== toChunk.id) {
      if (!fromChunk.externalDeps.includes(rel.to)) fromChunk.externalDeps.push(rel.to);
      if (!toChunk.reverseDeps.includes(rel.from)) toChunk.reverseDeps.push(rel.from);
    }
  }

  const totalEstimatedTokens = chunks.reduce((a, c) => a + c.estimatedTokens, 0);
  return { chunks, totalEstimatedTokens };
}

/**
 * Remplit filesContent / découpe les fichiers surdimensionnés.
 * Séparé de buildSemanticChunks car il nécessite les contenus (extraits du sourceCode).
 */
export function hydrateChunks(
  chunks: SemanticChunk[],
  contentByPath: Map<string, string>,
): SemanticChunk[] {
  const cfg = getPhase36Config();
  const partTokenBudget = Math.max(500, Math.floor(cfg.chunkSizeTokens * 0.9));
  const hydrated: SemanticChunk[] = [];

  for (const chunk of chunks) {
    const oversized = chunk.files.filter((f) => chunk.fileParts[f.path] === 'OVERSIZE');
    const normal    = chunk.files.filter((f) => chunk.fileParts[f.path] !== 'OVERSIZE');

    // ── Chunk normal : contenu complet des fichiers ──
    if (normal.length > 0) {
      const filesContent: Record<string, string> = {};
      let tokens = 0;
      for (const f of normal) {
        const content = contentByPath.get(f.path) ?? '';
        filesContent[f.path] = content;
        tokens += Math.ceil((content.length / 4) * 1.08);
      }
      hydrated.push({
        ...chunk,
        files: normal,
        filesContent,
        fileParts: {},
        estimatedTokens: tokens,
      });
    }

    // ── Fichiers OVERSIZE : découpage logique SANS PERTE → 1 part = 1 chunk ──
    for (const f of oversized) {
      const content = contentByPath.get(f.path) ?? '';
      if (!content) continue;
      const parts = splitFileLogically(f.path, content, partTokenBudget);
      parts.forEach((partContent, idx) => {
        hydrated.push({
          ...chunk,
          id: `${chunk.id}-part${idx + 1}of${parts.length}`,
          files: [f],
          filesContent: { [f.path]: partContent },
          fileParts: { [f.path]: `${idx + 1}/${parts.length}` },
          estimatedTokens: Math.ceil((partContent.length / 4) * 1.08),
          externalDeps: chunk.externalDeps,
          reverseDeps: chunk.reverseDeps,
        });
      });
    }
  }

  // Réindexer séquentiellement
  return hydrated.map((c, i) => ({ ...c, index: i }));
}
