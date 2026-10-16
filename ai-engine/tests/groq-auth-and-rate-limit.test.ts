// ============================================================
// CodeMorph — TESTS PHASE 40 : problèmes A (auth Groq) et B (rate limit)
// ------------------------------------------------------------
// PROBLÈME A — un 401 « Invalid API Key » n'était pas distingué d'une erreur
//   transitoire : il tombait dans la branche `else` de groqChat et faisait
//   simplement `throw`. Chaque chunk refaisait donc un appel complet avec la
//   même clé invalide, après avoir attendu le rate-limiter.
//
// PROBLÈME B — un appel ÉCHOUÉ facturait `projectedPerReq` (~4 400 tokens) au
//   budget TPM alors que le fournisseur n'avait rien consommé. Avec une limite
//   à 7 000 TPM, un seul échec saturait la fenêtre et imposait un reset complet
//   (~54 s) à l'appel suivant, en plus du délai minimal de 8 s.
//
// Aucune clé réelle n'est utilisée : uniquement des valeurs de test à la forme
// attendue, et l'on vérifie qu'aucune ne fuit dans les logs.
// ============================================================

const TEST_KEY = 'gsk_TEST_ONLY_not_a_real_key_0000000000';

// Le singleton GroqRateLimiter lit ses variables d'environnement à la
// construction du module : il faut les poser AVANT l'import.
process.env['GROQ_API_KEY']            = TEST_KEY;
process.env['AI_MIN_INTERVAL_MS']      = '0';
process.env['AI_RATE_LIMIT_TPM']       = '7000';
process.env['AI_PROVIDER_MAX_CONCURRENT'] = '3';

// Mock du SDK OpenAI (Groq est compatible OpenAI) — aucun appel réseau.
const createMock = jest.fn();
jest.mock('openai', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      chat: { completions: { create: (...a: unknown[]) => createMock(...a) } },
    })),
  };
});

import {
  AIProvider,
  GroqAuthError,
  GroqRateLimiter,
  isGroqAuthError,
  assertGroqKeyConfigured,
  buildGroqAuthMessage,
  getGroqAuthFailure,
  resetGroqAuthFailureForTests,
  GROQ_API_KEY_ENV,
} from '../src/core/ai-provider';

/** Erreur telle que le SDK OpenAI la produit : `status` posé sur l'instance. */
function makeApiError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function makeProvider(): AIProvider {
  return new AIProvider({});
}

const MESSAGES = [{ role: 'user' as const, content: 'convert this dart file' }];

function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spies = ['log', 'warn', 'error'].map((m) =>
    jest.spyOn(console, m as 'log').mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(' '));
    }),
  );
  return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
}

beforeEach(() => {
  createMock.mockReset();
  resetGroqAuthFailureForTests();
  process.env['GROQ_API_KEY'] = TEST_KEY;
});

