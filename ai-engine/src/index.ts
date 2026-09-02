// ============================================================
// CodeMorph — AI Engine Entry Point
// FIX PHASE 6: isCallbackUrlSafe déplacé dans utils/ssrf.ts (no circular import)
// ============================================================
import 'dotenv/config';
import express from 'express';
import { json } from 'express';
import pino from 'pino';

import { convertRouter }  from './api/convert.router';
import { healthRouter }   from './api/health.router';
import { errorHandler }   from './api/middleware/error.middleware';
import { requestLogger }  from './api/middleware/logger.middleware';
import { appConfig }      from './config/app.config';

// FIX PHASE 6: Import depuis utils/ssrf.ts pour éviter l'import circulaire
export { isCallbackUrlSafe } from './utils/ssrf';

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info', transport: { target: 'pino-pretty' } });

// ── FIX PHASE 5 — SEC-01 : middleware d'authentification pour l'AI Engine ──
// Le endpoint /api/convert était entièrement public → anyone can call it
// Fix: vérifier un secret partagé AI_ENGINE_SECRET (même valeur que dans le backend)
// Le health check reste public pour les sondes Render
import type { Request, Response, NextFunction } from 'express';

// FIX PHASE 27 — SEC-01 CORRIGÉ :
// AVANT: !secret EN PRODUCTION → 503 (bloquait toutes les requêtes si AI_ENGINE_SECRET non configuré)
// MAINTENANT: !secret → warn + accepter (compat dev ET prod sans secret)
//   Si secret configuré → vérifier X-AI-Engine-Secret header
//   Si secret absent → permettre toujours (warn seulement)
// Raison: l'absence de secret est volontaire en dev et sur certains déploiements prod.
// Bloquer avec 503 cassait le pipeline entier silencieusement.
function requireAiEngineSecret(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env['AI_ENGINE_SECRET'];
  if (!secret) {
    // AI_ENGINE_SECRET non configuré → autoriser (warn seulement, quel que soit l'env)
    logger.warn('[SEC-01] AI_ENGINE_SECRET not set — endpoint is accessible without auth (configure for production security)');
    next();
    return;
  }
  const provided = req.headers['x-ai-engine-secret'] as string | undefined;
  if (!provided || provided !== secret) {
    logger.warn(`[SEC-01] Rejected request — invalid or missing X-AI-Engine-Secret (provided="${provided?.slice(0, 8) ?? 'none'}...")`);
    res.status(401).json({ error: 'Unauthorized — invalid or missing X-AI-Engine-Secret' });
    return;
  }
  next();
}

async function bootstrap(): Promise<void> {
  const app = express();
  const { port } = appConfig;

  app.use(json({ limit: '50mb' }));
  app.use((req, res, next) => requestLogger(req, res, next));

  // Route racine — pour le health check rapide et le monitoring
  app.get('/', (_req, res) => {
    res.json({
      service:  'CodeMorph AI Engine',
      version:  '27.0.0',
      status:   'running',
      transpileMode: process.env['CODEMORPH_TRANSPILE_MODE'] === 'true',
      timestamp: new Date().toISOString(),
    });
  });

  // Routes — health est public, convert est protégé
  app.use('/api/health',  healthRouter);
  // FIX PHASE 5/27 — SEC-01 : protéger /api/convert avec le secret partagé
  // FIX PHASE 27 — AI_ENGINE_SECRET vide → accepter (pas de 503 en production)
  app.use('/api/convert', requireAiEngineSecret, convertRouter);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use(errorHandler as any);

  const server = app.listen(port, '0.0.0.0', () => {
    logger.info(`🤖 CodeMorph AI Engine running on http://0.0.0.0:${port}`);
    logger.info(`📦 Supported: Flutter→React, Flutter→RN, Express→NestJS, Node→NestJS`);
  });
  // Augmenter le timeout serveur pour les grosses conversions Groq (34+ fichiers)
  // Groq llama-3.3-70b: ~2-3s par fichier × 34 fichiers ≈ 90-120s
  server.timeout         = 7_200_000; // 2 heures (19 files × 30s + 5 screens × 22s = ~670s minimum)
  server.keepAliveTimeout = 7_260_000;
  server.headersTimeout   = 630_000;
}

bootstrap().catch((err) => {
  logger.error(err, 'AI Engine failed to start');
  process.exit(1);
});
