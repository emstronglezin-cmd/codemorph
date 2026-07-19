'use client';

// ============================================================
// CodeMorph — OAuth Success Page
// FIX PHASE 3 — SEC-02 : token via cookie httpOnly uniquement
// Le token n'est PLUS dans l'URL (?token=) — il est dans le
// cookie cm_refresh_token httpOnly (posé par le backend).
// Cette page appelle POST /auth/refresh via withCredentials
// pour échanger le cookie contre un access token.
//
// FIX PHASE 20 — OAUTH CROSS-DOMAIN fallback :
// Les navigateurs modernes (Chrome ITP, Safari) bloquent les cookies
// cross-domain entre *.onrender.com et *.vercel.app même SameSite=None.
// Fallback : le backend passe le refreshToken encodé dans le fragment
// URL (#rt=base64url) — jamais envoyé aux serveurs (logs sécurisés).
// Priorité : cookie httpOnly → fragment URL #rt=
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

/**
 * FIX PHASE 20 — Extraire le refreshToken depuis le fragment URL #rt=base64url
 * Le fragment n'est jamais envoyé aux serveurs → sécurisé contre les logs Referer.
 * Retourne null si absent ou invalide.
 */
function extractRtFromHash(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const hash = window.location.hash; // ex: "#rt=eyJhb..."
    if (!hash.startsWith('#rt=')) return null;
    const encoded = hash.slice(4); // supprimer "#rt="
    if (!encoded) return null;
    // Décoder base64url → string
    return atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null;
  }
}

function OAuthSuccessInner(): React.JSX.Element {
  const router  = useRouter();
  const setAuth = useAuthStore((s) => s.setAuth);

  useEffect(() => {
    let cancelled = false;

    async function handleOAuthSuccess() {
      try {
        let token: string | undefined;

        // ── Étape 1 : Essayer le cookie httpOnly (cas nominal, même domaine) ──
        const refreshRes = await fetch(`${BACKEND}/auth/refresh`, {
          method:      'POST',
          credentials: 'include',
          headers:     { 'Content-Type': 'application/json' },
          body:        '{}',
        });

        if (refreshRes.ok) {
          const refreshData = await refreshRes.json() as RefreshResponse;
          token =
            refreshData?.data?.tokens?.accessToken ??
            refreshData?.data?.accessToken ??
            refreshData?.tokens?.accessToken ??
            refreshData?.accessToken;
        }

        // ── Étape 2 : Fallback fragment URL #rt= (cross-domain SameSite block) ──
        // FIX PHASE 20 : si le cookie a été bloqué par le navigateur (cross-domain),
        // le backend a passé le refreshToken en base64url dans le fragment #rt=.
        // On l'utilise directement comme refreshToken pour appeler /auth/refresh.
        if (!token) {
          const rtFromHash = extractRtFromHash();
          if (rtFromHash) {
            const fallbackRes = await fetch(`${BACKEND}/auth/refresh`, {
              method:      'POST',
              credentials: 'include',
              headers:     { 'Content-Type': 'application/json' },
              body:        JSON.stringify({ refreshToken: rtFromHash }),
            });
            if (fallbackRes.ok) {
              const fallbackData = await fallbackRes.json() as RefreshResponse;
              token =
                fallbackData?.data?.tokens?.accessToken ??
                fallbackData?.data?.accessToken ??
                fallbackData?.tokens?.accessToken ??
                fallbackData?.accessToken;
            }
          }
        }

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
          // Nettoyer le fragment de l'URL avant de naviguer
          if (typeof window !== 'undefined' && window.location.hash.startsWith('#rt=')) {
            window.history.replaceState(null, '', window.location.pathname);
          }
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
