// ============================================================
// CodeMorph — Dashboard Layout avec AuthGuard client-side
// FIX CRITIQUE: 
//   1. Vérifie l'expiry JWT (décode sans vérifier signature)
//   2. Rafraîchit proactivement si token expire dans < 5 min
//   3. Redirige vers sign-in si token vraiment expiré
// ============================================================
'use client';

import * as React from 'react';
import { useEffect, useRef } from 'react';
import { Sidebar } from '@/components/layout/sidebar';
import { Header }  from '@/components/layout/header';
import { cn }      from '@/lib/utils/cn';

// ── JWT helpers côté client ────────────────────────────────
/** Décode le payload JWT sans vérifier la signature (lecture seule) */
function decodeJwtPayload(token: string): { exp?: number; sub?: string } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1];
    // Ajouter padding base64url si nécessaire
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded  = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=');
    return JSON.parse(atob(padded)) as { exp?: number; sub?: string };
  } catch {
    return null;
  }
}

/** Retourne true si le token est expiré ou expire dans < marginSecs secondes */
function isTokenExpiredOrExpiring(token: string, marginSecs = 0): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) return true; // token malformé → considérer expiré
  const nowSecs = Math.floor(Date.now() / 1000);
  return payload.exp < nowSecs + marginSecs;
}

// ── Token storage helpers ─────────────────────────────────
function getStoredToken(): string | null {
  if (typeof window === 'undefined') return null;
  // Priorité : window global > localStorage > zustand persist
  const win = window as Window & { __CODEMORPH_ACCESS_TOKEN__?: string };
  if (win.__CODEMORPH_ACCESS_TOKEN__) return win.__CODEMORPH_ACCESS_TOKEN__;

  const ls = localStorage.getItem('cm_access_token');
  if (ls) {
    win.__CODEMORPH_ACCESS_TOKEN__ = ls;
    return ls;
  }

  // Tenter de lire depuis le store Zustand sérialisé
  try {
    const raw = localStorage.getItem('codemorph-auth');
    if (raw) {
      const parsed = JSON.parse(raw) as { state?: { accessToken?: string } };
      const t = parsed?.state?.accessToken;
      if (t) {
        win.__CODEMORPH_ACCESS_TOKEN__ = t;
        localStorage.setItem('cm_access_token', t); // synchroniser
        return t;
      }
    }
  } catch { /* ignore */ }

  return null;
}

