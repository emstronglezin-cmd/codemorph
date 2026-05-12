'use client';

import { useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';
import { apiGet } from '@/lib/api/client';

interface MeResponse {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  role: string;
  plan: string;
}

function OAuthSuccessInner(): React.JSX.Element {
  const searchParams = useSearchParams();
  const router       = useRouter();
  const setAuth      = useAuthStore(s => s.setAuth);

  useEffect(() => {
    const token = searchParams.get('token');
    if (!token) {
      router.replace('/auth/sign-in?error=oauth_failed');
      return;
    }

    // Inject into window for axios interceptor immediately
    if (typeof window !== 'undefined') {
      window.__CODEMORPH_ACCESS_TOKEN__ = token;
    }

    // Fetch user profile with the new token
    apiGet<MeResponse>('/auth/me')
      .then((user) => {
        setAuth(user, token);
        router.replace('/dashboard');
      })
      .catch(() => {
        // Fallback: store token with minimal user info
        setAuth(
          { id: '', email: '', name: '', role: 'member', plan: 'free' },
          token,
        );
        router.replace('/dashboard');
      });
  }, [searchParams, router, setAuth]);

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
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <div className="w-8 h-8 border-2 border-violet-400 border-t-transparent rounded-full animate-spin" />
      </div>
    }>
      <OAuthSuccessInner />
    </Suspense>
  );
}
