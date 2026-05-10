// ============================================================
// CodeMorph — Billing Controller
// ============================================================
import {
  Controller,
  Post,
  Body,
  Headers,
  RawBodyRequest,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import type { Request } from 'express';

import { BillingService } from './billing.service';
import { JwtAuthGuard }   from '../../common/guards/jwt-auth.guard';
import { CurrentUser }    from '../../common/decorators/current-user.decorator';
import { Public }         from '../../common/decorators/public.decorator';
import type { JwtPayload } from '@codemorph/shared';

@ApiTags('billing')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT')
@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Post('checkout')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create Stripe checkout session' })
  async createCheckout(
    @CurrentUser() user: JwtPayload,
    @Body() body: { plan: 'starter' | 'pro' | 'enterprise' },
  ): Promise<{ url: string }> {
    return this.billingService.createCheckoutSession(user.sub, body.plan);
  }

  @Post('portal')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create Stripe billing portal session' })
  async createPortal(@CurrentUser() user: JwtPayload): Promise<{ url: string }> {
    return this.billingService.createPortalSession(user.sub);
  }

  @Public()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Internal] Stripe webhook handler' })
  async handleWebhook(
    @Req()     req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ): Promise<{ received: boolean }> {
    const payload = req.rawBody ?? Buffer.from('');
    await this.billingService.handleWebhook(payload, signature);
    return { received: true };
  }
}
