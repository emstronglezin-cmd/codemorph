// ============================================================
// CodeMorph — Organizations Controller
// ============================================================
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

import { OrganizationsService } from './organizations.service';
import { JwtAuthGuard }        from '../../common/guards/jwt-auth.guard';
import { CurrentUser }         from '../../common/decorators/current-user.decorator';
import type { JwtPayload, OrgId, UserId } from '@codemorph/shared';

@ApiTags('organizations')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT')
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly orgsService: OrganizationsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new organization' })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() body: { name: string; slug: string; logoUrl?: string | null },
  ): Promise<unknown> {
    return this.orgsService.create(body, user.sub);
  }

  @Get('me')
  @ApiOperation({ summary: 'Get organizations for current user' })
  async findMyOrgs(@CurrentUser() user: JwtPayload): Promise<unknown> {
    return this.orgsService.findByUser(user.sub);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get organization by ID' })
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    return this.orgsService.findByIdOrFail(id as OrgId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update organization' })
  async update(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { name?: string; logoUrl?: string | null },
  ): Promise<unknown> {
    return this.orgsService.update(id as OrgId, body, user.sub);
  }

  @Get(':id/members')
  @ApiOperation({ summary: 'List organization members' })
  async getMembers(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    return this.orgsService.getMembers(id as OrgId);
  }

  @Post(':id/members')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a member to organization' })
  async addMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { userId: string; role?: 'admin' | 'member' | 'viewer' },
  ): Promise<unknown> {
    return this.orgsService.addMember(id as OrgId, body.userId as UserId, body.role);
  }

  @Delete(':id/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a member from organization' })
  async removeMember(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe)     id:     string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    await this.orgsService.removeMember(id as OrgId, userId as UserId, user.sub);
  }
}
