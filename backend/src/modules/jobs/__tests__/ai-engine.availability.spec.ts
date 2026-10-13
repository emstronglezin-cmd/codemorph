// ============================================================
// CodeMorph — TESTS : disponibilité du service AI Engine
// ------------------------------------------------------------
// Complète la liste de tests obligatoire : timeout et indisponibilité du
// service (le 429, le 401 et le 5xx étaient déjà couverts par
// ai-engine.client.spec.ts et ai-engine.provenance.spec.ts).
//
// Point vérifié avec attention : pendant le réveil d'une instance Render
// (~1 minute), un dispatch peut expirer sur le timeout axios de 35 s. Ce cas
// DOIT rester transitoire et ne doit pas être confondu avec une panne.
// ============================================================
import { of, throwError } from 'rxjs';
import { AxiosError, AxiosHeaders } from 'axios';

import { AiEngineClient }     from '../ai-engine.client';
import { RetryableError }     from '../../../queue/retryable.error';
import { NonRetryableError }  from '../../../queue/non-retryable.error';

function makeClient(httpPostMock: jest.Mock) {
  const http = { post: httpPostMock } as never;
  const config = {
    get: jest.fn((key: string, def?: unknown) => {
      if (key === 'AI_ENGINE_URL')    return 'https://ai-engine.test';
      if (key === 'AI_ENGINE_SECRET') return 'shared-secret';
      return def;
    }),
  } as never;
  const client = new AiEngineClient(http, config);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const logger = (client as any).logger;
  jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  return client;
}

const baseReq = {
  jobId:          'job-avail-1',
  sourceLanguage: 'flutter',
  targetLanguage: 'react-native',
  files:          [{ path: 'lib/main.dart', content: 'void main() {}' }],
  callbackUrl:    'https://backend.test/api/v1/jobs/job-avail-1/callback',
};

function axiosTimeoutError(): AxiosError {
  const err = new AxiosError(
    'timeout of 35000ms exceeded',
    'ECONNABORTED',
    undefined,
    undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    undefined as any,
  );
  return err;
}

function axiosRefusedError(): AxiosError {
  const err = new AxiosError(
    'connect ECONNREFUSED 10.0.0.5:5000',
    'ECONNREFUSED',
    undefined,
    undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    undefined as any,
  );
  return err;
}

async function dispatchAndCatch(client: AiEngineClient): Promise<unknown> {
  try { await client.submitConversion(baseReq); } catch (e) { return e; }
  return undefined;
}

describe('AiEngineClient — timeout et indisponibilité', () => {
  it('timeout axios (ECONNABORTED) → RetryableError kind=timeout, distinct du 429', async () => {
    const post = jest.fn().mockReturnValue(throwError(() => axiosTimeoutError()));
    const client = makeClient(post);

    const caught = await dispatchAndCatch(client);

    expect(caught).toBeInstanceOf(RetryableError);
    expect(caught).not.toBeInstanceOf(NonRetryableError);
    expect((caught as RetryableError).kind).toBe('timeout');
    expect((caught as RetryableError).httpStatus).toBeUndefined();
  });

  it('service injoignable (ECONNREFUSED) → RetryableError kind=network', async () => {
    const post = jest.fn().mockReturnValue(throwError(() => axiosRefusedError()));
    const client = makeClient(post);

    const caught = await dispatchAndCatch(client);

    expect(caught).toBeInstanceOf(RetryableError);
    expect((caught as RetryableError).kind).toBe('network');
  });

  it('aucun des deux n\'est traité comme permanent (pas de NonRetryableError)', async () => {
    for (const factory of [axiosTimeoutError, axiosRefusedError]) {
      const post = jest.fn().mockReturnValue(throwError(() => factory()));
      const caught = await dispatchAndCatch(makeClient(post));
      expect((caught as { nonRetryable?: boolean }).nonRetryable).not.toBe(true);
    }
  });

  it('le circuit breaker s\'ouvre après 5 échecs réseau consécutifs (protection conservée)', async () => {
    const post = jest.fn().mockReturnValue(throwError(() => axiosRefusedError()));
    const client = makeClient(post);

    for (let i = 0; i < 5; i++) await dispatchAndCatch(client);
    expect(client.isCircuitOpen).toBe(true);
  });

  it('un succès referme le circuit breaker', async () => {
    const post = jest.fn().mockReturnValue(throwError(() => axiosRefusedError()));
    const client = makeClient(post);
    for (let i = 0; i < 5; i++) await dispatchAndCatch(client);
    expect(client.isCircuitOpen).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).recordSuccess();
    expect(client.isCircuitOpen).toBe(false);
  });

  it('200 nominal → succès accepté, aucune erreur levée', async () => {
    // Le client consomme un Observable rxjs (HttpService), pas une promesse.
    const post = jest.fn().mockReturnValue(of({
      status: 200,
      headers: new AxiosHeaders({ 'x-powered-by': 'Express' }),
      data: { jobId: 'job-avail-1', accepted: true, message: 'ok' },
    }));
    const client = makeClient(post);

    const res = await client.submitConversion(baseReq);

    expect(res.accepted).toBe(true);
    expect(client.isCircuitOpen).toBe(false);
  });
});
