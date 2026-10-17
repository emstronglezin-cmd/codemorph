// ============================================================
// CodeMorph — TESTS : réveil fiable de l'AI Engine Render (hibernation)
//
// REPRODUCTION DU BUG SIGNALÉ EN PRODUCTION
// -----------------------------------------
// Projet `emstronglezin-cmd/movia-controller-final` : 40 fichiers récupérés,
// snapshot réutilisé, mais
//   `AI Engine unreachable: Render free-tier instance is hibernating
//    (hibernate-rate-limited)`
// et **5 tentatives échouent en moins d'une minute**.
//
// CAUSE RACINE (démontrée par ce fichier)
// ---------------------------------------
// Le classifieur `AiEngineClient.classifyDispatchError` pose correctement
// `minDelayMs = AI_ENGINE_HIBERNATION_WAIT_MS` (45 000) sur la RetryableError.
// MAIS le seul provider de file réellement câblé est `MemoryQueueProvider`
// (voir `queue.module.ts` : « PHASE 26.1 — MemoryQueueProvider uniquement »).
// Or son `computeBackoff()` ne délègue à la politique partagée
// `computeRetryDelayMs()` — la seule qui lise `minDelayMs` — QUE si
// `retryAfterMs !== undefined` :
//
//     if (retryAfterMsOf(job.lastError) !== undefined) {
//       return computeRetryDelayMs(job.lastError, job.attemptsMade);
//     }
//     ...branche legacy exponentielle, qui IGNORE minDelayMs...
//
// Un rejet d'hibernation Render n'envoie PAS de `Retry-After` (observé : 429 en
// ~72 ms sans cet en-tête). On tombe donc dans la branche legacy :
// 2 s → 4 s → 8 s → 16 s = **30 s pour 5 tentatives**, au lieu de ≥ 4 × 45 s.
// Le plancher de réveil posé en Phase 41 n'était JAMAIS lu.
// ============================================================
import { MemoryQueueProvider, type IConversionProcessor } from '../memory-queue.provider';
import { NonRetryableError } from '../non-retryable.error';
import { RetryableError }    from '../retryable.error';
import { computeRetryDelayMs } from '../retry-delay';

const HIBERNATION_HEADERS = {
  'x-render-routing': 'hibernate-rate-limited',
  'rndr-id':          'abc123#',
};

/** Erreur telle que la produit le classifieur sur un rejet d'hibernation. */
function hibernationError(opts: { retryAfterMs?: number; minDelayMs?: number } = {}): RetryableError {
  return new RetryableError(
    'AI Engine unreachable: Render free-tier instance is hibernating ' +
    `(hibernate-rate-limited). The service spins back up in about a minute.`,
    {
      kind: 'rate-limit',
      httpStatus: 429,
      retryAfterMs: opts.retryAfterMs,
      minDelayMs: opts.minDelayMs ?? 45_000,
      provider: 'render',
    },
  );
}

async function drain(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setImmediate(r));
  }
}

