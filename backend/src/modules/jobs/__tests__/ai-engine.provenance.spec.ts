// ============================================================
// CodeMorph — TESTS PHASE 39 : provenance RÉELLE du 429
// ------------------------------------------------------------
// Ces tests verrouillent la leçon des phases 37/38 : un 429 ne doit JAMAIS
// être attribué à « l'edge » sur la seule foi de `server: cloudflare`, car
// Render place tous les *.onrender.com derrière Cloudflare — cet en-tête est
// présent sur les 200 comme sur les 401 (vérifié le 2026-10-11 sur
// https://codemorph-1-rdx0.onrender.com).
//
// Couvre :
//   • provenance dérivée des en-têtes (origine vs edge vs inconnue)
//   • 429 avec marqueurs d'origine   → provider=ai-engine-origin
//   • 429 sans marqueur d'origine    → provider=edge-or-proxy
//   • succès 200 (et pas seulement 202) → accepté, circuit breaker intact
//   • limite de concurrence jamais dépassée (race de sur-admission)
//   • aucun secret dans les logs, y compris les nouveaux champs
// ============================================================
import { of, throwError } from 'rxjs';
import { AxiosError, AxiosHeaders } from 'axios';

import { AiEngineClient, classifyRateLimitProvenance } from '../ai-engine.client';
import { RetryableError }     from '../../../queue/retryable.error';
import { NonRetryableError }  from '../../../queue/non-retryable.error';

const SECRET = 'super-secret-value-that-must-never-be-logged';

/** En-têtes réellement observés sur une réponse venue de l'ORIGINE Render. */
const ORIGIN_HEADERS: Record<string, string> = {
  'server':                   'cloudflare',
  'cf-ray':                   'a48f8178be21763a-SEA',
  'rndr-id':                  'b5582e53-073f-42cc',
  'x-render-origin-server':   'Render',
  'x-powered-by':             'Express',
  'x-request-id':             'diag-test-A-1791738914',
  'content-type':             'application/json; charset=utf-8',
};

/** En-têtes d'une réponse produite AVANT l'application (CDN seul). */
const EDGE_ONLY_HEADERS: Record<string, string> = {
  'server':       'cloudflare',
  'cf-ray':       'a48f86e45bf2eb3e-SEA',
  'content-type': 'text/html; charset=UTF-8',
};

function makeAxiosError(
  status: number | undefined,
  headers: Record<string, string> = {},
  data: unknown = {},
): AxiosError {
  const response = status === undefined ? undefined : {
    status,
    statusText: `HTTP ${status}`,
    headers: new AxiosHeaders(headers),
    data,
    config: { headers: new AxiosHeaders() },
  };
  const err = new AxiosError(
    status ? `Request failed with status code ${status}` : 'connect ECONNREFUSED 10.0.0.5:5000',
    status ? 'ERR_BAD_REQUEST' : 'ECONNREFUSED',
    undefined,
    undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    response as any,
  );
  if (status === undefined) err.code = 'ECONNREFUSED';
  return err;
}

function makeClient(httpPostMock: jest.Mock, maxConcurrent?: number) {
  const http = { post: httpPostMock } as never;
  const config = {
    get: jest.fn((key: string, def?: unknown) => {
      if (key === 'AI_ENGINE_URL')    return 'https://ai-engine.test';
      if (key === 'AI_ENGINE_SECRET') return SECRET;
      return def;
    }),
  } as never;

  const client = new AiEngineClient(http, config);
  if (maxConcurrent !== undefined) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).MAX_DISPATCH_CONCURRENT = maxConcurrent;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const logger = (client as any).logger;
  return {
    client,
    logSpy:   jest.spyOn(logger, 'log').mockImplementation(() => undefined),
    warnSpy:  jest.spyOn(logger, 'warn').mockImplementation(() => undefined),
    errorSpy: jest.spyOn(logger, 'error').mockImplementation(() => undefined),
  };
}

const baseReq = {
  jobId:          'job-prov-1',
  sourceLanguage: 'flutter',
  targetLanguage: 'react-native',
  files:          [{ path: 'lib/main.dart', content: 'void main() {}' }],
  callbackUrl:    'https://backend.test/api/v1/jobs/job-prov-1/callback',
};

function allLogs(spies: jest.SpyInstance[]): string[] {
  return spies.flatMap((s) => s.mock.calls.map((c) => String(c[0])));
}

