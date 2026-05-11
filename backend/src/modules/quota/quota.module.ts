import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsageQuotaEntity } from './quota.entity';
import { QuotaService } from './quota.service';

@Module({
  imports: [TypeOrmModule.forFeature([UsageQuotaEntity])],
  providers: [QuotaService],
  exports: [QuotaService],
})
export class QuotaModule {}
