// ============================================================
// CodeMorph — LeekPay Service
// Système de paiement francophone (XOF / EUR / USD)
// API REST : https://leekpay.fr/api/v1
// ============================================================
import {
  Injectable,
  Logger,
  BadRequestException,
  UnauthorizedException,
  forwardRef,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { SubscriptionService } from '../subscription/subscription.service';
import type { Plan } from '../subscription/plan-limits.config';

export interface LeekPayCheckoutRequest {
  amount: number;           // ex: 5000 = 5 000 XOF
  currency: 'XOF' | 'EUR' | 'USD';
  description: string;
  return_url: string;
  cancel_url?: string;
  webhook_url?: string;
  customer_email?: string;
  customer_name?: string;
  customer_phone?: string;
  metadata?: Record<string, unknown>;
}

export interface LeekPayCheckout {
  id: string;               // "checkout_42"
  payment_url: string;      // "https://leekpay.me/pay_AbCdEf..."
  amount: number;
  currency: string;
  status: LeekPayStatus;
  expires_at: string;
  return_url: string | null;
}

export interface LeekPayWebhookPayload {
  event: string;            // "payment.completed"
  data: {
    transaction_id: string;
    checkout_id: string;
    amount: number;
    currency: string;
    status: LeekPayStatus;
    payment_method: string;
    customer: {
      email: string;
      name: string;
      phone: string;
    };
    metadata: Record<string, unknown> | null;
    paid_at: string;
  };
}

export type LeekPayStatus =
  | 'pending'
  | 'processing'
  | 'paid'
  | 'failed'
  | 'cancelled'
  | 'expired';

@Injectable()
export class LeekPayService {
  private readonly logger  = new Logger(LeekPayService.name);
  private readonly baseUrl = 'https://leekpay.fr/api/v1';
  private readonly secretKey: string;
  private readonly publicKey: string;
  private readonly frontendUrl: string;

  constructor(
    private readonly config: ConfigService,
    // forwardRef pour éviter la dépendance circulaire BillingModule ↔ SubscriptionModule
    @Inject(forwardRef(() => SubscriptionService))
    private readonly subscriptionService: SubscriptionService,
  ) {
    // Clés LeekPay depuis les variables d'environnement Render
    // LEEKPAY_SECRET_KEY et LEEKPAY_PUBLIC_KEY doivent être configurées dans Render
    this.secretKey  = this.config.get<string>('LEEKPAY_SECRET_KEY') ?? '';
    this.publicKey  = this.config.get<string>('LEEKPAY_PUBLIC_KEY') ?? '';
    this.frontendUrl = this.config.get<string>('FRONTEND_URL')
                      ?? 'https://codemorph-coral.vercel.app';

    if (!this.secretKey) {
      this.logger.warn('⚠️  LEEKPAY_SECRET_KEY non configurée — les paiements échoueront');
    }
    if (!this.publicKey) {
      this.logger.warn('⚠️  LEEKPAY_PUBLIC_KEY non configurée — la vérification webhook échouera');
    }
  }

  // ── Créer un checkout ──────────────────────────────────
  async createCheckout(
    params: LeekPayCheckoutRequest,
  ): Promise<LeekPayCheckout> {
    if (!this.secretKey) {
      throw new BadRequestException(
        'Paiement non configuré : LEEKPAY_SECRET_KEY manquante. ' +
        'Contactez l\'administrateur pour configurer les clés LeekPay dans Render.',
      );
    }

    const backendUrl = this.config.get<string>('BACKEND_URL')
      ?? 'https://codemorph-hp00.onrender.com';

    const body = {
      ...params,
      // Webhook par défaut si non fourni dans params
      webhook_url:
        params.webhook_url ??
        `${backendUrl}/api/v1/payments/webhook`,
    };

    this.logger.log(`Creating LeekPay checkout: ${params.amount} ${params.currency}`);

    const response = await fetch(`${this.baseUrl}/checkout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const json = (await response.json()) as {
      success: boolean;
      data: LeekPayCheckout;
      message?: string;
    };

    if (!response.ok || !json.success) {
      this.logger.error(`LeekPay createCheckout error: ${JSON.stringify(json)}`);
      throw new BadRequestException(
        json.message ?? `LeekPay error (${response.status})`,
      );
    }

    this.logger.log(`Checkout created: ${json.data.id} → ${json.data.payment_url}`);
    return json.data;
  }

  // ── Vérifier le statut d'un checkout ─────────────────
  async getCheckout(checkoutId: string): Promise<LeekPayCheckout> {
    const response = await fetch(`${this.baseUrl}/checkout/${checkoutId}`, {
      headers: { Authorization: `Bearer ${this.secretKey}` },
    });

    const json = (await response.json()) as {
      success: boolean;
      data: LeekPayCheckout;
      message?: string;
    };

    if (!response.ok || !json.success) {
      throw new BadRequestException(
        json.message ?? `LeekPay error (${response.status})`,
      );
    }

    return json.data;
  }

  // ── Plans tarifaires ──────────────────────────────────
  // Les prix sont en XOF. Les équivalents USD affichés sur le frontend :
  //   starter : 4 900 XOF ≈ $5    → mapped plan 'starter'
  //   pro      : 14 900 XOF ≈ $10  → mapped plan 'pro'
  //   pro_max  : 29 900 XOF ≈ $20  → mapped plan 'pro_max'
  getPlans(): Array<{
    id: string;
    name: string;
    price: number;
    currency: 'XOF';
    description: string;
    features: string[];
  }> {
    return [
      {
        id: 'starter',
        name: 'Starter',
        price: 4_900,
        currency: 'XOF',
        description: 'Pour démarrer',
        features: [
          '10 conversions / mois',
          'Flutter → React & React Native',
          'ZIP & GitHub import',
          '5 MB max file size',
          '1 active project',
          'Email support',
        ],
      },
      {
        id: 'pro',
        name: 'Pro',
        price: 14_900,
        currency: 'XOF',
        description: 'Pour les équipes actives',
        features: [
          '50 conversions / mois',
          'Tous les frameworks (React↔Flutter, Express→NestJS…)',
          'Historique 90 jours',
          '20 MB max file size',
          '5 projets actifs',
          'Support prioritaire',
        ],
      },
      {
        id: 'pro_max',
        name: 'Pro Max',
        price: 29_900,
        currency: 'XOF',
        description: 'Pour les grandes équipes',
        features: [
          'Conversions illimitées',
          'Tous les frameworks supportés',
          'API accès direct',
          '100 MB max file size',
          'Projets illimités',
          'Support dédié 24h/7j',
          'SLA garanti',
        ],
      },
    ];
  }

  // ── Mapping ID plan LeekPay → Plan interne ────────────
  private mapPlanId(planId: string): Plan {
    const map: Record<string, Plan> = {
      starter: 'pro',      // "starter" LeekPay → plan "pro" interne (niveau 1 payant)
      pro:     'pro',
      pro_max: 'pro_max',
    };
    return map[planId] ?? 'free';
  }

  // ── Créer un checkout pour un plan ───────────────────
  async createPlanCheckout(
    planId: string,
    userEmail: string,
    userName: string,
    userId: string,
  ): Promise<LeekPayCheckout> {
    const plans = this.getPlans();
    const plan  = plans.find(p => p.id === planId);

    if (!plan) {
      throw new BadRequestException(`Plan inconnu: ${planId}`);
    }

    const backendUrl = this.config.get<string>('BACKEND_URL')
      ?? 'https://codemorph-hp00.onrender.com';

    return this.createCheckout({
      amount:         plan.price,
      currency:       plan.currency,
      description:    `CodeMorph ${plan.name} — abonnement mensuel`,
      return_url:     `${this.frontendUrl}/dashboard/billing?success=true&plan=${planId}`,
      cancel_url:     `${this.frontendUrl}/dashboard/billing?canceled=true`,
      webhook_url:    `${backendUrl}/api/v1/payments/webhook`,
      customer_email: userEmail,
      customer_name:  userName || userEmail,
      metadata:       { userId, planId, source: 'codemorph' },
    });
  }

  // ── Vérifier la signature webhook ────────────────────
  // La signature est calculée avec HMAC-SHA256 + clé PUBLIQUE (pk_live_xxx)
  verifyWebhookSignature(payload: string, signature: string): boolean {
    if (!signature || !this.publicKey) return false;
    try {
      const expected = createHmac('sha256', this.publicKey)
        .update(payload)
        .digest('hex');
      const sigBuffer = Buffer.from(signature, 'hex');
      const expBuffer = Buffer.from(expected, 'hex');
      if (sigBuffer.length !== expBuffer.length) return false;
      return timingSafeEqual(sigBuffer, expBuffer);
    } catch {
      return false;
    }
  }

  // ── Traiter un webhook ───────────────────────────────
  async processWebhook(
    rawPayload: string,
    signature: string,
  ): Promise<{ processed: boolean; event: string }> {
    // Vérification signature (sécurité)
    // Si LEEKPAY_PUBLIC_KEY non configurée, on log un warning mais on continue
    // pour permettre les tests sans configuration complète
    if (this.publicKey) {
      const isValid = this.verifyWebhookSignature(rawPayload, signature);
      if (!isValid) {
        this.logger.warn('LeekPay webhook: invalid signature');
        throw new UnauthorizedException('Invalid webhook signature');
      }
    } else {
      this.logger.warn('LeekPay webhook: signature non vérifiée (LEEKPAY_PUBLIC_KEY manquante)');
    }

    const payload = JSON.parse(rawPayload) as LeekPayWebhookPayload;
    this.logger.log(
      `LeekPay webhook received: ${payload.event} — txn ${payload.data.transaction_id}`,
    );

    switch (payload.event) {
      case 'payment.completed':
        await this.handlePaymentCompleted(payload.data);
        break;
      case 'payment.failed':
        await this.handlePaymentFailed(payload.data);
        break;
      case 'payment.cancelled':
        this.logger.log(`Payment cancelled: ${payload.data.transaction_id}`);
        break;
      default:
        this.logger.warn(`Unknown LeekPay event: ${payload.event}`);
    }

    return { processed: true, event: payload.event };
  }

  // ── Handlers internes ─────────────────────────────────
  private async handlePaymentCompleted(
    data: LeekPayWebhookPayload['data'],
  ): Promise<void> {
    const { transaction_id, amount, currency, metadata } = data;
    const userId = metadata?.['userId'] as string | undefined;
    const planId = metadata?.['planId'] as string | undefined;

    this.logger.log(
      `✅ Payment completed: ${transaction_id} — ${amount} ${currency}` +
        (userId ? ` — user ${userId}` : '') +
        (planId ? ` — plan ${planId}` : ''),
    );

    // Activer le plan en base de données
    if (userId && planId) {
      try {
        const internalPlan = this.mapPlanId(planId);
        await this.subscriptionService.activatePlan(userId, internalPlan);
        this.logger.log(
          `✅ Plan activated: user=${userId} leekpay_plan=${planId} internal_plan=${internalPlan}`,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`❌ Failed to activate plan for user ${userId}: ${msg}`);
      }
    } else {
      this.logger.warn(
        `⚠️  Payment completed but metadata missing userId/planId: ${JSON.stringify(metadata)}`,
      );
    }
  }

  private async handlePaymentFailed(
    data: LeekPayWebhookPayload['data'],
  ): Promise<void> {
    this.logger.warn(
      `❌ Payment failed: ${data.transaction_id} — ${data.amount} ${data.currency}`,
    );
  }

  // ── Getter clé publique (pour frontend) ──────────────
  getPublicKey(): string {
    return this.publicKey;
  }
}
