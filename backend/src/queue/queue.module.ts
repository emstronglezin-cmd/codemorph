// ============================================================
// CodeMorph — QueueModule
// PHASE 26 — Module NestJS pour l'abstraction de file
//
// Exporte :
//   • QueueAdapterService (IQueueProvider actif)
//   • MemoryQueueProvider (fallback mémoire)
//   • ConversionProcessorService (logique partagée Bull/Memory)
//
// Ce module est importé par JobsModule.
// JobsModule importe optionnellement BullModule.registerQueue().
// ============================================================
import { Module }  from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';

import { QueueAdapterService }       from './queue-adapter.service';
import { MemoryQueueProvider }       from './memory-queue.provider';
import { ConversionProcessorService } from './conversion-processor.service';

// Imports nécessaires pour ConversionProcessorService
import { GitHubModule }      from '../modules/github/github.module';
import { UploadsModule }     from '../modules/uploads/uploads.module';
import { QuotaModule }       from '../modules/quota/quota.module';
import { SubscriptionModule } from '../modules/subscription/subscription.module';

@Module({
  imports: [
    HttpModule.register({ timeout: 130_000, maxRedirects: 3 }),
    GitHubModule,
    UploadsModule,
    QuotaModule,
    SubscriptionModule,
  ],
  providers: [
    MemoryQueueProvider,
    ConversionProcessorService,
    QueueAdapterService,
  ],
  exports: [
    QueueAdapterService,
    MemoryQueueProvider,
    ConversionProcessorService,
  ],
})
export class QueueModule {}
