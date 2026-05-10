// ============================================================
// CodeMorph — Conversions Module
// ============================================================
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';

import { ConversionsController } from './conversions.controller';
import { ConversionsService }    from './conversions.service';
import { ConversionJobEntity }   from './entities/conversion-job.entity';
import { ProjectsModule }        from '../projects/projects.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ConversionJobEntity]),
    HttpModule,
    ConfigModule,
    ProjectsModule,
  ],
  controllers: [ConversionsController],
  providers:   [ConversionsService],
  exports:     [ConversionsService],
})
export class ConversionsModule {}
