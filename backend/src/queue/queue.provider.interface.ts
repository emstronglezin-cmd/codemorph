// ============================================================
// CodeMorph — IQueueProvider Interface
// PHASE 26 — MODE GRATUIT ROBUSTE
//
// Abstraction unique pour la file de conversion.
// Deux implémentations :
//   • RedisQueueProvider  — Bull + Redis/Upstash (si disponible)
//   • MemoryQueueProvider — FIFO en mémoire (fallback automatique)
//
// Aucun `if Redis` ailleurs dans le projet.
// Toute l'application passe par cette interface.
// ============================================================

export interface JobOptions {
  /** Priorité Bull (plus bas = priorité plus haute). Défaut: 0 */
  priority?:         number;
  /** Nombre de tentatives max. Défaut: 3 */
  attempts?:         number;
  /** Stratégie de backoff */
  backoff?:          { type: 'exponential' | 'fixed'; delay: number };
  /** Supprimer de la queue après succès (Bull uniquement) */
  removeOnComplete?: number | boolean;
  /** Supprimer de la queue après échec (Bull uniquement) */
  removeOnFail?:     number | boolean;
  /** Plan utilisateur (metadata, pour logs/priorité MemoryQueue) */
  plan?:             string;
}

/**
 * Interface commune QueueProvider.
 * Toute la logique d'enqueue passe par cette interface.
 * La sélection Redis ou Memory est faite par QueueAdapterService.
 */
export interface IQueueProvider {
  /**
   * Ajouter un job à la file d'attente.
   * @param name   Nom du job (ex: 'run-conversion')
   * @param data   Payload du job
   * @param opts   Options optionnelles (priorité, retry, etc.)
   */
  add(name: string, data: unknown, opts?: JobOptions): Promise<void>;

  /**
   * Indique si ce provider est actuellement disponible / opérationnel.
   */
  isHealthy(): boolean;

  /**
   * Nom du provider (pour les logs).
   */
  readonly providerName: 'redis' | 'memory';
}

/**
 * Token d'injection NestJS pour IQueueProvider.
 * Utilisé via @Inject(QUEUE_PROVIDER_TOKEN) dans JobsService.
 */
export const QUEUE_PROVIDER_TOKEN = 'QUEUE_PROVIDER';
