// ============================================================
// CodeMorph — Billing Controller (Legacy — utilise BillingService)
// Pour la compatibilité backward, pointe maintenant vers LeekPay
// Les nouvelles routes LeekPay sont dans PaymentsController
// ============================================================
import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

import { BillingService } from './billing.service';
import { JwtAuthGuard }   from '../../common/guards/jwt-auth.guard';
import { CurrentUser }    from '../../common/decorators/current-user.decorator';
import type { JwtPayload } from '@codemorph/shared';
import type { Plan }       from '../subscription/plan-limits.config';

@ApiTags('billing')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT')
@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Post('checkout')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create LeekPay checkout session (alias)' })
  async createCheckout(
    @CurrentUser() user: JwtPayload,
    @Body() body: { plan: Plan },
  ): Promise<{ url: string }> {
    return this.billingService.createCheckoutSession(user.sub, body.plan);
  }

  @Post('portal')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Billing portal (redirect to billing page)' })
  async createPortal(@CurrentUser() user: JwtPayload): Promise<{ url: string }> {
    return this.billingService.createPortalSession(user.sub);
  }
}