// ────────────────────────────────────────────────────────────────────────────
describe('Problème A — détection de l\'erreur d\'authentification', () => {
  it('reconnaît un 401 via err.status (source fiable, pas de match texte)', () => {
    expect(isGroqAuthError(makeApiError(401, 'Invalid API Key'))).toBe(true);
    expect(isGroqAuthError(makeApiError(403, 'Forbidden'))).toBe(true);
  });

  it('reconnaît un 401 re-wrappé ayant perdu err.status (repli texte)', () => {
    expect(isGroqAuthError(new Error('401 Invalid API Key'))).toBe(true);
    expect(isGroqAuthError(new Error('Error: invalid_api_key provided'))).toBe(true);
  });

  it('ne confond PAS un 429 avec une erreur d\'authentification', () => {
    expect(isGroqAuthError(makeApiError(429, 'Rate limit reached'))).toBe(false);
    expect(isGroqAuthError(makeApiError(500, 'Internal server error'))).toBe(false);
    expect(isGroqAuthError(makeApiError(400, 'Bad request'))).toBe(false);
  });

  it('nomme la variable d\'environnement exacte attendue', () => {
    expect(GROQ_API_KEY_ENV).toBe('GROQ_API_KEY');
    expect(buildGroqAuthMessage(401)).toContain('GROQ_API_KEY');
    // Le message doit distinguer auth et débit, explicitement.
    expect(buildGroqAuthMessage(401)).toContain('Ce n\'est PAS une limite de débit');
  });

  it('assertGroqKeyConfigured refuse une clé absente ou vide, sans la journaliser', () => {
    delete process.env['GROQ_API_KEY'];
    expect(() => assertGroqKeyConfigured()).toThrow(GroqAuthError);

    process.env['GROQ_API_KEY'] = '   ';
    expect(() => assertGroqKeyConfigured()).toThrow(GroqAuthError);

    process.env['GROQ_API_KEY'] = TEST_KEY;
    expect(() => assertGroqKeyConfigured()).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('Problème A — un 401 arrête les appels inutiles', () => {
  it('premier 401 → GroqAuthError avec message explicite', async () => {
    createMock.mockRejectedValue(makeApiError(401, 'Invalid API Key'));
    const cap = captureConsole();
    try {
      await expect(
        // groqChat est privé : on y accède pour tester le comportement réel.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (makeProvider() as any).groqChat(MESSAGES, 1000, 'job-auth-1'),
      ).rejects.toBeInstanceOf(GroqAuthError);
    } finally {
      cap.restore();
    }

    expect(getGroqAuthFailure()).not.toBeNull();
    expect(getGroqAuthFailure()?.httpStatus).toBe(401);
    // Le log structuré est émis, et il ne contient PAS la clé.
    expect(cap.lines.some((l) => l.includes('[GROQ-AUTH-FAILED]'))).toBe(true);
    expect(cap.lines.join('\n')).not.toContain(TEST_KEY);
  });

  it('après un 401, les chunks suivants n\'émettent AUCUN appel HTTP', async () => {
    createMock.mockRejectedValue(makeApiError(401, 'Invalid API Key'));
    const cap = captureConsole();
    const provider = makeProvider();
    try {
      for (let i = 0; i < 5; i++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (provider as any).groqChat(MESSAGES, 1000, `job-auth-${i}`).catch(() => undefined);
      }
    } finally {
      cap.restore();
    }

    // Cœur du correctif : 1 seul appel réel pour 5 chunks, au lieu de 5.
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(cap.lines.some((l) => l.includes('[GROQ-AUTH-SKIPPED]'))).toBe(true);
  });

  it('un 401 ne déclenche PAS la cascade de modèles (inutile avec une clé invalide)', async () => {
    createMock.mockRejectedValue(makeApiError(401, 'Invalid API Key'));
    const cap = captureConsole();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (makeProvider() as any).groqChat(MESSAGES, 1000, 'job-auth-cascade').catch(() => undefined);
    } finally {
      cap.restore();
    }
    // 3 modèles × 2 tentatives auraient donné jusqu'à 6 appels ; on en veut 1.
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('clé absente → échec immédiat, aucun appel HTTP', async () => {
    delete process.env['GROQ_API_KEY'];
    createMock.mockResolvedValue({ choices: [{ message: { content: 'x' } }], usage: { total_tokens: 10 } });
    const cap = captureConsole();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect((makeProvider() as any).groqChat(MESSAGES, 1000, 'job-nokey'))
        .rejects.toBeInstanceOf(GroqAuthError);
    } finally {
      cap.restore();
    }
    expect(createMock).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('Problème A — un 429 reste transitoire et n\'est pas traité comme une auth', () => {
  it('429 → pas de verrou d\'authentification posé, backoff absorbé', async () => {
    // Un 429 puis un succès : la cascade doit absorber, pas verrouiller.
    createMock
      .mockRejectedValueOnce(makeApiError(429, 'Rate limit reached, retry in 1s'))
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'ok' } }],
        usage: { total_tokens: 42 },
      });

    // Le backoff 429 réel est `max(x+3, 20)` s. On le fait avancer en temps
    // simulé plutôt que d'attendre 20 s — le comportement testé est identique.
    jest.useFakeTimers();
    const cap = captureConsole();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pending = (makeProvider() as any).groqChat(MESSAGES, 1000, 'job-429');
      await jest.advanceTimersByTimeAsync(25_000);
      const res = await pending;
      expect(res.tokensUsed).toBe(42);
    } finally {
      cap.restore();
      jest.useRealTimers();
    }

    // Point clé : un 429 n'a PAS verrouillé l'authentification.
    expect(getGroqAuthFailure()).toBeNull();
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(cap.lines.some((l) => l.includes('[AI-ENGINE-429]'))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('Problème B — comptabilité des tokens du rate-limiter', () => {
  it('un appel RÉUSSI facture les tokens réellement consommés', () => {
    const limiter = new GroqRateLimiter();
    return limiter.acquire(4000).then((release) => {
      release(1234, 'success');
      expect(limiter.telemetry()['tpmUsed']).toBe(1234);
      expect(limiter.totalFailedRequests).toBe(0);
    });
  });

  it('un appel ÉCHOUÉ ne facture AUCUN token (cœur du problème B)', async () => {
    const limiter = new GroqRateLimiter();
    const release = await limiter.acquire(4000);
    release(0, 'failed');

    expect(limiter.telemetry()['tpmUsed']).toBe(0);
    expect(limiter.totalFailedRequests).toBe(1);
    // Le compteur de diagnostic montre ce que l'ancien code aurait facturé.
    expect(limiter.phantomTokensAvoided).toBeGreaterThan(0);
  });

  it('RÉGRESSION : 20 échecs successifs ne saturent plus la fenêtre TPM', async () => {
    const limiter = new GroqRateLimiter();
    for (let i = 0; i < 20; i++) {
      const release = await limiter.acquire(4000);
      release(0, 'failed');
    }
    // Avec l'ancien code, la fenêtre aurait été saturée dès le 2e échec
    // (2 × ~4 000 > 7 000 TPM) et chaque appel suivant aurait attendu ~60 s.
    expect(limiter.telemetry()['tpmUsed']).toBe(0);
  });

  it('un succès sans usage rapporté reste prudent (facture la projection)', async () => {
    const limiter = new GroqRateLimiter();
    const release = await limiter.acquire(4000);
    release(0, 'success');
    expect(limiter.telemetry()['tpmUsed']).toBeGreaterThanOrEqual(3500);
  });

  it('sémaphore : jamais plus de MAX_CONCURRENT admissions simultanées', async () => {
    process.env['AI_PROVIDER_MAX_CONCURRENT'] = '2';
    const limiter = new GroqRateLimiter();
    let inflightPeak = 0;
    let inflightNow  = 0;

    const run = async (): Promise<void> => {
      const release = await limiter.acquire(100);
      inflightNow++;
      inflightPeak = Math.max(inflightPeak, inflightNow);
      await new Promise((r) => setTimeout(r, 10));
      inflightNow--;
      release(100, 'success');
    };

    await Promise.all(Array.from({ length: 8 }, run));
    expect(inflightPeak).toBeLessThanOrEqual(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((limiter as any).inflight).toBe(0);
    process.env['AI_PROVIDER_MAX_CONCURRENT'] = '3';
  });

  it('le paceur espace réellement les départs (réservation du créneau)', async () => {
    process.env['AI_MIN_INTERVAL_MS'] = '40';
    const limiter = new GroqRateLimiter();

    // Les deux acquisitions sont demandées en même temps. On horodate la
    // RÉSOLUTION de chacune (pas un point après le join, qui serait toujours
    // identique) : avec l'ancien code, les deux lisaient la même référence et
    // partaient ensemble.
    const t0 = Date.now();
    const resolvedAt: number[] = [];
    const p1 = limiter.acquire(100).then((r) => { resolvedAt.push(Date.now() - t0); return r; });
    const p2 = limiter.acquire(100).then((r) => { resolvedAt.push(Date.now() - t0); return r; });
    const [r1, r2] = await Promise.all([p1, p2]);
    r1(10, 'success');
    r2(10, 'success');

    // Mesurée sur des résolutions réelles : [≈32ms, ≈72ms] → écart de 40 ms.
    // On vérifie l'ÉCART (la propriété corrigée), pas les valeurs absolues qui
    // dépendent de la charge du runner.
    expect(resolvedAt).toHaveLength(2);
    expect(resolvedAt[1] - resolvedAt[0]).toBeGreaterThanOrEqual(35);
    process.env['AI_MIN_INTERVAL_MS'] = '0';
  });
});
