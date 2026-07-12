// ============================================================
// CodeMorph — Jobs Processor (Bull, AiEngineClient + Quota)
// FIX: URL_IMPORT géré (même flux que ZIP après download)
// FIX: Logs détaillés à chaque étape
// FIX: Erreurs non masquées — cause racine toujours propagée
// ============================================================
import { Process, Processor, OnQueueFailed, OnQueueCompleted } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job }    from 'bull';

import { JobsService }         from './jobs.service';
import { JobStatus, JobType }  from './jobs.entity';
import { GitHubApiService }    from '../github/github-api.service';
import { UploadsService }      from '../uploads/uploads.service';
import { QuotaService }        from '../quota/quota.service';
import { SubscriptionService } from '../subscription/subscription.service';
// FIX PHASE 12 — BUG CRITIQUE 2 : getPlanLimits() au lieu de PLAN_LIMITS[plan]
// PLAN_LIMITS['starter'] = undefined → TypeError: Cannot read properties of undefined
// getPlanLimits() gère starter→pro alias, retourne toujours PlanLimits valide
import { getPlanLimits } from '../subscription/plan-limits.config';

interface ConversionJobPayload {
  jobId: string;
  dto: {
    userId:         string;
    type:           JobType;
    sourceLanguage: string;
    targetLanguage: string;
    sourceRepo?:    string;
    sourceBranch?:  string;
    zipPath?:       string;
    goalPrompt?:    string;
  };
}

@Processor('conversion')
export class JobsProcessor {
  private readonly logger = new Logger(JobsProcessor.name);

  constructor(
    private readonly jobsService:       JobsService,
    private readonly githubApiService:  GitHubApiService,
    private readonly uploadsService:    UploadsService,
    private readonly quotaService:      QuotaService,
    private readonly subscriptionSvc:   SubscriptionService,
  ) {}

