'use client';
// ============================================================
// CodeMorph — Billing Page
// LeekPay REST: POST /api/v1/payments/checkout → { payment_url }
// Le client est redirigé vers payment_url (popup ou redirection)
// Retour : /dashboard/billing?success=true|canceled=true
// Plans : Starter $5 / Pro $10 / Pro Max $20
// ============================================================
import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Check, Zap, Crown, Sparkles, ArrowRight, CheckCircle, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { getAccessToken } from '@/lib/api/client';
import { useAuthStore } from '@/stores/auth.store';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

const PLANS = [
  {
    id:       'starter',
    name:     'Starter',
    price:    5,
    icon:     Zap,
    popular:  false,
    badge:    null as string | null,
    features: [
      '10 conversions / month',
      'Flutter → React & React Native',
      'ZIP & GitHub import',
      '5 MB max file size',
      '1 active project',
      'Email support',
    ],
    cta: 'Get started',
  },
  {
    id:       'pro',
    name:     'Pro',
    price:    10,
    icon:     Crown,
    popular:  true,
    badge:    'Most popular' as string | null,
    features: [
      '50 conversions / month',
      'All frameworks (React ↔ Flutter, NestJS)',
      'Priority queue',
      '25 MB max file size',
      '20 active projects',
      'Analytics dashboard',
      'Priority email support',
    ],
    cta: 'Upgrade to Pro',
  },
  {
    id:       'pro_max',
    name:     'Pro Max',
    price:    20,
    icon:     Sparkles,
    popular:  false,
    badge:    'Best value' as string | null,
    features: [
      'Unlimited conversions',
      'All frameworks + custom prompts',
      'Highest queue priority',
      '100 MB max file size',
      'Unlimited projects',
      'Team workspace',
      'IR document download',
      'Priority support (SLA 24h)',
    ],
    cta: 'Upgrade to Pro Max',
  },
];

