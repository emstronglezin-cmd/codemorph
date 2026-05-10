// ============================================================
// CodeMorph — Transform Response Interceptor
// ============================================================
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { v4 as uuidv4 } from 'uuid';

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
  timestamp: string;
  requestId: string;
}

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, ApiResponse<T>> {
  intercept(context: ExecutionContext, next: CallHandler): Observable<ApiResponse<T>> {
    const request   = context.switchToHttp().getRequest<{ headers: Record<string, string> }>();
    const requestId = request.headers['x-request-id'] ?? uuidv4();

    return next.handle().pipe(
      map((data: T) => ({
        success:   true,
        data,
        timestamp: new Date().toISOString(),
        requestId,
      })),
    );
  }
}
