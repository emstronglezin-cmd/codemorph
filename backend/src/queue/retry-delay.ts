// ============================================================
// CodeMorph — Stratégie de délai de retry unique et partagée
//
// UNE SEULE source de vérité pour les délais entre tentatives,
// utilisée par :
//   • Bull (stratégie custom 'conversion-retry' enregistrée dans
//     JobsProcessor.onModuleInit)
//   • MemoryQueueProvider (fallback sans Redis)
//
// Politique :
//   1. Si l'erreur porte un Retry-After (retryAfterMs) → il est
//      RESPECTÉ (+1s de marge), plafonné à CONVERSION_RETRY_AFTER_CAP_MS.
//   2. Sinon → backoff exponentiel base × 2^(attempt-1) avec jitter ±25%,
//      plafonné à CONVERSION_RETRY_MAX_DELAY_MS.
//
// Variables d'environnement (backend) :
//   CONVERSION_MAX_ATTEMPTS         défaut 3       tentatives max par job
//   CONVERSION_BACKOFF_BASE_MS      défaut 5000    délai de base
//   CONVERSION_RETRY_MAX_DELAY_MS   défaut 120000  plafond backoff (2 min)
//   CONVERSION_RETRY_AFTER_CAP_MS   défaut 120000  plafond Retry-After (2 min)
// ============================================================
import { retryAfterMsOf } from './retryable.error';

export function envInt(key: string, defaultValue: number, min: number, max: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return defaultValue;
  return Math.min(max, Math.max(min, parsed));
}

/** Nombre max de tentatives d'un job de conversion (env: CONVERSION_MAX_ATTEMPTS). */
export function getMaxAttempts(): number {
  // FIX PHASE 38 — Défaut augmenté de 3 à 5 :
  // Avec Render free tier, la fenêtre de rate-limit peut durer >1 minute.
  // 3 tentatives (backoff 5s+10s = 15s total) ne suffisent pas.
  // 5 tentatives (backoff 5s+10s+20s+40s = 75s total) couvrent la fenêtre
  // de rate-limit Render sans délai excessif.
  return envInt('CONVERSION_MAX_ATTEMPTS', 5, 1, 10);
}

/**
 * Parse un header HTTP `Retry-After`.
 * Formats supportés : secondes ("25", "2.5") ou date HTTP ("Fri, 31 Dec 2026 23:59:59 GMT").
 * Retourne le délai en ms, ou undefined si absent/invalide.
 */
export function parseRetryAfterHeader(value: string | string[] | undefined | null): number | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  // Format delta-seconds
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number.parseFloat(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.ceil(seconds * 1000);
  }

  // Format date HTTP
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

export interface RetryDelayOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryAfterCapMs?: number;
  /** Injecté pour les tests (défaut: Math.random) */
  randomFn?: () => number;
}

/**
 * Calcule le délai avant la prochaine tentative.
 * @param err          l'erreur de la tentative qui vient d'échouer
 * @param attemptsMade nombre de tentatives déjà effectuées (≥1 au moment du retry)
 */
export function computeRetryDelayMs(err: unknown, attemptsMade: number, opts: RetryDelayOptions = {}): number {
  const base   = opts.baseDelayMs     ?? envInt('CONVERSION_BACKOFF_BASE_MS',    5_000,   100,     600_000);
  const max    = opts.maxDelayMs      ?? envInt('CONVERSION_RETRY_MAX_DELAY_MS', 120_000, 1_000, 3_600_000);
  const raCap  = opts.retryAfterCapMs ?? envInt('CONVERSION_RETRY_AFTER_CAP_MS', 120_000, 1_000, 3_600_000);
  const random = opts.randomFn ?? Math.random;

  // 1. Retry-After fourni par le serveur → respecté (plafonné)
  const retryAfterMs = retryAfterMsOf(err);
  if (retryAfterMs !== undefined) {
    return Math.max(0, Math.min(retryAfterMs + 1_000, raCap));
  }

  // 2. Backoff exponentiel + jitter ±25%
  const attempt = Math.max(1, attemptsMade);
  const exponential = base * Math.pow(2, attempt - 1);
  const capped = Math.min(exponential, max);
  const jittered = capped * (0.75 + random() * 0.5);
  return Math.round(Math.min(jittered, max));
}

/**
 * Stratégie de backoff Bull enregistrée sous le nom 'conversion-retry'.
 * Signature Bull : (attemptsMade, err) => délai ms.
 */
export function conversionBackoffStrategy(attemptsMade: number, err: unknown): number {
  return computeRetryDelayMs(err, attemptsMade);
}

/** Nom de la stratégie de backoff partagée (Bull). */
export const CONVERSION_BACKOFF_TYPE = 'conversion-retry';
