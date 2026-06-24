// ============================================================
// CodeMorph — Subscription Service
// Redis OPTIONNEL : fallback in-memory si REDIS_URL absent
// Stripe conservé pour compatibilité mais non utilisé (on utilise LeekPay)
// ============================================================
import {
  Injectable, Logger, Optional, Inject,
  BadRequestException, ForbiddenException
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import {
  SubscriptionEntity,
  SubscriptionStatus,
  BillingInterval,
  BillingProvider,
} from './subscription.entity';
import {
  Plan,
  PLAN_LIMITS,
  PLAN_DISPLAY,
  getPlanLimits,
} from './plan-limits.config';
import { UsersService } from '../users/users.service';

export const SUB_REDIS_TOKEN = 'SUBSCRIPTION_REDIS_CLIENT';

export interface CheckoutSessionResult {
  url: string;
  sessionId: string;
  provider: BillingProvider;
}

export interface PortalSessionResult {
  url: string;
}

export interface SubscriptionSummary {
  plan: Plan;
  status: SubscriptionStatus;
  interval: BillingInterval;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  trialEnd: Date | null;
  limits: ReturnType<typeof getPlanLimits>;
  display: (typeof PLAN_DISPLAY)[Plan];
}

// ── Simple in-memory cache (fallback when Redis absent) ──
const memCache = new Map<string, { value: string; exp: number }>();
function mGet(k: string): string | null {
  const e = memCache.get(k);
  if (!e) return null;
  if (Date.now() > e.exp) { memCache.delete(k); return null; }
  return e.value;
}
function mSet(k: string, v: string, ttl: number) {
  memCache.set(k, { value: v, exp: Date.now() + ttl * 1000 });
}
function mDel(...keys: string[]) { keys.forEach(k => memCache.delete(k)); }

// ── Redis-like interface ─────────────────────────────────
type RedisLike = {
  get(k: string): Promise<string | null>;
  setex(k: string, t: number, v: string): Promise<unknown>;
  del(k: string): Promise<unknown>;
};

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);
  private readonly redis: RedisLike | null;
  private readonly CACHE_TTL = 300;

  constructor(
    @InjectRepository(SubscriptionEntity)
    private readonly subRepo: Repository<SubscriptionEntity>,
    @Optional() @Inject(SUB_REDIS_TOKEN) redisClient: RedisLike | null,
    private readonly config: ConfigService,
    private readonly usersService: UsersService,
  ) {
    this.redis = redisClient ?? null;
    if (!this.redis) {
      this.logger.warn('SubscriptionService: Redis not available — using in-memory cache');
    }
  }

  // ── Cache helpers ─────────────────────────────────────
  private async cGet(k: string): Promise<string | null> {
    try { if (this.redis) return await this.redis.get(k); } catch { /* ignore */ }
    return mGet(k);
  }
  private async cSetex(k: string, ttl: number, v: string): Promise<void> {
    try { if (this.redis) { await this.redis.setex(k, ttl, v); return; } } catch { /* ignore */ }
    mSet(k, v, ttl);
  }
  private async cDel(...keys: string[]): Promise<void> {
    try { if (this.redis) { await Promise.all(keys.map(k => this.redis!.del(k))); return; } } catch { /* ignore */ }
    mDel(...keys);
  }

  // ── Get current subscription ─────────────────────────────
  async getSubscription(userId: string): Promise<SubscriptionSummary> {
    const cacheKey = `sub:${userId}`;
    const cached = await this.cGet(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as SubscriptionSummary;
      if (parsed.currentPeriodEnd) parsed.currentPeriodEnd = new Date(parsed.currentPeriodEnd);
      if (parsed.trialEnd) parsed.trialEnd = new Date(parsed.trialEnd);
      return parsed;
    }

    const sub = await this.subRepo.findOne({
      where: { userId, status: SubscriptionStatus.ACTIVE },
      order: { createdAt: 'DESC' },
    });

    const user = await this.usersService.findById(userId as never);

    const summary: SubscriptionSummary = sub
      ? {
          plan:               sub.plan as Plan,
          status:             sub.status,
          interval:           sub.interval,
          currentPeriodEnd:   sub.currentPeriodEnd,
          cancelAtPeriodEnd:  !!sub.cancelAtPeriodEnd,
          trialEnd:           sub.trialEnd,
          limits:             getPlanLimits(sub.plan as Plan),
          display:            PLAN_DISPLAY[sub.plan as Plan] ?? PLAN_DISPLAY.free,
        }
      : {
          plan:               (user?.plan as Plan) ?? 'free',
          status:             SubscriptionStatus.ACTIVE,
          interval:           BillingInterval.MONTHLY,
          currentPeriodEnd:   null,
          cancelAtPeriodEnd:  false,
          trialEnd:           null,
          limits:             getPlanLimits((user?.plan as Plan) ?? 'free'),
          display:            PLAN_DISPLAY[(user?.plan as Plan) ?? 'free'],
        };

    await this.cSetex(cacheKey, this.CACHE_TTL, JSON.stringify(summary));
    return summary;
  }

  // ── Get plan (critical for quota checks) ─────────────────
  async getUserPlan(userId: string): Promise<Plan> {
    const cacheKey = `userplan:${userId}`;
    const cached = await this.cGet(cacheKey);
    if (cached && ['free', 'pro', 'pro_max'].includes(cached)) return cached as Plan;

    const user = await this.usersService.findById(userId as never);
    const plan = (user?.plan as Plan) ?? 'free';
    await this.cSetex(cacheKey, 120, plan);
    return plan;
  }

  // ── Create checkout session (Stripe — legacy, non utilisé) ─
  async createCheckoutSession(
    userId: string,
    plan: Plan,
    _interval: BillingInterval = BillingInterval.MONTHLY,
  ): Promise<CheckoutSessionResult> {
    if (plan === 'free') throw new BadRequestException('Cannot checkout for free plan');
    // Stripe non configuré — rediriger vers LeekPay
    const appUrl = this.config.get<string>('FRONTEND_URL', 'http://localhost:3000');
    return {
      url: `${appUrl}/dashboard/billing`,
      sessionId: `leekpay_${userId}_${plan}`,
      provider: BillingProvider.MANUAL,
    };
  }

  // ── Create portal session ─────────────────────────────────
  async createPortalSession(_userId: string): Promise<PortalSessionResult> {
    const appUrl = this.config.get<string>('FRONTEND_URL', 'http://localhost:3000');
    return { url: `${appUrl}/dashboard/billing` };
  }

  // ── Handle Stripe webhook (no-op) ────────────────────────
  async handleStripeWebhook(_payload: Buffer, _signature: string): Promise<void> {
    this.logger.log('Stripe webhook received (not configured — using LeekPay)');
  }

  // ── Activate plan after LeekPay payment ──────────────────
  async activatePlan(userId: string, planId: Plan): Promise<void> {
    await this.usersService.update(userId as never, { plan: planId });
    await this.invalidateCache(userId);
    this.logger.log(`Plan activated: user=${userId} plan=${planId}`);
  }

  // ── Downgrade to free ────────────────────────────────────
  async downgradeToFree(userId: string): Promise<void> {
    await this.subRepo.update(
      { userId, status: SubscriptionStatus.ACTIVE },
      { status: SubscriptionStatus.CANCELED, canceledAt: new Date() },
    );
    await this.usersService.update(userId as never, { plan: 'free' });
    await this.invalidateCache(userId);
  }

  // ── Validate feature access ──────────────────────────────
  async assertFeatureAccess(userId: string, feature: keyof typeof PLAN_LIMITS['free']): Promise<void> {
    const plan = await this.getUserPlan(userId);
    const limits = getPlanLimits(plan);
    const allowed = limits[feature as keyof typeof limits];

    if (allowed === false || allowed === 0) {
      throw new ForbiddenException({
        code:       'FEATURE_NOT_AVAILABLE',
        message:    `This feature requires a higher plan. Current plan: ${plan}.`,
        feature, plan,
        upgradeUrl: '/pricing',
      });
    }
  }

  // ── Helpers ──────────────────────────────────────────────
  private async invalidateCache(userId: string): Promise<void> {
    await this.cDel(`sub:${userId}`, `userplan:${userId}`);
  }
}
