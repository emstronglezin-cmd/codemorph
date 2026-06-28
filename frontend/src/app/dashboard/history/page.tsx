'use client';

// ============================================================
// CodeMorph — History Page (/dashboard/history)
// Affiche toutes les conversions de l'utilisateur
// - Stats bar (total, actifs, terminés, échoués)
// - Filtres status (All, Pending, Running, Done, Failed)
// - Tableau paginé (20/page) avec tri par date
// - Actions : Download (DONE), Retry, Cancel (actifs)
// - Bouton "Reset stuck jobs" → POST /jobs/reset-stale
// - Auto-refresh 10s si des jobs sont actifs
// ============================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Clock, CheckCircle2, XCircle, Loader2, RefreshCw,
  Download, RotateCcw, StopCircle, AlertTriangle,
  History, ChevronLeft, ChevronRight, Zap, Filter,
  Github, Upload, Link2, ArrowRight, BarChart3,
} from 'lucide-react';
import { Button }                from '@/components/ui/button';
import { Badge }                 from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getAccessToken }        from '@/lib/api/client';
import { cn }                    from '@/lib/utils/cn';

// ── Constantes ────────────────────────────────────────────
const BACKEND     = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
const PAGE_SIZE   = 20;
const AUTO_REFRESH_MS = 10_000; // 10 secondes

// ── Types ─────────────────────────────────────────────────
type JobStatus = 'pending' | 'analyzing' | 'converting' | 'done' | 'failed';
type FilterStatus = 'all' | JobStatus;
type JobType = 'github_import' | 'zip_import' | 'url_import' | 'conversion';

interface Job {
  id:              string;
  type:            JobType;
  status:          JobStatus;
  sourceLanguage:  string | null;
  targetLanguage:  string | null;
  sourceRepo:      string | null;
  progress:        number;
  currentPhase:    string | null;
  errorMessage:    string | null;
  outputZipPath:   string | null;
  filesGenerated:  number | null;
  linesGenerated:  number | null;
  startedAt:       string | null;
  completedAt:     string | null;
  createdAt:       string;
  updatedAt:       string;
  project?:        { id: string; name: string } | null;
  projectId?:      string | null;
}

interface Stats {
  total:     number;
  pending:   number;
  analyzing: number;
  converting:number;
  done:      number;
  failed:    number;
  active:    number;
}

// ── Helpers ───────────────────────────────────────────────
function authHeaders(): Record<string, string> {
  const token = getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function extractApiError(data: Record<string, unknown>, status: number, fallback: string): string {
  if (data['success'] === false) {
    const code = data['code'] ? ` [${data['code']}]` : '';
    const msg  = (data['message'] as string) ?? fallback;
    return `${msg}${code}`;
  }
  return `HTTP ${status}: ${fallback}`;
}

function unwrap<T>(data: unknown): T {
  if (data && typeof data === 'object' && 'success' in data && 'data' in data) {
    return (data as { success: boolean; data: T }).data;
  }
  return data as T;
}

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  const hours   = Math.floor(diff / 3_600_000);
  const days    = Math.floor(diff / 86_400_000);
  if (minutes < 1)   return "à l\u2019instant";
  if (minutes < 60)  return `il y a ${minutes} min`;
  if (hours   < 24)  return `il y a ${hours} h`;
  return `il y a ${days} j`;
}

function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return '—';
  const end   = completedAt ? new Date(completedAt).getTime() : Date.now();
  const secs  = Math.floor((end - new Date(startedAt).getTime()) / 1000);
  if (secs < 60)    return `${secs}s`;
  const mins  = Math.floor(secs / 60);
  const rem   = secs % 60;
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

function jobTypeLabel(type: JobType): string {
  switch (type) {
    case 'github_import': return 'GitHub';
    case 'zip_import':    return 'ZIP';
    case 'url_import':    return 'URL';
    case 'conversion':    return 'Conversion';
    default:              return type;
  }
}

function jobTypeIcon(type: JobType) {
  switch (type) {
    case 'github_import': return <Github className="h-3.5 w-3.5" />;
    case 'zip_import':    return <Upload className="h-3.5 w-3.5" />;
    case 'url_import':    return <Link2  className="h-3.5 w-3.5" />;
    default:              return <Zap    className="h-3.5 w-3.5" />;
  }
}

