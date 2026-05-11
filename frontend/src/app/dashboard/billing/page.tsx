'use client';

import { useState } from 'react';
import {
  useSubscription,
  usePlans,
  useCheckout,
  useBillingPortal,
  type Plan,
  type BillingInterval,
} from '@/hooks/useSubscription';
import { PlanBadge }  from '@/components/subscription/PlanBadge';
import { UsageMeter } from '@/components/subscription/UsageMeter';
import { cn }         from '@/lib/utils';

function StatCard({ label, value, sub, color = 'violet' }: {
  label: string; value: string | number; sub?: string; color?: 'violet' | 'green' | 'amber' | 'red';
}) {
  const colors = {
    violet: 'text-violet-600 bg-violet-50 border-violet-100',
    green:  'text-green-600  bg-green-50  border-green-100',
    amber:  'text-amber-600  bg-amber-50  border-amber-100',
    red:    'text-red-600    bg-red-50    border-red-100',
  };
  return (
    <div className={cn('border rounded-xl p-5', colors[color])}>
      <p className="text-xs font-semibold uppercase tracking-wider opacity-70 mb-1">{label}</p>
      <p className="text-2xl font-extrabold">{value}</p>
      {sub && <p className="text-xs opacity-60 mt-0.5">{sub}</p>}
    </div>
  );
}

