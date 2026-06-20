// ============================================================
// CodeMorph — Billing Module (LeekPay + legacy Stripe stub)
// ============================================================
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { BillingController }  from './billing.controller';
import { BillingService }     from './billing.service';
import { LeekPayService }     from './leekpay.service';
import { PaymentsController } from './payments.controller';
import { UsersModule }        from '../users/users.module';

@Module({
  imports:     [ConfigModule, UsersModule],
  controllers: [BillingController, PaymentsController],
  providers:   [BillingService, LeekPayService],
  exports:     [BillingService, LeekPayService],
})
export class BillingModule {}
