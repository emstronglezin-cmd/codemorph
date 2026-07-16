// ============================================================
// CodeMorph — Metrics Service
// FIX PHASE 4 — ARCH-08 : tous les appels Redis entourés de try/catch
// Avant : @InjectRedis() sans try/catch → crash si Redis down
// Fix   : chaque opération Redis est dans un try/catch avec fallback
// ============================================================
import { Injectable, Logger } from '@nestjs/common';
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

const METRICS_TTL   = 300;
const AI_COST_PER_1K_TOKENS = 0.01;

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);

  constructor(
    @InjectRepository(JobEntity)
    private readonly jobRepo: Repository<JobEntity>,

    @InjectRepository(UsageQuotaEntity)
    private readonly quotaRepo: Repository<UsageQuotaEntity>,

    @InjectRedis()
    private readonly redis: Redis,
  ) {}

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

  // ── Record request duration ───────────────────────────
  async recordRequest(method: string, path: string, statusCode: number, durationMs: number): Promise<void> {
    const key = `cm:metrics:req:${new Date().toISOString().slice(0, 13)}`;
    await this.safeRedis(async () => {
      await this.redis.hincrby(key, `${method}:${path}:${statusCode}`, 1);
      await this.redis.expire(key, 86_400 * 2);
      const bucket = this.latencyBucket(durationMs);
      await this.redis.hincrby(`cm:metrics:latency:${new Date().toISOString().slice(0, 13)}`, bucket, 1);
    }, undefined, 'recordRequest');
  }

  // ── Track AI call ─────────────────────────────────────
  async trackAiCall(userId: string, plan: string, tokens: number, durationMs: number): Promise<void> {
    void durationMs;
    const hourKey = `cm:metrics:ai:${new Date().toISOString().slice(0, 13)}`;
    await this.safeRedis(async () => {
      await this.redis.hincrby(hourKey, 'requests', 1);
      await this.redis.hincrby(hourKey, 'tokens',   tokens);
      await this.redis.hincrby(hourKey, `plan:${plan}:requests`, 1);
      await this.redis.hincrby(hourKey, `plan:${plan}:tokens`,   tokens);
      await this.redis.expire(hourKey, 86_400 * 7);

      const dayKey = `cm:metrics:ai:user:${userId}:${new Date().toISOString().slice(0, 10)}`;
      await this.redis.hincrby(dayKey, 'requests', 1);
      await this.redis.hincrby(dayKey, 'tokens',   tokens);
      await this.redis.expire(dayKey, 86_400 * 32);
    }, undefined, 'trackAiCall');
  }

  // ── Track job event ───────────────────────────────────
  async trackJobEvent(
    event:       'created' | 'completed' | 'failed',
    jobId:       string,
    framework?:  string,
    durationMs?: number,
  ): Promise<void> {
    void jobId;
    const key = `cm:metrics:jobs:${new Date().toISOString().slice(0, 10)}`;
    await this.safeRedis(async () => {
      await this.redis.hincrby(key, event, 1);
      if (framework) await this.redis.hincrby(key, `fw:${framework}`, 1);
      if (durationMs && event === 'completed') {
        await this.redis.lpush('cm:metrics:job:durations', durationMs);
        await this.redis.ltrim('cm:metrics:job:durations', 0, 999);
      }
      await this.redis.expire(key, 86_400 * 30);
    }, undefined, 'trackJobEvent');
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
