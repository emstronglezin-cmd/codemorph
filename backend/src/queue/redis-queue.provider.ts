// ============================================================
// CodeMorph — RedisQueueProvider
// PHASE 26 — Implémentation Bull (Redis/Upstash)
//
// Enveloppe Bull Queue derrière l'interface IQueueProvider.
// Utilisé quand Redis est disponible au démarrage.
// ============================================================
import { Logger } from '@nestjs/common';
import { Queue }  from 'bull';

import { IQueueProvider, JobOptions } from './queue.provider.interface';

export class RedisQueueProvider implements IQueueProvider {
  readonly providerName = 'redis' as const;
  private readonly logger: Logger;
  private healthy = true;

  constructor(private readonly bullQueue: Queue) {
    this.logger = new Logger(RedisQueueProvider.name);
  }

  async add(name: string, data: unknown, opts?: JobOptions): Promise<void> {
    try {
      await this.bullQueue.add(name, data, {
        priority:         opts?.priority,
        attempts:         opts?.attempts ?? 3,
        backoff:          opts?.backoff ?? { type: 'exponential', delay: 2_000 },
        removeOnComplete: opts?.removeOnComplete ?? 100,
        removeOnFail:     opts?.removeOnFail     ?? 200,
      });
      this.healthy = true;
      this.logger.debug(`[RedisQueue] Job '${name}' ajouté avec succès`);
    } catch (err) {
      this.healthy = false;
      this.logger.error(`[RedisQueue] Erreur ajout job '${name}': ${(err as Error).message}`);
      throw err; // Remonter pour que QueueAdapterService puisse basculer
    }
  }

  isHealthy(): boolean {
    return this.healthy;
  }
}
