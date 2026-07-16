'use client';
// ============================================================
// CodeMorph — Page Projects (/dashboard/projects)
// PHASE 8 : Refonte complète
//   - Vraies données via useProjects() (React Query)
//   - Recherche client-side par nom/langage
//   - Filtres par statut
//   - Tri par date / nom
//   - Pagination (20/page)
//   - Actions : Ouvrir, Supprimer
//   - Empty state + skeleton loading
// ============================================================
import type React from 'react';
import { useState, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  FolderGit2, Plus, Search, Filter, Trash2,
  Code2, GitBranch, ChevronLeft, ChevronRight,
  ArrowUpDown, Loader2, RefreshCw, AlertCircle,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge }             from '@/components/ui/badge';
import { Button }            from '@/components/ui/button';
import { useProjects, useDeleteProject } from '@/hooks/useProjects';
import { cn }                from '@/lib/utils/cn';
import type { Project }      from '@/stores/project.store';

// ── Types ─────────────────────────────────────────────────
type SortKey   = 'createdAt' | 'name' | 'status';
type SortOrder = 'asc' | 'desc';
type StatusFilter = 'all' | 'active' | 'completed' | 'archived';

// ── Helpers ───────────────────────────────────────────────
const STATUS_CFG: Record<string, { label: string; variant: 'success'|'warning'|'error'|'default'|'info' }> = {
  active:    { label: 'Actif',    variant: 'success' },
  completed: { label: 'Terminé',  variant: 'info'    },
  archived:  { label: 'Archivé',  variant: 'default' },
  pending:   { label: 'En cours', variant: 'warning' },
};

function relTime(d: string) {
  const diff = Date.now() - new Date(d).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 60)   return `il y a ${m} min`;
  const h = Math.floor(diff / 3_600_000);
  if (h < 24)   return `il y a ${h} h`;
  const days = Math.floor(diff / 86_400_000);
  return `il y a ${days} j`;
}

// ── Skeleton row ─────────────────────────────────────────
function SkeletonRow() {
  return (
    <div className="flex items-center gap-4 px-6 py-4 border-b border-border">
      <div className="h-10 w-10 rounded-lg bg-muted animate-pulse shrink-0" />
      <div className="flex-1 space-y-2">
        <div className="h-3.5 w-1/3 rounded bg-muted animate-pulse" />
        <div className="h-3 w-1/4 rounded bg-muted animate-pulse" />
      </div>
      <div className="h-6 w-20 rounded-full bg-muted animate-pulse" />
      <div className="h-3 w-16 rounded bg-muted animate-pulse" />
    </div>
  );
}

// ── ProjectRow ────────────────────────────────────────────
function ProjectRow({ project, onDelete }: { project: Project; onDelete: (id: string) => void }) {
  const cfg    = STATUS_CFG[project.status] ?? { label: project.status, variant: 'default' as const };
  const router = useRouter();

  return (
    <div
      className="flex items-center gap-4 px-6 py-4 border-b border-border hover:bg-accent/30 transition-colors cursor-pointer group"
      onClick={() => router.push(`/dashboard/projects/${project.id}`)}
    >
      {/* Icône */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 group-hover:bg-primary/20 transition-colors">
        <Code2 className="h-5 w-5 text-primary" />
      </div>

      {/* Infos principales */}
      <div className="flex-1 min-w-0">
        <p className="truncate font-medium text-foreground text-sm">{project.name}</p>
        <div className="flex items-center gap-2 mt-0.5">
          {project.sourceLanguage && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <GitBranch className="h-3 w-3" />
              <span className="capitalize">{project.sourceLanguage}</span>
              {project.targetLanguage && (
                <> → <span className="capitalize">{project.targetLanguage}</span></>
              )}
            </span>
          )}
          {project.description && (
            <span className="hidden sm:block truncate text-xs text-muted-foreground max-w-xs">
              {project.description}
            </span>
          )}
        </div>
      </div>

      {/* Badge statut */}
      <Badge variant={cfg.variant} size="sm">{cfg.label}</Badge>

      {/* Date */}
      <span className="hidden text-xs text-muted-foreground sm:block whitespace-nowrap">
        {relTime(project.createdAt)}
      </span>

      {/* Supprimer */}
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(project.id); }}
        className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-md hover:bg-red-500/10 text-muted-foreground hover:text-red-400"
        title="Supprimer le projet"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────
const PAGE_SIZE = 20;

