// ============================================================
// CodeMorph — Analytics Service
// ============================================================
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';

import type { UserId } from '@codemorph/shared';
import { ConversionJobEntity } from '../conversions/entities/conversion-job.entity';
import { ProjectEntity }       from '../projects/entities/project.entity';

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectRepository(ConversionJobEntity)
    private readonly jobsRepo: Repository<ConversionJobEntity>,
    @InjectRepository(ProjectEntity)
    private readonly projectsRepo: Repository<ProjectEntity>,
  ) {}

  async getDashboardStats(userId: UserId): Promise<{
    totalProjects:         number;
    activeConversions:     number;
    completedConversions:  number;
    tokensUsedThisMonth:   number;
    successRate:           number;
  }> {
    const userIdStr = userId as string;

    const [totalProjects, activeConversions, jobs] = await Promise.all([
      this.projectsRepo.count({ where: { ownerId: userIdStr } }),
      this.jobsRepo.count({ where: [
        { status: 'pending',    project: { ownerId: userIdStr } },
        { status: 'processing', project: { ownerId: userIdStr } },
      ]}),
      this.jobsRepo.find({
        where:    { project: { ownerId: userIdStr } },
        relations: ['project'],
        select:   ['status', 'tokensUsed', 'createdAt'],
      }),
    ]);

    const now       = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const completedJobs    = jobs.filter((j) => j.status === 'completed');
    const failedJobs       = jobs.filter((j) => j.status === 'failed');
    const tokensUsedThisMonth = jobs
      .filter((j) => new Date(j.createdAt) >= monthStart)
      .reduce((sum, j) => sum + (j.tokensUsed ?? 0), 0);

    const totalFinished = completedJobs.length + failedJobs.length;
    const successRate   = totalFinished > 0
      ? Math.round((completedJobs.length / totalFinished) * 100)
      : 100;

    return {
      totalProjects,
      activeConversions,
      completedConversions: completedJobs.length,
      tokensUsedThisMonth,
      successRate,
    };
  }

  async getUsageTimeline(
    userId: UserId,
    period: 'week' | 'month' | 'year' = 'month',
  ): Promise<Array<{ date: string; conversions: number; tokens: number }>> {
    const now   = new Date();
    const start = new Date(now);

    if (period === 'week')  start.setDate(now.getDate() - 7);
    if (period === 'month') start.setMonth(now.getMonth() - 1);
    if (period === 'year')  start.setFullYear(now.getFullYear() - 1);

    const jobs = await this.jobsRepo.find({
      where: {
        project:   { ownerId: userId as string },
        createdAt: Between(start, now),
      },
      relations: ['project'],
      select:    ['createdAt', 'tokensUsed', 'status'],
    });

    // Group by date
    const grouped = new Map<string, { conversions: number; tokens: number }>();
    jobs.forEach((job) => {
      const key = new Date(job.createdAt).toISOString().split('T')[0] ?? '';
      const existing = grouped.get(key) ?? { conversions: 0, tokens: 0 };
      grouped.set(key, {
        conversions: existing.conversions + 1,
        tokens:      existing.tokens + (job.tokensUsed ?? 0),
      });
    });

    return Array.from(grouped.entries())
      .map(([date, data]) => ({ date, ...data }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }
}
