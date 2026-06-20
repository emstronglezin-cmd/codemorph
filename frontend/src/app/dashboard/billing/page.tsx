'use client';
// ============================================================
// CodeMorph — Billing Page avec intégration LeekPay
// Widget LeekPay JS + API REST backend
// Devise : XOF (Franc CFA)
// ============================================================
import type React from 'react';
import { useState, useEffect } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
// La clé publique est récupérée depuis l'API backend (GET /payments/config)
// Elle est définie dans les variables d'environnement Render (LEEKPAY_PUBLIC_KEY)
let LEEKPAY_PUBLIC_KEY = process.env.NEXT_PUBLIC_LEEKPAY_KEY ?? '';

// ── Types ───────────────────────────────────────────────────
interface Plan {
  id: string;
  name: string;
  price: number;
  currency: string;
  description: string;
  features: string[];
}

// ── Helpers ─────────────────────────────────────────────────
function formatXOF(amount: number): string {
  return new Intl.NumberFormat('fr-FR').format(amount) + ' CFA';
}

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return (
    localStorage.getItem('cm_access_token') ??
    (window as Window & { __CODEMORPH_ACCESS_TOKEN__?: string }).__CODEMORPH_ACCESS_TOKEN__ ??
    null
  );
}

// ── Composant carte plan ─────────────────────────────────────
function PlanCard({
  plan,
  current,
  onSelect,
  loading,
}: {
  plan: Plan;
  current: boolean;
  onSelect: (planId: string) => void;
  loading: boolean;
}) {
  const isPro    = plan.id === 'pro';
  const isProMax = plan.id === 'pro_max';

  return (
    <div
      className={`relative rounded-2xl border p-6 flex flex-col gap-4 transition-all ${
        isPro
          ? 'border-violet-500 bg-gradient-to-b from-violet-950/40 to-slate-900 shadow-lg shadow-violet-500/10'
          : 'border-slate-700 bg-slate-800/50 hover:border-slate-600'
      }`}
    >
      {isPro && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
          <span className="bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-xs font-bold px-3 py-1 rounded-full">
            POPULAIRE
          </span>
        </div>
      )}

      <div>
        <h3 className="text-lg font-bold text-white">{plan.name}</h3>
        <p className="text-sm text-slate-400 mt-0.5">{plan.description}</p>
      </div>

      <div className="flex items-baseline gap-1">
        <span className="text-3xl font-extrabold text-white">
          {formatXOF(plan.price)}
        </span>
        <span className="text-slate-400 text-sm">/mois</span>
      </div>

      <ul className="space-y-2 flex-1">
        {plan.features.map((feature, i) => (
          <li key={i} className="flex items-start gap-2 text-sm text-slate-300">
            <svg className="w-4 h-4 text-violet-400 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {feature}
          </li>
        ))}
      </ul>

      {current ? (
        <div className="w-full py-2.5 rounded-xl text-sm font-semibold text-center border border-slate-600 text-slate-400 bg-slate-800">
          Plan actuel
        </div>
      ) : (
        <button
          onClick={() => onSelect(plan.id)}
          disabled={loading}
          className={`w-full py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-50 ${
            isPro || isProMax
              ? 'bg-gradient-to-r from-indigo-600 to-violet-600 text-white hover:opacity-90 shadow-md'
              : 'border border-violet-500 text-violet-400 hover:bg-violet-500/10'
          }`}
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Traitement…
            </span>
          ) : (
            `Choisir ${plan.name}`
          )}
        </button>
      )}
    </div>
  );
}

