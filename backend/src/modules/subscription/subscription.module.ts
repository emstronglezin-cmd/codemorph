// ============================================================
// CodeMorph — Subscription Module
// Redis OPTIONNEL : si REDIS_URL absent → null → in-memory fallback
// Pattern identique à quota.module.ts
// ============================================================
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { SubscriptionEntity } from './subscription.entity';
import { SubscriptionService, SUB_REDIS_TOKEN } from './subscription.service';
import { SubscriptionController } from './subscription.controller';
import { UsersModule } from '../users/users.module';

// ── Provider Redis optionnel ──────────────────────────────────
// Retourne null si REDIS_URL absent → SubscriptionService utilise in-memory fallback
const SubRedisClientProvider = {
  provide: SUB_REDIS_TOKEN,
  inject: [ConfigService],
  useFactory: async (config: ConfigService): Promise<unknown> => {
    const rawUrl = config.get<string>('REDIS_URL');
    if (!rawUrl) return null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Redis = require('ioredis');
      const url =
        rawUrl.startsWith('redis://') || rawUrl.startsWith('rediss://')
          ? rawUrl
          : `rediss://${rawUrl.replace(/^\/\//, '')}`;
      const client = new Redis.default(url, {
        lazyConnect:        true,
        retryStrategy:      (t: number) => (t > 3 ? null : t * 500),
        enableOfflineQueue: false,
      });
      await client.connect().catch(() => null);
      return client;
    } catch {
      return null;
    }
  },
};

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([SubscriptionEntity]),
    UsersModule,
  ],
  providers:   [SubRedisClientProvider, SubscriptionService],
  controllers: [SubscriptionController],
  exports:     [SubscriptionService],
})
export class SubscriptionModule {}
