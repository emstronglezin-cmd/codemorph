// ============================================================
// CodeMorph — Billing Service (Stripe integration stub)
// ============================================================
import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

import type { UserId } from '@codemorph/shared';
import { UsersService } from '../users/users.service';

@Injectable()
export class BillingService {
  private readonly stripe: Stripe;

  constructor(
    private readonly config: ConfigService,
    private readonly usersService: UsersService,
  ) {
    this.stripe = new Stripe(
      this.config.get<string>('STRIPE_SECRET_KEY') ?? 'sk_test_placeholder',
      { apiVersion: '2024-12-18.acacia' },
    );
  }

  // ── Create checkout session ────────────────────────────
  async createCheckoutSession(
    userId: UserId,
    plan: 'starter' | 'pro' | 'enterprise',
  ): Promise<{ url: string }> {
    const user = await this.usersService.findByIdOrFail(userId);
    const appUrl = this.config.get<string>('app.appUrl', 'http://localhost:3000');

    const priceIds: Record<string, string> = {
      starter:    this.config.get<string>('STRIPE_STARTER_PRICE_ID', ''),
      pro:        this.config.get<string>('STRIPE_PRO_PRICE_ID', ''),
      enterprise: this.config.get<string>('STRIPE_ENTERPRISE_PRICE_ID', ''),
    };

    const priceId = priceIds[plan];
    if (!priceId) throw new BadRequestException(`Invalid plan: ${plan}`);

    const session = await this.stripe.checkout.sessions.create({
      customer_email: user.email,
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `${appUrl}/dashboard/org/billing?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${appUrl}/dashboard/org/billing?canceled=true`,
      metadata:    { userId: userId as string, plan },
    });

    return { url: session.url ?? '' };
  }

  // ── Create billing portal ─────────────────────────────
  async createPortalSession(userId: UserId): Promise<{ url: string }> {
    const user = await this.usersService.findByIdOrFail(userId);
    if (!user.stripeCustomerId) {
      throw new BadRequestException('No billing account found. Please subscribe first.');
    }

    const appUrl = this.config.get<string>('app.appUrl', 'http://localhost:3000');
    const session = await this.stripe.billingPortal.sessions.create({
      customer:   user.stripeCustomerId,
      return_url: `${appUrl}/dashboard/org/billing`,
    });

    return { url: session.url };
  }

  // ── Handle Stripe webhook ─────────────────────────────
  async handleWebhook(payload: Buffer, signature: string): Promise<void> {
    const webhookSecret = this.config.get<string>('STRIPE_WEBHOOK_SECRET') ?? '';
    let event: Stripe.Event;

    try {
      event = this.stripe.webhooks.constructEvent(payload, signature, webhookSecret);
    } catch {
      throw new BadRequestException('Webhook signature verification failed');
    }

    switch (event.type) {
      case 'checkout.session.completed':
        await this.handleCheckoutCompleted(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await this.handleSubscriptionDeleted(event.data.object);
        break;
      case 'customer.subscription.updated':
        await this.handleSubscriptionUpdated(event.data.object);
        break;
      default:
        break;
    }
  }

  private async handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const userId = session.metadata?.['userId'] as string | undefined;
    const plan   = session.metadata?.['plan'] as 'starter' | 'pro' | 'enterprise' | undefined;

    if (!userId || !plan) return;

    await this.usersService.update(userId as UserId, {
      plan,
      stripeCustomerId: session.customer as string | undefined,
    });
  }

  private async handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
    const customerId = subscription.customer as string;
    // Find user by stripeCustomerId and downgrade to free
    void customerId;
    // TODO: implement lookup by stripe customer ID
  }

  private async handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
    void subscription;
    // TODO: handle plan changes
  }
}
