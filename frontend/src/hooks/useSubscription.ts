// ============================================================
// CodeMorph — useSubscription Hook
// FIX PHASE 13:
//   - fetchPlans()    : unwrap {success, data:{plans:[...]}} → PlanInfo[]
//   - fetchMe()       : unwrap {success, data: SubscriptionSummary} → SubscriptionSummary
//   - SubscriptionState: suppression du champ 'usage' (absent du backend)
//                        ajout de 'limits' et 'display' (présents dans SubscriptionSummary)
//   - createCheckout(): route corrigée /payments/checkout (LeekPay)
//                        au lieu de /subscription/checkout (Stripe legacy)
//   - CheckoutPayload : {planId: string} au lieu de {plan, interval}
//   - CheckoutResponse: {payment_url, checkoutUrl, url} avec aliases
//   - useUsagePercent : lit limits.conversionsPerMonth au lieu de usage.conversionsLimit
// ============================================================
'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/api/client';

// ── Types ────────────────────────────────────────────────
export type Plan = 'free' | 'starter' | 'pro' | 'pro_max';
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

// FIX: correspond exactement au SubscriptionSummary du backend
// SUPPRIMÉ: champ 'usage' (absent de /subscription/me)
// AJOUTÉ:   'interval', 'limits', 'display', 'trialEnd' (présents dans SubscriptionSummary)
export interface SubscriptionState {
  plan:               Plan;
  status:             string;
  interval:           string | null;
  currentPeriodEnd:   string | null;
  cancelAtPeriodEnd:  boolean;
  trialEnd:           string | null;
  limits: {
    conversionsPerMonth:  number;
    concurrentJobs:       number;
    maxSourceFileSizeMb:  number;
    maxFilesPerProject:   number;
    githubExport:         boolean;
    advancedFrameworks:   boolean;
    teamWorkspace:        boolean;
    apiAccess:            boolean;
    watermark:            boolean;
    queuePriority:        number;
    trialDays:            number;
  } | null;
  display: {
    name:  string;
    price: { monthly: number; annual: number };
    badge: string;
    color: string;
  } | null;
  provider?: string;
}

// FIX: planId au lieu de {plan, interval} — correspond à CreateCheckoutDto backend
interface CheckoutPayload {
  planId: string;
}

// FIX: tous les alias de payment_url que le backend peut renvoyer
interface CheckoutResponse {
  payment_url?:  string;
  checkoutUrl?:  string;
  url?:          string;
  checkoutId?:   string;
  amount?:       number;
  currency?:     string;
}

interface PortalResponse {
  url: string;
}

// ── API calls ─────────────────────────────────────────────

// FIX: /subscription/plans retourne {success, data: {plans: [...]}}
// apiClient.get().then(r => r.data) retourne {success, data: {plans:[...]}}
// On doit donc lire r.data?.data?.plans ?? r.data?.plans
const fetchPlans = (): Promise<PlanInfo[]> =>
  apiClient
    .get<{ success: boolean; data: { plans: PlanInfo[] } } | { plans: PlanInfo[] }>('/subscription/plans')
    .then(r => {
      const raw = r.data as {
        success?: boolean;
        data?: { plans?: PlanInfo[] } | PlanInfo[];
        plans?: PlanInfo[];
      };
      // Unwrap TransformInterceptor: {success, data: {plans: [...]}}
      const inner = raw?.data as { plans?: PlanInfo[] } | PlanInfo[] | undefined;
      if (inner && !Array.isArray(inner) && Array.isArray(inner.plans)) {
        console.log('[useSubscription] fetchPlans ✅ unwrapped from data.plans:', inner.plans.length, 'plans');
        return inner.plans;
      }
      // Fallback: data est déjà un tableau
      if (Array.isArray(inner)) {
        console.log('[useSubscription] fetchPlans ✅ data is array:', inner.length, 'plans');
        return inner as PlanInfo[];
      }
      // Fallback: plans directement à la racine
      if (Array.isArray(raw?.plans)) {
        console.log('[useSubscription] fetchPlans ✅ root plans:', raw.plans!.length, 'plans');
        return raw.plans!;
      }
      console.warn('[useSubscription] fetchPlans ⚠️ structure inattendue:', raw);
      return [];
    });

