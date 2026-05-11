// ============================================================
// CodeMorph — Admin Service
// Dashboard analytics for operators
// ============================================================
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, Between } from 'typeorm';
import { UserEntity } from '../users/entities/user.entity';
import { JobEntity, JobStatus } from '../jobs/jobs.entity';
import { SubscriptionEntity, SubscriptionStatus } from '../subscription/subscription.entity';
import { UsageQuotaEntity } from '../quota/quota.entity';
import { CacheService } from '../../cache/cache.service';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    @InjectRepository(JobEntity)
    private readonly jobRepo: Repository<JobEntity>,
    @InjectRepository(SubscriptionEntity)
    private readonly subRepo: Repository<SubscriptionEntity>,
    @InjectRepository(UsageQuotaEntity)
    private readonly quotaRepo: Repository<UsageQuotaEntity>,
    private readonly cache: CacheService,
  ) {}

  // ── Platform overview ────────────────────────────────────
  async getOverview() {
    return this.cache.remember('admin:overview', async () => {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const last24h = new Date(Date.now() - 86_400_000);
      const last7d  = new Date(Date.now() - 7 * 86_400_000);

      const [
        totalUsers,
        newUsersMonth,
        newUsersToday,
        totalJobs,
        jobsMonth,
        jobsToday,
        doneJobs,
        failedJobs,
        activeSubscriptions,
        planCounts,
        aiUsageMonth,
      ] = await Promise.all([
        this.userRepo.count(),
        this.userRepo.count({ where: { createdAt: MoreThan(startOfMonth) } }),
        this.userRepo.count({ where: { createdAt: MoreThan(last24h) } }),
        this.jobRepo.count(),
        this.jobRepo.count({ where: { createdAt: MoreThan(startOfMonth) } }),
        this.jobRepo.count({ where: { createdAt: MoreThan(last24h) } }),
        this.jobRepo.count({ where: { status: JobStatus.DONE } }),
        this.jobRepo.count({ where: { status: JobStatus.FAILED } }),
        this.subRepo.count({ where: { status: SubscriptionStatus.ACTIVE } }),
        this.userRepo
          .createQueryBuilder('u')
          .select('u.plan', 'plan')
          .addSelect('COUNT(*)', 'count')
          .groupBy('u.plan')
          .getRawMany<{ plan: string; count: string }>(),
        this.quotaRepo
          .createQueryBuilder('q')
          .select('SUM(q.aiRequestsUsed)', 'requests')
          .addSelect('SUM(q.aiTokensUsed)', 'tokens')
          .addSelect('SUM(q.conversionsUsed)', 'conversions')
          .where('q.periodStart >= :start', { start: startOfMonth })
          .getRawOne<{ requests: string; tokens: string; conversions: string }>(),
      ]);

      const successRate = totalJobs > 0
        ? Math.round((doneJobs / totalJobs) * 100)
        : 0;

      return {
        users: {
          total:        totalUsers,
          newThisMonth: newUsersMonth,
          newToday:     newUsersToday,
          byPlan:       Object.fromEntries(planCounts.map((r) => [r.plan, parseInt(r.count, 10)])),
        },
        jobs: {
          total:         totalJobs,
          thisMonth:     jobsMonth,
          today:         jobsToday,
          done:          doneJobs,
          failed:        failedJobs,
          successRate:   `${successRate}%`,
        },
        subscriptions: {
          active:        activeSubscriptions,
          freeUsers:     (planCounts.find((p) => p.plan === 'free')?.count ?? 0),
          proUsers:      (planCounts.find((p) => p.plan === 'pro')?.count ?? 0),
          proMaxUsers:   (planCounts.find((p) => p.plan === 'pro_max')?.count ?? 0),
        },
        aiUsage: {
          requestsThisMonth:   parseInt(aiUsageMonth?.requests ?? '0', 10),
          tokensThisMonth:     parseInt(aiUsageMonth?.tokens ?? '0', 10),
          conversionsThisMonth: parseInt(aiUsageMonth?.conversions ?? '0', 10),
        },
        generatedAt: now.toISOString(),
      };
    }, CacheService.TTL.SHORT);
  }

  // ── User list (paginated) ────────────────────────────────
  async getUsers(page = 1, limit = 20, search?: string) {
    const qb = this.userRepo
      .createQueryBuilder('u')
      .orderBy('u.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (search) {
      qb.where('u.email ILIKE :s OR u.name ILIKE :s', { s: `%${search}%` });
    }

    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // ── Job list (paginated, with filters) ──────────────────
  async getJobs(page = 1, limit = 20, status?: JobStatus) {
    const where = status ? { status } : {};
    const [data, total] = await this.jobRepo.findAndCount({
      where,
      order:    { createdAt: 'DESC' },
      skip:     (page - 1) * limit,
      take:     limit,
      relations: ['user'],
    });
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // ── Conversion timeline (last 30 days) ───────────────────
  async getConversionTimeline() {
    return this.cache.remember('admin:conv_timeline', async () => {
      const since = new Date(Date.now() - 30 * 86_400_000);
      const raw = await this.jobRepo
        .createQueryBuilder('j')
        .select("DATE_TRUNC('day', j.createdAt)", 'day')
        .addSelect('COUNT(*)', 'total')
        .addSelect(`COUNT(*) FILTER (WHERE j.status = 'done')`, 'done')
        .addSelect(`COUNT(*) FILTER (WHERE j.status = 'failed')`, 'failed')
        .where('j.createdAt >= :since', { since })
        .groupBy("DATE_TRUNC('day', j.createdAt)")
        .orderBy("DATE_TRUNC('day', j.createdAt)", 'ASC')
        .getRawMany<{ day: string; total: string; done: string; failed: string }>();

      return raw.map((r) => ({
        day:    r.day.slice(0, 10),
        total:  parseInt(r.total, 10),
        done:   parseInt(r.done, 10),
        failed: parseInt(r.failed, 10),
      }));
    }, CacheService.TTL.MEDIUM);
  }

  // ── AI usage by day ──────────────────────────────────────
  async getAiUsageTimeline() {
    return this.cache.remember('admin:ai_timeline', async () => {
      const since = new Date(Date.now() - 30 * 86_400_000);
      return this.jobRepo
        .createQueryBuilder('j')
        .select("DATE_TRUNC('day', j.createdAt)", 'day')
        .addSelect('COUNT(*)', 'aiRequests')
        .addSelect('SUM(j.filesGenerated)', 'filesGenerated')
        .addSelect('SUM(j.linesGenerated)', 'linesGenerated')
        .where('j.createdAt >= :since', { since })
        .andWhere('j.status = :status', { status: JobStatus.DONE })
        .groupBy("DATE_TRUNC('day', j.createdAt)")
        .orderBy("DATE_TRUNC('day', j.createdAt)", 'ASC')
        .getRawMany();
    }, CacheService.TTL.MEDIUM);
  }

  // ── Top users by usage ───────────────────────────────────
  async getTopUsers(limit = 10) {
    return this.quotaRepo
      .createQueryBuilder('q')
      .select('q.userId', 'userId')
      .addSelect('u.email', 'email')
      .addSelect('u.name', 'name')
      .addSelect('u.plan', 'plan')
      .addSelect('SUM(q.conversionsUsed)', 'conversions')
      .addSelect('SUM(q.aiTokensUsed)', 'tokens')
      .leftJoin('users', 'u', 'u.id = q.userId')
      .groupBy('q.userId, u.email, u.name, u.plan')
      .orderBy('SUM(q.conversionsUsed)', 'DESC')
      .limit(limit)
      .getRawMany();
  }

  // ── Error summary (failed jobs) ──────────────────────────
  async getErrorSummary() {
    return this.cache.remember('admin:errors', async () => {
      const since = new Date(Date.now() - 7 * 86_400_000);
      return this.jobRepo
        .createQueryBuilder('j')
        .select('j.errorMessage', 'error')
        .addSelect('COUNT(*)', 'count')
        .where('j.status = :status', { status: JobStatus.FAILED })
        .andWhere('j.createdAt >= :since', { since })
        .andWhere('j.errorMessage IS NOT NULL')
        .groupBy('j.errorMessage')
        .orderBy('COUNT(*)', 'DESC')
        .limit(20)
        .getRawMany<{ error: string; count: string }>();
    }, CacheService.TTL.SHORT);
  }

  // ── Force cancel stuck job ───────────────────────────────
  async forceFailJob(jobId: string, reason: string): Promise<void> {
    await this.jobRepo.update(jobId, {
      status:       JobStatus.FAILED,
      errorMessage: `[Admin] ${reason}`,
      completedAt:  new Date(),
    });
    this.logger.warn(`Admin force-failed job ${jobId}: ${reason}`);
  }
}
