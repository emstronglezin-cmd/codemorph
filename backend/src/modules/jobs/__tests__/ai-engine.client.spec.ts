// ============================================================
// CodeMorph — TESTS AiEngineClient (classification des erreurs HTTP)
//
// Couvre (Objectif 5) :
//   • TEST 1 : 429 + Retry-After → RetryableError avec retryAfterMs parsé
//   • TEST 2 : 429 sans Retry-After → RetryableError (backoff configuré ensuite)
//   • TEST 4 : erreur permanente (401) → NonRetryableError, pas de retry
//   • TEST 9 : erreurs provider distinguées (429 rate-limit vs 500 serveur
//              vs réseau) + message d'erreur du fournisseur préservé
//   • SÉCURITÉ : aucun secret (AI_ENGINE_SECRET) ne fuite dans les logs
// ============================================================
import { of, throwError } from 'rxjs';
import { AxiosError, AxiosHeaders } from 'axios';

import { AiEngineClient }    from '../ai-engine.client';
import { RetryableError }    from '../../../queue/retryable.error';
import { NonRetryableError } from '../../../queue/non-retryable.error';

const SECRET = 'super-secret-value-that-must-never-be-logged';

function makeAxiosError(status: number | undefined, headers: Record<string, string> = {}, data: unknown = {}): AxiosError {
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

function makeClient(httpPostMock: jest.Mock): {
  client: AiEngineClient;
  logSpy: jest.SpyInstance; warnSpy: jest.SpyInstance; errorSpy: jest.SpyInstance;
} {
  const http = { post: httpPostMock } as never;
  const config = {
    get: jest.fn((key: string, def?: unknown) => {
      if (key === 'AI_ENGINE_URL') return 'https://ai-engine.test';
      if (key === 'AI_ENGINE_SECRET') return SECRET;
      return def;
    }),
  } as never;

  const client = new AiEngineClient(http, config);
  // Espionner tous les canaux de log pour vérifier l'absence de fuite de secret
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const logger = (client as any).logger;
  return {
    client,
    logSpy:    jest.spyOn(logger, 'log').mockImplementation(() => undefined),
    warnSpy:   jest.spyOn(logger, 'warn').mockImplementation(() => undefined),
    errorSpy:  jest.spyOn(logger, 'error').mockImplementation(() => undefined),
  };
}

const baseReq = {
  jobId:          'job-123',
  sourceLanguage: 'flutter',
  targetLanguage: 'react-native',
  files:          [{ path: 'lib/main.dart', content: 'void main() {}' }],
  callbackUrl:    'https://backend.test/api/v1/jobs/job-123/callback',
};

function assertNoSecretLeak(spies: Array<jest.SpyInstance>): void {
  for (const spy of spies) {
    for (const call of spy.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(SECRET);
      }
    }
  }
}

