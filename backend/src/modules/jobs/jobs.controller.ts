// ============================================================
// CodeMorph — Jobs Controller
// FIX: CurrentUser retourne JwtPayload avec .sub (pas .id)
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
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JobsService, StartConversionDto } from './jobs.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { JwtPayload } from '@codemorph/shared';
import { JobType } from './jobs.entity';

@ApiTags('jobs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Post()
  @ApiOperation({ summary: 'Start a new conversion job' })
  async create(
    @Body() body: Omit<StartConversionDto, 'userId'>,
    @CurrentUser() user: JwtPayload,
  ) {
    // FIX: utiliser user.sub (string UUID) au lieu de user.id (inexistant dans JwtPayload)
    return this.jobsService.createJob({ ...body, userId: user.sub as string });
  }

  @Get()
  @ApiOperation({ summary: 'List jobs for current user' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async findAll(
    @CurrentUser() user: JwtPayload,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.jobsService.findByUser(user.sub as string, page, limit);
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
    return this.jobsService.createJob({
      userId:         user.sub as string,
      type:           JobType.GITHUB_IMPORT,
      sourceLanguage: body.sourceLanguage,
      targetLanguage: body.targetLanguage,
      projectId:      body.projectId,
      sourceRepo:     body.repo,
      sourceBranch:   body.branch ?? 'main',
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
    return this.jobsService.createJob({
      userId:         user.sub as string,
      type:           JobType.ZIP_IMPORT,
      sourceLanguage: body.sourceLanguage,
      targetLanguage: body.targetLanguage,
      projectId:      body.projectId,
      zipPath:        body.zipPath,
      goalPrompt:     body.goalPrompt,
    });
  }
}
