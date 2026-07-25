// ============================================================
// CodeMorph AI Engine — Pipeline Cache (Phase 25 Partie C)
// ============================================================
// Cache LRU en mémoire pour AST, IR, Architecture, Mapping, CodePlan
// Keyed par SHA-256 du sourceCode + params → pas de recalcul si rien n'a changé
//
// Objectif: éviter de refaire la même analyse AI si le sourceCode est identique
//           (ex : retry d'une conversion, conversions parallèles identiques)
//
// IMPORTANT: Ce cache est IN-PROCESS (mémoire du process AI Engine).
//   - Se réinitialise au redémarrage → comportement sûr (pas de stale cache)
//   - Pour un cache cross-process, utiliser Redis (non implémenté ici pour
//     éviter la dépendance Redis dans l'AI Engine)
//   - En scalabilité horizontale (Partie E), chaque instance a son propre cache
//     en mémoire — acceptable car les conversions sont stateless par jobId
//
// PHASE 24 COMPATIBILITY: 100% conservée — ce module n'altère aucun comportement.
// ============================================================

import { createHash } from 'crypto';

// ── LRU Cache générique ────────────────────────────────────────────────────────
interface CacheEntry<T> {
  value:     T;
  createdAt: number;
  hits:      number;
}

export class LRUCache<T> {
  private readonly cache: Map<string, CacheEntry<T>> = new Map();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize = 50, ttlMs = 10 * 60 * 1000 /* 10 minutes */) {
    this.maxSize = maxSize;
    this.ttlMs   = ttlMs;
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    // TTL check
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }
    // LRU : déplacer en tête (supprimer + réinsérer)
    this.cache.delete(key);
    entry.hits++;
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    // Éviction LRU si plein
    if (this.cache.size >= this.maxSize) {
      // Supprimer l'entrée la plus ancienne (premier élément de la Map)
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(key, { value, createdAt: Date.now(), hits: 0 });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number { return this.cache.size; }

  // Stats pour observabilité
  stats(): { size: number; maxSize: number; ttlMs: number } {
    return { size: this.cache.size, maxSize: this.maxSize, ttlMs: this.ttlMs };
  }
}

// ── Hash builder ───────────────────────────────────────────────────────────────
// Calcule un SHA-256 du sourceCode + paramètres → clé de cache stable
export function buildCacheKey(sourceCode: string, ...params: string[]): string {
  const input = [sourceCode, ...params].join('\x00');
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}

// ── PipelineCache singleton ────────────────────────────────────────────────────
// Stocke les résultats intermédiaires du pipeline pour éviter les recalculs
export class PipelineCache {
  private static instance: PipelineCache | null = null;

  // Caches par étape du pipeline
  // TTL courts pour les analyses qui peuvent changer (ex: AST d'un projet modifié)
  // TTL longs pour les analyses coûteuses (IR, Architecture)

  // AST : résultat de ASTAnalyzer.analyze() — TTL 5min (léger, basé sur fichiers)
  readonly astCache = new LRUCache<unknown>(100, 5 * 60 * 1000);

  // Architecture : résultat de ArchitectureDetector.detect() — TTL 10min
  readonly archCache = new LRUCache<unknown>(50, 10 * 60 * 1000);

  // IR : résultat de IRGenerator.generate() — TTL 15min (coûteux en tokens)
  readonly irCache = new LRUCache<unknown>(30, 15 * 60 * 1000);

  // Mapping : résultat de MappingEngine.map() — TTL 15min
  readonly mappingCache = new LRUCache<unknown>(30, 15 * 60 * 1000);

  // Code Plan : résultat de CodePlanner.plan() — TTL 10min
  // ATTENTION: ne pas mettre en cache les plans incomplets (score < 60%)
  readonly planCache = new LRUCache<unknown>(20, 10 * 60 * 1000);

  // PHASE 25 Partie D : Track des fichiers déjà générés correctement
  // Key: jobId → Set<filePath> (fichiers correctement générés)
  readonly generatedFiles = new LRUCache<Set<string>>(50, 30 * 60 * 1000);

  private constructor() {}

  static getInstance(): PipelineCache {
    if (!PipelineCache.instance) {
      PipelineCache.instance = new PipelineCache();
    }
    return PipelineCache.instance;
  }

  // ── Stats globales pour observabilité ────────────────────────────────────────
  getStats(): Record<string, { size: number; maxSize: number; ttlMs: number }> {
    return {
      ast:       this.astCache.stats(),
      arch:      this.archCache.stats(),
      ir:        this.irCache.stats(),
      mapping:   this.mappingCache.stats(),
      plan:      this.planCache.stats(),
      generated: this.generatedFiles.stats(),
    };
  }

  // ── Clear all caches ─────────────────────────────────────────────────────────
  clearAll(): void {
    this.astCache.clear();
    this.archCache.clear();
    this.irCache.clear();
    this.mappingCache.clear();
    this.planCache.clear();
    this.generatedFiles.clear();
  }
}

// Export singleton
export const pipelineCache = PipelineCache.getInstance();
