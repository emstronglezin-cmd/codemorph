'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface PhaseLog {
  phase: string;
  status: string;
  message: string;
  timestamp: string;
}

interface Job {
  id: string;
  status: string;
  sourceLanguage: string;
  targetLanguage: string;
  progress: number;
  currentPhase?: string;
  phaseLogs?: PhaseLog[];
  errorMessage?: string;
  filesGenerated?: number;
  linesGenerated?: number;
  startedAt?: string;
  completedAt?: string;
}

const BACKEND = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

const PIPELINE_PHASES = [
  { id: 'ast-analysis', label: 'AST Analysis', icon: '🔍', desc: 'Parsing source files & extracting imports' },
  { id: 'architecture-detection', label: 'Architecture Detection', icon: '🏗️', desc: 'Identifying patterns & design layers' },
  { id: 'ir-generation', label: 'IR Generation', icon: '🧠', desc: 'Building Intermediate Representation via GPT-4o' },
  { id: 'mapping', label: 'Framework Mapping', icon: '🗺️', desc: 'Mapping components to target framework' },
  { id: 'code-planning', label: 'Code Planning', icon: '📋', desc: 'Planning output file structure' },
  { id: 'validation', label: 'Validation', icon: '✅', desc: 'Validating IR completeness & consistency' },
];

const STATUS_COLOR: Record<string, string> = {
  pending: 'text-muted-foreground',
  analyzing: 'text-blue-400',
  converting: 'text-violet-400',
  done: 'text-green-400',
  failed: 'text-red-400',
};

const STATUS_BADGE: Record<string, 'default' | 'warning' | 'info' | 'success' | 'error'> = {
  pending: 'warning',
  analyzing: 'info',
  converting: 'info',
  done: 'success',
  failed: 'error',
};

