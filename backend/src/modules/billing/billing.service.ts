// ============================================================
// CodeMorph — Billing Service (Stripe integration stub)
// ============================================================
import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

import type { UserId } from '@codemorph/shared';
import { UsersService } from '../users/users.service';
import type { Plan } from '../subscription/plan-limits.config';

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
    plan: Plan,
  ): Promise<{ url: string }> {
    const user = await this.usersService.findByIdOrFail(userId);
    const frontendUrl = this.config.get<string>('FRONTEND_URL',
      this.config.get<string>('app.appUrl', 'http://localhost:3000'),
    );

    const priceIds: Record<string, string> = {
      free:    '',
      pro:     this.config.get<string>('STRIPE_PRICE_PRO_MONTHLY', ''),
      pro_max: this.config.get<string>('STRIPE_PRICE_PRO_MAX_MONTHLY', ''),
    };

    const priceId = priceIds[plan];
    if (!priceId) throw new BadRequestException(`Invalid plan or no price configured: ${plan}`);

    const session = await this.stripe.checkout.sessions.create({
      customer_email: user.email,
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `${frontendUrl}/dashboard/billing?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${frontendUrl}/dashboard/billing?canceled=true`,
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

    const frontendUrl = this.config.get<string>('FRONTEND_URL',
      this.config.get<string>('app.appUrl', 'http://localhost:3000'),
    );
    const session = await this.stripe.billingPortal.sessions.create({
      customer:   user.stripeCustomerId,
      return_url: `${frontendUrl}/dashboard/billing`,
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
    const plan   = session.metadata?.['plan'] as Plan | undefined;

    if (!userId || !plan) return;

    await this.usersService.update(userId as UserId, {
      plan,
      stripeCustomerId: session.customer as string | undefined,
    });
  }

  private async handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
    const customerId = subscription.customer as string;
    const user = await this.usersService.findByStripeCustomerId(customerId);
    if (user) {
      await this.usersService.update(user.id as UserId, { plan: 'free' });
    }
  }

  private async handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
    void subscription;
    // TODO: handle plan changes
  }
}
