'use client';
// ============================================================
// CodeMorph — Conversions Page (vraies données API)
// ============================================================
import type React from 'react';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, Zap, Search, Filter } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getAccessToken } from '@/lib/api/client';

const BACKEND = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

interface Job {
  id:              string;
  status:          string;
  sourceLanguage:  string;
  targetLanguage:  string;
  progress:        number;
  filesGenerated?: number;
  linesGenerated?: number;
  createdAt:       string;
  completedAt?:    string;
  projectId?:      string;
}

const STATUS_CFG: Record<string, { label: string; variant: 'success'|'warning'|'error'|'default'|'info' }> = {
  done:       { label: 'Terminé',    variant: 'success' },
  completed:  { label: 'Terminé',    variant: 'success' },
  converting: { label: 'Conversion', variant: 'warning' },
  analyzing:  { label: 'Analyse',    variant: 'info'    },
  pending:    { label: 'En attente', variant: 'default' },
  failed:     { label: 'Échoué',     variant: 'error'   },
};

function authH() {
  const t = getAccessToken();
  return { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}

export default function ConversionsPage(): React.JSX.Element {
  const [jobs,       setJobs]       = useState<Job[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [search,     setSearch]     = useState('');
  const [filter,     setFilter]     = useState<string>('all');

  useEffect(() => {
    fetch(`${BACKEND}/jobs`, { headers: authH() })
      .then(r => r.ok ? r.json() : { data: [] })
      .then(d => {
        const js = (d.data ?? d) as Job[];
        setJobs(Array.isArray(js) ? js : []);
      })
      .catch(() => setJobs([]))
      .finally(() => setLoading(false));
  }, []);

  // Polling pour les jobs en cours
  useEffect(() => {
    if (!jobs.some(j => ['pending','analyzing','converting'].includes(j.status))) return;
    const id = setInterval(() => {
      fetch(`${BACKEND}/jobs`, { headers: authH() })
        .then(r => r.ok ? r.json() : { data: [] })
        .then(d => { const js = (d.data ?? d) as Job[]; if (Array.isArray(js)) setJobs(js); })
        .catch(() => {});
    }, 5000);
    return () => clearInterval(id);
  }, [jobs]);

  const FILTER_OPTS = [
    { value: 'all',       label: 'Tous' },
    { value: 'active',    label: 'Actifs' },
    { value: 'done',      label: 'Terminés' },
    { value: 'failed',    label: 'Échoués' },
  ];

  const filtered = jobs.filter(j => {
    const matchSearch = !search || `${j.sourceLanguage} ${j.targetLanguage}`.toLowerCase().includes(search.toLowerCase());
    const matchFilter =
      filter === 'all' ? true :
      filter === 'active' ? ['pending','analyzing','converting'].includes(j.status) :
      filter === 'done' ? ['done','completed'].includes(j.status) :
      j.status === filter;
    return matchSearch && matchFilter;
  });

  const active    = jobs.filter(j => ['pending','analyzing','converting'].includes(j.status)).length;
  const completed = jobs.filter(j => ['done','completed'].includes(j.status)).length;
  const failed    = jobs.filter(j => j.status === 'failed').length;

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Conversions</h1>
          <p className="text-muted-foreground">Suivez tous vos jobs de conversion de code.</p>
        </div>
        <Link href="/dashboard/projects/new">
          <Button leftIcon={<Plus className="h-4 w-4" />} variant="premium">Nouveau projet</Button>
        </Link>
      </div>

      {/* Compteurs */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Actifs',    value: active,    color: 'text-warning',   bg: 'bg-warning/10'  },
          { label: 'Terminés',  value: completed, color: 'text-success',   bg: 'bg-success/10'  },
          { label: 'Échoués',   value: failed,    color: 'text-red-400',   bg: 'bg-red-500/10'  },
        ].map(s => (
          <Card key={s.label} className="p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">{s.label}</p>
            <p className={`text-2xl font-bold mt-1 ${s.color}`}>{loading ? '…' : s.value}</p>
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
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          {FILTER_OPTS.map(o => (
            <button
              key={o.value}
              onClick={() => setFilter(o.value)}
              className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${
                filter === o.value
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-accent'
              }`}
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
            {active > 0 ? `${active} en cours — actualisation automatique toutes les 5s` : 'Toutes les conversions'}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
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
                const cfg = STATUS_CFG[job.status] ?? { label: job.status, variant: 'default' as const };
                return (
                  <div key={job.id} className="flex items-center gap-4 px-6 py-4 hover:bg-accent/30 transition-colors">
                    {/* Icône statut */}
                    <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                      cfg.variant === 'success' ? 'bg-success/10' :
                      cfg.variant === 'warning' ? 'bg-warning/10' :
                      cfg.variant === 'error'   ? 'bg-red-500/10' :
                      cfg.variant === 'info'    ? 'bg-blue-500/10' : 'bg-muted'
                    }`}>
                      <Zap className={`h-5 w-5 ${
                        cfg.variant === 'success' ? 'text-success' :
                        cfg.variant === 'warning' ? 'text-warning' :
                        cfg.variant === 'error'   ? 'text-red-400' :
                        cfg.variant === 'info'    ? 'text-blue-400' : 'text-muted-foreground'
                      }`} />
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
                      {['analyzing','converting'].includes(job.status) && (
                        <div className="flex items-center gap-2 mt-1">
                          <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                            <div
                              className="h-full bg-primary rounded-full transition-all duration-500"
                              style={{ width: `${job.progress ?? 0}%` }}
                            />
                          </div>
                          <span className="text-xs text-muted-foreground tabular-nums">{job.progress ?? 0}%</span>
                        </div>
                      )}
                    </div>

                    {/* Badge + Action */}
                    <div className="flex items-center gap-3 shrink-0">
                      <Badge variant={cfg.variant} size="sm">{cfg.label}</Badge>
                      {job.projectId && ['pending','analyzing','converting'].includes(job.status) && (
                        <Link href={`/dashboard/projects/${job.projectId}/job/${job.id}`}>
                          <Button variant="outline" size="sm">Suivre</Button>
                        </Link>
                      )}
                      {job.projectId && ['done','completed'].includes(job.status) && (
                        <Link href={`/dashboard/projects/${job.projectId}/result/${job.id}`}>
                          <Button variant="premium" size="sm">Résultat</Button>
                        </Link>
                      )}
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
