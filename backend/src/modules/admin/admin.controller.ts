// ============================================================
// CodeMorph — Admin Controller
// Protected: requires admin or owner role
// ============================================================
import {
  Controller, Get, Post, Param, Body, Query,
  UseGuards, DefaultValuePipe, ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { JobStatus } from '../jobs/jobs.entity';

// Simple role guard inline
import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';

@Injectable()
class AdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ user?: { role?: string } }>();
    if (!['admin', 'owner'].includes(req.user?.role ?? '')) {
      throw new ForbiddenException({ code: 'ADMIN_REQUIRED', message: 'Admin access required' });
    }
    return true;
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Platform overview — users, jobs, revenue, AI usage' })
  getOverview() {
    return this.adminService.getOverview();
  }

  @Get('users')
  @ApiOperation({ summary: 'List all users (paginated)' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'search', required: false })
  getUsers(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('search') search?: string,
  ) {
    return this.adminService.getUsers(page, limit, search);
  }

  @Get('jobs')
  @ApiOperation({ summary: 'List all jobs (paginated, filterable)' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'status', required: false, enum: JobStatus })
  getJobs(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') status?: JobStatus,
  ) {
    return this.adminService.getJobs(page, limit, status);
  }

  @Get('timeline/conversions')
  @ApiOperation({ summary: 'Conversion timeline — last 30 days' })
  getConversionTimeline() {
    return this.adminService.getConversionTimeline();
  }

  @Get('timeline/ai-usage')
  @ApiOperation({ summary: 'AI usage timeline — last 30 days' })
  getAiUsageTimeline() {
    return this.adminService.getAiUsageTimeline();
  }

  @Get('top-users')
  @ApiOperation({ summary: 'Top users by conversion usage' })
  getTopUsers(@Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number) {
    return this.adminService.getTopUsers(limit);
  }

  @Get('errors')
  @ApiOperation({ summary: 'Error summary — last 7 days' })
  getErrorSummary() {
    return this.adminService.getErrorSummary();
  }

  @Post('jobs/:id/force-fail')
  @ApiOperation({ summary: 'Force-fail a stuck job' })
  forceFailJob(
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    return this.adminService.forceFailJob(id, body.reason ?? 'Admin action');
  }
}