/** Rafraîchit le token via cookie httpOnly ou refreshToken stocké */
async function tryRefreshToken(): Promise<string | null> {
  const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
  try {
    const res = await fetch(`${API}/auth/refresh`, {
      method:      'POST',
      credentials: 'include',   // cookie httpOnly si même domaine
      headers:     { 'Content-Type': 'application/json' },
      body:        '{}',
      signal:      AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      data?: { tokens?: { accessToken?: string } };
      tokens?: { accessToken?: string };
    };
    return (
      data?.data?.tokens?.accessToken ??
      data?.tokens?.accessToken ??
      null
    );
  } catch {
    return null;
  }
}

// ── AuthGuard ──────────────────────────────────────────────
function AuthGuard({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [state, setState] = React.useState<'loading' | 'authed' | 'redirect'>('loading');
  const redirected = useRef(false);
  // Ref pour le timer de refresh proactif
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const token = getStoredToken();

    if (!token) {
      // Pas de token du tout → redirection
      if (!redirected.current) {
        redirected.current = true;
        setState('redirect');
        const next = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.replace(`/auth/sign-in?next=${next}`);
      }
      return;
    }

    // Vérifier si le token est expiré (avec marge 0 = exact)
    if (isTokenExpiredOrExpiring(token, 0)) {
      // Token expiré → tenter refresh avant de rediriger
      void tryRefreshToken().then((newToken) => {
        if (newToken) {
          // Refresh réussi → mettre à jour le stockage
          const win = window as Window & { __CODEMORPH_ACCESS_TOKEN__?: string };
          win.__CODEMORPH_ACCESS_TOKEN__ = newToken;
          localStorage.setItem('cm_access_token', newToken);
          // Mettre à jour Zustand store si possible
          try {
            const raw = localStorage.getItem('codemorph-auth');
            if (raw) {
              const parsed = JSON.parse(raw) as { state?: Record<string, unknown> };
              if (parsed?.state) {
                parsed.state.accessToken = newToken;
                localStorage.setItem('codemorph-auth', JSON.stringify(parsed));
              }
            }
          } catch { /* ignore */ }
          setState('authed');
          scheduleProactiveRefresh(newToken);
        } else {
          // Refresh échoué → signe-in
          if (!redirected.current) {
            redirected.current = true;
            setState('redirect');
            const next = encodeURIComponent(window.location.pathname + window.location.search);
            window.location.replace(`/auth/sign-in?next=${next}&reason=token_expired`);
          }
        }
      });
      return;
    }

    // Token valide → autoriser l'accès
    setState('authed');
    // Programmer un refresh proactif avant expiry
    scheduleProactiveRefresh(token);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Programme un refresh proactif 5 minutes avant l'expiry */
  function scheduleProactiveRefresh(token: string): void {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);

    const payload = decodeJwtPayload(token);
    if (!payload?.exp) return;

    const nowSecs = Math.floor(Date.now() / 1000);
    const secsUntilExpiry = payload.exp - nowSecs;
    // Rafraîchir 5 min avant expiry, ou immédiatement si < 5 min
    const secsUntilRefresh = Math.max(0, secsUntilExpiry - 5 * 60);

    if (secsUntilExpiry > 0) {
      refreshTimer.current = setTimeout(() => {
        void tryRefreshToken().then((newToken) => {
          if (newToken) {
            const win = window as Window & { __CODEMORPH_ACCESS_TOKEN__?: string };
            win.__CODEMORPH_ACCESS_TOKEN__ = newToken;
            localStorage.setItem('cm_access_token', newToken);
            try {
              const raw = localStorage.getItem('codemorph-auth');
              if (raw) {
                const parsed = JSON.parse(raw) as { state?: Record<string, unknown> };
                if (parsed?.state) {
                  parsed.state.accessToken = newToken;
                  localStorage.setItem('codemorph-auth', JSON.stringify(parsed));
                }
              }
            } catch { /* ignore */ }
            // Re-programmer pour le nouveau token
            scheduleProactiveRefresh(newToken);
          }
          // Si refresh échoué, l'intercepteur Axios gérera la prochaine 401
        });
      }, secsUntilRefresh * 1000);
    }
  }

  // Cleanup timer à la destruction
  useEffect(() => {
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  if (state === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
          <div className="w-5 h-5 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  // state === 'redirect' : afficher spinner pendant la redirection
  if (state === 'redirect') {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950">
        <div className="w-5 h-5 border-2 border-slate-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return <>{children}</>;
}

// ── Dashboard Layout ──────────────────────────────────────
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [collapsed, setCollapsed] = React.useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = React.useState(false);

  return (
    <AuthGuard>
      <div className="flex h-screen overflow-hidden bg-background">
        {/* ── Mobile sidebar overlay ─────────────────────── */}
        {mobileSidebarOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden"
            onClick={() => setMobileSidebarOpen(false)}
          />
        )}

        {/* ── Sidebar ────────────────────────────────────── */}
        <div className={cn(
          // Desktop: always visible, fixed width
          'hidden lg:flex shrink-0',
          // Transition width
          collapsed ? 'w-16' : 'w-60',
          'transition-all duration-300 ease-in-out',
        )}>
          <Sidebar collapsed={collapsed} onCollapse={setCollapsed} />
        </div>

        {/* Mobile sidebar */}
        <div className={cn(
          'fixed inset-y-0 left-0 z-50 flex lg:hidden',
          'transition-transform duration-300 ease-in-out',
          mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full',
        )}>
          <Sidebar collapsed={false} onCollapse={() => setMobileSidebarOpen(false)} />
        </div>

        {/* ── Main ───────────────────────────────────────── */}
        <div className="flex flex-1 min-w-0 flex-col overflow-hidden">
          <Header
            onMobileMenuToggle={() => setMobileSidebarOpen(v => !v)}
          />
          <main
            className={cn(
              'flex-1 overflow-y-auto bg-surface-1',
              // Desktop-first padding: generous on large screens
              'px-4 py-4 sm:px-6 sm:py-6 lg:px-8 lg:py-8',
            )}
          >
            {/* Max width: comfortable on 1366px, 1440p, 4K, ultrawide */}
            <div className="mx-auto w-full max-w-screen-2xl">
              {children}
            </div>
          </main>
        </div>
      </div>
    </AuthGuard>
  );
}
