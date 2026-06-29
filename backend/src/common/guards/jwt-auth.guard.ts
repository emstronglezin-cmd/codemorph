// ============================================================
// CodeMorph — JWT Auth Guard
// FIX: logs détaillés sur les erreurs d'authentification
// ============================================================
import { Injectable, ExecutionContext, UnauthorizedException, Logger } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';

export const IS_PUBLIC_KEY = 'isPublic';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext): boolean | Promise<boolean> | Observable<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    return super.canActivate(context) as boolean | Promise<boolean>;
  }

  handleRequest<TUser>(err: Error | null, user: TUser, info: unknown): TUser {
    if (err ?? !user) {
      // Log détaillé pour diagnostiquer la cause du rejet
      const infoMsg = info instanceof Error ? info.message : String(info ?? 'no info');
      const errMsg  = err instanceof Error ? err.message : null;
      this.logger.warn(
        `[JwtAuthGuard] Token rejected — ` +
        `info="${infoMsg}" ` +
        `${errMsg ? `err="${errMsg}"` : ''}`
      );
      throw new UnauthorizedException({
        code:    'AUTH_002',
        message: 'Invalid or expired token',
      });
    }
    return user;
  }
}
