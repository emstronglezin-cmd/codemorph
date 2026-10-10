// ============================================================
// CodeMorph — TESTS MemoryQueueProvider (retry côté file)
//
// Couvre (Objectif 5) :
//   • TEST 1 : 429 (RetryableError + Retry-After) → retry DIFFÉRÉ d'au moins
//              le Retry-After annoncé
//   • TEST 3 : un succès après un 429 → le job continue et termine normalement
//   • TEST 4 : erreur permanente (NonRetryableError) → aucun retry planifié
//   • TEST 5 : job marqué failed seulement après ÉPUISEMENT des tentatives
//
// NOTE : on fake uniquement setTimeout/setInterval/Date (doNotFake garde
// setImmediate réel, utilisé par MemoryQueueProvider pour démarrer les workers).
// ============================================================
import { MemoryQueueProvider, type IConversionProcessor } from '../memory-queue.provider';
import { NonRetryableError } from '../non-retryable.error';
import { RetryableError }    from '../retryable.error';

interface CallRecord { attemptsMade: number; at: number }

// Laisse les setImmediate réels + microtasks s'exécuter
async function drain(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setImmediate(r));
  }
}

describe('MemoryQueueProvider — politique de retry', () => {
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

  it('TEST 1+3 : 429 avec Retry-After → retry différé respecté, puis succès', async () => {
    const calls: CallRecord[] = [];
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const processor: IConversionProcessor = {
      processConversionJob: jest.fn(async (_payload, info) => {
        calls.push({ attemptsMade: info.attemptsMade, at: Date.now() });
        if (info.attemptsMade === 0) {
          // Simule un 429 provider avec Retry-After de 30s
          throw new RetryableError('AI Engine rate limited (429)', {
            kind: 'rate-limit', httpStatus: 429, retryAfterMs: 30_000,
          });
        }
        // 2e tentative → succès : le job continue normalement
      }),
    };
    queue.setProcessor(processor);

    await queue.add('run-conversion', { jobId: 'job-429', dto: {} });
    await drain();

    // Tentative 1 exécutée, erreur 429 → retry planifié via setTimeout
    expect(calls).toHaveLength(1);

    // Le délai planifié doit respecter le Retry-After (≥ 30s annoncé)
    const retryDelays = setTimeoutSpy.mock.calls
      .map((c) => c[1] as number)
      .filter((d) => typeof d === 'number' && d >= 29_000);
    expect(retryDelays.length).toBeGreaterThan(0);

    // Pas encore de 2e tentative avant l'échéance
    jest.advanceTimersByTime(20_000);
    await drain();
    expect(calls).toHaveLength(1);

    // Après le Retry-After → 2e tentative → succès
    jest.advanceTimersByTime(15_000);
    await drain();
    expect(calls).toHaveLength(2);
    expect(calls[1].attemptsMade).toBe(1);

    const stats = queue.getStats();
    expect(stats.active).toBe(0);
    expect(stats.waiting).toBe(0);
    expect(stats.completed).toBe(1);
  });

  it('TEST 4 : NonRetryableError → abandon immédiat, AUCUN retry planifié', async () => {
    const processMock = jest.fn(async () => {
      throw new NonRetryableError('secret mismatch (401) — non récupérable');
    });
    queue.setProcessor({ processConversionJob: processMock });

    await queue.add('run-conversion', { jobId: 'job-permanent', dto: {} });
    await drain();

    // Une seule tentative ; même après beaucoup de temps, aucun retry
    jest.advanceTimersByTime(10 * 60 * 1000);
    await drain();

    expect(processMock).toHaveBeenCalledTimes(1);
    const stats = queue.getStats();
    expect(stats.active).toBe(0);
    expect(stats.waiting).toBe(0);
  });

  it('TEST 5 : erreurs transitoires répétées → failed seulement après épuisement (3 tentatives)', async () => {
    const processMock = jest.fn(async () => {
      throw new RetryableError('AI Engine server error (502)', { kind: 'server', httpStatus: 502 });
    });
    queue.setProcessor({ processConversionJob: processMock });

    // backoff court pour le test (pas de Retry-After → chemin exponentiel)
    await queue.add(
      'run-conversion',
      { jobId: 'job-epuisement', dto: {} },
      { attempts: 3, backoff: { type: 'fixed', delay: 10 } },
    );
    await drain();

    // Dérouler tentatives + backoffs (le délai fixed=10ms est faked)
    for (let i = 0; i < 10 && processMock.mock.calls.length < 3; i++) {
      jest.advanceTimersByTime(50);
      await drain();
    }
    await drain();

    // 3 tentatives exactement : ni plus (pas de boucle infinie), ni moins
    expect(processMock).toHaveBeenCalledTimes(3);
    const stats = queue.getStats();
    expect(stats.waiting).toBe(0);
    expect(stats.active).toBe(0);
  });
});