export default function BillingPage() {
  const [upgradeInterval, setUpgradeInterval] = useState<BillingInterval>('monthly');

  const { data: sub,    isLoading: subLoading  } = useSubscription();
  const { data: plans,  isLoading: plansLoading } = usePlans();
  const { mutate: checkout,    isPending: checkoutPending } = useCheckout();
  const { mutate: openPortal,  isPending: portalPending   } = useBillingPortal();

  if (subLoading || plansLoading) {
    return (
      <div className="p-8 space-y-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-24 bg-slate-100 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  if (!sub) return null;

  const currentPlanInfo  = plans?.find(p => p.id === sub.plan);
  const isFreePlan       = sub.plan === 'free';
  const isCancelPending  = sub.cancelAtPeriodEnd;
  const pct              = sub.usage.conversionsLimit > 0
    ? Math.min(100, Math.round((sub.usage.conversionsUsed / sub.usage.conversionsLimit) * 100))
    : 0;

  const upgradePlans = plans?.filter(p => {
    const order: Record<Plan, number> = { free: 0, pro: 1, pro_max: 2 };
    return order[p.id] > order[sub.plan];
  }) ?? [];

  const resetDate = new Date(sub.usage.resetAt).toLocaleDateString('fr-FR', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  const periodEndDate = sub.currentPeriodEnd
    ? new Date(sub.currentPeriodEnd).toLocaleDateString('fr-FR', {
        day: 'numeric', month: 'long', year: 'numeric',
      })
    : null;

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">

      {/* ── Header ──────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Abonnement & Facturation</h1>
          <p className="text-sm text-slate-500 mt-1">Gérez votre plan et suivez votre consommation</p>
        </div>
        {!isFreePlan && (
          <button
            onClick={() => openPortal()}
            disabled={portalPending}
            className="px-4 py-2 text-sm font-semibold text-slate-700 border border-slate-300 rounded-xl hover:bg-slate-50 transition-colors disabled:opacity-50"
          >
            {portalPending ? 'Chargement…' : '🔗 Portail de facturation'}
          </button>
        )}
      </div>

      {/* ── Current plan card ───────────────────────────── */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
        <div className="px-6 py-5 bg-gradient-to-r from-slate-50 to-white border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <PlanBadge plan={sub.plan} size="lg" />
            <div>
              <p className="font-bold text-slate-900">{currentPlanInfo?.name ?? sub.plan} Plan</p>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className={cn(
                  'w-1.5 h-1.5 rounded-full',
                  sub.status === 'active' || sub.status === 'trialing' ? 'bg-green-500' :
                  sub.status === 'past_due' ? 'bg-amber-500' : 'bg-slate-300',
                )} />
                <span className="text-xs text-slate-500 capitalize">
                  {sub.status === 'trialing' ? 'Période d\'essai' :
                   sub.status === 'past_due' ? 'Paiement en retard' :
                   sub.status === 'cancelled' ? 'Annulé' :
                   sub.status === 'active'    ? 'Actif' : sub.status}
                </span>
              </div>
            </div>
          </div>
          {periodEndDate && (
            <div className="text-right">
              <p className="text-xs text-slate-400">
                {isCancelPending ? 'Expire le' : 'Renouvellement le'}
              </p>
              <p className="text-sm font-semibold text-slate-700">{periodEndDate}</p>
            </div>
          )}
        </div>

        {/* Cancellation warning */}
        {isCancelPending && (
          <div className="mx-6 mt-4 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
            ⚠️ Votre abonnement se terminera le <strong>{periodEndDate}</strong>.
            Réabonnez-vous pour continuer à utiliser toutes les fonctionnalités.
          </div>
        )}

        {/* Past due warning */}
        {sub.status === 'past_due' && (
          <div className="mx-6 mt-4 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-800">
            ❌ Votre dernier paiement a échoué.{' '}
            <button onClick={() => openPortal()} className="font-bold underline">
              Mettez à jour votre moyen de paiement
            </button>
          </div>
        )}

        <div className="p-6">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <StatCard
              label="Conversions"
              value={sub.usage.conversionsLimit <= 0 ? '∞' : `${sub.usage.conversionsUsed}/${sub.usage.conversionsLimit}`}
              sub={`Réset le ${resetDate}`}
              color={pct >= 90 ? 'red' : pct >= 70 ? 'amber' : 'violet'}
            />
            <StatCard
              label="Requêtes AI"
              value={sub.usage.aiRequestsUsed}
              sub="Ce mois"
              color="green"
            />
            <StatCard
              label="Stockage utilisé"
              value={`${(sub.usage.storageBytesUsed / 1_048_576).toFixed(1)} MB`}
              sub={isFreePlan ? 'Limite 5 MB' : 'Inclus'}
              color="violet"
            />
            <StatCard
              label="Statut"
              value={isFreePlan ? 'Free' : sub.status === 'trialing' ? 'Trial' : 'Payant'}
              color={isFreePlan ? 'amber' : 'green'}
            />
          </div>
        </div>
      </div>

      {/* ── Usage detail ────────────────────────────────── */}
      {sub.usage.conversionsLimit > 0 && (
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <h2 className="text-base font-bold text-slate-900 mb-4">Utilisation détaillée</h2>
          <UsageMeter />
          <div className="mt-4 grid grid-cols-3 gap-3 text-xs text-center text-slate-500">
            <div className="bg-slate-50 rounded-lg py-2">
              <div className="font-bold text-slate-800 text-base">{sub.usage.conversionsUsed}</div>
              Conversions utilisées
            </div>
            <div className="bg-slate-50 rounded-lg py-2">
              <div className="font-bold text-slate-800 text-base">
                {sub.usage.conversionsLimit - sub.usage.conversionsUsed > 0
                  ? sub.usage.conversionsLimit - sub.usage.conversionsUsed
                  : 0}
              </div>
              Restantes
            </div>
            <div className="bg-slate-50 rounded-lg py-2">
              <div className="font-bold text-slate-800 text-base">{pct}%</div>
              Consommé
            </div>
          </div>
        </div>
      )}

      {/* ── Upgrade section ─────────────────────────────── */}
      {upgradePlans.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-base font-bold text-slate-900">Passer à un plan supérieur</h2>

          {/* Interval selector */}
          <div className="inline-flex items-center rounded-lg bg-slate-100 p-1 gap-1">
            {(['monthly', 'yearly'] as const).map((int) => (
              <button
                key={int}
                onClick={() => setUpgradeInterval(int)}
                className={cn(
                  'px-4 py-1.5 text-sm font-medium rounded-md transition-all',
                  upgradeInterval === int ? 'bg-white shadow text-slate-800' : 'text-slate-500',
                )}
              >
                {int === 'monthly' ? 'Mensuel' : 'Annuel'}
                {int === 'yearly' && (
                  <span className="ml-1.5 text-[10px] font-bold text-green-600 bg-green-100 rounded-full px-1.5">
                    -20%
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {upgradePlans.map((plan) => {
              const price = plan.price[upgradeInterval];
              return (
                <div
                  key={plan.id}
                  className={cn(
                    'relative border rounded-2xl p-5 bg-white transition-all hover:shadow-md',
                    plan.id === 'pro'
                      ? 'border-violet-400 shadow-violet-50 shadow'
                      : 'border-slate-200',
                  )}
                >
                  {plan.id === 'pro' && (
                    <div className="absolute -top-2.5 left-4">
                      <span className="text-[10px] font-bold text-white bg-violet-600 px-2 py-0.5 rounded-full">
                        Recommandé
                      </span>
                    </div>
                  )}
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <PlanBadge plan={plan.id} size="sm" />
                      <p className="mt-1.5 font-bold text-slate-900">{plan.name}</p>
                    </div>
                    <div className="text-right">
                      <span className="text-2xl font-extrabold text-slate-900">${price}</span>
                      <span className="text-slate-400 text-xs">/{upgradeInterval === 'monthly' ? 'mois' : 'an'}</span>
                    </div>
                  </div>
                  <ul className="space-y-1.5 mb-4">
                    {plan.features.slice(0, 4).map((feat, i) => (
                      <li key={i} className="flex items-center gap-2 text-xs text-slate-600">
                        <svg className="w-3.5 h-3.5 text-green-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                        </svg>
                        {feat}
                      </li>
                    ))}
                  </ul>
                  <button
                    onClick={() => checkout({ plan: plan.id, interval: upgradeInterval })}
                    disabled={checkoutPending}
                    className={cn(
                      'w-full py-2.5 text-sm font-bold rounded-xl transition-all disabled:opacity-50',
                      plan.id === 'pro'
                        ? 'bg-gradient-to-r from-violet-600 to-indigo-600 text-white hover:from-violet-700 hover:to-indigo-700 shadow shadow-violet-200'
                        : 'bg-slate-900 text-white hover:bg-slate-800',
                    )}
                  >
                    {checkoutPending ? '…' : `Passer à ${plan.name} →`}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Cancel / manage ─────────────────────────────── */}
      {!isFreePlan && (
        <div className="border border-slate-200 rounded-2xl p-6 bg-white shadow-sm">
          <h2 className="text-base font-bold text-slate-900 mb-1">Gérer l'abonnement</h2>
          <p className="text-sm text-slate-500 mb-4">
            Modifiez votre mode de paiement, téléchargez vos factures ou annulez votre abonnement.
          </p>
          <button
            onClick={() => openPortal()}
            disabled={portalPending}
            className="px-5 py-2.5 text-sm font-semibold text-slate-700 border border-slate-300 rounded-xl hover:bg-slate-50 transition-colors disabled:opacity-50"
          >
            {portalPending ? 'Ouverture…' : '⚙️ Ouvrir le portail de facturation'}
          </button>
        </div>
      )}
    </div>
  );
}
