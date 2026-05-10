// ============================================================
// CodeMorph — Conversions Controller
// ============================================================
import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

import { ConversionsService } from './conversions.service';
import { JwtAuthGuard }       from '../../common/guards/jwt-auth.guard';
import { CurrentUser }        from '../../common/decorators/current-user.decorator';
import { Public }             from '../../common/decorators/public.decorator';
import type { JwtPayload, ProjectId, IRDocument } from '@codemorph/shared';

@ApiTags('conversions')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT')
@Controller('conversions')
export class ConversionsController {
  constructor(private readonly conversionsService: ConversionsService) {}

  @Post('start')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Start a new code conversion job' })
  async start(
    @CurrentUser() user: JwtPayload,
    @Body() body: { projectId: string; irDocument: IRDocument },
  ): Promise<unknown> {
    return this.conversionsService.startConversion(
      body.projectId as ProjectId,
      user.sub,
      body.irDocument,
    );
  }

  @Get('job/:jobId')
  @ApiOperation({ summary: 'Get conversion job status' })
  async getJobStatus(
    @CurrentUser() user: JwtPayload,
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ): Promise<unknown> {
    return this.conversionsService.getJobStatus(jobId, user.sub);
  }

  @Get('project/:projectId')
  @ApiOperation({ summary: 'List all conversion jobs for a project' })
  async findByProject(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ): Promise<unknown> {
    return this.conversionsService.findByProject(projectId as ProjectId, user.sub);
  }

  // ── Webhook callback from AI Engine (internal, public) ─
  @Public()
  @Post('callback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Internal] AI Engine callback webhook' })
  async handleCallback(
    @Body() body: {
      jobId:        string;
      status:       'completed' | 'failed';
      output?:      Record<string, unknown>;
      errorMessage?: string;
      tokensUsed?:  number;
    },
  ): Promise<{ ok: boolean }> {
    await this.conversionsService.handleJobCallback(
      body.jobId,
      body.status,
      body.output,
      body.errorMessage,
      body.tokensUsed,
    );
    return { ok: true };
  }
}
