// ============================================================
// CodeMorph — Quota Service
// Tracks & enforces per-user monthly usage limits
// Redis is OPTIONAL — falls back to in-memory if unavailable
// ============================================================
import {
  Injectable, ForbiddenException, Logger, Inject, Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UsageQuotaEntity } from './quota.entity';
import { getPlanLimits, isUnlimited, Plan } from '../subscription/plan-limits.config';

export const REDIS_CLIENT_TOKEN = 'QUOTA_REDIS_CLIENT';

interface QuotaCheckResult {
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
  resetAt: Date;
}

// ── In-memory fallback store ──────────────────────────────
const memStore = new Map<string, { value: string; expiresAt: number }>();

function memGet(key: string): string | null {
  const entry = memStore.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { memStore.delete(key); return null; }
  return entry.value;
}
function memSet(key: string, value: string, ttlSeconds = 3600): void {
  memStore.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}
function memDel(key: string): void { memStore.delete(key); }
function memIncr(key: string): number {
  const cur = parseInt(memGet(key) ?? '0', 10);
  const next = cur + 1;
  memSet(key, String(next), 3600);
  return next;
}
function memDecr(key: string): number {
  const cur = parseInt(memGet(key) ?? '0', 10);
  const next = Math.max(0, cur - 1);
  memSet(key, String(next), 3600);
  return next;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RedisLike = { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<unknown>; setex(k: string, t: number, v: string): Promise<unknown>; del(k: string): Promise<unknown>; incr(k: string): Promise<number>; decr(k: string): Promise<number>; expire(k: string, t: number): Promise<unknown> };

@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name);
  private readonly redis: RedisLike | null;

  constructor(
    @InjectRepository(UsageQuotaEntity)
    private readonly quotaRepo: Repository<UsageQuotaEntity>,
    @Optional() @Inject(REDIS_CLIENT_TOKEN) redisClient?: RedisLike,
  ) {
    this.redis = redisClient ?? null;
    if (this.redis) {
      this.logger.log('QuotaService: Redis connected ✓');
    } else {
      this.logger.warn('QuotaService: Redis not available — using in-memory fallback (not persistent)');
    }
  }

  // ── Redis-or-memory helpers ──────────────────────────────
  private async cacheGet(key: string): Promise<string | null> {
    try {
      if (this.redis) return await this.redis.get(key);
    } catch (e) { this.logger.warn(`Redis GET failed: ${String(e)}`); }
    return memGet(key);
  }

  private async cacheDel(key: string): Promise<void> {
    try {
      if (this.redis) { await this.redis.del(key); return; }
    } catch (e) { this.logger.warn(`Redis DEL failed: ${String(e)}`); }
    memDel(key);
  }

  private async cacheIncr(key: string, ttl = 3600): Promise<number> {
    try {
      if (this.redis) {
        const val = await this.redis.incr(key);
        if (val === 1) await this.redis.expire(key, ttl);
        return val;
      }
    } catch (e) { this.logger.warn(`Redis INCR failed: ${String(e)}`); }
    return memIncr(key);
  }

  private async cacheDecr(key: string): Promise<number> {
    try {
      if (this.redis) {
        const val = await this.redis.decr(key);
        return val < 0 ? 0 : val;
      }
    } catch (e) { this.logger.warn(`Redis DECR failed: ${String(e)}`); }
    return memDecr(key);
  }

  // ── Get or create current period quota ──────────────────
  async getOrCreateQuota(userId: string, plan: Plan): Promise<UsageQuotaEntity> {
    const { periodStart, periodEnd } = this.currentPeriod();
    const limits = getPlanLimits(plan);

    let quota = await this.quotaRepo.findOne({ where: { userId, periodStart } });

    if (!quota) {
      quota = this.quotaRepo.create({
        userId,
        periodStart,
        periodEnd,
        conversionsLimit: limits.conversionsPerMonth,
        plan,
      });
      quota = await this.quotaRepo.save(quota);
    }

    return quota;
  }

  // ── Check if conversion is allowed ──────────────────────
  async checkConversionQuota(userId: string, plan: Plan): Promise<QuotaCheckResult> {
    const limits = getPlanLimits(plan);
    const { periodStart } = this.currentPeriod();

    const cacheKey = `quota:conv:${userId}:${periodStart.toISOString().slice(0, 7)}`;
    const cached = await this.cacheGet(cacheKey);
    const used = cached ? parseInt(cached, 10) : await this.getConversionsUsed(userId, periodStart);

    const limit = limits.conversionsPerMonth;
    const allowed = isUnlimited(limit) || used < limit;
    const remaining = isUnlimited(limit) ? -1 : Math.max(0, limit - used);
    const resetAt = this.nextPeriodStart();

    return { allowed, used, limit, remaining, resetAt };
  }

  // ── Increment conversion count ───────────────────────────
  async incrementConversions(
    userId: string,
    plan: Plan,
    extra?: { aiRequestsUsed?: number; aiTokensUsed?: number; filesProcessed?: number; linesProcessed?: number; storageBytesUsed?: number },
  ): Promise<void> {
    const { periodStart, periodEnd } = this.currentPeriod();
    const limits = getPlanLimits(plan);

    await this.quotaRepo
      .createQueryBuilder()
      .insert()
      .into(UsageQuotaEntity)
      .values({
        userId,
        periodStart,
        periodEnd,
        conversionsUsed: 1,
        conversionsLimit: limits.conversionsPerMonth,
        plan,
        aiRequestsUsed: extra?.aiRequestsUsed ?? 0,
        aiTokensUsed:   extra?.aiTokensUsed ?? 0,
        filesProcessed: extra?.filesProcessed ?? 0,
        linesProcessed: extra?.linesProcessed ?? 0,
        storageBytesUsed: String(extra?.storageBytesUsed ?? 0),
      })
      .orUpdate(
        ['conversionsUsed', 'aiRequestsUsed', 'aiTokensUsed', 'filesProcessed', 'linesProcessed', 'storageBytesUsed', 'updatedAt'],
        ['userId', 'periodStart'],
        { skipUpdateIfNoValuesChanged: false, upsertType: 'on-conflict-do-update' },
      )
      .execute()
      .catch(async () => {
        await this.quotaRepo.increment({ userId, periodStart }, 'conversionsUsed', 1);
        if (extra?.aiRequestsUsed) await this.quotaRepo.increment({ userId, periodStart }, 'aiRequestsUsed', extra.aiRequestsUsed);
        if (extra?.aiTokensUsed) await this.quotaRepo.increment({ userId, periodStart }, 'aiTokensUsed', extra.aiTokensUsed);
        if (extra?.filesProcessed) await this.quotaRepo.increment({ userId, periodStart }, 'filesProcessed', extra.filesProcessed);
        if (extra?.linesProcessed) await this.quotaRepo.increment({ userId, periodStart }, 'linesProcessed', extra.linesProcessed);
      });

    const cacheKey = `quota:conv:${userId}:${periodStart.toISOString().slice(0, 7)}`;
    await this.cacheDel(cacheKey);
  }

  // ── Enforce quota (throws if exceeded) ──────────────────
  async enforceConversionQuota(userId: string, plan: Plan): Promise<void> {
    const { allowed, used, limit, remaining } = await this.checkConversionQuota(userId, plan);

    if (!allowed) {
      const limitStr = isUnlimited(limit) ? 'unlimited' : String(limit);
      throw new ForbiddenException({
        code:      'QUOTA_EXCEEDED',
        message:   `Conversion quota exceeded. You've used ${used}/${limitStr} conversions this month.`,
        used,
        limit,
        remaining,
        resetAt:   this.nextPeriodStart(),
        upgradeUrl: '/pricing',
      });
    }
  }

  // ── Check AI request rate limit ──────────────────────────
  async checkAiRateLimit(userId: string, plan: Plan): Promise<{ allowed: boolean; resetInSeconds: number }> {
    const limits = getPlanLimits(plan);
    if (isUnlimited(limits.aiRequestsPerHour)) return { allowed: true, resetInSeconds: 0 };

    const key   = `ratelimit:ai:${userId}:${Math.floor(Date.now() / 3_600_000)}`;
    const count = await this.cacheIncr(key, 3600);

    const allowed = count <= limits.aiRequestsPerHour;
    const resetInSeconds = allowed ? 0 : 3600 - (Math.floor(Date.now() / 1000) % 3600);
    return { allowed, resetInSeconds };
  }

  // ── Check concurrent jobs ────────────────────────────────
  async checkConcurrentJobs(userId: string, plan: Plan): Promise<{ allowed: boolean; current: number; limit: number }> {
    const limits = getPlanLimits(plan);
    const key    = `concurrent:${userId}`;
    const current = parseInt((await this.cacheGet(key)) ?? '0', 10);
    return { allowed: current < limits.concurrentJobs, current, limit: limits.concurrentJobs };
  }

  async incrementConcurrentJobs(userId: string, _plan?: Plan): Promise<void> {
    await this.cacheIncr(`concurrent:${userId}`, 3600);
  }

  async decrementConcurrentJobs(userId: string, _plan?: Plan): Promise<void> {
    await this.cacheDecr(`concurrent:${userId}`);
  }

  // ── Get usage summary for dashboard ─────────────────────
  async getUsageSummary(userId: string, plan: Plan) {
    const quota = await this.getOrCreateQuota(userId, plan);
    const limits = getPlanLimits(plan);
    const { periodEnd } = this.currentPeriod();

    return {
      conversions: {
        used:      quota.conversionsUsed,
        limit:     limits.conversionsPerMonth,
        remaining: isUnlimited(limits.conversionsPerMonth)
          ? -1
          : Math.max(0, limits.conversionsPerMonth - quota.conversionsUsed),
        unlimited: isUnlimited(limits.conversionsPerMonth),
      },
      aiRequests:  { used: quota.aiRequestsUsed, limit: limits.aiRequestsPerHour, unlimited: isUnlimited(limits.aiRequestsPerHour) },
      aiTokens:    { used: quota.aiTokensUsed },
      files:       { processed: quota.filesProcessed },
      lines:       { processed: quota.linesProcessed },
      storage:     { usedBytes: parseInt(quota.storageBytesUsed, 10) },
      period:      { start: quota.periodStart, end: periodEnd, resetAt: this.nextPeriodStart() },
      plan,
    };
  }

  async getMonthlyAggregates(year: number, month: number) {
    const periodStart = new Date(`${year}-${String(month).padStart(2, '0')}-01`);
    return this.quotaRepo.find({ where: { periodStart }, order: { conversionsUsed: 'DESC' }, take: 100 });
  }

  private currentPeriod(): { periodStart: Date; periodEnd: Date } {
    const now = new Date();
    return {
      periodStart: new Date(now.getFullYear(), now.getMonth(), 1),
      periodEnd:   new Date(now.getFullYear(), now.getMonth() + 1, 0),
    };
  }

  private nextPeriodStart(): Date {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth() + 1, 1);
  }

  private async getConversionsUsed(userId: string, periodStart: Date): Promise<number> {
    const quota = await this.quotaRepo.findOne({ where: { userId, periodStart } });
    return quota?.conversionsUsed ?? 0;
  }
}
