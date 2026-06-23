'use client';
// ============================================================
// CodeMorph — Billing Page
// Style Stripe / Linear / Vercel — Clean, professional
// Plans: Starter $5 / Pro $10 / Pro Max $20
// ============================================================
import { useState } from 'react';
import { Check, Zap, Crown, Sparkles, ArrowRight } from 'lucide-react';
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
    color:    'slate',
    badge:    null,
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
    color:    'indigo',
    badge:    'Most popular',
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
    color:    'violet',
    badge:    'Best value',
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

export default function BillingPage() {
  const { user } = useAuthStore();
  const currentPlan = (user?.plan as string) ?? 'free';
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError]     = useState('');

  const handleUpgrade = async (planId: string) => {
    if (loading) return;
    setLoading(planId);
    setError('');

    try {
      const token = getAccessToken();
      const res = await fetch(`${API_URL}/payments/checkout`, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ planId, currency: 'USD' }),
      });

      const data = await res.json() as {
        data?: { checkoutUrl?: string; url?: string };
        checkoutUrl?: string;
        url?: string;
      };

      const url = data?.data?.checkoutUrl ?? data?.data?.url ?? data?.checkoutUrl ?? data?.url;
      if (url) {
        window.location.href = url;
      } else {
        setError('Could not initiate checkout. Please try again.');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(null);
    }
  };

  const isPlanActive = (planId: string): boolean => {
    if (planId === 'starter' && currentPlan === 'free') return false;
    return currentPlan === planId;
  };

  const isPlanBelow = (planId: string): boolean => {
    const order = ['free', 'starter', 'pro', 'pro_max'];
    return order.indexOf(currentPlan) >= order.indexOf(planId);
  };

  return (
    <div className="min-h-full bg-background">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12">

        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold tracking-tight text-foreground mb-3">
            Simple, transparent pricing
          </h1>
          <p className="text-lg text-muted-foreground">
            Choose the plan that fits your workflow. Upgrade or cancel anytime.
          </p>
          {currentPlan !== 'free' && currentPlan !== 'starter' && (
            <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-4 py-1.5 text-sm text-primary font-medium">
              <Check className="h-3.5 w-3.5" />
              Current plan: {PLANS.find(p => p.id === currentPlan)?.name ?? currentPlan}
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="mb-8 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive text-center">
            {error}
          </div>
        )}

        {/* Plans */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-start">
          {PLANS.map(plan => {
            const Icon = plan.icon;
            const active = isPlanActive(plan.id);
            const below = isPlanBelow(plan.id);
            const isLoading = loading === plan.id;

            return (
              <div
                key={plan.id}
                className={cn(
                  'relative flex flex-col rounded-2xl border p-7 transition-all duration-200',
                  plan.popular
                    ? 'border-primary/60 bg-gradient-to-b from-primary/5 to-card shadow-xl shadow-primary/10 scale-[1.02]'
                    : 'border-border bg-card hover:border-border/80 hover:shadow-lg',
                )}
              >
                {/* Badge */}
                {plan.badge && (
                  <div className={cn(
                    'absolute -top-3.5 left-1/2 -translate-x-1/2 whitespace-nowrap',
                    'rounded-full px-3.5 py-1 text-xs font-semibold shadow-sm',
                    plan.popular
                      ? 'bg-primary text-white'
                      : 'bg-violet-500 text-white',
                  )}>
                    {plan.badge}
                  </div>
                )}

                {/* Plan header */}
                <div className="flex items-center gap-3 mb-5">
                  <div className={cn(
                    'flex h-10 w-10 items-center justify-center rounded-xl',
                    plan.popular  ? 'bg-primary/15 text-primary' :
                    plan.id === 'pro_max' ? 'bg-violet-500/10 text-violet-500' :
                    'bg-surface-2 text-muted-foreground',
                  )}>
                    <Icon className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="font-bold text-foreground">{plan.name}</h3>
                  </div>
                </div>

                {/* Price */}
                <div className="mb-6">
                  <div className="flex items-baseline gap-1">
                    <span className="text-4xl font-extrabold tracking-tight text-foreground">
                      ${plan.price}
                    </span>
                    <span className="text-sm text-muted-foreground font-medium">/mo</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">Billed monthly. Cancel anytime.</p>
                </div>

                {/* Features */}
                <ul className="space-y-3 mb-8 flex-1">
                  {plan.features.map(f => (
                    <li key={f} className="flex items-start gap-2.5 text-sm">
                      <div className={cn(
                        'mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full',
                        plan.popular  ? 'bg-primary/15 text-primary' :
                        plan.id === 'pro_max' ? 'bg-violet-500/15 text-violet-500' :
                        'bg-surface-2 text-muted-foreground',
                      )}>
                        <Check className="h-3 w-3" strokeWidth={2.5} />
                      </div>
                      <span className="text-foreground/80">{f}</span>
                    </li>
                  ))}
                </ul>

                {/* CTA */}
                {active ? (
                  <div className="flex items-center justify-center gap-2 rounded-xl border border-border bg-surface-1 py-3 text-sm font-semibold text-muted-foreground">
                    <Check className="h-4 w-4" />
                    Current plan
                  </div>
                ) : below ? (
                  <div className="flex items-center justify-center gap-2 rounded-xl border border-border bg-surface-1 py-3 text-sm font-medium text-muted-foreground/50 cursor-default">
                    Downgrade
                  </div>
                ) : (
                  <button
                    onClick={() => void handleUpgrade(plan.id)}
                    disabled={!!loading}
                    className={cn(
                      'flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold',
                      'transition-all duration-150 disabled:opacity-60',
                      plan.popular
                        ? 'bg-primary text-white hover:bg-primary/90 shadow-md shadow-primary/25'
                        : plan.id === 'pro_max'
                        ? 'bg-violet-500 text-white hover:bg-violet-600 shadow-md shadow-violet-500/25'
                        : 'border border-border bg-surface-1 text-foreground hover:bg-surface-2',
                    )}
                  >
                    {isLoading ? (
                      <span className="flex items-center gap-2">
                        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="60" strokeDashoffset="20" />
                        </svg>
                        Processing...
                      </span>
                    ) : (
                      <>
                        {plan.cta}
                        <ArrowRight className="h-4 w-4" />
                      </>
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
            Not ready to upgrade?{' '}
            <span className="font-medium text-foreground">
              Free plan includes 3 conversions/month (Flutter → React Native).
            </span>
          </p>
        </div>

        {/* Trust badges */}
        <div className="mt-10 flex flex-wrap items-center justify-center gap-6 border-t border-border pt-8">
          {['Secure payment', 'Cancel anytime', 'Instant access', 'No hidden fees'].map(item => (
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
