// ============================================================
// CodeMorph — Projects Controller
// ============================================================
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';

import { ProjectsService } from './projects.service';
import { JwtAuthGuard }    from '../../common/guards/jwt-auth.guard';
import { CurrentUser }     from '../../common/decorators/current-user.decorator';
import type { JwtPayload, ProjectId } from '@codemorph/shared';

@ApiTags('projects')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT')
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new project' })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() body: {
      name: string;
      description?: string;
      sourceLanguage: 'javascript' | 'python' | 'java' | 'csharp' | 'php' | 'ruby' | 'go';
      targetLanguage: 'typescript' | 'rust' | 'kotlin' | 'swift' | 'dart';
      orgId?: string;
    },
  ): Promise<unknown> {
    return this.projectsService.create({ ...body, ownerId: user.sub });
  }

  @Get()
  @ApiOperation({ summary: 'List all user projects' })
  @ApiQuery({ name: 'page',  required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async findAll(
    @CurrentUser() user: JwtPayload,
    @Query('page')  page  = 1,
    @Query('limit') limit = 20,
  ): Promise<unknown> {
    return this.projectsService.findAllByOwner(user.sub, +page, +limit);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get project by ID' })
  async findOne(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    return this.projectsService.findByIdOrFail(id as ProjectId, user.sub);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update project' })
  async update(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { name?: string; description?: string | null },
  ): Promise<unknown> {
    return this.projectsService.update(id as ProjectId, user.sub, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete project' })
  async remove(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.projectsService.delete(id as ProjectId, user.sub);
  }
}
