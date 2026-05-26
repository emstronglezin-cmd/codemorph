// ============================================================
// CodeMorph — AI Engine Entry Point
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

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info', transport: { target: 'pino-pretty' } });

async function bootstrap(): Promise<void> {
  const app = express();
  const { port } = appConfig;

  app.use(json({ limit: '50mb' }));
  app.use((req, res, next) => requestLogger(req, res, next));

  // Routes
  app.use('/api/health',  healthRouter);
  app.use('/api/convert', convertRouter);

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
