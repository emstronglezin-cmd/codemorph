import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { JobsService } from './jobs.service';
import { JobStatus, JobType } from './jobs.entity';
import { GitHubApiService } from '../github/github-api.service';
import { UploadsService } from '../uploads/uploads.service';

interface ConversionJobPayload {
  jobId: string;
  dto: {
    userId: string;
    type: JobType;
    sourceLanguage: string;
    targetLanguage: string;
    sourceRepo?: string;
    sourceBranch?: string;
    zipPath?: string;
    goalPrompt?: string;
  };
}

@Processor('conversion')
export class JobsProcessor {
  private readonly logger = new Logger(JobsProcessor.name);

  constructor(
    private readonly jobsService: JobsService,
    private readonly githubApiService: GitHubApiService,
    private readonly uploadsService: UploadsService,
  ) {}

  @Process('run-conversion')
  async handleConversion(job: Job<ConversionJobPayload>): Promise<void> {
    const { jobId, dto } = job.data;
    this.logger.log(`Processing conversion job ${jobId}`);

    try {
      // Phase 1: Fetch source files
      await this.jobsService.updateStatus(jobId, JobStatus.ANALYZING);
      await this.jobsService.appendLog(jobId, 'ast-analysis', 'running', 'Fetching source files…');

      let files: Array<{ path: string; content: string }> = [];

      if (dto.type === JobType.GITHUB_IMPORT && dto.sourceRepo) {
        files = await this.githubApiService.fetchRepoFiles(
          dto.sourceRepo,
          dto.sourceBranch ?? 'main',
          dto.userId,
        );
        await this.jobsService.appendLog(
          jobId,
          'ast-analysis',
          'done',
          `Fetched ${files.length} files from GitHub`,
        );
      } else if (dto.type === JobType.ZIP_IMPORT && dto.zipPath) {
        files = await this.uploadsService.extractZipFiles(dto.zipPath);
        await this.jobsService.appendLog(
          jobId,
          'ast-analysis',
          'done',
          `Extracted ${files.length} files from ZIP`,
        );
      }

      // Phase 2: Dispatch to AI Engine
      await this.jobsService.updateStatus(jobId, JobStatus.CONVERTING);
      await this.jobsService.appendLog(jobId, 'ir-generation', 'running', 'Dispatching to AI engine…');

      const dbJob = await this.jobsService.findById(jobId);
      const aiJobId = await this.jobsService.dispatchToAiEngine(dbJob, dto.goalPrompt);

      await this.jobsService.updateStatus(jobId, JobStatus.CONVERTING, {
        aiEngineJobId: aiJobId,
      });

      await this.jobsService.appendLog(
        jobId,
        'ir-generation',
        'running',
        `AI Engine job ${aiJobId} started — awaiting callback`,
      );

      // Actual completion will come via the /callback endpoint
      this.logger.log(`Job ${jobId} dispatched to AI Engine as ${aiJobId}`);
    } catch (err) {
      this.logger.error(`Job ${jobId} failed: ${(err as Error).message}`);
      await this.jobsService.updateStatus(jobId, JobStatus.FAILED, {
        errorMessage: (err as Error).message,
        errorDetails: { stack: (err as Error).stack },
      });
    }
  }
}