  // ── Main processor ────────────────────────────────────
  @Process('run-conversion')
  async handleConversion(job: Job<ConversionJobPayload>): Promise<void> {
    const { jobId, dto } = job.data;
    const tag = `[Job ${jobId}]`;

    this.logger.log(`[PIPELINE] Worker started — jobId=${jobId} type=${dto.type} attempt=${job.attemptsMade + 1}`);
    this.logger.log(`${tag} src=${dto.sourceLanguage} tgt=${dto.targetLanguage} userId=${dto.userId}`);

    // Get user plan for limits
    const plan   = await this.subscriptionSvc.getUserPlan(dto.userId);
    const limits = getPlanLimits(plan);
    this.logger.log(`${tag} plan=${plan} maxFiles=${limits.maxFilesPerProject}`);

    try {
      // ── Phase 1: Status → ANALYZING ─────────────────────
      if (job.attemptsMade === 0) {
        await this.jobsService.updateStatus(jobId, JobStatus.ANALYZING);
      } else {
        const currentJob = await this.jobsService.findById(jobId);
        if (currentJob.status === JobStatus.FAILED || currentJob.status === JobStatus.DONE) {
          this.logger.warn(
            `${tag} Retry ${job.attemptsMade + 1}: job already terminal (${currentJob.status}). Aborting.`,
          );
          throw new Error(
            `Job ${jobId} is already in terminal status (${currentJob.status}). Retry aborted.`,
          );
        }
        await this.jobsService.updateStatus(jobId, JobStatus.ANALYZING);
      }
      await this.jobsService.appendLog(jobId, 'ast-analysis', 'running', `Fetching source files… (attempt ${job.attemptsMade + 1})`);

      // ── Phase 2: Fetch source files ──────────────────────
      let files: Array<{ path: string; content: string }> = [];

      if (dto.type === JobType.GITHUB_IMPORT) {
        if (!dto.sourceRepo) throw new Error('GITHUB_IMPORT: sourceRepo is required.');
        this.logger.log(`[PIPELINE] Fetching GitHub repo: ${dto.sourceRepo}@${dto.sourceBranch ?? 'main'}`);
        await this.jobsService.appendLog(jobId, 'ast-analysis', 'running',
          `Fetching files from GitHub: ${dto.sourceRepo}@${dto.sourceBranch ?? 'main'}…`);

        files = await this.githubApiService.fetchRepoFiles(
          dto.sourceRepo, dto.sourceBranch ?? 'main', dto.userId,
        );
        this.logger.log(`[PIPELINE] GitHub files fetched: ${files.length} files`);

      } else if (dto.type === JobType.ZIP_IMPORT || dto.type === JobType.URL_IMPORT) {
        if (!dto.zipPath) throw new Error(`${dto.type}: zipPath is required.`);
        const label = dto.type === JobType.URL_IMPORT ? 'URL download' : 'ZIP upload';
        this.logger.log(`[PIPELINE] ZIP extracted — path=${dto.zipPath} type=${label}`);
        await this.jobsService.appendLog(jobId, 'ast-analysis', 'running', `Extracting files from ${label}…`);

        files = await this.uploadsService.extractZipFiles(dto.zipPath);
        this.logger.log(`[PIPELINE] Files loaded: ${files.length} files extracted from ${label}`);

      } else {
        throw new Error(`Unsupported job type: ${dto.type}.`);
      }

      // Apply plan file limit
      if (limits.maxFilesPerProject > 0 && files.length > limits.maxFilesPerProject) {
        this.logger.warn(`${tag} Truncating to ${limits.maxFilesPerProject} files (plan limit)`);
        files = files.slice(0, limits.maxFilesPerProject);
      }

      await this.jobsService.appendLog(jobId, 'ast-analysis', 'done',
        `Loaded ${files.length} source files`);

      if (files.length === 0) {
        throw new Error(
          'No source files found after import. ' +
          'For GitHub: check repo access and that it contains code files. ' +
          'For ZIP: ensure the archive contains .ts/.js/.dart files outside node_modules/.',
        );
      }

      // ── Phase 3: AI rate limit check ─────────────────────
      const aiRateOk = await this.quotaService.checkAiRateLimit(dto.userId, plan);
      if (!aiRateOk.allowed) {
        const msg = `AI rate limit reached. Your plan allows ${limits.aiRequestsPerHour} AI requests/hour. Resets in ${aiRateOk.resetInSeconds}s.`;
        await this.jobsService.appendLog(jobId, 'ir-generation', 'waiting', msg);
        throw new Error(`AI_RATE_LIMIT:${aiRateOk.resetInSeconds}`);
      }

      // ── Phase 4: Dispatch to AI Engine ────────────────────
      this.logger.log(`[PIPELINE] AI request sent — ${files.length} files, ${dto.sourceLanguage}→${dto.targetLanguage}`);
      await this.jobsService.updateStatus(jobId, JobStatus.CONVERTING);
      await this.jobsService.appendLog(jobId, 'ir-generation', 'running',
        `Dispatching ${files.length} files to AI Engine (${dto.sourceLanguage}→${dto.targetLanguage}, plan=${plan})…`);

      const dbJob   = await this.jobsService.findById(jobId);
      const aiJobId = await this.jobsService.dispatchToAiEngine(dbJob, files, dto.goalPrompt);

      await this.jobsService.updateStatus(jobId, JobStatus.CONVERTING, { aiEngineJobId: aiJobId });
      await this.jobsService.appendLog(jobId, 'ir-generation', 'running',
        `AI Engine job ${aiJobId} started — awaiting callback…`);

      this.logger.log(`[PIPELINE] AI response received — aiJobId=${aiJobId}, awaiting callback`);

      // Track AI usage quota
      await this.quotaService.incrementConversions(dto.userId, plan);

    } catch (err) {
      const error   = err as Error;
      const message = error.message ?? 'Unknown processing error';
      this.logger.error(`[PIPELINE] FAILED at jobId=${jobId}: ${message}`, error.stack);

      try {
        await this.quotaService.decrementConcurrentJobs(dto.userId, plan);
      } catch { /* ignore */ }

      await this.jobsService.updateStatus(jobId, JobStatus.FAILED, {
        errorMessage: message,
        errorDetails: {
          stack:     error.stack,
          type:      dto.type,
          attempt:   job.attemptsMade + 1,
          timestamp: new Date().toISOString(),
        },
      });
      await this.jobsService.appendLog(jobId, 'failed', 'failed', `Job failed: ${message}`);

      throw err;
    }
  }

  // ── Bull hooks ────────────────────────────────────────
  @OnQueueFailed()
  onFailed(job: Job<ConversionJobPayload>, err: Error): void {
    this.logger.error(
      `[Queue] Job ${job.data.jobId} failed after ${job.attemptsMade} attempt(s): ${err.message}`,
    );
  }

  @OnQueueCompleted()
  onCompleted(job: Job<ConversionJobPayload>): void {
    this.logger.log(`[Queue] Job ${job.data.jobId} ✅ completed successfully`);
  }
}
