// ============================================================
// CodeMorph — Quota Tracking Interceptor
// Automatically increments usage after successful conversions
// ============================================================
import {
  Injectable, NestInterceptor, ExecutionContext, CallHandler,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { QuotaService } from '../../modules/quota/quota.service';
import { SubscriptionService } from '../../modules/subscription/subscription.service';

export const TRACK_QUOTA_KEY = 'trackQuota';
export const TrackConversionQuota = () => SetMetadata(TRACK_QUOTA_KEY, true);

@Injectable()
export class QuotaTrackInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly quotaService: QuotaService,
    private readonly subscriptionService: SubscriptionService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const track = this.reflector.getAllAndOverride<boolean>(TRACK_QUOTA_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!track) return next.handle();

    const request = ctx.switchToHttp().getRequest<{ user?: { id?: string } }>();
    const userId = request.user?.id;
    if (!userId) return next.handle();

    return next.handle().pipe(
      tap(async () => {
        try {
          const plan = await this.subscriptionService.getUserPlan(userId);
          await this.quotaService.incrementConversions(userId, plan);
        } catch {
          // Non-blocking — quota tracking failure should not break response
        }
      }),
    );
  }
}
