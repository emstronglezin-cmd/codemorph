import { create } from 'zustand';
import { apiGet, apiPost, apiPatch, apiDelete } from '@/lib/api/client';

export interface Project {
  id: string;
  name: string;
  slug: string;
  description?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  status: string;
  jobsCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface PaginatedProjects {
  data: Project[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface ProjectState {
  projects: Project[];
  currentProject: Project | null;
  total: number;
  isLoading: boolean;
  error: string | null;

  fetchProjects: (page?: number, limit?: number) => Promise<void>;
  fetchProject: (id: string) => Promise<void>;
  createProject: (data: { name: string; description?: string; sourceLanguage?: string; targetLanguage?: string }) => Promise<Project>;
  updateProject: (id: string, data: Partial<Project>) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  setCurrentProject: (project: Project | null) => void;
  clearError: () => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  currentProject: null,
  total: 0,
  isLoading: false,
  error: null,

  fetchProjects: async (page = 1, limit = 20) => {
    set({ isLoading: true, error: null });
    try {
      const res = await apiGet<PaginatedProjects>('/projects', { page, limit });
      set({ projects: res.data, total: res.total, isLoading: false });
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
    }
  },

  fetchProject: async (id) => {
    set({ isLoading: true, error: null });
    try {
      const project = await apiGet<Project>(`/projects/${id}`);
      set({ currentProject: project, isLoading: false });
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
    }
  },

  createProject: async (data) => {
    const project = await apiPost<Project>('/projects', data);
    set((state) => ({ projects: [project, ...state.projects], total: state.total + 1 }));
    return project;
  },

  updateProject: async (id, data) => {
    const updated = await apiPatch<Project>(`/projects/${id}`, data);
    set((state) => ({
      projects: state.projects.map((p) => (p.id === id ? updated : p)),
      currentProject: state.currentProject?.id === id ? updated : state.currentProject,
    }));
  },

  deleteProject: async (id) => {
    await apiDelete(`/projects/${id}`);
    set((state) => ({
      projects: state.projects.filter((p) => p.id !== id),
      total: Math.max(0, state.total - 1),
      currentProject: state.currentProject?.id === id ? null : state.currentProject,
    }));
  },

  setCurrentProject: (project) => set({ currentProject: project }),
  clearError: () => set({ error: null }),
}));
