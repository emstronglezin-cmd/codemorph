// ============================================================
// CodeMorph — TESTS PHASE 39 : corrélation des requêtes entrantes
// ------------------------------------------------------------
// Symptôme rapporté : « Aucun log correspondant n'est visible dans les
// Runtime Logs de l'AI Engine » pour une requête rejetée.
//
// Cause vérifiée : dans src/index.ts, `app.use(json({ limit: '50mb' }))` était
// monté AVANT `requestLogger`. Quand le corps est illisible ou trop lourd,
// body-parser lève AVANT que requestLogger n'ait tourné → aucun `x-request-id`
// écho, aucune ligne de log de requête → requête incorréliable avec le Backend
// qui, lui, envoie bien un X-Request-Id.
//
// Ce fichier teste l'ORDRE RÉEL des middlewares (celui de src/index.ts) et
// inclut un CONTRE-TEST qui rejoue l'ancien ordre pour prouver que le fix
// change quelque chose d'observable.
// ============================================================
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { json } from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

import { requestLogger } from '../src/api/middleware/logger.middleware';
import { errorHandler }  from '../src/api/middleware/error.middleware';

/** Reproduit l'ordre ACTUEL de src/index.ts (après le fix phase 39). */
function buildAppCurrentOrder(): Express {
  const app = express();
  app.use((req, res, next) => requestLogger(req, res, next));
  app.use(json({ limit: '1kb' }));
  app.post('/api/convert', (req: Request, res: Response) => {
    res.status(202).json({ jobId: 'j', accepted: true, echo: !!req.body });
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use(errorHandler as any);
  return app;
}

/** Reproduit l'ordre AVANT le fix (json avant requestLogger). */
function buildAppLegacyOrder(): Express {
  const app = express();
  app.use(json({ limit: '1kb' }));
  app.use((req, res, next) => requestLogger(req, res, next));
  app.post('/api/convert', (_req: Request, res: Response) => {
    res.status(202).json({ jobId: 'j', accepted: true });
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use(errorHandler as any);
  return app;
}

interface ProbeResult {
  status:  number;
  headers: http.IncomingHttpHeaders;
  body:    string;
}

async function withServer(app: Express, fn: (port: number) => Promise<void>): Promise<void> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  try {
    await fn((server.address() as AddressInfo).port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function post(port: number, rawBody: string, contentType = 'application/json'): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1', port, path: '/api/convert', method: 'POST',
        headers: {
          'content-type':  contentType,
          'content-length': Buffer.byteLength(rawBody),
          'x-request-id':  'corr-test-123',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += String(c); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(rawBody);
  });
}

describe('Ordre des middlewares — corrélation des requêtes rejetées', () => {
  it('APRÈS le fix : un corps JSON illisible écho QUAND MÊME le x-request-id', async () => {
    await withServer(buildAppCurrentOrder(), async (port) => {
      const res = await post(port, '{"jobId": "broken",,,}');
      expect(res.status).toBe(400);
      // C'est le cœur du fix : l'identifiant de corrélation survit au rejet.
      expect(res.headers['x-request-id']).toBe('corr-test-123');
    });
  });

  it('CONTRE-TEST : avec l\'ancien ordre, le x-request-id est PERDU', async () => {
    await withServer(buildAppLegacyOrder(), async (port) => {
      const res = await post(port, '{"jobId": "broken",,,}');
      expect(res.status).toBe(400);
      // Preuve que le fix change un comportement observable.
      expect(res.headers['x-request-id']).toBeUndefined();
    });
  });

  it('APRÈS le fix : un corps trop lourd (> limite) écho aussi le x-request-id', async () => {
    await withServer(buildAppCurrentOrder(), async (port) => {
      const res = await post(port, JSON.stringify({ sourceCode: 'x'.repeat(5_000) }));
      expect(res.status).toBe(413);
      expect(res.headers['x-request-id']).toBe('corr-test-123');
    });
  });

  it('une requête valide continue de fonctionner (202) avec x-request-id', async () => {
    await withServer(buildAppCurrentOrder(), async (port) => {
      const res = await post(port, JSON.stringify({ jobId: 'ok', sourceCode: 'void main(){}' }));
      expect(res.status).toBe(202);
      expect(res.headers['x-request-id']).toBe('corr-test-123');
      expect(JSON.parse(res.body)).toMatchObject({ accepted: true });
    });
  });

  it('sans x-request-id entrant, un identifiant est généré et écho', async () => {
    const app = express();
    app.use((req, res, next) => requestLogger(req, res, next));
    app.use(json({ limit: '1kb' }));
    app.post('/api/convert', (_q: Request, res: Response) => res.status(202).json({ ok: true }));

    await withServer(app, async (port) => {
      const res = await new Promise<ProbeResult>((resolve, reject) => {
        const raw = JSON.stringify({ jobId: 'x' });
        const r = http.request(
          {
            host: '127.0.0.1', port, path: '/api/convert', method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) },
          },
          (rs) => {
            let b = '';
            rs.on('data', (c) => { b += String(c); });
            rs.on('end', () => resolve({ status: rs.statusCode ?? 0, headers: rs.headers, body: b }));
          },
        );
        r.on('error', reject);
        r.end(raw);
      });
      expect(res.status).toBe(202);
      expect(typeof res.headers['x-request-id']).toBe('string');
      expect((res.headers['x-request-id'] as string).length).toBeGreaterThan(0);
    });
  });
});

describe('errorHandler — rejet du corps explicitement identifiable', () => {
  function fakeRes() {
    const res = {
      statusCode: 0,
      payload:    undefined as unknown,
      status(code: number) { this.statusCode = code; return this; },
      json(body: unknown)  { this.payload = body; return this; },
    };
    return res;
  }

  it('entity.parse.failed → 400 sans fuite du corps de la requête', () => {
    const res = fakeRes();
    const err = Object.assign(new SyntaxError('Unexpected token'), {
      type: 'entity.parse.failed', statusCode: 400,
    });
    const req = { method: 'POST', url: '/api/convert', headers: { 'content-length': '42' } } as unknown as Request;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    errorHandler(err as any, req, res as any, (() => undefined) as NextFunction);

    expect(res.statusCode).toBe(400);
    // Le message générique est renvoyé au client (non operational) : aucune
    // portion du corps utilisateur ne sort.
    expect(JSON.stringify(res.payload)).not.toContain('Unexpected token');
  });

  it('entity.too.large → 413', () => {
    const res = fakeRes();
    const err = Object.assign(new Error('request entity too large'), {
      type: 'entity.too.large', statusCode: 413,
    });
    const req = { method: 'POST', url: '/api/convert', headers: {} } as unknown as Request;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    errorHandler(err as any, req, res as any, (() => undefined) as NextFunction);

    expect(res.statusCode).toBe(413);
  });
});
