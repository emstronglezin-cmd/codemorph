// ============================================================
// CodeMorph — Jobs Service
// PHASE 7 FIX:
//   - Concurrent count basé sur la DB (plus de compteur Redis/mem)
//   - Stale job auto-cleanup au démarrage et via scheduler
//   - jobRepo injecté dans QuotaService (source de vérité DB)
//   - dispatchToAiEngine: correction retour AiConvertResponse
//   - Logs détaillés à chaque étape
// PHASE 11 FIX:
//   - CONVERTING jobs watchdog séparé : seuil 5min (au lieu de 15min)
//   - Un job CONVERTING zombie depuis >5min → FAILED automatiquement
//   - Après crash Render : tous les CONVERTING → FAILED au démarrage
// ============================================================
import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, LessThan } from 'typeorm';
import { InjectQueue }       from '@nestjs/bull';
import { Queue }             from 'bull';
import { ConfigService }     from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import { JobEntity, JobStatus, JobType } from './jobs.entity';
import { AiEngineClient }                from './ai-engine.client';
import { QuotaService, STALE_JOB_MINUTES } from '../quota/quota.service';

// FIX PHASE 11 — WATCHDOG CONVERTING
// Un job PENDING/ANALYZING sans activité > 15min → FAILED (existant)
// Un job CONVERTING sans activité > 5min → FAILED (nouveau)
// Raison: CONVERTING = mock callback en transit (3-5s en théorie).
// Si >5min → le callback a échoué silencieusement → zombie job.
const CONVERTING_STALE_MINUTES = 5;
import { SubscriptionService }           from '../subscription/subscription.service';
import { PLAN_LIMITS }                   from '../subscription/plan-limits.config';

export interface StartConversionDto {
  projectId?:     string;
  userId:         string;
  type:           JobType;
  sourceLanguage: string;
  targetLanguage: string;
  sourceRepo?:    string;
  sourceBranch?:  string;
  zipPath?:       string;
  goalPrompt?:    string;
}

// Statuts considérés comme "actifs" (bloquant le quota concurrent)
const ACTIVE_STATUSES = [JobStatus.PENDING, JobStatus.ANALYZING, JobStatus.CONVERTING];

@Injectable()
export class JobsService implements OnModuleInit {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    @InjectRepository(JobEntity)
    private readonly jobRepo: Repository<JobEntity>,

    @InjectQueue('conversion')
    private readonly conversionQueue: Queue,

