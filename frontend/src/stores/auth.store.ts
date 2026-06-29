// ============================================================
// CodeMorph — Auth Store (Zustand + persist)
// FIX CRITIQUE:
//   - setAuth synchronise localStorage + window
//   - clearAuth nettoie tous les stockages
//   - refreshAuth utilise cookie httpOnly (withCredentials)
//   - onRehydrateStorage: vérifie l'expiry JWT au rechargement
//     → si expiré: tente refresh → si échec: clearAuth
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

/** Décode le payload JWT sans vérifier la signature */
function decodeJwt(token: string): { exp?: number } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded  = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=');
    return JSON.parse(atob(padded)) as { exp?: number };
  } catch { return null; }
}

/** Retourne true si le token est expiré */
function isExpired(token: string): boolean {
  const p = decodeJwt(token);
  if (!p?.exp) return true;
  return p.exp < Math.floor(Date.now() / 1000);
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
            credentials: 'include',
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
            credentials: 'include',
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
          if (typeof window !== 'undefined') {
            window.location.replace('/auth/sign-in');
          }
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
      // Au rechargement de la page : vérifier l'expiry du token
      onRehydrateStorage: () => (state, error) => {
        if (error || !state) return;

        if (state.accessToken) {
          // Token présent — vérifier si expiré
          if (isExpired(state.accessToken)) {
            // Token expiré → tenter refresh silencieux
            const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
            void fetch(`${API}/auth/refresh`, {
              method:      'POST',
              credentials: 'include',
              headers:     { 'Content-Type': 'application/json' },
              body:        '{}',
            }).then(async (res) => {
              if (!res.ok) {
                // Refresh échoué → nettoyer le store
                state.clearAuth?.();
                return;
              }
              const data = await res.json() as {
                data?: { tokens?: { accessToken?: string } };
                tokens?: { accessToken?: string };
              };
              const newToken = data?.data?.tokens?.accessToken ?? data?.tokens?.accessToken;
              if (newToken && state.user) {
                state.setAuth?.(state.user, newToken);
              } else {
                state.clearAuth?.();
              }
            }).catch(() => {
              // Ignorer silencieusement — le AuthGuard du layout gérera
            });
          } else {
            // Token valide → synchroniser window
            setAccessToken(state.accessToken);
          }
        }
      },
    },
  ),
);