// FIX: /subscription/me retourne {success, data: SubscriptionSummary}
// apiClient.get().then(r => r.data) retourne {success, data: {...}}
// On doit lire r.data?.data
const fetchMe = (): Promise<SubscriptionState> =>
  apiClient
    .get<{ success: boolean; data: SubscriptionState } | SubscriptionState>('/subscription/me')
    .then(r => {
      const raw = r.data as {
        success?: boolean;
        data?: SubscriptionState;
        plan?: Plan;
      };
      // Unwrap TransformInterceptor: {success, data: SubscriptionSummary}
      if (raw?.success !== undefined && raw?.data) {
        console.log('[useSubscription] fetchMe ✅ unwrapped:', raw.data.plan, raw.data.status);
        return raw.data as SubscriptionState;
      }
      // Fallback: réponse directe (pas de wrapper)
      if (raw?.plan) {
        console.log('[useSubscription] fetchMe ✅ direct:', raw.plan);
        return raw as unknown as SubscriptionState;
      }
      console.warn('[useSubscription] fetchMe ⚠️ structure inattendue:', raw);
      return raw as unknown as SubscriptionState;
    });

// FIX: route corrigée /payments/checkout (LeekPay réel)
// au lieu de /subscription/checkout (Stripe legacy → retourne /dashboard/billing)
const createCheckout = (payload: CheckoutPayload): Promise<CheckoutResponse> =>
  apiClient
    .post<{ success: boolean; data: CheckoutResponse } | CheckoutResponse>('/payments/checkout', payload)
    .then(r => {
      const raw = r.data as {
        success?: boolean;
        data?: CheckoutResponse;
        payment_url?: string;
        checkoutUrl?: string;
        url?: string;
      };
      console.log('[useSubscription] createCheckout raw response:', raw);
      // Unwrap TransformInterceptor
      if (raw?.success !== undefined && raw?.data) {
        return raw.data as CheckoutResponse;
      }
      return raw as CheckoutResponse;
    });

const createPortal = (): Promise<PortalResponse> =>
  apiClient
    .post<{ success: boolean; data: PortalResponse } | PortalResponse>('/subscription/portal')
    .then(r => {
      const raw = r.data as { success?: boolean; data?: PortalResponse; url?: string };
      if (raw?.success !== undefined && raw?.data) return raw.data as PortalResponse;
      return raw as PortalResponse;
    });

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
    onSuccess: (data) => {
      // Récupérer l'URL de paiement depuis n'importe quel alias
      const paymentUrl =
        data?.payment_url ??
        data?.checkoutUrl ??
        data?.url;
      console.log('[useSubscription] useCheckout onSuccess, paymentUrl:', paymentUrl);
      if (paymentUrl) {
        window.location.href = paymentUrl;
      } else {
        console.error('[useSubscription] useCheckout: aucune URL de paiement dans la réponse', data);
      }
    },
    onError: (err) => {
      console.error('[useSubscription] useCheckout error:', err);
    },
  });
}

export function useBillingPortal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createPortal,
    onSuccess:  (data) => {
      qc.invalidateQueries({ queryKey: ['subscription'] });
      if (data?.url) window.location.href = data.url;
    },
  });
}

// ── Utility helpers ───────────────────────────────────────
export function usePlanFeature(feature: keyof NonNullable<SubscriptionState['limits']>) {
  const { data: sub }   = useSubscription();
  const { data: plans } = usePlans();

  if (!sub || !plans) return false;
  // D'abord essayer les limites de la subscription courante
  if (sub.limits && feature in sub.limits) {
    return sub.limits[feature as keyof NonNullable<SubscriptionState['limits']>];
  }
  // Fallback: chercher dans les plans
  const plan = plans.find(p => p.id === sub.plan);
  if (!plan) return false;
  return plan.limits[feature];
}

export function useIsFreePlan() {
  const { data: sub } = useSubscription();
  return sub?.plan === 'free';
}

// FIX: lit limits.conversionsPerMonth au lieu de usage.conversionsLimit (qui n'existe pas)
// Note: usage réel doit être fetché depuis /quota/me — SubscriptionState n'a PAS de champ usage
export function useUsagePercent() {
  const { data: sub } = useSubscription();
  if (!sub) return 0;
  const limit = sub.limits?.conversionsPerMonth ?? 0;
  if (limit <= 0) return 0; // illimité
  // Sans données d'usage réelles (quota), on ne peut pas calculer le pourcentage
  // Retourner 0 par défaut plutôt que NaN
  return 0;
}
