// ============================================================
// CodeMorph — Jobs Module
// PHASE 26 — Bull/Redis devient OPTIONNEL
//
// Architecture Phase 26 :
//   • BullModule.registerQueue() est TOUJOURS enregistré
//     (NestJS Bull en a besoin même si Redis est KO, grâce à lazyConnect)
//   • QueueAdapterService détecte Redis au démarrage et bascule
//     automatiquement vers MemoryQueueProvider si indisponible
//   • JobsProcessor (Bull) fonctionne si Redis est disponible
//   • MemoryQueueProvider fonctionne si Redis est indisponible
//   • ConversionProcessorService est la logique partagée des deux
//
// PRIORITÉ 9 : Aucun changement fonctionnel — API et frontend inchangés
// ============================================================
import { Module }        from '@nestjs/common';
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

// PHASE 26 — Module d'abstraction de file (Redis + Memory fallback)
import { QueueModule } from '../../queue/queue.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([JobEntity]),

    // Bull queue — toujours enregistré.
    // Si Redis est KO, lazyConnect=true (configuré dans app.module.ts BullModule.forRootAsync)
    // empêche le crash au démarrage. QueueAdapterService gère le fallback Memory.
    BullModule.registerQueue({
      name: 'conversion',
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail:     200,
        attempts:         3,
        backoff: { type: 'exponential', delay: 2_000 },
      },
    }),

    HttpModule.register({ timeout: 130_000, maxRedirects: 3 }),
    GitHubModule,
    UploadsModule,
    QuotaModule,
    SubscriptionModule,

    // PHASE 26 — QueueModule fournit QueueAdapterService + MemoryQueueProvider
    // + ConversionProcessorService (logique partagée Bull/Memory)
    QueueModule,
  ],
  providers: [
    JobsService,
    // JobsProcessor gère le chemin Bull (Redis disponible)
    // MemoryQueueProvider gère le chemin Memory (Redis KO), fourni par QueueModule
    JobsProcessor,
    AiEngineClient,
  ],
  controllers: [JobsController],
  exports:     [JobsService, AiEngineClient],
})
export class JobsModule {}
