// ============================================================
// CodeMorph — Global Exception Filter
// PHASE 9 FIX: Préserver le code métier (GITHUB_NOT_CONNECTED,
// CONCURRENT_LIMIT, QUOTA_EXCEEDED, etc.) depuis BadRequestException
// et ForbiddenException au lieu de tout mapper en GEN_003.
// ============================================================
import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { QueryFailedError, EntityNotFoundError } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx      = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request  = ctx.getRequest<Request>();
    const requestId = (request.headers['x-request-id'] as string) ?? uuidv4();

    let status  = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let code    = 'GEN_003';
    let errors: Array<{ code: string; message: string; field?: string }> = [];
    // Extra fields from business exceptions (CONCURRENT_LIMIT, etc.)
    let extra: Record<string, unknown> = {};

    // ── HttpException ────────────────────────────────────
    if (exception instanceof HttpException) {
      status  = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'object' && res !== null) {
        const body = res as Record<string, unknown>;
        message = (body['message'] as string) ?? exception.message;

        // FIX PHASE 9: Préserver le code métier depuis le body de l'exception.
        // Ex: throw new BadRequestException({ code: 'GITHUB_NOT_CONNECTED', message: '...' })
        // → body['code'] = 'GITHUB_NOT_CONNECTED' → on le préserve dans la réponse.
        // Sans ce fix, tous les codes métier étaient remplacés par 'GEN_003'.
        if (typeof body['code'] === 'string' && body['code']) {
          code = body['code'] as string;
        }

        if (Array.isArray(body['message'])) {
          errors = (body['message'] as string[]).map((msg) => ({
            code:    'VALIDATION_FAILED',
            message: msg,
          }));
          message = 'Validation failed';
          code    = 'GEN_001';
        }

        // Préserver les champs métier supplémentaires (current, limit, upgradeUrl, etc.)
        const reservedKeys = new Set(['message', 'code', 'statusCode', 'error']);
        for (const [k, v] of Object.entries(body)) {
          if (!reservedKeys.has(k)) extra[k] = v;
        }
      } else {
        message = res as string;
      }
    }

    // ── TypeORM errors ───────────────────────────────────
    else if (exception instanceof QueryFailedError) {
      status  = HttpStatus.BAD_REQUEST;
      message = 'Database query failed';
      code    = 'GEN_003';
      // Hide internal DB errors in production
      if (process.env['NODE_ENV'] === 'development') {
        errors = [{ code: 'DB_ERROR', message: exception.message }];
      }
    }

    else if (exception instanceof EntityNotFoundError) {
      status  = HttpStatus.NOT_FOUND;
      message = 'Resource not found';
      code    = 'GEN_002';
    }

    // ── Log the error ────────────────────────────────────
    const isServerError = status >= 500;
    if (isServerError) {
      this.logger.error(
        `[${requestId}] ${request.method} ${request.url} → ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(
        `[${requestId}] ${request.method} ${request.url} → ${status}: ${message}`,
      );
    }

    response.status(status).json({
      success:   false,
      message,
      code,
      errors:    errors.length > 0 ? errors : undefined,
      ...( Object.keys(extra).length > 0 ? extra : {} ),
      timestamp: new Date().toISOString(),
      requestId,
      path:      request.url,
    });
  }
}
