// ============================================================
// CodeMorph — TESTS PHASE 40 : problème C, comptage des chunks
// ------------------------------------------------------------
// CONSTAT : `runScheduled()` incrémentait `completed` et appelait onProgress
// même quand `task.run()` avait rejeté, et `semantic-pipeline.ts` faisait
// `doneCount++` à chaque callback. Résultat dans les logs : « 15/33 chunks
// analyzed » alors que plusieurs appels IA avaient échoué. Un chunk en échec
// était compté comme analysé.
// ============================================================
import { runScheduled, ScheduledTask } from '../../src/core/phase36/scheduler';

const noSleep = async (): Promise<void> => undefined;

describe('runScheduled — un chunk en échec n\'est JAMAIS compté comme analysé', () => {
  it('3 succès + 2 échecs → completed=5 mais succeeded=3, failed=2', async () => {
    const tasks: ScheduledTask<string>[] = [
      { id: 'c1', run: async () => 'ok' },
      { id: 'c2', run: async () => { throw new Error('401 Invalid API Key'); } },
      { id: 'c3', run: async () => 'ok' },
      { id: 'c4', run: async () => { throw new Error('rate limit'); } },
      { id: 'c5', run: async () => 'ok' },
    ];

    const seen: Array<{ completed: number; total: number; succeeded: number; failed: number }> = [];
    await runScheduled(tasks, {
      concurrency: 1,
      sleepFn: noSleep,
      onProgress: (completed, total, _lastId, info) => {
        seen.push({ completed, total, succeeded: info.succeeded, failed: info.failed });
      },
    });

    const last = seen[seen.length - 1];
    // Cœur du correctif : `completed` compte les tâches TERMINÉES (5), mais le
    // compteur « analysés » n'en compte que 3.
    expect(last.completed).toBe(5);
    expect(last.succeeded).toBe(3);
    expect(last.failed).toBe(2);
    expect(last.total).toBe(5);
  });

  it('la progression est monotone et `completed` atteint bien le total', async () => {
    const tasks: ScheduledTask<number>[] = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      run: async () => (i % 2 === 0 ? i : Promise.reject(new Error('boom')) as Promise<number>),
    }));

    const completedSeq: number[] = [];
    await runScheduled(tasks, {
      concurrency: 2,
      sleepFn: noSleep,
      onProgress: (completed, _total, _id, _info) => completedSeq.push(completed),
    });

    expect(completedSeq).toEqual([...completedSeq].sort((a, b) => a - b)); // monotone
    expect(completedSeq[completedSeq.length - 1]).toBe(6);
  });

  it('tous les chunks en échec → succeeded = 0 (aucun succès fantôme)', async () => {
    const tasks: ScheduledTask<string>[] = [1, 2, 3, 4].map((i) => ({
      id: `c${i}`,
      run: async () => { throw new Error('401 Invalid API Key'); },
    }));

    let lastSucceeded = -1;
    const result = await runScheduled(tasks, {
      concurrency: 2,
      sleepFn: noSleep,
      onProgress: (_c, _t, _id, info) => { lastSucceeded = info.succeeded; },
    });

    expect(lastSucceeded).toBe(0);
    expect(result.results.size).toBe(0);
    expect(result.errors.size).toBe(4);
  });

  it('aucun échec → succeeded === completed (comportement nominal préservé)', async () => {
    const tasks: ScheduledTask<string>[] = [1, 2, 3].map((i) => ({
      id: `c${i}`,
      run: async () => `ok-${i}`,
    }));

    let last = { completed: 0, succeeded: 0, failed: 0 };
    await runScheduled(tasks, {
      concurrency: 2,
      sleepFn: noSleep,
      onProgress: (completed, _t, _id, info) => {
        last = { completed, succeeded: info.succeeded, failed: info.failed };
      },
    });

    expect(last).toEqual({ completed: 3, succeeded: 3, failed: 0 });
  });
});
