// ============================================================
// CodeMorph — QueueAdapterService
// PHASE 26 — Détection automatique Redis + basculement Memory
//
// PRIORITÉ 3 : Interface unique QueueProvider
// PRIORITÉ 4 : Détection automatique au démarrage
//
// Au démarrage :
//   1. Ping Redis (PING command, timeout 3s)
//   2. Si OK → RedisQueueProvider (Bull)
//   3. Si ERR/timeout/quota → MemoryQueueProvider (fallback)
//
// Erreurs détectées :
//   • ERR max requests limit exceeded  (quota Upstash gratuit)
//   • ECONNREFUSED                      (Redis arrêté)
//   • Timeout (>3s)                     (Redis lent/mort)
//   • Any connection error
//
// PRIORITÉ 8 : Dégradation élégante
//   Message clair dans les logs, jamais d'exception fatale.
//
// AUCUN if Redis ailleurs dans le projet.
// ============================================================
import {
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue }       from 'bull';

import { IQueueProvider, JobOptions } from './queue.provider.interface';
import { RedisQueueProvider }    from './redis-queue.provider';
import { MemoryQueueProvider }   from './memory-queue.provider';

/** Timeout du ping Redis au démarrage (ms) */
const REDIS_HEALTH_CHECK_TIMEOUT_MS = 3_000;

/** Mots-clés indiquant un quota Upstash dépassé */
const QUOTA_EXCEEDED_PATTERNS = [
  'max requests limit exceeded',
  'ERR max daily',
  'ERR max monthly',
  'ERR max requests',
  'max_requests',
  'QUOTA_EXCEEDED',
];

/** Mots-clés indiquant une connexion refusée */
const CONNECTION_REFUSED_PATTERNS = [
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'connection refused',
  'Connection is closed',
  'connect ECONNREFUSED',
];

@Injectable()
export class QueueAdapterService implements IQueueProvider, OnModuleInit {
  readonly providerName: 'redis' | 'memory';

  private readonly logger = new Logger(QueueAdapterService.name);

  /** Provider actif (redis ou memory) */
  private activeProvider!: IQueueProvider;

  /** Indique si Redis est disponible */
  private redisAvailable = false;

  constructor(
    @Optional() @InjectQueue('conversion')
    private readonly bullQueue: Queue | null,

    // MemoryQueueProvider sera injecté par le module
    private readonly memoryProvider: MemoryQueueProvider,
  ) {
    // La valeur sera définie dans onModuleInit
    this.providerName = 'memory'; // valeur temporaire
  }

  // ── Initialisation au démarrage ───────────────────────────
  async onModuleInit(): Promise<void> {
    this.logger.log('[QueueAdapter] Démarrage — test de Redis…');
    await this.detectAndSelectProvider();
  }

  // ── Détection + sélection du provider ─────────────────────
  private async detectAndSelectProvider(): Promise<void> {
    if (!this.bullQueue) {
      this.logger.warn(
        '[QueueAdapter] Bull Queue non disponible (BullModule non configuré). ' +
        'Utilisation de MemoryQueue.',
      );
      this.activateMemoryProvider('Bull non disponible');
      return;
    }

    try {
      const isRedisOk = await this.pingRedis();

      if (isRedisOk) {
        this.redisAvailable = true;
        this.activeProvider = new RedisQueueProvider(this.bullQueue);
        (this as { providerName: string }).providerName = 'redis';
        this.logger.log(
          '[QueueAdapter] ✅ Redis disponible — RedisQueueProvider activé ' +
          '(Bull + Redis/Upstash)',
        );
      } else {
        this.activateMemoryProvider('Ping Redis échoué');
      }
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.activateMemoryProvider(`Exception: ${message}`);
    }
  }

