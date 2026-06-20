// ============================================================
// CodeMorph — Billing Service (LeekPay — stub Stripe retiré)
// ============================================================
import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { UserId } from '@codemorph/shared';
import { UsersService } from '../users/users.service';
import type { Plan } from '../subscription/plan-limits.config';
import { LeekPayService } from './leekpay.service';

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly config:       ConfigService,
    private readonly usersService: UsersService,
    private readonly leekPay:      LeekPayService,
  ) {}

  // ── Créer une session checkout via LeekPay ─────────────
  async createCheckoutSession(
    userId: UserId,
    plan:   Plan,
  ): Promise<{ url: string }> {
    const user = await this.usersService.findByIdOrFail(userId);

    // Mapping plan interne → plan LeekPay
    const planMapping: Partial<Record<Plan, string>> = {
      pro:     'pro',
      pro_max: 'pro_max',
    };

    const leekPlanId = planMapping[plan];
    if (!leekPlanId) {
      throw new BadRequestException(`Plan non supporté ou gratuit: ${plan}`);
    }

    const checkout = await this.leekPay.createPlanCheckout(
      leekPlanId,
      user.email,
      user.name,
      userId as string,
    );

    return { url: checkout.payment_url };
  }

  // ── Portail de facturation (placeholder) ─────────────
  async createPortalSession(_userId: UserId): Promise<{ url: string }> {
    const frontendUrl = this.config.get<string>('FRONTEND_URL') ??
                        'https://codemorph-coral.vercel.app';
    // LeekPay n'a pas de portail client — rediriger vers la page billing
    return { url: `${frontendUrl}/dashboard/billing` };
  }

  // ── Mettre à jour le plan utilisateur après paiement ──
  async upgradePlan(userId: UserId, planId: string): Promise<void> {
    const planMap: Record<string, Plan> = {
      starter: 'pro',
      pro:     'pro',
      pro_max: 'pro_max',
    };
    const plan = planMap[planId] ?? 'free';
    await this.usersService.update(userId, { plan });
    this.logger.log(`User ${userId as string} upgraded to plan: ${plan}`);
  }
}
