// ============================================================
// CodeMorph — Current User Decorator
// ============================================================
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { JwtPayload } from '@codemorph/shared';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload => {
    const request = ctx.switchToHttp().getRequest<{ user: JwtPayload }>();
    return request.user;
  },
);
