// ============================================================
// CodeMorph — TESTS : 429 d'hibernation Render (spin-down free tier)
// ------------------------------------------------------------
// CAS PRODUCTION À L'ORIGINE DE CES TESTS :
//   HTTP 429 · durationMs=72 · retryAfterHeader=(absent)
//   x-render-routing=hibernate-rate-limited · rndr-id présent
//   provider=ai-engine-origin · provenance=origin      ← DIAGNOSTIC FAUX
//
// Un process Node ne démarre pas et ne répond pas en 72 ms. Ces en-têtes sont
// posés par la couche de routage de Render, qui rejette la requête parce que
// l'instance free tier est endormie (render.yaml : « web service avec sleep
// après 15min inactivité » ; documentation Render : le réveil prend ~1 minute).
//
// Ces tests verrouillent :
//   • le diagnostic correct (couche responsable = routage Render, pas l'app) ;
//   • un plancher d'attente aligné sur le temps de réveil réel ;
//   • l'absence d'ouverture du circuit breaker (l'app n'est pas en panne) ;
//   • aucune fuite de secret.
// ============================================================
import { throwError } from 'rxjs';
import { AxiosError, AxiosHeaders } from 'axios';

import {
  AiEngineClient,
  classifyRateLimitProvenance,
  isRenderHibernationRejection,
} from '../ai-engine.client';
import { RetryableError, minDelayMsOf } from '../../../queue/retryable.error';
import { computeRetryDelayMs, getMaxAttempts } from '../../../queue/retry-delay';

const SECRET = 'super-secret-value-that-must-never-be-logged';

/** En-têtes réellement observés sur le 429 de production rapporté. */
const HIBERNATION_HEADERS: Record<string, string> = {
  'server':         'cloudflare',
  'cf-ray':         'a48f8178be21763a-SEA',
  'rndr-id':        'b5582e53-073f-42cc',
  'x-render-routing': 'hibernate-rate-limited',
  'content-type':   'text/plain; charset=utf-8',
};

/** 429 réellement produit PAR L'APPLICATION (marqueurs applicatifs présents). */
const APP_429_HEADERS: Record<string, string> = {
  'server':       'cloudflare',
  'rndr-id':      'b5582e53-073f-42cc',
  'x-powered-by': 'Express',
  'x-request-id': 'req-app-429-1',
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    undefined,
    response as any,
  );
  if (status === undefined) err.code = 'ECONNREFUSED';
  return err;
}

function makeClient(httpPostMock: jest.Mock) {
  const http = { post: httpPostMock } as never;
  const config = {
    get: jest.fn((key: string, def?: unknown) => {
      if (key === 'AI_ENGINE_URL')    return 'https://ai-engine.test';
      if (key === 'AI_ENGINE_SECRET') return SECRET;
      return def;
    }),
  } as never;

  const client = new AiEngineClient(http, config);
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
  jobId:          'job-hiber-1',
  sourceLanguage: 'flutter',
  targetLanguage: 'react-native',
  files:          [{ path: 'lib/main.dart', content: 'void main() {}' }],
  callbackUrl:    'https://backend.test/api/v1/jobs/job-hiber-1/callback',
};

const allLogs = (spies: jest.SpyInstance[]): string[] =>
  spies.flatMap((s) => s.mock.calls.map((c) => String(c[0])));

function assertNoSecretLeak(spies: jest.SpyInstance[]): void {
  for (const spy of spies) {
    for (const call of spy.mock.calls) {
      for (const arg of call) expect(String(arg)).not.toContain(SECRET);
    }
  }
}

async function dispatchAndCatch(client: AiEngineClient): Promise<unknown> {
  try { await client.submitConversion(baseReq); } catch (e) { return e; }
  return undefined;
}

