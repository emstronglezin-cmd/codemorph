import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { HttpModule } from '@nestjs/axios';
import { JobEntity } from './jobs.entity';
import { JobsService } from './jobs.service';
import { JobsController } from './jobs.controller';
import { JobsProcessor } from './jobs.processor';
import { GitHubModule } from '../github/github.module';
import { UploadsModule } from '../uploads/uploads.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([JobEntity]),
    BullModule.registerQueue({ name: 'conversion' }),
    HttpModule,
    GitHubModule,
    UploadsModule,
  ],
  providers: [JobsService, JobsProcessor],
  controllers: [JobsController],
  exports: [JobsService],
})
export class JobsModule {}