// ── Inner page with search params ─────────────────────────
function BillingContent() {
  const searchParams  = useSearchParams();
  const { user }      = useAuthStore();
  const currentPlan   = (user?.plan as string) ?? 'free';

  const [loading, setLoading]   = useState<string | null>(null);
  const [loadStep, setLoadStep] = useState<string>('');
  const [error, setError]       = useState('');
  const [toastType, setToastType] = useState<'success' | 'canceled' | null>(null);

  // Gérer le retour depuis LeekPay
  useEffect(() => {
    if (searchParams.get('success') === 'true') {
      setToastType('success');
      setTimeout(() => setToastType(null), 6000);
    } else if (searchParams.get('canceled') === 'true') {
      setToastType('canceled');
      setTimeout(() => setToastType(null), 4000);
    }
  }, [searchParams]);

  const handleUpgrade = async (planId: string) => {
    if (loading) return;
    setLoading(planId);
    setLoadStep('Création du paiement…');
    setError('');

    // Timeout global 15 secondes
    const timeoutId = setTimeout(() => {
      setError('Délai dépassé (15s). Vérifiez votre connexion et réessayez.');
      setLoading(null);
      setLoadStep('');
    }, 15_000);

    try {
      const token = getAccessToken();
      if (!token) {
        clearTimeout(timeoutId);
        setError('Session expirée. Reconnectez-vous.');
        setLoading(null);
        setLoadStep('');
        return;
      }

      setLoadStep('Connexion au serveur de paiement…');

      const controller = new AbortController();
      const abortTimeout = setTimeout(() => controller.abort(), 14_000);

      let res: Response;
      try {
        res = await fetch(`${API_URL}/payments/checkout`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ planId }),
          signal: controller.signal,
        });
      } catch (fetchErr: unknown) {
        clearTimeout(abortTimeout);
        clearTimeout(timeoutId);
        const isAbort = fetchErr instanceof Error && fetchErr.name === 'AbortError';
        setError(isAbort
          ? 'Délai dépassé. Le serveur de paiement ne répond pas. Réessayez dans quelques instants.'
          : 'Erreur réseau. Vérifiez votre connexion et réessayez.'
        );
        setLoading(null);
        setLoadStep('');
        return;
      }
      clearTimeout(abortTimeout);

      const data = await res.json() as {
        data?: { payment_url?: string; checkoutUrl?: string; url?: string };
        payment_url?: string;
        checkoutUrl?: string;
        url?: string;
        message?: string;
        success?: boolean;
      };

      if (!res.ok) {
        clearTimeout(timeoutId);
        const msg = (data?.success === false ? data?.message : null) ?? data?.message ?? `Erreur ${res.status}`;
        if (msg.includes('Plan inconnu') || res.status === 400) {
          setError(`Plan "${planId}" non reconnu par le serveur.`);
        } else if (res.status === 401 || res.status === 403) {
          setError('Session expirée. Reconnectez-vous.');
        } else if (msg.includes('LEEKPAY') || msg.includes('non configuré') || msg.includes('manquante')) {
          setError(`Paiement non disponible : ${msg}`);
        } else {
          setError(`Erreur paiement : ${msg}`);
        }
        setLoading(null);
        setLoadStep('');
        return;
      }

      // Récupérer payment_url depuis n'importe quel alias
      const paymentUrl =
        data?.data?.payment_url ??
        data?.data?.checkoutUrl ??
        data?.data?.url ??
        data?.payment_url ??
        data?.checkoutUrl ??
        data?.url;

      if (!paymentUrl) {
        clearTimeout(timeoutId);
        setError('URL de paiement manquante dans la réponse. Vérifiez la configuration LeekPay sur Render.');
        setLoading(null);
        setLoadStep('');
        return;
      }

      // Afficher l'étape finale avant redirection
      clearTimeout(timeoutId);
      setLoadStep('Redirection vers LeekPay…');
      // Redirection vers la page de paiement LeekPay
      window.location.href = paymentUrl;
      // Note: loading reste true intentionnellement pendant la redirection

    } catch (err: unknown) {
      clearTimeout(timeoutId);
      const msg = err instanceof Error ? err.message : 'Erreur inconnue';
      setError(`Erreur : ${msg}`);
      setLoading(null);
      setLoadStep('');
    }
  };

  const isPlanActive = (planId: string): boolean => currentPlan === planId;

  const planOrder = ['free', 'starter', 'pro', 'pro_max'];
  const isPlanBelow = (planId: string): boolean =>
    planOrder.indexOf(currentPlan) > planOrder.indexOf(planId);

  return (
    <div className="min-h-full bg-background">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10">

        {/* Toast retour LeekPay */}
        {toastType === 'success' && (
          <div className="mb-6 flex items-center gap-3 rounded-xl border border-green-500/30 bg-green-500/10 px-5 py-4 text-sm text-green-400 shadow-lg">
            <CheckCircle className="h-5 w-5 shrink-0" />
            <div>
              <p className="font-semibold">Paiement confirmé !</p>
              <p className="text-xs opacity-80 mt-0.5">Votre plan sera mis à jour d'ici quelques instants.</p>
            </div>
          </div>
        )}
        {toastType === 'canceled' && (
          <div className="mb-6 flex items-center gap-3 rounded-xl border border-yellow-500/30 bg-yellow-500/10 px-5 py-4 text-sm text-yellow-400">
            <XCircle className="h-5 w-5 shrink-0" />
            <p>Paiement annulé. Vous pouvez réessayer quand vous voulez.</p>
          </div>
        )}

        {/* Header */}
        <div className="text-center mb-10">
          <h1 className="text-4xl font-bold tracking-tight mb-3">
            Simple, transparent pricing
          </h1>
          <p className="text-lg text-muted-foreground">
            Choose the plan that fits your workflow. Upgrade or cancel anytime.
          </p>
          {currentPlan !== 'free' && (
            <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-4 py-1.5 text-sm text-primary font-medium">
              <Check className="h-3.5 w-3.5" />
              Current plan: {PLANS.find(p => p.id === currentPlan)?.name ?? currentPlan}
            </div>
          )}
        </div>

        {/* Error banner */}
        {error && (
          <div className="mb-8 rounded-xl border border-destructive/20 bg-destructive/5 px-5 py-4 text-sm text-destructive">
            <p className="font-medium">Erreur de paiement</p>
            <p className="mt-1 opacity-80">{error}</p>
          </div>
        )}

        {/* Plans grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-start">
          {PLANS.map(plan => {
            const Icon    = plan.icon;
            const active  = isPlanActive(plan.id);
            const below   = isPlanBelow(plan.id);
            const isLoad  = loading === plan.id;

            return (
              <div
                key={plan.id}
                className={cn(
                  'relative flex flex-col rounded-2xl border p-7 transition-all duration-200',
                  plan.popular
                    ? 'border-primary/60 bg-gradient-to-b from-primary/5 to-card shadow-xl shadow-primary/10 md:scale-[1.02]'
                    : 'border-border bg-card hover:shadow-lg',
                )}
              >
                {/* Badge */}
                {plan.badge && (
                  <div className={cn(
                    'absolute -top-3.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full px-3.5 py-1 text-xs font-semibold shadow-sm',
                    plan.popular ? 'bg-primary text-white' : 'bg-violet-500 text-white',
                  )}>
                    {plan.badge}
                  </div>
                )}

                {/* Plan header */}
                <div className="flex items-center gap-3 mb-5">
                  <div className={cn(
                    'flex h-10 w-10 items-center justify-center rounded-xl',
                    plan.popular       ? 'bg-primary/15 text-primary' :
                    plan.id === 'pro_max' ? 'bg-violet-500/10 text-violet-500' :
                    'bg-surface-2 text-muted-foreground',
                  )}>
                    <Icon className="h-5 w-5" />
                  </div>
                  <h3 className="font-bold text-foreground text-lg">{plan.name}</h3>
                </div>

                {/* Price */}
                <div className="mb-6">
                  <div className="flex items-baseline gap-1">
                    <span className="text-5xl font-extrabold tracking-tight">${plan.price}</span>
                    <span className="text-sm text-muted-foreground font-medium">/mo</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">Billed monthly · Cancel anytime</p>
                </div>

                {/* Features */}
                <ul className="space-y-3 mb-8 flex-1">
                  {plan.features.map(f => (
                    <li key={f} className="flex items-start gap-2.5 text-sm">
                      <div className={cn(
                        'mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full',
                        plan.popular       ? 'bg-primary/15 text-primary' :
                        plan.id === 'pro_max' ? 'bg-violet-500/15 text-violet-500' :
                        'bg-surface-2 text-muted-foreground',
                      )}>
                        <Check className="h-3 w-3" strokeWidth={2.5} />
                      </div>
                      <span className="text-foreground/80 leading-snug">{f}</span>
                    </li>
                  ))}
                </ul>

                {/* CTA */}
                {active ? (
                  <div className="flex items-center justify-center gap-2 rounded-xl border border-border bg-surface-1 py-3 text-sm font-semibold text-muted-foreground">
                    <Check className="h-4 w-4" /> Current plan
                  </div>
                ) : below ? (
                  <div className="flex items-center justify-center rounded-xl border border-border bg-surface-1 py-3 text-sm font-medium text-muted-foreground/40 cursor-default">
                    Downgrade
                  </div>
                ) : (
                  <button
                    onClick={() => void handleUpgrade(plan.id)}
                    disabled={!!loading}
                    className={cn(
                      'flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold',
                      'transition-all duration-150 disabled:opacity-60 disabled:cursor-wait',
                      plan.popular
                        ? 'bg-primary text-white hover:bg-primary/90 shadow-md shadow-primary/25'
                        : plan.id === 'pro_max'
                        ? 'bg-violet-500 text-white hover:bg-violet-600 shadow-md shadow-violet-500/25'
                        : 'border border-border bg-surface-1 text-foreground hover:bg-surface-2',
                    )}
                  >
                    {isLoad ? (
                      <span className="flex items-center gap-2">
                        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="60" strokeDashoffset="20" />
                        </svg>
                        {loadStep || 'Traitement…'}
                      </span>
                    ) : (
                      <>{plan.cta}<ArrowRight className="h-4 w-4" /></>
                    )}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Free plan note */}
        <div className="mt-10 text-center">
          <p className="text-sm text-muted-foreground">
            Free plan includes <span className="font-medium text-foreground">3 conversions/month</span> (Flutter → React Native).
          </p>
        </div>

        {/* Trust row */}
        <div className="mt-8 flex flex-wrap items-center justify-center gap-6 border-t border-border pt-8">
          {['Secure payment via LeekPay', 'Cancel anytime', 'Instant access', 'No hidden fees'].map(item => (
            <div key={item} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Check className="h-3.5 w-3.5 text-primary" />
              {item}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Page export (Suspense pour useSearchParams) ────────────
export default function BillingPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    }>
      <BillingContent />
    </Suspense>
  );
}
