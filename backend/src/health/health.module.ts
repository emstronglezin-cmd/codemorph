// ============================================================
// CodeMorph — Health Module
// FIX PHASE 4 — OBS-02 : import BullModule pour health check
// ============================================================
import { Module }     from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HttpModule }     from '@nestjs/axios';
import { BullModule }     from '@nestjs/bull';

import { HealthController } from './health.controller';

@Module({
  imports: [
    TerminusModule,
    HttpModule,
    // FIX PHASE 4 : enregistrement de la queue 'conversion' pour health check
    BullModule.registerQueue({ name: 'conversion' }),
  ],
  controllers: [HealthController],
})
export class HealthModule {}
