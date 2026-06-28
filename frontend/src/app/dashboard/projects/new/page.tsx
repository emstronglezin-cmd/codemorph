'use client';

// ============================================================
// CodeMorph — New Project (Phase 7 UX Refonte)
// Étape 1 : Nom + Description
// Étape 2 : Import Source
//   → GitHub : liste inline, recherche, pagination, choix branche
//   → ZIP    : drag & drop
//   → URL    : champ direct
// Étape 3 : Framework de conversion
// ============================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Github, Search, Lock, Globe, Star, Clock, Code2,
  Loader2, RefreshCw, ChevronLeft, ChevronRight,
  AlertCircle, ExternalLink, GitBranch, CheckCircle2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getAccessToken } from '@/lib/api/client';
import { cn } from '@/lib/utils/cn';

type ImportMethod = 'github' | 'zip' | 'url';
type Step = 1 | 2 | 3;

// ── Types ─────────────────────────────────────────────────
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
  defaultBranch: string;
}

interface ProgressStep {
  label: string;
  status: 'waiting' | 'running' | 'done' | 'error';
}

// ── Constants ─────────────────────────────────────────────
const BACKEND = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

const FRAMEWORKS = [
  { id: 'flutter-react',   source: 'Flutter',    target: 'React',        sourceLang: 'flutter',    targetLang: 'react',       icon: '🦋', badge: 'stable', desc: 'Dart + Flutter → React + TypeScript',              free: true  },
  { id: 'flutter-rn',      source: 'Flutter',    target: 'React Native', sourceLang: 'flutter',    targetLang: 'react-native', icon: '📱', badge: 'stable', desc: 'Dart + Flutter → Expo + React Native',             free: true  },
  { id: 'react-flutter',   source: 'React',      target: 'Flutter',      sourceLang: 'react',      targetLang: 'flutter',      icon: '🎯', badge: 'stable', desc: 'React + TypeScript → Flutter + Dart',              free: false },
  { id: 'express-nestjs',  source: 'Express.js', target: 'NestJS',       sourceLang: 'javascript', targetLang: 'typescript',   icon: '🐈', badge: 'stable', desc: 'Express.js REST API → NestJS enterprise',          free: false },
  { id: 'nodejs-nestjs',   source: 'Node.js',    target: 'NestJS',       sourceLang: 'javascript', targetLang: 'typescript',   icon: '🦅', badge: 'beta',   desc: 'Node.js vanilla → NestJS architecture modulaire',  free: false },
] as const;

const LANG_COLORS: Record<string, string> = {
  TypeScript: '#3178c6', JavaScript: '#f7df1e', Dart: '#00B4AB',
  Python: '#3776ab', Go: '#00ADD8', Rust: '#dea584', Java: '#b07219',
  Kotlin: '#A97BFF', Swift: '#fa7343', Ruby: '#701516', PHP: '#4F5D95',
};

