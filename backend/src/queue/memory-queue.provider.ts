// ============================================================
// CodeMorph — MemoryQueueProvider
// PHASE 26 — File FIFO en mémoire (fallback Redis)
//
// PRIORITÉ 2 : File mémoire avec :
//   • FIFO
//   • Concurrence configurable (défaut: 5)
//   • Retry automatique (3 tentatives, backoff exponentiel)
//   • Timeout par job (5min)
//   • Progression identique au chemin Bull
//   • Nettoyage automatique (mémoire bornée)
//
// PRIORITÉ 6 : Optimisation mémoire
//   • Taille max de la file : MAX_QUEUE_SIZE = 500 jobs
//   • Jobs terminés supprimés après COMPLETED_TTL_MS
//   • Payload limité (pas de stockage des fichiers en RAM)
//
// NOTE ARCHITECTURE (Phase 26.1) :
//   ConversionProcessorService est injecté via setProcessor() (setter injection)
//   pour éviter la dépendance circulaire :
//   QueueModule → MemoryQueueProvider → ConversionProcessorService (JobsModule) ← JobsModule
//   La setter injection est appelée par JobsModule après la construction des providers.
//
// L'utilisateur ne voit AUCUNE différence avec le chemin Redis.
// ============================================================
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

import { IQueueProvider, JobOptions } from './queue.provider.interface';
// FIX PHASE 35 — NonRetryableError : stopper le retry sur jobs terminaux
import { NonRetryableError } from './non-retryable.error';
// FIX PHASE 37 — RetryableError : respecter Retry-After / backoff partagé
import { minDelayMsOf, retryAfterMsOf } from './retryable.error';
import { computeRetryDelayMs } from './retry-delay';

/** Interface minimale du processeur (évite import circulaire) */
export interface IConversionProcessor {
  processConversionJob(
    payload:     { jobId: string; dto: Record<string, unknown> },
    attemptInfo: { attemptsMade: number },
  ): Promise<void>;
}

/** Payload d'un job de conversion */
export interface MemoryJobPayload {
  jobId: string;
  dto:   Record<string, unknown>;
}

/** Nombre max de jobs en attente dans la file mémoire */
const MAX_QUEUE_SIZE = 500;

/** Concurrence max (jobs en parallèle) */
const DEFAULT_CONCURRENCY = 5;

/** Timeout par job : 5 minutes */
const JOB_TIMEOUT_MS = 5 * 60 * 1_000;

/** Délai initial de backoff exponentiel (ms) */
const INITIAL_BACKOFF_MS = 2_000;

/** Nombre de tentatives max */
const MAX_ATTEMPTS = 3;

/** Durée de conservation des jobs terminés avant nettoyage (2 minutes) */
const COMPLETED_TTL_MS = 2 * 60 * 1_000;

interface MemoryJob {
  id:           string;
  name:         string;
  data:         unknown;
  opts:         JobOptions;
  attemptsMade: number;
  status:       'waiting' | 'active' | 'completed' | 'failed' | 'cancelled';
  enqueuedAt:   number;
  completedAt?: number;
  error?:       string;
  // FIX PHASE 37 — dernière erreur (pour Retry-After / backoff partagé)
  lastError?:   unknown;
  // FIX PHASE 43 — annulation propre : le timer de retry planifié doit pouvoir
  // être annulé, sinon un job cancelé repart quand même après le backoff.
  retryTimer?:     ReturnType<typeof setTimeout>;
  cancelRequested?: boolean;
}

@Injectable()
export class MemoryQueueProvider implements IQueueProvider, OnModuleDestroy {
  readonly providerName = 'memory' as const;
  private readonly logger = new Logger(MemoryQueueProvider.name);

  /** File FIFO des jobs en attente */
  private readonly waitingQueue: MemoryJob[] = [];

  /** Jobs actifs (en cours de traitement) */
  private readonly activeJobs = new Map<string, MemoryJob>();

  /** Jobs terminés (pour référence, bornés par COMPLETED_TTL_MS) */
  private readonly completedJobs = new Map<string, MemoryJob>();

  /**
   * FIX PHASE 43 — Jobs en attente de RETRY (backoff en cours).
   *
   * Le `finally` du worker retire systématiquement le job de `activeJobs`, et le
   * job n'est remis dans `waitingQueue` qu'à l'expiration du timer de backoff.
   * Entre les deux, le job n'était dans AUCUNE collection : impossible à annuler.
   * C'est exactement l'état d'un job qui attend le réveil d'une instance Render
   * pendant 45 s — le cas où l'annulation est la plus nécessaire.
   */
  private readonly pendingRetry = new Map<string, MemoryJob>();

  /** Nombre de workers actifs */
  private activeWorkerCount = 0;

  /** Indicateur d'arrêt du module */
  private shuttingDown = false;

