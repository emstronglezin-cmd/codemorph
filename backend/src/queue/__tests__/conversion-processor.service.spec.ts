// ============================================================
// CodeMorph — TESTS ConversionProcessorService (cœur du fix retry)
//
// Couvre (Objectif 5) :
//   • TEST 2 : 429 sans Retry-After → backoff configuré, job reste ACTIF
//   • TEST 3 : un succès après un 429 → le job continue normalement
//   • TEST 4 : une erreur permanente n'est pas réessayée indéfiniment
//   • TEST 5 : un job n'est marqué FAILED qu'après épuisement des tentatives
//   • TEST 6 : les tentatives suivantes ne sont pas rejetées à cause d'un
//              FAILED prématuré (le job n'est JAMAIS FAILED avant épuisement)
//   • TEST 7 : les jobs terminés (DONE) ne sont pas exécutés une seconde fois
//   • TEST 9 : erreurs provider (429 retryable) vs permanentes (401) distinguées
// ============================================================
import { ConversionProcessorService, type ConversionJobPayload } from '../conversion-processor.service';
import { JobStatus, JobType } from '../../modules/jobs/jobs.entity';
import { NonRetryableError }  from '../non-retryable.error';
import { RetryableError }     from '../retryable.error';

// ── Fabrique de mocks ────────────────────────────────────────────────────────
function makeMocks() {
  const jobsService = {
    updateStatus:       jest.fn().mockResolvedValue(undefined),
    appendLog:          jest.fn().mockResolvedValue(undefined),
    findById:           jest.fn(),
    dispatchToAiEngine: jest.fn(),
    heartbeat:          jest.fn().mockResolvedValue(undefined),
  };
  const githubApiService = {
    fetchRepoFiles: jest.fn().mockResolvedValue([
      { path: 'lib/main.dart', content: 'void main() {}' },
    ]),
  };
  const uploadsService = { extractZipFiles: jest.fn() };
  const quotaService = {
    checkAiRateLimit:        jest.fn().mockResolvedValue({ allowed: true, resetInSeconds: 0 }),
    incrementConversions:    jest.fn().mockResolvedValue(undefined),
    decrementConcurrentJobs: jest.fn().mockResolvedValue(undefined),
    rollbackAiRateLimit:     jest.fn().mockResolvedValue(undefined),
  };
  const subscriptionSvc = { getUserPlan: jest.fn().mockResolvedValue('free') };

  const processor = new ConversionProcessorService(
    jobsService as never,
    githubApiService as never,
    uploadsService as never,
    quotaService as never,
    subscriptionSvc as never,
  );
  return { processor, jobsService, githubApiService, quotaService, subscriptionSvc };
}

function makePayload(): ConversionJobPayload {
  return {
    jobId: 'job-test-1',
    dto: {
      userId:         'user-1',
      type:           JobType.GITHUB_IMPORT,
      sourceLanguage: 'flutter',
      targetLanguage: 'react-native',
      sourceRepo:     'org/app',
      sourceBranch:   'main',
    },
  };
}