// ── LeekPay Checkout via widget JS ──────────────────────────
function launchLeekPayWidget(params: {
  amount: number;
  currency: string;
  description: string;
  email?: string;
  onSuccess: (data: { payment_id: string; amount: number; currency: string }) => void;
  onCancel: () => void;
}) {
  // Charger le script LeekPay si pas encore chargé
  const scriptId = 'leekpay-script';
  const existing = document.getElementById(scriptId);

  function launchCheckout() {
    const LeekPay = (window as unknown as { LeekPay?: {
      checkout: (opts: unknown) => void;
      configure: (opts: unknown) => void;
    } }).LeekPay;

    if (!LeekPay) {
      console.error('LeekPay script not loaded');
      return;
    }

    LeekPay.checkout({
      amount:        params.amount,
      currency:      params.currency,
      apiKey:        LEEKPAY_PUBLIC_KEY,
      description:   params.description,
      customerEmail: params.email ?? '',
      onSuccess: params.onSuccess,
      onCancel:  params.onCancel,
    });
  }

  if (!existing) {
    const script = document.createElement('script');
    script.id  = scriptId;
    script.src = 'https://leekpay.fr/js/leekpay.js';
    script.async = true;
    script.onload = launchCheckout;
    document.head.appendChild(script);
  } else {
    launchCheckout();
  }
}

