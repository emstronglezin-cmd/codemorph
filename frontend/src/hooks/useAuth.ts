import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/auth.store';
import { useProjectStore } from '@/stores/project.store';
import { apiGet, apiPost } from '@/lib/api/client';

interface MeResponse {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  role: string;
  plan: string;
}

export function useAuth() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, isAuthenticated, isLoading, setAuth, clearAuth } = useAuthStore();
  const resetProjectStore = useProjectStore((s) => s.resetStore);

  // Fetch current user
  const { data: me, isLoading: isMeLoading } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => apiGet<MeResponse>('/auth/me'),
    enabled: isAuthenticated,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  // Sign in mutation
  const signInMutation = useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      apiPost<{ user: MeResponse; accessToken: string }>('/auth/sign-in', { email, password }),
    onSuccess: (data) => {
      setAuth(data.user, data.accessToken);
      queryClient.setQueryData(['auth', 'me'], data.user);
      router.push('/dashboard');
    },
  });

  // Sign up mutation
  const signUpMutation = useMutation({
    mutationFn: ({ name, email, password }: { name: string; email: string; password: string }) =>
      apiPost<{ user: MeResponse; accessToken: string }>('/auth/sign-up', { name, email, password }),
    onSuccess: (data) => {
      setAuth(data.user, data.accessToken);
      queryClient.setQueryData(['auth', 'me'], data.user);
      router.push('/dashboard');
    },
  });

  // Sign out — FIX PHASE 2 : nettoyage complet multi-couche
  // 1. clearAuth() → supprime localStorage (codemorph-auth, cm_access_token) + sessionStorage
  // 2. resetProjectStore() → réinitialise Zustand project store
  // 3. queryClient.clear() → réinitialise React Query cache
  // 4. queryClient.removeQueries() → supprime toutes les queries (double sécurité ISO-01)
  const signOut = useCallback(async () => {
    try {
      await apiPost('/auth/sign-out');
    } finally {
      clearAuth();
      resetProjectStore();
      queryClient.clear();
      queryClient.removeQueries();
      router.push('/auth/sign-in');
    }
  }, [clearAuth, resetProjectStore, queryClient, router]);

  return {
    user: me ?? user,
    isAuthenticated,
    isLoading: isLoading || isMeLoading,
    signIn: signInMutation.mutateAsync,
    signInError: signInMutation.error,
    signInLoading: signInMutation.isPending,
    signUp: signUpMutation.mutateAsync,
    signUpError: signUpMutation.error,
    signUpLoading: signUpMutation.isPending,
    signOut,
  };
}
