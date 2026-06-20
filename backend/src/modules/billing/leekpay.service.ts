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
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

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

  constructor(private readonly config: ConfigService) {
    // Clés LeekPay depuis les variables d'environnement Render
    // LEEKPAY_SECRET_KEY et LEEKPAY_PUBLIC_KEY doivent être configurées dans Render
    this.secretKey  = this.config.get<string>('LEEKPAY_SECRET_KEY') ?? '';
    this.publicKey  = this.config.get<string>('LEEKPAY_PUBLIC_KEY') ?? '';
    this.frontendUrl = this.config.get<string>('FRONTEND_URL')
                      ?? 'https://codemorph-coral.vercel.app';
  }

  // ── Créer un checkout ──────────────────────────────────
  async createCheckout(
    params: LeekPayCheckoutRequest,
  ): Promise<LeekPayCheckout> {
    const body = {
      ...params,
      // Webhook par défaut si non fourni
      webhook_url:
        params.webhook_url ??
        `${this.config.get<string>('BACKEND_URL') ?? 'https://codemorph-hp00.onrender.com'}/api/v1/payments/webhook`,
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

  // ── Plans tarifaires en XOF ───────────────────────────
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
          'Langages principaux (Python, JS, TS)',
          'Support email',
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
          'Tous les langages supportés',
          'Historique 90 jours',
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
          'Tous les langages supportés',
          'API accès direct',
          'Support dédié 24h/7j',
          'SLA garanti',
        ],
      },
    ];
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

    return this.createCheckout({
      amount:         plan.price,
      currency:       plan.currency,
      description:    `CodeMorph ${plan.name} — abonnement mensuel`,
      return_url:     `${this.frontendUrl}/dashboard/billing?success=true&plan=${planId}`,
      cancel_url:     `${this.frontendUrl}/dashboard/billing?canceled=true`,
      customer_email: userEmail,
      customer_name:  userName,
      metadata:       { userId, planId, source: 'codemorph' },
    });
  }

  // ── Vérifier la signature webhook ────────────────────
  // La signature est calculée avec HMAC-SHA256 + clé PUBLIQUE
  verifyWebhookSignature(payload: string, signature: string): boolean {
    if (!signature) return false;
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
    const isValid = this.verifyWebhookSignature(rawPayload, signature);
    if (!isValid) {
      this.logger.warn('LeekPay webhook: invalid signature');
      throw new UnauthorizedException('Invalid webhook signature');
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

    // TODO: mettre à jour le plan utilisateur en base de données
    // await this.usersService.update(userId, { plan: planId });
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
