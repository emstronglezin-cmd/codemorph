'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getAccessToken } from '@/lib/api/client';

interface GeneratedFile {
  path: string;
  content: string;
  language: string;
  linesCount: number;
  warnings?: string[];
}

interface JobResult {
  id: string;
  status: string;
  sourceLanguage: string;
  targetLanguage: string;
  filesGenerated: number;
  linesGenerated: number;
  completedAt: string;
  result?: {
    files?: GeneratedFile[];
    outputZipUrl?: string;
    summary?: {
      filesProcessed?: number;
      filesGenerated?: number;
      framework?: string;
      sourceLanguage?: string;
      targetLanguage?: string;
    };
    sourceLanguage?: string;
    targetLanguage?: string;
    aiTier?: string;
    aiModel?: string;
  };
}

const BACKEND = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

const LANG_COLORS: Record<string, string> = {
  typescript: 'text-blue-400',
  javascript: 'text-yellow-400',
  dart: 'text-cyan-400',
  json: 'text-orange-400',
  css: 'text-pink-400',
  markdown: 'text-slate-400',
  default: 'text-muted-foreground',
};

function getLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    dart: 'dart', json: 'json', css: 'css', scss: 'css', md: 'markdown',
    yaml: 'yaml', yml: 'yaml',
  };
  return map[ext] ?? 'text';
}

function buildFileTree(files: GeneratedFile[]): Record<string, GeneratedFile[]> {
  const tree: Record<string, GeneratedFile[]> = {};
  for (const f of files) {
    const dir = f.path.includes('/') ? f.path.split('/').slice(0, -1).join('/') : '.';
    (tree[dir] ??= []).push(f);
  }
  return tree;
}

