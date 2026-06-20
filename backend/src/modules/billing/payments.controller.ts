// ============================================================
// CodeMorph — Payments Controller (LeekPay)
// Routes :
//   POST /api/v1/payments/webhook  → recevoir notifications LeekPay
//   POST /api/v1/payments/checkout → créer session de paiement
//   GET  /api/v1/payments/plans    → liste des plans en XOF
//   GET  /api/v1/payments/config   → clé publique pour le widget
// ============================================================
import {
  Controller,
  Post,
  Get,
  Body,
  Headers,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  UseGuards,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { LeekPayService } from './leekpay.service';
import { JwtAuthGuard }   from '../../common/guards/jwt-auth.guard';
import { CurrentUser }    from '../../common/decorators/current-user.decorator';
import { Public }         from '../../common/decorators/public.decorator';
import type { JwtPayload } from '@codemorph/shared';

// ── DTO ──────────────────────────────────────────────────
class CreateCheckoutDto {
  planId!: string;           // 'starter' | 'pro' | 'pro_max'
}

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(private readonly leekPayService: LeekPayService) {}

  // ── GET /payments/config ─────────────────────────────
  // Renvoie la clé publique pour initialiser le widget LeekPay côté client
  @Public()
  @Get('config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get LeekPay public config for frontend widget' })
  getConfig(): { publicKey: string; currency: string } {
    return {
      publicKey: this.leekPayService.getPublicKey(),
      currency:  'XOF',
    };
  }

  // ── GET /payments/plans ──────────────────────────────
  @Public()
  @Get('plans')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List available subscription plans (XOF)' })
  getPlans() {
    return { plans: this.leekPayService.getPlans() };
  }

  // ── POST /payments/checkout ──────────────────────────
  // Crée une session de paiement LeekPay pour l'utilisateur connecté
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT')
  @Post('checkout')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a LeekPay checkout session' })
  @ApiBody({ schema: { example: { planId: 'pro' } } })
  async createCheckout(
    @CurrentUser() user: JwtPayload,
    @Body() body: CreateCheckoutDto,
  ) {
    this.logger.log(`User ${user.sub} creating checkout for plan ${body.planId}`);

    const checkout = await this.leekPayService.createPlanCheckout(
      body.planId,
      user.email ?? '',
      '',          // name non disponible dans JwtPayload
      user.sub   as string,
    );

    return {
      checkoutId:  checkout.id,
      payment_url: checkout.payment_url,
      amount:      checkout.amount,
      currency:    checkout.currency,
      expires_at:  checkout.expires_at,
    };
  }

  // ── POST /payments/webhook ───────────────────────────
  // Endpoint webhook pour LeekPay — doit être PUBLIC (pas d'auth JWT)
  // URL configurée dans LeekPay Dashboard :
  // https://codemorph-hp00.onrender.com/api/v1/payments/webhook
  @Public()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[LeekPay] Webhook endpoint — receives payment notifications' })
  async handleWebhook(
    @Req()     req: Request,
    @Res()     res: Response,
    @Headers('x-leekpay-signature') signature: string,
    @Headers('x-leekpay-event')     event: string,
  ): Promise<void> {
    // Récupérer le corps brut pour la vérification de signature
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));

    await new Promise<void>((resolve) => req.on('end', () => resolve()));

    const rawPayload = Buffer.concat(chunks).toString('utf8');

    this.logger.log(`LeekPay webhook received — event: ${event ?? 'unknown'}`);

    try {
      const result = await this.leekPayService.processWebhook(
        rawPayload,
        signature ?? '',
      );
      res.status(HttpStatus.OK).json({ received: true, ...result });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Webhook error';
      this.logger.error(`Webhook error: ${message}`);
      res.status(HttpStatus.UNAUTHORIZED).json({ error: message });
    }
  }

  // ── GET /payments/checkout/:id ───────────────────────
  // Vérifier le statut d'un paiement (polling fallback si pas de webhook)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT')
  @Get('checkout/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get checkout status by ID' })
  async getCheckoutStatus(
    @Req() req: Request & { params: { id: string } },
  ) {
    const checkout = await this.leekPayService.getCheckout(req.params.id);
    return {
      id:       checkout.id,
      status:   checkout.status,
      amount:   checkout.amount,
      currency: checkout.currency,
    };
  }
}
