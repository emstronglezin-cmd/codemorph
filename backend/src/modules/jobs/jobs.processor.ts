// ============================================================
// CodeMorph — Jobs Processor (Bull, chemin Redis)
// PHASE 25 Partie E : Scalabilité
//   - concurrency: 5 — jusqu'à 5 jobs en parallèle par worker process
// PHASE 26 : Refactoring
//   - Logique de traitement extraite dans ConversionProcessorService
//   - JobsProcessor devient un simple adaptateur Bull → ConversionProcessorService
//   - Logique identique quelle que soit la file (Redis ou Memory)
//
// FIX PHASE 37 — RETRY COHÉRENT :
//   • maxAttempts transmis au processeur (le job n'est marqué FAILED qu'à
//     épuisement réel des tentatives — plus de FAILED prématuré sur 429).
//   • NonRetryableError → job.discard() : Bull ne relance JAMAIS une erreur
//     permanente (secret mismatch, job déjà terminal…).
//   • Stratégie de backoff custom 'conversion-retry' enregistrée sur la file :
//     Retry-After respecté quand fourni, sinon backoff exponentiel + jitter.
//     UNE SEULE stratégie partagée avec MemoryQueueProvider (retry-delay.ts).
// ============================================================
import { Process, Processor, OnQueueFailed, OnQueueCompleted } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';

import { ConversionProcessorService, ConversionJobPayload } from '../../queue/conversion-processor.service';
import { NonRetryableError }    from '../../queue/non-retryable.error';
import { getMaxAttempts }       from '../../queue/retry-delay';

// PHASE 25 Partie E : concurrency=5 via l'option du @Process (Bull NestJS pattern correct)
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
    try {
      // PHASE 26 — Délégation complète à ConversionProcessorService
      // PHASE 37 — maxAttempts transmis : le FAILED n'arrive qu'à épuisement
      await this.conversionProcessor.processConversionJob(job.data, {
        attemptsMade: job.attemptsMade,
        maxAttempts:  job.opts.attempts ?? getMaxAttempts(),
      });
    } catch (err) {
      // FIX PHASE 37 — Erreur permanente : supprimer les tentatives restantes
      // pour que Bull ne relance PAS le job (ex: job déjà terminal, secret
      // mismatch). Sans discard(), Bull retenterait jusqu'à `attempts` fois
      // une erreur dont le retry ne peut pas changer l'issue.
      if (err instanceof NonRetryableError || (err as { nonRetryable?: boolean })?.nonRetryable === true) {
        try {
          await job.discard();
          this.logger.warn(
            `[Queue] Job ${job.data.jobId} — erreur non-réessayable, tentatives restantes supprimées: ${(err as Error).message}`,
          );
        } catch (discardErr) {
          this.logger.warn(`[Queue] Job ${job.data.jobId} — discard() a échoué: ${(discardErr as Error).message}`);
        }
      }
      throw err;
    }
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
