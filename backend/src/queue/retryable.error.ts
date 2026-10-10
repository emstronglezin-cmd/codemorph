// ============================================================
// CodeMorph — RetryableError
// Erreur TRANSITOIRE réessayable (429, 5xx, timeout, réseau…)
//
// Complément de NonRetryableError : la file (Bull ou MemoryQueue)
// planifie une nouvelle tentative avec backoff (Retry-After respecté
// si fourni, sinon exponentiel + jitter — voir retry-delay.ts).
//
// Le processeur (ConversionProcessorService) ne marque JAMAIS le job
// FAILED pour une RetryableError tant qu'il reste des tentatives.
// ============================================================

export type RetryableErrorKind =
  | 'rate-limit'   // HTTP 429 (provider / edge / proxy)
  | 'server'       // HTTP 5xx
  | 'timeout'      // délai dépassé
  | 'network'      // ECONNREFUSED / ECONNRESET / DNS…
  | 'quota-window' // quota local (ex: fenêtre AI req/heure) — reset connu
  | 'unavailable'  // circuit breaker ouvert, service temporairement indisponible
  | 'unknown';

export interface RetryableErrorOptions {
  /** Catégorie de l'erreur (pour logs et tests) */
  kind?: RetryableErrorKind;
  /** Statut HTTP d'origine, si pertinent */
  httpStatus?: number;
  /** Délai annoncé par le serveur (header Retry-After), en ms */
  retryAfterMs?: number;
  /** Identifiant de requête corrélé (X-Request-Id), pour traces safe */
  requestId?: string;
  /** Nom du composant/provider à l'origine de l'erreur (jamais de secret) */
  provider?: string;
}

/**
 * Erreur qui signale à la file que ce job PEUT être retenté.
 * Propriétés conservées sur l'instance pour la stratégie de backoff :
 *   • retryAfterMs → respecté en priorité (plafonné)
 *   • sinon backoff exponentiel + jitter (computeRetryDelayMs)
 */
export class RetryableError extends Error {
  readonly retryable = true as const;
  readonly kind: RetryableErrorKind;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
  readonly provider?: string;

  constructor(message: string, options: RetryableErrorOptions = {}, cause?: Error) {
    super(message);
    this.name = 'RetryableError';
    this.kind = options.kind ?? 'unknown';
    this.httpStatus = options.httpStatus;
    this.retryAfterMs = options.retryAfterMs;
    this.requestId = options.requestId;
    this.provider = options.provider;
    if (cause) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

/** True si l'erreur est explicitement marquée réessayable. */
export function isRetryableError(err: unknown): err is RetryableError {
  return (
    err instanceof RetryableError ||
    (typeof err === 'object' && err !== null && (err as { retryable?: boolean }).retryable === true)
  );
}

/** True si l'erreur est explicitement marquée NON réessayable. */
export function isNonRetryableError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    ((err as { name?: string }).name === 'NonRetryableError' ||
      (err as { nonRetryable?: boolean }).nonRetryable === true)
  );
}

/** Extrait retryAfterMs d'une erreur quelconque (undefined si absent/invalide). */
export function retryAfterMsOf(err: unknown): number | undefined {
  const v = (err as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}
