// ============================================================
// CodeMorph — Jobs Service (AiEngineClient + Quota enforcement)
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
    // 1. Fetch user plan
    const plan = await this.subscriptionSvc.getUserPlan(dto.userId);
    const limits = PLAN_LIMITS[plan];

    // 2. Enforce monthly quota
    await this.quotaService.enforceConversionQuota(dto.userId, plan);

    // 3. Enforce concurrent job limit
    const concurrent = await this.quotaService.checkConcurrentJobs(dto.userId, plan);
    if (!concurrent.allowed) {
      throw new ForbiddenException({
        code:    'CONCURRENT_LIMIT',
        message: `Concurrent job limit reached (${limits.concurrentJobs}). Wait for a running job to finish.`,
      });
    }

    // 4. Validate framework access
    // Free plan: Flutter → React / React Native seulement
    // Pro+: tous les frameworks dont React → Flutter
    if (!limits.advancedFrameworks) {
      const srcNorm = dto.sourceLanguage.toLowerCase().replace(/[^a-z]/g, '');
      const tgtNorm = dto.targetLanguage.toLowerCase().replace(/[^a-z]/g, '');
      // free autorise: flutter/dart → react/reactnative
      const allowedSrc = ['flutter', 'dart'];
      const allowedTgt = ['react', 'reactnative'];
      if (!allowedSrc.includes(srcNorm) || !allowedTgt.includes(tgtNorm)) {
        throw new ForbiddenException({
          code:       'FRAMEWORK_RESTRICTED',
          message:    'Free plan only supports Flutter → React / React Native. Upgrade to Pro for more frameworks.',
          upgradeUrl: '/pricing',
        });
      }
    }

    // 5. Create DB record
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

    // 6. Track concurrent job
    await this.quotaService.incrementConcurrentJobs(dto.userId, plan);

    // 7. Enqueue with plan priority
    await this.conversionQueue.add(
      'run-conversion',
      { jobId: saved.id, dto },
      {
        priority:        limits.queuePriority,
        attempts:        3,
        backoff:         { type: 'exponential', delay: 2_000 },
        removeOnComplete: 100,
        removeOnFail:     200,
      },
    );

    this.logger.log(`Job ${saved.id} enqueued — plan=${plan} priority=${limits.queuePriority}`);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callbackUrl = `${this.config.get<string>('API_URL', 'http://backend:4000')}/api/v1/jobs/${job.id}/callback`;

    const aiJobId = await this.aiEngineClient.submitConversion({
      jobId:          job.id,
      sourceLanguage: job.sourceLanguage,
      targetLanguage: job.targetLanguage,
      files,
      goalPrompt:     goalPrompt ?? '',
      callbackUrl,
    });

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
      // Track successful conversion quota
      await this.quotaService.incrementConversions(job.userId, plan, {
        filesProcessed: payload.filesGenerated,
        linesProcessed: payload.linesGenerated,
      });
    } else {
      await this.updateStatus(id, JobStatus.FAILED, {
        errorMessage: payload.error ?? 'Unknown error',
        progress:     0,
      });
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
  }

  // ── Helpers ───────────────────────────────────────────
  private calculateProgress(phase: string): number {
    const phases: Record<string, number> = {
      'ast-analysis':          15,
      'architecture-detection': 30,
      'ir-generation':         50,
      mapping:                 65,
      'code-planning':         80,
      validation:              90,
      done:                    100,
    };
    return phases[phase] ?? 0;
  }
}
