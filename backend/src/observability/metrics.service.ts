// ============================================================
// CodeMorph — Metrics Service
// FIX PHASE 4 — ARCH-08 : tous les appels Redis entourés de try/catch
// PHASE 25 — Partie A : OPTIMISATION REDIS
//   - recordRequest() : pipeline Redis (5 appels → 1 pipeline)
//   - trackAiCall()   : pipeline Redis (8 appels → 1 pipeline)
//   - trackJobEvent() : pipeline Redis (4 appels → 1 pipeline)
//   - Debounce mémoire : accumulate metrics en RAM, flush toutes les 5 secondes
//     → réduit les requêtes Redis de ~95% sur les endpoints fréquents
// ============================================================
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { InjectRedis } from '@liaoliaots/nestjs-redis';
import Redis from 'ioredis';

import { JobEntity, JobStatus } from '../modules/jobs/jobs.entity';
import { UsageQuotaEntity }     from '../modules/quota/quota.entity';

export interface JobMetrics {
  totalJobs:       number;
  successRate:     number;
  avgDurationMs:   number;
  byStatus:        Record<string, number>;
  byFramework:     Record<string, number>;
  last24h:         number;
}

export interface AiUsageMetrics {
  totalRequests:  number;
  totalTokens:    number;
  avgTokens:      number;
  byPlan:         Record<string, { requests: number; tokens: number }>;
  costEstimate:   number;
}

export interface PlatformMetrics {
  jobs:         JobMetrics;
  aiUsage:      AiUsageMetrics;
  activeUsers:  number;
  errorRate:    number;
}

const METRICS_TTL        = 300;
const AI_COST_PER_1K_TOKENS = 0.01;
// ── PHASE 25 Partie A : Debounce buffer constants ────────
const FLUSH_INTERVAL_MS  = 5_000;   // flush toutes les 5 secondes
const MAX_BUFFER_SIZE    = 500;     // flush forcé si buffer > 500 entrées

// Types pour le buffer mémoire
interface ReqEntry   { key: string; field: string; latencyKey: string; latencyBucket: string }
interface AiEntry    { hourKey: string; plan: string; tokens: number; userId: string; dayKey: string }
interface JobEntry   { key: string; event: string; framework?: string; durationMs?: number }

@Injectable()
export class MetricsService implements OnModuleDestroy {
  private readonly logger = new Logger(MetricsService.name);

  // ── PHASE 25 Partie A : Buffers mémoire (debounce) ───────
  private reqBuffer:  ReqEntry[] = [];
  private aiBuffer:   AiEntry[]  = [];
  private jobBuffer:  JobEntry[]  = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(JobEntity)
    private readonly jobRepo: Repository<JobEntity>,

    @InjectRepository(UsageQuotaEntity)
    private readonly quotaRepo: Repository<UsageQuotaEntity>,

