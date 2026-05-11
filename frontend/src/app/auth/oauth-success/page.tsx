'use client';

import { useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';

function OAuthSuccessInner() {
  const searchParams = useSearchParams();
  const router       = useRouter();
  const setToken     = useAuthStore(s => s.setToken);

  useEffect(() => {
    const token = searchParams.get('token');
    if (!token) {
      router.replace('/auth/sign-in?error=oauth_failed');
      return;
    }
    // Store token in memory store
    setToken(token);
    // Inject into window for axios interceptor
    if (typeof window !== 'undefined') {
      (window as Record<string, unknown>)['__CODEMORPH_ACCESS_TOKEN__'] = token;
    }
    router.replace('/dashboard');
  }, [searchParams, router, setToken]);

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

export default function OAuthSuccessPage() {
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