    private readonly aiEngineClient:  AiEngineClient,
    private readonly quotaService:    QuotaService,
    private readonly subscriptionSvc: SubscriptionService,
    private readonly config:          ConfigService,
  ) {}

  // ── Module init: injecter jobRepo dans QuotaService ───
  onModuleInit(): void {
    // Donne à QuotaService la capacité de compter les jobs actifs
    // directement depuis la DB — source de vérité unique
    this.quotaService.setJobRepository(this.jobRepo as any);
    this.logger.log('JobsService: QuotaService jobRepo injected ✓');

    // FIX PHASE 11 — WATCHDOG DÉMARRAGE :
    // Après un crash/restart Render, TOUS les jobs CONVERTING sont des zombies
    // (leurs setTimeout mock ont été perdus). On les marque FAILED immédiatement.
    void this.cleanupConvertingZombiesOnStartup();
    // Nettoyage classique (PENDING/ANALYZING > 15min)
    void this.cleanupStaleJobs();
  }

  // ── Startup cleanup: mark all CONVERTING as FAILED ───
  // FIX PHASE 11 — CAUSE RACINE ZOMBIE JOBS :
  // Après un restart Render/crash, les jobs CONVERTING ne recevront
  // jamais leur callback (le setTimeout du mock a été perdu avec le process).
  // On les marque FAILED immédiatement au démarrage pour éviter le blocage.
  private async cleanupConvertingZombiesOnStartup(): Promise<void> {
    try {
      const convertingJobs = await this.jobRepo.find({
        where: { status: JobStatus.CONVERTING },
        select: ['id', 'userId', 'status', 'updatedAt'],
      });

      if (convertingJobs.length === 0) {
        this.logger.log('[StartupCleanup] No CONVERTING zombie jobs found ✓');
        return;
      }

      this.logger.warn(
        `[StartupCleanup] Found ${convertingJobs.length} CONVERTING job(s) after restart — marking FAILED (zombie prevention): ` +
        convertingJobs.map(j => j.id).join(', '),
      );

      for (const job of convertingJobs) {
        await this.jobRepo.update(job.id, {
          status:       JobStatus.FAILED,
          errorMessage: `Job auto-failed on server restart: the conversion was in progress when the server crashed. ` +
                        `The AI Engine callback was lost. Please retry your conversion.`,
          errorDetails: {
            reason:    'server_restart_zombie',
            lastStatus: 'converting',
            clearedAt: new Date().toISOString(),
            hint:      'This happens when Render restarts the backend (free tier sleep). Retry the conversion.',
          },
          completedAt: new Date(),
        });
        this.logger.warn(`[StartupCleanup] Job ${job.id} (CONVERTING) → FAILED (zombie cleared)`);
      }
    } catch (e) {
      this.logger.error(`[StartupCleanup] Error: ${(e as Error).message}`);
    }
  }

  // ── Stale job cleanup (scheduled every 5 minutes) ────
  // FIX PHASE 11 — WATCHDOG AMÉLIORÉ :
  // Deux seuils distincts :
  //   1. CONVERTING jobs > 5min sans mise à jour → FAILED (zombie callback perdu)
  //   2. PENDING/ANALYZING jobs > 15min sans mise à jour → FAILED (worker crashé)
  @Cron(CronExpression.EVERY_5_MINUTES)
  async cleanupStaleJobs(): Promise<void> {
    const now = Date.now();
    const convertingStaleThreshold = new Date(now - CONVERTING_STALE_MINUTES * 60 * 1000);
    const generalStaleThreshold    = new Date(now - STALE_JOB_MINUTES * 60 * 1000);

    try {
      // ── 1. CONVERTING zombie watchdog (seuil court : 5min) ──
      const convertingZombies = await this.jobRepo.find({
        where: {
          status:    JobStatus.CONVERTING,
          updatedAt: LessThan(convertingStaleThreshold),
        },
        select: ['id', 'userId', 'status', 'updatedAt', 'type'],
      });

      if (convertingZombies.length > 0) {
        this.logger.warn(
          `[Watchdog] Found ${convertingZombies.length} CONVERTING zombie job(s) (inactive >${CONVERTING_STALE_MINUTES}min): ` +
          convertingZombies.map(j => `${j.id}`).join(', '),
        );
        for (const job of convertingZombies) {
          await this.jobRepo.update(job.id, {
            status:       JobStatus.FAILED,
            errorMessage: `Job automatically failed: stuck in CONVERTING state for more than ${CONVERTING_STALE_MINUTES} minutes. ` +
                          `The AI Engine callback was never received. This typically means: ` +
                          `(1) the server restarted and the mock callback setTimeout was lost, or ` +
                          `(2) the callback URL was unreachable. Please retry your conversion.`,
            errorDetails: {
              reason:           'converting_zombie_watchdog',
              lastStatus:       job.status,
              staleThresholdMin: CONVERTING_STALE_MINUTES,
              detectedAt:       new Date().toISOString(),
            },
            completedAt: new Date(),
          });
          this.logger.warn(`[Watchdog] Job ${job.id} (CONVERTING zombie) → FAILED ✓`);
        }
      }

      // ── 2. PENDING/ANALYZING stale cleanup (seuil standard : 15min) ──
      const staleJobs = await this.jobRepo.find({
        where: {
          status:    In([JobStatus.PENDING, JobStatus.ANALYZING]),
          updatedAt: LessThan(generalStaleThreshold),
        },
        select: ['id', 'userId', 'status', 'updatedAt', 'type'],
      });

      if (staleJobs.length === 0 && convertingZombies.length === 0) {
        return; // Nothing to clean
      }

      if (staleJobs.length > 0) {
        this.logger.warn(
          `[StaleCleanup] Found ${staleJobs.length} stale job(s) (inactive >${STALE_JOB_MINUTES}min): ` +
          staleJobs.map(j => `${j.id}(${j.status})`).join(', '),
        );

        for (const job of staleJobs) {
          await this.jobRepo.update(job.id, {
            status:       JobStatus.FAILED,
            errorMessage: `Job automatically failed: no activity for more than ${STALE_JOB_MINUTES} minutes. ` +
                          `This typically means the AI Engine did not respond or the worker crashed. ` +
                          `Please try again.`,
            errorDetails: {
              reason:          'stale_timeout',
              lastStatus:      job.status,
              staleThreshold:  generalStaleThreshold.toISOString(),
              detectedAt:      new Date().toISOString(),
            },
            completedAt: new Date(),
          });
          this.logger.warn(`[StaleCleanup] Job ${job.id} (${job.status}) marked FAILED (stale)`);
        }
      }
    } catch (e) {
      this.logger.error(`[StaleCleanup] Error: ${(e as Error).message}`);
    }
  }

  // ── Create + Enqueue ──────────────────────────────────
  async createJob(dto: StartConversionDto): Promise<JobEntity> {
    const tag = `[createJob userId=${dto.userId}]`;
    this.logger.log(
      `${tag} type=${dto.type} src=${dto.sourceLanguage} tgt=${dto.targetLanguage} ` +
      `repo=${dto.sourceRepo ?? '-'} zip=${dto.zipPath ?? '-'}`,
    );

    // 1. Fetch user plan
    this.logger.log(`${tag} Step 1/6: Fetching user plan…`);
    const plan   = await this.subscriptionSvc.getUserPlan(dto.userId);
    const limits = PLAN_LIMITS[plan];
    this.logger.log(`${tag} Plan: ${plan}`);

    // 2. Enforce monthly quota
    this.logger.log(`${tag} Step 2/6: Enforcing monthly quota…`);
    await this.quotaService.enforceConversionQuota(dto.userId, plan);
    this.logger.log(`${tag} Quota: OK`);

    // 3. Enforce concurrent job limit (source de vérité = DB)
    // LOG DIAGNOSTIC PHASE 10 : afficher TOUS les jobs actifs avant la vérification
    this.logger.log(`${tag} Step 3/6: Checking concurrent jobs (DB count)…`);
    const concurrent = await this.quotaService.checkConcurrentJobs(dto.userId, plan);
    // checkConcurrentJobs loggue déjà les IDs/statuts/updatedAt dans QuotaService
    if (!concurrent.allowed) {
      this.logger.warn(
        `${tag} Concurrent limit: current=${concurrent.current} limit=${concurrent.limit}. ` +
        `Check /dashboard/history to see active jobs.`,
      );
      throw new ForbiddenException({
        code:    'CONCURRENT_LIMIT',
        message: `You already have ${concurrent.current} active job(s). ` +
                 `Your ${plan} plan allows ${limits.concurrentJobs} concurrent job(s). ` +
                 `Wait for the current job to complete or check the History page.`,
        current: concurrent.current,
        limit:   limits.concurrentJobs,
      });
    }
    this.logger.log(`${tag} Concurrent: OK (${concurrent.current}/${limits.concurrentJobs} active)`);

    // 4. Validate framework access
    this.logger.log(`${tag} Step 4/6: Validating framework access…`);
    if (!limits.advancedFrameworks) {
      const srcNorm = dto.sourceLanguage.toLowerCase().replace(/[^a-z]/g, '');
      const tgtNorm = dto.targetLanguage.toLowerCase().replace(/[^a-z]/g, '');
      const allowedSrc = ['flutter', 'dart'];
      const allowedTgt = ['react', 'reactnative'];
      if (!allowedSrc.includes(srcNorm) || !allowedTgt.includes(tgtNorm)) {
        this.logger.warn(`${tag} Framework restricted: ${dto.sourceLanguage}→${dto.targetLanguage} (plan=${plan})`);
        throw new ForbiddenException({
          code:       'FRAMEWORK_RESTRICTED',
          message:    `Free plan only supports Flutter → React / React Native. ` +
                      `Upgrade to Pro for ${dto.sourceLanguage} → ${dto.targetLanguage}.`,
          upgradeUrl: '/pricing',
        });
      }
    }
    this.logger.log(`${tag} Framework: OK`);

    // 5. Create DB record
    this.logger.log(`${tag} Step 5/6: Creating job in DB…`);
    const job = this.jobRepo.create({
      type:           dto.type,
      status:         JobStatus.PENDING,
      userId:         dto.userId,
      projectId:      dto.projectId,
      sourceLanguage: dto.sourceLanguage,
      targetLanguage: dto.targetLanguage,
      sourceRepo:     dto.sourceRepo,
      sourceBranch:   dto.sourceBranch,
      zipPath:        dto.zipPath,
      phaseLogs:      [],
    });
    const saved = await this.jobRepo.save(job);
    this.logger.log(`${tag} Job created: id=${saved.id}`);

    // 6. Enqueue with plan priority
    this.logger.log(`${tag} Step 6/6: Enqueueing (priority=${limits.queuePriority})…`);
    try {
      await this.conversionQueue.add(
        'run-conversion',
        { jobId: saved.id, dto },
        {
          priority:         limits.queuePriority,
          attempts:         3,
          backoff:          { type: 'exponential', delay: 2_000 },
          removeOnComplete: 100,
          removeOnFail:     200,
        },
      );
      this.logger.log(`${tag} Job ${saved.id} enqueued ✅ plan=${plan}`);
    } catch (queueErr: unknown) {
      const qMsg = queueErr instanceof Error ? queueErr.message : String(queueErr);
      this.logger.error(`${tag} Queue unavailable (Redis?): ${qMsg}`);

      // Mark job as failed — concurrent count is DB-based so no need to decrement
      await this.jobRepo.update(saved.id, {
        status:       JobStatus.FAILED,
        errorMessage: `Conversion queue unavailable: ${qMsg}. ` +
                      `Redis may not be configured. Contact support.`,
        errorDetails: {
          cause:     qMsg,
          hint:      'Set REDIS_URL environment variable or contact support.',
          timestamp: new Date().toISOString(),
        },
        completedAt: new Date(),
      });

      const failedJob = await this.jobRepo.findOne({ where: { id: saved.id } });
      return failedJob ?? saved;
    }

    return saved;
  }

  // ── Find by ID ────────────────────────────────────────
  async findById(id: string): Promise<JobEntity> {
    const job = await this.jobRepo.findOne({ where: { id } });
    if (!job) throw new NotFoundException(`Job ${id} not found`);
    return job;
  }

  // ── Find by User ──────────────────────────────────────
  async findByUser(
    userId: string,
    page  = 1,
    limit = 20,
  ): Promise<{ data: JobEntity[]; total: number }> {
    const [data, total] = await this.jobRepo.findAndCount({
      where: { userId },
      order: { createdAt: 'DESC' },
      skip:  (page - 1) * limit,
      take:  limit,
    });
    return { data, total };
  }

  // ── Find by Project ───────────────────────────────────
  async findByProject(projectId: string): Promise<JobEntity[]> {
    return this.jobRepo.find({
      where: { projectId },
      order: { createdAt: 'DESC' },
    });
  }

  // ── Update status ─────────────────────────────────────
  async updateStatus(
    id:     string,
    status: JobStatus,
    extra?: Partial<JobEntity>,
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await this.jobRepo.update(id, {
      status,
      ...(status === JobStatus.ANALYZING || status === JobStatus.CONVERTING
        ? { startedAt: new Date() } : {}),
      ...(status === JobStatus.DONE || status === JobStatus.FAILED
        ? { completedAt: new Date() } : {}),
      ...extra,
    } as any);
  }

  // ── Append phase log ──────────────────────────────────
  async appendLog(id: string, phase: string, logStatus: string, message: string): Promise<void> {
    const job  = await this.findById(id);
    const logs = job.phaseLogs ?? [];
    logs.push({ phase, status: logStatus, message, timestamp: new Date().toISOString() });
    await this.jobRepo.update(id, {
      phaseLogs:    logs,
      currentPhase: phase,
      progress:     this.calculateProgress(phase),
    });
  }

  // ── Dispatch to AI Engine ─────────────────────────────
  async dispatchToAiEngine(
    job:         JobEntity,
    files:       Array<{ path: string; content: string }>,
    goalPrompt?: string,
  ): Promise<string> {
    // FIX PHASE 9 — CAUSE RACINE BUG 1 (callback localhost):
    // Avant: config.get('API_URL', 'http://localhost:4000/api/v1')
    // Sur Render sans API_URL défini → callbackUrl = 'http://localhost:4000/...'
    // Le mock AI Engine envoyait le callback vers localhost → jamais reçu.
    // Résultat: job restait CONVERTING indéfiniment → bloque les conversions suivantes.
    //
    // Fallback hiérarchique:
    //   1. API_URL env var (défini manuellement sur Render)
    //   2. RENDER_EXTERNAL_URL (injecté auto par Render) + /api/v1
    //   3. localhost (dev local seulement)
    const renderUrl = process.env['RENDER_EXTERNAL_URL'];
    const apiUrl = this.config.get<string>('API_URL')
      ?? (renderUrl ? `${renderUrl}/api/v1` : 'http://localhost:4000/api/v1');
    const callbackUrl = `${apiUrl}/jobs/${job.id}/callback`;

    this.logger.log(
      `[Job ${job.id}] dispatchToAiEngine: ${files.length} files ` +
      `${job.sourceLanguage}→${job.targetLanguage}, callback=${callbackUrl}, ` +
      `mockMode=${this.aiEngineClient.isMockMode}`,
    );

    const response = await this.aiEngineClient.submitConversion({
      jobId:          job.id,
      sourceLanguage: job.sourceLanguage,
      targetLanguage: job.targetLanguage,
      files,
      goalPrompt:     goalPrompt ?? '',
      callbackUrl,
    });

    // FIX: response est AiConvertResponse { jobId, accepted, message? }
    // On retourne response.jobId (qui est string), pas l'objet entier
    const aiJobId = response.jobId ?? job.id;
    this.logger.log(
      `[Job ${job.id}] AI Engine accepted: aiJobId=${aiJobId} accepted=${response.accepted}`,
    );

    return String(aiJobId);
  }

  // ── Handle callback from AI Engine ────────────────────
  async handleCallback(
    id:      string,
    payload: {
      success:          boolean;
      result?:          Record<string, unknown>;
      irDocument?:      Record<string, unknown>;
      error?:           string;
      filesGenerated?:  number;
      linesGenerated?:  number;
    },
  ): Promise<void> {
    const job = await this.findById(id);
    this.logger.log(`[Job ${id}] Callback received: success=${payload.success}`);

    // Get user plan for quota tracking
    const plan = await this.subscriptionSvc.getUserPlan(job.userId);

    if (payload.success) {
      await this.updateStatus(id, JobStatus.DONE, {
        result:         payload.result,
        irDocument:     payload.irDocument,
        filesGenerated: payload.filesGenerated,
        linesGenerated: payload.linesGenerated,
        progress:       100,
      });
      await this.appendLog(id, 'done', 'done',
        `Conversion complete: ${payload.filesGenerated ?? 0} files generated`,
      );
      // Track successful conversion (monthly quota)
      await this.quotaService.incrementConversions(job.userId, plan, {
        filesProcessed: payload.filesGenerated,
        linesProcessed: payload.linesGenerated,
      });
      this.logger.log(`━━━ [Job ${id}] STEP 10 ✅ ━━━ DONE — ${payload.filesGenerated ?? 0} files generated — conversion complete!`);
    } else {
      const errorMsg = payload.error ?? 'Unknown error from AI Engine';
      await this.updateStatus(id, JobStatus.FAILED, {
        errorMessage: errorMsg,
        progress:     0,
      });
      await this.appendLog(id, 'failed', 'failed', `AI Engine error: ${errorMsg}`);
      this.logger.error(`━━━ [Job ${id}] STEP 10 ❌ ━━━ FAILED by AI Engine: ${errorMsg}`);
    }
  }

  // ── Reset ALL active jobs for user (sans restriction de temps) ───
  // FIX PHASE 10 — CAUSE RACINE BUG 1 (reset-stale inutilisable) :
  // forceResetStaleJobsForUser() n'agit que sur les jobs updatedAt > 15min.
  // Un job bloqué depuis 2min (ex: Bull retry) n'est pas stale → reset-stale retourne 0.
  // Ce nouvel endpoint remet à FAILED TOUS les jobs actifs de l'utilisateur sans condition.
  // Utilisé par le frontend quand l'utilisateur est bloqué par CONCURRENT_LIMIT.
  async resetMyActiveJobs(userId: string): Promise<number> {
    const activeJobs = await this.jobRepo.find({
      where: {
        userId,
        status: In(ACTIVE_STATUSES),
      },
      select: ['id', 'status', 'updatedAt'],
    });

    for (const job of activeJobs) {
      await this.jobRepo.update(job.id, {
        status:       JobStatus.FAILED,
        errorMessage: 'Manually reset by user: job was blocking new conversions.',
        completedAt:  new Date(),
      });
      this.logger.warn(
        `[reset-mine] Job ${job.id} (${job.status}, updatedAt=${job.updatedAt.toISOString()}) ` +
        `force-reset to FAILED for userId=${userId}`,
      );
    }

    this.logger.log(`[reset-mine] userId=${userId}: ${activeJobs.length} job(s) reset`);
    return activeJobs.length;
  }

  // ── Manual reset stale (admin / user action) ──────────
  async forceResetStaleJobsForUser(userId: string): Promise<number> {
    const staleThreshold = new Date(Date.now() - STALE_JOB_MINUTES * 60 * 1000);
    const staleJobs = await this.jobRepo.find({
      where: {
        userId,
        status:    In(ACTIVE_STATUSES),
        updatedAt: LessThan(staleThreshold),
      },
    });

    for (const job of staleJobs) {
      await this.jobRepo.update(job.id, {
        status:       JobStatus.FAILED,
        errorMessage: 'Manually reset: job was stuck and has been cleared.',
        completedAt:  new Date(),
      });
      this.logger.warn(`[reset-stale] Job ${job.id} (${job.status}) force-reset for user ${userId}`);
    }
    return staleJobs.length;
  }

  // ── Reset ALL active jobs (admin) ─────────────────────
  // Remet TOUS les jobs actifs en FAILED sans aucun filtre utilisateur
  // Utile pour nettoyer lors d'un redéploiement ou d'une migration
  async resetAllActiveJobs(): Promise<number> {
    const allActive = await this.jobRepo.find({
      where: { status: In(ACTIVE_STATUSES) },
      select: ['id', 'userId', 'status'],
    });

    for (const job of allActive) {
      await this.jobRepo.update(job.id, {
        status:       JobStatus.FAILED,
        errorMessage: 'Admin reset: all active jobs have been cleared by an administrator.',
        completedAt:  new Date(),
      });
    }

    this.logger.warn(`[reset-all] Admin reset ${allActive.length} active job(s) to FAILED`);
    return allActive.length;
  }

  // ── Cancel job ────────────────────────────────────────
  async cancel(id: string, userId: string): Promise<void> {
    const job = await this.findById(id);
    if (job.userId !== userId) throw new NotFoundException(`Job ${id} not found`);
    if ([JobStatus.DONE, JobStatus.FAILED].includes(job.status)) return;

    await this.updateStatus(id, JobStatus.FAILED, { errorMessage: 'Cancelled by user' });
    this.logger.log(`[Job ${id}] Cancelled by user ${userId}`);
  }

  // ── Helpers ───────────────────────────────────────────
  private calculateProgress(phase: string): number {
    const phases: Record<string, number> = {
      'ast-analysis':           15,
      'architecture-detection': 30,
      'ir-generation':          50,
      mapping:                  65,
      'code-planning':          80,
      validation:               90,
      done:                     100,
      failed:                   0,
    };
    return phases[phase] ?? 0;
  }
}
