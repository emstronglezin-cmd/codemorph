'use client';

import { useState } from 'react';
import { usePlans, useSubscription, useCheckout, type Plan, type BillingInterval } from '@/hooks/useSubscription';
import { PlanBadge } from '@/components/subscription/PlanBadge';
import { cn } from '@/lib/utils';

// ── Feature comparison table ──────────────────────────────
const FEATURE_ROWS = [
  { label: 'Conversions / mois',       free: '3',         pro: '50',        max: 'Illimité' },
  { label: 'Jobs concurrents',          free: '1',         pro: '3',         max: '10' },
  { label: 'Taille max fichiers',       free: '5 MB',      pro: '25 MB',     max: '100 MB' },
  { label: 'Frameworks disponibles',    free: 'Flutter→React', pro: 'Tous (4)', max: 'Tous (4)' },
  { label: 'File de priorité',          free: 'Lente',     pro: 'Prioritaire', max: 'Highest' },
  { label: 'Export GitHub (PR)',        free: '✗',         pro: '✓',         max: '✓' },
  { label: 'Filigrane sur le code',     free: '✓',         pro: '✗',         max: '✗' },
  { label: 'Workspace équipe',          free: '✗',         pro: '✗',         max: '✓' },
  { label: 'Accès API',                 free: '✗',         pro: '✗',         max: '✓' },
  { label: 'Période d\'essai',          free: '—',         pro: '7 jours',   max: '14 jours' },
  { label: 'Support',                   free: 'Communauté', pro: 'Email',    max: 'Prioritaire' },
];

