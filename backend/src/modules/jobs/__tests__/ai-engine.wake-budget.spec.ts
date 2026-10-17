// ============================================================
// CodeMorph — TESTS : budget de réveil + classification d'état réel
// (FIX PHASE 43 — réveil fiable de l'AI Engine Render)
//
// Couvre :
//   • plancher de réveil PROGRESSIF avec jitter
//   • budget de réveil distinct → erreur EXPLICITE à l'épuisement
//   • réveil réussi → suivi réinitialisé
//   • classification des états : asleep / starting / up-unavailable /
//     rate-limited / server-error / network-error / ready
//   • un 429 n'est PAS supposé signifier « en veille »
//   • aucune fuite de secret dans les logs
// ============================================================
import { AxiosError, AxiosHeaders } from 'axios';
import { of, throwError } from 'rxjs';

import {
  AiEngineClient, type AiServiceState,
} from '../ai-engine.client';
import { NonRetryableError } from '../../../queue/non-retryable.error';
import { RetryableError }    from '../../../queue/retryable.error';

const SECRET = 'super-secret-ai-engine-token';

const HIBERNATION_HEADERS: Record<string, string> = {
  'rndr-id':                'rnd-abc123#eu-central-1',
  'server':                 'cloudflare',
  'x-render-origin-server': 'Render',
  'x-render-routing':       'hibernate-rate-limited',
};
// Marqueur prouvant que le process Node a réellement répondu.
const APP_HEADERS: Record<string, string> = { 'x-powered-by': 'Express' };

function axError(
  status: number | undefined,
  headers: Record<string, string> = {},
): AxiosError {
  const response = status === undefined ? undefined : {
    status,
    statusText: 'X',
    headers: new AxiosHeaders(headers),
    config: { headers: new AxiosHeaders() },
    data: { error: 'boom' },
  };
  const err = new AxiosError(
    status ? `Request failed with status code ${status}` : 'connect ECONNREFUSED',
    status ? 'ERR_BAD_REQUEST' : 'ECONNREFUSED',
    undefined, undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    response as any,
  );
  if (status === undefined) err.code = 'ECONNREFUSED';
  return err;
}

function makeClient(opts: {
  postMock?: jest.Mock;
  getMock?: jest.Mock;
} = {}) {
  const postMock = opts.postMock ?? jest.fn();
  const getMock  = opts.getMock  ?? jest.fn();
  const http = { post: postMock, get: getMock } as never;
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
    postMock,
    getMock,
    spies: [
      jest.spyOn(logger, 'log').mockImplementation(() => undefined),
      jest.spyOn(logger, 'warn').mockImplementation(() => undefined),
      jest.spyOn(logger, 'error').mockImplementation(() => undefined),
    ] as jest.SpyInstance[],
  };
}

const baseReq = {
  jobId:          'job-wake-1',
  sourceLanguage: 'flutter',
  targetLanguage: 'react-native',
  files:          [{ path: 'lib/main.dart', content: 'void main() {}' }],
  callbackUrl:    'https://backend.test/api/v1/jobs/job-wake-1/callback',
};

async function dispatchAndCatch(client: AiEngineClient, jobId = baseReq.jobId): Promise<unknown> {
  try { await client.submitConversion({ ...baseReq, jobId }); } catch (e) { return e; }
  return undefined;
}

