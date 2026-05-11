'use client';

import { cn } from '@/lib/utils';
import { useSubscription, useUsagePercent } from '@/hooks/useSubscription';

interface UsageMeterProps {
  compact?:   boolean;
  className?: string;
}

export function UsageMeter({ compact = false, className }: UsageMeterProps) {
  const { data: sub, isLoading } = useSubscription();
  const pct = useUsagePercent();

  if (isLoading || !sub) {
    return (
      <div className={cn('animate-pulse h-8 bg-slate-100 rounded-lg', className)} />
    );
  }

  const { conversionsUsed, conversionsLimit, remaining, resetAt } = sub.usage;
  const isUnlimited  = conversionsLimit <= 0;
  const isWarning    = pct >= 80 && !isUnlimited;
  const isDanger     = pct >= 100 && !isUnlimited;
  const resetDate    = new Date(resetAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

  const barColor = isDanger
    ? 'bg-red-500'
    : isWarning
    ? 'bg-amber-500'
    : 'bg-violet-500';

  if (compact) {
    return (
      <div className={cn('space-y-1', className)}>
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>Conversions</span>
          <span className={cn('font-medium', isDanger ? 'text-red-600' : isWarning ? 'text-amber-600' : 'text-slate-700')}>
            {isUnlimited ? '∞' : `${conversionsUsed} / ${conversionsLimit}`}
          </span>
        </div>
        {!isUnlimited && (
          <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all duration-500', barColor)}
              style={{ width: `${Math.min(pct, 100)}%` }}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={cn('p-4 bg-white border border-slate-200 rounded-xl space-y-3', className)}>
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-slate-800">Conversions ce mois</h4>
        {isUnlimited ? (
          <span className="text-xs font-medium text-violet-600 bg-violet-50 px-2 py-0.5 rounded-full">
            Illimité
          </span>
        ) : (
          <span className={cn(
            'text-xs font-semibold',
            isDanger ? 'text-red-600' : isWarning ? 'text-amber-600' : 'text-slate-600',
          )}>
            {remaining > 0 ? `${remaining} restante${remaining > 1 ? 's' : ''}` : 'Quota atteint'}
          </span>
        )}
      </div>

      {!isUnlimited && (
        <>
          <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all duration-700', barColor)}
              style={{ width: `${Math.min(pct, 100)}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>{conversionsUsed} / {conversionsLimit} utilisées</span>
            <span>Réset le {resetDate}</span>
          </div>
        </>
      )}

      {isDanger && (
        <a
          href="/pricing"
          className="block w-full text-center text-xs font-semibold text-white bg-violet-600 hover:bg-violet-700 rounded-lg py-2 transition-colors"
        >
          Passer à Pro →
        </a>
      )}
    </div>
  );
}
