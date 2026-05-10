import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPatch, apiDelete } from '@/lib/api/client';
import { Project, PaginatedProjects } from '@/stores/project.store';

export function useProjects(page = 1, limit = 20) {
  return useQuery({
    queryKey: ['projects', page, limit],
    queryFn: () => apiGet<PaginatedProjects>('/projects', { page, limit }),
    staleTime: 60_000,
  });
}

export function useProject(id: string) {
  return useQuery({
    queryKey: ['projects', id],
    queryFn: () => apiGet<Project>(`/projects/${id}`),
    staleTime: 60_000,
    enabled: !!id,
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; description?: string }) =>
      apiPost<Project>('/projects', data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Partial<Project>) =>
      apiPatch<Project>(`/projects/${id}`, data),
    onSuccess: (updated) => {
      qc.setQueryData(['projects', updated.id], updated);
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete(`/projects/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useGitHubRepos(page = 1) {
  return useQuery({
    queryKey: ['github', 'repos', page],
    queryFn: () => apiGet<Array<Record<string, unknown>>>('/github/repos', { page }),
    staleTime: 2 * 60 * 1000,
  });
}
