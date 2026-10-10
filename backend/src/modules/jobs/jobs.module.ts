// ============================================================
// CodeMorph — Jobs Module
// PHASE 26.1 — Architecture DI correcte
//
// Providers dans CE module (scope correct pour éviter problèmes DI) :
//   • JobsService            — logique métier jobs
//   • JobsProcessor          — adaptateur Bull → ConversionProcessorService
//   • ConversionProcessorService — logique partagée Bull/Memory
//   • QueueAdapterService    — ICI (accès à BullModule dans ce scope)
//   • AiEngineClient         — HTTP vers AI Engine
//   • JobsModuleInit         — setter injection post-construction
//
// Modules importés :
//   • QueueModule            — fournit MemoryQueueProvider uniquement
//
// Flux DI (résolution circulaire) :
//   1. Tous les providers construits par NestJS
//   2. JobsModuleInit.onModuleInit() → memoryProvider.setProcessor(convProcessor)
//   3. MemoryQueueProvider peut maintenant exécuter des jobs
// ============================================================
import { Module, Injectable, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule }    from '@nestjs/bull';
import { HttpModule }    from '@nestjs/axios';

import { JobEntity }       from './jobs.entity';
import { JobsService }     from './jobs.service';
import { JobsController }  from './jobs.controller';
import { JobsProcessor }   from './jobs.processor';
import { AiEngineClient }  from './ai-engine.client';
import { GitHubModule }    from '../github/github.module';
import { UploadsModule }   from '../uploads/uploads.module';
import { QuotaModule }     from '../quota/quota.module';
import { SubscriptionModule } from '../subscription/subscription.module';

import { ConversionProcessorService } from '../../queue/conversion-processor.service';
import { MemoryQueueProvider }        from '../../queue/memory-queue.provider';
import { QueueAdapterService }        from '../../queue/queue-adapter.service';
import { QueueModule }                from '../../queue/queue.module';
// FIX PHASE 37 — stratégie de backoff unique (Retry-After + exponentiel + jitter)
import {
  CONVERSION_BACKOFF_TYPE, conversionBackoffStrategy, getMaxAttempts,
} from '../../queue/retry-delay';

/**
 * Initialisation post-construction — résout la circularité.
 * Injecte ConversionProcessorService dans MemoryQueueProvider.
 */
@Injectable()
class JobsModuleInit implements OnModuleInit {
  constructor(
    private readonly memoryProvider: MemoryQueueProvider,
    private readonly convProcessor:  ConversionProcessorService,
  ) {}

  onModuleInit(): void {
    this.memoryProvider.setProcessor(this.convProcessor);
  }
}

@Module({
  imports: [
    TypeOrmModule.forFeature([JobEntity]),

    // Bull queue — lazyConnect=true dans app.module.ts évite crash si Redis KO
    // FIX PHASE 37 — RETRY COHÉRENT :
    //   • attempts       = getMaxAttempts() (défaut 3, env CONVERSION_MAX_ATTEMPTS)
    //   • backoff custom = 'conversion-retry' : respect du Retry-After si fourni,
    //     sinon backoff exponentiel + jitter (retry-delay.ts, source unique
    //     partagée avec MemoryQueueProvider).
    //   La stratégie est enregistrée via settings.backoffStrategies (mécanisme
    //   Bull officiel — aucune boucle de retry concurrente côté processeur).
    BullModule.registerQueue({
      name: 'conversion',
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail:     200,
        attempts:         getMaxAttempts(),
        backoff: { type: CONVERSION_BACKOFF_TYPE, delay: 2_000 },
      },
      settings: {
        backoffStrategies: {
          [CONVERSION_BACKOFF_TYPE]: (attemptsMade: number, err: Error) =>
            conversionBackoffStrategy(attemptsMade, err),
        },
      },
    }),

    HttpModule.register({ timeout: 130_000, maxRedirects: 3 }),
    GitHubModule,
    UploadsModule,
    QuotaModule,
    SubscriptionModule,

    // QueueModule fournit uniquement MemoryQueueProvider
    QueueModule,
  ],
  providers: [
    JobsService,
    JobsProcessor,
    ConversionProcessorService,
    // QueueAdapterService ICI — accède à BullModule.registerQueue('conversion')
    // via le scope de ce module (injection @InjectQueue fonctionne correctement)
    QueueAdapterService,
    AiEngineClient,
    // Initialisation post-construction
    JobsModuleInit,
  ],
  controllers: [JobsController],
  exports:     [JobsService, AiEngineClient],
})
export class JobsModule {}
