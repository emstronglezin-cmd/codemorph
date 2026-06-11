'use client';

import type React from 'react';
import { useState } from 'react';
import { useSubscription, useCheckout, usePlans, type Plan, type BillingInterval } from '@/hooks/useSubscription';
import { PlanBadge } from './PlanBadge';
import { cn } from '@/lib/utils';

interface UpgradeGateProps {
  feature:         string;
  requiredPlan:    Plan;
  children?:       React.ReactNode;
  fallback?:       React.ReactNode;
  variant?:        'modal' | 'inline' | 'banner';
  onClose?:        () => void;
}

export function UpgradeGate({
  feature,
  requiredPlan,
  children,
  fallback,
  variant = 'inline',
  onClose,
}: UpgradeGateProps) {
  const { data: sub } = useSubscription();

  const planOrder: Record<Plan, number> = { free: 0, pro: 1, pro_max: 2 };
  const userLevel     = planOrder[sub?.plan ?? 'free'] ?? 0;
  const requiredLevel = planOrder[requiredPlan] ?? 0;

  if (userLevel >= requiredLevel) {
    return <>{children}</>;
  }

  if (fallback) return <>{fallback}</>;

  if (variant === 'banner') {
    return <UpgradeBanner feature={feature} requiredPlan={requiredPlan} onClose={onClose} />;
  }

  if (variant === 'modal') {
    return <UpgradeModal feature={feature} requiredPlan={requiredPlan} onClose={onClose} />;
  }

  return <UpgradeInline feature={feature} requiredPlan={requiredPlan} />;
}

// ── Inline card ───────────────────────────────────────────
function UpgradeInline({ feature, requiredPlan }: { feature: string; requiredPlan: Plan }) {
  const { mutate: checkout, isPending } = useCheckout();

  return (
    <div className="flex flex-col items-center justify-center gap-4 p-8 border-2 border-dashed border-slate-200 rounded-2xl bg-slate-50 text-center">
      <div className="w-12 h-12 rounded-full bg-violet-100 flex items-center justify-center">
        <svg className="w-6 h-6 text-violet-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
      </div>
      <div>
        <h3 className="font-semibold text-slate-800 mb-1">{feature}</h3>
        <p className="text-sm text-slate-500">
          Cette fonctionnalité est réservée au plan{' '}
          <PlanBadge plan={requiredPlan} size="sm" />
        </p>
      </div>
      <div className="flex gap-3">
        <a href="/pricing" className="text-sm text-slate-500 hover:text-slate-700 underline">
          Voir les plans
        </a>
        <button
          onClick={() => checkout({ plan: requiredPlan, interval: 'monthly' })}
          disabled={isPending}
          className="px-4 py-2 text-sm font-semibold text-white bg-violet-600 hover:bg-violet-700 rounded-lg transition-colors disabled:opacity-50"
        >
          {isPending ? 'Chargement…' : `Passer à ${requiredPlan === 'pro_max' ? 'Pro Max' : 'Pro'}`}
        </button>
      </div>
    </div>
  );
}

// ── Banner ────────────────────────────────────────────────
function UpgradeBanner({ feature, requiredPlan, onClose }: { feature: string; requiredPlan: Plan; onClose?: () => void }) {
  const { mutate: checkout, isPending } = useCheckout();

  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 bg-gradient-to-r from-violet-600 to-indigo-600 text-white rounded-xl">
      <div className="flex items-center gap-3">
        <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        <p className="text-sm font-medium">
          <span className="font-bold">{feature}</span>{' '}
          requis plan <PlanBadge plan={requiredPlan} size="sm" className="opacity-90" />
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => checkout({ plan: requiredPlan, interval: 'monthly' })}
          disabled={isPending}
          className="px-3 py-1 text-xs font-bold bg-white text-violet-700 rounded-lg hover:bg-violet-50 transition-colors disabled:opacity-50"
        >
          {isPending ? '…' : 'Upgrader'}
        </button>
        {onClose && (
          <button onClick={onClose} className="text-white/70 hover:text-white">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

// ── Modal ─────────────────────────────────────────────────
function UpgradeModal({ feature, requiredPlan, onClose }: { feature: string; requiredPlan: Plan; onClose?: () => void }) {
  const [interval, setInterval] = useState<BillingInterval>('monthly');
  const { data: plans }         = usePlans();
  const { mutate: checkout, isPending } = useCheckout();

  const plan = plans?.find(p => p.id === requiredPlan);
  const price = plan?.price[interval] ?? 0;
  const yearlyDiscount = plan ? Math.round((1 - plan.price.yearly / (plan.price.monthly * 12)) * 100) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-br from-violet-600 to-indigo-700 p-6 text-white">
          <div className="flex items-center justify-between mb-4">
            <PlanBadge plan={requiredPlan} size="lg" className="bg-white/20 text-white border-white/30" />
            {onClose && (
              <button onClick={onClose} className="text-white/70 hover:text-white transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
          <h2 className="text-xl font-bold mb-1">Débloquer {feature}</h2>
          <p className="text-sm text-violet-200">
            Passez à {plan?.name ?? requiredPlan} pour accéder à cette fonctionnalité
          </p>
        </div>

        {/* Body */}
        <div className="p-6 space-y-5">
          {/* Interval toggle */}
          <div className="flex rounded-lg bg-slate-100 p-1 gap-1">
            {(['monthly', 'yearly'] as const).map((int) => (
              <button
                key={int}
                onClick={() => setInterval(int)}
                className={cn(
                  'flex-1 py-1.5 text-sm font-medium rounded-md transition-all',
                  interval === int ? 'bg-white shadow text-slate-800' : 'text-slate-500 hover:text-slate-700',
                )}
              >
                {int === 'monthly' ? 'Mensuel' : 'Annuel'}
                {int === 'yearly' && yearlyDiscount > 0 && (
                  <span className="ml-1.5 text-[10px] font-bold text-green-600 bg-green-100 rounded-full px-1.5 py-0.5">
                    -{yearlyDiscount}%
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Price */}
          <div className="text-center">
            <span className="text-4xl font-extrabold text-slate-900">${price}</span>
            <span className="text-slate-400 ml-1">/{interval === 'monthly' ? 'mois' : 'an'}</span>
          </div>

          {/* Features */}
          {plan && (
            <ul className="space-y-2">
              {plan.features.slice(0, 5).map((feat, i) => (
                <li key={i} className="flex items-center gap-2.5 text-sm text-slate-600">
                  <svg className="w-4 h-4 text-green-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                  </svg>
                  {feat}
                </li>
              ))}
            </ul>
          )}

          {/* CTA */}
          <button
            onClick={() => checkout({ plan: requiredPlan, interval })}
            disabled={isPending}
            className="w-full py-3 text-sm font-bold text-white bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 rounded-xl transition-all shadow-lg shadow-violet-200 disabled:opacity-60"
          >
            {isPending ? 'Redirection…' : `Passer à ${plan?.name ?? requiredPlan}`}
          </button>

          <p className="text-center text-xs text-slate-400">
            Annulation possible à tout moment · Sans engagement
          </p>
        </div>
      </div>
    </div>
  );
}
