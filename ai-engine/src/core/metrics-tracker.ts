// ============================================================
// CodeMorph AI Engine — Metrics Tracker (Phase 25 Partie F)
// ============================================================
// Collecte et expose les métriques du moteur IA :
//   - Temps par phase (AST, IR, Mapping, Planning, Validation)
//   - Tokens consommés par appel + total
//   - Coût estimé par conversion (en USD)
//   - Requêtes Redis (via proxy — non applicable dans AI Engine sans Redis)
//   - Mémoire process
//   - Compteurs de cache hits/misses
//
// Toutes les métriques sont loguées dans les logs structurés (pino)
// ET exposées via une Map en mémoire pour l'endpoint /api/metrics
//
// PHASE 24 COMPATIBILITY: 100% conservée — module additionnel pur
// ============================================================

export interface ConversionMetrics {
  jobId:          string;
  tier:           string;
  model:          string;

  // Timings par phase (ms)
  timings: {
    ast?:       number;
    arch?:      number;
    ir?:        number;
    mapping?:   number;
    planning?:  number;
    validation?:number;
    total?:     number;
  };

  // Tokens IA
  tokens: {
    uiGraph?:      number;
    backendGraph?: number;
    dataLayer?:    number;
    codePlan?:     number;
    total?:        number;
  };

  // Coût estimé
  costUSD?: number;

  // Résultats
  filesGenerated?:  number;
  fidelityScore?:   number;
  cacheHits?:       number;

  // Mémoire process au moment de la conversion (MB)
  memoryMB?: number;

  // Timestamp
  startedAt:    string;
  completedAt?: string;
}

// ── Registre global des métriques ────────────────────────────
// Garde les N dernières conversions en mémoire pour l'endpoint /api/metrics
const MAX_HISTORY = 100;

class MetricsRegistry {
  private history: ConversionMetrics[] = [];
  private totals = {
    conversions:    0,
    totalTokens:    0,
    totalCostUSD:   0,
    totalDurationMs: 0,
    cacheHits:      0,
  };

  record(metrics: ConversionMetrics): void {
    // Ajouter à l'historique
    this.history.push(metrics);
    if (this.history.length > MAX_HISTORY) {
      this.history.shift();
    }

    // Mettre à jour les totaux
    this.totals.conversions++;
    this.totals.totalTokens    += metrics.tokens.total ?? 0;
    this.totals.totalCostUSD   += metrics.costUSD ?? 0;
    this.totals.totalDurationMs += metrics.timings.total ?? 0;
    this.totals.cacheHits       += metrics.cacheHits ?? 0;
  }

  getHistory(limit = 10): ConversionMetrics[] {
    return this.history.slice(-limit);
  }

  getSummary() {
    const n = this.totals.conversions;
    return {
      totalConversions:  n,
      totalTokens:       this.totals.totalTokens,
      totalCostUSD:      Math.round(this.totals.totalCostUSD * 10000) / 10000,
      avgDurationMs:     n > 0 ? Math.round(this.totals.totalDurationMs / n) : 0,
      avgTokens:         n > 0 ? Math.round(this.totals.totalTokens / n)    : 0,
      avgCostUSD:        n > 0 ? Math.round(this.totals.totalCostUSD / n * 10000) / 10000 : 0,
      cacheHitRate:      n > 0 ? Math.round(this.totals.cacheHits / n * 100) : 0,
      memoryCurrentMB:   Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    };
  }

  reset(): void {
    this.history = [];
    this.totals = { conversions: 0, totalTokens: 0, totalCostUSD: 0, totalDurationMs: 0, cacheHits: 0 };
  }
}

export const metricsRegistry = new MetricsRegistry();

// ── Helper: coût estimé par tier ─────────────────────────────
export function estimateCostUSD(tokens: number, tier: string): number {
  switch (tier) {
    case 'free-groq':     return 0; // Groq free tier
    case 'platform':      return (tokens / 1_000) * 0.005; // gpt-4o-mini ~$0.005/1k tokens
    case 'pro-openai':    return (tokens / 1_000) * 0.015; // gpt-4o ~$0.015/1k tokens
    case 'pro-anthropic': return (tokens / 1_000) * 0.018; // claude-3.5-sonnet
    default:              return 0;
  }
}

// ── Log métriques finales en format structuré ─────────────────
export function logFinalMetrics(metrics: ConversionMetrics): void {
  console.log(`\n================ METRICS FINALES (Phase 25) ================`);
  console.log(`Job ID         : ${metrics.jobId}`);
  console.log(`AI Tier        : ${metrics.tier} (${metrics.model})`);
  console.log(`─── Timings ──────────────────────────────`);
  console.log(`  AST          : ${metrics.timings.ast ?? '-'}ms`);
  console.log(`  Architecture : ${metrics.timings.arch ?? '-'}ms`);
  console.log(`  IR           : ${metrics.timings.ir ?? '-'}ms`);
  console.log(`  Mapping      : ${metrics.timings.mapping ?? '-'}ms`);
  console.log(`  Planning     : ${metrics.timings.planning ?? '-'}ms`);
  console.log(`  Validation   : ${metrics.timings.validation ?? '-'}ms`);
  console.log(`  TOTAL        : ${metrics.timings.total ?? '-'}ms`);
  console.log(`─── Tokens ───────────────────────────────`);
  console.log(`  UIGraph      : ${metrics.tokens.uiGraph ?? '-'}`);
  console.log(`  BackendGraph : ${metrics.tokens.backendGraph ?? '-'}`);
  console.log(`  DataLayer    : ${metrics.tokens.dataLayer ?? '-'}`);
  console.log(`  CodePlan     : ${metrics.tokens.codePlan ?? '-'}`);
  console.log(`  TOTAL        : ${metrics.tokens.total ?? '-'}`);
  console.log(`─── Résultats ────────────────────────────`);
  console.log(`  Files        : ${metrics.filesGenerated ?? '-'}`);
  console.log(`  Score        : ${metrics.fidelityScore ?? '-'}%`);
  console.log(`  Cache hits   : ${metrics.cacheHits ?? 0}`);
  console.log(`  Est. cost    : $${(metrics.costUSD ?? 0).toFixed(4)} USD`);
  console.log(`  Memory       : ${metrics.memoryMB ?? '-'} MB`);
  console.log(`==============================\n`);
}