// ── StatusBadge ───────────────────────────────────────────
function StatusBadge({ status }: { status: JobStatus }) {
  const cfg: Record<JobStatus, { label: string; className: string; icon: React.ReactNode }> = {
    pending:    { label: 'En attente',  className: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',  icon: <Clock      className="h-3 w-3" /> },
    analyzing:  { label: 'Analyse',     className: 'bg-blue-500/15   text-blue-400   border-blue-500/30',    icon: <Loader2    className="h-3 w-3 animate-spin" /> },
    converting: { label: 'Conversion',  className: 'bg-purple-500/15 text-purple-400 border-purple-500/30', icon: <Loader2    className="h-3 w-3 animate-spin" /> },
    done:       { label: 'Terminé',     className: 'bg-green-500/15  text-green-400  border-green-500/30',   icon: <CheckCircle2 className="h-3 w-3" /> },
    failed:     { label: 'Échec',       className: 'bg-red-500/15    text-red-400    border-red-500/30',     icon: <XCircle    className="h-3 w-3" /> },
  };
  const { label, className, icon } = cfg[status] ?? cfg.failed;
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium', className)}>
      {icon}{label}
    </span>
  );
}

// ── ProgressBar ───────────────────────────────────────────
function ProgressBar({ progress, status }: { progress: number; status: JobStatus }) {
  if (status === 'done' || status === 'failed' || status === 'pending') return null;
  return (
    <div className="mt-1 h-1 w-full rounded-full bg-surface-1 overflow-hidden">
      <div
        className={cn(
          'h-full rounded-full transition-all duration-500',
          status === 'analyzing'  && 'bg-blue-500',
          status === 'converting' && 'bg-purple-500',
        )}
        style={{ width: `${Math.min(100, progress)}%` }}
      />
    </div>
  );
}

