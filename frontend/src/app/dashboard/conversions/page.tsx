'use client';
// ============================================================
// CodeMorph — Conversions Page (/dashboard/conversions)
// PHASE 10 FIX :
//   - Suppression du fetch() brut + polling manuel sans AbortController
//   - Utilise useJobs() (React Query) : source de vérité unique
//   - refetchInterval auto géré par React Query (3s si actifs, sinon off)
//   - Recherche client-side par langage
//   - Filtres : Tous / Actifs / Terminés / Échoués
//   - Lien "Suivre" → page détail job
//   - Pas de fuite mémoire (AbortController géré par React Query)
// ============================================================
import type React from 'react';
import { useState, useMemo } from 'react';
import Link from 'next/link';
import { Plus, Zap, Search, Filter, Loader2, RefreshCw,
         CheckCircle2, XCircle, Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge }   from '@/components/ui/badge';
import { Button }  from '@/components/ui/button';
import { useJobs } from '@/hooks/useJobs';
import { cn }      from '@/lib/utils/cn';

// ── Types ─────────────────────────────────────────────────
const STATUS_CFG: Record<string, { label: string; variant: 'success'|'warning'|'error'|'default'|'info' }> = {
  done:       { label: 'Terminé',    variant: 'success' },
  completed:  { label: 'Terminé',    variant: 'success' },
  converting: { label: 'Conversion', variant: 'warning' },
  analyzing:  { label: 'Analyse',    variant: 'info'    },
  pending:    { label: 'En attente', variant: 'default' },
  failed:     { label: 'Échoué',     variant: 'error'   },
};

type FilterMode = 'all' | 'active' | 'done' | 'failed';

