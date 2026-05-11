// ============================================================
// CodeMorph — Jobs Processor (Bull, AiEngineClient + Quota)
// ============================================================
import { Process, Processor, OnQueueFailed, OnQueueCompleted } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job }    from 'bull';

import { JobsService }      from './jobs.service';
import { JobStatus, JobType } from './jobs.entity';
import { AiEngineClient }   from './ai-engine.client';
import { GitHubApiService } from '../github/github-api.service';
import { UploadsService }   from '../uploads/uploads.service';
import { QuotaService }     from '../quota/quota.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { PLAN_LIMITS }      from '../subscription/plan-limits.config';

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
    private readonly aiEngineClient:    AiEngineClient,
    private readonly githubApiService:  GitHubApiService,
    private readonly uploadsService:    UploadsService,
    private readonly quotaService:      QuotaService,
    private readonly subscriptionSvc:   SubscriptionService,
  ) {}

  // ── Main processor ────────────────────────────────────
  @Process('run-conversion')
  async handleConversion(job: Job<ConversionJobPayload>): Promise<void> {
    const { jobId, dto } = job.data;
    this.logger.log(`[Job ${jobId}] Processing — type=${dto.type}`);

    // Get user plan for limits
    const plan   = await this.subscriptionSvc.getUserPlan(dto.userId);
    const limits = PLAN_LIMITS[plan];

    try {
      // ── Phase 1: Fetch source files ──────────────────
      await this.jobsService.updateStatus(jobId, JobStatus.ANALYZING);
      await this.jobsService.appendLog(jobId, 'ast-analysis', 'running', 'Fetching source files…');

      let files: Array<{ path: string; content: string }> = [];

      if (dto.type === JobType.GITHUB_IMPORT && dto.sourceRepo) {
        files = await this.githubApiService.fetchRepoFiles(
          dto.sourceRepo,
          dto.sourceBranch ?? 'main',
          dto.userId,
        );
        // Enforce per-plan file count limit
        if (limits.maxFilesPerProject > 0 && files.length > limits.maxFilesPerProject) {
          files = files.slice(0, limits.maxFilesPerProject);
          this.logger.warn(
            `[Job ${jobId}] Truncated to ${limits.maxFilesPerProject} files (plan limit)`,
          );
        }
        await this.jobsService.appendLog(
          jobId, 'ast-analysis', 'done',
          `Fetched ${files.length} files from GitHub`,
        );
      } else if (dto.type === JobType.ZIP_IMPORT && dto.zipPath) {
        files = await this.uploadsService.extractZipFiles(dto.zipPath);
        if (limits.maxFilesPerProject > 0 && files.length > limits.maxFilesPerProject) {
          files = files.slice(0, limits.maxFilesPerProject);
        }
        await this.jobsService.appendLog(
          jobId, 'ast-analysis', 'done',
          `Extracted ${files.length} files from ZIP`,
        );
      }

      if (files.length === 0) {
        throw new Error('No source files found. Check repository access or ZIP contents.');
      }

      // ── Phase 2: Check AI rate limit ─────────────────
      const aiRateOk = await this.quotaService.checkAiRateLimit(dto.userId, plan);
      if (!aiRateOk.allowed) {
        await this.jobsService.appendLog(
          jobId, 'ir-generation', 'waiting',
          `AI rate limit reached. Resets in ${aiRateOk.resetInSeconds}s…`,
        );
        // Exponential backoff — job will be retried by Bull
        throw new Error(`AI_RATE_LIMIT:${aiRateOk.resetInSeconds}`);
      }

      // ── Phase 3: Dispatch to AI Engine ───────────────
      await this.jobsService.updateStatus(jobId, JobStatus.CONVERTING);
      await this.jobsService.appendLog(
        jobId, 'ir-generation', 'running',
        `Dispatching ${files.length} files to AI Engine (plan=${plan})…`,
      );

      const dbJob   = await this.jobsService.findById(jobId);
      const aiJobId = await this.jobsService.dispatchToAiEngine(dbJob, files, dto.goalPrompt);

      await this.jobsService.updateStatus(jobId, JobStatus.CONVERTING, { aiEngineJobId: aiJobId });
      await this.jobsService.appendLog(
        jobId, 'ir-generation', 'running',
        `AI Engine job ${aiJobId} started — awaiting callback`,
      );

      this.logger.log(`[Job ${jobId}] Dispatched to AI Engine as ${aiJobId}`);

      // Update AI usage quota
      await this.quotaService.incrementConversions(dto.userId, plan);

    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`[Job ${jobId}] Failed: ${message}`);

      // Decrement concurrent counter on failure
      try {
        await this.quotaService.decrementConcurrentJobs(dto.userId, plan);
      } catch {
        // ignore
      }

      await this.jobsService.updateStatus(jobId, JobStatus.FAILED, {
        errorMessage: message,
        errorDetails: { stack: (err as Error).stack },
      });

      // Re-throw so Bull records the failure and triggers retry
      throw err;
    }
  }

  // ── Bull hooks ────────────────────────────────────────
  @OnQueueFailed()
  onFailed(job: Job<ConversionJobPayload>, err: Error): void {
    this.logger.error(
      `[Queue] Job ${job.data.jobId} failed after ${job.attemptsMade} attempts: ${err.message}`,
    );
  }

  @OnQueueCompleted()
  onCompleted(job: Job<ConversionJobPayload>): void {
    this.logger.log(`[Queue] Job ${job.data.jobId} completed successfully`);
  }
}