// ── StatCard ──────────────────────────────────────────────
function StatCard({
  label, value, icon, className,
}: { label: string; value: number; icon: React.ReactNode; className?: string }) {
  return (
    <Card className={cn('border-border bg-surface-0', className)}>
      <CardContent className="flex items-center gap-3 p-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-1">
          {icon}
        </div>
        <div>
          <p className="text-xl font-bold text-foreground">{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main Component ────────────────────────────────────────
export default function HistoryPage() {
  const router = useRouter();

  // Data
  const [jobs,       setJobs]       = useState<Job[]>([]);
  const [stats,      setStats]      = useState<Stats | null>(null);
  const [total,      setTotal]      = useState(0);
  const [page,       setPage]       = useState(1);
  const [filter,     setFilter]     = useState<FilterStatus>('all');
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);

  // Actions
  const [actionMsg,  setActionMsg]  = useState<string | null>(null);
  const [actionErr,  setActionErr]  = useState<string | null>(null);
  const [resetting,  setResetting]  = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [cancelId,   setCancelId]   = useState<string | null>(null);

  // Auto-refresh
  const refreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Fetch jobs ─────────────────────────────────────────
  const fetchJobs = useCallback(async (pg = page, fil = filter) => {
    try {
      const params = new URLSearchParams({ page: String(pg), limit: String(PAGE_SIZE) });
      if (fil !== 'all') params.set('status', fil);

      const [jobsRes, statsRes] = await Promise.all([
        fetch(`${BACKEND}/jobs?${params}`, { headers: authHeaders() }),
        fetch(`${BACKEND}/jobs/stats`,     { headers: authHeaders() }),
      ]);

      if (!jobsRes.ok) {
        const raw = await jobsRes.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error(extractApiError(raw, jobsRes.status, 'Impossible de charger les conversions'));
      }

      const jobsRaw   = await jobsRes.json()  as unknown;
      const statsRaw  = statsRes.ok ? await statsRes.json() as unknown : null;

      const jobsData  = unwrap<{ data: Job[]; total: number }>(jobsRaw);
      const statsData = statsRaw ? unwrap<Stats>(statsRaw) : null;

      setJobs(Array.isArray(jobsData) ? jobsData : (jobsData.data ?? []));
      setTotal(Array.isArray(jobsData) ? jobsData.length : (jobsData.total ?? 0));
      if (statsData) setStats(statsData);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setLoading(false);
    }
  }, [page, filter]);

  // ── Initial load ───────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    void fetchJobs(page, filter);
  }, [page, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-refresh when active jobs present ──────────────
  useEffect(() => {
    const hasActive = stats && stats.active > 0;
    if (hasActive) {
      refreshRef.current = setInterval(() => void fetchJobs(page, filter), AUTO_REFRESH_MS);
    } else {
      if (refreshRef.current) clearInterval(refreshRef.current);
    }
    return () => {
      if (refreshRef.current) clearInterval(refreshRef.current);
    };
  }, [stats, page, filter, fetchJobs]);

  // ── Reset stale jobs ───────────────────────────────────
  const handleResetStale = async () => {
    setResetting(true);
    setActionMsg(null);
    setActionErr(null);
    try {
      const res = await fetch(`${BACKEND}/jobs/reset-stale`, {
        method: 'POST',
        headers: authHeaders(),
      });
      const raw = await res.json() as Record<string, unknown>;
      if (!res.ok) throw new Error(extractApiError(raw, res.status, 'Erreur reset'));
      const data = unwrap<{ message: string; cleared: number }>(raw);
      setActionMsg(data.message ?? `${data.cleared ?? 0} job(s) libéré(s)`);
      void fetchJobs(page, filter);
    } catch (err: unknown) {
      setActionErr(err instanceof Error ? err.message : 'Erreur reset');
    } finally {
      setResetting(false);
    }
  };

  // ── Retry a job ────────────────────────────────────────
  const handleRetry = async (job: Job) => {
    setRetryingId(job.id);
    setActionMsg(null);
    setActionErr(null);
    try {
      // Re-créer un job de conversion avec les mêmes paramètres
      const payload: Record<string, unknown> = {
        type:           job.type,
        sourceLanguage: job.sourceLanguage,
        targetLanguage: job.targetLanguage,
      };
      if (job.projectId) payload['projectId'] = job.projectId;
      if (job.sourceRepo) payload['sourceRepo'] = job.sourceRepo;

      const res = await fetch(`${BACKEND}/jobs`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body:    JSON.stringify(payload),
      });
      const raw = await res.json() as Record<string, unknown>;
      if (!res.ok) throw new Error(extractApiError(raw, res.status, 'Impossible de relancer'));
      const newJob = unwrap<Job>(raw);
      setActionMsg(`Job relancé avec succès (ID: ${newJob.id.slice(0, 8)}…)`);
      void fetchJobs(1, filter);
      setPage(1);
    } catch (err: unknown) {
      setActionErr(err instanceof Error ? err.message : 'Erreur relance');
    } finally {
      setRetryingId(null);
    }
  };

  // ── Cancel a job ──────────────────────────────────────
  const handleCancel = async (jobId: string) => {
    setCancelId(jobId);
    setActionMsg(null);
    setActionErr(null);
    try {
      const res = await fetch(`${BACKEND}/jobs/${jobId}`, {
        method:  'DELETE',
        headers: authHeaders(),
      });
      if (!res.ok) {
        const raw = await res.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error(extractApiError(raw, res.status, 'Impossible d\'annuler'));
      }
      setActionMsg('Job annulé avec succès.');
      void fetchJobs(page, filter);
    } catch (err: unknown) {
      setActionErr(err instanceof Error ? err.message : 'Erreur annulation');
    } finally {
      setCancelId(null);
    }
  };

  // ── Download result ───────────────────────────────────
  const handleDownload = async (job: Job) => {
    try {
      const res = await fetch(`${BACKEND}/jobs/${job.id}/download`, {
        headers: authHeaders(),
      });
      if (!res.ok) {
        const raw = await res.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error(extractApiError(raw, res.status, 'Téléchargement impossible'));
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `codemorph-${job.id.slice(0, 8)}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      setActionErr(err instanceof Error ? err.message : 'Erreur téléchargement');
    }
  };

  // ── Filters ────────────────────────────────────────────
  const FILTERS: { value: FilterStatus; label: string }[] = [
    { value: 'all',       label: 'Tous' },
    { value: 'pending',   label: 'En attente' },
    { value: 'analyzing', label: 'Analyse' },
    { value: 'converting',label: 'Conversion' },
    { value: 'done',      label: 'Terminés' },
    { value: 'failed',    label: 'Échecs' },
  ];

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const isActive   = (s: JobStatus) => ['pending', 'analyzing', 'converting'].includes(s);

  // ── Render ─────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-6 p-6">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl gradient-brand shadow-glow-sm">
            <History className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">Historique des conversions</h1>
            <p className="text-sm text-muted-foreground">
              Toutes vos conversions de code — actives, terminées, en échec
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Refresh manuel */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => { setLoading(true); void fetchJobs(page, filter); }}
            className="gap-2"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            Actualiser
          </Button>

          {/* Reset stuck jobs */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleResetStale()}
            disabled={resetting}
            className="gap-2 border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/10"
          >
            {resetting
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <AlertTriangle className="h-4 w-4" />
            }
            Libérer les jobs bloqués
          </Button>

          {/* Nouvelle conversion */}
          <Button
            size="sm"
            onClick={() => router.push('/dashboard/projects/new')}
            className="gap-2 gradient-brand text-white"
          >
            <Zap className="h-4 w-4" />
            Nouvelle conversion
          </Button>
        </div>
      </div>

      {/* ── Feedback messages ── */}
      {actionMsg && (
        <div className="flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-400">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          {actionMsg}
          <button onClick={() => setActionMsg(null)} className="ml-auto text-green-400/60 hover:text-green-400">✕</button>
        </div>
      )}
      {actionErr && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          <XCircle className="h-4 w-4 shrink-0" />
          {actionErr}
          <button onClick={() => setActionErr(null)} className="ml-auto text-red-400/60 hover:text-red-400">✕</button>
        </div>
      )}

      {/* ── Stats bar ── */}
      {stats && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard label="Total"       value={stats.total}     icon={<BarChart3    className="h-4 w-4 text-muted-foreground" />} />
          <StatCard label="Actifs"      value={stats.active}    icon={<Loader2      className="h-4 w-4 text-blue-400" />}        className={stats.active > 0 ? 'border-blue-500/30' : ''} />
          <StatCard label="En attente"  value={stats.pending}   icon={<Clock        className="h-4 w-4 text-yellow-400" />} />
          <StatCard label="Analyse"     value={stats.analyzing} icon={<Zap          className="h-4 w-4 text-blue-400" />} />
          <StatCard label="Terminés"    value={stats.done}      icon={<CheckCircle2 className="h-4 w-4 text-green-400" />} />
          <StatCard label="Échecs"      value={stats.failed}    icon={<XCircle      className="h-4 w-4 text-red-400" />} />
        </div>
      )}

      {/* ── Auto-refresh indicator ── */}
      {stats && stats.active > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-2.5 text-xs text-blue-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {stats.active} job(s) actif(s) — actualisation automatique toutes les 10 secondes
        </div>
      )}

      {/* ── Filters ── */}
      <div className="flex items-center gap-2 flex-wrap">
        <Filter className="h-4 w-4 text-muted-foreground shrink-0" />
        {FILTERS.map(f => (
          <button
            key={f.value}
            onClick={() => { setFilter(f.value); setPage(1); }}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              filter === f.value
                ? 'border-primary bg-primary/20 text-primary'
                : 'border-border bg-surface-0 text-muted-foreground hover:border-primary/50 hover:text-foreground',
            )}
          >
            {f.label}
            {f.value !== 'all' && stats && (
              <span className="ml-1.5 opacity-60">
                {f.value === 'pending'    && stats.pending}
                {f.value === 'analyzing'  && stats.analyzing}
                {f.value === 'converting' && stats.converting}
                {f.value === 'done'       && stats.done}
                {f.value === 'failed'     && stats.failed}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Table ── */}
      <Card className="border-border bg-surface-0">
        {loading ? (
          <CardContent className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </CardContent>
        ) : error ? (
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <XCircle className="h-8 w-8 text-red-400" />
            <p className="text-sm text-red-400">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void fetchJobs(page, filter)}>
              Réessayer
            </Button>
          </CardContent>
        ) : jobs.length === 0 ? (
          <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-surface-1">
              <History className="h-8 w-8 text-muted-foreground" />
            </div>
            <div>
              <p className="font-medium text-foreground">Aucune conversion</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {filter !== 'all'
                  ? `Aucune conversion avec le statut « ${filter} »`
                  : 'Lancez votre première conversion pour la voir apparaître ici'}
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => router.push('/dashboard/projects/new')}
              className="gap-2 gradient-brand text-white"
            >
              <Zap className="h-4 w-4" />
              Créer un projet
            </Button>
          </CardContent>
        ) : (
          <>
            {/* Header table */}
            <div className="hidden border-b border-border px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground lg:grid lg:grid-cols-[1fr_140px_100px_120px_90px_80px_160px]">
              <span>Projet / Source</span>
              <span>Conversion</span>
              <span>Type</span>
              <span>Statut</span>
              <span>Durée</span>
              <span>Fichiers</span>
              <span className="text-right">Actions</span>
            </div>

            {/* Rows */}
            <div className="divide-y divide-border">
              {jobs.map(job => (
                <div
                  key={job.id}
                  className="grid gap-2 px-4 py-3 transition-colors hover:bg-surface-1/50 lg:grid-cols-[1fr_140px_100px_120px_90px_80px_160px] lg:items-center"
                >
                  {/* Projet / Source */}
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground text-sm">
                      {job.project?.name ?? (job.sourceRepo?.split('/').pop()) ?? `Job ${job.id.slice(0, 8)}`}
                    </p>
                    {job.sourceRepo && (
                      <p className="truncate text-xs text-muted-foreground">{job.sourceRepo}</p>
                    )}
                    <ProgressBar progress={job.progress} status={job.status} />
                    {job.currentPhase && isActive(job.status) && (
                      <p className="mt-0.5 text-xs text-muted-foreground">{job.currentPhase}</p>
                    )}
                    {job.errorMessage && job.status === 'failed' && (
                      <p className="mt-0.5 truncate text-xs text-red-400" title={job.errorMessage}>
                        {job.errorMessage}
                      </p>
                    )}
                    <p className="mt-0.5 text-xs text-muted-foreground/60">{relativeTime(job.createdAt)}</p>
                  </div>

                  {/* Conversion src → tgt */}
                  <div className="flex items-center gap-1.5 text-xs">
                    {job.sourceLanguage ? (
                      <>
                        <span className="rounded bg-surface-1 px-1.5 py-0.5 font-mono text-[10px] text-foreground">
                          {job.sourceLanguage}
                        </span>
                        <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                        <span className="rounded bg-surface-1 px-1.5 py-0.5 font-mono text-[10px] text-foreground">
                          {job.targetLanguage ?? '?'}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </div>

                  {/* Type */}
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {jobTypeIcon(job.type)}
                    {jobTypeLabel(job.type)}
                  </div>

                  {/* Statut */}
                  <div>
                    <StatusBadge status={job.status} />
                  </div>

                  {/* Durée */}
                  <div className="text-xs text-muted-foreground">
                    {formatDuration(job.startedAt, job.completedAt)}
                  </div>

                  {/* Fichiers générés */}
                  <div className="text-xs text-muted-foreground">
                    {job.filesGenerated != null ? `${job.filesGenerated} fichiers` : '—'}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center justify-end gap-1.5 flex-wrap">
                    {/* Download — seulement si DONE */}
                    {job.status === 'done' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleDownload(job)}
                        className="h-7 gap-1.5 border-green-500/30 px-2 text-green-400 hover:bg-green-500/10 text-xs"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Télécharger
                      </Button>
                    )}

                    {/* Retry — si DONE ou FAILED */}
                    {(job.status === 'done' || job.status === 'failed') && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleRetry(job)}
                        disabled={retryingId === job.id}
                        className="h-7 gap-1.5 px-2 text-xs"
                      >
                        {retryingId === job.id
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          : <RotateCcw className="h-3.5 w-3.5" />
                        }
                        Relancer
                      </Button>
                    )}

                    {/* Cancel — si actif */}
                    {isActive(job.status) && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleCancel(job.id)}
                        disabled={cancelId === job.id}
                        className="h-7 gap-1.5 border-red-500/30 px-2 text-red-400 hover:bg-red-500/10 text-xs"
                      >
                        {cancelId === job.id
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          : <StopCircle className="h-3.5 w-3.5" />
                        }
                        Annuler
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between border-t border-border px-4 py-3">
                <p className="text-xs text-muted-foreground">
                  {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} sur {total} conversions
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="h-7 w-7 p-0"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Page {page} / {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                    className="h-7 w-7 p-0"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>

      {/* ── Info auto-refresh ── */}
      {stats && stats.active === 0 && jobs.length > 0 && (
        <p className="text-center text-xs text-muted-foreground">
          Aucun job actif — actualisation automatique suspendue
        </p>
      )}
    </div>
  );
}
