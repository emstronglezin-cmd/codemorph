import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { UsageQuotaEntity } from './quota.entity';
import { QuotaService, REDIS_CLIENT_TOKEN } from './quota.service';

// Provider qui injecte Redis de manière optionnelle (sans crasher si absent)
const RedisClientProvider = {
  provide: REDIS_CLIENT_TOKEN,
  inject: [ConfigService],
  useFactory: async (config: ConfigService) => {
    const rawUrl = config.get<string>('REDIS_URL');
    if (!rawUrl) return null;

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Redis = require('ioredis') as { default: new (url: string, opts?: object) => unknown };
      const url = rawUrl.startsWith('redis://') || rawUrl.startsWith('rediss://')
        ? rawUrl
        : `rediss://${rawUrl.replace(/^\/\//, '')}`;

      const client = new Redis.default(url, {
        lazyConnect: true,
        retryStrategy: (times: number) => (times > 3 ? null : Math.min(times * 500, 2000)),
        enableOfflineQueue: false,
      });

      // Test de connexion silencieux
      await (client as { connect(): Promise<void> }).connect().catch(() => null);
      return client;
    } catch {
      return null; // Redis absent ou erreur → fallback in-memory
    }
  },
};

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([UsageQuotaEntity]),
  ],
  providers: [RedisClientProvider, QuotaService],
  exports: [QuotaService],
})
export class QuotaModule {}
