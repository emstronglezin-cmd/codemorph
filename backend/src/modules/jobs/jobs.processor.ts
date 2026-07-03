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
  // FIX PHASE 11 — BUG 2 (STEP logs) :
  // Chaque étape du worker est loggée avec un numéro STEP 5→10
  // pour traçabilité complète dans les logs Render.
  @Process('run-conversion')
  async handleConversion(job: Job<ConversionJobPayload>): Promise<void> {
    const { jobId, dto } = job.data;
    const tag = `[Job ${jobId}]`;

    this.logger.log(`━━━ ${tag} STEP 5 ━━━ Worker picked up job from Bull queue`);
    this.logger.log(
      `${tag} type=${dto.type} src=${dto.sourceLanguage} tgt=${dto.targetLanguage} ` +
      `userId=${dto.userId} attempt=${job.attemptsMade + 1}`,
    );

    // Get user plan for limits
    // FIX PHASE 12 : getPlanLimits() gère les aliases (starter→pro)
    // PLAN_LIMITS[plan] retourne undefined si plan='starter' → TypeError crash
    const plan   = await this.subscriptionSvc.getUserPlan(dto.userId);
    const limits = getPlanLimits(plan);
    this.logger.log(`${tag} Plan: ${plan} | maxFiles: ${limits.maxFilesPerProject} | priority: ${limits.queuePriority} | advancedFrameworks: ${limits.advancedFrameworks}`);

    try {
      // ── Phase 1: Fetch source files ──────────────────────
      // FIX PHASE 9 — CAUSE RACINE BUG 1 (race condition Bull retry):
      // Bull retente ce handler jusqu'à 3 fois (attempts:3, backoff exponential).
      // À chaque retry, updateStatus(ANALYZING) remettait le job en statut ACTIF,
      // même s'il avait été marqué FAILED au précédent attempt.
      // countActiveJobsFromDb() comptait alors ce job comme actif → CONCURRENT_LIMIT.
      //
      // Fix: ne pas écraser le statut si c'est un retry (attemptsMade > 0)
      // ET que le job est déjà FAILED (évite de le compter comme actif entre les attempts).
      this.logger.log(`━━━ ${tag} STEP 6 ━━━ Fetching source files (type=${dto.type}) attempt=${job.attemptsMade + 1}…`);
      if (job.attemptsMade === 0) {
        // Premier attempt → passer en ANALYZING (normal)
        await this.jobsService.updateStatus(jobId, JobStatus.ANALYZING);
      } else {
        // FIX PHASE 10 — Retry : ne PAS remettre en ANALYZING si job déjà terminal
        // CAUSE RACINE BUG 1 (Phase 9 incomplet) :
        // L'ancien code loggait "skipping re-activation" PUIS appelait quand même
        // updateStatus(ANALYZING), repassant le job en statut actif.
        // countActiveJobsFromDb() le comptait → CONCURRENT_LIMIT au prochain createJob().
        //
        // Fix: si FAILED ou DONE → throw immédiatement pour que Bull enregistre l'échec
        // sans toucher le statut DB. Le job reste terminal et ne bloque plus le quota.
        const currentJob = await this.jobsService.findById(jobId);
        if (currentJob.status === JobStatus.FAILED || currentJob.status === JobStatus.DONE) {
          this.logger.warn(
            `${tag} Retry ${job.attemptsMade + 1}: job already terminal (${currentJob.status}). ` +
            `Aborting retry without touching DB status — job will NOT be reactivated.`,
          );
          // Ne pas appeler updateStatus → le job reste FAILED/DONE dans la DB
          // Bull enregistre cet attempt comme échoué mais le statut DB est préservé
          throw new Error(
            `Job ${jobId} is already in terminal status (${currentJob.status}). ` +
            `Retry aborted to prevent false-active quota count.`,
          );
        }
        // Retry sur un job encore en cours → reprendre normalement
        await this.jobsService.updateStatus(jobId, JobStatus.ANALYZING);
      }
      await this.jobsService.appendLog(jobId, 'ast-analysis', 'running', `Fetching source files… (attempt ${job.attemptsMade + 1})`);

      let files: Array<{ path: string; content: string }> = [];

      if (dto.type === JobType.GITHUB_IMPORT) {
        // ── GitHub import ──
        if (!dto.sourceRepo) {
          throw new Error('GITHUB_IMPORT: sourceRepo is required but was not provided.');
        }
        this.logger.log(`${tag} GitHub import: repo=${dto.sourceRepo} branch=${dto.sourceBranch ?? 'main'}`);

        await this.jobsService.appendLog(
          jobId, 'ast-analysis', 'running',
          `Fetching files from GitHub: ${dto.sourceRepo}@${dto.sourceBranch ?? 'main'}…`,
        );

        this.logger.log(`━━━ ${tag} STEP 7 ━━━ Cloning/fetching GitHub repo: ${dto.sourceRepo}@${dto.sourceBranch ?? 'main'}…`);
        files = await this.githubApiService.fetchRepoFiles(
          dto.sourceRepo,
          dto.sourceBranch ?? 'main',
          dto.userId,
        );

        this.logger.log(`━━━ ${tag} STEP 7 ✓ ━━━ GitHub: fetched ${files.length} files from ${dto.sourceRepo}`);

        // Enforce per-plan file count limit
        if (limits.maxFilesPerProject > 0 && files.length > limits.maxFilesPerProject) {
          this.logger.warn(`${tag} Truncating to ${limits.maxFilesPerProject} files (plan limit)`);
          files = files.slice(0, limits.maxFilesPerProject);
        }

        await this.jobsService.appendLog(
          jobId, 'ast-analysis', 'done',
          `Fetched ${files.length} files from GitHub (${dto.sourceRepo})`,
        );

      } else if (dto.type === JobType.ZIP_IMPORT || dto.type === JobType.URL_IMPORT) {
        // ── ZIP import (local upload) or URL import (downloaded ZIP) ──
        if (!dto.zipPath) {
          throw new Error(`${dto.type}: zipPath is required but was not provided.`);
        }
        const importLabel = dto.type === JobType.URL_IMPORT ? 'URL download' : 'ZIP upload';
        this.logger.log(`${tag} ${importLabel}: extracting from ${dto.zipPath}`);

        await this.jobsService.appendLog(
          jobId, 'ast-analysis', 'running',
          `Extracting files from ${importLabel}…`,
        );

        files = await this.uploadsService.extractZipFiles(dto.zipPath);

        this.logger.log(`${tag} ${importLabel}: extracted ${files.length} files`);

        if (limits.maxFilesPerProject > 0 && files.length > limits.maxFilesPerProject) {
          this.logger.warn(`${tag} Truncating to ${limits.maxFilesPerProject} files (plan limit)`);
          files = files.slice(0, limits.maxFilesPerProject);
        }

        await this.jobsService.appendLog(
          jobId, 'ast-analysis', 'done',
          `Extracted ${files.length} code files from ${importLabel}`,
        );

      } else {
        throw new Error(`Unsupported job type: ${dto.type}. Expected: github_import, zip_import, url_import.`);
      }

      // Guard: no files found
      if (files.length === 0) {
        throw new Error(
          'No source files found after import. ' +
          'For GitHub: check repository access and that the repo contains code files. ' +
          'For ZIP: ensure the archive contains .ts/.js/.dart/.py files outside node_modules/.',
        );
      }

      this.logger.log(`━━━ ${tag} STEP 8 ━━━ Source analysis ready: ${files.length} files to convert`);

      // ── Phase 2: Check AI rate limit ──────────────────────
      this.logger.log(`${tag} Phase 2/3: Checking AI rate limit (plan=${plan})…`);
      const aiRateOk = await this.quotaService.checkAiRateLimit(dto.userId, plan);
      if (!aiRateOk.allowed) {
        const msg = `AI rate limit reached. Your plan allows ${limits.aiRequestsPerHour} AI requests/hour. Resets in ${aiRateOk.resetInSeconds}s.`;
        this.logger.warn(`${tag} ${msg}`);
        await this.jobsService.appendLog(jobId, 'ir-generation', 'waiting', msg);
        // Bull will retry after backoff
        throw new Error(`AI_RATE_LIMIT:${aiRateOk.resetInSeconds}`);
      }
      this.logger.log(`${tag} AI rate limit: OK`);

      // ── Phase 3: Dispatch to AI Engine ────────────────────
      this.logger.log(`━━━ ${tag} STEP 9 ━━━ Dispatching to AI Engine (${dto.sourceLanguage} → ${dto.targetLanguage})…`);
      await this.jobsService.updateStatus(jobId, JobStatus.CONVERTING);
      await this.jobsService.appendLog(
        jobId, 'ir-generation', 'running',
        `Dispatching ${files.length} files to AI Engine (${dto.sourceLanguage} → ${dto.targetLanguage}, plan=${plan})…`,
      );

      const dbJob   = await this.jobsService.findById(jobId);
      const aiJobId = await this.jobsService.dispatchToAiEngine(dbJob, files, dto.goalPrompt);

      await this.jobsService.updateStatus(jobId, JobStatus.CONVERTING, { aiEngineJobId: aiJobId });
      await this.jobsService.appendLog(
        jobId, 'ir-generation', 'running',
        `AI Engine job ${aiJobId} started — awaiting callback…`,
      );

      this.logger.log(`━━━ ${tag} STEP 9 ✓ ━━━ Dispatched to AI Engine as ${aiJobId} — awaiting callback…`);
      this.logger.log(`━━━ ${tag} STEP 10 ━━━ Job is now CONVERTING — callback will update status to DONE or FAILED`);

      // Track AI usage quota
      await this.quotaService.incrementConversions(dto.userId, plan);

    } catch (err) {
      const error   = err as Error;
      const message = error.message ?? 'Unknown processing error';
      this.logger.error(`${tag} ❌ FAILED: ${message}`, error.stack);

      // Decrement concurrent counter on failure
      try {
        await this.quotaService.decrementConcurrentJobs(dto.userId, plan);
      } catch {
        // ignore quota decrement failure
      }

      // Persist failure with full details
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

      // Re-throw so Bull records the failure and triggers retry
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
