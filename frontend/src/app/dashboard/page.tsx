'use client';
// ============================================================
// CodeMorph — Dashboard Page
// PHASE 7 FIX : Source de vérité unique via React Query
//   - Suppression des fetch() bruts → useProjects + useJobs
//   - Suppression des console.log verbeux
//   - Données synchronisées cross-pages (cache React Query partagé)
//   - Polling auto si jobs actifs (refetchInterval dans useJobs)
// ============================================================
import type React from 'react';
import Link from 'next/link';
import {
  FolderGit2, Zap, CheckCircle2, TrendingUp, ArrowUpRight,
  Plus, Code2, GitBranch, Upload,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useProjects } from '@/hooks/useProjects';
import { useJobs } from '@/hooks/useJobs';

const STATUS_CFG: Record<string, { label: string; variant: 'success'|'warning'|'error'|'default'|'info' }> = {
  completed:  { label: 'Completed',  variant: 'success' },
  done:       { label: 'Done',       variant: 'success' },
  converting: { label: 'Converting', variant: 'warning' },
  analyzing:  { label: 'Analyzing',  variant: 'info'    },
  pending:    { label: 'Pending',    variant: 'default' },
  failed:     { label: 'Failed',     variant: 'error'   },
  active:     { label: 'Active',     variant: 'success' },
};

