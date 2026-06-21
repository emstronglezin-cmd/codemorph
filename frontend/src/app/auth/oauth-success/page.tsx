'use client';

// ============================================================
// CodeMorph — OAuth Success Page
// FIX 14: setAuth() compatible avec AuthUser (id, email, name, role, plan)
//         Normalise la réponse /auth/me (sub → id, name fallback)
//         setAccessToken() appelé immédiatement pour que apiGet /auth/me fonctionne
// ============================================================

import type React from 'react';
import { useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';
import { setAccessToken, apiGet } from '@/lib/api/client';
import type { AuthUser } from '@/stores/auth.store';

// Réponse brute possible de /auth/me selon TransformInterceptor
interface MeRaw {
  // JwtPayload fields (via getMe qui retourne l'user entity)
  id?:        string;
  sub?:       string;   // JwtPayload utilise sub
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
  const searchParams = useSearchParams();
  const router       = useRouter();
  const setAuth      = useAuthStore((s) => s.setAuth);

  useEffect(() => {
    const token = searchParams.get('token');

    if (!token) {
      router.replace('/auth/sign-in?error=oauth_failed');
      return;
    }

    // 1. Injecter le token immédiatement dans tous les stockages
    //    pour que apiGet('/auth/me') puisse l'utiliser via l'intercepteur Axios
    setAccessToken(token);

    // 2. Récupérer le profil complet de l'utilisateur
    apiGet<MeRaw>('/auth/me')
      .then((raw) => {
        const user = normalizeMeResponse(raw);
        setAuth(user, token);
        // Utiliser replace (pas push) pour éviter un retour en arrière vers oauth-success
        router.replace('/dashboard');
      })
      .catch(() => {
        // Fallback : le token est valide (backend l'a émis) mais /auth/me a échoué
        // → on stock quand même et on redirige
        const fallbackUser: AuthUser = {
          id:    '',
          email: '',
          name:  'User',
          role:  'member',
          plan:  'free',
        };
        setAuth(fallbackUser, token);
        router.replace('/dashboard');
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);   // Intentionnellement vide : s'exécute une seule fois au montage

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 to-slate-800">
      <div className="text-center space-y-4">
        <div className="w-16 h-16 mx-auto rounded-full bg-violet-600/20 flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-violet-400 border-t-transparent rounded-full animate-spin" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-white">Connexion réussie</h2>
          <p className="text-sm text-slate-400 mt-1">Redirection vers le dashboard…</p>
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
