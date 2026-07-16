// ============================================================
// CodeMorph — Axios API Client
// FIX: refresh token robuste + token sync multi-stockage
// ============================================================
import axios, { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from 'axios';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

// ── Token storage helpers ─────────────────────────────────
export function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null;

  const win = window as Window & { __CODEMORPH_ACCESS_TOKEN__?: string };

  // 1. Mémoire window
  if (win.__CODEMORPH_ACCESS_TOKEN__) return win.__CODEMORPH_ACCESS_TOKEN__;

  // 2. localStorage cm_access_token
  const ls = localStorage.getItem('cm_access_token');
  if (ls) {
    win.__CODEMORPH_ACCESS_TOKEN__ = ls;
    return ls;
  }

  // 3. Zustand persist store
  try {
    const raw = localStorage.getItem('codemorph-auth');
    if (raw) {
      const parsed = JSON.parse(raw) as { state?: { accessToken?: string } };
      const t = parsed?.state?.accessToken;
      if (t) {
        win.__CODEMORPH_ACCESS_TOKEN__ = t;
        localStorage.setItem('cm_access_token', t);
        return t;
      }
    }
  } catch { /* ignore */ }

  return null;
}

export function setAccessToken(token: string): void {
  if (typeof window === 'undefined') return;
  (window as Window & { __CODEMORPH_ACCESS_TOKEN__?: string }).__CODEMORPH_ACCESS_TOKEN__ = token;
  localStorage.setItem('cm_access_token', token);
}

export function clearAccessToken(): void {
  if (typeof window === 'undefined') return;
  // FIX PHASE 2 — ISO-03 : supprimer TOUS les stockages au logout
  // Avant : codemorph-auth était préservé → restauration de session cross-compte
  (window as Window & { __CODEMORPH_ACCESS_TOKEN__?: string }).__CODEMORPH_ACCESS_TOKEN__ = undefined;
  localStorage.removeItem('cm_access_token');
  // Supprimer le store Zustand persisté pour éviter la restauration cross-compte
  localStorage.removeItem('codemorph-auth');
  // Supprimer sessionStorage également
  try { sessionStorage.clear(); } catch { /* ignore */ }
}

// ── Axios instance ────────────────────────────────────────
export const apiClient: AxiosInstance = axios.create({
  baseURL:         BASE_URL,
  withCredentials: true,   // envoie le cookie refresh pour le endpoint /auth/refresh
  headers:         { 'Content-Type': 'application/json' },
  timeout:         30_000,
});

// ── Request interceptor — injecter le Bearer token + LOG ──
apiClient.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = getAccessToken();
  if (token && config.headers) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // LOG détaillé de chaque requête API
  const payload = config.data ? (() => {
    try { return JSON.parse(config.data as string); } catch { return config.data; }
  })() : undefined;
  console.log(`[apiClient] ▶ ${config.method?.toUpperCase() ?? 'GET'} ${config.baseURL ?? ''}${config.url ?? ''}`, {
    params:  config.params,
    payload,
    hasToken: !!token,
  });
  return config;
});

// ── Response interceptor — refresh auto sur 401 ───────────
let isRefreshing  = false;
let refreshQueue: Array<(token: string | null) => void> = [];

function processQueue(token: string | null): void {
  refreshQueue.forEach(cb => cb(token));
  refreshQueue = [];
}

apiClient.interceptors.response.use(
  (res) => {
    // LOG de chaque réponse réussie
    console.log(`[apiClient] ◀ ${res.status} ${res.config.method?.toUpperCase() ?? 'GET'} ${res.config.url ?? ''}`, {
      data: res.data,
    });
    return res;
  },
  async (error: AxiosError) => {
    // LOG de chaque erreur
    console.error(`[apiClient] ✖ ${error.response?.status ?? 'network'} ${error.config?.method?.toUpperCase() ?? 'GET'} ${error.config?.url ?? ''}`, {
      status:  error.response?.status,
      data:    error.response?.data,
      message: error.message,
      stack:   error.stack,
    });
    const original = error.config as InternalAxiosRequestConfig & { _retry?: boolean };

    // Seul les 401 sont traités, et seulement une fois
    if (error.response?.status !== 401 || original._retry) {
      return Promise.reject(error);
    }

    // Ne pas relancer le refresh si on était déjà sur l'endpoint refresh/sign-in
    const url = original.url ?? '';
    if (url.includes('/auth/refresh') || url.includes('/auth/sign-in') || url.includes('/auth/sign-up')) {
      return Promise.reject(error);
    }

    if (isRefreshing) {
      // File d'attente pendant le refresh en cours
      return new Promise((resolve, reject) => {
        refreshQueue.push((newToken) => {
          if (newToken) {
            if (original.headers) original.headers.Authorization = `Bearer ${newToken}`;
            resolve(apiClient(original));
          } else {
            reject(error);
          }
        });
      });
    }

    original._retry  = true;
    isRefreshing     = true;

    try {
      // Essayer de rafraîchir via cookie (cross-domain)
      const res = await axios.post(
        `${BASE_URL}/auth/refresh`,
        {},
        { withCredentials: true, timeout: 10_000 },
      );

      const newToken =
        (res.data?.data?.tokens?.accessToken as string | undefined) ??
        (res.data?.tokens?.accessToken as string | undefined) ??
        (res.data?.data?.accessToken as string | undefined) ??
        (res.data?.accessToken as string | undefined);

      if (newToken) {
        setAccessToken(newToken);
        processQueue(newToken);
        if (original.headers) original.headers.Authorization = `Bearer ${newToken}`;
        return apiClient(original);
      } else {
        throw new Error('No token in refresh response');
      }
    } catch {
      // Refresh échoué → déconnecter proprement
      processQueue(null);
      clearAccessToken();
      if (typeof window !== 'undefined') {
        window.location.replace('/auth/sign-in?reason=session_expired');
      }
      return Promise.reject(error);
    } finally {
      isRefreshing = false;
    }
  },
);

// ── Augment Window type ───────────────────────────────────
declare global {
  interface Window {
    __CODEMORPH_ACCESS_TOKEN__?: string;
  }
}

// ── Typed API helpers ─────────────────────────────────────
export async function apiGet<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const res = await apiClient.get<{ data: T } | T>(url, { params });
  return ((res.data as { data: T }).data ?? res.data) as T;
}

export async function apiPost<T>(url: string, body?: unknown): Promise<T> {
  const res = await apiClient.post<{ data: T } | T>(url, body);
  return ((res.data as { data: T }).data ?? res.data) as T;
}

export async function apiPatch<T>(url: string, body?: unknown): Promise<T> {
  const res = await apiClient.patch<{ data: T } | T>(url, body);
  return ((res.data as { data: T }).data ?? res.data) as T;
}

export async function apiDelete(url: string): Promise<void> {
  await apiClient.delete(url);
}
