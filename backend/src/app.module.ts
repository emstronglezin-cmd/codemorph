// ============================================================
// CodeMorph — Root AppModule (Production SaaS)
// ============================================================
import { Module }        from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule }  from '@nestjs/schedule';
import { TerminusModule }  from '@nestjs/terminus';
import { BullModule }      from '@nestjs/bull';
import { RedisModule }     from '@liaoliaots/nestjs-redis';
// FIX PHASE 6 — ARCH-01 : ThrottlerGuard global (APP_GUARD)
// Sans APP_GUARD, ThrottlerModule est configuré mais 0 routes sont limitées
import { APP_GUARD } from '@nestjs/core';

/**
 * Normalise une URL Redis en s'assurant qu'elle a un protocole valide.
 * Cas Upstash : l'URL peut arriver sans protocole (ex: "hostname:port")
 * ce qui fait que Node.js tente une connexion socket Unix → ENOENT.
 *
 * Retourne null si aucune URL n'est configurée → Redis sera désactivé.
 */
function normalizeRedisUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Déjà un protocole valide Redis ?
  if (trimmed.startsWith('redis://') || trimmed.startsWith('rediss://')) {
    return trimmed;
  }
  // URL sans protocole (ex: "hostname:port") ou avec // seulement → ajouter rediss://
  // Upstash requiert TLS donc on force rediss://
  const withoutSlashes = trimmed.replace(/^\/\//, '');
  return `rediss://${withoutSlashes}`;
}

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
    // Redis est OPTIONNEL : si REDIS_URL est absent/invalide, on ne crashe pas.
    // L'URL est normalisée pour corriger le cas Upstash (rediss:// manquant).
    RedisModule.forRootAsync({
      inject:     [ConfigService],
      useFactory: (config: ConfigService) => {
        const rawUrl  = config.get<string>('REDIS_URL');
        const redisUrl = normalizeRedisUrl(rawUrl) ?? 'redis://localhost:6379';
        return {
          config: {
            url:           redisUrl,
            password:      config.get<string>('REDIS_PASSWORD'),
            db:            config.get<number>('REDIS_DB', 0),
            // lazyConnect = true : ne crashe pas au démarrage si Redis indisponible
            lazyConnect:   true,
            // Limiter les tentatives de reconnexion pour ne pas bloquer le démarrage
            retryStrategy: (times: number) => {
              if (times > 5) return null; // abandon après 5 essais
              return Math.min(times * 500, 3000);
            },
            enableOfflineQueue: false,
          },
        };
      },
    }),

    // ── Bull queue (Redis-backed) ──────────────────────────
    BullModule.forRootAsync({
      inject:     [ConfigService],
      useFactory: (config: ConfigService) => {
        const rawUrl  = config.get<string>('REDIS_URL');
        const redisUrl = normalizeRedisUrl(rawUrl);
        // Si on a une URL complète, on l'utilise directement via url
        // Sinon on tombe sur localhost (dev sans Redis)
        if (redisUrl) {
          return {
            url: redisUrl,
            defaultJobOptions: {
              removeOnComplete: 100,
              removeOnFail:     200,
              attempts:         3,
              backoff: { type: 'exponential', delay: 2000 },
            },
          };
        }
        return {
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
        };
      },
    }),

    // ── Database ───────────────────────────────────────────
    // Compatible Supabase (Connection Pooler, port 6543 ou 5432)
    // DATABASE_SSL=true active SSL avec rejectUnauthorized: false
    // (requis car Supabase utilise un certificat pooler auto-signé)
    TypeOrmModule.forRootAsync({
      inject:     [ConfigService],
      useFactory: (config: ConfigService) => {
        const databaseUrl = config.get<string>('DATABASE_URL');
        const nodeEnv     = config.get<string>('NODE_ENV', 'development');

        // Détection automatique Supabase si DATABASE_SSL non défini
        const sslRaw      = config.get<string>('DATABASE_SSL');
        let sslEnabled: boolean;
        if (sslRaw === 'true')  sslEnabled = true;
        else if (sslRaw === 'false') sslEnabled = false;
        else if (databaseUrl?.includes('supabase.com')) sslEnabled = true;
        else sslEnabled = nodeEnv === 'production';

        // DATABASE_SYNC=true → force la création des tables (à activer 1 fois)
        // En production sans migrations, mettre DATABASE_SYNC=true dans Render
        // puis repasser à false après le premier démarrage réussi
        const syncEnv = config.get<string>('DATABASE_SYNC');
        const shouldSync =
          syncEnv === 'true' ||           // forcé explicitement
          nodeEnv !== 'production';       // toujours en dev

        return {
          type:        'postgres' as const,
          url:          databaseUrl,
          entities:    [__dirname + '/**/*.entity{.ts,.js}'],
          migrations:  [__dirname + '/database/migrations/*{.ts,.js}'],
          synchronize:  shouldSync,
          logging:      nodeEnv === 'development' || syncEnv === 'true',
          // Supabase pooler requiert ssl avec rejectUnauthorized: false
          ssl:          sslEnabled ? { rejectUnauthorized: false } : false,
          extra: {
            max:                      20,
            idleTimeoutMillis:        30_000,
            // Timeout plus long pour Supabase (cold start pooler)
            connectionTimeoutMillis:  10_000,
          },
        };
      },
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
  // FIX PHASE 6 — ARCH-01 : ThrottlerGuard global
  // ThrottlerModule était configuré mais APP_GUARD absent → 0 routes limitées
  providers: [
    {
      provide:  APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
