'use client';

// ============================================================
// CodeMorph — Project Detail Page
// FIX 13: Authorization Bearer header sur tous les fetch()
//          Polling auto pour les jobs en cours (toutes les 5s)
// ============================================================

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getAccessToken } from '@/lib/api/client';

interface Job {
  id:              string;
  type:            string;
  status:          string;
  sourceLanguage:  string;
  targetLanguage:  string;
  progress:        number;
  filesGenerated?: number;
  linesGenerated?: number;
  createdAt:       string;
  completedAt?:    string;
}

interface Project {
  id:           string;
  name:         string;
  description?: string;
  createdAt:    string;
}

const BACKEND = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

const STATUS_BADGE: Record<string, 'default' | 'warning' | 'success' | 'error' | 'info'> = {
  pending:    'warning',
  analyzing:  'info',
  converting: 'info',
  done:       'success',
  failed:     'error',
};

/** Construit les headers communs avec Authorization Bearer */
function authHeaders(): Record<string, string> {
  const token = getAccessToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** Parse la réponse NestJS wrappée dans { success, data } */
async function parseResponse<T>(res: Response): Promise<T | null> {
  if (!res.ok) return null;
  const body = await res.json() as { data?: T } | T;
  return ((body as { data?: T }).data ?? body) as T;
}

export default function ProjectPage() {
  const { id }    = useParams<{ id: string }>();
  const router    = useRouter();

  const [project, setProject] = useState<Project | null>(null);
  const [jobs, setJobs]       = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  // ── Chargement initial et polling ────────────────────────
  const load = useCallback(async () => {
    const headers = authHeaders();

    const [pRes, jRes] = await Promise.all([
      fetch(`${BACKEND}/projects/${id}`,       { headers }),
      fetch(`${BACKEND}/jobs/project/${id}`,   { headers }),
    ]);

    const projectData = await parseResponse<Project>(pRes);
    const jobsData    = await parseResponse<Job[]>(jRes);

    if (projectData) setProject(projectData);
    if (jobsData)    setJobs(Array.isArray(jobsData) ? jobsData : []);

    setLoading(false);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Polling toutes les 5 secondes si des jobs sont en cours
  useEffect(() => {
    const hasActiveJob = jobs.some((j) =>
      ['pending', 'analyzing', 'converting'].includes(j.status),
    );
    if (!hasActiveJob) return;

    const interval = setInterval(() => { void load(); }, 5_000);
    return () => clearInterval(interval);
  }, [jobs, load]);

  // ── Loading skeleton ──────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-8 py-8">
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
            <Link href="/dashboard" className="hover:text-foreground transition-colors">
              Dashboard
            </Link>
            <span>/</span>
            <span>{project?.name ?? id}</span>
          </div>
          <h1 className="text-3xl font-bold text-foreground">{project?.name ?? 'Project'}</h1>
          {project?.description && (
            <p className="text-muted-foreground mt-1">{project.description}</p>
          )}
        </div>
        <Button
          variant="premium"
          onClick={() => router.push('/dashboard/projects/new')}
        >
          + New Conversion
        </Button>
      </div>

      {/* ── Stats row ──────────────────────────────────────── */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: 'Total Jobs',       value: jobs.length },
          { label: 'Completed',        value: jobs.filter((j) => j.status === 'done').length },
          {
            label: 'Files Generated',
            value: jobs.reduce((s, j) => s + (j.filesGenerated ?? 0), 0),
          },
          {
            label: 'Lines Generated',
            value: jobs.reduce((s, j) => s + (j.linesGenerated ?? 0), 0).toLocaleString(),
          },
        ].map((stat) => (
          <Card key={stat.label} variant="default" className="p-4">
            <p className="text-sm text-muted-foreground">{stat.label}</p>
            <p className="text-2xl font-bold text-foreground mt-1">{stat.value}</p>
          </Card>
        ))}
      </div>

      {/* ── Jobs list ──────────────────────────────────────── */}
      <Card variant="elevated">
        <CardHeader>
          <CardTitle>Conversion Jobs</CardTitle>
        </CardHeader>
        <CardContent>
          {jobs.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-5xl mb-4">🚀</div>
              <p className="text-muted-foreground mb-4">
                No conversions yet. Start your first one!
              </p>
              <Button
                variant="premium"
                onClick={() => router.push('/dashboard/projects/new')}
              >
                Start Conversion
              </Button>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {jobs.map((job) => (
                <div key={job.id} className="py-4 flex items-center gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-foreground">
                        {job.sourceLanguage} → {job.targetLanguage}
                      </span>
                      <Badge variant={STATUS_BADGE[job.status] ?? 'default'} size="sm">
                        {job.status}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {new Date(job.createdAt).toLocaleString()}
                      {job.filesGenerated ? ` · ${job.filesGenerated} files` : ''}
                      {job.linesGenerated
                        ? ` · ${job.linesGenerated.toLocaleString()} lines`
                        : ''}
                    </p>

                    {/* Barre de progression */}
                    {['analyzing', 'converting'].includes(job.status) && (
                      <div className="mt-2 h-1.5 w-full bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary rounded-full transition-all duration-500"
                          style={{ width: `${job.progress ?? 0}%` }}
                        />
                      </div>
                    )}
                  </div>

                  <div className="flex gap-2">
                    {['pending', 'analyzing', 'converting'].includes(job.status) && (
                      <Link href={`/dashboard/projects/${id}/job/${job.id}`}>
                        <Button variant="outline" size="sm">Track</Button>
                      </Link>
                    )}
                    {job.status === 'done' && (
                      <Link href={`/dashboard/projects/${id}/result/${job.id}`}>
                        <Button variant="premium" size="sm">View Result</Button>
                      </Link>
                    )}
                    {job.status === 'failed' && (
                      <Link href={`/dashboard/projects/${id}/job/${job.id}`}>
                        <Button variant="outline" size="sm">Details</Button>
                      </Link>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
