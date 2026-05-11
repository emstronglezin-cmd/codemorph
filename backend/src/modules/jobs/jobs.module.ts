// ============================================================
// CodeMorph — Jobs Module (with AiEngineClient + Quota)
// ============================================================
import { Module }        from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule }    from '@nestjs/bull';
import { HttpModule }    from '@nestjs/axios';

import { JobEntity }       from './jobs.entity';
import { JobsService }     from './jobs.service';
import { JobsController }  from './jobs.controller';
import { JobsProcessor }   from './jobs.processor';
import { AiEngineClient }  from './ai-engine.client';
import { GitHubModule }    from '../github/github.module';
import { UploadsModule }   from '../uploads/uploads.module';
import { QuotaModule }     from '../quota/quota.module';
import { SubscriptionModule } from '../subscription/subscription.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([JobEntity]),
    BullModule.registerQueue({
      name: 'conversion',
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail:     200,
        attempts:         3,
        backoff: { type: 'exponential', delay: 2_000 },
      },
    }),
    HttpModule.register({ timeout: 130_000, maxRedirects: 3 }),
    GitHubModule,
    UploadsModule,
    QuotaModule,
    SubscriptionModule,
  ],
  providers:   [JobsService, JobsProcessor, AiEngineClient],
  controllers: [JobsController],
  exports:     [JobsService, AiEngineClient],
})
export class JobsModule {}
