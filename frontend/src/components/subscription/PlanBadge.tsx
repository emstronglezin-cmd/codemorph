'use client';

import { cn } from '@/lib/utils';
import type { Plan } from '@/hooks/useSubscription';

interface PlanBadgeProps {
  plan:       Plan;
  className?: string;
  size?:      'sm' | 'md' | 'lg';
}

const PLAN_CONFIG: Record<Plan, { label: string; className: string }> = {
  free: {
    label:     'Free',
    className: 'bg-slate-100 text-slate-600 border-slate-200',
  },
  pro: {
    label:     'Pro',
    className: 'bg-violet-100 text-violet-700 border-violet-200',
  },
  pro_max: {
    label:     'Pro Max',
    className: 'bg-gradient-to-r from-amber-50 to-orange-50 text-orange-700 border-orange-200',
  },
};

const SIZE_CONFIG = {
  sm: 'text-[10px] px-1.5 py-0.5',
  md: 'text-xs px-2 py-0.5',
  lg: 'text-sm px-3 py-1',
};

export function PlanBadge({ plan, className, size = 'md' }: PlanBadgeProps) {
  const cfg = PLAN_CONFIG[plan] ?? PLAN_CONFIG.free;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border font-semibold tracking-wide',
        cfg.className,
        SIZE_CONFIG[size],
        className,
      )}
    >
      {plan === 'pro_max' && (
        <svg className="w-2.5 h-2.5 text-orange-500" fill="currentColor" viewBox="0 0 20 20">
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      )}
      {cfg.label}
    </span>
  );
}
