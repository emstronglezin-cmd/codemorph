import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { JobEntity, JobStatus, JobType } from './jobs.entity';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

export interface StartConversionDto {
  projectId?: string;
  userId: string;
  type: JobType;
  sourceLanguage: string;
  targetLanguage: string;
  sourceRepo?: string;
  sourceBranch?: string;
  zipPath?: string;
  goalPrompt?: string;
}

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    @InjectRepository(JobEntity)
    private readonly jobRepo: Repository<JobEntity>,
    @InjectQueue('conversion')
    private readonly conversionQueue: Queue,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  async createJob(dto: StartConversionDto): Promise<JobEntity> {
    const job = this.jobRepo.create({
      type: dto.type,
      status: JobStatus.PENDING,
      userId: dto.userId,
      projectId: dto.projectId,
      sourceLanguage: dto.sourceLanguage,
      targetLanguage: dto.targetLanguage,
      sourceRepo: dto.sourceRepo,
      sourceBranch: dto.sourceBranch,
      zipPath: dto.zipPath,
      phaseLogs: [],
    });

    const saved = await this.jobRepo.save(job);

    // Enqueue the job in Bull queue
    await this.conversionQueue.add(
      'run-conversion',
      {
        jobId: saved.id,
        dto,
      },
      {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 50,
        removeOnFail: 100,
      },
    );

    this.logger.log(`Job ${saved.id} enqueued for conversion`);
    return saved;
  }

  async findById(id: string): Promise<JobEntity> {
    const job = await this.jobRepo.findOne({ where: { id } });
    if (!job) throw new NotFoundException(`Job ${id} not found`);
    return job;
  }

  async findByUser(
    userId: string,
    page = 1,
    limit = 20,
  ): Promise<{ data: JobEntity[]; total: number }> {
    const [data, total] = await this.jobRepo.findAndCount({
      where: { userId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data, total };
  }

  async findByProject(projectId: string): Promise<JobEntity[]> {
    return this.jobRepo.find({
      where: { projectId },
      order: { createdAt: 'DESC' },
    });
  }

  async updateStatus(
    id: string,
    status: JobStatus,
    extra?: Partial<JobEntity>,
  ): Promise<void> {
    await this.jobRepo.update(id, {
      status,
      ...(status === JobStatus.ANALYZING || status === JobStatus.CONVERTING
        ? { startedAt: new Date() }
        : {}),
      ...(status === JobStatus.DONE || status === JobStatus.FAILED
        ? { completedAt: new Date() }
        : {}),
      ...extra,
    });
  }

  async appendLog(
    id: string,
    phase: string,
    logStatus: string,
    message: string,
  ): Promise<void> {
    const job = await this.findById(id);
    const logs = job.phaseLogs ?? [];
    logs.push({ phase, status: logStatus, message, timestamp: new Date().toISOString() });

    await this.jobRepo.update(id, {
      phaseLogs: logs,
      currentPhase: phase,
      progress: this.calculateProgress(phase),
    });
  }

  private calculateProgress(phase: string): number {
    const phases: Record<string, number> = {
      'ast-analysis': 15,
      'architecture-detection': 30,
      'ir-generation': 50,
      mapping: 65,
      'code-planning': 80,
      validation: 90,
      done: 100,
    };
    return phases[phase] ?? 0;
  }

  async dispatchToAiEngine(job: JobEntity, goalPrompt?: string): Promise<string> {
    const aiEngineUrl = this.configService.get<string>('AI_ENGINE_URL', 'http://ai-engine:5000');
    const callbackUrl = `${this.configService.get<string>('API_URL', 'http://backend:4000')}/api/v1/jobs/${job.id}/callback`;

    const response = await firstValueFrom(
      this.httpService.post(`${aiEngineUrl}/api/convert`, {
        jobId: job.id,
        sourceLanguage: job.sourceLanguage,
        targetLanguage: job.targetLanguage,
        files: [], // populated by GitHub/ZIP service before calling this
        goalPrompt: goalPrompt ?? '',
        callbackUrl,
      }),
    );

    return response.data.jobId as string;
  }

  async handleCallback(
    id: string,
    payload: {
      success: boolean;
      result?: Record<string, unknown>;
      irDocument?: Record<string, unknown>;
      error?: string;
      filesGenerated?: number;
      linesGenerated?: number;
    },
  ): Promise<void> {
    if (payload.success) {
      await this.updateStatus(id, JobStatus.DONE, {
        result: payload.result,
        irDocument: payload.irDocument,
        filesGenerated: payload.filesGenerated,
        linesGenerated: payload.linesGenerated,
        progress: 100,
      });
    } else {
      await this.updateStatus(id, JobStatus.FAILED, {
        errorMessage: payload.error ?? 'Unknown error',
        progress: 0,
      });
    }
  }

  async cancel(id: string, userId: string): Promise<void> {
    const job = await this.findById(id);
    if (job.userId !== userId) throw new NotFoundException(`Job ${id} not found`);

    if ([JobStatus.DONE, JobStatus.FAILED].includes(job.status)) return;

    await this.updateStatus(id, JobStatus.FAILED, {
      errorMessage: 'Cancelled by user',
    });
  }
}
