// ============================================================
// CodeMorph — Billing Module (LeekPay)
// ============================================================
import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule }       from '@nestjs/config';

import { BillingController }  from './billing.controller';
import { BillingService }     from './billing.service';
import { LeekPayService }     from './leekpay.service';
import { PaymentsController } from './payments.controller';
import { UsersModule }        from '../users/users.module';
import { SubscriptionModule } from '../subscription/subscription.module';

@Module({
  imports: [
    ConfigModule,
    UsersModule,
    // forwardRef pour éviter dépendance circulaire éventuelle
    forwardRef(() => SubscriptionModule),
  ],
  controllers: [BillingController, PaymentsController],
  providers:   [BillingService, LeekPayService],
  exports:     [BillingService, LeekPayService],
})
export class BillingModule {}
