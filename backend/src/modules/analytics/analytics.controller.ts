// ============================================================
// CodeMorph — Analytics Controller
// ============================================================
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

import { AnalyticsService } from './analytics.service';
import { JwtAuthGuard }     from '../../common/guards/jwt-auth.guard';
import { CurrentUser }      from '../../common/decorators/current-user.decorator';
import type { JwtPayload }  from '@codemorph/shared';

@ApiTags('analytics')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT')
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Get dashboard stats' })
  async getDashboardStats(@CurrentUser() user: JwtPayload): Promise<unknown> {
    return this.analyticsService.getDashboardStats(user.sub);
  }

  @Get('timeline')
  @ApiOperation({ summary: 'Get usage timeline' })
  async getTimeline(
    @CurrentUser() user: JwtPayload,
    @Query('period') period: 'week' | 'month' | 'year' = 'month',
  ): Promise<unknown> {
    return this.analyticsService.getUsageTimeline(user.sub, period);
  }
}
