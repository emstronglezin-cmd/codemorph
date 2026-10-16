// ============================================================
// CodeMorph AI Engine — PHASE 36: Scheduler (queue contrôlée)
//
// NE LANCE JAMAIS tous les chunks simultanément.
// Concurrence par défaut = 1 (séquentiel) — configurable via
// AI_MAX_CONCURRENT_REQUESTS (petite concurrence si sûr).
//
//   Chunk 1 → traitement
//        ↓
//   Chunk 2 → traitement
//        ↓
//   …
//
// Objectif : éviter les 429 Render + éviter les 429 Groq.
// Priorité à la FIABILITÉ, pas à la vitesse maximale.
// ============================================================

import { estimateTokens, getPhase36Config } from './config';

export interface ScheduledTask<T> {
  id: string;
  run: () => Promise<T>;
  /** Tokens estimés de la requête — pour le pacing local */
  estimatedTokens?: number;
}

export interface ScheduleOptions {
  /** Concurrence max — défaut: AI_MAX_CONCURRENT_REQUESTS (1) */
  concurrency?: number;
  /**
   * Callback de progression après chaque tâche terminée.
   * FIX PHASE 40 — PROBLÈME C : `completed` compte les tâches TERMINÉES
   * (succès + échecs), comme avant. `succeeded` ne compte QUE les réussites.
   * Toute barre de progression ou tout compteur « analysés » doit utiliser
   * `succeeded` : un chunk dont l'appel IA a échoué n'est pas un chunk analysé.
   */
  onProgress?: (
    completed: number,
    total:     number,
    lastId:    string,
    info:      { succeeded: number; failed: number },
  ) => void;
  /** Pacing local : si le budget tokens/minute est atteint, attendre la fenêtre suivante */
  rateLimitTpm?: number;
  /** Injecté pour les tests */
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
}

export interface ScheduleResult<T> {
  results: Map<string, T>;
  errors: Map<string, Error>;
  totalWaitMs: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Exécute les tâches dans l'ordre avec une concurrence contrôlée.
 * - Les tâches sont prises dans l'ordre du tableau (famine impossible).
 * - Le pacing TPM local attend le reset de fenêtre AVANT d'envoyer
 *   (plutôt que d'envoyer et subir un 429).
 * - Résout toujours (les erreurs sont capturées par tâche dans `errors`).
 */
export async function runScheduled<T>(
  tasks: Array<ScheduledTask<T>>,
  options: ScheduleOptions = {},
): Promise<ScheduleResult<T>> {
  const cfg = getPhase36Config();
  const concurrency = Math.max(1, options.concurrency ?? cfg.maxConcurrentRequests);
  const tpm = options.rateLimitTpm ?? cfg.rateLimitTpm;
  const sleep = options.sleepFn ?? defaultSleep;
  const now = options.nowFn ?? Date.now;

  const results = new Map<string, T>();
  const errors   = new Map<string, Error>();
  let totalWaitMs = 0;

  // ── Pacing TPM (fenêtre glissante 60s) ─────────────────────────────────────
  let windowStart = now();
  let tokensInWindow = 0;

  const waitForTokenBudget = async (estimated: number): Promise<void> => {
    for (;;) {
      const elapsed = now() - windowStart;
      if (elapsed >= 60_000) {
        windowStart = now();
        tokensInWindow = 0;
        return;
      }
      // Un bloc dont l'estimation dépasse à lui seul le budget minute ne peut
      // pas "attendre" indéfiniment → on laisse partir (le resilience absorbera
      // un éventuel 429). Sinon on attend le reset de la fenêtre.
      if (tokensInWindow + estimated <= tpm || estimated >= tpm) return;
      const waitMs = 60_000 - elapsed + 1_500; // +1.5s de marge
      totalWaitMs += waitMs;
      await sleep(waitMs);
      windowStart = now();
      tokensInWindow = 0;
      return;
    }
  };

  let nextIndex = 0;
  let completed = 0;
  // FIX PHASE 40 — PROBLÈME C : compteurs séparés.
  // AVANT : un seul compteur `completed` incrémenté dans tous les cas, y compris
  //   quand `task.run()` levait. Le callback de progression annonçait donc
  //   « N/M chunks analyzed » en comptant les chunks dont l'appel IA avait
  //   ÉCHOUÉ. Avec des 401 Groq sur tous les chunks, la progression montait
  //   jusqu'à 33/33 alors que rien n'avait été analysé.
  let succeeded = 0;
  let failed    = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = nextIndex++;
      if (idx >= tasks.length) return;
      const task = tasks[idx];
      if (!task) return;

      // ── Pacing AVANT l'envoi (empêche les requêtes trop rapprochées) ──
      // FIX — `tpm <= 0` désactive cette porte : le GroqRateLimiter du provider
      // applique déjà le budget TPM (fenêtre glissante) et le RPM. Les laisser
      // tous deux actifs faisait attendre la même requête à deux guichets.
      if (tpm > 0 && task.estimatedTokens !== undefined && task.estimatedTokens > 0) {
        await waitForTokenBudget(task.estimatedTokens);
        tokensInWindow += task.estimatedTokens;
      }

      try {
        const result = await task.run();
        results.set(task.id, result);
        succeeded++;
      } catch (err) {
        errors.set(task.id, err instanceof Error ? err : new Error(String(err)));
        failed++;
      }
      completed++;
      options.onProgress?.(completed, tasks.length, task.id, { succeeded, failed });
    }
  };

  const workers: Array<Promise<void>> = [];
  const effective = Math.min(concurrency, tasks.length);
  for (let i = 0; i < effective; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return { results, errors, totalWaitMs };
}

/** Vérifie qu'un prompt respecte le budget input — sinon jette une erreur claire. */
export function assertInputBudget(
  promptChars: number,
  label: string,
  maxInputTokens?: number,
): number {
  const cfg = getPhase36Config();
  const budget = maxInputTokens ?? cfg.maxInputTokens;
  const estimated = Math.ceil((promptChars / 4) * 1.08);
  if (estimated > budget) {
    throw new Error(
      `[AI-BUDGET] ${label}: prompt estimé ${estimated} tokens > budget ${budget} tokens ` +
      `(AI_MAX_INPUT_TOKENS). Le chunk doit être découpé davantage.`,
    );
  }
  return estimated;
}

/** Estimation simple du nombre de tokens d'un prompt. */
export function estimatePromptTokens(prompt: string): number {
  return estimateTokens(prompt);
}
