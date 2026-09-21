// ============================================================
// CodeMorph — NonRetryableError
// FIX PHASE 35 — Erreur terminale non-retryable
//
// Utilisé par ConversionProcessorService pour signaler à
// MemoryQueueProvider qu'un job ne doit PAS être retenté
// (ex: job déjà en statut terminal FAILED/DONE en base).
//
// MemoryQueueProvider vérifie `err instanceof NonRetryableError`
// avant de décider si une nouvelle tentative est justifiée.
// ============================================================

/**
 * Erreur qui signale à la file que ce job ne doit PAS être retenté.
 * Utilisé pour les cas où relancer le traitement serait incorrect :
 *  - Job déjà FAILED ou DONE en base de données
 *  - Erreur de configuration non récupérable (secret mismatch)
 *  - Toute erreur dont le retry ne changerait pas l'issue
 */
export class NonRetryableError extends Error {
  readonly nonRetryable = true as const;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = 'NonRetryableError';
    if (cause) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}
