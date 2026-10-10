// ============================================================
// CodeMorph — TESTS JobsService.handleCallback (transitions de statut)
//
// Couvre (Objectif 5) :
//   • TEST 7 : un job terminé (DONE) n'est jamais ré-écrit par un callback
//              dupliqué ou tardif — résultat préservé
//   • Un callback de succès sur un job FAILED (livraison tardive après timeout
//     de dispatch) restaure le résultat : FAILED → DONE (transition cohérente)
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
  const aiEngineClient = {};
  const quotaService   = {
    setJobRepository:    jest.fn(),
    incrementConversions: jest.fn().mockResolvedValue(undefined),
  };
  const subscriptionSvc = { getUserPlan: jest.fn().mockResolvedValue('free') };
  const config          = { get: jest.fn() };

  const service = new JobsService(
    jobRepo as never,
    queueAdapter as never,
    aiEngineClient as never,
    quotaService as never,
    subscriptionSvc as never,
    config as never,
  );
  return { service, updateSpy: jobRepo.update };
}

describe('JobsService.handleCallback — transitions cohérentes', () => {
  it('TEST 7 : callback sur un job déjà DONE → ignoré, aucune ré-écriture du résultat', async () => {
    const { service, updateSpy } = makeService({
      id: 'job-done', userId: 'u1', status: JobStatus.DONE,
      result: { files: [{ path: 'preserved.tsx' }] },
    });

    await service.handleCallback('job-done', {
      success: true, filesGenerated: 5,
      result: { files: [{ path: 'duplicate.tsx' }] },
    });

    // Aucune mise à jour DB : le résultat existant est préservé tel quel
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('callback SUCCÈS tardif sur un job FAILED (dispatch timeout) → le résultat est livré (DONE)', async () => {
    const { service, updateSpy } = makeService({
      id: 'job-late', userId: 'u1', status: JobStatus.FAILED,
      errorMessage: 'AI Engine unreachable (timeout)',
    });

    await service.handleCallback('job-late', {
      success: true, filesGenerated: 12, linesGenerated: 900,
      result: { files: [] }, irDocument: { version: '1.0' },
    });

    expect(updateSpy).toHaveBeenCalled();
    const firstUpdate = updateSpy.mock.calls[0];
    expect(firstUpdate[0]).toBe('job-late');
    expect((firstUpdate[1] as { status: JobStatus }).status).toBe(JobStatus.DONE);
  });

  it('callback ÉCHEC sur un job CONVERTING → FAILED avec message du fournisseur préservé', async () => {
    const { service, updateSpy } = makeService({
      id: 'job-conv', userId: 'u1', status: JobStatus.CONVERTING,
    });

    await service.handleCallback('job-conv', {
      success: false,
      error: 'rate-limit: quota épuisé côté fournisseur (erreur explicite, pas de simulation)',
    });

    expect(updateSpy).toHaveBeenCalled();
    const firstUpdate = updateSpy.mock.calls[0];
    expect((firstUpdate[1] as { status: JobStatus }).status).toBe(JobStatus.FAILED);
    expect((firstUpdate[1] as { errorMessage?: string }).errorMessage)
      .toContain('quota épuisé');
  });
});
