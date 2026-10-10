// ============================================================
// CodeMorph — TESTS stratégie de retry unique (retry-delay.ts)
//
// Couvre (Objectif 5) :
//   • TEST 1 : 429 avec Retry-After → délai différé = Retry-After respecté
//   • TEST 2 : erreur sans Retry-After → backoff exponentiel configuré + jitter
//   • Plafonds (Retry-After et backoff) jamais explosés
// ============================================================
import {
  parseRetryAfterHeader, computeRetryDelayMs, conversionBackoffStrategy,
} from '../retry-delay';
import { RetryableError } from '../retryable.error';

describe('parseRetryAfterHeader', () => {
  it('parse un délai en secondes entières', () => {
    expect(parseRetryAfterHeader('25')).toBe(25_000);
  });

  it('parse un délai en secondes décimales (arrondi supérieur)', () => {
    expect(parseRetryAfterHeader('2.5')).toBe(2_500);
  });

  it('parse une date HTTP future', () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    const parsed = parseRetryAfterHeader(future);
    expect(parsed).toBeDefined();
    // Tolérance 5s (le temps passe entre la création et le parse)
    expect(parsed!).toBeGreaterThan(20_000);
    expect(parsed!).toBeLessThanOrEqual(31_000);
  });

  it('retourne undefined pour absent / vide / invalide', () => {
    expect(parseRetryAfterHeader(undefined)).toBeUndefined();
    expect(parseRetryAfterHeader(null)).toBeUndefined();
    expect(parseRetryAfterHeader('')).toBeUndefined();
    expect(parseRetryAfterHeader('   ')).toBeUndefined();
    expect(parseRetryAfterHeader('nimporte quoi')).toBeUndefined();
    expect(parseRetryAfterHeader([''])).toBeUndefined();
  });

  it('une date Retry-After déjà passée → délai 0 (retry immédiat, jamais négatif)', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfterHeader(past)).toBe(0);
  });
});

describe('computeRetryDelayMs — Retry-After respecté (TEST 1)', () => {
  const opts = { baseDelayMs: 5_000, maxDelayMs: 120_000, retryAfterCapMs: 120_000 };

  it('utilise Retry-After (+1s de marge) quand fourni', () => {
    const err = new RetryableError('429', { kind: 'rate-limit', retryAfterMs: 25_000 });
    expect(computeRetryDelayMs(err, 1, opts)).toBe(26_000);
  });

  it('plafonne un Retry-After démesuré (jamais de retry bloquant)', () => {
    const err = new RetryableError('429', { kind: 'rate-limit', retryAfterMs: 3_600_000 });
    expect(computeRetryDelayMs(err, 1, opts)).toBe(120_000);
  });

  it('ignore un retryAfterMs invalide (0 ou négatif)', () => {
    const err = { retryAfterMs: 0 } as unknown;
    const delay = computeRetryDelayMs(err, 1, { ...opts, randomFn: () => 0.5 });
    // retombe sur le backoff exponentiel : base * 2^0 * jitter(0.5→1.0) = 5000
    expect(delay).toBe(5_000);
  });
});

describe('computeRetryDelayMs — backoff exponentiel + jitter (TEST 2)', () => {
  const opts = { baseDelayMs: 5_000, maxDelayMs: 120_000, retryAfterCapMs: 120_000 };

  it('croît de façon exponentielle avec les tentatives', () => {
    // randomFn fixé à 0.5 → jitter neutre (facteur 1.0)
    const neutral = { ...opts, randomFn: () => 0.5 };
    expect(computeRetryDelayMs(new Error('x'), 1, neutral)).toBe(5_000);
    expect(computeRetryDelayMs(new Error('x'), 2, neutral)).toBe(10_000);
    expect(computeRetryDelayMs(new Error('x'), 3, neutral)).toBe(20_000);
  });

  it('applique un jitter borné ±25%', () => {
    const minDelay = computeRetryDelayMs(new Error('x'), 1, { ...opts, randomFn: () => 0 });
    const maxDelay = computeRetryDelayMs(new Error('x'), 1, { ...opts, randomFn: () => 1 });
    expect(minDelay).toBe(3_750);  // 5000 × 0.75
    expect(maxDelay).toBe(6_250);  // 5000 × 1.25
  });

  it('plafonne le backoff à maxDelayMs', () => {
    const neutral = { ...opts, randomFn: () => 0.5 };
    expect(computeRetryDelayMs(new Error('x'), 10, neutral)).toBe(120_000);
  });

  it('est utilisable directement comme stratégie Bull', () => {
    const err = new RetryableError('429', { retryAfterMs: 12_000 });
    // conversionBackoffStrategy lit l'env pour les plafonds ; avec Retry-After
    // le résultat est retryAfterMs + 1s borné par CONVERSION_RETRY_AFTER_CAP_MS
    const delay = conversionBackoffStrategy(1, err);
    expect(delay).toBeGreaterThanOrEqual(12_000);
    expect(delay).toBeLessThanOrEqual(13_000);
  });
});
