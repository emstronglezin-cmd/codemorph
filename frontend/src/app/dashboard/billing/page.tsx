'use client';
// ============================================================
// CodeMorph — Billing Page
// Plans en USD ($10/mois), paiement LeekPay
// Webhook : https://codemorph-hp00.onrender.com/api/v1/payments/webhook
// ============================================================
import type React from 'react';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Crown, Check, Zap, Shield, Star, Users, ArrowRight } from 'lucide-react';
import { getAccessToken } from '@/lib/api/client';
import { useAuthStore } from '@/stores/auth.store';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

// ── Plans fixes (USD) ────────────────────────────────────────
const PLANS = [
  {
    id:          'starter',
    name:        'Starter',
    price:       5,
    currency:    'USD',
    desc:        'Idéal pour démarrer',
    popular:     false,
    features: [
      '10 conversions / mois',
      'Langages principaux (Flutter, React, Express)',
      'Import GitHub & ZIP',
      'Support email',
    ],
    cta: 'Commencer avec Starter',
  },
  {
    id:          'pro',
    name:        'Pro',
    price:       10,
    currency:    'USD',
    desc:        'Pour les développeurs actifs',
    popular:     true,
    features: [
      '50 conversions / mois',
      'Tous les langages disponibles',
      'Historique des projets (90 jours)',
      'Support prioritaire',
      'Analytics avancées',
    ],
    cta: 'Passer au Pro',
  },
  {
    id:          'pro_max',
    name:        'Pro Max',
    price:       25,
    currency:    'USD',
    desc:        'Pour les équipes et entreprises',
    popular:     false,
    features: [
      'Conversions illimitées',
      'Tous les langages disponibles',
      'Gestion d\'équipe & permissions',
      'API directe (CI/CD)',
      'Support dédié 24h/7j',
      'SLA 99.9%',
    ],
    cta: 'Passer au Pro Max',
  },
];

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return (
    (window as Window & { __CODEMORPH_ACCESS_TOKEN__?: string }).__CODEMORPH_ACCESS_TOKEN__ ??
    localStorage.getItem('cm_access_token') ??
    null
  );
}

// ── Composant carte plan ─────────────────────────────────────
function PlanCard({
  plan, current, onSelect, loading,
}: {
  plan: typeof PLANS[0]; current: boolean; onSelect: (id: string) => void; loading: boolean;
}) {
  return (
    <div className={`relative flex flex-col rounded-2xl border p-6 gap-5 transition-all ${
      plan.popular
        ? 'border-violet-500 bg-gradient-to-b from-violet-950/50 to-slate-900 shadow-xl shadow-violet-500/10 scale-[1.02]'
        : 'border-slate-700/50 bg-slate-800/40 hover:border-slate-600 hover:bg-slate-800/60'
    }`}>
      {/* Badge populaire */}
      {plan.popular && (
        <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
          <span className="flex items-center gap-1 bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-xs font-bold px-4 py-1.5 rounded-full shadow-lg">
            <Star className="h-3 w-3" /> POPULAIRE
          </span>
        </div>
      )}

      {/* Nom + desc */}
      <div className="space-y-1">
        <h3 className="text-lg font-bold text-white">{plan.name}</h3>
        <p className="text-sm text-slate-400">{plan.desc}</p>
      </div>

      {/* Prix */}
      <div className="flex items-baseline gap-1">
        <span className="text-4xl font-extrabold text-white">${plan.price}</span>
        <span className="text-slate-400 text-sm">USD/mois</span>
      </div>

      {/* Features */}
      <ul className="space-y-2.5 flex-1">
        {plan.features.map((f, i) => (
          <li key={i} className="flex items-start gap-2.5 text-sm text-slate-300">
            <Check className="h-4 w-4 text-violet-400 mt-0.5 shrink-0" />
            {f}
          </li>
        ))}
      </ul>

      {/* CTA */}
      {current ? (
        <div className="w-full py-3 rounded-xl text-sm font-semibold text-center border border-slate-600 text-slate-400 bg-slate-800/50">
          ✓ Plan actuel
        </div>
      ) : (
        <button
          onClick={() => onSelect(plan.id)}
          disabled={loading}
          className={`w-full py-3 rounded-xl text-sm font-semibold transition-all disabled:opacity-50 flex items-center justify-center gap-2 ${
            plan.popular
              ? 'bg-gradient-to-r from-indigo-600 to-violet-600 text-white hover:opacity-90 shadow-lg shadow-violet-500/30'
              : 'border border-violet-500/50 text-violet-300 hover:bg-violet-500/10'
          }`}
        >
          {loading ? (
            <span className="flex items-center gap-2">
              <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Traitement…
            </span>
          ) : (
            <>{plan.cta} <ArrowRight className="h-4 w-4" /></>
          )}
        </button>
      )}
    </div>
  );
}

