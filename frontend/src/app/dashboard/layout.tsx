// ============================================================
// CodeMorph — Dashboard Layout avec AuthGuard client-side
// FIX: race condition corrigée + token sync robuste
// ============================================================
'use client';

import * as React from 'react';
import { useEffect, useRef } from 'react';
import { Sidebar } from '@/components/layout/sidebar';
import { Header }  from '@/components/layout/header';
import { cn }      from '@/lib/utils/cn';

// ── Helpers ───────────────────────────────────────────────
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

// ── AuthGuard ──────────────────────────────────────────────
function AuthGuard({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [state, setState] = React.useState<'loading' | 'authed' | 'redirect'>('loading');
  const redirected = useRef(false);

  useEffect(() => {
    const token = getStoredToken();

    if (token) {
      setState('authed');
    } else {
      // Pas de token → redirection vers sign-in
      if (!redirected.current) {
        redirected.current = true;
        setState('redirect');
        const next = encodeURIComponent(window.location.pathname + window.location.search);
        // Utiliser window.location pour éviter les problèmes de router en SSR
        window.location.replace(`/auth/sign-in?next=${next}`);
      }
    }
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
