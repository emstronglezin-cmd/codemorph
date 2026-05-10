import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { apiPost } from '@/lib/api/client';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  role: string;
  plan: string;
}

interface AuthTokens {
  accessToken: string;
}

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;

  setAuth: (user: AuthUser, token: string) => void;
  setUser: (user: AuthUser) => void;
  clearAuth: () => void;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (name: string, email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshAuth: () => Promise<boolean>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      accessToken: null,
      isAuthenticated: false,
      isLoading: false,

      setAuth: (user, accessToken) => {
        if (typeof window !== 'undefined') {
          window.__CODEMORPH_ACCESS_TOKEN__ = accessToken;
        }
        set({ user, accessToken, isAuthenticated: true });
      },

      setUser: (user) => set({ user }),

      clearAuth: () => {
        if (typeof window !== 'undefined') {
          window.__CODEMORPH_ACCESS_TOKEN__ = undefined;
        }
        set({ user: null, accessToken: null, isAuthenticated: false });
      },

      signIn: async (email, password) => {
        set({ isLoading: true });
        try {
          const res = await apiPost<{ user: AuthUser; accessToken: string }>('/auth/sign-in', {
            email,
            password,
          });
          get().setAuth(res.user, res.accessToken);
        } finally {
          set({ isLoading: false });
        }
      },

      signUp: async (name, email, password) => {
        set({ isLoading: true });
        try {
          const res = await apiPost<{ user: AuthUser; accessToken: string }>('/auth/sign-up', {
            name,
            email,
            password,
          });
          get().setAuth(res.user, res.accessToken);
        } finally {
          set({ isLoading: false });
        }
      },

      signOut: async () => {
        try {
          await apiPost('/auth/sign-out');
        } finally {
          get().clearAuth();
        }
      },

      refreshAuth: async () => {
        try {
          const res = await apiPost<AuthTokens>('/auth/refresh');
          const current = get().user;
          if (res.accessToken && current) {
            get().setAuth(current, res.accessToken);
            return true;
          }
          return false;
        } catch {
          get().clearAuth();
          return false;
        }
      },
    }),
    {
      name: 'codemorph-auth',
      partialize: (state) => ({ user: state.user, accessToken: state.accessToken, isAuthenticated: state.isAuthenticated }),
      onRehydrateStorage: () => (state) => {
        if (state?.accessToken && typeof window !== 'undefined') {
          window.__CODEMORPH_ACCESS_TOKEN__ = state.accessToken;
        }
      },
    },
  ),
);
