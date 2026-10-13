// ============================================================
// CodeMorph — TEST : sonde /api/health/readiness
// ------------------------------------------------------------
// BUG CORRIGÉ : la sonde vérifiait uniquement OPENAI_API_KEY, alors que le
// tier par défaut du pipeline tourne sur GROQ_API_KEY (app.config.ts + gate de
// tier dans ai-provider.ts). Un déploiement Render configuré avec la seule clé
// Groq — le cas documenté dans render.yaml — était déclaré « not-ready » (503)
// alors qu'il est opérationnel. Si Render utilise cette route comme sonde de
// santé, l'instance est marquée indisponible à tort, ce qui aggrave les
// problèmes de réveil d'instance.
// ============================================================
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

import { healthRouter } from '../src/api/health.router';

let server: Server;
let baseUrl = '';

async function startApp(): Promise<void> {
  const app = express();
  app.use('/api/health', healthRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function stopApp(): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function getReadiness(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/health/readiness`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('GET /api/health/readiness — clé Groq acceptée', () => {
  const savedGroq  = process.env['GROQ_API_KEY'];
  const savedOpenAI = process.env['OPENAI_API_KEY'];

  beforeEach(async () => {
    delete process.env['GROQ_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    await startApp();
  });

  afterEach(async () => {
    await stopApp();
    if (savedGroq !== undefined)   process.env['GROQ_API_KEY']   = savedGroq;
    if (savedOpenAI !== undefined) process.env['OPENAI_API_KEY'] = savedOpenAI;
  });

  it('GROQ_API_KEY seule → 200 ready (cas réel du déploiement Render)', async () => {
    process.env['GROQ_API_KEY'] = 'gsk_test_only';
    const { status, body } = await getReadiness();

    expect(status).toBe(200);
    expect(body['status']).toBe('ready');
    expect(body['checks']).toMatchObject({ groq: 'ok' });
  });

  it('OPENAI_API_KEY seule → 200 ready (comportement historique préservé)', async () => {
    process.env['OPENAI_API_KEY'] = 'sk_test_only';
    const { status } = await getReadiness();

    expect(status).toBe(200);
  });

  it('aucune clé → 503 not-ready, les deux vérifications sont rapportées', async () => {
    const { status, body } = await getReadiness();

    expect(status).toBe(503);
    expect(body['status']).toBe('not-ready');
    expect(body['checks']).toMatchObject({ groq: 'missing-api-key', openai: 'missing-api-key' });
  });

  it('RÉGRESSION : la sonde ne renvoie plus 503 pour un déploiement Groq fonctionnel', async () => {
    process.env['GROQ_API_KEY'] = 'gsk_test_only';
    const { status } = await getReadiness();
    expect(status).not.toBe(503);
  });

  it('la sonde ne révèle jamais la valeur des clés', async () => {
    process.env['GROQ_API_KEY'] = 'gsk_VALEUR_ULTRA_SECRETE_123';
    const res = await fetch(`${baseUrl}/api/health/readiness`);
    const text = await res.text();
    expect(text).not.toContain('gsk_VALEUR_ULTRA_SECRETE_123');
  });

  it('GET /api/health reste public et répond 200 sans clé', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('GET /api/health/liveness répond 200 quelle que soit la configuration', async () => {
    const res = await fetch(`${baseUrl}/api/health/liveness`);
    expect(res.status).toBe(200);
  });
});
