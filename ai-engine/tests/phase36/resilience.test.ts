// ============================================================
// CodeMorph AI Engine — TESTS résilience (429 / erreurs provider vs internes)
//
// Couvre (Objectif 5) :
//   • TEST 9 : les erreurs de FOURNISSEUR (429 Groq, auth, quota) sont
//              correctement distinguées des erreurs internes (timeout, réseau)
//   • TEST 1 : un 429 avec Retry-After déclenche un retry différé du délai annoncé
//   • TEST 2 : un 429 sans Retry-After utilise le backoff configuré
//   • TEST 3 : un succès après un 429 permet de continuer normalement
//   • TEST 4 : une erreur permanente n'est pas réessayée indéfiniment
//   • TEST 5 : les tentatives sont bornées (AI_RETRY_MAX_ATTEMPTS)
// ============================================================
import {
  classifyAIError, isRetryable, computeBackoffMs, withResilience, NonRetryableAIError,
} from '../../src/core/phase36/resilience';
import { resetPhase36Config } from '../../src/core/phase36/config';

function setTestEnv(maxDelayMs = 60_000): void {
  process.env['AI_RETRY_DELAY_MS'] = '10';
  process.env['AI_RETRY_MAX_ATTEMPTS'] = '4';
  process.env['AI_RETRY_MAX_DELAY_MS'] = String(maxDelayMs);
  resetPhase36Config();
}

describe('classifyAIError — différenciation provider vs erreurs internes (TEST 9)', () => {
  it('429 Groq ("Rate limit reached…try again in 12.5s") → rate-limit réessayable + Retry-After parsé', () => {
    const c = classifyAIError(
      new Error('429 Rate limit reached for model openai/gpt-oss-120b. Please try again in 12.5s'),
    );
    expect(c.kind).toBe('rate-limit');
    expect(c.httpStatus).toBe(429);
    expect(c.retryAfterMs).toBe(12_500);
    expect(isRetryable(c)).toBe(true);
  });

  it('401 / clé invalide → auth NON réessayable (erreur permanente de config)', () => {
    const c = classifyAIError(new Error('401 Unauthorized: Invalid API key provided'));
    expect(c.kind).toBe('auth');
    expect(isRetryable(c)).toBe(false);
  });

  it('400 contexte trop grand → bad-request NON réessayable (ne sert à rien de retenter identique)', () => {
    const c = classifyAIError(new Error('400 maximum context length exceeded, reduce your prompt'));
    expect(c.kind).toBe('bad-request');
    expect(isRetryable(c)).toBe(false);
  });

  it('quota épuisé → NON réessayable (erreur explicite, jamais simulée comme succès)', () => {
    const c = classifyAIError(new Error('You exceeded your current quota'));
    expect(c.kind).toBe('quota');
    expect(isRetryable(c)).toBe(false);
  });

  it('timeout interne → timeout réessayable (distinct du rate-limit provider)', () => {
    const c = classifyAIError(new Error('request timed out after 90000ms'));
    expect(c.kind).toBe('timeout');
    expect(isRetryable(c)).toBe(true);
    expect(c.httpStatus).toBeUndefined();
  });

  it('erreur réseau (ECONNRESET) → network réessayable', () => {
    const c = classifyAIError(new Error('socket hang up: read ECONNRESET'));
    expect(c.kind).toBe('network');
    expect(isRetryable(c)).toBe(true);
  });

  it('erreur serveur 5xx → server réessayable', () => {
    const c = classifyAIError(new Error('502 Bad Gateway from upstream'));
    expect(c.kind).toBe('server');
    expect(isRetryable(c)).toBe(true);
  });
});

describe('computeBackoffMs — Retry-After et backoff configuré', () => {
  beforeEach(setTestEnv);

  it('TEST 1 : Retry-After fourni → délai = Retry-After + 1s de marge (plafonné)', () => {
    const delay = computeBackoffMs(1, {
      kind: 'rate-limit', retryAfterMs: 12_500, message: 'x',
    });
    expect(delay).toBe(13_500);
  });

  it('Retry-After démesuré → plafonné à AI_RETRY_MAX_DELAY_MS', () => {
    setTestEnv(1_000); // plafond volontairement bas pour ce test
    const delay = computeBackoffMs(1, {
      kind: 'rate-limit', retryAfterMs: 3_600_000, message: 'x',
    });
    expect(delay).toBe(1_000); // AI_RETRY_MAX_DELAY_MS du test
  });

  it('TEST 2 : sans Retry-After → backoff exponentiel configuré (±20% jitter)', () => {
    // attempt=1 → base(10ms) × 2^0 = 10ms ±20% → [8, 12]
    for (let i = 0; i < 20; i++) {
      const delay = computeBackoffMs(1, { kind: 'rate-limit', message: 'x' });
      expect(delay).toBeGreaterThanOrEqual(8);
      expect(delay).toBeLessThanOrEqual(12);
    }
    // attempt=3 → base × 2^2 = 40ms ±20% → [32, 48]
    for (let i = 0; i < 20; i++) {
      const delay = computeBackoffMs(3, { kind: 'timeout', message: 'x' });
      expect(delay).toBeGreaterThanOrEqual(32);
      expect(delay).toBeLessThanOrEqual(48);
    }
  });
});

describe('withResilience — comportement de retry borné', () => {
  beforeEach(setTestEnv);
  const noSleep = async (): Promise<void> => undefined;

  it('TEST 3 : un succès après un 429 permet de continuer normalement', async () => {
    let calls = 0;
    const result = await withResilience(async () => {
      calls++;
      if (calls === 1) throw new Error('429 Rate limit reached, try again in 1s');
      return 'IR-OK';
    }, { sleepFn: noSleep, context: { projectId: 'p1' } });

    expect(result).toBe('IR-OK');
    expect(calls).toBe(2);
  });

  it('TEST 4 : une erreur permanente (auth) → NonRetryableAIError immédiate, 1 seul appel', async () => {
    let calls = 0;
    await expect(withResilience(async () => {
      calls++;
      throw new Error('401 Unauthorized invalid api key');
    }, { sleepFn: noSleep })).rejects.toBeInstanceOf(NonRetryableAIError);

    expect(calls).toBe(1); // jamais réessayée
  });

  it('TEST 5 : erreur réessayable persistante → exactement AI_RETRY_MAX_ATTEMPTS appels, puis abandon (pas de boucle infinie)', async () => {
    let calls = 0;
    await expect(withResilience(async () => {
      calls++;
      throw new Error('429 rate limit');
    }, { sleepFn: noSleep })).rejects.toBeInstanceOf(NonRetryableAIError);

    expect(calls).toBe(4); // AI_RETRY_MAX_ATTEMPTS=4 dans l'env de test
  });

  it('les délais de retry attendus utilisent bien sleepFn (retry différé)', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    await expect(withResilience(async () => {
      calls++;
      throw new Error('429 rate limit please retry after 2s');
    }, {
      sleepFn: async (ms) => { sleeps.push(ms); },
      maxAttempts: 3,
    })).rejects.toBeInstanceOf(NonRetryableAIError);

    // 2 retries avant abandon → 2 attentes, chacune = Retry-After(2s) + 1s de marge
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBe(3_000);
    expect(sleeps[1]).toBe(3_000);
  });
});
