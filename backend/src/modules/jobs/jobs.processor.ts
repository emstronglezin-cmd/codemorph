// ============================================================
// CodeMorph — Jobs Processor (Bull, chemin Redis)
// PHASE 25 Partie E : Scalabilité
//   - concurrency: 5 — jusqu'à 5 jobs en parallèle par worker process
// PHASE 26 : Refactoring
//   - Logique de traitement extraite dans ConversionProcessorService
//   - JobsProcessor devient un simple adaptateur Bull → ConversionProcessorService
//   - Logique identique quelle que soit la file (Redis ou Memory)
//
// Ce processor est uniquement actif quand Redis/Bull est disponible.
// Si Redis est KO, les jobs sont traités directement par MemoryQueueProvider
// qui appelle ConversionProcessorService de manière identique.
// ============================================================
import { Process, Processor, OnQueueFailed, OnQueueCompleted } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job }    from 'bull';

import { ConversionProcessorService, ConversionJobPayload } from '../../queue/conversion-processor.service';

// PHASE 25 Partie E : concurrency configurée sur le @Process (Bull NestJS pattern correct)
// Pour scaler à 10k users: déployer N instances backend horizontalement
// → N workers en parallèle via Bull queue, aucune modification applicative requise
@Processor('conversion')
export class JobsProcessor {
  private readonly logger = new Logger(JobsProcessor.name);

  constructor(
    // PHASE 26 — Délégation à ConversionProcessorService (partagé avec MemoryQueue)
    private readonly conversionProcessor: ConversionProcessorService,
  ) {}

  // ── Main processor ────────────────────────────────────
  // PHASE 25 Partie E : concurrency=5 via l'option du @Process
  // Chaque worker peut traiter jusqu'à 5 jobs en parallèle
  @Process({ name: 'run-conversion', concurrency: 5 })
  async handleConversion(job: Job<ConversionJobPayload>): Promise<void> {
    // PHASE 26 — Délégation complète à ConversionProcessorService
    // Toute la logique métier est dans ce service partagé (Bull + Memory)
    await this.conversionProcessor.processConversionJob(job.data, {
      attemptsMade: job.attemptsMade,
    });
  }

  // ── Bull hooks ────────────────────────────────────────
  @OnQueueFailed()
  onFailed(job: Job<ConversionJobPayload>, err: Error): void {
    this.logger.error(
      `[Queue] Job ${job.data.jobId} failed after ${job.attemptsMade} attempt(s): ${err.message}`,
    );
  }

  @OnQueueCompleted()
  onCompleted(job: Job<ConversionJobPayload>): void {
    this.logger.log(`[Queue] Job ${job.data.jobId} ✅ completed successfully`);
  }
}
