// ============================================================
// CodeMorph AI Engine — PHASE 36: Module Cache (empreinte de contenu)
//
// Si un module a déjà été analysé avec EXACTEMENT le même contenu →
// PAS de nouvel appel au modèle. Le résultat est réutilisé depuis le disque.
//
// CLÉ DE CACHE = SHA-256 de :
//   hash(contenu des fichiers du chunk)
// + version des prompts (AI_PROMPT_VERSION)
// + modèle provider (ex: openai/gpt-oss-120b)
// + version du pipeline (phase36)
// + frameworks (source → target)
//
// SÉCURITÉ : la clé est purement CONTENT-ADDRESSED. Deux projets différents
// n'ont jamais la même clé (leur contenu diffère) → impossible de mélanger
// deux projets. Un même contenu → même analyse → réutilisation valide.
// ============================================================

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getPhase36Config } from './config';
import type { ModuleIR } from './types';

const PIPELINE_VERSION = 'phase36';

export function buildModuleCacheKey(params: {
  chunkContent: string;      // concaténation déterministe du contenu du chunk
  files: string[];           // chemins (ordre inclus dans le hash)
  promptVersion: string;
  model: string;
  sourceFramework: string;
  targetFramework: string;
}): string {
  const h = createHash('sha256');
  h.update(PIPELINE_VERSION);
  h.update('\x00');
  h.update(params.promptVersion);
  h.update('\x00');
  h.update(params.model);
  h.update('\x00');
  h.update(params.sourceFramework);
  h.update('->');
  h.update(params.targetFramework);
  h.update('\x00');
  h.update(params.files.join('|'));
  h.update('\x00');
  h.update(params.chunkContent);
  return h.digest('hex').slice(0, 40);
}

interface CacheEnvelope {
  version: string;
  promptVersion: string;
  model: string;
  createdAt: number;
  moduleIR: ModuleIR;
}

export class ModuleCache {
  private readonly dir: string;
  private readonly ttlMs: number;
  private readonly enabled: boolean;
  private readonly maxEntries = 500;
  // Statistiques d'observabilité
  hits = 0;
  misses = 0;

  constructor() {
    const cfg = getPhase36Config();
    this.enabled = cfg.cacheEnabled;
    this.dir     = cfg.cacheDir;
    this.ttlMs   = cfg.cacheTtlHours * 3_600_000;
    if (this.enabled) {
      try { mkdirSync(this.dir, { recursive: true }); } catch { /* tmp non accessible → cache off */ }
    }
  }

  get(key: string): ModuleIR | undefined {
    if (!this.enabled) return undefined;
    const file = join(this.dir, `${key}.json`);
    if (!existsSync(file)) {
      this.misses++;
      return undefined;
    }
    try {
      const env = JSON.parse(readFileSync(file, 'utf-8')) as CacheEnvelope;
      if (Date.now() - env.createdAt > this.ttlMs) {
        rmSync(file, { force: true });
        this.misses++;
        return undefined;
      }
      this.hits++;
      return { ...env.moduleIR, cacheHit: true };
    } catch {
      this.misses++;
      return undefined;
    }
  }

  set(key: string, moduleIR: ModuleIR, meta: { promptVersion: string; model: string }): void {
    if (!this.enabled) return;
    try {
      this.evictIfNeeded();
      const envelope: CacheEnvelope = {
        version: PIPELINE_VERSION,
        promptVersion: meta.promptVersion,
        model: meta.model,
        createdAt: Date.now(),
        moduleIR: { ...moduleIR, cacheHit: false },
      };
      // Écriture atomique (tmp + rename) pour éviter un fichier corrompu en cas de crash
      const tmpFile = join(this.dir, `${key}.tmp-${process.pid}`);
      writeFileSync(tmpFile, JSON.stringify(envelope), 'utf-8');
      const finalFile = join(this.dir, `${key}.json`);
      rmSync(finalFile, { force: true });
      writeFileSync(finalFile, JSON.stringify(envelope), 'utf-8');
      rmSync(tmpFile, { force: true });
    } catch { /* cache en écriture best-effort — jamais bloquant */ }
  }

  /** Éviction LRU simple par date de modification quand le cache dépasse maxEntries. */
  private evictIfNeeded(): void {
    try {
      const files = readdirSync(this.dir).filter((f) => f.endsWith('.json'));
      if (files.length < this.maxEntries) return;
      const withTime = files
        .map((f) => ({ f, t: statSync(join(this.dir, f)).mtimeMs }))
        .sort((a, b) => a.t - b.t);
      const toRemove = withTime.slice(0, Math.floor(this.maxEntries * 0.2));
      for (const entry of toRemove) rmSync(join(this.dir, entry.f), { force: true });
    } catch { /* best-effort */ }
  }

  stats(): { hits: number; misses: number; enabled: boolean; dir: string } {
    return { hits: this.hits, misses: this.misses, enabled: this.enabled, dir: this.dir };
  }
}
