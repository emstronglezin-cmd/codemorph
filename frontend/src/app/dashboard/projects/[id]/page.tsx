'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface Job {
  id: string;
  type: string;
  status: string;
  sourceLanguage: string;
  targetLanguage: string;
  progress: number;
  filesGenerated?: number;
  linesGenerated?: number;
  createdAt: string;
  completedAt?: string;
}

interface Project {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
}

const BACKEND = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

const STATUS_BADGE: Record<string, 'default' | 'warning' | 'success' | 'error' | 'info'> = {
  pending: 'warning',
  analyzing: 'info',
  converting: 'info',
  done: 'success',
  failed: 'error',
};

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const [pRes, jRes] = await Promise.all([
          fetch(`${BACKEND}/projects/${id}`, { credentials: 'include' }),
          fetch(`${BACKEND}/jobs/project/${id}`, { credentials: 'include' }),
        ]);
        if (pRes.ok) setProject(await pRes.json().then((d) => d.data ?? d));
        if (jRes.ok) setJobs(await jRes.json().then((d) => d.data ?? d));
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-8 py-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
            <Link href="/dashboard" className="hover:text-foreground">Dashboard</Link>
            <span>/</span>
            <span>{project?.name ?? id}</span>
          </div>
          <h1 className="text-3xl font-bold text-foreground">{project?.name}</h1>
          {project?.description && <p className="text-muted-foreground mt-1">{project.description}</p>}
        </div>
        <Button variant="premium" onClick={() => router.push(`/dashboard/projects/new`)}>
          + New Conversion
        </Button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: 'Total Jobs', value: jobs.length },
          { label: 'Completed', value: jobs.filter((j) => j.status === 'done').length },
          { label: 'Files Generated', value: jobs.reduce((s, j) => s + (j.filesGenerated ?? 0), 0) },
          { label: 'Lines Generated', value: jobs.reduce((s, j) => s + (j.linesGenerated ?? 0), 0).toLocaleString() },
        ].map((stat) => (
          <Card key={stat.label} variant="default" className="p-4">
            <p className="text-sm text-muted-foreground">{stat.label}</p>
            <p className="text-2xl font-bold text-foreground mt-1">{stat.value}</p>
          </Card>
        ))}
      </div>

      {/* Jobs list */}
      <Card variant="elevated">
        <CardHeader>
          <CardTitle>Conversion Jobs</CardTitle>
        </CardHeader>
        <CardContent>
          {jobs.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-5xl mb-4">🚀</div>
              <p className="text-muted-foreground mb-4">No conversions yet. Start your first one!</p>
              <Button variant="premium" onClick={() => router.push(`/dashboard/projects/new`)}>
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
                      {job.linesGenerated ? ` · ${job.linesGenerated.toLocaleString()} lines` : ''}
                    </p>
                    {['analyzing', 'converting'].includes(job.status) && (
                      <div className="mt-2 h-1.5 w-full bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary rounded-full transition-all duration-500"
                          style={{ width: `${job.progress}%` }}
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
