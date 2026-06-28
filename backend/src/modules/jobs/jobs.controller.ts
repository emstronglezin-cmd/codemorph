// ============================================================
// CodeMorph — Jobs Controller
// PHASE 7 FIX:
//   - POST /jobs/start/url implémenté
//   - POST /jobs/reset-stale : libère les jobs bloqués
//   - GET /jobs/stats : stats pour la page Historique
//   - Logs détaillés
// ============================================================
import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
  HttpCode,
  HttpStatus,
  UseGuards,
  ParseUUIDPipe,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JobsService, StartConversionDto } from './jobs.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { JwtPayload } from '@codemorph/shared';
import { JobType } from './jobs.entity';
import { UploadsService } from '../uploads/uploads.service';

@ApiTags('jobs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('jobs')
export class JobsController {
  private readonly logger = new Logger(JobsController.name);

  constructor(
    private readonly jobsService:    JobsService,
    private readonly uploadsService: UploadsService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Start a new conversion job' })
  async create(
    @Body() body: Omit<StartConversionDto, 'userId'>,
    @CurrentUser() user: JwtPayload,
  ) {
    const userId = user.sub as string;
    this.logger.log(`[POST /jobs] userId=${userId} type=${body.type}`);
    return this.jobsService.createJob({ ...body, userId });
  }

  @Get()
  @ApiOperation({ summary: 'List jobs for current user' })
  @ApiQuery({ name: 'page',   required: false, type: Number })
  @ApiQuery({ name: 'limit',  required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, type: String })
  async findAll(
    @CurrentUser() user: JwtPayload,
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page:  number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.jobsService.findByUser(user.sub as string, page, limit);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get job statistics for the current user (for History page)' })
  async getStats(@CurrentUser() user: JwtPayload) {
    const userId = user.sub as string;
    const { data, total } = await this.jobsService.findByUser(userId, 1, 1000);

    const stats = {
      total,
      pending:    data.filter(j => j.status === 'pending').length,
      analyzing:  data.filter(j => j.status === 'analyzing').length,
      converting: data.filter(j => j.status === 'converting').length,
      done:       data.filter(j => j.status === 'done').length,
      failed:     data.filter(j => j.status === 'failed').length,
      active:     data.filter(j => ['pending', 'analyzing', 'converting'].includes(j.status)).length,
    };

    return stats;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get job by ID' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const job = await this.jobsService.findById(id);
    if (job.userId !== (user.sub as string)) {
      return { statusCode: 403, message: 'Forbidden' };
    }
    return job;
  }

  @Get('project/:projectId')
  @ApiOperation({ summary: 'Get all jobs for a project' })
  async findByProject(@Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.jobsService.findByProject(projectId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Cancel a running job' })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.jobsService.cancel(id, user.sub as string);
  }

  // ── Reset stale jobs for user ──────────────────────────
  @Post('reset-stale')
  @ApiOperation({ summary: 'Reset stuck/stale jobs for current user (frees concurrent quota)' })
  async resetStale(@CurrentUser() user: JwtPayload) {
    const userId = user.sub as string;
    this.logger.log(`[reset-stale] userId=${userId}`);
    const count = await this.jobsService.forceResetStaleJobsForUser(userId);
    return {
      message: count > 0
        ? `${count} stale job(s) have been cleared. You can now start new conversions.`
        : 'No stale jobs found. All your jobs are either active or already completed.',
      cleared: count,
    };
  }

  // ── Callback from AI Engine (public) ──────────────────
  @Public()
  @Post(':id/callback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'AI Engine callback — update job result' })
  async callback(
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    body: {
      success:         boolean;
      result?:         Record<string, unknown>;
      irDocument?:     Record<string, unknown>;
      error?:          string;
      filesGenerated?: number;
      linesGenerated?: number;
    },
  ) {
    this.logger.log(`[Callback] Job ${id} → success=${body.success}`);
    await this.jobsService.handleCallback(id, body);
    return { ok: true };
  }

  // ── Quick-start: from GitHub repo ─────────────────────
  @Post('start/github')
  @ApiOperation({ summary: 'Start conversion from GitHub repo' })
  async startFromGitHub(
    @Body()
    body: {
      projectId?:     string;
      sourceLanguage: string;
      targetLanguage: string;
      repo:           string;
      branch?:        string;
      goalPrompt?:    string;
    },
    @CurrentUser() user: JwtPayload,
  ) {
    const userId = user.sub as string;

    if (!body.repo?.trim()) {
      throw new BadRequestException({ code: 'MISSING_REPO', message: 'GitHub repository is required (e.g. "owner/repo").' });
    }
    if (!body.sourceLanguage?.trim() || !body.targetLanguage?.trim()) {
      throw new BadRequestException({ code: 'MISSING_LANGUAGES', message: 'sourceLanguage and targetLanguage are required.' });
    }

    this.logger.log(`[start/github] userId=${userId} repo=${body.repo} branch=${body.branch ?? 'main'}`);

    return this.jobsService.createJob({
      userId,
      type:           JobType.GITHUB_IMPORT,
      sourceLanguage: body.sourceLanguage,
      targetLanguage: body.targetLanguage,
      projectId:      body.projectId,
      sourceRepo:     body.repo.trim(),
      sourceBranch:   body.branch?.trim() ?? 'main',
      goalPrompt:     body.goalPrompt,
    });
  }

  // ── Quick-start: from ZIP ──────────────────────────────
  @Post('start/zip')
  @ApiOperation({ summary: 'Start conversion from uploaded ZIP' })
  async startFromZip(
    @Body()
    body: {
      projectId?:     string;
      sourceLanguage: string;
      targetLanguage: string;
      zipPath:        string;
      goalPrompt?:    string;
    },
    @CurrentUser() user: JwtPayload,
  ) {
    const userId = user.sub as string;

    if (!body.zipPath?.trim()) {
      throw new BadRequestException({ code: 'MISSING_ZIP_PATH', message: 'zipPath is required. Upload your ZIP first via POST /uploads/zip.' });
    }
    if (!body.sourceLanguage?.trim() || !body.targetLanguage?.trim()) {
      throw new BadRequestException({ code: 'MISSING_LANGUAGES', message: 'sourceLanguage and targetLanguage are required.' });
    }

    this.logger.log(`[start/zip] userId=${userId} zipPath=${body.zipPath}`);

    return this.jobsService.createJob({
      userId,
      type:           JobType.ZIP_IMPORT,
      sourceLanguage: body.sourceLanguage,
      targetLanguage: body.targetLanguage,
      projectId:      body.projectId,
      zipPath:        body.zipPath.trim(),
      goalPrompt:     body.goalPrompt,
    });
  }

  // ── Quick-start: from public URL ───────────────────────
  @Post('start/url')
  @ApiOperation({ summary: 'Start conversion from public ZIP URL' })
  async startFromUrl(
    @Body()
    body: {
      projectId?:     string;
      sourceLanguage: string;
      targetLanguage: string;
      sourceUrl:      string;
      goalPrompt?:    string;
    },
    @CurrentUser() user: JwtPayload,
  ) {
    const userId = user.sub as string;

    if (!body.sourceUrl?.trim()) {
      throw new BadRequestException({ code: 'MISSING_SOURCE_URL', message: 'sourceUrl is required.' });
    }
    if (!body.sourceLanguage?.trim() || !body.targetLanguage?.trim()) {
      throw new BadRequestException({ code: 'MISSING_LANGUAGES', message: 'sourceLanguage and targetLanguage are required.' });
    }

    let parsedUrl: URL;
    try { parsedUrl = new URL(body.sourceUrl.trim()); } catch {
      throw new BadRequestException({ code: 'INVALID_URL', message: `Invalid URL: "${body.sourceUrl}"` });
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new BadRequestException({ code: 'INVALID_URL_PROTOCOL', message: 'Only http:// and https:// URLs are supported.' });
    }

    this.logger.log(`[start/url] userId=${userId} url=${body.sourceUrl}`);

    const zipPath = await this.uploadsService.downloadFromUrl(body.sourceUrl.trim());
    this.logger.log(`[start/url] Downloaded to: ${zipPath}`);

    return this.jobsService.createJob({
      userId,
      type:           JobType.URL_IMPORT,
      sourceLanguage: body.sourceLanguage,
      targetLanguage: body.targetLanguage,
      projectId:      body.projectId,
      zipPath,
      goalPrompt:     body.goalPrompt,
    });
  }
}
