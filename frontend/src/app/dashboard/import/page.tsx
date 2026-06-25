'use client';
// ============================================================
// CodeMorph — Import Repository Page
// Style Vercel/Railway : liste repos GitHub, search, pagination
// ============================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Github, Search, Lock, Globe, Star, GitFork, RefreshCw,
  AlertCircle, ExternalLink, ChevronLeft, ChevronRight, ArrowRight,
  Clock, Code2, Loader2
} from 'lucide-react';
import { getAccessToken } from '@/lib/api/client';
import { cn } from '@/lib/utils/cn';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

interface GithubRepo {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  url: string;
  description: string | null;
  language: string | null;
  updatedAt: string;
  stars: number;
  forks: number;
  defaultBranch: string;
  topics: string[];
}

const LANGUAGE_COLORS: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f7df1e',
  Dart:       '#00B4AB',
  Python:     '#3776ab',
  Go:         '#00ADD8',
  Rust:       '#dea584',
  Java:       '#b07219',
  Kotlin:     '#A97BFF',
  Swift:      '#fa7343',
  Ruby:       '#701516',
  PHP:        '#4F5D95',
  CSS:        '#563d7c',
  HTML:       '#e34c26',
  Shell:      '#89e051',
  Vue:        '#41b883',
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

function authHeaders(): Record<string, string> {
  const token = getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function ImportRepositoryPage() {
  const router = useRouter();
  const [repos, setRepos]           = useState<GithubRepo[]>([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [githubConnected, setGithubConnected] = useState<boolean | null>(null);
  const [search, setSearch]         = useState('');
  const [filter, setFilter]         = useState<'all' | 'public' | 'private'>('all');
  const [page, setPage]             = useState(1);
  const [hasMore, setHasMore]       = useState(true);
  const [selecting, setSelecting]   = useState<number | null>(null);
  const searchRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Check GitHub connection status ───────────────────
  const checkGithubStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/auth/github-status`, {
        headers: authHeaders(),
      });
      if (!res.ok) { setGithubConnected(false); return; }
      const data = await res.json() as { data?: { connected?: boolean }; connected?: boolean };
      const connected = data?.data?.connected ?? data?.connected ?? false;
      setGithubConnected(connected);
    } catch { setGithubConnected(false); }
  }, []);

  // ── Fetch repos ──────────────────────────────────────
  const fetchRepos = useCallback(async (p: number, q: string, f: string) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        page: String(p),
        per_page: '24',
        ...(q ? { search: q } : {}),
        ...(f !== 'all' ? { type: f } : {}),
      });
      const res = await fetch(`${API_URL}/auth/github-repos?${params}`, {
        headers: authHeaders(),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as {
          message?: string;
          code?: string;
          error?: { message?: string; code?: string };
        };
        // AllExceptionsFilter retourne { message, code, ... }
        // BadRequestException({ code: 'GITHUB_NOT_CONNECTED', ... }) retourne:
        //   { success: false, message: '...', code: 'GEN_003', ... }
        // mais le code interne est dans body.message si c'est un objet ou dans body.code
        const msg  = body?.message ?? body?.error?.message ?? 'Failed to fetch repositories';
        const code = body?.code ?? body?.error?.code ?? '';
        const isNotConnected =
          code === 'GITHUB_NOT_CONNECTED' ||
          msg.includes('GITHUB_NOT_CONNECTED') ||
          msg.includes('not connected') ||
          res.status === 400 && msg.includes('GitHub');
        if (isNotConnected) {
          setGithubConnected(false);
        } else {
          setError(msg);
        }
        return;
      }

      const data = await res.json() as {
        data?: { repos?: GithubRepo[]; total?: number; hasMore?: boolean };
        repos?: GithubRepo[];
      };
      const list: GithubRepo[]  = data?.data?.repos ?? (data as { repos?: GithubRepo[] })?.repos ?? [];
      const serverHasMore       = data?.data?.hasMore;
      setRepos(list);
      // Utiliser hasMore retourné par le backend si disponible, sinon heuristique
      setHasMore(serverHasMore !== undefined ? serverHasMore : list.length === 24);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void checkGithubStatus();
  }, [checkGithubStatus]);

  useEffect(() => {
    if (githubConnected === true) {
      void fetchRepos(page, search, filter);
    }
  }, [githubConnected, page, filter, fetchRepos]); // eslint-disable-line

  // Debounced search
  const handleSearch = (val: string) => {
    setSearch(val);
    setPage(1);
    if (searchRef.current) clearTimeout(searchRef.current);
    searchRef.current = setTimeout(() => {
      void fetchRepos(1, val, filter);
    }, 400);
  };

  // ── Select repo → redirect to new project ────────────
  const handleSelect = async (repo: GithubRepo) => {
    setSelecting(repo.id);
    // Store selection in sessionStorage, redirect to new project
    sessionStorage.setItem('cm_import_repo', JSON.stringify({
      fullName: repo.fullName,
      name: repo.name,
      branch: repo.defaultBranch,
      language: repo.language,
      private: repo.private,
    }));
    router.push(`/dashboard/projects/new?repo=${encodeURIComponent(repo.fullName)}&branch=${repo.defaultBranch}`);
  };

  // ── Connect GitHub ───────────────────────────────────
  const connectGitHub = () => {
    const backendBase = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1')
      .replace('/api/v1', '');
    window.location.href = `${backendBase}/api/v1/auth/github`;
  };

  // ── Not connected UI ─────────────────────────────────
  if (githubConnected === false) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6 px-4">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-border bg-surface-1 shadow-sm">
          <Github className="h-8 w-8 text-foreground" />
        </div>
        <div className="text-center max-w-md">
          <h1 className="text-2xl font-bold tracking-tight mb-2">Connect your GitHub account</h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Authorize CodeMorph to access your repositories (public &amp; private).
            We use <code className="text-xs">repo</code>, <code className="text-xs">read:user</code> and <code className="text-xs">user:email</code> scopes.
          </p>
        </div>
        <button
          onClick={connectGitHub}
          className="flex items-center gap-2.5 rounded-xl bg-foreground px-6 py-3 text-sm font-semibold text-background transition-all hover:opacity-90 shadow-md"
        >
          <Github className="h-4 w-4" />
          Connect GitHub
        </button>
        <Link href="/dashboard/projects/new" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
          Or import a ZIP instead →
        </Link>
      </div>
    );
  }

  const displayed = repos;

  return (
    <div className="flex flex-col gap-6 p-6 lg:p-8 max-w-screen-xl mx-auto w-full">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link
          href="/dashboard/projects/new"
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-surface-1 hover:bg-surface-2 transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="text-xl font-bold tracking-tight">Import Repository</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Select a GitHub repository to convert
          </p>
        </div>
        <button
          onClick={() => fetchRepos(page, search, filter)}
          className="ml-auto flex items-center gap-2 rounded-lg border border-border bg-surface-1 px-3 py-1.5 text-xs font-medium hover:bg-surface-2 transition-colors"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {/* Search + Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search repositories..."
            value={search}
            onChange={e => handleSearch(e.target.value)}
            className={cn(
              'w-full rounded-xl border border-border bg-surface-1 py-2.5 pl-9 pr-4',
              'text-sm placeholder:text-muted-foreground',
              'focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50',
              'transition-all'
            )}
          />
        </div>
        <div className="flex gap-1 rounded-xl border border-border bg-surface-1 p-1">
          {(['all', 'public', 'private'] as const).map(f => (
            <button
              key={f}
              onClick={() => { setFilter(f); setPage(1); void fetchRepos(1, search, f); }}
              className={cn(
                'rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition-all',
                filter === f
                  ? 'bg-background text-foreground shadow-sm border border-border'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {f === 'all' ? 'All' : f === 'public' ? <><Globe className="inline h-3 w-3 mr-1" />Public</> : <><Lock className="inline h-3 w-3 mr-1" />Private</>}
            </button>
          ))}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-3 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !repos.length && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-border bg-card p-4 animate-pulse">
              <div className="h-4 bg-muted rounded w-1/2 mb-3" />
              <div className="h-3 bg-muted rounded w-3/4 mb-2" />
              <div className="h-3 bg-muted rounded w-1/4" />
            </div>
          ))}
        </div>
      )}

      {/* Repos grid */}
      {!loading && displayed.length === 0 && !error && (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <Github className="h-10 w-10 text-muted-foreground/40" />
          <p className="text-sm font-medium text-muted-foreground">No repositories found</p>
          {search && (
            <button onClick={() => handleSearch('')} className="text-xs text-primary hover:underline">
              Clear search
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {displayed.map(repo => (
          <RepoCard
            key={repo.id}
            repo={repo}
            selecting={selecting === repo.id}
            onSelect={() => void handleSelect(repo)}
          />
        ))}
      </div>

      {/* Pagination */}
      {(page > 1 || hasMore) && (
        <div className="flex items-center justify-center gap-3 pt-2">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1 || loading}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium disabled:opacity-40 hover:bg-surface-1 transition-colors"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Previous
          </button>
          <span className="text-xs text-muted-foreground">Page {page}</span>
          <button
            onClick={() => setPage(p => p + 1)}
            disabled={!hasMore || loading}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium disabled:opacity-40 hover:bg-surface-1 transition-colors"
          >
            Next
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

// ── Repo Card ─────────────────────────────────────────────
interface RepoCardProps {
  repo: GithubRepo;
  selecting: boolean;
  onSelect: () => void;
}

function RepoCard({ repo, selecting, onSelect }: RepoCardProps) {
  const langColor = repo.language ? (LANGUAGE_COLORS[repo.language] ?? '#94a3b8') : '#94a3b8';

  return (
    <div className={cn(
      'group relative flex flex-col rounded-xl border border-border bg-card p-4',
      'transition-all duration-150 hover:border-primary/40 hover:shadow-md hover:shadow-primary/5',
      selecting && 'border-primary/60 shadow-md shadow-primary/5 opacity-75',
    )}>
      {/* Header row */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          {repo.private ? (
            <Lock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          ) : (
            <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}
          <span className="font-semibold text-sm text-foreground truncate">{repo.name}</span>
        </div>
        <a
          href={repo.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          className="shrink-0 text-muted-foreground hover:text-foreground transition-colors opacity-0 group-hover:opacity-100"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      {/* Description */}
      <p className="text-xs text-muted-foreground line-clamp-2 mb-3 min-h-[2rem]">
        {repo.description ?? <span className="italic opacity-50">No description</span>}
      </p>

      {/* Meta */}
      <div className="mt-auto flex items-center gap-3 text-[11px] text-muted-foreground">
        {repo.language && (
          <span className="flex items-center gap-1">
            <span
              className="h-2.5 w-2.5 rounded-full shrink-0"
              style={{ backgroundColor: langColor }}
            />
            {repo.language}
          </span>
        )}
        {repo.stars > 0 && (
          <span className="flex items-center gap-0.5">
            <Star className="h-3 w-3" />
            {repo.stars.toLocaleString()}
          </span>
        )}
        {repo.forks > 0 && (
          <span className="flex items-center gap-0.5">
            <GitFork className="h-3 w-3" />
            {repo.forks}
          </span>
        )}
        <span className="ml-auto flex items-center gap-0.5">
          <Clock className="h-3 w-3" />
          {relativeTime(repo.updatedAt)}
        </span>
      </div>

      {/* Topics */}
      {repo.topics.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {repo.topics.slice(0, 4).map(t => (
            <span key={t} className="rounded-full bg-primary/8 px-2 py-0.5 text-[10px] font-medium text-primary/80">
              {t}
            </span>
          ))}
          {repo.topics.length > 4 && (
            <span className="text-[10px] text-muted-foreground">+{repo.topics.length - 4}</span>
          )}
        </div>
      )}

      {/* CTA */}
      <button
        onClick={onSelect}
        disabled={selecting}
        className={cn(
          'mt-3 flex w-full items-center justify-center gap-2 rounded-lg py-2 text-xs font-semibold',
          'border border-border bg-surface-1 text-foreground',
          'transition-all hover:bg-primary hover:text-white hover:border-primary',
          'disabled:opacity-50',
        )}
      >
        {selecting ? (
          <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Selecting...</>
        ) : (
          <><Code2 className="h-3.5 w-3.5" /> Import <ArrowRight className="h-3 w-3 ml-auto" /></>
        )}
      </button>
    </div>
  );
}
