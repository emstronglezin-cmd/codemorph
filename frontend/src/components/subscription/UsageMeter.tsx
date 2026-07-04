'use client';
// ============================================================
// CodeMorph — UsageMeter
// FIX PHASE 13:
//   - SUPPRIMÉ: accès à sub.usage.conversionsUsed (champ absent du backend)
//   - AJOUTÉ:   lecture de sub.limits.conversionsPerMonth pour la limite du plan
//   - Usage réel (conversionsUsed) nécessite /quota/me — affichage gracieux sans lui
//   - useUsagePercent() ne peut plus calculer le % sans données d'usage réelles
// ============================================================

import { cn } from '@/lib/utils';
import { useSubscription } from '@/hooks/useSubscription';

interface UsageMeterProps {
  compact?:   boolean;
  className?: string;
}

export function UsageMeter({ compact = false, className }: UsageMeterProps) {
  const { data: sub, isLoading } = useSubscription();

  if (isLoading || !sub) {
    return (
      <div className={cn('animate-pulse h-8 bg-slate-100 rounded-lg', className)} />
    );
  }

  // FIX: lire limits.conversionsPerMonth au lieu de usage.conversionsLimit (qui n'existe pas)
  const conversionsLimit = sub.limits?.conversionsPerMonth ?? 0;
  const isUnlimited      = conversionsLimit <= 0;

  if (compact) {
    return (
      <div className={cn('space-y-1', className)}>
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>Conversions</span>
          <span className="font-medium text-slate-700">
            {isUnlimited ? '∞' : `— / ${conversionsLimit}`}
          </span>
        </div>
        {!isUnlimited && (
          <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
            {/* Barre indéterminée tant que l'usage réel n'est pas chargé */}
            <div className="h-full bg-violet-300 rounded-full w-0" />
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
          <span className="text-xs font-semibold text-slate-600">
            Quota : {conversionsLimit}
          </span>
        )}
      </div>

      {!isUnlimited && (
        <>
          {/* Barre de progression indéterminée — usage réel via /quota/me non chargé */}
          <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-violet-200 rounded-full"
              style={{ width: '0%' }}
            />
          </div>
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>— / {conversionsLimit} utilisées</span>
            <span className="italic">Usage chargé en temps réel</span>
          </div>
        </>
      )}
    </div>
  );
}
