import axios, { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from 'axios';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

export const apiClient: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
  timeout: 30_000,
});

// ── Request interceptor: attach access token from memory ──────────────────────
apiClient.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = typeof window !== 'undefined'
    ? window.__CODEMORPH_ACCESS_TOKEN__
    : undefined;
  if (token && config.headers) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ── Response interceptor: refresh on 401 ─────────────────────────────────────
let isRefreshing = false;
let refreshQueue: Array<(token: string) => void> = [];

apiClient.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config as InternalAxiosRequestConfig & { _retry?: boolean };
    if (error.response?.status === 401 && !original._retry) {
      if (isRefreshing) {
        // Queue while refresh is in-flight
        return new Promise((resolve) => {
          refreshQueue.push((token) => {
            if (original.headers) original.headers.Authorization = `Bearer ${token}`;
            resolve(apiClient(original));
          });
        });
      }

      original._retry = true;
      isRefreshing = true;

      try {
        const res = await axios.post(`${BASE_URL}/auth/refresh`, {}, { withCredentials: true });
        const newToken = (res.data?.data?.accessToken ?? res.data?.accessToken) as string;
        window.__CODEMORPH_ACCESS_TOKEN__ = newToken;
        refreshQueue.forEach((cb) => cb(newToken));
        refreshQueue = [];
        if (original.headers) original.headers.Authorization = `Bearer ${newToken}`;
        return apiClient(original);
      } catch {
        refreshQueue = [];
        window.__CODEMORPH_ACCESS_TOKEN__ = undefined;
        if (typeof window !== 'undefined') window.location.href = '/auth/sign-in';
        return Promise.reject(error);
      } finally {
        isRefreshing = false;
      }
    }
    return Promise.reject(error);
  },
);

// Augment Window type
declare global {
  interface Window {
    __CODEMORPH_ACCESS_TOKEN__?: string;
  }
}

// ── Typed API helpers ─────────────────────────────────────────────────────────
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
