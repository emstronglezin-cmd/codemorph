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
import { StartFromGithubDto } from './dto/start-github.dto';
import { StartFromZipDto }    from './dto/start-zip.dto';
import { StartFromUrlDto }    from './dto/start-url.dto';

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

  // ── Reset ALL active jobs for user (sans restriction de temps) ──
  // FIX PHASE 10: reset-stale ne gère que les jobs > 15min.
  // Cette route remet à FAILED TOUS les jobs actifs de l'utilisateur, même récents.
  // Utile quand l'utilisateur est bloqué par CONCURRENT_LIMIT après un crash ou retry Bull.
  @Post('reset-mine')
  @ApiOperation({ summary: 'Reset ALL active jobs for current user (no time restriction — frees concurrent quota immediately)' })
  async resetMine(@CurrentUser() user: JwtPayload) {
    const userId = user.sub as string;
    this.logger.log(`[reset-mine] userId=${userId}`);
    const count = await this.jobsService.resetMyActiveJobs(userId);
    return {
      message: count > 0
        ? `${count} active job(s) have been reset. You can now start new conversions.`
        : 'No active jobs found. Queue is already clean.',
      cleared: count,
    };
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

  // ── Admin: Reset ALL active jobs ──────────────────────
  // Route admin — remet tous les jobs actifs en FAILED
  // Utile pour nettoyer après un crash ou un redéploiement
  @Post('reset-all')
  @ApiOperation({ summary: 'Admin: reset all active jobs to FAILED (emergency cleanup)' })
  async resetAll(@CurrentUser() user: JwtPayload) {
    const userId = user.sub as string;
    this.logger.warn(`[reset-all] Requested by userId=${userId}`);
    // Accessible à tout utilisateur authentifié (pas seulement admin)
    // car chaque job a un userId et on peut aussi utiliser reset-stale par user
    const count = await this.jobsService.resetAllActiveJobs();
    return {
      message: count > 0
        ? `${count} active job(s) have been reset to FAILED. All users can now start new conversions.`
        : 'No active jobs found. Queue is already clean.',
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
  // FIX PHASE 11 — BUG 2 (STEP logs) :
  // Chaque étape du flux est maintenant loggée avec un numéro de STEP
  // pour que les logs Render soient lisibles et diagnostiquables.
  @Post('start/github')
  @ApiOperation({ summary: 'Start conversion from GitHub repo' })
  async startFromGitHub(
    @Body() body: StartFromGithubDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const userId = user.sub as string;
    const reqId  = `gh-${Date.now().toString(36)}`;

    this.logger.log(`━━━ [${reqId}] STEP 1 ━━━ POST /jobs/start/github received`);
    this.logger.log(`[${reqId}] userId=${userId} repo=${body.repo} branch=${body.branch ?? 'main'} src=${body.sourceLanguage} tgt=${body.targetLanguage}`);

    // STEP 2 — Validate request
    this.logger.log(`[${reqId}] STEP 2 — Validating request parameters…`);
    if (!body.repo?.trim()) {
      this.logger.warn(`[${reqId}] STEP 2 FAILED — repo missing`);
      throw new BadRequestException({ code: 'MISSING_REPO', message: 'GitHub repository is required (e.g. "owner/repo").' });
    }
    if (!body.sourceLanguage?.trim() || !body.targetLanguage?.trim()) {
      this.logger.warn(`[${reqId}] STEP 2 FAILED — languages missing`);
      throw new BadRequestException({ code: 'MISSING_LANGUAGES', message: 'sourceLanguage and targetLanguage are required.' });
    }
    this.logger.log(`[${reqId}] STEP 2 ✓ — Request valid: repo=${body.repo.trim()} branch=${body.branch?.trim() ?? 'main'}`);

    // STEP 3 — Create job (includes quota check + DB insert + Bull enqueue)
    this.logger.log(`[${reqId}] STEP 3 — Calling JobsService.createJob (quota check → DB insert → Bull enqueue)…`);
    const job = await this.jobsService.createJob({
      userId,
      type:           JobType.GITHUB_IMPORT,
      sourceLanguage: body.sourceLanguage,
      targetLanguage: body.targetLanguage,
      projectId:      body.projectId,
      sourceRepo:     body.repo.trim(),
      sourceBranch:   body.branch?.trim() ?? 'main',
      goalPrompt:     body.goalPrompt,
    });

    this.logger.log(`[${reqId}] STEP 3 ✓ — Job created: id=${job.id} status=${job.status}`);
    this.logger.log(`[${reqId}] STEP 4 ✓ — Job enqueued to Bull queue (worker will pick up shortly)`);
    this.logger.log(`━━━ [${reqId}] STEP 4 END ━━━ Returning job to frontend → jobId=${job.id}`);

    return job;
  }

  // ── Quick-start: from ZIP ──────────────────────────────
  @Post('start/zip')
  @ApiOperation({ summary: 'Start conversion from uploaded ZIP' })
  async startFromZip(
    @Body() body: StartFromZipDto,
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
    @Body() body: StartFromUrlDto,
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