// ── Page ─────────────────────────────────────────────────
export default function ConversionsPage(): React.JSX.Element {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterMode>('all');

  // PHASE 10 FIX : React Query gère le polling proprement
  // refetchInterval dans useJobs.ts : 3000ms si jobs actifs, false sinon
  // Plus de setInterval manuel / AbortController / fuite mémoire
  const { data, isLoading, refetch, isFetching } = useJobs(1, 200);
  const jobs = data?.data ?? [];

  const active    = jobs.filter(j => ['pending','analyzing','converting'].includes(j.status)).length;
  const completed = jobs.filter(j => ['done','completed'].includes(j.status)).length;
  const failed    = jobs.filter(j => j.status === 'failed').length;

  const filtered = useMemo(() => {
    let list = jobs;

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(j =>
        (j.sourceLanguage ?? '').toLowerCase().includes(q) ||
        (j.targetLanguage ?? '').toLowerCase().includes(q),
      );
    }

    switch (filter) {
      case 'active': return list.filter(j => ['pending','analyzing','converting'].includes(j.status));
      case 'done':   return list.filter(j => ['done','completed'].includes(j.status));
      case 'failed': return list.filter(j => j.status === 'failed');
      default:       return list;
    }
  }, [jobs, search, filter]);

  const FILTER_OPTS: { value: FilterMode; label: string }[] = [
    { value: 'all',    label: 'Tous' },
    { value: 'active', label: 'Actifs' },
    { value: 'done',   label: 'Terminés' },
    { value: 'failed', label: 'Échoués' },
  ];

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Conversions</h1>
          <p className="text-muted-foreground text-sm">
            Suivez tous vos jobs de conversion de code.
            {active > 0 && (
              <span className="ml-2 text-blue-400 font-medium">
                {active} en cours — actualisation auto toutes les 3s
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
          </Button>
          <Link href="/dashboard/projects/new">
            <Button leftIcon={<Plus className="h-4 w-4" />} variant="premium">Nouveau projet</Button>
          </Link>
        </div>
      </div>

      {/* Compteurs */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {[
          { label: 'Actifs',    value: active,    color: 'text-warning',  bg: 'bg-warning/10',  icon: <Loader2 className="h-4 w-4 text-warning animate-spin" /> },
          { label: 'Terminés',  value: completed, color: 'text-success',  bg: 'bg-success/10',  icon: <CheckCircle2 className="h-4 w-4 text-success" /> },
          { label: 'Échoués',   value: failed,    color: 'text-red-400',  bg: 'bg-red-500/10',  icon: <XCircle className="h-4 w-4 text-red-400" /> },
        ].map(s => (
          <Card key={s.label}>
            <CardContent className="flex items-center gap-3 p-4">
              <div className={cn('flex h-9 w-9 items-center justify-center rounded-lg', s.bg)}>
                {s.icon}
              </div>
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide">{s.label}</p>
                <p className={cn('text-2xl font-bold mt-0.5', s.color)}>{isLoading ? '…' : s.value}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filtres + Recherche */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Rechercher par langage…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2 text-sm rounded-lg border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Filter className="h-4 w-4 text-muted-foreground shrink-0" />
          {FILTER_OPTS.map(o => (
            <button
              key={o.value}
              onClick={() => setFilter(o.value)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                filter === o.value
                  ? 'border-primary bg-primary/20 text-primary'
                  : 'border-border bg-card text-muted-foreground hover:border-primary/50',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {/* Liste des jobs */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {filtered.length} job{filtered.length !== 1 ? 's' : ''}
            {filter !== 'all' && ` · ${FILTER_OPTS.find(o => o.value === filter)?.label}`}
          </CardTitle>
          <CardDescription>
            {active > 0
              ? `${active} en cours — actualisation automatique`
              : 'Toutes les conversions'}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="divide-y divide-border">
              {[1,2,3].map(i => (
                <div key={i} className="flex items-center gap-4 px-6 py-4">
                  <div className="h-9 w-9 rounded-lg bg-muted animate-pulse" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-1/3 rounded bg-muted animate-pulse" />
                    <div className="h-3 w-1/4 rounded bg-muted animate-pulse" />
                  </div>
                  <div className="h-6 w-20 rounded bg-muted animate-pulse" />
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center gap-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary/10">
                <Zap className="h-7 w-7 text-primary" />
              </div>
              <div>
                <p className="font-medium text-foreground">Aucune conversion</p>
                <p className="text-sm text-muted-foreground mt-1">
                  {search || filter !== 'all'
                    ? 'Aucun résultat pour ces filtres.'
                    : 'Démarrez votre première conversion depuis le dashboard.'}
                </p>
              </div>
              {!search && filter === 'all' && (
                <Link href="/dashboard/projects/new">
                  <Button variant="premium" size="sm">
                    <Plus className="h-4 w-4 mr-1" /> Commencer
                  </Button>
                </Link>
              )}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {filtered.map(job => {
                const cfg     = STATUS_CFG[job.status] ?? { label: job.status, variant: 'default' as const };
                const isActive = ['pending','analyzing','converting'].includes(job.status);
                const isDone   = ['done','completed'].includes(job.status);
                return (
                  <div key={job.id} className="flex items-center gap-4 px-6 py-4 hover:bg-accent/30 transition-colors">
                    {/* Icône statut */}
                    <div className={cn(
                      'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
                      cfg.variant === 'success' ? 'bg-success/10' :
                      cfg.variant === 'warning' ? 'bg-warning/10' :
                      cfg.variant === 'error'   ? 'bg-red-500/10' :
                      cfg.variant === 'info'    ? 'bg-blue-500/10' : 'bg-muted',
                    )}>
                      {isActive
                        ? <Loader2 className={cn('h-5 w-5 animate-spin',
                            job.status === 'analyzing'  ? 'text-blue-400' : 'text-warning')} />
                        : isDone
                          ? <CheckCircle2 className="h-5 w-5 text-success" />
                          : job.status === 'failed'
                            ? <XCircle className="h-5 w-5 text-red-400" />
                            : <Clock className="h-5 w-5 text-muted-foreground" />
                      }
                    </div>

                    {/* Infos */}
                    <div className="flex-1 min-w-0 space-y-1">
                      <p className="text-sm font-semibold capitalize">
                        {job.sourceLanguage} → {job.targetLanguage}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(job.createdAt).toLocaleString('fr-FR')}
                        {job.filesGenerated ? ` · ${job.filesGenerated} fichiers` : ''}
                        {job.linesGenerated ? ` · ${job.linesGenerated.toLocaleString()} lignes` : ''}
                      </p>
                      {/* Barre de progression */}
                      {isActive && (
                        <div className="flex items-center gap-2 mt-1">
                          <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden max-w-[160px]">
                            <div
                              className="h-full rounded-full transition-all duration-500 bg-primary"
                              style={{ width: `${job.progress ?? 0}%` }}
                            />
                          </div>
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {job.progress ?? 0}%
                          </span>
                        </div>
                      )}
                      {/* Phase courante */}
                      {isActive && job.currentPhase && (
                        <p className="text-xs text-muted-foreground/60">{job.currentPhase}</p>
                      )}
                      {/* Erreur */}
                      {job.status === 'failed' && job.errorMessage && (
                        <p className="text-xs text-red-400 truncate" title={job.errorMessage}>
                          {job.errorMessage}
                        </p>
                      )}
                    </div>

                    {/* Badge + Actions */}
                    <div className="flex items-center gap-3 shrink-0">
                      <Badge variant={cfg.variant} size="sm">{cfg.label}</Badge>

                      {/* Lien vers le détail du job */}
                      {isActive && job.projectId && (
                        <Link href={`/dashboard/projects/${job.projectId}`}>
                          <Button variant="outline" size="sm" className="text-xs h-7">
                            Suivre
                          </Button>
                        </Link>
                      )}
                      {isDone && job.projectId && (
                        <Link href={`/dashboard/projects/${job.projectId}`}>
                          <Button variant="premium" size="sm" className="text-xs h-7">
                            Résultat
                          </Button>
                        </Link>
                      )}
                      {/* Lien historique pour les détails */}
                      <Link href="/dashboard/history">
                        <Button variant="ghost" size="sm" className="text-xs h-7 text-muted-foreground">
                          Détails
                        </Button>
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
