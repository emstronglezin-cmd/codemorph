// ============================================================
// CodeMorph — Observability Module (global)
// ============================================================
import { Global, Module }   from '@nestjs/common';
import { TypeOrmModule }    from '@nestjs/typeorm';

import { LoggerService }        from './logger.service';
import { ErrorTrackingService } from './error-tracking.service';
import { MetricsService }       from './metrics.service';
import { JobEntity }            from '../modules/jobs/jobs.entity';
import { UsageQuotaEntity }     from '../modules/quota/quota.entity';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([JobEntity, UsageQuotaEntity]),
  ],
  providers: [
    LoggerService,
    ErrorTrackingService,
    MetricsService,
  ],
  exports: [
    LoggerService,
    ErrorTrackingService,
    MetricsService,
  ],
})
export class ObservabilityModule {}