function assertNoSecretLeak(spies: jest.SpyInstance[]): void {
  for (const spy of spies) {
    for (const call of spy.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(SECRET);
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
describe('classifyRateLimitProvenance — déduction depuis les en-têtes réels', () => {
  it('marqueurs d\'origine présents → provenance=origin (pas edge)', () => {
    const prov = classifyRateLimitProvenance(ORIGIN_HEADERS);
    expect(prov.provenance).toBe('origin');
    expect(prov.provider).toBe('ai-engine-origin');
    expect(prov.hints).toContain('originMarkers=');
    expect(prov.hints).toContain('rndrId=');
    expect(prov.hints).toContain('renderOrigin=Render');
  });

  it('RÉGRESSION PHASE 37/38 : `server: cloudflare` seul ne prouve PAS l\'origine', () => {
    // C'est exactement l'erreur commise : conclure « edge » parce que Cloudflare.
    const prov = classifyRateLimitProvenance(EDGE_ONLY_HEADERS);
    expect(prov.provenance).toBe('edge');
    expect(prov.provider).toBe('edge-or-proxy');
    expect(prov.hints).toContain('originMarkers=none');
  });

  it('`server: cloudflare` n\'est JAMAIS traité comme un marqueur d\'origine', () => {
    // cloudflare + cf-ray + via, mais aucun marqueur applicatif → toujours edge
    const prov = classifyRateLimitProvenance({
      'server': 'cloudflare',
      'cf-ray': 'abc',
      'via':    '1.1 proxy',
    });
    expect(prov.provenance).toBe('edge');
  });

  it('aucun en-tête exploitable → provenance=unknown (on ne conclut pas)', () => {
    const prov = classifyRateLimitProvenance({});
    expect(prov.provenance).toBe('unknown');
    expect(prov.provider).toBe('unknown');
  });

  it('accepte des en-têtes en casse mixte (AxiosHeaders normalise, mais pas toujours)', () => {
    const prov = classifyRateLimitProvenance({
      'Server':                 'cloudflare',
      'X-Render-Origin-Server': 'Render',
    });
    expect(prov.provenance).toBe('origin');
  });

  it('chaque marqueur d\'origine suffit isolément à prouver l\'origine', () => {
    for (const header of ['rndr-id', 'x-render-origin-server', 'x-render-routing', 'x-powered-by', 'x-request-id']) {
      expect(classifyRateLimitProvenance({ [header]: 'x' }).provenance).toBe('origin');
    }
  });

  it('n\'écrit aucun secret dans les hints', () => {
    const prov = classifyRateLimitProvenance({ ...ORIGIN_HEADERS, 'x-ai-engine-secret': SECRET });
    expect(prov.hints).not.toContain(SECRET);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('AiEngineClient — 429 avec provenance démontrée', () => {
  it('429 venant de l\'ORIGINE → provider=ai-engine-origin, log provenance=origin', async () => {
    const post = jest.fn().mockReturnValue(
      throwError(() => makeAxiosError(429, ORIGIN_HEADERS, { error: 'too many requests' })),
    );
    const { client, logSpy, warnSpy, errorSpy } = makeClient(post);

    let caught: unknown;
    try { await client.submitConversion(baseReq); } catch (e) { caught = e; }

    expect(caught).toBeInstanceOf(RetryableError);
    expect(caught).toMatchObject({ kind: 'rate-limit', httpStatus: 429, provider: 'ai-engine-origin' });
    const logs = allLogs([logSpy, warnSpy, errorSpy]);
    expect(logs.some((l) => l.includes('[DISPATCH-429]') && l.includes('provenance=origin'))).toBe(true);
    expect(logs.some((l) => l.includes('provider=ai-engine-origin'))).toBe(true);
    assertNoSecretLeak([logSpy, warnSpy, errorSpy]);
  });

  it('429 venant de l\'EDGE → provider=edge-or-proxy, log provenance=edge', async () => {
    const post = jest.fn().mockReturnValue(
      throwError(() => makeAxiosError(429, EDGE_ONLY_HEADERS, '<html>rate limited</html>')),
    );
    const { client, logSpy, warnSpy, errorSpy } = makeClient(post);

    let caught: unknown;
    try { await client.submitConversion(baseReq); } catch (e) { caught = e; }

    expect(caught).toBeInstanceOf(RetryableError);
    expect(caught).toMatchObject({ kind: 'rate-limit', provider: 'edge-or-proxy' });
    const logs = allLogs([logSpy, warnSpy, errorSpy]);
    expect(logs.some((l) => l.includes('provenance=edge'))).toBe(true);
    assertNoSecretLeak([logSpy, warnSpy, errorSpy]);
  });

  it('Retry-After absent → le log le dit explicitement (retryAfterHeader=(absent))', async () => {
    const post = jest.fn().mockReturnValue(
      throwError(() => makeAxiosError(429, ORIGIN_HEADERS, {})),
    );
    const { client, logSpy, warnSpy, errorSpy } = makeClient(post);
    try { await client.submitConversion(baseReq); } catch { /* attendu */ }
    const logs = allLogs([logSpy, warnSpy, errorSpy]);
    expect(logs.some((l) => l.includes('retryAfterHeader=(absent)'))).toBe(true);
    expect(logs.some((l) => l.includes('retryAfterMs=none'))).toBe(true);
  });

  it('Retry-After présent mais non parsable → la valeur brute reste dans le log', async () => {
    const post = jest.fn().mockReturnValue(
      throwError(() => makeAxiosError(429, { ...ORIGIN_HEADERS, 'retry-after': 'not-a-date' }, {})),
    );
    const { client, logSpy, warnSpy, errorSpy } = makeClient(post);

    let caught: unknown;
    try { await client.submitConversion(baseReq); } catch (e) { caught = e; }

    expect((caught as RetryableError).retryAfterMs).toBeUndefined();
    const logs = allLogs([logSpy, warnSpy, errorSpy]);
    expect(logs.some((l) => l.includes('retryAfterHeader=not-a-date'))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('AiEngineClient — succès non-202 (bug de classification phase 34)', () => {
  it('réponse 200 → SUCCÈS accepté, PAS une erreur réseau, circuit breaker intact', async () => {
    const post = jest.fn().mockReturnValue(
      of({ status: 200, data: { jobId: 'ai-200', accepted: true, message: 'ok' } }),
    );
    const { client, logSpy, warnSpy, errorSpy } = makeClient(post);

    const res = await client.submitConversion(baseReq);

    expect(res).toMatchObject({ jobId: 'ai-200', accepted: true });
    // Avant le fix, un 200 produisait RetryableError kind=network + recordFailure()
    expect(client.isCircuitOpen).toBe(false);
    const logs = allLogs([logSpy, warnSpy, errorSpy]);
    expect(logs.some((l) => l.includes('errorType=network'))).toBe(false);
    expect(logs.some((l) => l.includes('[DISPATCH-RESPONSE]') && l.includes('httpStatus=200'))).toBe(true);
  });

  it('réponse 200 sans champ `accepted` → accepted déduit du statut (true)', async () => {
    const post = jest.fn().mockReturnValue(of({ status: 200, data: { jobId: 'ai-x' } }));
    const { client } = makeClient(post);
    const res = await client.submitConversion(baseReq);
    expect(res.accepted).toBe(true);
  });

  it('réponse 2xx avec accepted:false → respected tel quel (pas de succès forcé)', async () => {
    const post = jest.fn().mockReturnValue(
      of({ status: 202, data: { jobId: 'ai-y', accepted: false, message: 'queued elsewhere' } }),
    );
    const { client } = makeClient(post);
    const res = await client.submitConversion(baseReq);
    expect(res.accepted).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('AiEngineClient — limite de concurrence (race de sur-admission)', () => {
  it('6 dispatch parallèles avec MAX=2 → jamais plus de 2 requêtes HTTP en vol', async () => {
    const { from } = await import('rxjs');
    let inFlight = 0;
    let peak     = 0;

    const httpPost = jest.fn().mockImplementation(() => from(
      new Promise<{ status: number; data: unknown }>((resolve) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        // Rend l'overlap observable : sans limite, peak monterait à 6.
        setTimeout(() => {
          inFlight--;
          resolve({ status: 202, data: { jobId: 'j', accepted: true } });
        }, 15);
      }),
    ));

    const { client } = makeClient(httpPost, 2);

    const reqs = Array.from({ length: 6 }, (_, i) => ({ ...baseReq, jobId: `conc-${i}` }));
    await Promise.all(reqs.map((r) => client.submitConversion(r)));

    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(2);
    expect(httpPost).toHaveBeenCalledTimes(6);
  });

  it('RACE de sur-admission : un nouvel appel synchrone ne peut pas doubler un attendu', async () => {
    // Reproduction déterministe de l'entrelacement fautif de l'ancienne version.
    // Séquence : 2 slots pris (A, B) + 1 en attente (C). Puis A libère et D
    // arrive SYNCHRONE, avant que la microtâche de C n'ait incrémenté.
    //   ANCIEN code : release → inFlight 2→1, C résolu (microtâche en suspens)
    //                 D synchrone voit 1 < 2 → admis (inFlight=2)
    //                 microtâche de C → inFlight=3  ← LIMITE VIOLÉE
    //   NOUVEAU code : release TRANSFÈRE le slot à C sans décrémenter, donc D
    //                 voit inFlight=2 et se met en attente → jamais > 2.
    const { client } = makeClient(jest.fn(), 2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = client as any;

    const relA = await c.acquireDispatchSlot();  // A → slot 1
    const relB = await c.acquireDispatchSlot();  // B → slot 2
    expect(c.dispatchInFlight).toBe(2);

    const pC = c.acquireDispatchSlot();          // C se met en attente (0 slot libre)
    relA();                                      // libération SYNCHRONE de A
    const pD = c.acquireDispatchSlot();          // D arrive SYNCHRONE, avant la microtâche de C

    // On laisse passer la microtâche de C, puis on ÉCHANTILLONNE le compteur :
    // c'est à cet instant précis que l'ancien code montait à 3.
    const relC = await pC;
    const peak = c.dispatchInFlight as number;
    expect(peak).toBeLessThanOrEqual(2);

    // D ne peut obtenir un slot qu'après une nouvelle libération (B ou C) :
    // c'est le comportement attendu d'une limite à 2.
    relB();
    const relD = await pD;

    relC();
    relD();
    expect(c.dispatchInFlight).toBe(0);
    expect(c.dispatchWaitQueue.length).toBe(0);
  });

  it('tous les slots sont rendus après des échecs (pas de fuite de capacité)', async () => {
    const { from } = await import('rxjs');
    let inFlight = 0;
    let peak     = 0;

    const httpPost = jest.fn().mockImplementation(() => from(
      new Promise<never>((_resolve, reject) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        setTimeout(() => {
          inFlight--;
          reject(makeAxiosError(502, ORIGIN_HEADERS, { error: 'boom' }));
        }, 10);
      }),
    ));

    const { client } = makeClient(httpPost, 2);
    const reqs = Array.from({ length: 5 }, (_, i) => ({ ...baseReq, jobId: `leak-${i}` }));
    await Promise.allSettled(reqs.map((r) => client.submitConversion(r)));

    expect(peak).toBeLessThanOrEqual(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).dispatchInFlight).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).dispatchWaitQueue.length).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('AiEngineClient — erreurs définitives inchangées', () => {
  it('401 secret mismatch → NonRetryableError (aucun retry)', async () => {
    const post = jest.fn().mockReturnValue(
      throwError(() => makeAxiosError(401, ORIGIN_HEADERS, { error: 'Unauthorized' })),
    );
    const { client } = makeClient(post);
    await expect(client.submitConversion(baseReq)).rejects.toBeInstanceOf(NonRetryableError);
  });

  it('400 payload refusé → NonRetryableError (retry inutile à cette taille)', async () => {
    const post = jest.fn().mockReturnValue(
      throwError(() => makeAxiosError(400, ORIGIN_HEADERS, { error: 'sourceCode is required' })),
    );
    const { client } = makeClient(post);
    await expect(client.submitConversion(baseReq)).rejects.toBeInstanceOf(NonRetryableError);
  });

  it('5xx → RetryableError kind=server, message fournisseur préservé', async () => {
    const post = jest.fn().mockReturnValue(
      throwError(() => makeAxiosError(503, ORIGIN_HEADERS, { error: 'pipeline crashed' })),
    );
    const { client } = makeClient(post);
    let caught: unknown;
    try { await client.submitConversion(baseReq); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ kind: 'server', httpStatus: 503 });
    expect((caught as Error).message).toContain('pipeline crashed');
  });
});
