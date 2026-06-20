'use client';

import type React from 'react';
import Link from 'next/link';
import { useState } from 'react';

// URL de l'API (toujours depuis la variable d'env, jamais localhost en prod)
const BACKEND = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

export default function SignUpPage() {
  const [form, setForm]     = useState({ name: '', email: '', password: '', confirm: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.password !== form.confirm) { setError('Les mots de passe ne correspondent pas'); return; }
    if (form.password.length < 8)       { setError('Le mot de passe doit contenir au moins 8 caractères'); return; }

    setLoading(true);
    setError('');

    try {
      const res = await fetch(`${BACKEND}/auth/sign-up`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:        form.name.trim(),
          email:       form.email.trim().toLowerCase(),
          password:    form.password,
          acceptTerms: true,
        }),
        // NE PAS mettre credentials:'include' pour l'inscription
        // ça cause des erreurs CORS preflight inutiles sur certains navigateurs
        credentials: 'omit',
      });

      // Parser la réponse même en cas d'erreur
      let data: {
        data?:       { tokens?: { accessToken?: string }; user?: { id: string; email: string; name: string } };
        tokens?:     { accessToken?: string };
        user?:       { id: string; email: string; name: string };
        error?:      { message?: string };
        message?:    string | string[];
        statusCode?: number;
      } = {};

      try {
        data = await res.json();
      } catch {
        // Réponse non-JSON (ex: 502 Bad Gateway HTML)
        throw new Error(`Erreur serveur (${res.status}). Veuillez réessayer.`);
      }

      if (!res.ok) {
        // NestJS peut retourner message comme string[] (validation) ou string
        const raw = data.message;
        const msg = Array.isArray(raw)
          ? raw.join(', ')
          : (raw ?? data.error?.message ?? `Erreur ${res.status}`);
        throw new Error(String(msg));
      }

      // Extraire le token selon la structure de réponse
      const token =
        data?.data?.tokens?.accessToken ??
        data?.tokens?.accessToken;

      if (token && typeof window !== 'undefined') {
        localStorage.setItem('cm_access_token', token);
        // Sync mémoire pour axios interceptor
        (window as Window & { __CODEMORPH_ACCESS_TOKEN__?: string }).__CODEMORPH_ACCESS_TOKEN__ = token;
      }

      // Redirection vers le dashboard
      window.location.href = '/dashboard';

    } catch (err) {
      const message = (err as Error).message;
      // Masquer les erreurs réseau techniques avec un message clair
      if (message === 'Failed to fetch' || message === 'Load failed' || message === 'NetworkError') {
        setError('Impossible de contacter le serveur. Vérifiez votre connexion ou réessayez dans quelques instants.');
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  };

  const githubUrl  = `${BACKEND}/auth/github`;
  const googleUrl  = `${BACKEND}/auth/google`;

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">

        {/* Logo */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center gap-2">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <span className="text-xl font-bold text-white">CodeMorph</span>
          </div>
          <p className="text-sm text-slate-400">AI-powered code conversion platform</p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-5">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-white">Create your account</h1>
            <p className="text-sm text-slate-400 mt-1">Start converting codebases with AI</p>
          </div>

          {/* OAuth buttons */}
          <div className="grid grid-cols-2 gap-3">
            <a href={githubUrl} className="flex items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-800 py-2.5 text-sm font-medium text-white hover:bg-slate-700 transition-colors">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
              GitHub
            </a>
            <a href={googleUrl} className="flex items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-800 py-2.5 text-sm font-medium text-white hover:bg-slate-700 transition-colors">
              <svg className="w-4 h-4" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              Google
            </a>
          </div>

          <div className="relative">
            <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-slate-700" /></div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-slate-900 px-2 text-slate-500">Or continue with email</span>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-400">
                {error}
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-slate-300" htmlFor="name">Full name</label>
              <input
                id="name"
                type="text"
                placeholder="Jane Doe"
                required
                autoComplete="name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="flex h-10 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-slate-300" htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                placeholder="jane@example.com"
                required
                autoComplete="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="flex h-10 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-slate-300" htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                placeholder="Min. 8 characters"
                required
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                className="flex h-10 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-slate-300" htmlFor="confirm">Confirm password</label>
              <input
                id="confirm"
                type="password"
                placeholder="Repeat your password"
                required
                autoComplete="new-password"
                value={form.confirm}
                onChange={(e) => setForm({ ...form, confirm: e.target.value })}
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
                  Creating account…
                </>
              ) : (
                'Create account'
              )}
            </button>
          </form>

          <p className="text-center text-sm text-slate-400">
            Already have an account?{' '}
            <Link href="/auth/sign-in" className="text-violet-400 hover:text-violet-300 font-medium">Sign in</Link>
          </p>

          <p className="text-center text-xs text-slate-500">
            By creating an account, you agree to our{' '}
            <Link href="/terms" className="hover:underline">Terms of Service</Link>
            {' '}and{' '}
            <Link href="/privacy" className="hover:underline">Privacy Policy</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