describe('ConversionProcessorService — gestion des erreurs et retries', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('TEST 2/6 : 429 réessayable à la tentative 1/3 → le job reste ACTIF (jamais FAILED)', async () => {
    const { processor, jobsService, quotaService } = makeMocks();
    jobsService.findById.mockResolvedValue({ id: 'job-test-1', status: JobStatus.ANALYZING });
    jobsService.dispatchToAiEngine.mockRejectedValue(
      new RetryableError('AI Engine rate limited (429): too many requests', {
        kind: 'rate-limit', httpStatus: 429, retryAfterMs: 30_000,
      }),
    );

    await expect(
      processor.processConversionJob(makePayload(), { attemptsMade: 0, maxAttempts: 3 }),
    ).rejects.toMatchObject({ retryable: true, httpStatus: 429 });

    // Le job n'est PAS marqué FAILED : la file retentera.
    const statusCalls = jobsService.updateStatus.mock.calls.map((c) => c[1] as JobStatus);
    expect(statusCalls).not.toContain(JobStatus.FAILED);
    // Dernier statut écrit : ANALYZING (état actif, en attente du retry)
    expect(statusCalls[statusCalls.length - 1]).toBe(JobStatus.ANALYZING);
    // Le quota AI consommé pour rien est restitué
    expect(quotaService.rollbackAiRateLimit).toHaveBeenCalled();
  });

  it('TEST 5 : 429 à la tentative 3/3 (épuisement) → le job est marqué FAILED seulement maintenant', async () => {
    const { processor, jobsService } = makeMocks();
    jobsService.findById.mockResolvedValue({ id: 'job-test-1', status: JobStatus.ANALYZING });
    jobsService.dispatchToAiEngine.mockRejectedValue(
      new RetryableError('AI Engine rate limited (429): too many requests', {
        kind: 'rate-limit', httpStatus: 429,
      }),
    );

    await expect(
      processor.processConversionJob(makePayload(), { attemptsMade: 2, maxAttempts: 3 }),
    ).rejects.toMatchObject({ retryable: true });

    const statusCalls = jobsService.updateStatus.mock.calls.map((c) => c[1] as JobStatus);
    expect(statusCalls).toContain(JobStatus.FAILED);
    // Une seule mise à jour FAILED (pas de double écriture)
    expect(statusCalls.filter((s) => s === JobStatus.FAILED)).toHaveLength(1);
    // Le message d'erreur du fournisseur est préservé (pas d'erreur générique)
    const failedCall = jobsService.updateStatus.mock.calls.find((c) => c[1] === JobStatus.FAILED);
    expect((failedCall?.[2] as { errorMessage?: string })?.errorMessage)
      .toContain('rate limited (429)');
  });

  it('TEST 3 : succès à la tentative 2 après un 429 → le job continue normalement (CONVERTING)', async () => {
    const { processor, jobsService, quotaService } = makeMocks();
    // Tentative 2 : le job est en ANALYZING (posé par le catch de la tentative 1)
    jobsService.findById.mockResolvedValue({ id: 'job-test-1', status: JobStatus.ANALYZING, userId: 'user-1' });
    jobsService.dispatchToAiEngine.mockResolvedValue('ai-engine-job-42');

    await processor.processConversionJob(makePayload(), { attemptsMade: 1, maxAttempts: 3 });

    // Dispatch réellement effectué et statut CONVERTING posé avec l'aiEngineJobId
    expect(jobsService.dispatchToAiEngine).toHaveBeenCalledTimes(1);
    const convertingCall = jobsService.updateStatus.mock.calls.find(
      (c) => c[1] === JobStatus.CONVERTING && (c[2] as { aiEngineJobId?: string } | undefined)?.aiEngineJobId === 'ai-engine-job-42',
    );
    expect(convertingCall).toBeDefined();
    // Jamais FAILED sur le chemin du succès
    expect(jobsService.updateStatus.mock.calls.map((c) => c[1])).not.toContain(JobStatus.FAILED);
    // Utilisation AI comptabilisée une seule fois après succès du dispatch
    expect(quotaService.incrementConversions).toHaveBeenCalledTimes(1);
  });

  it('TEST 4/9 : erreur permanente (401 provider) → FAILED immédiat, erreur non-réessayable propagée', async () => {
    const { processor, jobsService } = makeMocks();
    jobsService.findById.mockResolvedValue({ id: 'job-test-1', status: JobStatus.ANALYZING });
    jobsService.dispatchToAiEngine.mockRejectedValue(
      new NonRetryableError('AI Engine rejected dispatch (401): authentication refused.'),
    );

    await expect(
      processor.processConversionJob(makePayload(), { attemptsMade: 0, maxAttempts: 3 }),
    ).rejects.toBeInstanceOf(NonRetryableError);

    // Marqué FAILED immédiatement (erreur permanente) — une seule écriture FAILED
    const statusCalls = jobsService.updateStatus.mock.calls.map((c) => c[1] as JobStatus);
    expect(statusCalls.filter((s) => s === JobStatus.FAILED)).toHaveLength(1);
  });

  it('TEST 7 : un job déjà DONE refuse toute ré-exécution (résultat préservé)', async () => {
    const { processor, jobsService, githubApiService } = makeMocks();
    jobsService.findById.mockResolvedValue({ id: 'job-test-1', status: JobStatus.DONE });

    await expect(
      processor.processConversionJob(makePayload(), { attemptsMade: 1, maxAttempts: 3 }),
    ).rejects.toBeInstanceOf(NonRetryableError);

    // Aucun retraitement : ni fetch, ni dispatch, ni ré-écriture du statut
    expect(githubApiService.fetchRepoFiles).not.toHaveBeenCalled();
    expect(jobsService.dispatchToAiEngine).not.toHaveBeenCalled();
    expect(jobsService.updateStatus).not.toHaveBeenCalled();
  });

  it('TEST 6 : un job en ANALYZING (posé par un retry précédent) est retraité normalement', async () => {
    const { processor, jobsService } = makeMocks();
    jobsService.findById.mockResolvedValue({ id: 'job-test-1', status: JobStatus.ANALYZING, userId: 'user-1' });
    jobsService.dispatchToAiEngine.mockResolvedValue('ai-engine-job-99');

    await expect(
      processor.processConversionJob(makePayload(), { attemptsMade: 2, maxAttempts: 3 }),
    ).resolves.toBeUndefined();

    expect(jobsService.dispatchToAiEngine).toHaveBeenCalledTimes(1);
  });

  it('quota AI épuisé → erreur réessayable avec le délai de reset (pas de FAILED immédiat)', async () => {
    const { processor, jobsService, quotaService } = makeMocks();
    quotaService.checkAiRateLimit.mockResolvedValue({ allowed: false, resetInSeconds: 42 });

    let caught: unknown;
    try {
      await processor.processConversionJob(makePayload(), { attemptsMade: 0, maxAttempts: 3 });
    } catch (e) {
      caught = e;
    }

    expect(caught).toMatchObject({ retryable: true, retryAfterMs: 42_000, kind: 'quota-window' });
    // Le compteur incrémenté à tort est restitué
    expect(quotaService.rollbackAiRateLimit).toHaveBeenCalled();
    // Aucun FAILED : la file retentera après le reset de fenêtre
    expect(jobsService.updateStatus.mock.calls.map((c) => c[1])).not.toContain(JobStatus.FAILED);
  });
});