export default function ResultStudioPage() {
  const { id, jobId } = useParams<{ id: string; jobId: string }>();
  const [job, setJob] = useState<JobResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedFile, setSelectedFile] = useState<GeneratedFile | null>(null);
  const [pushLoading, setPushLoading] = useState(false);
  const [pushResult, setPushResult] = useState<{ url?: string; error?: string } | null>(null);
  const [pushRepo, setPushRepo] = useState('');
  const [showPushModal, setShowPushModal] = useState(false);
  const [activeTab, setActiveTab] = useState<'code' | 'diff'>('code');

  useEffect(() => {
    const load = async () => {
      try {
        // FIX PHASE 21: add Authorization header — fetch without it returns 401
        const token = getAccessToken();
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const res = await fetch(`${BACKEND}/jobs/${jobId}`, {
          credentials: 'include',
          headers,
        });
        if (res.ok) {
          const data = await res.json() as { data?: JobResult } | JobResult;
          const jobData = (data as { data?: JobResult }).data ?? (data as JobResult);
          setJob(jobData);
        } else {
          console.error(`[ResultStudio] fetch job failed: ${res.status} ${res.statusText}`);
        }
      } catch (err) {
        console.error('[ResultStudio] fetch job error:', err);
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [jobId]);

  const downloadZip = async () => {
    // FIX PHASE 21: use authenticated fetch() instead of <a>.click()
    // <a>.click() triggers browser navigation → no Authorization header → AUTH_002
    try {
      const token = getAccessToken();
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const downloadUrl = job?.result?.outputZipUrl ?? `${BACKEND}/jobs/${jobId}/download`;

      // If it's an external URL (outputZipUrl), use direct download
      if (job?.result?.outputZipUrl) {
        const a = document.createElement('a');
        a.href = job.result.outputZipUrl;
        a.download = `codemorph-result-${jobId.slice(0, 8)}.zip`;
        a.click();
        return;
      }

      // Otherwise use authenticated fetch()
      const res = await fetch(downloadUrl, { headers, credentials: 'include' });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({})) as { message?: string; code?: string };
        throw new Error(errData.message ?? `Download failed: ${res.status}`);
      }

      const blob  = await res.blob();
      const url   = URL.createObjectURL(blob);
      const a     = document.createElement('a');
      a.href      = url;
      a.download  = `codemorph-result-${jobId.slice(0, 8)}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('[ResultStudio] download failed:', err);
      alert(`Download failed: ${(err as Error).message}`);
    }
  };

  const pushToGitHub = async () => {
    if (!pushRepo) return;
    setPushLoading(true);
    setPushResult(null);
    try {
      const res = await fetch(`${BACKEND}/jobs/${jobId}/push-github`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ repo: pushRepo, branch: `codemorph/${jobId.slice(0, 8)}` }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message ?? 'Push failed');
      setPushResult({ url: data.prUrl ?? data.data?.prUrl });
    } catch (err) {
      setPushResult({ error: (err as Error).message });
    } finally {
      setPushLoading(false);
    }
  };

  // FIX PHASE 21: sourceLanguage/targetLanguage can be at root OR inside result
  const sourceLanguage = job?.sourceLanguage ?? job?.result?.sourceLanguage ?? job?.result?.summary?.sourceLanguage ?? '—';
  const targetLanguage = job?.targetLanguage ?? job?.result?.targetLanguage ?? job?.result?.summary?.targetLanguage ?? '—';
  const filesGenerated = job?.filesGenerated ?? job?.result?.summary?.filesGenerated ?? 0;
  const linesGenerated = job?.linesGenerated ?? 0;

  const files = (job?.result?.files ?? []).map((f) => ({
    ...f,
    linesCount: f.linesCount ?? f.content?.split('\n').length ?? 0,
  }));
  const fileTree = buildFileTree(files);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6 py-8">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/dashboard" className="hover:text-foreground">Dashboard</Link>
        <span>/</span>
        <Link href={`/dashboard/projects/${id}`} className="hover:text-foreground">Project</Link>
        <span>/</span>
        <span>Result</span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-3">
            Result Studio
            <Badge variant="success">Conversion Complete</Badge>
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {sourceLanguage} → {targetLanguage} ·{' '}
            {files.length > 0 ? files.length : filesGenerated} files · {linesGenerated.toLocaleString()} lines
            {job?.completedAt && ` · ${new Date(job.completedAt).toLocaleString()}`}
          </p>
        </div>
        <div className="flex gap-3">
          <Button variant="outline" onClick={downloadZip}>
            <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Download ZIP
          </Button>
          <Button variant="premium" onClick={() => setShowPushModal(true)}>
            <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
            </svg>
            Push to GitHub
          </Button>
        </div>
      </div>

      {/* Main layout: file tree + code viewer */}
      <div className="grid grid-cols-[280px_1fr] gap-6 h-[70vh]">
        {/* File tree */}
        <Card variant="elevated" className="overflow-hidden">
          <CardHeader className="py-3 px-4 border-b border-border">
            <CardTitle className="text-sm font-semibold">
              {files.length} Generated Files
            </CardTitle>
          </CardHeader>
          <div className="overflow-y-auto h-full">
            {Object.entries(fileTree).sort(([a], [b]) => a.localeCompare(b)).map(([dir, dirFiles]) => (
              <div key={dir}>
                <div className="px-4 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30 sticky top-0">
                  {dir === '.' ? '/' : `/${dir}`}
                </div>
                {dirFiles.map((file) => (
                  <button
                    key={file.path}
                    onClick={() => setSelectedFile(file)}
                    className={`w-full text-left px-4 py-2 text-sm flex items-center gap-2 hover:bg-muted/50 transition-colors ${selectedFile?.path === file.path ? 'bg-primary/10 text-primary border-r-2 border-primary' : 'text-foreground'}`}
                  >
                    <span className={`text-xs font-mono ${LANG_COLORS[getLanguage(file.path)] ?? LANG_COLORS.default}`}>
                      {file.path.split('.').pop()}
                    </span>
                    <span className="truncate">{file.path.split('/').pop()}</span>
                    <span className="ml-auto text-xs text-muted-foreground shrink-0">{file.linesCount}L</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </Card>

        {/* Code viewer */}
        <Card variant="elevated" className="overflow-hidden flex flex-col">
          {selectedFile ? (
            <>
              <CardHeader className="py-3 px-4 border-b border-border flex-row items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className={`text-sm font-mono font-semibold ${LANG_COLORS[getLanguage(selectedFile.path)] ?? LANG_COLORS.default}`}>
                    {selectedFile.path}
                  </span>
                  <Badge variant="secondary" size="sm">{selectedFile.linesCount} lines</Badge>
                </div>
                <div className="flex gap-1">
                  {['code', 'diff'].map((t) => (
                    <button
                      key={t}
                      onClick={() => setActiveTab(t as 'code' | 'diff')}
                      className={`px-3 py-1 text-xs rounded-md font-medium transition-colors ${activeTab === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                    >
                      {t === 'code' ? 'Generated' : 'Diff view'}
                    </button>
                  ))}
                </div>
              </CardHeader>
              <div className="flex-1 overflow-auto bg-zinc-950 rounded-b-xl">
                <pre className="p-4 text-xs font-mono text-zinc-300 leading-relaxed whitespace-pre-wrap">
                  {activeTab === 'diff' ? (
                    // Simple diff display — each line prefixed with "+"
                    selectedFile.content.split('\n').map((line, i) => (
                      <div key={i} className="flex gap-2">
                        <span className="text-green-500 select-none">+</span>
                        <span className="text-green-300/80">{line}</span>
                      </div>
                    ))
                  ) : (
                    selectedFile.content
                  )}
                </pre>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
              <div className="text-5xl mb-4">📂</div>
              <p className="text-muted-foreground font-medium">Select a file to view its contents</p>
              <p className="text-sm text-muted-foreground mt-1">{files.length} files generated</p>
            </div>
          )}
        </Card>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: 'Files Generated', value: files.length > 0 ? files.length : filesGenerated, icon: '📄' },
          { label: 'Lines of Code', value: linesGenerated.toLocaleString(), icon: '📝' },
          { label: 'Framework', value: `${sourceLanguage} → ${targetLanguage}`, icon: '🔄' },
          { label: 'Status', value: 'Complete', icon: '✅' },
        ].map((stat) => (
          <Card key={stat.label} className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <span>{stat.icon}</span>
              <span className="text-xs text-muted-foreground">{stat.label}</span>
            </div>
            <p className="text-xl font-bold text-foreground">{stat.value}</p>
          </Card>
        ))}
      </div>

      {/* Push to GitHub modal */}
      {showPushModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <Card variant="elevated" className="w-full max-w-md">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                </svg>
                Push to GitHub
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Creates a new branch <code className="bg-muted px-1 rounded text-xs">codemorph/{jobId.slice(0, 8)}</code> and opens a Pull Request.
              </p>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Target Repository (owner/repo)</label>
                <input
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                  placeholder="your-org/your-repo"
                  value={pushRepo}
                  onChange={(e) => setPushRepo(e.target.value)}
                />
              </div>
              {pushResult?.url && (
                <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-sm">
                  ✅ PR created:{' '}
                  <a href={pushResult.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                    {pushResult.url}
                  </a>
                </div>
              )}
              {pushResult?.error && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
                  ⚠️ {pushResult.error}
                </div>
              )}
              <div className="flex gap-3">
                <Button variant="outline" className="flex-1" onClick={() => setShowPushModal(false)}>
                  Cancel
                </Button>
                <Button
                  variant="premium"
                  className="flex-1"
                  disabled={!pushRepo || pushLoading}
                  loading={pushLoading}
                  onClick={pushToGitHub}
                >
                  Create PR
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
