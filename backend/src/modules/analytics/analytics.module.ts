// ============================================================
// CodeMorph — Analytics Module
// ============================================================
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AnalyticsController } from './analytics.controller';
import { AnalyticsService }    from './analytics.service';
import { ConversionJobEntity } from '../conversions/entities/conversion-job.entity';
import { ProjectEntity }       from '../projects/entities/project.entity';
import { UserEntity }          from '../users/entities/user.entity';

@Module({
  imports:     [TypeOrmModule.forFeature([ConversionJobEntity, ProjectEntity, UserEntity])],
  controllers: [AnalyticsController],
  providers:   [AnalyticsService],
  exports:     [AnalyticsService],
})
export class AnalyticsModule {}
