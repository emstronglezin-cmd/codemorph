// ============================================================
// CodeMorph AI Engine — PHASE 36: Chunk State (checkpoint / resume)
//
// IMPORTANT POUR LES PLANS GRATUITS :
//   Si une conversion contient 15 chunks et que le chunk 12 échoue,
//   les chunks 1 à 11 NE SONT PAS relancés.
//
//   chunk 1 ✅  chunk 2 ✅ … chunk 11 ✅  chunk 12 ❌  chunk 13 ⏳
//   → après récupération, on reprend au chunk 12.
//
// L'état est persisté sur disque (tmpdir), keyé par
//   sha256(projectId | targetFramework | sourceHash)
// → un retry du job (même projet, même contenu) reprend exactement
//   là où la conversion s'était arrêtée.
// ============================================================

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getPhase36Config } from './config';
import type { ChunkStateEntry, PipelineRunState, SemanticChunk } from './types';

export function buildRunStateKey(projectId: string, targetFramework: string, sourceHash: string): string {
  return createHash('sha256')
    .update(`${projectId}\x00${targetFramework}\x00${sourceHash}`)
    .digest('hex')
    .slice(0, 32);
}

export class ChunkStateManager {
  private readonly dir: string;
  private state: PipelineRunState | null = null;
  private stateKey = '';

  constructor() {
    const cfg = getPhase36Config();
    this.dir = cfg.stateDir;
    try { mkdirSync(this.dir, { recursive: true }); } catch { /* best-effort */ }
  }

  /** Charge l'état existant pour cette clé (resume) ou en crée un nouveau. */
  initialize(params: {
    projectId: string;
    targetFramework: string;
    sourceHash: string;
    chunks: SemanticChunk[];
  }): { resumed: number; total: number } {
    this.stateKey = buildRunStateKey(params.projectId, params.targetFramework, params.sourceHash);
    const file = join(this.dir, `${this.stateKey}.json`);

    const freshChunks: Record<string, ChunkStateEntry> = {};
    for (const c of params.chunks) {
      freshChunks[c.id] = { chunkId: c.id, status: 'pending', attempts: 0, updatedAt: new Date().toISOString() };
    }

    if (existsSync(file)) {
      try {
        const prev = JSON.parse(readFileSync(file, 'utf-8')) as PipelineRunState;
        if (prev.sourceHash === params.sourceHash) {
          // Resume : conserver les chunks 'done' (et leurs ModuleIR)
          let resumed = 0;
          for (const c of params.chunks) {
            const prevState = prev.chunks[c.id];
            if (prevState?.status === 'done' && prevState.moduleIR) {
              freshChunks[c.id] = { ...prevState, updatedAt: new Date().toISOString() };
              resumed++;
            }
          }
          this.state = {
            projectId: params.projectId,
            sourceHash: params.sourceHash,
            totalChunks: params.chunks.length,
            chunks: freshChunks,
            startedAt: prev.startedAt,
            updatedAt: new Date().toISOString(),
          };
          this.persist();
          return { resumed, total: params.chunks.length };
        }
        // Contenu différent → l'ancien état est obsolète
        rmSync(file, { force: true });
      } catch { /* état corrompu → repartir de zéro */ }
    }

    this.state = {
      projectId: params.projectId,
      sourceHash: params.sourceHash,
      totalChunks: params.chunks.length,
      chunks: freshChunks,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.persist();
    return { resumed: 0, total: params.chunks.length };
  }

  /** Chunks encore à traiter (pending ou failed) — dans l'ordre. */
  pendingChunks(ordered: SemanticChunk[]): SemanticChunk[] {
    if (!this.state) return ordered;
    return ordered.filter((c) => {
      const s = this.state!.chunks[c.id];
      return !s || s.status === 'pending' || s.status === 'failed';
    });
  }

  isDone(chunkId: string): boolean {
    return this.state?.chunks[chunkId]?.status === 'done';
  }

  getDoneModuleIR(chunkId: string): import('./types').ModuleIR | undefined {
    return this.state?.chunks[chunkId]?.moduleIR;
  }

  markRunning(chunkId: string): void {
    this.update(chunkId, { status: 'running' });
  }

  markDone(chunkId: string, moduleIR: import('./types').ModuleIR): void {
    this.update(chunkId, { status: 'done', moduleIR, error: undefined });
  }

  markFailed(chunkId: string, error: string): void {
    const current = this.state?.chunks[chunkId];
    this.update(chunkId, { status: 'failed', error, attempts: (current?.attempts ?? 0) + 1 });
  }

  progress(): { done: number; failed: number; pending: number; total: number } {
    if (!this.state) return { done: 0, failed: 0, pending: 0, total: 0 };
    let done = 0, failed = 0, pending = 0;
    for (const entry of Object.values(this.state.chunks)) {
      if (entry.status === 'done') done++;
      else if (entry.status === 'failed') failed++;
      else pending++;
    }
    return { done, failed, pending, total: this.state.totalChunks };
  }

  /** Purge l'état quand TOUT est terminé (conversion complète réussie). */
  finalizeIfComplete(): boolean {
    if (!this.state) return false;
    const all = Object.values(this.state.chunks);
    if (all.length > 0 && all.every((c) => c.status === 'done')) {
      const file = join(this.dir, `${this.stateKey}.json`);
      try { rmSync(file, { force: true }); } catch { /* best-effort */ }
      return true;
    }
    return false;
  }

  private update(chunkId: string, patch: Partial<ChunkStateEntry>): void {
    if (!this.state) return;
    const current = this.state.chunks[chunkId] ?? { chunkId, status: 'pending' as const, attempts: 0, updatedAt: '' };
    this.state.chunks[chunkId] = {
      ...current,
      ...patch,
      moduleIR: patch.moduleIR !== undefined ? patch.moduleIR : current.moduleIR,
      updatedAt: new Date().toISOString(),
    };
    this.state.updatedAt = new Date().toISOString();
    this.persist();
  }

  private persist(): void {
    if (!this.state) return;
    try {
      const file = join(this.dir, `${this.stateKey}.json`);
      writeFileSync(file, JSON.stringify(this.state), 'utf-8');
    } catch { /* best-effort — la reprise est un optimisme, pas une obligation */ }
  }
}
