// ============================================================
// CodeMorph AI Engine — PHASE 36: Resilience (429 / timeouts / réseau)
//
// DIFFÉRENCIATION des erreurs :
//   rate-limit (429 Groq OU 429 Render) → retry avec backoff progressif + jitter
//                                          + respect EXACT du header Retry-After
//   timeout                              → retry (backoff)
//   network (ECONNRESET, ECONNREFUSED…)  → retry (backoff)
//   server (5xx)                         → retry (backoff)
//   auth (401/403)                       → NON-RETRYABLE (définitif)
//   bad-request (400/413, prompt trop grand) → NON-RETRYABLE (définitif à cette taille)
//   quota épuisé / content policy        → NON-RETRYABLE
//
// GARANTIES :
//   • Jamais de boucle infinie — max AI_RETRY_MAX_ATTEMPTS tentatives.
//   • NonRetryableAIError pour toute erreur définitive (aligné Phase 35).
//   • Logs structurés [AI-RETRY] sans aucun secret.
// ============================================================

import { getPhase36Config } from './config';

export type AIErrorKind =
  | 'rate-limit'
  | 'timeout'
  | 'network'
  | 'server'
  | 'auth'
  | 'bad-request'
  | 'quota'
  | 'unknown';

/** Erreur définitive — ne JAMAIS retenter (aligné avec NonRetryableError Phase 35 du backend). */
export class NonRetryableAIError extends Error {
  readonly kind: AIErrorKind;
  readonly httpStatus?: number | undefined;
  constructor(message: string, kind: AIErrorKind = 'unknown', httpStatus?: number) {
    super(message);
    this.name = 'NonRetryableAIError';
    this.kind = kind;
    this.httpStatus = httpStatus;
  }
}

export interface ClassifiedError {
  kind: AIErrorKind;
  retryAfterMs?: number | undefined; // header Retry-After si présent
  httpStatus?: number | undefined;
  message: string;
}

// ── Classification ────────────────────────────────────────────────────────────
export function classifyAIError(err: unknown): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err);
  const statusMatch = message.match(/\b(4\d\d|5\d\d)\b/);
  const httpStatus = statusMatch?.[1] !== undefined ? Number.parseInt(statusMatch[1], 10) : undefined;

  // Retry-After : "Retry-After: 12.5s", "retry after 8s", "Please try again in 5.2s"
  const retryMatch = message.match(/(?:retry[- ]after|try again in)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*s/i);
  const retryAfterSec = retryMatch?.[1] !== undefined ? Number.parseFloat(retryMatch[1]) : undefined;

  const lower = message.toLowerCase();

  if (httpStatus === 429 || lower.includes('rate limit') || lower.includes('rate_limit')) {
    return {
      kind: 'rate-limit',
      retryAfterMs: retryAfterSec !== undefined ? Math.ceil(retryAfterSec * 1000) : undefined,
      httpStatus: 429,
      message,
    };
  }
  if (httpStatus === 401 || httpStatus === 403 || lower.includes('unauthorized') || lower.includes('invalid api key') || lower.includes('forbidden')) {
    return { kind: 'auth', httpStatus, message };
  }
  if (httpStatus === 400 || httpStatus === 413 || lower.includes('context length') || lower.includes('too large') || lower.includes('maximum context')) {
    return { kind: 'bad-request', httpStatus, message };
  }
  if (lower.includes('quota') || lower.includes('billing') || lower.includes('exceeded your current quota')) {
    return { kind: 'quota', httpStatus, message };
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('etimedout') || lower.includes('deadline')) {
    return { kind: 'timeout', message };
  }
  if (
    lower.includes('connection error') || lower.includes('fetch failed') ||
    lower.includes('econnreset') || lower.includes('econnrefused') || lower.includes('enotfound') ||
    lower.includes('network') || lower.includes('socket hang up') || lower.includes('epipe')
  ) {
    return { kind: 'network', message };
  }
  if (httpStatus !== undefined && httpStatus >= 500) {
    return { kind: 'server', httpStatus, message };
  }
  return { kind: 'unknown', httpStatus, message };
}

const RETRYABLE_KINDS: ReadonlySet<AIErrorKind> = new Set(['rate-limit', 'timeout', 'network', 'server']);

