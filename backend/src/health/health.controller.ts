// ============================================================
// CodeMorph — Health Controller
// FIX PHASE 4 — OBS-02 : Redis + Bull ajoutés au health check
// ============================================================
import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import {
  HealthCheckService,
  HealthCheck,
  TypeOrmHealthIndicator,
  MemoryHealthIndicator,
  DiskHealthIndicator,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { InjectRedis } from '@liaoliaots/nestjs-redis';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import Redis from 'ioredis';
import { Public } from '../common/decorators/public.decorator';

@ApiTags('health')
@SkipThrottle()  // Les health checks ne doivent pas être soumis au rate limiting
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db:     TypeOrmHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
    private readonly disk:   DiskHealthIndicator,

    // FIX PHASE 4 — OBS-02 : inject Redis + Bull pour health check
    @InjectRedis()
    private readonly redis: Redis,

    @InjectQueue('conversion')
    private readonly conversionQueue: Queue,
  ) {}

  // ── Redis health indicator ────────────────────────────
  private async checkRedis(): Promise<HealthIndicatorResult> {
    try {
      const result = await this.redis.ping();
      const isHealthy = result === 'PONG';
      return {
        redis: {
          status:  isHealthy ? 'up' : 'down',
          message: isHealthy ? 'Redis connected' : 'Redis ping failed',
        },
      };
    } catch (err) {
      return {
        redis: {
          status:  'down',
          message: `Redis error: ${(err as Error).message}`,
        },
      };
    }
  }

  // ── Bull queue health indicator ──────────────────────
  private async checkBullQueue(): Promise<HealthIndicatorResult> {
    try {
      const [waiting, active, failed, delayed] = await Promise.all([
        this.conversionQueue.getWaitingCount(),
        this.conversionQueue.getActiveCount(),
        this.conversionQueue.getFailedCount(),
        this.conversionQueue.getDelayedCount(),
      ]);

      const isHealthy = true; // Queue accessible
      return {
        bull_conversion_queue: {
          status:   isHealthy ? 'up' : 'down',
          waiting,
          active,
          failed,
          delayed,
          message:  `Queue healthy — ${waiting} waiting, ${active} active, ${failed} failed`,
        },
      };
    } catch (err) {
      return {
        bull_conversion_queue: {
          status:  'down',
          message: `Bull queue error: ${(err as Error).message}`,
        },
      };
    }
  }

  @Public()
  @Get()
  @HealthCheck()
  @ApiOperation({ summary: 'Full health check (DB + Redis + Bull + Memory + Disk)' })
  async check(): Promise<unknown> {
    return this.health.check([
      () => this.db.pingCheck('database', { timeout: 3000 }),
      () => this.checkRedis(),
      () => this.checkBullQueue(),
      () => this.memory.checkHeap('memory_heap', 512 * 1024 * 1024),
      () => this.memory.checkRSS('memory_rss', 512 * 1024 * 1024),
      () => this.disk.checkStorage('disk', { thresholdPercent: 0.9, path: '/' }),
    ]);
  }

  @Public()
  @Get('live')
  @ApiOperation({ summary: 'Liveness probe' })
  live(): { status: string; timestamp: string } {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Public()
  @Get('ready')
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness probe (database + Redis)' })
  async ready(): Promise<unknown> {
    return this.health.check([
      () => this.db.pingCheck('database', { timeout: 3000 }),
      () => this.checkRedis(),
    ]);
  }
}