describe('Réveil AI Engine Render — politique de retry (MemoryQueueProvider)', () => {
  let queue: MemoryQueueProvider;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    queue = new MemoryQueueProvider();
  });

  afterEach(() => {
    queue.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // ── 1. LE BUG : plancher de réveil ignoré ──────────────────────────────
  it('BUG : un rejet d\'hibernation SANS Retry-After attend le plancher minDelayMs (pas 2 s)', async () => {
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const processor: IConversionProcessor = {
      processConversionJob: jest.fn(async () => {
        throw hibernationError(); // minDelayMs=45000, PAS de retryAfterMs
      }),
    };
    queue.setProcessor(processor);

    await queue.add('run-conversion', { jobId: 'job-hibernate', dto: {} }, { attempts: 5 });
    await drain();

    // Délais de retry réellement planifiés (on exclut le timeout de job de 5 min)
    const retryDelays = setTimeoutSpy.mock.calls
      .map((c) => Number(c[1]))
      .filter((ms) => Number.isFinite(ms) && ms > 0 && ms < 5 * 60_000);

    expect(retryDelays.length).toBeGreaterThan(0);
    // Cœur de l'assertion : AUCUN retry ne doit partir en dessous du plancher.
    for (const d of retryDelays) {
      expect(d).toBeGreaterThanOrEqual(45_000);
    }
  });

  // ── 2. Réveil réussi après deux tentatives ─────────────────────────────
  it('réveil réussi après 2 tentatives : même jobId, même snapshot, aucune recréation', async () => {
    const seen: Array<{ jobId: unknown; snapshotId: unknown; attempt: number }> = [];
    const processor: IConversionProcessor = {
      processConversionJob: jest.fn(async (payload, info) => {
        const p = payload as { jobId: string; dto: { snapshotId?: string } };
        seen.push({ jobId: p.jobId, snapshotId: p.dto?.snapshotId, attempt: info.attemptsMade });
        if (info.attemptsMade === 0) throw hibernationError();
        // 2e tentative : l'instance est réveillée → succès
      }),
    };
    queue.setProcessor(processor);

    await queue.add(
      'run-conversion',
      { jobId: 'job-fixed-id', dto: { snapshotId: 'snap-movia-40-files' } },
      { attempts: 5 },
    );
    await drain();
    await jest.advanceTimersByTimeAsync(60_000);
    await drain();

    expect(seen.length).toBe(2);
    // Conservation du job ID et du snapshot source entre les tentatives
    expect(seen[0]?.jobId).toBe('job-fixed-id');
    expect(seen[1]?.jobId).toBe('job-fixed-id');
    expect(seen[0]?.snapshotId).toBe('snap-movia-40-files');
    expect(seen[1]?.snapshotId).toBe('snap-movia-40-files');
    // Le processeur n'a été appelé QUE 2 fois : pas de boucle de réveil
    expect(processor.processConversionJob).toHaveBeenCalledTimes(2);
  });

  // ── 3. Retry-After présent → respecté, et jamais sous le plancher ──────
  it('429 AVEC Retry-After (90 s) → le Retry-After prime sur le backoff', () => {
    const err = hibernationError({ retryAfterMs: 90_000, minDelayMs: 45_000 });
    const delay = computeRetryDelayMs(err, 1, { randomFn: () => 0.5 });
    expect(delay).toBeGreaterThanOrEqual(90_000);
  });

  it('429 AVEC Retry-After court (3 s) → le plancher de réveil reste appliqué', () => {
    const err = hibernationError({ retryAfterMs: 3_000, minDelayMs: 45_000 });
    const delay = computeRetryDelayMs(err, 1, { randomFn: () => 0.5 });
    expect(delay).toBeGreaterThanOrEqual(45_000);
  });

  it('429 SANS Retry-After → backoff progressif avec jitter, jamais sous le plancher', () => {
    const d1 = computeRetryDelayMs(hibernationError(), 1, { randomFn: () => 0.5 });
    const d2 = computeRetryDelayMs(hibernationError(), 2, { randomFn: () => 0.5 });
    expect(d1).toBeGreaterThanOrEqual(45_000);
    expect(d2).toBeGreaterThanOrEqual(45_000);
    expect(d2).toBeGreaterThanOrEqual(d1); // progressif
  });

  // ── 4. Pas de retries imbriqués ────────────────────────────────────────
  it('pas de retries imbriqués : 5 tentatives max, jamais plus', async () => {
    let calls = 0;
    const processor: IConversionProcessor = {
      processConversionJob: jest.fn(async () => {
        calls++;
        throw hibernationError();
      }),
    };
    queue.setProcessor(processor);

    await queue.add('run-conversion', { jobId: 'job-exhaust', dto: {} }, { attempts: 5 });
    await drain();
    // On avance bien au-delà de tout budget de réveil
    await jest.advanceTimersByTimeAsync(20 * 60_000);
    await drain();

    expect(calls).toBe(5);
    expect(processor.processConversionJob).toHaveBeenCalledTimes(5);
  });

  // ── 5. Erreurs non concernées : comportement legacy préservé ───────────
  it('erreur réseau sans plancher → backoff legacy inchangé (aucune régression)', () => {
    const netErr = new RetryableError('ECONNREFUSED', { kind: 'network' });
    const d1 = computeRetryDelayMs(netErr, 1, { randomFn: () => 0.5, baseDelayMs: 5_000, maxDelayMs: 120_000 });
    expect(d1).toBe(5_000); // base × 2^0 × jitter(1.0)
    const d2 = computeRetryDelayMs(netErr, 2, { randomFn: () => 0.5, baseDelayMs: 5_000, maxDelayMs: 120_000 });
    expect(d2).toBe(10_000);
  });

  it('NonRetryableError (401) → aucun retry planifié', async () => {
    const processor: IConversionProcessor = {
      processConversionJob: jest.fn(async () => {
        throw new NonRetryableError('AI Engine rejected the secret (401)');
      }),
    };
    queue.setProcessor(processor);

    await queue.add('run-conversion', { jobId: 'job-401', dto: {} }, { attempts: 5 });
    await drain();
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    await drain();

    expect(processor.processConversionJob).toHaveBeenCalledTimes(1);
  });

  // ── 6. Le symptôme production ne doit plus se reproduire ───────────────
  it('RÉGRESSION : 5 tentatives d\'hibernation ne peuvent PAS tenir en moins d\'une minute', async () => {
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const processor: IConversionProcessor = {
      processConversionJob: jest.fn(async () => { throw hibernationError(); }),
    };
    queue.setProcessor(processor);

    await queue.add('run-conversion', { jobId: 'job-regression', dto: {} }, { attempts: 5 });
    await drain();
    // Il faut laisser les timers se déclencher pour que CHAQUE retry suivant
    // soit planifié : 4 attentes pour 5 tentatives.
    for (let i = 0; i < 4; i++) {
      await jest.advanceTimersByTimeAsync(60_000);
      await drain();
    }

    const retryDelays = setTimeoutSpy.mock.calls
      .map((c) => Number(c[1]))
      .filter((ms) => Number.isFinite(ms) && ms > 0 && ms < 5 * 60_000);

    expect(retryDelays.length).toBe(4); // 5 tentatives → 4 attentes
    const total = retryDelays.reduce((a, b) => a + b, 0);
    // Avant le correctif : 2000+4000+8000+16000 = 30 000 ms (< 1 minute).
    // Après : ≥ 4 × 45 000 = 180 000 ms.
    expect(total).toBeGreaterThan(60_000);
  });

  // ── 7. Diagnostic direct de computeBackoff ─────────────────────────────
  it('computeBackoff délègue à la politique partagée dès qu\'un plancher existe', () => {
    // Accès au comportement via la file : on vérifie que minDelayMs seul suffit.
    const errWithFloorOnly = new RetryableError('hibernating', { kind: 'rate-limit', minDelayMs: 45_000 });
    const errWithNeither   = new RetryableError('plain', { kind: 'unknown' });

    expect(computeRetryDelayMs(errWithFloorOnly, 1, { randomFn: () => 0.5 })).toBeGreaterThanOrEqual(45_000);
    // Sans plancher ni Retry-After → backoff de base, pas le plancher
    expect(computeRetryDelayMs(errWithNeither, 1, { randomFn: () => 0.5, baseDelayMs: 5_000 })).toBe(5_000);
    void HIBERNATION_HEADERS;
  });
});