export function isRetryable(classified: ClassifiedError): boolean {
  return RETRYABLE_KINDS.has(classified.kind);
}

// ── Backoff progressif avec jitter ────────────────────────────────────────────
export function computeBackoffMs(attempt: number, classified: ClassifiedError): number {
  const cfg = getPhase36Config();
  // Respect EXACT du Retry-After (avec petite marge 1s) si le provider le fournit
  if (classified.retryAfterMs !== undefined && classified.retryAfterMs > 0) {
    return Math.min(classified.retryAfterMs + 1_000, cfg.retryMaxDelayMs);
  }
  // Backoff exponentiel : base * 2^(attempt-1), plafonné
  const exponential = cfg.retryDelayMs * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(exponential, cfg.retryMaxDelayMs);
  // Jitter ±20% pour désynchroniser les workers concurrents
  const jitter = capped * (0.8 + Math.random() * 0.4);
  return Math.min(Math.max(0, Math.round(jitter)), cfg.retryMaxDelayMs);
}

export interface RetryLogContext {
  projectId: string;
  chunkId?: string;
  phase?: string;
}

export interface ResilienceOptions {
  maxAttempts?: number;
  log?: ((line: string) => void) | undefined;
  context?: RetryLogContext | undefined;
  /** Injecté pour les tests — remplace setTimeout */
  sleepFn?: ((ms: number) => Promise<void>) | undefined;
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exécute fn avec la politique de résilience Phase 36.
 *   attempt 1 → erreur retryable → attend → attempt 2 → … → max attempts → NonRetryableAIError
 *   erreur définitive (auth/quota/bad-request) → NonRetryableAIError IMMÉDIATEMENT.
 */
export async function withResilience<T>(
  fn: () => Promise<T>,
  options: ResilienceOptions = {},
): Promise<T> {
  const cfg = getPhase36Config();
  const maxAttempts = options.maxAttempts ?? cfg.retryMaxAttempts;
  const sleep = options.sleepFn ?? defaultSleep;
  const ctx = options.context;
  const tag = ctx ? `[${ctx.phase ?? 'AI'}] project=${ctx.projectId}${ctx.chunkId ? ` chunk=${ctx.chunkId}` : ''}` : '[AI]';

  let lastClassified: ClassifiedError | null = null;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // Une NonRetryableAIError remontée par un niveau interne est définitive.
      if (err instanceof NonRetryableAIError) throw err;
      lastError = err;
      lastClassified = classifyAIError(err);

      if (!isRetryable(lastClassified)) {
        options.log?.(
          `${tag} [AI-NONRETRYABLE] kind=${lastClassified.kind} status=${lastClassified.httpStatus ?? '-'} error="${truncate(lastClassified.message, 180)}"`,
        );
        throw new NonRetryableAIError(
          `${lastClassified.kind}: ${truncate(lastClassified.message, 300)}`,
          lastClassified.kind,
          lastClassified.httpStatus,
        );
      }

      if (attempt >= maxAttempts) {
        options.log?.(
          `${tag} [AI-RETRY-EXHAUSTED] kind=${lastClassified.kind} attempts=${attempt}/${maxAttempts} error="${truncate(lastClassified.message, 180)}" — giving up (no infinite loop)`,
        );
        throw new NonRetryableAIError(
          `retries exhausted (${lastClassified.kind}): ${truncate(lastClassified.message, 300)}`,
          lastClassified.kind,
          lastClassified.httpStatus,
        );
      }

      const waitMs = computeBackoffMs(attempt, lastClassified);
      options.log?.(
        `${tag} [AI-RETRY] reason=${lastClassified.kind === 'rate-limit' ? '429' : lastClassified.kind} ` +
        `attempt=${attempt}/${maxAttempts} retryAfter=${waitMs}ms ` +
        `(serverRetryAfter=${lastClassified.retryAfterMs ?? 'none'})`,
      );
      await sleep(waitMs);
    }
  }

  // Inatteignable (la boucle lance toujours) — garde-fou TypeScript
  throw new NonRetryableAIError(
    `retries exhausted: ${lastClassified?.message ?? String(lastError)}`,
    lastClassified?.kind ?? 'unknown',
  );
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}
