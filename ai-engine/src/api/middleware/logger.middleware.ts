import { Request, Response, NextFunction } from 'express';
import pino from 'pino';
import { randomUUID } from 'crypto';

const logger = pino({
  name: 'ai-engine:http',
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
      : undefined,
});

// Attach request ID and logger to every request
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req.headers['x-request-id'] as string) ?? randomUUID();
  const startTime = Date.now();

  // Attach to request so downstream handlers can use it
  (req as Request & { id: string; log: pino.Logger }).id = requestId;
  (req as Request & { id: string; log: pino.Logger }).log = logger.child({ requestId });

  // Set response header
  res.setHeader('x-request-id', requestId);

  // Log incoming request
  logger.info(
    {
      requestId,
      method: req.method,
      url: req.url,
      userAgent: req.headers['user-agent'],
      ip: req.ip ?? req.headers['x-forwarded-for'],
      contentType: req.headers['content-type'],
      contentLength: req.headers['content-length'],
    },
    `→ ${req.method} ${req.url}`,
  );

  // Intercept response finish to log outcome
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    logger[level](
      {
        requestId,
        method: req.method,
        url: req.url,
        statusCode: res.statusCode,
        durationMs: duration,
        responseSize: res.getHeader('content-length'),
      },
      `← ${req.method} ${req.url} ${res.statusCode} (${duration}ms)`,
    );
  });

  next();
}

export { logger };