// ────────────────────────────────────────────────────────────────────────────
describe('isRenderHibernationRejection — détection de la porte d\'hibernation', () => {
  it('détecte x-render-routing: hibernate-rate-limited', () => {
    expect(isRenderHibernationRejection(HIBERNATION_HEADERS)).toBe(true);
  });

  it('tolère la casse mixte de l\'en-tête', () => {
    expect(isRenderHibernationRejection({ 'X-Render-Routing': 'hibernate-rate-limited' })).toBe(true);
  });

  it('un x-render-routing non lié à l\'hibernation ne déclenche rien', () => {
    expect(isRenderHibernationRejection({ 'x-render-routing': 'no-server' })).toBe(false);
    expect(isRenderHibernationRejection({ 'rndr-id': 'x' })).toBe(false);
    expect(isRenderHibernationRejection({})).toBe(false);
    expect(isRenderHibernationRejection(undefined)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('classifyRateLimitProvenance — le cas production est classé hibernation', () => {
  it('les en-têtes réels du 429 rapporté → provenance=hibernation (et PLUS origin)', () => {
    const prov = classifyRateLimitProvenance(HIBERNATION_HEADERS);
    expect(prov.provenance).toBe('hibernation');
    expect(prov.provider).toBe('render-hibernation');
    expect(prov.verdict).toMatch(/endormi|hibern/i);
  });

  it('CONTRE-TEST : un 429 émis par l\'application reste provenance=origin', () => {
    const prov = classifyRateLimitProvenance(APP_429_HEADERS);
    expect(prov.provenance).toBe('origin');
    expect(prov.provider).toBe('ai-engine-origin');
  });

  it('hibernation prioritaire même si des marqueurs applicatifs traînent', () => {
    // Si Render rejette à l'éveil, l'app n'a pas répondu : l'hibernation gagne.
    const prov = classifyRateLimitProvenance({
      ...HIBERNATION_HEADERS,
      'x-powered-by': 'Express',
    });
    expect(prov.provenance).toBe('hibernation');
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('AiEngineClient — dispatch face à une instance endormie', () => {
  it('429 hibernation → RetryableError avec plancher d\'attente, provider=render-hibernation', async () => {
    const post = jest.fn().mockReturnValue(
      throwError(() => makeAxiosError(429, HIBERNATION_HEADERS, 'Your service is starting up')),
    );
    const { client, logSpy, warnSpy, errorSpy } = makeClient(post);

    const caught = await dispatchAndCatch(client);

    expect(caught).toBeInstanceOf(RetryableError);
    expect(caught).toMatchObject({
      kind: 'rate-limit', httpStatus: 429, provider: 'render-hibernation',
    });
    // Le plancher doit couvrir le temps de réveil documenté (~1 minute).
    expect(minDelayMsOf(caught)).toBeGreaterThanOrEqual(45_000);
    assertNoSecretLeak([logSpy, warnSpy, errorSpy]);
  });

  it('le log nomme la couche responsable, le statut, la durée et la décision', async () => {
    const post = jest.fn().mockReturnValue(
      throwError(() => makeAxiosError(429, HIBERNATION_HEADERS, {})),
    );
    const { client, logSpy, warnSpy, errorSpy } = makeClient(post);
    await dispatchAndCatch(client);

    const logs = allLogs([logSpy, warnSpy, errorSpy]);
    const line = logs.find((l) => l.includes('[DISPATCH-429-HIBERNATION]'));
    expect(line).toBeDefined();
    expect(line).toContain('httpStatus=429');
    expect(line).toContain('errorType=hibernation');
    expect(line).toContain('layer=render-routing');
    expect(line).toContain('durationMs=');
    expect(line).toContain('nextAttemptFloorMs=');
    expect(line).toContain('action=WAIT_FOR_SPIN_UP_VIA_QUEUE_BACKOFF');
  });

  it('RÉGRESSION : le 429 d\'hibernation n\'est PLUS étiqueté provider=ai-engine-origin', async () => {
    const post = jest.fn().mockReturnValue(
      throwError(() => makeAxiosError(429, HIBERNATION_HEADERS, {})),
    );
    const { client, logSpy, warnSpy, errorSpy } = makeClient(post);
    const caught = await dispatchAndCatch(client);

    expect((caught as RetryableError).provider).not.toBe('ai-engine-origin');
    expect(allLogs([logSpy, warnSpy, errorSpy]).join('\n')).not.toContain('provenance=origin');
  });

  it('un 429 d\'hibernation n\'ouvre PAS le circuit breaker (l\'app n\'est pas en panne)', async () => {
    const post = jest.fn().mockReturnValue(
      throwError(() => makeAxiosError(429, HIBERNATION_HEADERS, {})),
    );
    const { client } = makeClient(post);

    for (let i = 0; i < 6; i++) await dispatchAndCatch(client);

    expect(client.isCircuitOpen).toBe(false);
  });

  it('Retry-After fourni par le serveur reste prioritaire s\'il est plus long', async () => {
    const post = jest.fn().mockReturnValue(
      throwError(() => makeAxiosError(429, { ...HIBERNATION_HEADERS, 'retry-after': '120' }, {})),
    );
    const { client } = makeClient(post);
    const caught = await dispatchAndCatch(client);

    // computeRetryDelayMs = max(plancher, Retry-After + 1s)
    expect(computeRetryDelayMs(caught, 1)).toBeGreaterThanOrEqual(120_000);
  });

  it('aucun secret dans les logs du cas hibernation', async () => {
    const post = jest.fn().mockReturnValue(
      throwError(() => makeAxiosError(429, { ...HIBERNATION_HEADERS, 'x-ai-engine-secret': SECRET }, {})),
    );
    const { client, logSpy, warnSpy, errorSpy } = makeClient(post);
    await dispatchAndCatch(client);
    assertNoSecretLeak([logSpy, warnSpy, errorSpy]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('Politique de retry — le plancher couvre le temps de réveil Render', () => {
  const hibernationErr = new RetryableError('hibernating', {
    kind: 'rate-limit', httpStatus: 429, minDelayMs: 45_000,
  });

  it('première tentative : le plancher remplace le backoff de 5 s', () => {
    const plain = new RetryableError('plain 429', { kind: 'rate-limit', httpStatus: 429 });
    expect(computeRetryDelayMs(plain, 1, { randomFn: () => 0.5 })).toBeLessThan(10_000);
    expect(computeRetryDelayMs(hibernationErr, 1, { randomFn: () => 0.5 })).toBeGreaterThanOrEqual(45_000);
  });

  it('le plancher ne peut qu\'ALLONGER l\'attente, jamais la raccourcir', () => {
    // Backoff exponentiel au-delà du plancher → la valeur exponentielle gagne.
    const d = computeRetryDelayMs(hibernationErr, 6, { randomFn: () => 0.5 });
    expect(d).toBeGreaterThanOrEqual(45_000);
  });

  it('sur 5 tentatives, l\'attente cumulée dépasse la minute de réveil documentée', () => {
    const max = getMaxAttempts();
    let cumulé = 0;
    for (let attempt = 1; attempt < max; attempt++) {
      cumulé += computeRetryDelayMs(hibernationErr, attempt, { randomFn: () => 0.5 });
    }
    expect(max).toBe(5);
    expect(cumulé).toBeGreaterThanOrEqual(60_000);
  });

  it('un 429 ordinaire (sans plancher) garde son backoff d\'origine', () => {
    const plain = new RetryableError('plain', { kind: 'rate-limit', httpStatus: 429 });
    expect(minDelayMsOf(plain)).toBeUndefined();
    expect(computeRetryDelayMs(plain, 1, { randomFn: () => 0.5 })).toBe(5_000);
  });
});