// ── Page principale ──────────────────────────────────────────
export default function BillingPage(): React.JSX.Element {
  const user        = useAuthStore(s => s.user);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState('');
  const [success,   setSuccess]   = useState('');
  const [currentPlan, setCurrentPlan] = useState(user?.plan ?? 'free');

  useEffect(() => {
    // Retour après paiement
    const params = new URLSearchParams(window.location.search);
    if (params.get('success') === 'true') {
      const plan = params.get('plan') ?? '';
      setSuccess(`🎉 Paiement réussi ! Votre plan ${plan} est maintenant actif.`);
      setCurrentPlan(plan);
      window.history.replaceState({}, '', '/dashboard/billing');
    }
    if (params.get('canceled') === 'true') {
      setError('Paiement annulé. Vous pouvez réessayer à tout moment.');
      window.history.replaceState({}, '', '/dashboard/billing');
    }
  }, []);

  const handleSelect = async (planId: string) => {
    setError(''); setSuccess(''); setLoading(true);
    const token = getToken();

    try {
      if (!token) {
        setError('Vous devez être connecté pour souscrire un abonnement.');
        return;
      }

      // Appel API backend → retourne un payment_url LeekPay
      const res = await fetch(`${API_URL}/payments/checkout`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          planId,
          // Webhook URL hardcodé pour Render
          webhookUrl: 'https://codemorph-hp00.onrender.com/api/v1/payments/webhook',
          // URLs de retour
          successUrl: `${window.location.origin}/dashboard/billing?success=true&plan=${planId}`,
          cancelUrl:  `${window.location.origin}/dashboard/billing?canceled=true`,
        }),
      });

      const data = await res.json() as {
        data?:       { payment_url?: string; checkoutUrl?: string; url?: string };
        payment_url?: string;
        checkoutUrl?: string;
        url?:         string;
        message?:    string;
        error?:      string;
      };

      const url =
        data.data?.payment_url ?? data.data?.checkoutUrl ?? data.data?.url ??
        data.payment_url ?? data.checkoutUrl ?? data.url;

      if (!res.ok) {
        throw new Error(data.message ?? data.error ?? `Erreur ${res.status}`);
      }

      if (url) {
        window.location.href = url;
        return;
      }

      // Fallback : pas de payment_url mais requête OK
      setSuccess(`Votre demande d'abonnement ${planId} a été reçue. Notre équipe vous contactera.`);
      setCurrentPlan(planId);

    } catch (err: unknown) {
      setError((err as Error).message ?? 'Erreur lors du paiement. Réessayez.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-10">

      {/* Header */}
      <div className="text-center space-y-2">
        <div className="inline-flex items-center gap-2 bg-violet-500/10 border border-violet-500/20 text-violet-400 text-xs font-semibold px-3 py-1.5 rounded-full mb-2">
          <Crown className="h-3.5 w-3.5" /> Abonnements CodeMorph
        </div>
        <h1 className="text-3xl font-bold text-white">Choisissez votre plan</h1>
        <p className="text-slate-400 max-w-lg mx-auto">
          Paiement sécurisé par <span className="text-violet-400 font-semibold">LeekPay</span>.
          Changez ou annulez votre abonnement à tout moment.
        </p>
      </div>

      {/* Alertes */}
      {success && (
        <div className="rounded-xl bg-green-500/10 border border-green-500/30 px-4 py-3 text-sm text-green-400">
          {success}
        </div>
      )}
      {error && (
        <div className="rounded-xl bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm text-red-400">
          ⚠️ {error}
        </div>
      )}

      {/* Grille des plans */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-4">
        {PLANS.map(plan => (
          <PlanCard
            key={plan.id}
            plan={plan}
            current={currentPlan === plan.id}
            onSelect={handleSelect}
            loading={loading}
          />
        ))}
      </div>

      {/* Badges confiance */}
      <div className="border border-slate-700/50 rounded-2xl p-6 bg-slate-800/20">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { icon: Shield,  color: 'text-green-400',  label: 'Paiement 100% sécurisé' },
            { icon: Zap,     color: 'text-blue-400',   label: 'Mobile Money & Carte' },
            { icon: Check,   color: 'text-yellow-400', label: 'Annulation à tout moment' },
            { icon: Crown,   color: 'text-violet-400', label: 'Powered by LeekPay' },
          ].map(b => (
            <div key={b.label} className="flex items-center gap-2 text-slate-400 text-sm">
              <b.icon className={`h-4 w-4 shrink-0 ${b.color}`} />
              <span>{b.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Comparaison rapide */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-white">Comparaison des plans</h2>
        <div className="overflow-x-auto rounded-xl border border-slate-700/50">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700/50 bg-slate-800/40">
                <th className="text-left px-4 py-3 text-slate-400 font-medium">Fonctionnalité</th>
                <th className="text-center px-4 py-3 text-slate-400 font-medium">Starter</th>
                <th className="text-center px-4 py-3 text-violet-400 font-medium">Pro</th>
                <th className="text-center px-4 py-3 text-slate-400 font-medium">Pro Max</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/30">
              {[
                ['Conversions / mois',    '10',       '50',         'Illimitées'],
                ['Import GitHub',         '✓',        '✓',          '✓'],
                ['Import ZIP',            '✓',        '✓',          '✓'],
                ['Tous les langages',     '—',        '✓',          '✓'],
                ['Gestion d\'équipe',     '—',        '—',          '✓'],
                ['API directe (CI/CD)',   '—',        '—',          '✓'],
                ['Support',               'Email',    'Prioritaire','Dédié 24h/7j'],
                ['Prix/mois',             '$5',       '$10',        '$25'],
              ].map(([feat, ...vals]) => (
                <tr key={feat} className="hover:bg-slate-800/20">
                  <td className="px-4 py-3 text-slate-300">{feat}</td>
                  {vals.map((v, i) => (
                    <td key={i} className={`px-4 py-3 text-center ${
                      i === 1 ? 'text-violet-300 font-medium' : 'text-slate-400'
                    } ${v === '—' ? 'opacity-40' : ''}`}>{v}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* FAQ */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-white">Questions fréquentes</h2>
        <div className="space-y-3">
          {[
            {
              q: 'Comment fonctionne le paiement ?',
              a: 'Après sélection du plan, vous êtes redirigé vers LeekPay pour un paiement sécurisé par Mobile Money ou carte bancaire.',
            },
            {
              q: 'Puis-je changer de plan ?',
              a: 'Oui, à tout moment depuis cette page. Le nouveau plan prend effet immédiatement.',
            },
            {
              q: 'Comment le webhook fonctionne-t-il ?',
              a: `LeekPay notifie automatiquement notre serveur à l'adresse codemorph-hp00.onrender.com/api/v1/payments/webhook pour activer votre plan après paiement.`,
            },
          ].map(({ q, a }, i) => (
            <div key={i} className="rounded-xl bg-slate-800/40 border border-slate-700/50 p-4">
              <p className="font-medium text-white text-sm">{q}</p>
              <p className="text-slate-400 text-sm mt-1">{a}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Besoin d'aide */}
      <div className="text-center py-4">
        <p className="text-sm text-slate-400">
          Des questions ? Consultez notre{' '}
          <Link href="/pricing" className="text-violet-400 hover:underline">page tarifs</Link>{' '}
          ou contactez le support.
        </p>
      </div>
    </div>
  );
}
