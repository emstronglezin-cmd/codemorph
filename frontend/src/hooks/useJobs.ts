import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiDelete } from '@/lib/api/client';

export interface Job {
  id: string;
  type: string;
  status: 'pending' | 'analyzing' | 'converting' | 'done' | 'failed';
  sourceLanguage: string;
  targetLanguage: string;
  progress: number;
  currentPhase?: string;
  phaseLogs?: Array<{ phase: string; status: string; message: string; timestamp: string }>;
  errorMessage?: string;
  filesGenerated?: number;
  linesGenerated?: number;
  result?: Record<string, unknown>;
  irDocument?: Record<string, unknown>;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  projectId?: string;
}

interface JobsPage {
  data: Job[];
  total: number;
}

export function useJobs(page = 1, limit = 20) {
  return useQuery({
    queryKey: ['jobs', page, limit],
    queryFn: () => apiGet<JobsPage>('/jobs', { page, limit }),
    staleTime: 30_000,
  });
}

export function useJob(jobId: string, pollWhileActive = true) {
  return useQuery({
    queryKey: ['jobs', jobId],
    queryFn: () => apiGet<Job>(`/jobs/${jobId}`),
    refetchInterval: (query) => {
      if (!pollWhileActive) return false;
      const status = query.state.data?.status;
      return status && ['pending', 'analyzing', 'converting'].includes(status) ? 3000 : false;
    },
    staleTime: 0,
  });
}

export function useProjectJobs(projectId: string) {
  return useQuery({
    queryKey: ['jobs', 'project', projectId],
    queryFn: () => apiGet<Job[]>(`/jobs/project/${projectId}`),
    staleTime: 30_000,
    enabled: !!projectId,
  });
}

export function useStartGitHubJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      projectId?: string;
      sourceLanguage: string;
      targetLanguage: string;
      repo: string;
      branch?: string;
      goalPrompt?: string;
    }) => apiPost<Job>('/jobs/start/github', payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}

export function useStartZipJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      projectId?: string;
      sourceLanguage: string;
      targetLanguage: string;
      zipPath: string;
      goalPrompt?: string;
    }) => apiPost<Job>('/jobs/start/zip', payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}

export function useCancelJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => apiDelete(`/jobs/${jobId}`),
    onSuccess: (_data, jobId) => {
      void qc.invalidateQueries({ queryKey: ['jobs', jobId] });
      void qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}
