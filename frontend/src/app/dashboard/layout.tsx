// ============================================================
// CodeMorph — Dashboard Layout avec AuthGuard client-side
// ============================================================
'use client';

import * as React from 'react';
import { useEffect, useState } from 'react';
import { Sidebar } from '@/components/layout/sidebar';
import { Header }  from '@/components/layout/header';
import { cn }      from '@/lib/utils/cn';

// ── AuthGuard ──────────────────────────────────────────────
// Vérifie que le token est présent dans localStorage
// Si absent → redirection vers sign-in
function AuthGuard({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [checked,  setChecked]  = useState(false);
  const [authed,   setAuthed]   = useState(false);

  useEffect(() => {
    // Vérifier token dans localStorage (défini lors du sign-up ou sign-in)
    const token =
      localStorage.getItem('cm_access_token') ??
      (window as Window & { __CODEMORPH_ACCESS_TOKEN__?: string }).__CODEMORPH_ACCESS_TOKEN__;

    if (token) {
      // Synchroniser dans window pour axios
      (window as Window & { __CODEMORPH_ACCESS_TOKEN__?: string }).__CODEMORPH_ACCESS_TOKEN__ = token;
      setAuthed(true);
    } else {
      // Pas de token → redirection
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `/auth/sign-in?next=${next}`;
      return;
    }
    setChecked(true);
  }, []);

  if (!checked) {
    // Écran de chargement pendant la vérification
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center">
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

  if (!authed) return <></>;

  return <>{children}</>;
}

// ── Dashboard Layout ──────────────────────────────────────
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [collapsed, setCollapsed] = React.useState(false);

  return (
    <AuthGuard>
      <div className="flex h-screen overflow-hidden bg-background">
        {/* Sidebar */}
        <Sidebar collapsed={collapsed} onCollapse={setCollapsed} />

        {/* Main */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <Header />
          <main
            className={cn(
              'flex-1 overflow-y-auto',
              'bg-surface-1',
              'px-4 py-6 sm:px-6 lg:px-8',
            )}
          >
            <div className="mx-auto w-full max-w-7xl">
              {children}
            </div>
          </main>
        </div>
      </div>
    </AuthGuard>
  );
}
