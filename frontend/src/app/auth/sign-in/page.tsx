'use client';
// ============================================================
// CodeMorph — Sign In Page (Client Component)
// ============================================================
import type React from 'react';
import { useState } from 'react';
import Link from 'next/link';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

export default function SignInPage(): React.JSX.Element {
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState('');
  const [loading,  setLoading]  = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch(`${API_URL}/auth/sign-in`, {
        method:      'POST',
        headers:     { 'Content-Type': 'application/json' },
        credentials: 'omit',   // pas de cookie cross-domain en sign-in (on utilise localStorage)
        body:        JSON.stringify({ email: email.trim().toLowerCase(), password }),
      });

      let data: {
        data?:    { tokens?: { accessToken?: string } };
        tokens?:  { accessToken?: string };
        message?: string | string[];
        error?:   string;
      } = {};

      try {
        data = await res.json();
      } catch {
        throw new Error(`Erreur serveur (${res.status}). Veuillez réessayer.`);
      }

      if (!res.ok) {
        const raw = data.message;
        const msg = Array.isArray(raw)
          ? raw.join(', ')
          : (raw ?? data.error ?? 'Identifiants incorrects');
        throw new Error(String(msg));
      }

      const token =
        data?.data?.tokens?.accessToken ??
        data?.tokens?.accessToken;

      if (token && typeof window !== 'undefined') {
        localStorage.setItem('cm_access_token', token);
        (window as Window & { __CODEMORPH_ACCESS_TOKEN__?: string }).__CODEMORPH_ACCESS_TOKEN__ = token;
      }

      window.location.href = '/dashboard';

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Erreur de connexion';
      if (message === 'Failed to fetch' || message === 'Load failed') {
        setError('Impossible de contacter le serveur. Vérifiez votre connexion.');
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">

        {/* Logo */}
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg">
            <svg className="h-5 w-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Welcome back</h1>
            <p className="text-sm text-slate-400">Sign in to your CodeMorph account</p>
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900 p-6 shadow-xl space-y-4">

          {/* OAuth Buttons */}
          <a
            href={`${API_URL}/auth/github`}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-800 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-700"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
            </svg>
            Continue with GitHub
          </a>

          <a
            href={`${API_URL}/auth/google`}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-800 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-700"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
            </svg>
            Continue with Google
          </a>

          {/* Divider */}
          <div className="relative flex items-center py-1">
            <div className="flex-1 border-t border-slate-700" />
            <span className="mx-3 text-xs text-slate-500">or continue with email</span>
            <div className="flex-1 border-t border-slate-700" />
          </div>

          {/* Error banner */}
          {error && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}

          {/* Email / Password Form */}
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-slate-300" htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                placeholder="you@example.com"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="flex h-10 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-slate-300" htmlFor="password">Password</label>
                <Link href="/auth/forgot-password" className="text-xs text-violet-400 hover:text-violet-300">
                  Forgot password?
                </Link>
              </div>
              <input
                id="password"
                type="password"
                placeholder="••••••••"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="flex h-10 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full h-10 rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 text-sm font-semibold text-white shadow-sm hover:opacity-90 transition-all disabled:opacity-60 flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Signing in…
                </>
              ) : (
                'Sign in'
              )}
            </button>
          </form>
        </div>

        <p className="text-center text-sm text-slate-400">
          Don&apos;t have an account?{' '}
          <Link href="/auth/sign-up" className="font-medium text-violet-400 hover:text-violet-300">
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}
