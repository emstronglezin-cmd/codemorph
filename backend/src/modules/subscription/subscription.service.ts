// ============================================================
// CodeMorph — Subscription Service
// Modulaire : Stripe aujourd'hui, LemonSqueezy/Paddle demain
// ============================================================
import {
  Injectable, Logger,
  BadRequestException, ForbiddenException
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectRedis } from '@liaoliaots/nestjs-redis';
import Redis from 'ioredis';
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
import Stripe from 'stripe';

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

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);
  private readonly stripe: Stripe;
  private readonly CACHE_TTL = 300; // 5 minutes

  constructor(
    @InjectRepository(SubscriptionEntity)
    private readonly subRepo: Repository<SubscriptionEntity>,
    @InjectRedis()
    private readonly redis: Redis,
    private readonly config: ConfigService,
    private readonly usersService: UsersService,
  ) {
    this.stripe = new Stripe(
      this.config.get<string>('STRIPE_SECRET_KEY', 'sk_test_placeholder'),
      { apiVersion: '2023-10-16' },
    );
  }

  // ── Get current subscription ─────────────────────────────
  async getSubscription(userId: string): Promise<SubscriptionSummary> {
    const cacheKey = `sub:${userId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as SubscriptionSummary;
      // Restore dates
      if (parsed.currentPeriodEnd) parsed.currentPeriodEnd = new Date(parsed.currentPeriodEnd);
      if (parsed.trialEnd) parsed.trialEnd = new Date(parsed.trialEnd);
      return parsed;
    }

    const sub = await this.subRepo.findOne({
      where: { userId, status: SubscriptionStatus.ACTIVE },
      order: { createdAt: 'DESC' },
    });

    const user = await this.usersService.findById(userId as any);
    const _unusedPlan: Plan = (user?.plan as Plan) ?? 'free'; void _unusedPlan;

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
          plan:               'free',
          status:             SubscriptionStatus.ACTIVE,
          interval:           BillingInterval.MONTHLY,
          currentPeriodEnd:   null,
          cancelAtPeriodEnd:  false,
          trialEnd:           null,
          limits:             getPlanLimits('free'),
          display:            PLAN_DISPLAY.free,
        };

    await this.redis.setex(cacheKey, this.CACHE_TTL, JSON.stringify(summary));
    return summary;
  }

  // ── Create Stripe checkout session ──────────────────────
  async createCheckoutSession(
    userId: string,
    plan: Plan,
    interval: BillingInterval = BillingInterval.MONTHLY,
  ): Promise<CheckoutSessionResult> {
    if (plan === 'free') {
      throw new BadRequestException('Cannot checkout for free plan');
    }

    const user = await this.usersService.findByIdOrFail(userId as any);
    const appUrl = this.config.get<string>('FRONTEND_URL', 'http://localhost:3000');

    const priceId = this.getStripePriceId(plan, interval);
    if (!priceId) {
      throw new BadRequestException(`No Stripe price configured for ${plan}/${interval}`);
    }

    // Ensure or create Stripe customer
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await this.stripe.customers.create({
        email:    user.email,
        name:     user.name,
        metadata: { userId, codeMorphPlan: plan },
      });
      customerId = customer.id;
      await this.usersService.update(userId as any, { stripeCustomerId: customerId });
    }

    const session = await this.stripe.checkout.sessions.create({
      customer:             customerId,
      line_items:           [{ price: priceId, quantity: 1 }],
      mode:                 'subscription',
      allow_promotion_codes: true,
      subscription_data:    {
        trial_period_days: this.getTrialDays(plan),
        metadata: { userId, plan, interval },
      },
      success_url: `${appUrl}/dashboard/billing?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${appUrl}/pricing?canceled=true`,
      metadata:    { userId, plan, interval },
    });

    this.logger.log(`Checkout session created for user ${userId} plan=${plan}/${interval}`);
    return { url: session.url ?? '', sessionId: session.id, provider: BillingProvider.STRIPE };
  }

  // ── Create Stripe billing portal ─────────────────────────
  async createPortalSession(userId: string): Promise<PortalSessionResult> {
    const user = await this.usersService.findByIdOrFail(userId as any);
    if (!user.stripeCustomerId) {
      throw new BadRequestException('No billing account found. Please subscribe first.');
    }

    const appUrl = this.config.get<string>('FRONTEND_URL', 'http://localhost:3000');
    const session = await this.stripe.billingPortal.sessions.create({
      customer:   user.stripeCustomerId,
      return_url: `${appUrl}/dashboard/billing`,
    });

    return { url: session.url };
  }

  // ── Handle Stripe webhook ────────────────────────────────
  async handleStripeWebhook(payload: Buffer, signature: string): Promise<void> {
    const webhookSecret = this.config.get<string>('STRIPE_WEBHOOK_SECRET', '');
    let event: Stripe.Event;

    try {
      event = this.stripe.webhooks.constructEvent(payload, signature, webhookSecret);
    } catch (err) {
      throw new BadRequestException(`Webhook signature failed: ${(err as Error).message}`);
    }

    this.logger.log(`Stripe webhook: ${event.type}`);

    switch (event.type) {
      case 'checkout.session.completed':
        await this.handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await this.handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
        break;
      case 'customer.subscription.deleted':
        await this.handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
      case 'invoice.payment_failed':
        await this.handlePaymentFailed(event.data.object as Stripe.Invoice);
        break;
      case 'invoice.paid':
        await this.handleInvoicePaid(event.data.object as Stripe.Invoice);
        break;
      default:
        this.logger.debug(`Unhandled Stripe event: ${event.type}`);
    }
  }

  // ── Downgrade to free ────────────────────────────────────
  async downgradeToFree(userId: string): Promise<void> {
    await this.subRepo.update(
      { userId, status: SubscriptionStatus.ACTIVE },
      { status: SubscriptionStatus.CANCELED, canceledAt: new Date() },
    );
    await this.usersService.update(userId as any, { plan: 'free' });
    await this.invalidateCache(userId);
    this.logger.log(`User ${userId} downgraded to free`);
  }

  // ── Get plan from user (cached) ──────────────────────────
  async getUserPlan(userId: string): Promise<Plan> {
    const cacheKey = `userplan:${userId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return cached as Plan;

    const user = await this.usersService.findById(userId as any);
    const plan = (user?.plan as Plan) ?? 'free';
    await this.redis.setex(cacheKey, 120, plan);
    return plan;
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
        feature,
        plan,
        upgradeUrl: '/pricing',
      });
    }
  }

  // ── Private: Stripe webhook handlers ────────────────────
  private async handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const userId = session.metadata?.userId;
    const plan   = session.metadata?.plan as Plan;
    if (!userId || !plan) return;

    await this.usersService.update(userId as any, { plan });
    await this.invalidateCache(userId);
    this.logger.log(`Checkout completed: user=${userId} plan=${plan}`);
  }

  private async handleSubscriptionUpdated(sub: Stripe.Subscription): Promise<void> {
    const userId = sub.metadata?.userId;
    if (!userId) return;

    const plan     = sub.metadata?.plan as Plan ?? 'free';
    const interval = sub.items.data[0]?.plan?.interval === 'year'
      ? BillingInterval.ANNUAL
      : BillingInterval.MONTHLY;

    const status = this.mapStripeStatus(sub.status);

    await this.subRepo
      .createQueryBuilder()
      .insert()
      .into(SubscriptionEntity)
      .values({
        userId,
        plan,
        status,
        interval,
        provider:               BillingProvider.STRIPE,
        providerSubscriptionId: sub.id,
        providerCustomerId:     sub.customer as string,
        currentPeriodStart:     new Date(sub.current_period_start * 1000),
        currentPeriodEnd:       new Date(sub.current_period_end * 1000),
        trialEnd:               sub.trial_end ? new Date(sub.trial_end * 1000) : undefined,
        cancelAtPeriodEnd:      sub.cancel_at_period_end && sub.cancel_at ? new Date(sub.cancel_at * 1000) : undefined,
      })
      .orUpdate(
        ['plan', 'status', 'interval', 'currentPeriodStart', 'currentPeriodEnd', 'trialEnd', 'cancelAtPeriodEnd', 'updatedAt'],
        ['providerSubscriptionId'],
      )
      .execute();

    if (status === SubscriptionStatus.ACTIVE) {
      await this.usersService.update(userId as any, { plan });
    }
    await this.invalidateCache(userId);
  }

  private async handleSubscriptionDeleted(sub: Stripe.Subscription): Promise<void> {
    const userId = sub.metadata?.userId;
    if (!userId) return;

    await this.subRepo.update(
      { providerSubscriptionId: sub.id },
      { status: SubscriptionStatus.CANCELED, canceledAt: new Date() },
    );
    await this.usersService.update(userId as any, { plan: 'free' });
    await this.invalidateCache(userId);
    this.logger.log(`Subscription deleted: user=${userId}`);
  }

  private async handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    const customerId = invoice.customer as string;
    const user = await this.usersService.findByStripeCustomerId(customerId);
    if (!user) return;

    await this.subRepo.update(
      { userId: user.id, status: SubscriptionStatus.ACTIVE },
      { status: SubscriptionStatus.PAST_DUE },
    );
    await this.invalidateCache(user.id);
    this.logger.warn(`Payment failed for user ${user.id} (customer: ${customerId})`);
  }

  private async handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
    const customerId = invoice.customer as string;
    const user = await this.usersService.findByStripeCustomerId(customerId);
    if (!user) return;

    await this.subRepo.update(
      { userId: user.id, status: SubscriptionStatus.PAST_DUE },
      { status: SubscriptionStatus.ACTIVE },
    );
    await this.invalidateCache(user.id);
  }

  // ── Helpers ──────────────────────────────────────────────
  private getStripePriceId(plan: Plan, interval: BillingInterval): string {
    const key = `STRIPE_${plan.toUpperCase()}_${interval.toUpperCase()}_PRICE_ID`;
    return this.config.get<string>(key, '');
  }

  private getTrialDays(plan: Plan): number {
    return plan === 'pro' ? 7 : plan === 'pro_max' ? 14 : 0;
  }

  private mapStripeStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
    const map: Record<string, SubscriptionStatus> = {
      active:            SubscriptionStatus.ACTIVE,
      trialing:          SubscriptionStatus.TRIALING,
      past_due:          SubscriptionStatus.PAST_DUE,
      canceled:          SubscriptionStatus.CANCELED,
      unpaid:            SubscriptionStatus.PAST_DUE,
      paused:            SubscriptionStatus.PAUSED,
      incomplete:        SubscriptionStatus.PAST_DUE,
      incomplete_expired: SubscriptionStatus.EXPIRED,
    };
    return map[status] ?? SubscriptionStatus.EXPIRED;
  }

  private async invalidateCache(userId: string): Promise<void> {
    await Promise.all([
      this.redis.del(`sub:${userId}`),
      this.redis.del(`userplan:${userId}`),
    ]);
  }
}