// ── Page principale ──────────────────────────────────────────
export default function BillingPage(): React.JSX.Element {
  const [plans,      setPlans]     = useState<Plan[]>([]);
  const [loading,    setLoading]   = useState(false);
  const [planLoad,   setPlanLoad]  = useState(true);
  const [error,      setError]     = useState('');
  const [success,    setSuccess]   = useState('');
  const [currentPlan, setCurrentPlan] = useState('free');

  // Récupérer les plans et la config (clé publique) depuis le backend
  useEffect(() => {
    // Charger la clé publique LeekPay depuis l'API
    fetch(`${API_URL}/payments/config`)
      .then(r => r.json() as Promise<{ publicKey: string; currency: string }>)
      .then(data => { if (data.publicKey) LEEKPAY_PUBLIC_KEY = data.publicKey; })
      .catch(() => { /* Utiliser la clé par défaut de l'env */ });

    fetch(`${API_URL}/payments/plans`)
      .then(r => r.json() as Promise<{ plans: Plan[] }>)
      .then(data => {
        setPlans(data.plans ?? []);
        setPlanLoad(false);
      })
      .catch(() => {
        // Plans par défaut si API inaccessible
        setPlans([
          {
            id: 'starter', name: 'Starter', price: 4_900, currency: 'XOF',
            description: 'Pour démarrer',
            features: ['10 conversions / mois', 'Langages principaux', 'Support email'],
          },
          {
            id: 'pro', name: 'Pro', price: 14_900, currency: 'XOF',
            description: 'Pour les équipes actives',
            features: ['50 conversions / mois', 'Tous les langages', 'Historique 90 jours', 'Support prioritaire'],
          },
          {
            id: 'pro_max', name: 'Pro Max', price: 29_900, currency: 'XOF',
            description: 'Pour les grandes équipes',
            features: ['Conversions illimitées', 'Tous les langages', 'API directe', 'Support dédié 24h/7j'],
          },
        ]);
        setPlanLoad(false);
      });

    // Récupérer le plan actuel depuis l'URL (retour après paiement)
    const params = new URLSearchParams(window.location.search);
    if (params.get('success') === 'true') {
      const plan = params.get('plan') ?? '';
      setSuccess(`🎉 Paiement réussi ! Votre plan ${plan} est maintenant actif.`);
      setCurrentPlan(plan);
      // Nettoyer l'URL
      window.history.replaceState({}, '', '/dashboard/billing');
    }
    if (params.get('canceled') === 'true') {
      setError('Paiement annulé. Vous pouvez réessayer à tout moment.');
      window.history.replaceState({}, '', '/dashboard/billing');
    }
  }, []);

  // Lancer le paiement via l'API backend + widget LeekPay
  const handleSelectPlan = async (planId: string) => {
    setError('');
    setSuccess('');
    setLoading(true);

    const token = getToken();

    try {
      if (token) {
        // Option 1 : Checkout via API backend (recommandé — sécurisé)
        const res = await fetch(`${API_URL}/payments/checkout`, {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ planId }),
        });

        const data = await res.json() as {
          payment_url?: string;
          checkoutId?: string;
          amount?: number;
          currency?: string;
          error?: string;
          message?: string;
        };

        if (!res.ok) {
          throw new Error(data.message ?? data.error ?? `Erreur ${res.status}`);
        }

        if (data.payment_url) {
          // Redirection vers la page de paiement LeekPay
          window.location.href = data.payment_url;
          return;
        }
      }

      // Option 2 : Widget JS LeekPay (fallback si pas de token ou pas de payment_url)
      const plan = plans.find(p => p.id === planId);
      if (!plan) throw new Error('Plan introuvable');

      launchLeekPayWidget({
        amount:      plan.price,
        currency:    plan.currency,
        description: `CodeMorph ${plan.name} — abonnement mensuel`,
        onSuccess: (data) => {
          setSuccess(`🎉 Paiement réussi ! Référence : ${data.payment_id}`);
          setCurrentPlan(planId);
          setLoading(false);
        },
        onCancel: () => {
          setError('Paiement annulé.');
          setLoading(false);
        },
      });

    } catch (err: unknown) {
      setError((err as Error).message ?? 'Erreur lors du paiement');
      setLoading(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-8">

      {/* ── Header ──────────────────────────────────────── */}
      <div>
        <h1 className="text-2xl font-bold text-white">Abonnement & Paiement</h1>
        <p className="text-sm text-slate-400 mt-1">
          Choisissez le plan qui correspond à vos besoins. Paiement sécurisé par{' '}
          <span className="text-violet-400 font-medium">LeekPay</span> en XOF (Franc CFA).
        </p>
      </div>

      {/* ── Alertes ─────────────────────────────────────── */}
      {success && (
        <div className="rounded-xl bg-green-500/10 border border-green-500/30 px-4 py-3 text-sm text-green-400 flex items-start gap-2">
          <span className="mt-0.5">✅</span>
          <span>{success}</span>
        </div>
      )}
      {error && (
        <div className="rounded-xl bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm text-red-400 flex items-start gap-2">
          <span className="mt-0.5">⚠️</span>
          <span>{error}</span>
        </div>
      )}

      {/* ── Plans ───────────────────────────────────────── */}
      {planLoad ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-80 rounded-2xl bg-slate-800 animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {plans.map(plan => (
            <PlanCard
              key={plan.id}
              plan={plan}
              current={currentPlan === plan.id}
              onSelect={handleSelectPlan}
              loading={loading}
            />
          ))}
        </div>
      )}

      {/* ── Badges confiance ────────────────────────────── */}
      <div className="border border-slate-800 rounded-2xl p-6 flex flex-wrap items-center justify-center gap-6">
        <div className="flex items-center gap-2 text-slate-400 text-sm">
          <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          Paiement 100% sécurisé
        </div>
        <div className="flex items-center gap-2 text-slate-400 text-sm">
          <svg className="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
          </svg>
          Mobile Money & Carte bancaire
        </div>
        <div className="flex items-center gap-2 text-slate-400 text-sm">
          <svg className="w-5 h-5 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
          Annulation à tout moment
        </div>
        <div className="flex items-center gap-2 text-slate-400 text-sm">
          <svg className="w-5 h-5 text-violet-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
          </svg>
          Powered by LeekPay
        </div>
      </div>

      {/* ── FAQ rapide ──────────────────────────────────── */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-white">Questions fréquentes</h2>
        <div className="space-y-3">
          {[
            {
              q: 'Comment fonctionne le paiement ?',
              a: 'Après sélection de votre plan, vous êtes redirigé vers la page de paiement sécurisée LeekPay. Vous pouvez payer par Mobile Money ou carte bancaire.',
            },
            {
              q: 'Puis-je changer de plan ?',
              a: 'Oui, vous pouvez upgrader ou downgrader à tout moment. Le changement prend effet immédiatement.',
            },
            {
              q: 'Et si je ne suis pas satisfait ?',
              a: "Vous pouvez annuler votre abonnement à tout moment depuis cette page. Aucun remboursement n'est effectué pour les mois déjà payés.",
            },
          ].map(({ q, a }, i) => (
            <div key={i} className="rounded-xl bg-slate-800/50 border border-slate-700 p-4">
              <p className="font-medium text-white text-sm">{q}</p>
              <p className="text-slate-400 text-sm mt-1">{a}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
