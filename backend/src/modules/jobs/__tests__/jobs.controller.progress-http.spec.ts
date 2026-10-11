// ============================================================
// CodeMorph — TEST E2E HTTP PHASE 40 : la route de progression RÉPOND
// ------------------------------------------------------------
// La cause racine du « bloqué à 50 % » n'était pas une méthode manquante mais
// une ROUTE non déclarée : chaque POST de l'AI Engine vers
// `POST /api/v1/jobs/:id/progress` recevait un 404.
//
// Les tests unitaires du contrôleur ne prouvent PAS que Nest enregistre la
// route, ni que @Public() laisse passer l'AI Engine sans JWT. Ce test monte la
// vraie application HTTP (préfixe global `api/v1`, JwtAuthGuard global,
// ThrottlerGuard global) et tape la route pour de vrai.
// ============================================================
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import * as http from 'http';
import type { AddressInfo } from 'net';

import { JobsController } from '../jobs.controller';
import { JobsService } from '../jobs.service';
import { UploadsService } from '../../uploads/uploads.service';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { JwtStrategy } from '../../auth/strategies/jwt.strategy';
import { UsersService } from '../../users/users.service';

const SECRET = 'shared-secret-TEST-ONLY';
const JOB_ID = '11111111-1111-4111-8111-111111111111'; // UUID valide (ParseUUIDPipe)

let app: INestApplication;
let server: http.Server;
let baseUrl = '';
let handleProgress: jest.Mock;

/** Appel HTTP réel contre l'application Nest montée (pas de supertest). */
async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: { ok?: boolean; progress?: number; phase?: string } }> {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: { ok?: boolean; progress?: number; phase?: string };
  try { parsed = JSON.parse(text); } catch { parsed = { ok: undefined }; }
  return { status: res.status, body: parsed };
}

beforeAll(async () => {
  handleProgress = jest.fn().mockResolvedValue({ progress: 62, phase: 'phase_3_ir' });

  const moduleRef = await Test.createTestingModule({
    // Limite volontairement basse : si @SkipThrottle était absent, la 2e
    // requête prendrait un 429 au lieu d'un 200.
    imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1 }])],
    controllers: [JobsController],
    providers: [
      { provide: JobsService,    useValue: { handleProgress } },
      { provide: UploadsService, useValue: {} },
      { provide: ConfigService,  useValue: {
        get: (k: string, d?: string) => (k === 'AI_ENGINE_SECRET' ? SECRET : d),
      } },
      Reflector,
      // La VRAIE stratégie 'jwt' doit être enregistrée : sans elle, le garde
      // lèverait « Unknown authentication strategy » (500) au lieu de 401, et
      // le contre-test final ne prouverait rien.
      { provide: UsersService, useValue: { findById: jest.fn().mockResolvedValue(null) } },
      JwtStrategy,
      { provide: APP_GUARD, useClass: ThrottlerGuard },
      // Le vrai garde JWT global : sans @Public(), la route renverrait 401
      // parce qu'aucun token n'est fourni par l'AI Engine.
      { provide: APP_GUARD, useClass: JwtAuthGuard },
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1'); // même préfixe que main.ts
  await app.init();

  // Écoute sur un port éphémère : on tape la route pour de vrai, comme le ferait
  // l'AI Engine en production.
  server = app.getHttpServer() as http.Server;
  if (!server.listening) {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  }
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app?.close();
});

describe('E2E — POST /api/v1/jobs/:id/progress', () => {
  it('la route EXISTE : 200 au lieu du 404 qui gelait la progression', async () => {
    const res = await call('POST', `/api/v1/jobs/${JOB_ID}/progress`,
      { phase: 'phase_3_ir', phaseName: 'Analyse IR', filesDone: 15, filesTotal: 33 },
      { 'X-AI-Engine-Secret': SECRET });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, progress: 62, phase: 'phase_3_ir' });
  });

  it('@Public() : l\'AI Engine passe SANS JWT (sinon 401 du garde global)', async () => {
    const res = await call('POST', `/api/v1/jobs/${JOB_ID}/progress`,
      { phase: 'mapping', filesDone: 3, filesTotal: 33 },
      { 'X-AI-Engine-Secret': SECRET });

    // Aucun header Authorization envoyé.
    expect(res.status).toBe(200);
  });

  it('@SkipThrottle() : haute fréquence autorisée malgré la limite à 1 req/min', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await call('POST', `/api/v1/jobs/${JOB_ID}/progress`,
        { phase: 'mapping', filesDone: i, filesTotal: 33 },
        { 'X-AI-Engine-Secret': SECRET });
      codes.push(res.status);
    }
    expect(codes).toEqual([200, 200, 200, 200, 200]);
    expect(codes).not.toContain(429);
  });

  it('secret absent → 401 du contrôle applicatif, pas un 404 de route', async () => {
    const res = await call('POST', `/api/v1/jobs/${JOB_ID}/progress`,
      { phase: 'mapping', filesDone: 1, filesTotal: 33 });

    expect(res.status).toBe(401);
  });

  it('secret erroné → 401', async () => {
    const res = await call('POST', `/api/v1/jobs/${JOB_ID}/progress`,
      { phase: 'mapping', filesDone: 1, filesTotal: 33 },
      { 'X-AI-Engine-Secret': 'mauvais-secret' });

    expect(res.status).toBe(401);
  });

  it('id non-UUID → 400 du ParseUUIDPipe (la route est bien paramétrée)', async () => {
    const res = await call('POST', '/api/v1/jobs/pas-un-uuid/progress',
      { phase: 'mapping', filesDone: 1, filesTotal: 33 },
      { 'X-AI-Engine-Secret': SECRET });

    expect(res.status).toBe(400);
  });

  it('CONTRE-TEST : une route voisine non protégée renvoie bien 401 sans JWT', async () => {
    // Prouve que le garde JWT global est ACTIF dans cette app de test : si le
    // test précédent passait « parce qu'aucun garde ne tourne », celui-ci
    // passerait aussi. Il échoue volontairement en 401.
    const res = await call('GET', `/api/v1/jobs/${JOB_ID}`);

    expect(res.status).toBe(401);
  });
});
