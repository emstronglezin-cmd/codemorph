// ============================================================
// CodeMorph — Auth Store (Zustand + persist)
// FIX: setAuth synchronise localStorage + window
//      clearAuth nettoie tous les stockages
//      refreshAuth utilise l'API client (Bearer token)
// ============================================================
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { setAccessToken, clearAccessToken, apiPost } from '@/lib/api/client';

export interface AuthUser {
  id:        string;
  email:     string;
  name:      string;
  avatarUrl?: string;
  role:      string;
  plan:      string;
}

interface AuthState {
  user:            AuthUser | null;
  accessToken:     string | null;
  isAuthenticated: boolean;
  isLoading:       boolean;

  setAuth:      (user: AuthUser, token: string)          => void;
  setUser:      (user: AuthUser)                         => void;
  clearAuth:    ()                                       => void;
  signIn:       (email: string, password: string)        => Promise<void>;
  signUp:       (name: string, email: string, password: string) => Promise<void>;
  signOut:      ()                                       => Promise<void>;
  refreshAuth:  ()                                       => Promise<boolean>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user:            null,
      accessToken:     null,
      isAuthenticated: false,
      isLoading:       false,

      setAuth: (user, accessToken) => {
        // Synchroniser dans tous les stockages
        setAccessToken(accessToken);
        set({ user, accessToken, isAuthenticated: true, isLoading: false });
      },

      setUser: (user) => set({ user }),

      clearAuth: () => {
        clearAccessToken();
        set({ user: null, accessToken: null, isAuthenticated: false, isLoading: false });
      },

      signIn: async (email, password) => {
        set({ isLoading: true });
        try {
          const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
          const res = await fetch(`${API}/auth/sign-in`, {
            method:      'POST',
            headers:     { 'Content-Type': 'application/json' },
            credentials: 'omit',
            body:        JSON.stringify({ email, password }),
          });
          const data = await res.json() as {
            data?:    { tokens?: { accessToken?: string }; user?: AuthUser };
            tokens?:  { accessToken?: string };
            user?:    AuthUser;
          };
          if (!res.ok) throw new Error('Invalid credentials');

          const token = data?.data?.tokens?.accessToken ?? data?.tokens?.accessToken ?? '';
          const user  = (data?.data?.user ?? data?.user) as AuthUser;
          if (token) get().setAuth(user, token);
        } finally {
          set({ isLoading: false });
        }
      },

      signUp: async (name, email, password) => {
        set({ isLoading: true });
        try {
          const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
          const res = await fetch(`${API}/auth/sign-up`, {
            method:      'POST',
            headers:     { 'Content-Type': 'application/json' },
            credentials: 'omit',
            body:        JSON.stringify({ name, email, password, acceptTerms: true }),
          });
          const data = await res.json() as {
            data?:    { tokens?: { accessToken?: string }; user?: AuthUser };
            tokens?:  { accessToken?: string };
            user?:    AuthUser;
          };
          if (!res.ok) throw new Error('Sign up failed');

          const token = data?.data?.tokens?.accessToken ?? data?.tokens?.accessToken ?? '';
          const user  = (data?.data?.user ?? data?.user) as AuthUser;
          if (token) get().setAuth(user, token);
        } finally {
          set({ isLoading: false });
        }
      },

      signOut: async () => {
        try {
          // Notifier le backend (best effort — ne pas bloquer si ça échoue)
          await apiPost('/auth/sign-out').catch(() => null);
        } finally {
          get().clearAuth();
          window.location.replace('/auth/sign-in');
        }
      },

      refreshAuth: async () => {
        try {
          // Tenter le refresh via cookie (withCredentials dans apiPost)
          const res = await apiPost<{ tokens?: { accessToken?: string }; accessToken?: string }>(
            '/auth/refresh',
          );
          const newToken = res?.tokens?.accessToken ?? (res as { accessToken?: string })?.accessToken;
          if (newToken) {
            const current = get().user;
            if (current) {
              get().setAuth(current, newToken);
              return true;
            }
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
      // Ne persister que les données essentielles (pas isLoading)
      partialize: (state) => ({
        user:            state.user,
        accessToken:     state.accessToken,
        isAuthenticated: state.isAuthenticated,
      }),
      // Au rechargement de la page : resynchroniser window depuis localStorage
      onRehydrateStorage: () => (state) => {
        if (state?.accessToken) {
          setAccessToken(state.accessToken);
        }
      },
    },
  ),
);
