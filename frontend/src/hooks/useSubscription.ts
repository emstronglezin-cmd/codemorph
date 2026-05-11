// ============================================================
// CodeMorph — useSubscription Hook
// TanStack Query + subscription API
// ============================================================
'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/api/client';

// ── Types ────────────────────────────────────────────────
export type Plan = 'free' | 'pro' | 'pro_max';
export type BillingInterval = 'monthly' | 'yearly';

export interface PlanInfo {
  id:          Plan;
  name:        string;
  price:       { monthly: number; yearly: number };
  description: string;
  features:    string[];
  limits: {
    conversionsPerMonth: number;
    concurrentJobs:      number;
    maxSourceFileSizeMb: number;
    maxFilesPerProject:  number;
    githubExport:        boolean;
    advancedFrameworks:  boolean;
    teamWorkspace:       boolean;
    apiAccess:           boolean;
    watermark:           boolean;
    queuePriority:       number;
    trialDays:           number;
  };
  highlighted?: boolean;
}

export interface SubscriptionState {
  plan:                 Plan;
  status:               'active' | 'trialing' | 'past_due' | 'cancelled' | 'free';
  currentPeriodEnd?:    string;
  cancelAtPeriodEnd?:   boolean;
  provider?:            string;
  usage: {
    conversionsUsed:    number;
    conversionsLimit:   number;
    remaining:          number;
    resetAt:            string;
    aiRequestsUsed:     number;
    storageBytesUsed:   number;
  };
}

interface CheckoutPayload {
  plan:     Plan;
  interval: BillingInterval;
}

interface CheckoutResponse {
  url: string;
}

interface PortalResponse {
  url: string;
}

// ── API calls ─────────────────────────────────────────────
const fetchPlans  = () => apiClient.get<PlanInfo[]>('/subscription/plans').then(r => r.data);
const fetchMe     = () => apiClient.get<SubscriptionState>('/subscription/me').then(r => r.data);

const createCheckout = (payload: CheckoutPayload) =>
  apiClient.post<CheckoutResponse>('/subscription/checkout', payload).then(r => r.data);

const createPortal = () =>
  apiClient.post<PortalResponse>('/subscription/portal').then(r => r.data);

// ── Hooks ─────────────────────────────────────────────────
export function usePlans() {
  return useQuery({
    queryKey:   ['subscription', 'plans'],
    queryFn:    fetchPlans,
    staleTime:  10 * 60 * 1000, // 10 min
    gcTime:     30 * 60 * 1000,
  });
}

export function useSubscription() {
  return useQuery({
    queryKey:  ['subscription', 'me'],
    queryFn:   fetchMe,
    staleTime: 60 * 1000,       // 1 min
    gcTime:    5 * 60 * 1000,
    retry:     1,
  });
}

export function useCheckout() {
  return useMutation({
    mutationFn: createCheckout,
    onSuccess:  (data) => {
      window.location.href = data.url;
    },
  });
}

export function useBillingPortal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createPortal,
    onSuccess:  (data) => {
      qc.invalidateQueries({ queryKey: ['subscription'] });
      window.location.href = data.url;
    },
  });
}

// ── Utility helpers ───────────────────────────────────────
export function usePlanFeature(feature: keyof PlanInfo['limits']) {
  const { data: sub } = useSubscription();
  const { data: plans } = usePlans();

  if (!sub || !plans) return false;
  const plan = plans.find(p => p.id === sub.plan);
  if (!plan) return false;
  return plan.limits[feature];
}

export function useIsFreePlan() {
  const { data: sub } = useSubscription();
  return sub?.plan === 'free';
}

export function useUsagePercent() {
  const { data: sub } = useSubscription();
  if (!sub) return 0;
  const { conversionsUsed, conversionsLimit } = sub.usage;
  if (conversionsLimit <= 0) return 0; // unlimited
  return Math.min(100, Math.round((conversionsUsed / conversionsLimit) * 100));
}
