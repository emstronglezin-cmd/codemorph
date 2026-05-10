// ============================================================
// CodeMorph — Root AppModule
// ============================================================
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { TerminusModule } from '@nestjs/terminus';

import { AuthModule }          from './modules/auth/auth.module';
import { UsersModule }         from './modules/users/users.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { ProjectsModule }      from './modules/projects/projects.module';
import { ConversionsModule }   from './modules/conversions/conversions.module';
import { BillingModule }       from './modules/billing/billing.module';
import { AnalyticsModule }     from './modules/analytics/analytics.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { HealthModule }        from './health/health.module';

import { appConfig }      from './config/app.config';
import { databaseConfig } from './config/database.config';
import { jwtConfig }      from './config/jwt.config';
import { redisConfig }    from './config/redis.config';

@Module({
  imports: [
    // ── Configuration ──────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal:    true,
      cache:       true,
      expandVariables: true,
      load: [appConfig, databaseConfig, jwtConfig, redisConfig],
      envFilePath: ['.env.local', '.env'],
    }),

    // ── Database ───────────────────────────────────────────
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type:          'postgres',
        url:           config.get<string>('DATABASE_URL'),
        entities:      [__dirname + '/**/*.entity{.ts,.js}'],
        migrations:    [__dirname + '/database/migrations/*{.ts,.js}'],
        synchronize:   config.get<string>('NODE_ENV') !== 'production',
        logging:       config.get<string>('NODE_ENV') === 'development',
        ssl:           config.get<boolean>('DATABASE_SSL', false)
                        ? { rejectUnauthorized: false }
                        : false,
        extra:         { max: 20, idleTimeoutMillis: 30_000 },
      }),
    }),

    // ── Rate limiting ──────────────────────────────────────
    ThrottlerModule.forRoot([
      { name: 'short',  ttl: 1_000,  limit: 10 },
      { name: 'medium', ttl: 10_000, limit: 50 },
      { name: 'long',   ttl: 60_000, limit: 200 },
    ]),

    // ── Scheduling ─────────────────────────────────────────
    ScheduleModule.forRoot(),

    // ── Health ─────────────────────────────────────────────
    TerminusModule,

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
  ],
})
export class AppModule {}