function StatCard({ label, value, delta, trend, icon: Icon, color, bg }: {
  label: string; value: string; delta: string; trend: string;
  icon: React.ElementType; color: string; bg: string;
}) {
  return (
    <Card className="stat-card">
      <CardContent className="p-6">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
            <p className="text-3xl font-bold tracking-tight">{value}</p>
            <p className={`flex items-center gap-1 text-xs ${trend === 'up' ? 'text-success' : 'text-muted-foreground'}`}>
              {trend === 'up' && <ArrowUpRight className="h-3 w-3" />}
              {delta}
            </p>
          </div>
          <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${bg}`}>
            <Icon className={`h-5 w-5 ${color}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function DashboardPage(): React.JSX.Element {
  // ── Source de vérité unique via React Query ───────────
  // Les données sont partagées et synchronisées avec toutes les autres pages
  const { data: projectsData, isLoading: projectsLoading } = useProjects(1, 20);
  const { data: jobsData, isLoading: jobsLoading } = useJobs(1, 50);

  const loading = projectsLoading || jobsLoading;

  const projects = projectsData?.data ?? [];
  const jobs     = jobsData?.data ?? [];

  const totalProjects  = projectsData?.total ?? projects.length;
  const activeJobs     = jobs.filter(j => ['pending','analyzing','converting'].includes(j.status)).length;
  const completedJobs  = jobs.filter(j => ['done','completed'].includes(j.status)).length;
  const failedJobs     = jobs.filter(j => j.status === 'failed').length;
  const successRate    = completedJobs + failedJobs > 0
    ? ((completedJobs / (completedJobs + failedJobs)) * 100).toFixed(1)
    : '100.0';

  const recentProjects = projects.slice(0, 5);
  const recentJobs     = jobs.slice(0, 4);

  const STATS = [
    { label:'Total Projects',      value: loading ? '…' : String(totalProjects),  delta: `${totalProjects} projet${totalProjects !== 1 ? 's' : ''}`,     trend:'neutral', icon:FolderGit2,   color:'text-brand-500', bg:'bg-brand-500/10' },
    { label:'Active Conversions',  value: loading ? '…' : String(activeJobs),     delta: activeJobs > 0 ? `${activeJobs} en cours` : 'Aucune en cours', trend:'neutral', icon:Zap,           color:'text-warning',   bg:'bg-warning/10'   },
    { label:'Completed',           value: loading ? '…' : String(completedJobs),  delta: `${completedJobs} au total`,                                    trend:'up',      icon:CheckCircle2,  color:'text-success',   bg:'bg-success/10'   },
    { label:'Success Rate',        value: loading ? '…' : `${successRate}%`,      delta: 'sur toutes les conversions',                                   trend:'up',      icon:TrendingUp,    color:'text-info',      bg:'bg-info/10'      },
  ];

  return (
    <div className="space-y-8 animate-fade-in">

      {/* ── Header ──────────────────────────────────── */}
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Bienvenue. Voici l&apos;état de vos projets.</p>
        </div>
        <Link href="/dashboard/projects/new">
          <Button leftIcon={<Plus className="h-4 w-4" />}>Nouveau projet</Button>
        </Link>
      </div>

      {/* ── Stats ───────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STATS.map(s => <StatCard key={s.label} {...s} />)}
      </div>

      {/* ── Projets récents + Actions rapides ─────── */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">

        {/* Projets récents */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between pb-3">
            <div>
              <CardTitle className="text-base">Projets récents</CardTitle>
              <CardDescription>Vos derniers projets de conversion</CardDescription>
            </div>
            <Link href="/dashboard/projects">
              <Button variant="ghost" size="sm" rightIcon={<ArrowUpRight className="h-3.5 w-3.5" />}>
                Voir tout
              </Button>
            </Link>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="divide-y divide-border">
                {[1,2,3].map(i => (
                  <div key={i} className="flex items-center gap-4 px-6 py-4">
                    <div className="h-9 w-9 rounded-lg bg-muted animate-pulse" />
                    <div className="flex-1 space-y-2">
                      <div className="h-3 w-1/2 rounded bg-muted animate-pulse" />
                      <div className="h-3 w-1/3 rounded bg-muted animate-pulse" />
                    </div>
                  </div>
                ))}
              </div>
            ) : recentProjects.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
                  <FolderGit2 className="h-6 w-6 text-primary" />
                </div>
                <p className="text-sm text-muted-foreground">Aucun projet pour l&apos;instant.</p>
                <Link href="/dashboard/projects/new">
                  <Button size="sm" variant="premium">
                    <Plus className="h-4 w-4 mr-1" /> Créer votre premier projet
                  </Button>
                </Link>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {recentProjects.map(project => {
                  const cfg = STATUS_CFG[project.status] ?? { label: project.status, variant: 'default' as const };
                  return (
                    <Link
                      key={project.id}
                      href={`/dashboard/projects/${project.id}`}
                      className="flex items-center gap-4 px-6 py-4 transition-colors hover:bg-accent/50"
                    >
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                        <Code2 className="h-4 w-4 text-primary" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{project.name}</p>
                        <p className="text-xs text-muted-foreground capitalize">
                          {project.sourceLanguage} → {project.targetLanguage}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <Badge variant={cfg.variant}>{cfg.label}</Badge>
                        <span className="hidden text-xs text-muted-foreground sm:block">
                          {new Date(project.createdAt).toLocaleDateString('fr-FR')}
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Actions rapides */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Actions rapides</CardTitle>
            <CardDescription>Démarrez en quelques clics</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <Link href="/dashboard/projects/new">
              <Button variant="premium" className="w-full justify-start gap-3" size="lg">
                <Plus className="h-4 w-4" /> Nouveau projet
              </Button>
            </Link>
            <Link href="/dashboard/projects/new">
              <Button variant="outline" className="w-full justify-start gap-3" size="lg">
                <GitBranch className="h-4 w-4 text-violet-400" /> Importer depuis GitHub
              </Button>
            </Link>
            <Link href="/dashboard/projects/new">
              <Button variant="outline" className="w-full justify-start gap-3" size="lg">
                <Upload className="h-4 w-4 text-blue-400" /> Uploader un ZIP
              </Button>
            </Link>
            <Link href="/dashboard/conversions">
              <Button variant="outline" className="w-full justify-start gap-3" size="lg">
                <Zap className="h-4 w-4 text-warning" /> Conversions actives
                {activeJobs > 0 && (
                  <span className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-warning/20 text-xs font-bold text-warning">
                    {activeJobs}
                  </span>
                )}
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>

      {/* ── Jobs récents ──────────────────────────── */}
      {!loading && recentJobs.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Activité récente</CardTitle>
            <CardDescription>Derniers jobs de conversion</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {recentJobs.map(job => {
                const cfg = STATUS_CFG[job.status] ?? { label: job.status, variant: 'default' as const };
                return (
                  <div key={job.id} className="flex items-center gap-4 px-6 py-3">
                    <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                      cfg.variant === 'success' ? 'bg-success/10' :
                      cfg.variant === 'warning' ? 'bg-warning/10' :
                      cfg.variant === 'error'   ? 'bg-red-500/10' : 'bg-muted'
                    }`}>
                      <Zap className={`h-4 w-4 ${
                        cfg.variant === 'success' ? 'text-success' :
                        cfg.variant === 'warning' ? 'text-warning' :
                        cfg.variant === 'error'   ? 'text-red-400' : 'text-muted-foreground'
                      }`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium capitalize">
                        {job.sourceLanguage} → {job.targetLanguage}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(job.createdAt).toLocaleString('fr-FR')}
                        {job.filesGenerated ? ` · ${job.filesGenerated} fichiers` : ''}
                      </p>
                      {['analyzing','converting'].includes(job.status) && (
                        <div className="mt-1 h-1 w-32 overflow-hidden rounded-full bg-muted">
                          <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${job.progress ?? 0}%` }} />
                        </div>
                      )}
                    </div>
                    <Badge variant={cfg.variant} size="sm">{cfg.label}</Badge>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
