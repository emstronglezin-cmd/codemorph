// ============================================================
// CodeMorph — Root AppModule (Production SaaS)
// ============================================================
import { Module }        from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule }  from '@nestjs/schedule';
import { TerminusModule }  from '@nestjs/terminus';
import { BullModule }      from '@nestjs/bull';
import { RedisModule }     from '@liaoliaots/nestjs-redis';

import { AuthModule }          from './modules/auth/auth.module';
import { UsersModule }         from './modules/users/users.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { ProjectsModule }      from './modules/projects/projects.module';
import { ConversionsModule }   from './modules/conversions/conversions.module';
import { BillingModule }       from './modules/billing/billing.module';
import { AnalyticsModule }     from './modules/analytics/analytics.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { HealthModule }        from './health/health.module';

// ── Session 3: Production SaaS modules ───────────────────
import { SubscriptionModule }  from './modules/subscription/subscription.module';
import { QuotaModule }         from './modules/quota/quota.module';
import { AdminModule }         from './modules/admin/admin.module';
import { JobsModule }          from './modules/jobs/jobs.module';
import { AppCacheModule }      from './cache/cache.module';
import { ObservabilityModule } from './observability/observability.module';

import { appConfig }      from './config/app.config';
import { databaseConfig } from './config/database.config';
import { jwtConfig }      from './config/jwt.config';
import { redisConfig }    from './config/redis.config';

@Module({
  imports: [
    // ── Configuration ──────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal:        true,
      cache:           true,
      expandVariables: true,
      load:            [appConfig, databaseConfig, jwtConfig, redisConfig],
      envFilePath:     ['.env.local', '.env'],
    }),

    // ── Redis (global, @liaoliaots/nestjs-redis) ───────────
    RedisModule.forRootAsync({
      inject:     [ConfigService],
      useFactory: (config: ConfigService) => ({
        config: {
          url:          config.get<string>('REDIS_URL', 'redis://localhost:6379'),
          password:     config.get<string>('REDIS_PASSWORD'),
          db:           config.get<number>('REDIS_DB', 0),
          lazyConnect:  false,
          retryStrategy: (times: number) => Math.min(times * 200, 3000),
        },
      }),
    }),

    // ── Bull queue (Redis-backed) ──────────────────────────
    BullModule.forRootAsync({
      inject:     [ConfigService],
      useFactory: (config: ConfigService) => ({
        redis: {
          host:     config.get<string>('REDIS_HOST', 'localhost'),
          port:     config.get<number>('REDIS_PORT', 6379),
          password: config.get<string>('REDIS_PASSWORD'),
          db:       config.get<number>('REDIS_QUEUE_DB', 1),
        },
        defaultJobOptions: {
          removeOnComplete: 100,
          removeOnFail:     200,
          attempts:         3,
          backoff: { type: 'exponential', delay: 2000 },
        },
      }),
    }),

    // ── Database ───────────────────────────────────────────
    TypeOrmModule.forRootAsync({
      inject:     [ConfigService],
      useFactory: (config: ConfigService) => ({
        type:        'postgres',
        url:          config.get<string>('DATABASE_URL'),
        entities:    [__dirname + '/**/*.entity{.ts,.js}'],
        migrations:  [__dirname + '/database/migrations/*{.ts,.js}'],
        synchronize:  config.get<string>('NODE_ENV') !== 'production',
        logging:      config.get<string>('NODE_ENV') === 'development',
        ssl:          config.get<boolean>('DATABASE_SSL', false)
                       ? { rejectUnauthorized: false }
                       : false,
        extra:       { max: 20, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 },
      }),
    }),

    // ── Rate limiting (tiered per plan via ThrottlerModule) ─
    ThrottlerModule.forRoot([
      { name: 'burst',  ttl: 1_000,   limit: 20  },   // 20 req/sec burst
      { name: 'medium', ttl: 60_000,  limit: 300 },   // 300 req/min
      { name: 'long',   ttl: 3_600_000, limit: 5_000 }, // 5k req/hr
    ]),

    // ── Scheduling ─────────────────────────────────────────
    ScheduleModule.forRoot(),

    // ── Health ─────────────────────────────────────────────
    TerminusModule,

    // ── Cache (global) ─────────────────────────────────────
    AppCacheModule,

    // ── Feature Modules ────────────────────────────────────
    AuthModule,
    UsersModule,
    OrganizationsModule,
    ProjectsModule,
    ConversionsModule,
    BillingModule,
    AnalyticsModule,
    NotificationsModule,
    HealthModule,
    JobsModule,

    // ── SaaS Production Modules ────────────────────────────
    SubscriptionModule,
    QuotaModule,
    AdminModule,

    // ── Observability ──────────────────────────────────────
    ObservabilityModule,
  ],
})
export class AppModule {}
