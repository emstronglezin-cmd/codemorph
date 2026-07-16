'use client';

// ============================================================
// CodeMorph — OAuth Success Page
// FIX PHASE 3 — SEC-02 : token via cookie httpOnly uniquement
// Le token n'est PLUS dans l'URL (?token=) — il est dans le
// cookie cm_refresh_token httpOnly (posé par le backend).
// Cette page appelle POST /auth/refresh via withCredentials
// pour échanger le cookie contre un access token.
// ============================================================

import type React from 'react';
import { useEffect, Suspense } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';
import { setAccessToken, apiGet } from '@/lib/api/client';
import type { AuthUser } from '@/stores/auth.store';

const BACKEND = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

// Réponse brute possible de /auth/me selon TransformInterceptor
interface MeRaw {
  id?:        string;
  sub?:       string;
  email?:     string;
  name?:      string;
  firstName?: string;
  lastName?:  string;
  avatarUrl?: string;
  avatar?:    string;
  role?:      string;
  plan?:      string;
  status?:    string;
}

interface RefreshResponse {
  data?: { tokens?: { accessToken?: string }; accessToken?: string };
  tokens?: { accessToken?: string };
  accessToken?: string;
}

/** Normalise la réponse brute de /auth/me en AuthUser */
function normalizeMeResponse(raw: MeRaw): AuthUser {
  const id    = raw.id ?? raw.sub ?? '';
  const name  = raw.name
    ?? (raw.firstName && raw.lastName ? `${raw.firstName} ${raw.lastName}` : undefined)
    ?? raw.firstName
    ?? raw.email?.split('@')[0]
    ?? 'User';

  return {
    id,
    email:     raw.email    ?? '',
    name,
    avatarUrl: raw.avatarUrl ?? raw.avatar,
    role:      raw.role     ?? 'member',
    plan:      raw.plan     ?? 'free',
  };
}

function OAuthSuccessInner(): React.JSX.Element {
  const router  = useRouter();
  const setAuth = useAuthStore((s) => s.setAuth);

  useEffect(() => {
    let cancelled = false;

    async function handleOAuthSuccess() {
      try {
        // FIX PHASE 3 — SEC-02 : utiliser le cookie httpOnly pour obtenir l'access token
        // Le backend a posé cm_refresh_token en cookie httpOnly lors du callback OAuth.
        // On appelle POST /auth/refresh avec withCredentials pour échanger le cookie.
        const refreshRes = await fetch(`${BACKEND}/auth/refresh`, {
          method:      'POST',
          credentials: 'include',
          headers:     { 'Content-Type': 'application/json' },
          body:        '{}',
        });

        if (!refreshRes.ok) {
          if (!cancelled) router.replace('/auth/sign-in?error=oauth_failed');
          return;
        }

        const refreshData = await refreshRes.json() as RefreshResponse;
        const token =
          refreshData?.data?.tokens?.accessToken ??
          refreshData?.data?.accessToken ??
          refreshData?.tokens?.accessToken ??
          refreshData?.accessToken;

        if (!token) {
          if (!cancelled) router.replace('/auth/sign-in?error=oauth_failed');
          return;
        }

        // Injecter le token dans tous les stockages
        setAccessToken(token);

        // Récupérer le profil complet
        const raw = await apiGet<MeRaw>('/auth/me');
        const user = normalizeMeResponse(raw);

        if (!cancelled) {
          setAuth(user, token);
          router.replace('/dashboard');
        }
      } catch {
        if (!cancelled) {
          router.replace('/auth/sign-in?error=oauth_failed');
        }
      }
    }

    void handleOAuthSuccess();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 to-slate-800">
      <div className="text-center space-y-4">
        <div className="w-16 h-16 mx-auto rounded-full bg-violet-600/20 flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-violet-400 border-t-transparent rounded-full animate-spin" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-white">Connexion réussie</h2>
          <p className="text-sm text-slate-400 mt-1">Finalisation de la session…</p>
        </div>
      </div>
    </div>
  );
}

export default function OAuthSuccessPage(): React.JSX.Element {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-slate-900">
          <div className="w-8 h-8 border-2 border-violet-400 border-t-transparent rounded-full animate-spin" />
        </div>
      }
    >
      <OAuthSuccessInner />
    </Suspense>
  );
}