export default function ProjectsPage(): React.JSX.Element {
  const [page,         setPage]         = useState(1);
  const [search,       setSearch]       = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortKey,      setSortKey]      = useState<SortKey>('createdAt');
  const [sortOrder,    setSortOrder]    = useState<SortOrder>('desc');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // React Query — source de vérité unique
  const { data, isLoading, isError, refetch } = useProjects(1, 200); // charger tout pour tri/filtre client
  const deleteProject = useDeleteProject();

  const allProjects = data?.data ?? [];

  // ── Filtrer + trier ────────────────────────────────────
  const filtered = useMemo(() => {
    let list = allProjects;

    // Recherche
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(p =>
        p.name.toLowerCase().includes(q) ||
        (p.description ?? '').toLowerCase().includes(q) ||
        (p.sourceLanguage ?? '').toLowerCase().includes(q) ||
        (p.targetLanguage ?? '').toLowerCase().includes(q),
      );
    }

    // Filtre statut
    if (statusFilter !== 'all') {
      list = list.filter(p => p.status === statusFilter);
    }

    // Tri
    list = [...list].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'name')      cmp = a.name.localeCompare(b.name);
      if (sortKey === 'status')    cmp = (a.status ?? '').localeCompare(b.status ?? '');
      if (sortKey === 'createdAt') cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return sortOrder === 'asc' ? cmp : -cmp;
    });

    return list;
  }, [allProjects, search, statusFilter, sortKey, sortOrder]);

  // Pagination
  const totalPages     = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated      = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortOrder(o => o === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortOrder('desc'); }
  };

  const handleDelete = async (id: string) => {
    if (deleteConfirm !== id) { setDeleteConfirm(id); return; }
    await deleteProject.mutateAsync(id);
    setDeleteConfirm(null);
  };

  const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
    { value: 'all',       label: 'Tous' },
    { value: 'active',    label: 'Actifs' },
    { value: 'completed', label: 'Terminés' },
    { value: 'archived',  label: 'Archivés' },
  ];

  return (
    <div className="space-y-6">

      {/* ── Header ── */}
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Projets</h1>
          <p className="text-sm text-muted-foreground">
            {isLoading ? '…' : `${data?.total ?? 0} projet${(data?.total ?? 0) !== 1 ? 's' : ''} au total`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isLoading}>
            <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
          </Button>
          <Link href="/dashboard/projects/new">
            <Button leftIcon={<Plus className="h-4 w-4" />} variant="premium">
              Nouveau projet
            </Button>
          </Link>
        </div>
      </div>

      {/* ── Recherche + Filtres ── */}
      <div className="flex flex-col gap-3 sm:flex-row">
        {/* Recherche */}
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Rechercher par nom, langage…"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            className="w-full pl-9 pr-4 py-2 text-sm rounded-lg border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {/* Filtres statut */}
        <div className="flex items-center gap-2 flex-wrap">
          <Filter className="h-4 w-4 text-muted-foreground shrink-0" />
          {STATUS_FILTERS.map(f => (
            <button
              key={f.value}
              onClick={() => { setStatusFilter(f.value); setPage(1); }}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                statusFilter === f.value
                  ? 'border-primary bg-primary/20 text-primary'
                  : 'border-border bg-card text-muted-foreground hover:border-primary/50',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Tri rapide ── */}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>Trier par :</span>
        {(['name', 'createdAt', 'status'] as SortKey[]).map(key => (
          <button
            key={key}
            onClick={() => toggleSort(key)}
            className={cn(
              'flex items-center gap-1 rounded px-2 py-1 transition-colors hover:text-foreground',
              sortKey === key && 'text-primary',
            )}
          >
            {{ name: 'Nom', createdAt: 'Date', status: 'Statut' }[key]}
            <ArrowUpDown className="h-3 w-3" />
            {sortKey === key && <span className="text-[10px]">{sortOrder === 'asc' ? '↑' : '↓'}</span>}
          </button>
        ))}
        <span className="ml-auto">{filtered.length} résultat{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      {/* ── Liste projets ── */}
      <Card className="overflow-hidden">
        {isLoading ? (
          <div>
            {[1,2,3,4,5].map(i => <SkeletonRow key={i} />)}
          </div>
        ) : isError ? (
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <AlertCircle className="h-8 w-8 text-red-400" />
            <p className="text-sm text-red-400">Impossible de charger les projets</p>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              <RefreshCw className="h-4 w-4 mr-2" /> Réessayer
            </Button>
          </CardContent>
        ) : filtered.length === 0 ? (
          <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary/10">
              <FolderGit2 className="h-7 w-7 text-primary" />
            </div>
            <div>
              <p className="font-medium text-foreground">
                {search || statusFilter !== 'all' ? 'Aucun résultat' : 'Aucun projet'}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {search || statusFilter !== 'all'
                  ? 'Modifiez vos filtres pour voir plus de résultats.'
                  : 'Créez votre premier projet pour commencer.'}
              </p>
            </div>
            {!search && statusFilter === 'all' && (
              <Link href="/dashboard/projects/new">
                <Button variant="premium" size="sm" leftIcon={<Plus className="h-4 w-4" />}>
                  Créer un projet
                </Button>
              </Link>
            )}
          </CardContent>
        ) : (
          <>
            {/* En-tête colonnes */}
            <div className="hidden lg:grid lg:grid-cols-[1fr_160px_120px_100px_40px] items-center px-6 py-2.5 border-b border-border bg-muted/30 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <span>Projet</span>
              <span>Langages</span>
              <span>Statut</span>
              <span>Créé</span>
              <span />
            </div>

            {/* Lignes */}
            <div className="divide-y divide-border">
              {paginated.map(project => (
                <div key={project.id} className="relative">
                  <ProjectRow
                    project={project}
                    onDelete={(id) => void handleDelete(id)}
                  />
                  {/* Confirmation suppression */}
                  {deleteConfirm === project.id && (
                    <div className="absolute inset-0 flex items-center justify-end gap-3 px-6 bg-background/95 z-10 border border-red-500/30 rounded">
                      <span className="text-sm text-red-400">Supprimer ce projet ?</span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setDeleteConfirm(null)}
                      >
                        Annuler
                      </Button>
                      <Button
                        size="sm"
                        className="bg-red-500 hover:bg-red-600 text-white"
                        disabled={deleteProject.isPending}
                        onClick={() => void handleDelete(project.id)}
                      >
                        {deleteProject.isPending
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          : 'Confirmer'
                        }
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between border-t border-border px-6 py-3">
                <p className="text-xs text-muted-foreground">
                  {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} sur {filtered.length}
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
                    {page} / {totalPages}
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
    </div>
  );
}
