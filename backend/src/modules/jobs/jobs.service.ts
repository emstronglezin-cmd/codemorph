// ============================================================
// CodeMorph — Jobs Service (AiEngineClient + Quota enforcement)
// FIX: Logs détaillés à chaque étape
// FIX: Erreurs complètes propagées sans masquage
// FIX: dispatchToAiEngine retourne string correctement
// ============================================================
import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository }        from 'typeorm';
import { InjectQueue }       from '@nestjs/bull';
import { Queue }             from 'bull';
import { ConfigService }     from '@nestjs/config';

import { JobEntity, JobStatus, JobType } from './jobs.entity';
import { AiEngineClient }                from './ai-engine.client';
import { QuotaService }                  from '../quota/quota.service';
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

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    @InjectRepository(JobEntity)
    private readonly jobRepo: Repository<JobEntity>,

    @InjectQueue('conversion')
    private readonly conversionQueue: Queue,

    private readonly aiEngineClient:    AiEngineClient,
    private readonly quotaService:      QuotaService,
    private readonly subscriptionSvc:   SubscriptionService,
    private readonly config:            ConfigService,
  ) {}

  // ── Create + Enqueue ──────────────────────────────────
  async createJob(dto: StartConversionDto): Promise<JobEntity> {
    const tag = `[createJob userId=${dto.userId}]`;
    this.logger.log(
      `${tag} type=${dto.type} src=${dto.sourceLanguage} tgt=${dto.targetLanguage} ` +
      `repo=${dto.sourceRepo ?? '-'} zip=${dto.zipPath ?? '-'}`,
    );

    // 1. Fetch user plan
    this.logger.log(`${tag} Step 1/7: Fetching user plan…`);
    const plan   = await this.subscriptionSvc.getUserPlan(dto.userId);
    const limits = PLAN_LIMITS[plan];
    this.logger.log(`${tag} Plan: ${plan}`);

    // 2. Enforce monthly quota
    this.logger.log(`${tag} Step 2/7: Enforcing monthly quota…`);
    await this.quotaService.enforceConversionQuota(dto.userId, plan);
    this.logger.log(`${tag} Quota: OK`);

    // 3. Enforce concurrent job limit
    this.logger.log(`${tag} Step 3/7: Checking concurrent jobs…`);
    const concurrent = await this.quotaService.checkConcurrentJobs(dto.userId, plan);
    if (!concurrent.allowed) {
      this.logger.warn(`${tag} Concurrent limit reached (${limits.concurrentJobs})`);
      throw new ForbiddenException({
        code:    'CONCURRENT_LIMIT',
        message: `Concurrent job limit reached (${limits.concurrentJobs}). Wait for a running job to finish.`,
      });
    }
    this.logger.log(`${tag} Concurrent: OK (${concurrent.current ?? 0}/${limits.concurrentJobs})`);

    // 4. Validate framework access
    // Free plan: Flutter → React / React Native only
    // Pro+: all frameworks including React → Flutter, Express/Node → NestJS
    this.logger.log(`${tag} Step 4/7: Validating framework access…`);
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
    this.logger.log(`${tag} Framework: OK (${dto.sourceLanguage} → ${dto.targetLanguage})`);

    // 5. Create DB record
    this.logger.log(`${tag} Step 5/7: Creating job in database…`);
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

    // 6. Track concurrent job
    this.logger.log(`${tag} Step 6/7: Tracking concurrent job counter…`);
    await this.quotaService.incrementConcurrentJobs(dto.userId, plan);

    // 7. Enqueue with plan priority
    // If Redis is absent, Bull throws — we catch it and mark job FAILED with a clear message
    this.logger.log(`${tag} Step 7/7: Enqueueing job (priority=${limits.queuePriority})…`);
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
      this.logger.log(`${tag} Job ${saved.id} enqueued ✅ — plan=${plan} priority=${limits.queuePriority}`);
    } catch (queueErr: unknown) {
      const qMsg = queueErr instanceof Error ? queueErr.message : String(queueErr);
      this.logger.error(`${tag} Queue unavailable (Redis?): ${qMsg}`);

      // Decrement concurrent counter since job won't run
      try {
        await this.quotaService.decrementConcurrentJobs(dto.userId, plan);
      } catch { /* ignore */ }

      // Mark job as failed with a clear, actionable message
      await this.jobRepo.update(saved.id, {
        status:       JobStatus.FAILED,
        errorMessage: `Conversion queue unavailable: ${qMsg}. Redis may not be configured on this instance.`,
        errorDetails: {
          cause:     qMsg,
          hint:      'Ensure REDIS_URL environment variable is set, or contact support.',
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

  // ── Dispatch to AI Engine (via AiEngineClient) ────────
  async dispatchToAiEngine(
    job:         JobEntity,
    files:       Array<{ path: string; content: string }>,
    goalPrompt?: string,
  ): Promise<string> {
    const apiUrl     = this.config.get<string>('API_URL', 'http://localhost:4000/api/v1');
    const callbackUrl = `${apiUrl}/jobs/${job.id}/callback`;

    this.logger.log(
      `[Job ${job.id}] dispatchToAiEngine: ${files.length} files, callback=${callbackUrl}, ` +
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

    const aiJobId = response.jobId ?? job.id;
    this.logger.log(`[Job ${job.id}] AI Engine accepted: aiJobId=${aiJobId} accepted=${response.accepted}`);

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

    // Decrement concurrent job counter
    const plan = await this.subscriptionSvc.getUserPlan(job.userId);
    await this.quotaService.decrementConcurrentJobs(job.userId, plan);

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
      // Track successful conversion quota
      await this.quotaService.incrementConversions(job.userId, plan, {
        filesProcessed: payload.filesGenerated,
        linesProcessed: payload.linesGenerated,
      });
      this.logger.log(`[Job ${id}] ✅ DONE — ${payload.filesGenerated ?? 0} files`);
    } else {
      const errorMsg = payload.error ?? 'Unknown error from AI Engine';
      await this.updateStatus(id, JobStatus.FAILED, {
        errorMessage: errorMsg,
        progress:     0,
      });
      await this.appendLog(id, 'failed', 'failed', `AI Engine error: ${errorMsg}`);
      this.logger.error(`[Job ${id}] ❌ FAILED by AI Engine: ${errorMsg}`);
    }
  }

  // ── Cancel job ────────────────────────────────────────
  async cancel(id: string, userId: string): Promise<void> {
    const job = await this.findById(id);
    if (job.userId !== userId) throw new NotFoundException(`Job ${id} not found`);
    if ([JobStatus.DONE, JobStatus.FAILED].includes(job.status)) return;

    const plan = await this.subscriptionSvc.getUserPlan(userId);
    await this.quotaService.decrementConcurrentJobs(userId, plan);
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
