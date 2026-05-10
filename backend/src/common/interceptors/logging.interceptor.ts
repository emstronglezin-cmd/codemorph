// ============================================================
// CodeMorph — Logging Interceptor
// ============================================================
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Request } from 'express';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request    = context.switchToHttp().getRequest<Request>();
    const { method, url } = request;
    const startTime  = Date.now();
    const requestId  = (request.headers['x-request-id'] as string) ?? 'N/A';

    return next.handle().pipe(
      tap({
        next: () => {
          const response = context.switchToHttp().getResponse<{ statusCode: number }>();
          const duration = Date.now() - startTime;
          this.logger.log(
            `[${requestId}] ${method} ${url} → ${response.statusCode} (${duration}ms)`,
          );
        },
        error: (err: Error) => {
          const duration = Date.now() - startTime;
          this.logger.warn(
            `[${requestId}] ${method} ${url} → ERROR (${duration}ms): ${err.message}`,
          );
        },
      }),
    );
  }
}