  /** Tester la connexion Redis avec un timeout */
  private async pingRedis(): Promise<boolean> {
    return new Promise((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.logger.warn('[QueueAdapter] Redis ping timeout (>3s)');
        resolve(false);
      }, REDIS_HEALTH_CHECK_TIMEOUT_MS);

      // Utiliser le client ioredis sous-jacent de Bull
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = (this.bullQueue as any)?.client as {
        ping?: (callback: (err: Error | null, result: string) => void) => void;
        status?: string;
      } | undefined;

      if (!client || typeof client.ping !== 'function') {
        clearTimeout(timeoutHandle);
        this.logger.warn('[QueueAdapter] Client Redis Bull non accessible pour ping');
        resolve(false);
        return;
      }

      client.ping((err: Error | null, result: string) => {
        clearTimeout(timeoutHandle);

        if (err) {
          const errMsg = err.message ?? String(err);
          if (this.isQuotaExceeded(errMsg)) {
            this.logger.warn(
              `[QueueAdapter] ⚠️ Quota Redis dépassé: ${errMsg}`,
            );
          } else if (this.isConnectionRefused(errMsg)) {
            this.logger.warn(
              `[QueueAdapter] ⚠️ Redis inaccessible (ECONNREFUSED): ${errMsg}`,
            );
          } else {
            this.logger.warn(`[QueueAdapter] ⚠️ Redis ping error: ${errMsg}`);
          }
          resolve(false);
        } else {
          this.logger.debug(`[QueueAdapter] Redis PONG reçu: ${result}`);
          resolve(true);
        }
      });
    });
  }

  /** Activer le fallback MemoryQueueProvider */
  private activateMemoryProvider(reason: string): void {
    this.redisAvailable = false;
    this.activeProvider = this.memoryProvider;
    (this as { providerName: string }).providerName = 'memory';
    this.logger.warn(
      `[QueueAdapter] ⚠️ Redis désactivé (${reason}). ` +
      'Utilisation de MemoryQueue. La conversion continue normalement.',
    );
  }

  // ── Interface IQueueProvider ──────────────────────────────

  /**
   * Ajouter un job à la file active.
   * Si Redis échoue en cours d'exécution, bascule automatiquement sur Memory.
   */
  async add(name: string, data: unknown, opts?: JobOptions): Promise<void> {
    try {
      await this.activeProvider.add(name, data, opts);
    } catch (err) {
      const message = (err as Error).message ?? String(err);

      // Si le provider actif est Redis et qu'il échoue → basculer
      if (
        this.activeProvider.providerName === 'redis' &&
        (this.isQuotaExceeded(message) || this.isConnectionRefused(message))
      ) {
        this.logger.warn(
          `[QueueAdapter] ⚠️ Redis indisponible pendant l'enqueue: ${message}. ` +
          'Basculement automatique vers MemoryQueue. La conversion continue.',
        );
        this.activateMemoryProvider(`Erreur runtime: ${message}`);

        // Retenter avec MemoryQueue
        await this.activeProvider.add(name, data, opts);
        return;
      }

      // Relancer toute autre erreur (ex: MemoryQueue saturée)
      throw err;
    }
  }

  isHealthy(): boolean {
    return this.activeProvider?.isHealthy() ?? false;
  }

  // ── Helpers diagnostiques ─────────────────────────────────

  /** Indique si Redis est actuellement utilisé */
  isUsingRedis(): boolean {
    return this.redisAvailable && this.activeProvider.providerName === 'redis';
  }

  /** Indique si Memory est actuellement utilisé */
  isUsingMemory(): boolean {
    return this.activeProvider.providerName === 'memory';
  }

  /** Stats de la file mémoire (si active) */
  getMemoryStats(): ReturnType<MemoryQueueProvider['getStats']> | null {
    if (this.activeProvider.providerName === 'memory') {
      return (this.activeProvider as MemoryQueueProvider).getStats();
    }
    return null;
  }

  // ── Vérificateurs d'erreurs ───────────────────────────────
  private isQuotaExceeded(msg: string): boolean {
    return QUOTA_EXCEEDED_PATTERNS.some(p => msg.toLowerCase().includes(p.toLowerCase()));
  }

  private isConnectionRefused(msg: string): boolean {
    return CONNECTION_REFUSED_PATTERNS.some(p => msg.toLowerCase().includes(p.toLowerCase()));
  }
}
