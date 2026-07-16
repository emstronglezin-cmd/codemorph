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

function requireAiEngineSecret(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env['AI_ENGINE_SECRET'];
  if (!secret) {
    // Si AI_ENGINE_SECRET n'est pas configuré → permettre en dev (warn seulement)
    if (process.env['NODE_ENV'] === 'production') {
      res.status(503).json({ error: 'AI_ENGINE_SECRET not configured — endpoint disabled' });
      return;
    }
    logger.warn('[SEC-01] AI_ENGINE_SECRET not set — endpoint is PUBLIC (dev mode only)');
    next();
    return;
  }
  const provided = req.headers['x-ai-engine-secret'] as string | undefined;
  if (!provided || provided !== secret) {
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

  // Routes — health est public, convert est protégé
  app.use('/api/health',  healthRouter);
  // FIX PHASE 5 — SEC-01 : protéger /api/convert avec le secret partagé
  app.use('/api/convert', requireAiEngineSecret, convertRouter);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use(errorHandler as any);

  app.listen(port, '0.0.0.0', () => {
    logger.info(`🤖 CodeMorph AI Engine running on http://0.0.0.0:${port}`);
    logger.info(`📦 Supported: Flutter→React, Flutter→RN, Express→NestJS, Node→NestJS`);
  });
}

bootstrap().catch((err) => {
  logger.error(err, 'AI Engine failed to start');
  process.exit(1);
});