export default function PricingPage() {
  const [interval, setInterval] = useState<BillingInterval>('monthly');
  const { data: plans, isLoading } = usePlans();
  const { data: sub }              = useSubscription();
  const { mutate: checkout, isPending } = useCheckout();

  const currentPlan = sub?.plan ?? 'free';
  const yearlyDiscount = 20; // %

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-violet-600 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-slate-500">Chargement des plans…</p>
        </div>
      </div>
    );
  }

  // Fallback plans if API not available
  const displayPlans: Array<{
    id: Plan; name: string; description: string;
    price: { monthly: number; yearly: number };
    highlighted?: boolean;
    features: string[];
  }> = plans ?? [
    {
      id: 'free', name: 'Free', description: 'Pour découvrir CodeMorph',
      price: { monthly: 0, yearly: 0 },
      features: ['3 conversions/mois', '1 projet', 'Flutter → React uniquement', 'File lente'],
    },
    {
      id: 'pro', name: 'Pro', description: 'Pour les développeurs sérieux',
      price: { monthly: 29, yearly: 279 },
      highlighted: true,
      features: ['50 conversions/mois', '20 projets', 'Tous les frameworks', 'Export GitHub', 'File prioritaire', 'Sans filigrane'],
    },
    {
      id: 'pro_max', name: 'Pro Max', description: 'Pour les équipes et agences',
      price: { monthly: 79, yearly: 759 },
      features: ['Conversions illimitées', '10 jobs concurrents', 'Workspace équipe', 'API Access', '100 MB max', 'Support prioritaire'],
    },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      {/* ── Header ─────────────────────────────────────── */}
      <div className="max-w-6xl mx-auto px-4 pt-20 pb-16 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-violet-100 text-violet-700 text-xs font-semibold mb-6">
          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
          </svg>
          Tarification simple et transparente
        </div>
        <h1 className="text-4xl md:text-5xl font-extrabold text-slate-900 mb-4 tracking-tight">
          Choisissez votre plan
        </h1>
        <p className="text-lg text-slate-500 max-w-2xl mx-auto mb-10">
          Convertissez votre code Flutter en React, Vue, Angular ou Swift avec la puissance de GPT-4o.
          Sans engagement, annulable à tout moment.
        </p>

        {/* ── Interval toggle ────────────────────────── */}
        <div className="inline-flex items-center rounded-xl bg-slate-100 p-1 gap-1">
          {(['monthly', 'yearly'] as const).map((int) => (
            <button
              key={int}
              onClick={() => setInterval(int)}
              className={cn(
                'px-5 py-2 text-sm font-semibold rounded-lg transition-all',
                interval === int
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700',
              )}
            >
              {int === 'monthly' ? 'Mensuel' : 'Annuel'}
              {int === 'yearly' && (
                <span className="ml-2 text-[10px] font-bold text-green-700 bg-green-100 rounded-full px-2 py-0.5">
                  -{yearlyDiscount}%
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ── Plan cards ─────────────────────────────────── */}
      <div className="max-w-6xl mx-auto px-4 pb-16">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {displayPlans.map((plan) => {
            const price      = plan.price[interval];
            const isCurrent  = currentPlan === plan.id;
            const isHigh     = plan.highlighted;

            return (
              <div
                key={plan.id}
                className={cn(
                  'relative flex flex-col rounded-2xl border transition-all',
                  isHigh
                    ? 'border-violet-500 shadow-xl shadow-violet-100 bg-white'
                    : 'border-slate-200 shadow-sm bg-white hover:shadow-md',
                )}
              >
                {isHigh && (
                  <div className="absolute -top-3.5 left-0 right-0 flex justify-center">
                    <span className="px-4 py-1 text-xs font-bold text-white bg-gradient-to-r from-violet-600 to-indigo-600 rounded-full shadow">
                      ⭐ Le plus populaire
                    </span>
                  </div>
                )}

                <div className="p-6 pb-0">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <PlanBadge plan={plan.id} size="md" />
                      <h3 className="mt-2 text-xl font-bold text-slate-900">{plan.name}</h3>
                      <p className="text-sm text-slate-500">{plan.description}</p>
                    </div>
                  </div>

                  <div className="mt-4 mb-6">
                    <span className="text-4xl font-extrabold text-slate-900">
                      {price === 0 ? 'Gratuit' : `$${price}`}
                    </span>
                    {price > 0 && (
                      <span className="text-slate-400 text-sm ml-1">
                        /{interval === 'monthly' ? 'mois' : 'an'}
                      </span>
                    )}
                    {interval === 'yearly' && price > 0 && (
                      <p className="text-xs text-green-600 font-medium mt-1">
                        soit ${Math.round(price / 12)}/mois — économisez ${(plan.price.monthly * 12) - price}
                      </p>
                    )}
                  </div>
                </div>

                {/* Features */}
                <div className="px-6 pb-6 flex-1">
                  <ul className="space-y-2.5">
                    {plan.features.map((feat, i) => (
                      <li key={i} className="flex items-center gap-2.5 text-sm text-slate-600">
                        <svg className="w-4 h-4 text-green-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                        </svg>
                        {feat}
                      </li>
                    ))}
                  </ul>
                </div>

                {/* CTA */}
                <div className="px-6 pb-6">
                  {isCurrent ? (
                    <div className="w-full py-3 text-center text-sm font-semibold text-slate-500 bg-slate-50 border border-slate-200 rounded-xl">
                      ✓ Plan actuel
                    </div>
                  ) : plan.id === 'free' ? (
                    <a
                      href="/auth/sign-up"
                      className="block w-full py-3 text-center text-sm font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
                    >
                      Commencer gratuitement
                    </a>
                  ) : (
                    <button
                      onClick={() => checkout({ plan: plan.id, interval })}
                      disabled={isPending}
                      className={cn(
                        'w-full py-3 text-sm font-bold rounded-xl transition-all disabled:opacity-60',
                        isHigh
                          ? 'text-white bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 shadow-lg shadow-violet-200'
                          : 'text-slate-800 bg-slate-900 hover:bg-slate-800 text-white',
                      )}
                    >
                      {isPending ? 'Redirection…' : `Démarrer l'essai ${plan.id === 'pro' ? '7j' : '14j'} gratuit`}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Feature comparison table ────────────────────── */}
      <div className="max-w-5xl mx-auto px-4 pb-24">
        <h2 className="text-2xl font-bold text-slate-900 text-center mb-8">Comparaison détaillée</h2>
        <div className="overflow-hidden border border-slate-200 rounded-2xl shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="text-left py-4 px-5 font-semibold text-slate-700 w-1/2">Fonctionnalité</th>
                {(['free', 'pro', 'pro_max'] as Plan[]).map((p) => (
                  <th key={p} className="py-4 px-3 text-center">
                    <PlanBadge plan={p} size="sm" />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {FEATURE_ROWS.map((row, i) => (
                <tr key={i} className={cn('border-b border-slate-100', i % 2 === 0 ? 'bg-white' : 'bg-slate-50/50')}>
                  <td className="py-3.5 px-5 text-slate-600">{row.label}</td>
                  {[row.free, row.pro, row.max].map((val, j) => (
                    <td key={j} className="py-3.5 px-3 text-center">
                      {val === '✓' ? (
                        <span className="inline-flex w-5 h-5 items-center justify-center rounded-full bg-green-100">
                          <svg className="w-3 h-3 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                          </svg>
                        </span>
                      ) : val === '✗' ? (
                        <span className="inline-flex w-5 h-5 items-center justify-center rounded-full bg-slate-100">
                          <svg className="w-3 h-3 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </span>
                      ) : (
                        <span className={cn(
                          'font-medium',
                          j === 0 ? 'text-slate-500' : j === 1 ? 'text-violet-700' : 'text-orange-700',
                        )}>
                          {val}
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* FAQ */}
        <div className="mt-16 text-center">
          <p className="text-slate-500 text-sm">
            Des questions ?{' '}
            <a href="mailto:support@codemorph.ai" className="text-violet-600 hover:underline font-medium">
              Contactez notre support
            </a>
            {' '}— nous répondons sous 24h.
          </p>
        </div>
      </div>
    </div>
  );
}
