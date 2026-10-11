// ============================================================
// CodeMorph — TESTS PHASE 39 : snapshot sources réutilisé entre tentatives
// ------------------------------------------------------------
// Objectif 8 : « Évite de télécharger et réanalyser inutilement les fichiers
// GitHub à chaque reprise si le résultat de cette étape peut être conservé
// sans compromettre la cohérence. »
//
// Couvre :
//   • tentative 0 → télécharge depuis GitHub
//   • tentative 1 (reprise après 429) → NE re-télécharge PAS, réutilise
//   • le payload envoyé à l'AI Engine est identique entre les deux tentatives
//   • job terminal (FAILED) → snapshot purgé (pas de rétention mémoire)
//   • ZIP_IMPORT bénéficie du même mécanisme
//   • la limite de fichiers du plan reste appliquée au snapshot mis en cache
// ============================================================
import { ConversionProcessorService, type ConversionJobPayload } from '../conversion-processor.service';
import { JobStatus, JobType }  from '../../modules/jobs/jobs.entity';
import { RetryableError }      from '../retryable.error';
import { sourceSnapshotCache } from '../source-snapshot-cache';

const REPO_FILES = Array.from({ length: 5 }, (_, i) => ({
  path:    `lib/screen_${i}.dart`,
  content: `class Screen${i} {}`,
}));

function makeMocks(fetchImpl?: jest.Mock) {
  const jobsService = {
    updateStatus:       jest.fn().mockResolvedValue(undefined),
    appendLog:          jest.fn().mockResolvedValue(undefined),
    findById:           jest.fn().mockResolvedValue({ id: 'job-snap', status: JobStatus.ANALYZING }),
    dispatchToAiEngine: jest.fn().mockResolvedValue('ai-job-1'),
    heartbeat:          jest.fn().mockResolvedValue(undefined),
  };
  const githubApiService = {
    fetchRepoFiles: fetchImpl ?? jest.fn().mockResolvedValue(REPO_FILES.map((f) => ({ ...f }))),
  };
  const uploadsService = { extractZipFiles: jest.fn().mockResolvedValue(REPO_FILES.map((f) => ({ ...f }))) };
  const quotaService = {
    checkAiRateLimit:        jest.fn().mockResolvedValue({ allowed: true, resetInSeconds: 0 }),
    incrementConversions:    jest.fn().mockResolvedValue(undefined),
    decrementConcurrentJobs: jest.fn().mockResolvedValue(undefined),
    rollbackAiRateLimit:     jest.fn().mockResolvedValue(undefined),
  };
  const subscriptionSvc = { getUserPlan: jest.fn().mockResolvedValue('pro') };

  const processor = new ConversionProcessorService(
    jobsService as never,
    githubApiService as never,
    uploadsService as never,
    quotaService as never,
    subscriptionSvc as never,
  );
  return { processor, jobsService, githubApiService, uploadsService, quotaService, subscriptionSvc };
}

function payload(type: JobType = JobType.GITHUB_IMPORT): ConversionJobPayload {
  return {
    jobId: 'job-snap',
    dto: {
      userId:         'user-1',
      type,
      sourceLanguage: 'flutter',
      targetLanguage: 'react-native',
      sourceRepo:     'org/app',
      sourceBranch:   'main',
      zipPath:        '/tmp/upload.zip',
    },
  };
}

