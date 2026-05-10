// ============================================================
// CodeMorph — Conversions Service
// ============================================================
import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { firstValueFrom } from 'rxjs';

import type { UserId, ProjectId, IRDocument } from '@codemorph/shared';
import { ConversionJobEntity } from './entities/conversion-job.entity';
import { ProjectsService }    from '../projects/projects.service';

@Injectable()
export class ConversionsService {
  constructor(
    @InjectRepository(ConversionJobEntity)
    private readonly jobsRepo: Repository<ConversionJobEntity>,
    private readonly projectsService: ProjectsService,
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
  ) {}

  // ── Start conversion ──────────────────────────────────
  async startConversion(
    projectId: ProjectId,
    userId: UserId,
    irDocument: IRDocument,
  ): Promise<ConversionJobEntity> {
    const project = await this.projectsService.findByIdOrFail(projectId, userId);

    if (project.status === 'converting') {
      throw new BadRequestException('A conversion is already in progress for this project');
    }

    // Create job
    const job = this.jobsRepo.create({
      id:         uuidv4(),
      projectId:  project.id,
      status:     'pending',
      progress:   0,
      irDocument: irDocument as unknown as Record<string, unknown>,
      startedAt:  new Date(),
    });
    const savedJob = await this.jobsRepo.save(job);

    // Update project status
    await this.projectsService.updateStatus(projectId, 'converting');

    // Dispatch to AI Engine (fire-and-forget)
    void this.dispatchToAIEngine(savedJob.id, project.id, irDocument, project.sourceLanguage, project.targetLanguage);

    return savedJob;
  }

  // ── Get job status ────────────────────────────────────
  async getJobStatus(jobId: string, userId: UserId): Promise<ConversionJobEntity> {
    const job = await this.jobsRepo.findOne({
      where:    { id: jobId },
      relations: ['project'],
    });
    if (!job) throw new NotFoundException(`Job ${jobId} not found`);
    if (job.project.ownerId !== (userId as string)) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }
    return job;
  }

  // ── List jobs by project ──────────────────────────────
  async findByProject(projectId: ProjectId, userId: UserId): Promise<ConversionJobEntity[]> {
    await this.projectsService.findByIdOrFail(projectId, userId);
    return this.jobsRepo.find({
      where:  { projectId: projectId as string },
      order:  { createdAt: 'DESC' },
    });
  }

  // ── Webhook: AI Engine callback ───────────────────────
  async handleJobCallback(
    jobId: string,
    status: 'completed' | 'failed',
    output?: Record<string, unknown>,
    errorMessage?: string,
    tokensUsed?: number,
  ): Promise<void> {
    const job = await this.jobsRepo.findOne({ where: { id: jobId } });
    if (!job) return;

    const now = new Date();
    const durationMs = job.startedAt
      ? now.getTime() - new Date(job.startedAt).getTime()
      : null;

    await this.jobsRepo.update(jobId, {
      status,
      progress:     status === 'completed' ? 100 : job.progress,
      output:       output ?? null,
      errorMessage: errorMessage ?? null,
      tokensUsed:   tokensUsed ?? 0,
      completedAt:  now,
      durationMs,
    });

    await this.projectsService.updateStatus(
      job.projectId as ProjectId,
      status === 'completed' ? 'completed' : 'failed',
    );
  }

  // ── Dispatch to AI Engine ─────────────────────────────
  private async dispatchToAIEngine(
    jobId: string,
    projectId: string,
    irDocument: IRDocument,
    sourceLanguage: string,
    targetLanguage: string,
  ): Promise<void> {
    const aiEngineUrl = this.config.get<string>('app.aiEngineUrl', 'http://localhost:5000');
    const callbackUrl = `${this.config.get<string>('app.apiUrl', 'http://localhost:4000')}/api/v1/conversions/callback`;

    try {
      await firstValueFrom(
        this.httpService.post(`${aiEngineUrl}/api/convert`, {
          jobId,
          projectId,
          irDocument,
          sourceLanguage,
          targetLanguage,
          callbackUrl,
        }),
      );
    } catch (err) {
      // Mark job as failed if AI engine is unreachable
      await this.handleJobCallback(
        jobId,
        'failed',
        undefined,
        err instanceof Error ? err.message : 'AI Engine unreachable',
      );
    }
  }
}