  /** Timer de nettoyage des jobs terminés */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /** Compteur auto-incrémenté pour les IDs */
  private jobCounter = 0;

  /**
   * Processeur injecté via setter (évite circularité avec JobsModule).
   * Initialisé par JobsModule.registerProcessor() après construction.
   */
  private processor: IConversionProcessor | null = null;

  constructor() {
    // Nettoyage toutes les 2 minutes
    this.cleanupTimer = setInterval(() => this.cleanupCompletedJobs(), COMPLETED_TTL_MS);
  }

  /**
   * Setter injection du processeur de conversion.
   * Appelé par JobsModule après la construction de tous les providers
   * pour éviter la dépendance circulaire.
   */
  setProcessor(processor: IConversionProcessor): void {
    this.processor = processor;
    this.logger.log('[MemoryQueue] ConversionProcessorService injecté ✓');
  }

  onModuleDestroy(): void {
    this.shuttingDown = true;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    const pending = this.waitingQueue.length;
    const active  = this.activeJobs.size;
    if (pending > 0 || active > 0) {
      this.logger.warn(
        `[MemoryQueue] Arrêt avec ${pending} job(s) en attente, ${active} job(s) actif(s)`,
      );
    }
  }

  // ── Enqueue ────────────────────────────────────────────────
  async add(name: string, data: unknown, opts?: JobOptions): Promise<void> {
    if (this.shuttingDown) {
      throw new Error('MemoryQueue: module en cours d\'arrêt, rejet du job');
    }

    if (!this.processor) {
      throw new Error(
        'MemoryQueue: processeur non initialisé. ' +
        'JobsModule.setMemoryQueueProcessor() doit être appelé au démarrage.',
      );
    }

    if (this.waitingQueue.length >= MAX_QUEUE_SIZE) {
      throw new Error(
        `MemoryQueue saturée (${MAX_QUEUE_SIZE} jobs en attente). ` +
        `Réessayez dans quelques minutes.`,
      );
    }

    const job: MemoryJob = {
      id:           `mem-${++this.jobCounter}-${Date.now()}`,
      name,
      data,
      opts:         opts ?? {},
      attemptsMade: 0,
      status:       'waiting',
      enqueuedAt:   Date.now(),
    };

    this.waitingQueue.push(job);
    this.logger.log(
      `[MemoryQueue] Job ${job.id} enqueued (${name}) — ` +
      `file: ${this.waitingQueue.length} en attente, ${this.activeJobs.size} actifs`,
    );

    // Lancer un worker si possible
    this.scheduleNextWorker();
  }

  isHealthy(): boolean {
    return !this.shuttingDown && this.waitingQueue.length < MAX_QUEUE_SIZE && this.processor !== null;
  }

  // ── Statistiques (pour monitoring) ────────────────────────
  getStats(): {
    waiting:    number;
    active:     number;
    completed:  number;
    workers:    number;
    maxWorkers: number;
    processorReady: boolean;
  } {
    return {
      waiting:    this.waitingQueue.length,
      active:     this.activeJobs.size,
      completed:  this.completedJobs.size,
      workers:    this.activeWorkerCount,
      maxWorkers: DEFAULT_CONCURRENCY,
      processorReady: this.processor !== null,
    };
  }

  // ── Planifier le prochain worker ──────────────────────────
  private scheduleNextWorker(): void {
    if (this.shuttingDown) return;
    if (this.activeWorkerCount >= DEFAULT_CONCURRENCY) return;
    if (this.waitingQueue.length === 0) return;

    setImmediate(() => void this.runNextJob());
  }

  // ── Exécuter le prochain job de la file ───────────────────
  private async runNextJob(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.activeWorkerCount >= DEFAULT_CONCURRENCY) return;

    const job = this.waitingQueue.shift();
    if (!job) return;

    this.activeWorkerCount++;
    job.status = 'active';
    this.activeJobs.set(job.id, job);

    this.logger.log(
      `[MemoryQueue] Worker démarré — jobId=${job.id} attempt=${job.attemptsMade + 1} ` +
      `workers_actifs=${this.activeWorkerCount}/${DEFAULT_CONCURRENCY}`,
    );