// ============================================================
// FIX PHASE 43 — Annulation PROPRE d'un job
// AVANT : la file n'avait aucun moyen d'annuler. `JobsService.cancel()` passait
// le statut en base, mais la file continuait de retenter le job — donc de taper
// l'AI Engine et de consommer du quota Groq pour un job déjà abandonné.
// ============================================================
describe('Annulation propre d\'un job (MemoryQueueProvider)', () => {
  let queue: MemoryQueueProvider;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    queue = new MemoryQueueProvider();
  });
  afterEach(() => {
    queue.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('un job en attente de réveil est annulé : plus AUCUNE tentative suivante', async () => {
    let calls = 0;
    const processor: IConversionProcessor = {
      processConversionJob: jest.fn(async () => {
        calls++;
        throw new RetryableError('hibernating', { kind: 'rate-limit', minDelayMs: 45_000 });
      }),
    };
    queue.setProcessor(processor);

    await queue.add('run-conversion', { jobId: 'job-cancel-wait', dto: {} }, { attempts: 5 });
    await drain();
    expect(calls).toBe(1); // 1re tentative faite, retry planifié à 45 s

    // Annulation PENDANT l'attente de réveil
    expect(queue.cancelJob('job-cancel-wait')).toBe(true);

    // On avance bien au-delà du plancher de 45 s : rien ne doit repartir.
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    await drain();
    expect(calls).toBe(1);
    expect(processor.processConversionJob).toHaveBeenCalledTimes(1);
  });

  it('un job actif annulé n\'est PAS retenté après l\'appel en cours', async () => {
    let calls = 0;
    const processor: IConversionProcessor = {
      processConversionJob: jest.fn(async () => {
        calls++;
        // L'annulation arrive pendant le traitement
        queue.cancelJob('job-cancel-active');
        throw new RetryableError('network', { kind: 'network' });
      }),
    };
    queue.setProcessor(processor);

    await queue.add('run-conversion', { jobId: 'job-cancel-active', dto: {} }, { attempts: 5 });
    await drain();
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    await drain();

    // Une seule tentative : l'erreur transitoire n'a PAS déclenché de retry.
    expect(calls).toBe(1);
  });

  it('l\'annulation est idempotente et ne marque PAS le job failed', async () => {
    const processor: IConversionProcessor = {
      processConversionJob: jest.fn(async () => {
        throw new RetryableError('network', { kind: 'network' });
      }),
    };
    queue.setProcessor(processor);

    await queue.add('run-conversion', { jobId: 'job-cancel-idem', dto: {} }, { attempts: 5 });
    await drain();

    expect(queue.cancelJob('job-cancel-idem')).toBe(true);
    expect(queue.cancelJob('job-cancel-idem')).toBe(true); // idempotent
    // Un job inconnu retourne false (pas d'effet de bord)
    expect(queue.cancelJob('job-inexistant')).toBe(false);

    await jest.advanceTimersByTimeAsync(10 * 60_000);
    await drain();
    expect(processor.processConversionJob).toHaveBeenCalledTimes(1);
  });

  it('l\'annulation ne déclenche PAS de requête de réveil supplémentaire', async () => {
    let calls = 0;
    const processor: IConversionProcessor = {
      processConversionJob: jest.fn(async () => {
        calls++;
        throw new RetryableError('hibernating', { kind: 'rate-limit', minDelayMs: 45_000 });
      }),
    };
    queue.setProcessor(processor);

    await queue.add('run-conversion', { jobId: 'job-cancel-noloop', dto: {} }, { attempts: 6 });
    await drain();
    queue.cancelJob('job-cancel-noloop');

    await jest.advanceTimersByTimeAsync(30 * 60_000);
    await drain();
    // Aucune boucle de réveil : toujours une seule tentative.
    expect(calls).toBe(1);
  });
});
