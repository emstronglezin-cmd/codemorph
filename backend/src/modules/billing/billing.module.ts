// ============================================================
// CodeMorph — Billing Module (Stripe)
// ============================================================
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { BillingController } from './billing.controller';
import { BillingService }    from './billing.service';
import { UsersModule }       from '../users/users.module';

@Module({
  imports:     [ConfigModule, UsersModule],
  controllers: [BillingController],
  providers:   [BillingService],
  exports:     [BillingService],
})
export class BillingModule {}
