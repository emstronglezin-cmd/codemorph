import {
  Controller, Get, Post, Body, Param, UseGuards,
  RawBodyRequest, Req, Headers, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { SubscriptionService } from './subscription.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { BillingInterval } from './subscription.entity';
import { Plan, PLAN_DISPLAY, PLAN_LIMITS } from './plan-limits.config';

@ApiTags('subscription')
@Controller('subscription')
export class SubscriptionController {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  @Get('plans')
  @Public()
  @ApiOperation({ summary: 'Get all plans with features and pricing' })
  getPlans() {
    return {
      plans: Object.entries(PLAN_DISPLAY).map(([key, display]) => ({
        id:     key,
        ...display,
        limits: PLAN_LIMITS[key as Plan],
      })),
    };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user subscription' })
  getMySubscription(@CurrentUser() user: { id: string }) {
    return this.subscriptionService.getSubscription(user.id);
  }

  @Post('checkout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create checkout session' })
  createCheckout(
    @CurrentUser() user: { id: string },
    @Body() body: { plan: Plan; interval?: BillingInterval },
  ) {
    return this.subscriptionService.createCheckoutSession(
      user.id,
      body.plan,
      body.interval ?? BillingInterval.MONTHLY,
    );
  }

  @Post('portal')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create billing portal session' })
  createPortal(@CurrentUser() user: { id: string }) {
    return this.subscriptionService.createPortalSession(user.id);
  }

  @Post('cancel')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Downgrade to free plan' })
  cancel(@CurrentUser() user: { id: string }) {
    return this.subscriptionService.downgradeToFree(user.id);
  }

  // Stripe webhook — public, raw body required
  @Public()
  @Post('webhook/stripe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stripe webhook endpoint' })
  async stripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    const raw = req.rawBody;
    if (!raw) throw new Error('No raw body');
    await this.subscriptionService.handleStripeWebhook(raw, signature);
    return { received: true };
  }
}
