// ============================================================
// CodeMorph — Plan Guard
// Enforces minimum plan requirement on routes
// Usage: @RequirePlan('pro') or @RequirePlan('pro_max')
// ============================================================
import {
  Injectable, CanActivate, ExecutionContext,
  ForbiddenException, SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Plan } from '../../modules/subscription/plan-limits.config';

export const PLAN_KEY = 'requiredPlan';
export const RequirePlan = (...plans: Plan[]) => SetMetadata(PLAN_KEY, plans);

const PLAN_ORDER: Record<Plan, number> = { free: 0, pro: 1, pro_max: 2 };

@Injectable()
export class PlanGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Plan[]>(PLAN_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);

    if (!required || required.length === 0) return true;

    const request = ctx.switchToHttp().getRequest<{ user?: { plan?: string } }>();
    const userPlan = (request.user?.plan ?? 'free') as Plan;
    const userLevel = PLAN_ORDER[userPlan] ?? 0;
    const requiredLevel = Math.min(...required.map((p) => PLAN_ORDER[p] ?? 0));

    if (userLevel < requiredLevel) {
      throw new ForbiddenException({
        code:       'PLAN_REQUIRED',
        message:    `This feature requires plan: ${required.join(' or ')}. Current: ${userPlan}.`,
        current:    userPlan,
        required:   required,
        upgradeUrl: '/pricing',
      });
    }

    return true;
  }
}