describe('AiEngineClient.submitConversion — classification des erreurs', () => {
  it('TEST 1 : 429 + Retry-After → RetryableError avec retryAfterMs=25s (retry différé)', async () => {
    const post = jest.fn().mockReturnValue(
      throwError(() => makeAxiosError(429, { 'retry-after': '25' }, { error: 'too many requests' })),
    );
    const { client, logSpy, warnSpy, errorSpy } = makeClient(post);

    let caught: unknown;
    try {
      await client.submitConversion(baseReq);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(RetryableError);
    expect(caught).toMatchObject({
      retryable: true, kind: 'rate-limit', httpStatus: 429, retryAfterMs: 25_000,
    });
    // Log structuré [DISPATCH-429] émis avec les infos provider
    const allLogs = [...warnSpy.mock.calls, ...errorSpy.mock.calls, ...logSpy.mock.calls]
      .map((c) => String(c[0]));
    expect(allLogs.some((l) => l.includes('[DISPATCH-429]') && l.includes('errorType=rate-limit'))).toBe(true);
    expect(allLogs.some((l) => l.includes('retryAfterMs=25000'))).toBe(true);
    assertNoSecretLeak([logSpy, warnSpy, errorSpy]);
  });

  it('TEST 2 : 429 SANS Retry-After → RetryableError sans délai imposé (backoff de la file)', async () => {
    const post = jest.fn().mockReturnValue(
      throwError(() => makeAxiosError(429, {}, { error: 'too many requests' })),
    );
    const { client, logSpy, warnSpy, errorSpy } = makeClient(post);

    let caught: unknown;
    try {
      await client.submitConversion(baseReq);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(RetryableError);
    expect((caught as RetryableError).retryAfterMs).toBeUndefined();
    expect((caught as Error).message).toContain('429');
    // L'info du fournisseur est préservée dans le log (pas d'erreur générique muette)
    const allLogs = [...warnSpy.mock.calls, ...errorSpy.mock.calls].map((c) => String(c[0]));
    expect(allLogs.some((l) => l.includes('too many requests'))).toBe(true);
    assertNoSecretLeak([logSpy, warnSpy, errorSpy]);
  });

  it('TEST 4/9 : 401 (secret mismatch) → NonRetryableError, jamais retenté', async () => {
    const post = jest.fn().mockReturnValue(
      throwError(() => makeAxiosError(401, {}, { error: 'Unauthorized — invalid or missing X-AI-Engine-Secret' })),
    );
    const { client, logSpy, warnSpy, errorSpy } = makeClient(post);

    await expect(client.submitConversion(baseReq)).rejects.toBeInstanceOf(NonRetryableError);
    assertNoSecretLeak([logSpy, warnSpy, errorSpy]);
  });

  it('TEST 9 : 500 (erreur serveur) → RetryableError kind=server, message provider préservé', async () => {
    const post = jest.fn().mockReturnValue(
      throwError(() => makeAxiosError(502, {}, { error: 'pipeline crashed in phase 3' })),
    );
    const { client, logSpy, warnSpy, errorSpy } = makeClient(post);

    let caught: unknown;
    try {
      await client.submitConversion(baseReq);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RetryableError);
    expect(caught).toMatchObject({ kind: 'server', httpStatus: 502 });
    // L'erreur du fournisseur est préservée dans le message (pas écrasée)
    expect((caught as Error).message).toContain('pipeline crashed in phase 3');
    assertNoSecretLeak([logSpy, warnSpy, errorSpy]);
  });

  it('TEST 9 : erreur réseau (pas de réponse) → RetryableError kind=network distincte du 429 provider', async () => {
    const post = jest.fn().mockReturnValue(
      throwError(() => makeAxiosError(undefined)),
    );
    const { client } = makeClient(post);

    let caught: unknown;
    try {
      await client.submitConversion(baseReq);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RetryableError);
    expect(caught).toMatchObject({ kind: 'network' });
    expect((caught as RetryableError).httpStatus).toBeUndefined();
  });

  it('TEST 3 (amont) : réponse 202 → accepted=true, requestId corrélé envoyé', async () => {
    const post = jest.fn().mockReturnValue(
      of({ status: 202, data: { jobId: 'ai-engine-777', accepted: true, message: 'started' } }),
    );
    const { client } = makeClient(post);

    const res = await client.submitConversion(baseReq);
    expect(res).toMatchObject({ jobId: 'ai-engine-777', accepted: true });

    // L'en-tête de corrélation X-Request-Id est envoyé à l'AI Engine
    const [, , reqConfig] = post.mock.calls[0];
    const headers = (reqConfig as { headers: Record<string, string> }).headers;
    expect(headers['X-Request-Id']).toBeTruthy();
    expect(headers['X-AI-Engine-Secret']).toBe(SECRET); // secret transmis, mais jamais loggé
  });

  it('SÉCURITÉ : le secret AI_ENGINE_SECRET ne fuite dans aucun log, même en erreur', async () => {
    const post = jest.fn().mockReturnValue(
      throwError(() => makeAxiosError(429, { 'retry-after': '10' }, { error: 'too many requests' })),
    );
    const { client, logSpy, warnSpy, errorSpy } = makeClient(post);
    try { await client.submitConversion(baseReq); } catch { /* attendu */ }
    assertNoSecretLeak([logSpy, warnSpy, errorSpy]);
  });
});