    // Timeout par job
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        reject(new Error(`Timeout: job ${job.id} dépassé (${JOB_TIMEOUT_MS / 1_000}s)`));
      }, JOB_TIMEOUT_MS);
    });

    try {
      await Promise.race([
        this.executeJob(job),
        timeoutPromise,
      ]);

      if (timeoutHandle) clearTimeout(timeoutHandle);

      job.status      = 'completed';
      job.completedAt = Date.now();
      this.completedJobs.set(job.id, job);
      this.logger.log(`[MemoryQueue] ✅ Job ${job.id} terminé avec succès`);

    } catch (err) {
      if (timeoutHandle) clearTimeout(timeoutHandle);

      const message = (err as Error).message ?? 'Erreur inconnue';
      job.error       = message;
      job.lastError   = err;
      job.attemptsMade++;

      const maxAttempts = job.opts.attempts ?? MAX_ATTEMPTS;

      // FIX PHASE 35 — NonRetryableError : certaines erreurs sont terminales et ne
      // doivent JAMAIS déclencher de retry, quelle que soit la tentative courante.
      // Exemples : job déjà FAILED/DONE en base, secret mismatch non récupérable.
      // AVANT : toute Error ordinaire → retry jusqu'à maxAttempts (3 inutiles)
      // MAINTENANT : NonRetryableError → abandon immédiat, statut failed, 0 retry
      const isNonRetryable = err instanceof NonRetryableError ||
        (err as { nonRetryable?: boolean })?.nonRetryable === true;

      if (job.cancelRequested) {
        // FIX PHASE 43 — annulation demandée pendant le traitement : on arrête
        // ici, sans planifier de retry et sans marquer le job « failed ».
        this.finalizeCancelled(job);
      } else if (isNonRetryable) {
        // Abandon immédiat — pas de retry, quelle que soit la tentative
        job.status      = 'failed';
        job.completedAt = Date.now();
        this.completedJobs.set(job.id, job);
        this.logger.warn(
          `[MemoryQueue] 🚫 Job ${job.id} — NonRetryableError après ` +
          `${job.attemptsMade} tentative(s): ${message} (aucun retry planifié)`,
        );
      } else if (!timedOut && job.attemptsMade < maxAttempts) {
        // Retry avec backoff exponentiel
        const delay = this.computeBackoff(job);
        this.logger.warn(
          `[MemoryQueue] ⚠️ Job ${job.id} échoué (tentative ${job.attemptsMade}/${maxAttempts}) ` +
          `— retry dans ${delay}ms: ${message}`,
        );
        job.status = 'waiting';
        this.pendingRetry.set(job.id, job);
        job.retryTimer = setTimeout(() => {
          job.retryTimer = undefined;
          this.pendingRetry.delete(job.id);
          if (job.cancelRequested) {
            this.finalizeCancelled(job);
            return;
          }
          this.waitingQueue.unshift(job); // Remettre en tête de file (priorité retry)
          this.scheduleNextWorker();
        }, delay);
      } else {
        // Échec définitif
        job.status      = 'failed';
        job.completedAt = Date.now();
        this.completedJobs.set(job.id, job);
        this.logger.error(
          `[MemoryQueue] ❌ Job ${job.id} définitivement échoué après ` +
          `${job.attemptsMade} tentative(s)${timedOut ? ' (timeout)' : ''}: ${message}`,
        );
      }
    } finally {
      this.activeJobs.delete(job.id);
      this.activeWorkerCount--;

      // Libérer un slot → lancer le prochain job
      this.scheduleNextWorker();
    }
  }

  // ── Exécuter la logique métier du job ─────────────────────
  private async executeJob(job: MemoryJob): Promise<void> {
    if (job.name !== 'run-conversion') {
      throw new Error(`MemoryQueue: job name inconnu: ${job.name}`);
    }

    if (!this.processor) {
      throw new Error('MemoryQueue: processeur non disponible');
    }

    const payload = job.data as MemoryJobPayload;
    await this.processor.processConversionJob(
      payload as Parameters<IConversionProcessor['processConversionJob']>[0],
      { attemptsMade: job.attemptsMade },
    );
  }

  // ── FIX PHASE 43 — Annulation PROPRE d'un job ────────────────────────────
  //
  // AVANT : la file n'avait AUCUN moyen d'annuler un job. `JobsService.cancel()`
  // se contentait de passer le statut en base, et la file continuait de retenter
  // le job — donc de taper l'AI Engine (et de consommer du quota Groq) pour un
  // job que l'utilisateur avait déjà abandonné.
  //
  // `cancelJob()` :
  //   • supprime le job de la file d'attente s'il n'a pas démarré ;
  //   • annule le timer de retry planifié (sinon il repart après le backoff) ;
  //   • pose un drapeau pour qu'un job déjà actif ne soit PAS retenté ;
  //   • ne marque JAMAIS le job « failed » : il est « cancelled ».
  /**
   * Annule un job. Retourne true si le job était connu de la file.
   * Idempotent : annuler deux fois ne provoque rien.
   */
  cancelJob(jobId: string): boolean {
    const job = this.findJob(jobId);

    if (!job) {
      this.logger.warn(`[MemoryQueue] Annulation ignorée — job inconnu: ${jobId}`);
      return false;
    }
    if (job.status === 'cancelled' || job.status === 'completed' || job.status === 'failed') {
      return true; // déjà terminé : idempotent
    }

    job.cancelRequested = true;

    // 1. Annuler le retry planifié (le cas le plus important pour l'hibernation :
    //    un job en attente de réveil pendant 45 s ne doit pas repartir).
    if (job.retryTimer) {
      clearTimeout(job.retryTimer);
      job.retryTimer = undefined;
    }

    // 2. Retirer de la file d'attente si pas encore démarré.
    const idx = this.waitingQueue.findIndex((j) => j === job);
    if (idx !== -1) {
      this.waitingQueue.splice(idx, 1);
      this.finalizeCancelled(job);
    } else {
      // Job actif : le worker s'arrêtera après l'appel en cours (drapeau posé).
      this.logger.log(
        `[MemoryQueue] 🛑 Annulation demandée pour le job actif ${jobId} ` +
        `(attempt ${job.attemptsMade}) — aucun retry ne sera planifié`,
      );
    }
    return true;
  }

  /**
   * Recherche un job par son id INTERNE (`mem-N-<ts>`) OU par le `jobId` MÉTIER
   * porté dans le payload.
   *
   * Cette double correspondance est indispensable : `JobsService.cancel()` ne
   * connaît que le jobId métier, alors que la file génère son propre id interne.
   * Sans elle, aucune annulation venue de l'API ne pourrait viser le bon job.
   */
  private findJob(key: string): MemoryJob | undefined {
    const matches = (j: MemoryJob): boolean => {
      if (j.id === key) return true;
      const payloadJobId = (j.data as { jobId?: unknown } | undefined)?.jobId;
      return typeof payloadJobId === 'string' && payloadJobId === key;
    };
    return (
      this.waitingQueue.find(matches) ??
      this.activeJobs.get(key) ??
      this.pendingRetry.get(key) ??
      this.completedJobs.get(key) ??
      [...this.activeJobs.values()].find(matches) ??
      [...this.pendingRetry.values()].find(matches) ??
      [...this.completedJobs.values()].find(matches)
    );
  }

  /** Marque définitivement un job comme annulé (une seule fois). */
  private finalizeCancelled(job: MemoryJob): void {
    if (job.status === 'cancelled') return;
    job.status      = 'cancelled';
    job.completedAt = Date.now();
    const idx = this.waitingQueue.findIndex((j) => j === job);
    if (idx !== -1) this.waitingQueue.splice(idx, 1);
    this.activeJobs.delete(job.id);
    this.pendingRetry.delete(job.id);
    this.completedJobs.set(job.id, job);
    this.logger.log(`[MemoryQueue] 🛑 Job ${job.id} annulé (aucun retry planifié)`);
  }

  // ── Calcul du backoff ─────────────────────────────────────
  // FIX PHASE 37 — même politique que Bull (retry-delay.ts, source unique) :
  //   • RetryableError avec Retry-After → délai respecté (plafonné) ;
  //   • sinon → exponentiel borné (comportement historique préservé).
  private computeBackoff(job: MemoryJob): number {
    // FIX PHASE 43 — le plancher de délai (`minDelayMs`) doit AUSSI déclencher
    // la délégation à la politique partagée.
    //
    // AVANT : délégation uniquement si `retryAfterMs !== undefined`. Or un rejet
    // d'hibernation Render (429 + `x-render-routing: hibernate-rate-limited`)
    // n'envoie PAS de `Retry-After` : on retombait dans la branche legacy
    // ci-dessous, qui IGNORE `minDelayMs`. Le plancher de réveil de 45 s posé
    // par le classifieur n'était jamais lu → 2 s / 4 s / 8 s / 16 s = 30 s pour
    // 5 tentatives, alors que l'instance met ~1 min à redémarrer.
    //
    // `computeRetryDelayMs` applique le plancher via Math.max : il ne peut
    // qu'ALLONGER l'attente, jamais la raccourcir. Aucune limite contournée.
    if (retryAfterMsOf(job.lastError) !== undefined || minDelayMsOf(job.lastError) !== undefined) {
      return computeRetryDelayMs(job.lastError, job.attemptsMade);
    }

    const type  = job.opts.backoff?.type  ?? 'exponential';
    const delay = job.opts.backoff?.delay ?? INITIAL_BACKOFF_MS;

    if (type === 'fixed') return delay;
    return Math.min(delay * Math.pow(2, job.attemptsMade - 1), 30_000);
  }

  // ── Nettoyage des jobs terminés ───────────────────────────
  private cleanupCompletedJobs(): void {
    const now = Date.now();
    let removed = 0;

    for (const [id, job] of this.completedJobs.entries()) {
      if (job.completedAt && now - job.completedAt > COMPLETED_TTL_MS) {
        this.completedJobs.delete(id);
        removed++;
      }
    }

    if (removed > 0) {
      this.logger.debug(
        `[MemoryQueue] Nettoyage: ${removed} job(s) terminé(s) supprimés ` +
        `(${this.completedJobs.size} restants)`,
      );
    }
  }
}
