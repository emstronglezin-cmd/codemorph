// ============================================================
// CodeMorph — TESTS PHASE 40 : problème C, progression réelle et monotone
// ------------------------------------------------------------
// CONSTAT : `dispatchToAiEngine()` passait à l'AI Engine
//   progressUrl = `${apiUrl}/jobs/${id}/progress`
// mais AUCUNE route de ce nom n'existait dans jobs.controller.ts — chaque POST
// de progression faisait 404, et ProgressReporter avalait l'erreur. Le job
// restait donc figé sur la valeur de `calculateProgress()`, une table statique
// où `ir-generation` vaut 50 : d'où le « bloqué à 50 % » avec filesGenerated=0.
//
// Ces tests couvrent la nouvelle `handleProgress()` : interpolation réelle dans
// la bande de la phase, MONOTONICITÉ, plafond 99, et jobs terminés ignorés.
// ============================================================
import { JobsService } from '../jobs.service';
import { JobStatus }   from '../jobs.entity';

function makeService(findOneResult: Record<string, unknown>): {
  service: JobsService;
  updateSpy: jest.Mock;
} {
  const jobRepo = {
    findOne:  jest.fn().mockResolvedValue(findOneResult),
    update:   jest.fn().mockResolvedValue({ affected: 1 }),
    find:     jest.fn().mockResolvedValue([]),
    save:     jest.fn(),
    create:   jest.fn(),
  };
  const queueAdapter   = { add: jest.fn(), providerName: 'memory' };
  const quotaService   = {
    setJobRepository:     jest.fn(),
    incrementConversions: jest.fn().mockResolvedValue(undefined),
  };
  const subscriptionSvc = { getUserPlan: jest.fn().mockResolvedValue('free') };
  const config          = { get: jest.fn().mockReturnValue('') };

  const service = new JobsService(
    jobRepo as never,
    queueAdapter as never,
    {} as never,
    quotaService as never,
    subscriptionSvc as never,
    config as never,
  );
  return { service, updateSpy: jobRepo.update };
}

const converting = (progress: number): Record<string, unknown> => ({
  id: 'job-p', userId: 'u1', status: JobStatus.CONVERTING, progress,
});

describe('JobsService.handleProgress — progression réelle (problème C)', () => {
  it('interpole dans la bande de la phase au lieu de rester figée à 50', async () => {
    const { service, updateSpy } = makeService(converting(50));

    // phase_3_ir = bande 50–65. 30/60 fichiers → milieu de bande.
    const out = await service.handleProgress('job-p', {
      phase: 'phase_3_ir', filesDone: 30, filesTotal: 60,
    });

    expect(out.progress).toBeGreaterThan(50);
    expect(out.progress).toBeLessThanOrEqual(65);
    expect((updateSpy.mock.calls[0][1] as { currentPhase: string }).currentPhase)
      .toBe('phase_3_ir');
  });

  it('la progression ne RECULE jamais, même sur un rapport tardif', async () => {
    const { service } = makeService(converting(88));

    // Un rapport retardé de phase_1_ast (bande 15–30) arrive après 88 %.
    const out = await service.handleProgress('job-p', {
      phase: 'phase_1_ast', filesDone: 1, filesTotal: 10,
    });

    expect(out.progress).toBe(88);
  });

  it('la progression est plafonnée à 99 : 100 est réservé au callback de succès', async () => {
    const { service } = makeService(converting(90));

    // validation = bande 90–99, terminé à 100 %.
    const out = await service.handleProgress('job-p', {
      phase: 'validation', filesDone: 10, filesTotal: 10,
    });

    expect(out.progress).toBe(99);
    expect(out.progress).toBeLessThan(100);
  });

  it('un job terminé (DONE) n\'est PAS ré-écrit par un rapport de progression', async () => {
    const { service, updateSpy } = makeService({
      id: 'job-p', userId: 'u1', status: JobStatus.DONE, progress: 100,
    });

    await service.handleProgress('job-p', { phase: 'phase_3_ir', filesDone: 1, filesTotal: 10 });

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('un job FAILED n\'est pas ressuscité par un rapport tardif', async () => {
    const { service, updateSpy } = makeService({
      id: 'job-p', userId: 'u1', status: JobStatus.FAILED, progress: 0,
    });

    await service.handleProgress('job-p', { phase: 'phase_3_ir', filesDone: 5, filesTotal: 10 });

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('filesTotal=0 (compteurs absents) ne produit pas de NaN ni de division par zéro', async () => {
    const { service, updateSpy } = makeService(converting(50));

    const out = await service.handleProgress('job-p', { phase: 'phase_2_arch' });

    expect(Number.isFinite(out.progress)).toBe(true);
    expect(out.progress).toBeGreaterThanOrEqual(30);
    expect(out.progress).toBeLessThanOrEqual(99);
    expect(updateSpy).toHaveBeenCalled();
  });

  it('une phase inconnue ne fait ni régresser ni exploser la progression', async () => {
    const { service } = makeService(converting(70));

    const out = await service.handleProgress('job-p', {
      phase: 'phase_inconnue', filesDone: 5, filesTotal: 10,
    });

    expect(out.progress).toBe(70);
  });

  it('la progression avance vraiment au fil des chunks (15/33 → 33/33)', async () => {
    const { service } = makeService(converting(65));
    const steps: number[] = [];

    // Reproduit le cas des logs : 33 chunks dans la phase de mapping (65–80).
    for (let i = 1; i <= 33; i++) {
      const r = await service.handleProgress('job-p', {
        phase: 'mapping', filesDone: i, filesTotal: 33,
      });
      steps.push(r.progress);
    }

    // Strictement croissante au fil des chunks, et jamais figée.
    expect(new Set(steps).size).toBeGreaterThan(1);
    expect(steps[steps.length - 1]).toBeGreaterThanOrEqual(65);
    expect(steps[steps.length - 1]).toBeLessThanOrEqual(80);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
  });
});
