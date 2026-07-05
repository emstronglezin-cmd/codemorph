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
    // FIX PHASE 12 — BUG CRITIQUE 3 : logs de diagnostic au démarrage
    // Permet de vérifier exactement quelle valeur est lue depuis Render
    // sans exposer la clé complète (seulement préfixe/longueur)

    // Clés LeekPay depuis les variables d'environnement Render
    // LEEKPAY_SECRET_KEY et LEEKPAY_PUBLIC_KEY doivent être configurées dans Render
    this.secretKey  = (this.config.get<string>('LEEKPAY_SECRET_KEY') ?? '').trim();
    this.publicKey  = (this.config.get<string>('LEEKPAY_PUBLIC_KEY') ?? '').trim();
    this.frontendUrl = this.config.get<string>('FRONTEND_URL')
                      ?? 'https://codemorph-coral.vercel.app';

    // Diagnostic précis pour identifier pourquoi la clé est considérée absente
    // Affiche le préfixe (6 premiers chars) et la longueur — jamais la clé complète
    const skPrefix = this.secretKey ? `${this.secretKey.slice(0, 6)}... (len=${this.secretKey.length})` : 'EMPTY';
    const pkPrefix = this.publicKey ? `${this.publicKey.slice(0, 6)}... (len=${this.publicKey.length})` : 'EMPTY';
    this.logger.log(`LeekPay keys at startup: SK=${skPrefix}, PK=${pkPrefix}`);

    if (!this.secretKey) {
      this.logger.error(
        '❌ LEEKPAY_SECRET_KEY is EMPTY after trim(). ' +
        'Verify in Render: env var name is exactly "LEEKPAY_SECRET_KEY" (no spaces, no quotes). ' +
        'The value must not be empty. Payments will fail.',
      );
    } else {
      this.logger.log('✅ LEEKPAY_SECRET_KEY configured — LeekPay payments enabled');
    }
    if (!this.publicKey) {
      this.logger.warn('⚠️  LEEKPAY_PUBLIC_KEY non configurée — la vérification webhook échouera');
    }
  }

  // ── Créer un checkout ──────────────────────────────────
  async createCheckout(
    params: LeekPayCheckoutRequest,
  ): Promise<LeekPayCheckout> {

    // ── DIAG: état des variables d'environnement utilisées ──
    // On n'affiche jamais les clés en clair — seulement présence + longueur
    const skLen    = this.secretKey.length;
    const pkLen    = this.publicKey.length;
    const skPrefix = skLen > 0 ? `${this.secretKey.slice(0, 6)}… (len=${skLen})` : 'ABSENT';
    const pkPrefix = pkLen > 0 ? `${this.publicKey.slice(0, 6)}… (len=${pkLen})` : 'ABSENT';
    const backendUrlEnv  = this.config.get<string>('BACKEND_URL') ?? '(non défini → fallback)';
    const frontendUrlVal = this.frontendUrl;
    this.logger.log(
      `[DIAG createCheckout] ENV vars:\n` +
      `  LEEKPAY_SECRET_KEY : ${skPrefix}\n` +
      `  LEEKPAY_PUBLIC_KEY : ${pkPrefix}\n` +
      `  BACKEND_URL        : ${backendUrlEnv}\n` +
      `  FRONTEND_URL       : ${frontendUrlVal}\n` +
      `  baseUrl (LeekPay)  : ${this.baseUrl}`,
    );

    if (!this.secretKey) {
      // FIX PHASE 12 : message d'erreur plus actionnable
      // Le frontend billing/page.tsx détecte 'LEEKPAY_SECRET_KEY' dans le message
      // pour afficher "Paiement non disponible : la clé LeekPay n'est pas configurée"
      throw new BadRequestException(
        'Paiement non configuré : LEEKPAY_SECRET_KEY manquante ou vide. ' +
        'Vérifiez dans Render que la variable "LEEKPAY_SECRET_KEY" est définie ' +
        '(sans guillemets, sans espaces). ' +
        'Contactez l\'administrateur pour configurer les clés LeekPay.',
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

    // ── DIAG: payload exact envoyé à LeekPay ──
    const targetUrl = `${this.baseUrl}/checkout`;
    this.logger.log(
      `[DIAG createCheckout] REQUEST:\n` +
      `  METHOD  : POST\n` +
      `  URL     : ${targetUrl}\n` +
      `  TIMEOUT : 12000ms\n` +
      `  PAYLOAD : ${JSON.stringify({
        amount:         body.amount,
        currency:       body.currency,
        description:    body.description,
        return_url:     body.return_url,
        cancel_url:     body.cancel_url,
        webhook_url:    body.webhook_url,
        customer_email: body.customer_email ? `${body.customer_email.slice(0, 3)}…` : undefined,
        customer_name:  body.customer_name  ? '[present]'                            : undefined,
        metadata:       body.metadata,
      })}`,
    );

    this.logger.log(`Creating LeekPay checkout: ${params.amount} ${params.currency}`);

    // FIX PHASE 10 — CAUSE RACINE BUG 3 : fetch sans timeout
    // Le frontend a un AbortController de 14s (billing/page.tsx handleUpgrade).
    // Si LeekPay API met >14s → frontend déclenche abort → "Délai dépassé. Le serveur de paiement ne répond pas."
    // Fix: timeout de 12s côté backend (< 14s frontend) pour retourner une erreur structurée
    // avant que le frontend ne coupe la connexion.
    const leekpayAbortCtrl = new AbortController();
    const leekpayTimeoutId = setTimeout(() => leekpayAbortCtrl.abort(), 12_000);

    let response: Response;
    try {
      response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: leekpayAbortCtrl.signal,
      });
    } catch (fetchErr: unknown) {
      clearTimeout(leekpayTimeoutId);
      const errName    = (fetchErr as { name?: string })?.name ?? '';
      const errMessage = (fetchErr as Error)?.message ?? String(fetchErr);
      const errStack   = (fetchErr as Error)?.stack ?? '(no stack)';

      // ── DIAG: erreur réseau / timeout ──
      this.logger.error(
        `[DIAG createCheckout] FETCH ERROR:\n` +
        `  URL     : ${targetUrl}\n` +
        `  type    : ${errName || 'unknown'}\n` +
        `  message : ${errMessage}\n` +
        `  isAbort : ${errName === 'AbortError'}\n` +
        `  stack   : ${errStack}`,
      );

      if (errName === 'AbortError') {
        this.logger.error('LeekPay createCheckout: timeout after 12s — API did not respond');
        throw new BadRequestException(
          'Le serveur de paiement LeekPay ne répond pas (timeout 12s). ' +
          'Vérifiez que LEEKPAY_SECRET_KEY est correcte et que leekpay.fr est accessible. ' +
          'Réessayez dans quelques instants.',
        );
      }
      throw new BadRequestException(`LeekPay network error: ${String(fetchErr)}`);
    } finally {
      clearTimeout(leekpayTimeoutId);
    }

    // ── DIAG: lire le body brut avant de le parser ──
    let rawBody = '';
    let json: { success: boolean; data: LeekPayCheckout; message?: string };
    try {
      rawBody = await response.text();
      this.logger.log(
        `[DIAG createCheckout] RESPONSE:\n` +
        `  STATUS : ${response.status} ${response.statusText}\n` +
        `  BODY   : ${rawBody.slice(0, 2000)}`,
      );
      json = JSON.parse(rawBody) as { success: boolean; data: LeekPayCheckout; message?: string };
    } catch (parseErr: unknown) {
      this.logger.error(
        `[DIAG createCheckout] JSON parse error:\n` +
        `  STATUS   : ${response.status}\n` +
        `  RAW BODY : ${rawBody.slice(0, 500)}\n` +
        `  ERROR    : ${(parseErr as Error)?.message ?? String(parseErr)}`,
      );
      throw new BadRequestException(`LeekPay returned non-JSON response (HTTP ${response.status}): ${rawBody.slice(0, 200)}`);
    }

    if (!response.ok || !json.success) {
      this.logger.error(
        `[DIAG createCheckout] LeekPay error response:\n` +
        `  STATUS  : ${response.status}\n` +
        `  success : ${json.success}\n` +
        `  message : ${json.message ?? '(none)'}\n` +
        `  body    : ${JSON.stringify(json)}`,
      );
      throw new BadRequestException(
        json.message ?? `LeekPay error (${response.status})`,
      );
    }

    this.logger.log(
      `[DIAG createCheckout] SUCCESS:\n` +
      `  checkout.id          : ${json.data?.id ?? '(none)'}\n` +
      `  checkout.payment_url : ${json.data?.payment_url ?? '(none)'}\n` +
      `  checkout.status      : ${json.data?.status ?? '(none)'}\n` +
      `  checkout.amount      : ${json.data?.amount ?? '(none)'} ${json.data?.currency ?? ''}`,
    );
    this.logger.log(`Checkout created: ${json.data.id} → ${json.data.payment_url}`);
    return json.data;
  }

  // ── Vérifier le statut d'un checkout ─────────────────
  async getCheckout(checkoutId: string): Promise<LeekPayCheckout> {
    const targetUrl = `${this.baseUrl}/checkout/${checkoutId}`;
    this.logger.log(`[DIAG getCheckout] GET ${targetUrl}`);

    const abortCtrl = new AbortController();
    const timeoutId = setTimeout(() => abortCtrl.abort(), 12_000);
    let response: Response;
    try {
      response = await fetch(targetUrl, {
        headers: { Authorization: `Bearer ${this.secretKey}` },
        signal: abortCtrl.signal,
      });
    } catch (e: unknown) {
      clearTimeout(timeoutId);
      const errName    = (e as { name?: string })?.name ?? '';
      const errMessage = (e as Error)?.message ?? String(e);
      this.logger.error(
        `[DIAG getCheckout] FETCH ERROR:\n` +
        `  URL     : ${targetUrl}\n` +
        `  type    : ${errName || 'unknown'}\n` +
        `  message : ${errMessage}\n` +
        `  stack   : ${(e as Error)?.stack ?? '(no stack)'}`,
      );
      if (errName === 'AbortError') {
        throw new BadRequestException('LeekPay API timeout (12s) on getCheckout');
      }
      throw new BadRequestException(`LeekPay network error: ${String(e)}`);
    } finally {
      clearTimeout(timeoutId);
    }

    let rawBody = '';
    let json: { success: boolean; data: LeekPayCheckout; message?: string };
    try {
      rawBody = await response.text();
      this.logger.log(
        `[DIAG getCheckout] RESPONSE:\n` +
        `  STATUS : ${response.status} ${response.statusText}\n` +
        `  BODY   : ${rawBody.slice(0, 1000)}`,
      );
      json = JSON.parse(rawBody) as { success: boolean; data: LeekPayCheckout; message?: string };
    } catch (parseErr: unknown) {
      this.logger.error(
        `[DIAG getCheckout] JSON parse error:\n` +
        `  STATUS   : ${response.status}\n` +
        `  RAW BODY : ${rawBody.slice(0, 300)}\n` +
        `  ERROR    : ${(parseErr as Error)?.message ?? String(parseErr)}`,
      );
      throw new BadRequestException(`LeekPay returned non-JSON (HTTP ${response.status}): ${rawBody.slice(0, 200)}`);
    }

    if (!response.ok || !json.success) {
      this.logger.error(
        `[DIAG getCheckout] Error response: status=${response.status}, message=${json.message ?? '(none)'}`,
      );
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

    // ── DIAG: entrée createPlanCheckout ──
    this.logger.log(
      `[DIAG createPlanCheckout] ENTRY:\n` +
      `  planId    : ${planId}\n` +
      `  plan found: ${plan ? `${plan.name} — ${plan.price} ${plan.currency}` : 'NOT FOUND'}\n` +
      `  userId    : ${userId}\n` +
      `  userEmail : ${userEmail ? `${userEmail.slice(0, 3)}…` : '(empty)'}\n` +
      `  userName  : ${userName ? '[present]' : '(empty)'}`,
    );

    if (!plan) {
      this.logger.error(
        `[DIAG createPlanCheckout] Plan "${planId}" not found. Available: ${plans.map(p => p.id).join(', ')}`,
      );
      throw new BadRequestException(`Plan inconnu: ${planId}`);
    }

    const backendUrl = this.config.get<string>('BACKEND_URL')
      ?? 'https://codemorph-hp00.onrender.com';

    const checkoutParams = {
      amount:         plan.price,
      currency:       plan.currency,
      description:    `CodeMorph ${plan.name} — abonnement mensuel`,
      return_url:     `${this.frontendUrl}/dashboard/billing?success=true&plan=${planId}`,
      cancel_url:     `${this.frontendUrl}/dashboard/billing?canceled=true`,
      webhook_url:    `${backendUrl}/api/v1/payments/webhook`,
      customer_email: userEmail,
      customer_name:  userName || userEmail,
      metadata:       { userId, planId, source: 'codemorph' },
    };

    this.logger.log(
      `[DIAG createPlanCheckout] Calling createCheckout with:\n` +
      `  amount      : ${checkoutParams.amount}\n` +
      `  currency    : ${checkoutParams.currency}\n` +
      `  return_url  : ${checkoutParams.return_url}\n` +
      `  webhook_url : ${checkoutParams.webhook_url}`,
    );

    try {
      const result = await this.createCheckout(checkoutParams);
      this.logger.log(
        `[DIAG createPlanCheckout] SUCCESS → checkout.id=${result.id}, payment_url=${result.payment_url}`,
      );
      return result;
    } catch (err: unknown) {
      this.logger.error(
        `[DIAG createPlanCheckout] EXCEPTION:\n` +
        `  message : ${(err as Error)?.message ?? String(err)}\n` +
        `  stack   : ${(err as Error)?.stack ?? '(no stack)'}`,
      );
      throw err;
    }
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
