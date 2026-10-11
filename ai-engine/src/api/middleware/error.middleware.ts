import { Request, Response, NextFunction } from 'express';
import pino from 'pino';

const logger = pino({ name: 'ai-engine:error' });

export interface AppError extends Error {
  statusCode?: number;
  code?: string;
  details?: unknown;
  isOperational?: boolean;
}

export class ConversionError extends Error implements AppError {
  statusCode: number;
  code: string;
  details?: unknown;
  isOperational = true;

  constructor(message: string, code: string, statusCode = 400, details?: unknown) {
    super(message);
    this.name = 'ConversionError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class PipelineError extends Error implements AppError {
  statusCode: number;
  code: string;
  phase: string;
  details?: unknown;
  isOperational = true;

  constructor(message: string, phase: string, details?: unknown) {
    super(message);
    this.name = 'PipelineError';
    this.code = 'PIPELINE_ERROR';
    this.statusCode = 500;
    this.phase = phase;
    this.details = details;
  }
}

export class ValidationError extends Error implements AppError {
  statusCode = 422;
  code = 'VALIDATION_ERROR';
  details?: unknown;
  isOperational = true;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  err: AppError,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const statusCode = err.statusCode ?? 500;
  const isOperational = err.isOperational ?? false;

  // ── FIX PHASE 39 — identifier les rejets issus du parsing du corps ──────────
  // body-parser (express.json) lève avec un `type` précis. Sans cette branche,
  // un corps illisible / tronqué / trop lourd remontait comme un INTERNAL_ERROR
  // générique, impossible à distinguer d'un vrai 500 dans les Runtime Logs.
  // Aucun contenu du corps n'est journalisé (sécurité) : seulement le type,
  // la taille déclarée et l'identifiant de requête corrélé.
  const parserType = (err as unknown as { type?: string }).type;
  const isBodyParserError =
    parserType === 'entity.parse.failed' ||
    parserType === 'entity.too.large' ||
    parserType === 'entity.verify.failed' ||
    parserType === 'request.aborted' ||
    parserType === 'request.size.did.not.match.content.length';

  if (isBodyParserError) {
    logger.warn(
      {
        requestId:    (req as Request & { id?: string }).id,
        method:       req.method,
        url:          req.url,
        statusCode,
        parserType,
        declaredSize: req.headers['content-length'],
        // Volontairement AUCUN extrait du corps : peut contenir du code utilisateur.
      },
      `Corps de requête rejeté avant tout traitement (${parserType})`,
    );
  }

  // Log all errors
  if (statusCode >= 500) {
    logger.error(
      {
        err,
        requestId: (req as Request & { id?: string }).id,
        method: req.method,
        url: req.url,
        statusCode,
      },
      'Server error',
    );
  } else {
    logger.warn(
      {
        code: err.code,
        message: err.message,
        requestId: (req as Request & { id?: string }).id,
        method: req.method,
        url: req.url,
        statusCode,
      },
      'Client error',
    );
  }

  // Don't leak stack traces in production
  const isDev = process.env.NODE_ENV === 'development';

  res.status(statusCode).json({
    success: false,
    error: {
      code: err.code ?? 'INTERNAL_ERROR',
      message: isOperational ? err.message : 'An unexpected error occurred',
      ...(err.details && typeof err.details === 'object' ? { details: err.details } : {}),
      ...(isDev && !isOperational && { stack: err.stack }),
    },
    timestamp: new Date().toISOString(),
  });
}

// 404 handler — must be placed before errorHandler
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.url} not found`,
    },
    timestamp: new Date().toISOString(),
  });
}
