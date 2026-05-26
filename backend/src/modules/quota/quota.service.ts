// ============================================================
// CodeMorph — Quota Service
// Tracks & enforces per-user monthly usage limits
// ============================================================
import {
  Injectable, ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectRedis } from '@liaoliaots/nestjs-redis';
import Redis from 'ioredis';
import { UsageQuotaEntity } from './quota.entity';
import { getPlanLimits, isUnlimited, Plan } from '../subscription/plan-limits.config';

interface QuotaCheckResult {
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
  resetAt: Date;
}

@Injectable()
export class QuotaService {
  
  

  constructor(
    @InjectRepository(UsageQuotaEntity)
    private readonly quotaRepo: Repository<UsageQuotaEntity>,
    @InjectRedis()
    private readonly redis: Redis,
  ) {}

  // ── Get or create current period quota ──────────────────
  async getOrCreateQuota(userId: string, plan: Plan): Promise<UsageQuotaEntity> {
    const { periodStart, periodEnd } = this.currentPeriod();
    const limits = getPlanLimits(plan);

    let quota = await this.quotaRepo.findOne({
      where: { userId, periodStart },
    });

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

    // Check Redis cache first
    const cacheKey = `quota:conv:${userId}:${periodStart.toISOString().slice(0, 7)}`;
    const cached = await this.redis.get(cacheKey);
    let used = cached ? parseInt(cached, 10) : await this.getConversionsUsed(userId, periodStart);

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

    // Upsert quota record
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
        {
          skipUpdateIfNoValuesChanged: false,
          upsertType: 'on-conflict-do-update',
        },
      )
      .execute()
      .catch(async () => {
        // Fallback: increment existing record
        await this.quotaRepo.increment({ userId, periodStart }, 'conversionsUsed', 1);
        if (extra?.aiRequestsUsed) await this.quotaRepo.increment({ userId, periodStart }, 'aiRequestsUsed', extra.aiRequestsUsed);
        if (extra?.aiTokensUsed) await this.quotaRepo.increment({ userId, periodStart }, 'aiTokensUsed', extra.aiTokensUsed);
        if (extra?.filesProcessed) await this.quotaRepo.increment({ userId, periodStart }, 'filesProcessed', extra.filesProcessed);
        if (extra?.linesProcessed) await this.quotaRepo.increment({ userId, periodStart }, 'linesProcessed', extra.linesProcessed);
      });

    // Invalidate cache
    const cacheKey = `quota:conv:${userId}:${periodStart.toISOString().slice(0, 7)}`;
    await this.redis.del(cacheKey);
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

    const key    = `ratelimit:ai:${userId}:${Math.floor(Date.now() / 3_600_000)}`;
    const count  = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, 3600);

    const allowed = count <= limits.aiRequestsPerHour;
    const resetInSeconds = allowed ? 0 : 3600 - (Math.floor(Date.now() / 1000) % 3600);
    return { allowed, resetInSeconds };
  }

  // ── Check concurrent jobs ────────────────────────────────
  async checkConcurrentJobs(userId: string, plan: Plan): Promise<{ allowed: boolean; current: number; limit: number }> {
    const limits = getPlanLimits(plan);
    const key    = `concurrent:${userId}`;
    const current = parseInt((await this.redis.get(key)) ?? '0', 10);
    return { allowed: current < limits.concurrentJobs, current, limit: limits.concurrentJobs };
  }

  async incrementConcurrentJobs(userId: string, _plan?: Plan): Promise<void> {
    const key = `concurrent:${userId}`;
    await this.redis.incr(key);
    await this.redis.expire(key, 3600); // auto-cleanup after 1h
  }

  async decrementConcurrentJobs(userId: string, _plan?: Plan): Promise<void> {
    const key = `concurrent:${userId}`;
    const val = await this.redis.decr(key);
    if (val < 0) await this.redis.set(key, '0');
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
      aiRequests: {
        used:     quota.aiRequestsUsed,
        limit:    limits.aiRequestsPerHour,
        unlimited: isUnlimited(limits.aiRequestsPerHour),
      },
      aiTokens:   { used: quota.aiTokensUsed },
      files:      { processed: quota.filesProcessed },
      lines:      { processed: quota.linesProcessed },
      storage:    { usedBytes: parseInt(quota.storageBytesUsed, 10) },
      period:     { start: quota.periodStart, end: periodEnd, resetAt: this.nextPeriodStart() },
      plan,
    };
  }

  // ── Admin: get all quotas for a period ───────────────────
  async getMonthlyAggregates(year: number, month: number) {
    const periodStart = new Date(`${year}-${String(month).padStart(2, '0')}-01`);
    return this.quotaRepo.find({
      where: { periodStart },
      order: { conversionsUsed: 'DESC' },
      take:  100,
    });
  }

  // ── Helpers ──────────────────────────────────────────────
  private currentPeriod(): { periodStart: Date; periodEnd: Date } {
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return { periodStart, periodEnd };
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