export default function JobTrackingPage() {
  const { id, jobId } = useParams<{ id: string; jobId: string }>();
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  const fetchJob = async () => {
    const res = await fetch(`${BACKEND}/jobs/${jobId}`, { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      const j = data.data ?? data;
      setJob(j);
      if (['done', 'failed'].includes(j.status)) {
        clearInterval(pollRef.current);
      }
    }
    setLoading(false);
  };

  useEffect(() => {
    void fetchJob();
    pollRef.current = setInterval(fetchJob, 3000);
    return () => clearInterval(pollRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [job?.phaseLogs?.length]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const phaseProgress = (phaseId: string) => {
    if (!job?.phaseLogs) return 'pending';
    const logs = job.phaseLogs.filter((l) => l.phase === phaseId);
    if (!logs.length) return 'pending';
    if (logs.some((l) => l.status === 'done')) return 'done';
    return 'running';
  };

  const elapsed = job?.startedAt
    ? Math.round((Date.now() - new Date(job.startedAt).getTime()) / 1000)
    : 0;

  return (
    <div className="max-w-4xl mx-auto space-y-6 py-8">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/dashboard" className="hover:text-foreground">Dashboard</Link>
        <span>/</span>
        <Link href={`/dashboard/projects/${id}`} className="hover:text-foreground">Project</Link>
        <span>/</span>
        <span>Job {jobId.slice(0, 8)}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-3">
            <span>{job?.sourceLanguage} → {job?.targetLanguage}</span>
            {job && <Badge variant={STATUS_BADGE[job.status] ?? 'default'}>{job.status}</Badge>}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Job ID: <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">{jobId}</code>
            {job?.startedAt && ` · Started ${new Date(job.startedAt).toLocaleTimeString()}`}
            {job?.status !== 'done' && job?.status !== 'failed' && elapsed > 0 && ` · ${elapsed}s elapsed`}
          </p>
        </div>
        {job?.status === 'done' && (
          <Link href={`/dashboard/projects/${id}/result/${jobId}`}>
            <Button variant="premium">View Results →</Button>
          </Link>
        )}
      </div>

      {/* Progress bar */}
      <Card variant="elevated">
        <CardContent className="pt-6">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-foreground">Overall Progress</span>
            <span className={`text-sm font-bold ${STATUS_COLOR[job?.status ?? 'pending']}`}>
              {job?.progress ?? 0}%
            </span>
          </div>
          <div className="h-2.5 bg-muted rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-700 ${job?.status === 'done' ? 'bg-green-500' : job?.status === 'failed' ? 'bg-red-500' : 'bg-gradient-to-r from-indigo-500 to-violet-500'}`}
              style={{ width: `${job?.progress ?? 0}%` }}
            />
          </div>
          {job?.status !== 'done' && job?.status !== 'failed' && job?.status !== 'pending' && (
            <div className="flex items-center gap-2 mt-3">
              <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              <span className="text-xs text-muted-foreground">
                {job?.currentPhase ? `Running: ${job.currentPhase}` : 'Initializing…'}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pipeline phases */}
      <Card variant="elevated">
        <CardHeader>
          <CardTitle>Pipeline Phases</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {PIPELINE_PHASES.map((phase, idx) => {
              const status = phaseProgress(phase.id);
              return (
                <div key={phase.id} className="flex items-start gap-4">
                  {/* Phase indicator */}
                  <div className="flex flex-col items-center gap-1 mt-1">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-colors ${status === 'done' ? 'bg-green-500/20 text-green-400 ring-2 ring-green-500/40' : status === 'running' ? 'bg-primary/20 text-primary ring-2 ring-primary/40 animate-pulse' : 'bg-muted text-muted-foreground'}`}>
                      {status === 'done' ? '✓' : phase.icon}
                    </div>
                    {idx < PIPELINE_PHASES.length - 1 && (
                      <div className={`w-0.5 h-6 ${status === 'done' ? 'bg-green-500/40' : 'bg-border'}`} />
                    )}
                  </div>
                  {/* Phase info */}
                  <div className="flex-1 pb-2">
                    <div className="flex items-center gap-2">
                      <span className={`font-medium text-sm ${status === 'running' ? 'text-primary' : status === 'done' ? 'text-foreground' : 'text-muted-foreground'}`}>
                        {phase.label}
                      </span>
                      {status === 'running' && (
                        <span className="text-xs text-primary animate-pulse">running…</span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{phase.desc}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Live logs */}
      {(job?.phaseLogs?.length ?? 0) > 0 && (
        <Card variant="elevated">
          <CardHeader>
            <CardTitle>Live Logs</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="bg-zinc-950 rounded-lg p-4 font-mono text-xs space-y-1 max-h-64 overflow-y-auto">
              {job?.phaseLogs?.map((log, i) => (
                <div key={i} className="flex gap-3 items-start">
                  <span className="text-zinc-500 shrink-0">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                  <span className={`shrink-0 ${log.status === 'done' ? 'text-green-400' : log.status === 'error' ? 'text-red-400' : 'text-blue-400'}`}>
                    [{log.phase}]
                  </span>
                  <span className="text-zinc-300">{log.message}</span>
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Error */}
      {job?.status === 'failed' && job.errorMessage && (
        <Card className="border-red-500/30 bg-red-500/5">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <span className="text-red-400 text-xl">⚠️</span>
              <div>
                <p className="font-semibold text-red-400">Conversion Failed</p>
                <p className="text-sm text-muted-foreground mt-1">{job.errorMessage}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Success */}
      {job?.status === 'done' && (
        <Card className="border-green-500/30 bg-green-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div className="flex items-start gap-3">
                <span className="text-green-400 text-xl">🎉</span>
                <div>
                  <p className="font-semibold text-green-400">Conversion Complete!</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {job.filesGenerated} files generated · {job.linesGenerated?.toLocaleString()} lines of code
                  </p>
                </div>
              </div>
              <Link href={`/dashboard/projects/${id}/result/${jobId}`}>
                <Button variant="premium" size="lg">View Results →</Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