    @InjectRedis()
    private readonly redis: Redis,
  ) {
    // Démarrer le timer de flush périodique
    this.startFlushTimer();
  }

  // ── Cleanup au shutdown du module ────────────────────────
  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Flush final pour ne rien perdre
    await this.flushAllBuffers();
  }

  // ── Timer de flush périodique ─────────────────────────────
  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      void this.flushAllBuffers();
    }, FLUSH_INTERVAL_MS);
    // Éviter que le timer bloque le process Node.js
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  // ── Flush global ─────────────────────────────────────────
  private async flushAllBuffers(): Promise<void> {
    await Promise.all([
      this.flushReqBuffer(),
      this.flushAiBuffer(),
      this.flushJobBuffer(),
    ]);
  }

  // ── Safe Redis helper — ne jamais crasher si Redis down ──
  // FIX PHASE 4 — ARCH-08 : toute opération Redis passe par cette méthode
  private async safeRedis<T>(
    operation: () => Promise<T>,
    fallback: T,
    context = 'redis',
  ): Promise<T> {
    try {
      return await operation();
    } catch (err) {
      this.logger.warn(`[MetricsService] ${context} error (Redis down?): ${(err as Error).message}`);
      return fallback;
    }
  }

  // ── PHASE 25 Partie A : recordRequest — BUFFERED (debounce) ──
  // AVANT: 4 appels Redis séparés par requête HTTP (hincrby×2 + expire×2)
  // APRÈS: accumulation en mémoire → 1 pipeline Redis toutes les 5s
  // Réduction: ~95% des requêtes Redis pour les endpoints fréquents
  async recordRequest(method: string, path: string, statusCode: number, durationMs: number): Promise<void> {
    const key        = `cm:metrics:req:${new Date().toISOString().slice(0, 13)}`;
    const latencyKey = `cm:metrics:latency:${new Date().toISOString().slice(0, 13)}`;
    const bucket     = this.latencyBucket(durationMs);
    this.reqBuffer.push({ key, field: `${method}:${path}:${statusCode}`, latencyKey, latencyBucket: bucket });
    // Flush forcé si buffer trop grand
    if (this.reqBuffer.length >= MAX_BUFFER_SIZE) await this.flushReqBuffer();
  }

  // ── PHASE 25 Partie A : trackAiCall — BUFFERED (debounce) ──
  // AVANT: 8 appels Redis séparés par appel IA (hincrby×6 + expire×2)
  // APRÈS: accumulation en mémoire → 1 pipeline Redis toutes les 5s
  async trackAiCall(userId: string, plan: string, tokens: number, durationMs: number): Promise<void> {
    void durationMs;
    const hourKey = `cm:metrics:ai:${new Date().toISOString().slice(0, 13)}`;
    const dayKey  = `cm:metrics:ai:user:${userId}:${new Date().toISOString().slice(0, 10)}`;
    this.aiBuffer.push({ hourKey, plan, tokens, userId, dayKey });
    if (this.aiBuffer.length >= MAX_BUFFER_SIZE) await this.flushAiBuffer();
  }

  // ── PHASE 25 Partie A : trackJobEvent — BUFFERED (debounce) ──
  // AVANT: 3-4 appels Redis séparés par événement job
  // APRÈS: accumulation en mémoire → 1 pipeline Redis toutes les 5s
  async trackJobEvent(
    event:       'created' | 'completed' | 'failed',
    jobId:       string,
    framework?:  string,
    durationMs?: number,
  ): Promise<void> {
    void jobId;
    const key = `cm:metrics:jobs:${new Date().toISOString().slice(0, 10)}`;
    this.jobBuffer.push({ key, event, framework, durationMs });
    if (this.jobBuffer.length >= MAX_BUFFER_SIZE) await this.flushJobBuffer();
  }

  // ── PHASE 25 Partie A : Flush Redis en pipeline (batch) ──
  // Toutes les écritures en attente sont envoyées en 1 seul round-trip Redis

  private async flushReqBuffer(): Promise<void> {
    if (this.reqBuffer.length === 0) return;
    const batch = this.reqBuffer.splice(0);
    await this.safeRedis(async () => {
      const pipeline = this.redis.pipeline();
      // Agréger par clé pour minimiser les commandes
      const aggReq:     Map<string, Map<string, number>> = new Map();
      const aggLatency: Map<string, Map<string, number>> = new Map();
      const expireKeys: Set<string> = new Set();
      for (const e of batch) {
        if (!aggReq.has(e.key))     aggReq.set(e.key, new Map());
        if (!aggLatency.has(e.latencyKey)) aggLatency.set(e.latencyKey, new Map());
        aggReq.get(e.key)!.set(e.field, (aggReq.get(e.key)!.get(e.field) ?? 0) + 1);
        aggLatency.get(e.latencyKey)!.set(e.latencyBucket, (aggLatency.get(e.latencyKey)!.get(e.latencyBucket) ?? 0) + 1);
        expireKeys.add(e.key);
        expireKeys.add(e.latencyKey);
      }
      for (const [key, fields] of aggReq)     { for (const [f, v] of fields) pipeline.hincrby(key, f, v); pipeline.expire(key, 86_400 * 2); }
      for (const [key, fields] of aggLatency) { for (const [f, v] of fields) pipeline.hincrby(key, f, v); pipeline.expire(key, 86_400 * 2); }
      await pipeline.exec();
    }, undefined, 'flushReqBuffer');
  }

  private async flushAiBuffer(): Promise<void> {
    if (this.aiBuffer.length === 0) return;
    const batch = this.aiBuffer.splice(0);
    await this.safeRedis(async () => {
      const pipeline = this.redis.pipeline();
      // Agréger par hourKey
      const aggHour: Map<string, { requests: number; tokens: number; plans: Map<string, { requests: number; tokens: number }> }> = new Map();
      const aggDay:  Map<string, { requests: number; tokens: number }> = new Map();
      for (const e of batch) {
        if (!aggHour.has(e.hourKey)) aggHour.set(e.hourKey, { requests: 0, tokens: 0, plans: new Map() });
        const h = aggHour.get(e.hourKey)!;
        h.requests++;
        h.tokens += e.tokens;
        if (!h.plans.has(e.plan)) h.plans.set(e.plan, { requests: 0, tokens: 0 });
        h.plans.get(e.plan)!.requests++;
        h.plans.get(e.plan)!.tokens += e.tokens;

        if (!aggDay.has(e.dayKey)) aggDay.set(e.dayKey, { requests: 0, tokens: 0 });
        aggDay.get(e.dayKey)!.requests++;
        aggDay.get(e.dayKey)!.tokens += e.tokens;
      }
      for (const [key, d] of aggHour) {
        pipeline.hincrby(key, 'requests', d.requests);
        pipeline.hincrby(key, 'tokens',   d.tokens);
        for (const [plan, p] of d.plans) {
          pipeline.hincrby(key, `plan:${plan}:requests`, p.requests);
          pipeline.hincrby(key, `plan:${plan}:tokens`,   p.tokens);
        }
        pipeline.expire(key, 86_400 * 7);
      }
      for (const [key, d] of aggDay) {
        pipeline.hincrby(key, 'requests', d.requests);
        pipeline.hincrby(key, 'tokens',   d.tokens);
        pipeline.expire(key, 86_400 * 32);
      }
      await pipeline.exec();
    }, undefined, 'flushAiBuffer');
  }

  private async flushJobBuffer(): Promise<void> {
    if (this.jobBuffer.length === 0) return;
    const batch = this.jobBuffer.splice(0);
    await this.safeRedis(async () => {
      const pipeline = this.redis.pipeline();
      const aggJob: Map<string, { events: Map<string, number>; frameworks: Map<string, number> }> = new Map();
      const durations: number[] = [];
      for (const e of batch) {
        if (!aggJob.has(e.key)) aggJob.set(e.key, { events: new Map(), frameworks: new Map() });
        const j = aggJob.get(e.key)!;
        j.events.set(e.event, (j.events.get(e.event) ?? 0) + 1);
        if (e.framework) j.frameworks.set(e.framework, (j.frameworks.get(e.framework) ?? 0) + 1);
        if (e.durationMs && e.event === 'completed') durations.push(e.durationMs);
      }
      for (const [key, d] of aggJob) {
        for (const [ev, count] of d.events)  pipeline.hincrby(key, ev, count);
        for (const [fw, count] of d.frameworks) pipeline.hincrby(key, `fw:${fw}`, count);
        pipeline.expire(key, 86_400 * 30);
      }
      if (durations.length > 0) {
        pipeline.lpush('cm:metrics:job:durations', ...durations.map(String));
        pipeline.ltrim('cm:metrics:job:durations', 0, 999);
      }
      await pipeline.exec();
    }, undefined, 'flushJobBuffer');
  }

  // ── Get job metrics ───────────────────────────────────
  async getJobMetrics(): Promise<JobMetrics> {
    // Check cache
    const cached = await this.safeRedis(
      () => this.redis.get('cm:metrics:cache:jobs'),
      null, 'getJobMetrics-cache',
    );
    if (cached) {
      try { return JSON.parse(cached) as JobMetrics; } catch { /* ignore */ }
    }

    const now      = new Date();
    const since24h = new Date(now.getTime() - 86_400_000);

    const [total, byStatusRaw, last24h] = await Promise.all([
      this.jobRepo.count(),
      this.jobRepo
        .createQueryBuilder('j')
        .select('j.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .groupBy('j.status')
        .getRawMany<{ status: string; count: string }>(),
      this.jobRepo.count({ where: { createdAt: Between(since24h, now) } }),
    ]);

    const durations = await this.safeRedis(
      () => this.redis.lrange('cm:metrics:job:durations', 0, -1),
      [] as string[], 'getJobMetrics-durations',
    );

    const byStatus: Record<string, number> = {};
    for (const row of byStatusRaw) {
      byStatus[row.status] = parseInt(row.count, 10);
    }

    const done     = byStatus[JobStatus.DONE]   ?? 0;
    const failed   = byStatus[JobStatus.FAILED] ?? 0;
    const finished = done + failed;

    const avgDurationMs = durations.length
      ? durations.reduce((a, b) => a + parseInt(b, 10), 0) / durations.length
      : 0;

    const frameworks = await this.jobRepo
      .createQueryBuilder('j')
      .select('j.targetLanguage', 'fw')
      .addSelect('COUNT(*)', 'count')
      .groupBy('j.targetLanguage')
      .getRawMany<{ fw: string; count: string }>();

    const byFramework: Record<string, number> = {};
    for (const row of frameworks) byFramework[row.fw] = parseInt(row.count, 10);

    const metrics: JobMetrics = {
      totalJobs:     total,
      successRate:   finished > 0 ? Math.round((done / finished) * 100) : 0,
      avgDurationMs: Math.round(avgDurationMs),
      byStatus,
      byFramework,
      last24h,
    };

    await this.safeRedis(
      () => this.redis.set('cm:metrics:cache:jobs', JSON.stringify(metrics), 'EX', METRICS_TTL),
      null, 'getJobMetrics-setCache',
    );

    return metrics;
  }

  // ── Get AI usage metrics ──────────────────────────────
  async getAiUsageMetrics(): Promise<AiUsageMetrics> {
    const cached = await this.safeRedis(
      () => this.redis.get('cm:metrics:cache:ai'),
      null, 'getAiUsageMetrics-cache',
    );
    if (cached) {
      try { return JSON.parse(cached) as AiUsageMetrics; } catch { /* ignore */ }
    }

    const keys: string[] = [];
    for (let i = 0; i < 7 * 24; i++) {
      const d = new Date(Date.now() - i * 3_600_000);
      keys.push(`cm:metrics:ai:${d.toISOString().slice(0, 13)}`);
    }

    let totalRequests = 0;
    let totalTokens   = 0;
    const byPlan: Record<string, { requests: number; tokens: number }> = {};

    const results = await this.safeRedis(async () => {
      const pipeline = this.redis.pipeline();
      for (const k of keys) pipeline.hgetall(k);
      return pipeline.exec();
    }, null, 'getAiUsageMetrics-pipeline');

    if (results) {
      for (const [, data] of results) {
        if (!data || typeof data !== 'object') continue;
        const d = data as Record<string, string>;
        totalRequests += parseInt(d['requests'] ?? '0', 10);
        totalTokens   += parseInt(d['tokens']   ?? '0', 10);
        for (const plan of ['free', 'pro', 'pro_max']) {
          if (!byPlan[plan]) byPlan[plan] = { requests: 0, tokens: 0 };
          byPlan[plan].requests += parseInt(d[`plan:${plan}:requests`] ?? '0', 10);
          byPlan[plan].tokens   += parseInt(d[`plan:${plan}:tokens`]   ?? '0', 10);
        }
      }
    }

    const metrics: AiUsageMetrics = {
      totalRequests,
      totalTokens,
      avgTokens:    totalRequests > 0 ? Math.round(totalTokens / totalRequests) : 0,
      byPlan,
      costEstimate: Math.round((totalTokens / 1_000) * AI_COST_PER_1K_TOKENS * 100) / 100,
    };

    await this.safeRedis(
      () => this.redis.set('cm:metrics:cache:ai', JSON.stringify(metrics), 'EX', METRICS_TTL),
      null, 'getAiUsageMetrics-setCache',
    );

    return metrics;
  }

  // ── Get platform overview ─────────────────────────────
  async getPlatformMetrics(): Promise<PlatformMetrics> {
    const [jobs, aiUsage] = await Promise.all([
      this.getJobMetrics(),
      this.getAiUsageMetrics(),
    ]);

    const activeUsers = await this.quotaRepo
      .createQueryBuilder('q')
      .select('COUNT(DISTINCT q.userId)', 'count')
      .where('q.periodStart > :since', { since: new Date(Date.now() - 30 * 86_400_000) })
      .getRawOne<{ count: string }>()
      .then((r) => parseInt(r?.count ?? '0', 10));

    const finished = (jobs.byStatus[JobStatus.DONE] ?? 0) + (jobs.byStatus[JobStatus.FAILED] ?? 0);
    const failed   = jobs.byStatus[JobStatus.FAILED] ?? 0;

    return {
      jobs,
      aiUsage,
      activeUsers,
      errorRate: finished > 0 ? Math.round((failed / finished) * 100) : 0,
    };
  }

  // ── Helpers ───────────────────────────────────────────
  private latencyBucket(ms: number): string {
    if (ms < 100)    return '<100ms';
    if (ms < 500)    return '<500ms';
    if (ms < 1_000)  return '<1s';
    if (ms < 5_000)  return '<5s';
    if (ms < 30_000) return '<30s';
    return '>30s';
  }
}