describe('ConversionProcessorService — snapshot sources entre tentatives', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    sourceSnapshotCache.clear();
  });

  it('tentative 0 → télécharge depuis GitHub et met en cache', async () => {
    const { processor, githubApiService } = makeMocks();

    await processor.processConversionJob(payload(), { attemptsMade: 0, maxAttempts: 3 });

    expect(githubApiService.fetchRepoFiles).toHaveBeenCalledTimes(1);
    expect(sourceSnapshotCache.get('job-snap')).toHaveLength(REPO_FILES.length);
  });

  it('reprise après 429 → NE re-télécharge PAS GitHub (objectif 8)', async () => {
    const { processor, jobsService, githubApiService } = makeMocks();

    // Tentative 0 : 429 au dispatch → erreur réessayable, job reste actif.
    jobsService.dispatchToAiEngine.mockRejectedValueOnce(
      new RetryableError('AI Engine rate limited (429)', { kind: 'rate-limit', httpStatus: 429 }),
    );
    await expect(
      processor.processConversionJob(payload(), { attemptsMade: 0, maxAttempts: 3 }),
    ).rejects.toBeInstanceOf(RetryableError);
    expect(githubApiService.fetchRepoFiles).toHaveBeenCalledTimes(1);

    // Tentative 1 : succès. Aucun re-téléchargement.
    await processor.processConversionJob(payload(), { attemptsMade: 1, maxAttempts: 3 });

    expect(githubApiService.fetchRepoFiles).toHaveBeenCalledTimes(1); // ← toujours 1
    expect(jobsService.dispatchToAiEngine).toHaveBeenCalledTimes(2);
  });

  it('le payload envoyé à l\'AI Engine est identique entre les deux tentatives', async () => {
    const { processor, jobsService } = makeMocks();

    jobsService.dispatchToAiEngine.mockRejectedValueOnce(
      new RetryableError('AI Engine rate limited (429)', { kind: 'rate-limit', httpStatus: 429 }),
    );
    await expect(
      processor.processConversionJob(payload(), { attemptsMade: 0, maxAttempts: 3 }),
    ).rejects.toBeInstanceOf(RetryableError);
    await processor.processConversionJob(payload(), { attemptsMade: 1, maxAttempts: 3 });

    const first  = jobsService.dispatchToAiEngine.mock.calls[0][1];
    const second = jobsService.dispatchToAiEngine.mock.calls[1][1];
    expect(second).toEqual(first);
    expect(second).toHaveLength(REPO_FILES.length);
  });

  it('trois tentatives successives → un seul téléchargement GitHub', async () => {
    const { processor, jobsService, githubApiService } = makeMocks();

    jobsService.dispatchToAiEngine
      .mockRejectedValueOnce(new RetryableError('429', { kind: 'rate-limit', httpStatus: 429 }))
      .mockRejectedValueOnce(new RetryableError('503', { kind: 'server', httpStatus: 503 }));

    await expect(
      processor.processConversionJob(payload(), { attemptsMade: 0, maxAttempts: 3 }),
    ).rejects.toBeInstanceOf(RetryableError);
    await expect(
      processor.processConversionJob(payload(), { attemptsMade: 1, maxAttempts: 3 }),
    ).rejects.toBeInstanceOf(RetryableError);
    await processor.processConversionJob(payload(), { attemptsMade: 2, maxAttempts: 3 });

    expect(githubApiService.fetchRepoFiles).toHaveBeenCalledTimes(1);
    expect(jobsService.dispatchToAiEngine).toHaveBeenCalledTimes(3);
  });

  it('ZIP_IMPORT : l\'archive n\'est pas re-extraite à la reprise', async () => {
    const { processor, uploadsService } = makeMocks();

    await processor.processConversionJob(payload(JobType.ZIP_IMPORT), { attemptsMade: 0, maxAttempts: 3 });
    expect(uploadsService.extractZipFiles).toHaveBeenCalledTimes(1);

    await processor.processConversionJob(payload(JobType.ZIP_IMPORT), { attemptsMade: 1, maxAttempts: 3 });
    expect(uploadsService.extractZipFiles).toHaveBeenCalledTimes(1);
  });

  it('job terminal (tentatives épuisées) → snapshot purgé, plus de rétention mémoire', async () => {
    const { processor, jobsService } = makeMocks();
    jobsService.dispatchToAiEngine.mockRejectedValue(
      new RetryableError('429', { kind: 'rate-limit', httpStatus: 429 }),
    );

    await expect(
      processor.processConversionJob(payload(), { attemptsMade: 2, maxAttempts: 3 }),
    ).rejects.toBeInstanceOf(RetryableError);

    expect(sourceSnapshotCache.get('job-snap')).toBeUndefined();
    expect(sourceSnapshotCache.size).toBe(0);
    expect(jobsService.updateStatus).toHaveBeenCalledWith(
      'job-snap', JobStatus.FAILED, expect.objectContaining({ errorMessage: expect.any(String) }),
    );
  });

  it('la limite de fichiers du plan est appliquée AU snapshot mis en cache', async () => {
    const manyFiles = Array.from({ length: 60 }, (_, i) => ({
      path: `lib/s${i}.dart`, content: `class S${i} {}`,
    }));
    const { processor, jobsService, githubApiService, subscriptionSvc } = makeMocks(
      jest.fn().mockResolvedValue(manyFiles),
    );
    // plan `free` → maxFilesPerProject = 50
    subscriptionSvc.getUserPlan.mockResolvedValue('free');

    await processor.processConversionJob(payload(), { attemptsMade: 0, maxAttempts: 3 });

    expect(githubApiService.fetchRepoFiles).toHaveBeenCalledTimes(1);
    const cached = sourceSnapshotCache.get('job-snap') ?? [];
    const sent   = jobsService.dispatchToAiEngine.mock.calls[0][1] as unknown[];
    expect(cached.length).toBe(50);          // tronqué selon le plan
    expect(cached.length).toBe(sent.length); // le cache contient exactement ce qui est envoyé
  });
});