// ── Helpers ───────────────────────────────────────────────
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = getAccessToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(extra ?? {}),
  };
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}d ago` : `${Math.floor(d / 30)}mo ago`;
}

function extractError(data: Record<string, unknown>, status: number, fallback: string): string {
  if (data['success'] === false) {
    const code = data['code'] ? ` [${data['code']}]` : '';
    const msg  = (data['message'] as string | undefined) ?? fallback;
    if (Array.isArray(data['errors']) && (data['errors'] as unknown[]).length > 0) {
      const errs = (data['errors'] as Array<{ message?: string }>).map(e => e.message).filter(Boolean).join(', ');
      return `${msg}${code}: ${errs}`;
    }
    return `${msg}${code}`;
  }
  return `HTTP ${status}: ${fallback}`;
}

function getProgressSteps(method: ImportMethod): ProgressStep[] {
  const base: ProgressStep[] = [{ label: 'Creating project…', status: 'waiting' }];
  if (method === 'zip')    base.push({ label: 'Uploading ZIP…',     status: 'waiting' });
  else if (method === 'url') base.push({ label: 'Fetching from URL…', status: 'waiting' });
  else                     base.push({ label: 'Connecting GitHub…',  status: 'waiting' });
  base.push({ label: 'Creating conversion job…', status: 'waiting' });
  base.push({ label: 'Worker started ✓',          status: 'waiting' });
  return base;
}

// ════════════════════════════════════════════════════════════
// Main Component
// ════════════════════════════════════════════════════════════
export default function NewProjectPage() {
  const router = useRouter();

  // Navigation
  const [step, setStep]     = useState<Step>(1);
  const [method, setMethod] = useState<ImportMethod>('github');
  const [framework, setFramework] = useState('');

  // UX state
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [progressSteps, setProgressSteps] = useState<ProgressStep[]>([]);

  // Step 1
  const [projectName, setProjectName] = useState('');
  const [description, setDescription] = useState('');

  // ZIP
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [zipPath, setZipPath] = useState('');

  // URL
  const [sourceUrl, setSourceUrl] = useState('');

  // GitHub state (managed inline)
  const [githubConnected, setGithubConnected] = useState<boolean | null>(null);
  const [ghRepos, setGhRepos]       = useState<GithubRepo[]>([]);
  const [ghLoading, setGhLoading]   = useState(false);
  const [ghError, setGhError]       = useState('');
  const [ghSearch, setGhSearch]     = useState('');
  const [ghFilter, setGhFilter]     = useState<'all' | 'public' | 'private'>('all');
  const [ghPage, setGhPage]         = useState(1);
  const [ghHasMore, setGhHasMore]   = useState(true);
  const [selectedRepo, setSelectedRepo] = useState<GithubRepo | null>(null);
  const [selectedBranch, setSelectedBranch] = useState('main');
  const [goalPrompt, setGoalPrompt] = useState('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── GitHub status check ─────────────────────────────────
  const checkGithub = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND}/auth/github-status`, { headers: authHeaders() });
      if (!res.ok) { setGithubConnected(false); return; }
      const d = await res.json() as { data?: { connected?: boolean }; connected?: boolean };
      setGithubConnected(d?.data?.connected ?? d?.connected ?? false);
    } catch { setGithubConnected(false); }
  }, []);

  // ── Fetch GitHub repos ──────────────────────────────────
  const fetchRepos = useCallback(async (p: number, q: string, f: string) => {
    setGhLoading(true);
    setGhError('');
    try {
      const params = new URLSearchParams({
        page: String(p), per_page: '24',
        ...(q ? { search: q } : {}),
        ...(f !== 'all' ? { type: f } : {}),
      });
      const res  = await fetch(`${BACKEND}/auth/github-repos?${params}`, { headers: authHeaders() });
      const body = await res.json() as Record<string, unknown>;

      if (!res.ok) {
        const msg  = (body['message'] as string | undefined) ?? 'Failed to load repositories';
        const code = (body['code'] as string | undefined) ?? '';
        if (code === 'GITHUB_NOT_CONNECTED' || msg.includes('not connected') || msg.includes('GITHUB_NOT_CONNECTED')) {
          setGithubConnected(false);
        } else {
          setGhError(msg);
        }
        return;
      }

      const inner = (body['data'] as Record<string, unknown> | undefined) ?? body;
      const list  = (inner['repos'] as GithubRepo[] | undefined) ?? (inner as { repos?: GithubRepo[] })?.repos ?? [];
      const more  = (inner['hasMore'] as boolean | undefined) ?? list.length === 24;
      setGhRepos(list);
      setGhHasMore(more);
    } catch (e) {
      setGhError(String(e));
    } finally {
      setGhLoading(false);
    }
  }, []);

  // Load repos when method becomes 'github' and connected
  useEffect(() => {
    if (method === 'github' && step === 2) {
      void checkGithub();
    }
  }, [method, step, checkGithub]);

  useEffect(() => {
    if (githubConnected === true && method === 'github' && step === 2) {
      void fetchRepos(ghPage, ghSearch, ghFilter);
    }
  }, [githubConnected, ghPage, ghFilter, method, step]); // eslint-disable-line

  const handleSearch = (val: string) => {
    setGhSearch(val);
    setGhPage(1);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => void fetchRepos(1, val, ghFilter), 400);
  };

  const selectRepo = (repo: GithubRepo) => {
    setSelectedRepo(repo);
    setSelectedBranch(repo.defaultBranch ?? 'main');
  };

  // ── Progress helpers ────────────────────────────────────
  const updateProgress = (idx: number, status: ProgressStep['status']) => {
    setProgressSteps(prev => {
      const next = [...prev];
      if (next[idx]) next[idx] = { ...next[idx], status };
      return next;
    });
  };

  // ── Upload ZIP ──────────────────────────────────────────
  const uploadZip = async (): Promise<string> => {
    if (!zipFile) throw new Error('No ZIP file selected');
    const token = getAccessToken();
    const fd = new FormData();
    fd.append('file', zipFile);
    const res  = await fetch(`${BACKEND}/uploads/zip`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd,
    });
    const raw = await res.json() as Record<string, unknown>;
    if (!res.ok) throw new Error(extractError(raw, res.status, 'Upload failed'));
    const inner = (raw['data'] as Record<string, unknown> | undefined) ?? raw;
    const p     = (inner['zipPath'] as string | undefined) ?? '';
    if (!p) throw new Error('ZIP uploaded but server returned no zipPath');
    setZipPath(p);
    return p;
  };

  // ── Main start handler ──────────────────────────────────
  const handleStart = async () => {
    if (!framework) { setError('Please select a conversion framework'); return; }

    // Validate import source
    if (method === 'github' && !selectedRepo) { setError('Please select a GitHub repository'); return; }
    if (method === 'zip'    && !zipFile)       { setError('Please upload a ZIP file'); return; }
    if (method === 'url'    && !sourceUrl.trim()) { setError('Please enter a public URL'); return; }

    setLoading(true);
    setError('');
    const steps = getProgressSteps(method);
    setProgressSteps(steps);

    try {
      const fw = FRAMEWORKS.find(f => f.id === framework)!;

      // Step 0: Create project
      updateProgress(0, 'running');
      const projRes = await fetch(`${BACKEND}/projects`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          name:           projectName.trim(),
          description:    description.trim() || undefined,
          sourceLanguage: fw.sourceLang,
          targetLanguage: fw.targetLang,
        }),
      });
      const projRaw = await projRes.json() as Record<string, unknown>;
      if (!projRes.ok) throw new Error(extractError(projRaw, projRes.status, 'Project creation failed'));
      const projData  = (projRaw['data'] as Record<string, unknown> | undefined) ?? projRaw;
      const projectId = (projData['id'] as string | undefined) ?? '';
      if (!projectId) throw new Error('Project created but server returned no ID');
      updateProgress(0, 'done');

      // Step 1: Import source
      updateProgress(1, 'running');
      let jobRes: Response;

      if (method === 'github') {
        if (!selectedRepo) throw new Error('No repository selected');
        jobRes = await fetch(`${BACKEND}/jobs/start/github`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            projectId,
            sourceLanguage: fw.sourceLang,
            targetLanguage: fw.targetLang,
            repo:           selectedRepo.fullName,
            branch:         selectedBranch,
            goalPrompt:     goalPrompt.trim() || undefined,
          }),
        });

      } else if (method === 'zip') {
        const zPath = zipPath || await uploadZip();
        updateProgress(1, 'done');
        updateProgress(2, 'running');
        jobRes = await fetch(`${BACKEND}/jobs/start/zip`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            projectId,
            sourceLanguage: fw.sourceLang,
            targetLanguage: fw.targetLang,
            zipPath:        zPath,
            goalPrompt:     goalPrompt.trim() || undefined,
          }),
        });

      } else {
        jobRes = await fetch(`${BACKEND}/jobs/start/url`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            projectId,
            sourceLanguage: fw.sourceLang,
            targetLanguage: fw.targetLang,
            sourceUrl:      sourceUrl.trim(),
            goalPrompt:     goalPrompt.trim() || undefined,
          }),
        });
      }

      updateProgress(1, 'done');

      // Step 2: Read job response
      updateProgress(2, 'running');
      const jobRaw = await jobRes.json() as Record<string, unknown>;
      if (!jobRes.ok) throw new Error(extractError(jobRaw, jobRes.status, 'Job creation failed'));
      const jobData = (jobRaw['data'] as Record<string, unknown> | undefined) ?? jobRaw;
      const jobId   = (jobData['id'] as string | undefined) ?? '';
      if (!jobId) throw new Error('Job created but server returned no ID');

      // Job immediately FAILED (Redis unavailable etc.)
      if ((jobData['status'] as string) === 'failed') {
        throw new Error((jobData['errorMessage'] as string | undefined) ?? 'Job failed immediately after creation');
      }
      updateProgress(2, 'done');
      updateProgress(3, 'done');

      router.push(`/dashboard/projects/${projectId}/job/${jobId}`);

    } catch (err) {
      setError((err as Error).message);
      setProgressSteps(prev => {
        const idx = prev.findIndex(s => s.status === 'running');
        if (idx < 0) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx], status: 'error' };
        return next;
      });
    } finally {
      setLoading(false);
    }
  };

  const connectGitHub = () => {
    const base = BACKEND.replace('/api/v1', '');
    window.location.href = `${base}/api/v1/auth/github`;
  };

  // ── Step labels ─────────────────────────────────────────
  const STEP_LABELS = ['Project Details', 'Import Source', 'Conversion Target'] as const;

  return (
    <div className="max-w-4xl mx-auto space-y-8 py-8 px-4">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-foreground">New Conversion Project</h1>
        <p className="text-muted-foreground mt-1">Import your source code and choose a conversion target</p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-3 flex-wrap">
        {STEP_LABELS.map((label, i) => (
          <div key={label} className="flex items-center gap-2">
            <div className={cn(
              'w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold transition-colors',
              step > i + 1 ? 'bg-green-500 text-white'
                : step === i + 1 ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground',
            )}>
              {step > i + 1 ? '✓' : i + 1}
            </div>
            <span className={cn('text-sm font-medium', step === i + 1 ? 'text-foreground' : 'text-muted-foreground')}>
              {label}
            </span>
            {i < 2 && <div className="w-8 h-px bg-border" />}
          </div>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════
          STEP 1 — Project Details
      ══════════════════════════════════════════════════ */}
      {step === 1 && (
        <Card variant="elevated">
          <CardHeader>
            <CardTitle>Project Details</CardTitle>
            <CardDescription>Give your project a name and description</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input
              label="Project name"
              placeholder="my-flutter-to-react"
              value={projectName}
              onChange={e => setProjectName(e.target.value)}
              required
            />
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Description (optional)</label>
              <textarea
                className="w-full min-h-[80px] rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                placeholder="Describe what this project does…"
                value={description}
                onChange={e => setDescription(e.target.value)}
              />
            </div>
            <Button onClick={() => setStep(2)} disabled={!projectName.trim()} className="w-full" variant="premium">
              Continue →
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ══════════════════════════════════════════════════
          STEP 2 — Import Source
      ══════════════════════════════════════════════════ */}
      {step === 2 && (
        <Card variant="elevated">
          <CardHeader>
            <CardTitle>Import Source Code</CardTitle>
            <CardDescription>Choose how to import your codebase</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">

            {/* Method selector */}
            <div className="grid grid-cols-3 gap-3">
              {([
                { id: 'github', label: 'GitHub Repo', icon: '🐙' },
                { id: 'zip',    label: 'Upload ZIP',  icon: '📦' },
                { id: 'url',    label: 'Public URL',  icon: '🔗' },
              ] as { id: ImportMethod; label: string; icon: string }[]).map(m => (
                <button
                  key={m.id}
                  onClick={() => { setMethod(m.id); setSelectedRepo(null); }}
                  className={cn(
                    'p-4 rounded-xl border-2 text-center transition-all',
                    method === m.id ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40',
                  )}
                >
                  <div className="text-2xl mb-1">{m.icon}</div>
                  <div className="text-sm font-medium">{m.label}</div>
                </button>
              ))}
            </div>

            {/* ── GITHUB INLINE ───────────────────────── */}
            {method === 'github' && (
              <div className="space-y-4">
                {/* Not connected */}
                {githubConnected === false && (
                  <div className="flex flex-col items-center gap-4 py-8 text-center">
                    <div className="h-14 w-14 rounded-2xl border border-border bg-surface-1 flex items-center justify-center">
                      <Github className="h-7 w-7 text-foreground" />
                    </div>
                    <div>
                      <p className="font-semibold text-foreground">Connect your GitHub account</p>
                      <p className="text-sm text-muted-foreground mt-1 max-w-xs mx-auto">
                        Authorize CodeMorph to access your public and private repositories.
                      </p>
                    </div>
                    <button
                      onClick={connectGitHub}
                      className="flex items-center gap-2.5 rounded-xl bg-foreground px-5 py-2.5 text-sm font-semibold text-background hover:opacity-90 transition-opacity shadow-md"
                    >
                      <Github className="h-4 w-4" />
                      Connect GitHub
                    </button>
                  </div>
                )}

                {/* Loading state */}
                {githubConnected === null && (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                )}

                {/* Connected — show repos */}
                {githubConnected === true && (
                  <>
                    {/* Selected repo display */}
                    {selectedRepo && (
                      <div className="rounded-xl border-2 border-primary bg-primary/5 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <CheckCircle2 className="h-5 w-5 text-primary shrink-0" />
                            <div className="min-w-0">
                              <p className="font-semibold text-sm text-foreground truncate">{selectedRepo.fullName}</p>
                              {selectedRepo.description && (
                                <p className="text-xs text-muted-foreground truncate">{selectedRepo.description}</p>
                              )}
                            </div>
                          </div>
                          <button
                            onClick={() => setSelectedRepo(null)}
                            className="text-xs text-muted-foreground hover:text-foreground shrink-0"
                          >
                            Change
                          </button>
                        </div>
                        {/* Branch selector */}
                        <div className="mt-3 flex items-center gap-2">
                          <GitBranch className="h-4 w-4 text-muted-foreground shrink-0" />
                          <Input
                            label=""
                            placeholder="Branch (e.g. main)"
                            value={selectedBranch}
                            onChange={e => setSelectedBranch(e.target.value)}
                            className="h-8 text-sm py-1"
                          />
                        </div>
                      </div>
                    )}

                    {/* Repo list */}
                    {!selectedRepo && (
                      <>
                        {/* Search + filter */}
                        <div className="flex flex-col sm:flex-row gap-2">
                          <div className="relative flex-1">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                            <input
                              type="text"
                              placeholder="Search repositories…"
                              value={ghSearch}
                              onChange={e => handleSearch(e.target.value)}
                              className="w-full rounded-lg border border-border bg-surface-1 py-2 pl-8 pr-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all"
                            />
                          </div>
                          <div className="flex gap-1 rounded-lg border border-border bg-surface-1 p-0.5">
                            {(['all', 'public', 'private'] as const).map(f => (
                              <button
                                key={f}
                                onClick={() => { setGhFilter(f); setGhPage(1); void fetchRepos(1, ghSearch, f); }}
                                className={cn(
                                  'rounded px-2.5 py-1 text-xs font-medium capitalize transition-all',
                                  ghFilter === f ? 'bg-background text-foreground shadow-sm border border-border' : 'text-muted-foreground hover:text-foreground',
                                )}
                              >
                                {f === 'all' ? 'All' : f === 'public' ? '🌐 Public' : '🔒 Private'}
                              </button>
                            ))}
                          </div>
                          <button
                            onClick={() => void fetchRepos(ghPage, ghSearch, ghFilter)}
                            className="flex items-center gap-1.5 rounded-lg border border-border bg-surface-1 px-2.5 py-1.5 text-xs hover:bg-surface-2 transition-colors"
                          >
                            <RefreshCw className={cn('h-3.5 w-3.5', ghLoading && 'animate-spin')} />
                          </button>
                        </div>

                        {/* Error */}
                        {ghError && (
                          <div className="flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                            <AlertCircle className="h-4 w-4 shrink-0" />
                            {ghError}
                          </div>
                        )}

                        {/* Loading skeleton */}
                        {ghLoading && (
                          <div className="space-y-2">
                            {Array.from({ length: 4 }).map((_, i) => (
                              <div key={i} className="rounded-lg border border-border bg-card p-3 animate-pulse">
                                <div className="h-3.5 bg-muted rounded w-1/3 mb-2" />
                                <div className="h-3 bg-muted rounded w-2/3" />
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Repo list */}
                        {!ghLoading && ghRepos.length === 0 && !ghError && (
                          <div className="flex flex-col items-center justify-center py-8 gap-2 text-muted-foreground">
                            <Github className="h-8 w-8 opacity-30" />
                            <p className="text-sm">No repositories found</p>
                            {ghSearch && (
                              <button onClick={() => handleSearch('')} className="text-xs text-primary hover:underline">
                                Clear search
                              </button>
                            )}
                          </div>
                        )}

                        <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                          {ghRepos.map(repo => (
                            <RepoRow
                              key={repo.id}
                              repo={repo}
                              onSelect={() => selectRepo(repo)}
                            />
                          ))}
                        </div>

                        {/* Pagination */}
                        {(ghPage > 1 || ghHasMore) && !ghLoading && (
                          <div className="flex items-center justify-center gap-3">
                            <button
                              onClick={() => setGhPage(p => Math.max(1, p - 1))}
                              disabled={ghPage === 1}
                              className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs disabled:opacity-40 hover:bg-surface-1 transition-colors"
                            >
                              <ChevronLeft className="h-3.5 w-3.5" /> Prev
                            </button>
                            <span className="text-xs text-muted-foreground">Page {ghPage}</span>
                            <button
                              onClick={() => setGhPage(p => p + 1)}
                              disabled={!ghHasMore}
                              className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs disabled:opacity-40 hover:bg-surface-1 transition-colors"
                            >
                              Next <ChevronRight className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            )}

            {/* ── ZIP ───────────────────────────────────── */}
            {method === 'zip' && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-foreground">ZIP file (max 50MB)</label>
                <div
                  className="border-2 border-dashed border-border rounded-xl p-8 text-center cursor-pointer hover:border-primary/40 transition-colors"
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => { e.preventDefault(); setZipFile(e.dataTransfer.files[0] ?? null); setZipPath(''); }}
                  onClick={() => document.getElementById('zip-input')?.click()}
                >
                  <div className="text-4xl mb-2">📦</div>
                  <p className="text-sm text-muted-foreground">
                    {zipFile ? zipFile.name : 'Drag & drop or click to select a ZIP file'}
                  </p>
                  {zipFile && <p className="text-xs text-muted-foreground mt-1">{(zipFile.size / 1024 / 1024).toFixed(2)} MB</p>}
                </div>
                <input
                  id="zip-input" type="file" accept=".zip" className="hidden"
                  onChange={e => { setZipFile(e.target.files?.[0] ?? null); setZipPath(''); }}
                />
              </div>
            )}

            {/* ── URL ───────────────────────────────────── */}
            {method === 'url' && (
              <div className="space-y-3">
                <Input
                  label="Public repository URL"
                  placeholder="https://github.com/owner/repo/archive/refs/heads/main.zip"
                  value={sourceUrl}
                  onChange={e => setSourceUrl(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  💡 For GitHub: use the archive URL format&nbsp;
                  <code className="bg-muted px-1 rounded text-xs">
                    https://github.com/OWNER/REPO/archive/refs/heads/BRANCH.zip
                  </code>
                </p>
              </div>
            )}

            {/* Goal prompt (shared) */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Conversion goal (optional)</label>
              <textarea
                className="w-full min-h-[70px] rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                placeholder="Describe specific requirements, e.g. 'Use Zustand for state, keep the same folder structure'…"
                value={goalPrompt}
                onChange={e => setGoalPrompt(e.target.value)}
              />
            </div>

            <div className="flex gap-3">
              <Button variant="outline" onClick={() => setStep(1)} className="flex-1">← Back</Button>
              <Button
                variant="premium"
                className="flex-1"
                disabled={
                  method === 'github' ? (!githubConnected || !selectedRepo)
                  : method === 'zip'  ? !zipFile
                  : !sourceUrl.trim()
                }
                onClick={() => setStep(3)}
              >
                Continue →
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ══════════════════════════════════════════════════
          STEP 3 — Conversion Framework
      ══════════════════════════════════════════════════ */}
      {step === 3 && (
        <Card variant="elevated">
          <CardHeader>
            <CardTitle>Choose Conversion Framework</CardTitle>
            <CardDescription>Select the source → target stack for AI conversion</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">

            {/* Progress (while loading) */}
            {loading && progressSteps.length > 0 && (
              <div className="p-4 rounded-xl border border-border bg-muted/30 space-y-2.5">
                <p className="text-sm font-semibold text-foreground mb-3">🚀 Starting conversion…</p>
                {progressSteps.map((s, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className={cn(
                      'w-5 h-5 rounded-full flex items-center justify-center text-xs flex-shrink-0',
                      s.status === 'done'    ? 'bg-green-500 text-white'
                      : s.status === 'running' ? 'bg-primary text-white animate-pulse'
                      : s.status === 'error'   ? 'bg-red-500 text-white'
                      : 'bg-muted-foreground/20 text-muted-foreground',
                    )}>
                      {s.status === 'done' ? '✓' : s.status === 'running' ? '⟳' : s.status === 'error' ? '✗' : '·'}
                    </div>
                    <span className={cn(
                      'text-sm',
                      s.status === 'done'    ? 'text-green-500 line-through'
                      : s.status === 'running' ? 'text-foreground font-medium'
                      : s.status === 'error'   ? 'text-red-400'
                      : 'text-muted-foreground',
                    )}>
                      {s.label}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 space-y-1">
                <p className="text-sm font-semibold text-red-400">❌ Failed to start conversion</p>
                <p className="text-sm text-red-400/80 break-words">{error}</p>
                {error.includes('CONCURRENT_LIMIT') || error.includes('active job') ? (
                  <p className="text-xs text-muted-foreground mt-2">
                    💡 Go to{' '}
                    <a href="/dashboard/history" className="text-primary underline">History</a>
                    {' '}to see your active jobs, or wait for them to complete.
                  </p>
                ) : null}
              </div>
            )}

            {/* Framework cards */}
            {!loading && (
              <div className="grid grid-cols-1 gap-3">
                {FRAMEWORKS.map(fw => (
                  <button
                    key={fw.id}
                    onClick={() => setFramework(fw.id)}
                    className={cn(
                      'p-4 rounded-xl border-2 text-left transition-all',
                      framework === fw.id ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40',
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{fw.icon}</span>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-foreground">{fw.source}</span>
                          <span className="text-muted-foreground">→</span>
                          <span className="font-semibold text-foreground">{fw.target}</span>
                          <Badge variant="success" size="sm">{fw.badge}</Badge>
                          {!fw.free && <Badge variant="warning" size="sm">Pro</Badge>}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">{fw.desc}</p>
                      </div>
                      {framework === fw.id && (
                        <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center text-white text-xs shrink-0">✓</div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Summary */}
            {framework && !loading && (
              <div className="rounded-lg border border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground space-y-1">
                <p><span className="font-medium text-foreground">Source:</span>{' '}
                  {method === 'github' && selectedRepo ? `GitHub: ${selectedRepo.fullName}@${selectedBranch}`
                    : method === 'zip' ? `ZIP: ${zipFile?.name ?? 'uploaded file'}`
                    : `URL: ${sourceUrl}`}
                </p>
                <p><span className="font-medium text-foreground">Framework:</span>{' '}
                  {FRAMEWORKS.find(f => f.id === framework)?.source} → {FRAMEWORKS.find(f => f.id === framework)?.target}
                </p>
              </div>
            )}

            <div className="flex gap-3">
              <Button variant="outline" onClick={() => setStep(2)} className="flex-1" disabled={loading}>← Back</Button>
              <Button
                variant="premium"
                className="flex-1"
                disabled={!framework || loading}
                loading={loading}
                onClick={handleStart}
              >
                {loading ? 'Starting…' : '🚀 Start Conversion'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Repo Row ──────────────────────────────────────────────
function RepoRow({ repo, onSelect }: { repo: GithubRepo; onSelect: () => void }) {
  const langColor = repo.language ? (LANG_COLORS[repo.language] ?? '#94a3b8') : '#94a3b8';
  return (
    <div
      className="group flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 hover:border-primary/40 hover:bg-primary/2 transition-all cursor-pointer"
      onClick={onSelect}
    >
      {repo.private
        ? <Lock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        : <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm text-foreground truncate">{repo.name}</span>
          {repo.private && (
            <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded-full text-muted-foreground shrink-0">private</span>
          )}
        </div>
        {repo.description && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">{repo.description}</p>
        )}
      </div>

      <div className="flex items-center gap-3 text-[11px] text-muted-foreground shrink-0">
        {repo.language && (
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: langColor }} />
            {repo.language}
          </span>
        )}
        {repo.stars > 0 && (
          <span className="flex items-center gap-0.5">
            <Star className="h-3 w-3" />{repo.stars}
          </span>
        )}
        <span className="flex items-center gap-0.5 hidden sm:flex">
          <Clock className="h-3 w-3" />{relativeTime(repo.updatedAt)}
        </span>
      </div>

      <div className="flex items-center gap-1.5 ml-1">
        <a
          href={repo.url} target="_blank" rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          className="text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
        <div className="rounded-md bg-primary/10 px-2 py-1 text-xs font-semibold text-primary opacity-0 group-hover:opacity-100 transition-opacity">
          Select
        </div>
      </div>
    </div>
  );
}
