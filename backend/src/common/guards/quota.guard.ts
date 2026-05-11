// ============================================================
// CodeMorph — Quota Guard
// Enforces per-user monthly conversion quotas
// ============================================================
import {
  Injectable, CanActivate, ExecutionContext,
  ForbiddenException, SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { QuotaService } from '../../modules/quota/quota.service';
import { SubscriptionService } from '../../modules/subscription/subscription.service';

export const SKIP_QUOTA_KEY = 'skipQuota';
export const SkipQuota = () => SetMetadata(SKIP_QUOTA_KEY, true);

@Injectable()
export class QuotaGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly quotaService: QuotaService,
    private readonly subscriptionService: SubscriptionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_QUOTA_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (skip) return true;

    const request = ctx.switchToHttp().getRequest<{ user?: { id?: string } }>();
    const userId = request.user?.id;
    if (!userId) return true; // let JwtGuard handle auth

    const plan = await this.subscriptionService.getUserPlan(userId);
    const { allowed, used, limit, remaining, resetAt } =
      await this.quotaService.checkConversionQuota(userId, plan);

    if (!allowed) {
      throw new ForbiddenException({
        code:       'QUOTA_EXCEEDED',
        message:    `Monthly conversion quota exceeded (${used}/${limit === -1 ? '∞' : limit}).`,
        used,
        limit,
        remaining,
        resetAt,
        plan,
        upgradeUrl: '/pricing',
      });
    }

    return true;
  }
}