describe('Budget de réveil — AiEngineClient', () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    process.env['AI_ENGINE_WAKE_MAX_ATTEMPTS'] = '6';
    process.env['AI_ENGINE_WAKE_BUDGET_MS']    = '240000';
    process.env['AI_ENGINE_HIBERNATION_WAIT_MS'] = '45000';
  });
  afterEach(() => {
    process.env = { ...OLD_ENV };
    jest.restoreAllMocks();
  });

  it('1er rejet d\'hibernation → RetryableError avec plancher ≥ 45 s (pas 2 s)', async () => {
    const { client, postMock } = makeClient({
      postMock: jest.fn(() => throwError(() => axError(429, HIBERNATION_HEADERS))),
    });

    const err = await dispatchAndCatch(client) as RetryableError;

    expect(err).toBeInstanceOf(RetryableError);
    expect(err.kind).toBe('rate-limit');
    expect(err.httpStatus).toBe(429);
    // Cœur du correctif : le plancher de réveil est bien porté par l'erreur.
    expect(err.minDelayMs).toBeGreaterThanOrEqual(36_000); // 45 s × jitter 0.8
    expect(err.minDelayMs).toBeLessThanOrEqual(54_000);    // 45 s × jitter 1.2
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('le plancher est PROGRESSIF : chaque tentative attend au moins autant que la précédente', async () => {
    const { client } = makeClient({
      postMock: jest.fn(() => throwError(() => axError(429, HIBERNATION_HEADERS))),
    });

    // La progression est comptabilisée PAR JOB : il faut donc réutiliser le
    // même jobId, comme le fait la file (le job n'est jamais recréé).
    process.env['AI_ENGINE_WAKE_MAX_ATTEMPTS'] = '10';
    const floors: number[] = [];
    for (let i = 0; i < 4; i++) {
      const err = await dispatchAndCatch(client, 'job-progressive') as RetryableError;
      floors.push(err.minDelayMs ?? 0);
    }
    // Tous au-dessus du plancher de base, et le 4e ≥ le 1er (progression).
    for (const f of floors) expect(f).toBeGreaterThanOrEqual(36_000);
    expect(floors[3]).toBeGreaterThanOrEqual(floors[0] as number);
  });

  it('budget épuisé → NonRetryableError EXPLICITE et exploitable (pas un échec générique)', async () => {
    process.env['AI_ENGINE_WAKE_MAX_ATTEMPTS'] = '3';
    const { client, spies } = makeClient({
      postMock: jest.fn(() => throwError(() => axError(429, HIBERNATION_HEADERS))),
    });

    let last: unknown;
    for (let i = 0; i < 3; i++) last = await dispatchAndCatch(client);

    expect(last).toBeInstanceOf(NonRetryableError);
    const msg = (last as Error).message;
    // Erreur exploitable : elle dit QUOI faire.
    expect(msg).toMatch(/did not wake up/i);
    expect(msg).toMatch(/paid Render instance|keep-awake/i);
    expect(msg).toMatch(/snapshot is preserved/i);
    // Et elle précise que le code applicatif n'a jamais été atteint.
    expect(msg).toMatch(/never reached/i);

    const logs = spies.flatMap((s) => s.mock.calls.map((c) => String(c[0])));
    expect(logs.some((l) => l.includes('[DISPATCH-WAKE-EXHAUSTED]'))).toBe(true);
  });

  it('réveil réussi → le suivi est réinitialisé pour les jobs suivants', async () => {
    let asleep = true;
    const postMock = jest.fn(() => {
      if (asleep) return throwError(() => axError(429, HIBERNATION_HEADERS));
      return of({
        status: 202,
        data: { jobId: baseReq.jobId, accepted: true, message: 'ok' },
        headers: {},
        config: { headers: new AxiosHeaders() },
        statusText: 'Accepted',
      });
    });
    const { client, spies } = makeClient({ postMock });

    // 1er essai : endormi
    const first = await dispatchAndCatch(client);
    expect(first).toBeInstanceOf(RetryableError);
    // 2e essai : l'instance est réveillée → succès
    asleep = false;
    const res = await client.submitConversion(baseReq);
    expect(res.accepted).toBe(true);

    const logs = spies.flatMap((s) => s.mock.calls.map((c) => String(c[0])));
    expect(logs.some((l) => l.includes('[DISPATCH-WAKE-RECOVERED]'))).toBe(true);

    // Un NOUVEAU job recommence au compteur 1 (suivi bien nettoyé, pas de fuite
    // de la Map entre jobs).
    asleep = true;
    const err = await dispatchAndCatch(client, 'job-after-recovery') as RetryableError;
    expect(err).toBeInstanceOf(RetryableError);
    expect(err.message).toMatch(/attempt 1\//);
  });

  it('aucun secret ne fuite dans les logs de réveil', async () => {
    process.env['AI_ENGINE_WAKE_MAX_ATTEMPTS'] = '2';
    const { client, spies } = makeClient({
      postMock: jest.fn(() => throwError(() => axError(429, HIBERNATION_HEADERS))),
    });
    for (let i = 0; i < 2; i++) await dispatchAndCatch(client);

    for (const spy of spies) {
      for (const c of spy.mock.calls) {
        for (const arg of c) expect(String(arg)).not.toContain(SECRET);
      }
    }
  });
});

describe('probeServiceState — classification de l\'état réel', () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => { process.env['AI_ENGINE_PROBE_MIN_INTERVAL_MS'] = '1'; });
  afterEach(() => { process.env = { ...OLD_ENV }; jest.restoreAllMocks(); });

  function probeWith(getMock: jest.Mock): Promise<AiServiceState> {
    const { client } = makeClient({ getMock });
    return client.probeServiceState(`job-${Math.random()}`).then((p) => p.state);
  }

  it('health 200 → ready', async () => {
    const getMock = jest.fn(() => of({ status: 200, data: { status: 'ok', uptime: '0m 7s' } }));
    expect(await probeWith(getMock)).toBe('ready');
  });

  it('429 + x-render-routing → asleep (et non « rate-limited »)', async () => {
    const getMock = jest.fn(() => throwError(() => axError(429, HIBERNATION_HEADERS)));
    expect(await probeWith(getMock)).toBe('asleep');
  });

  it('429 SANS x-render-routing mais AVEC marqueur app → rate-limited (pas asleep)', async () => {
    const getMock = jest.fn(() => throwError(() => axError(429, APP_HEADERS)));
    expect(await probeWith(getMock)).toBe('rate-limited');
  });

  it('503 + marqueur app → up-unavailable (démarré mais indisponible)', async () => {
    const getMock = jest.fn(() => throwError(() => axError(503, APP_HEADERS)));
    expect(await probeWith(getMock)).toBe('up-unavailable');
  });

  it('502 sans marqueur app → starting (Render a routé, l\'app pas encore là)', async () => {
    const getMock = jest.fn(() => throwError(() => axError(502, { 'rndr-id': 'rnd-xyz#' })));
    expect(await probeWith(getMock)).toBe('starting');
  });

  it('500 + marqueur app → server-error', async () => {
    const getMock = jest.fn(() => throwError(() => axError(500, APP_HEADERS)));
    expect(await probeWith(getMock)).toBe('server-error');
  });

  it('aucune réponse HTTP → network-error', async () => {
    const getMock = jest.fn(() => throwError(() => axError(undefined)));
    expect(await probeWith(getMock)).toBe('network-error');
  });
});
