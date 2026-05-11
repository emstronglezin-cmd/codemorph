import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { UserEntity } from '../users/entities/user.entity';
import { JobEntity } from '../jobs/jobs.entity';
import { SubscriptionEntity } from '../subscription/subscription.entity';
import { UsageQuotaEntity } from '../quota/quota.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity, JobEntity, SubscriptionEntity, UsageQuotaEntity]),
  ],
  providers: [AdminService],
  controllers: [AdminController],
  exports: [AdminService],
})
export class AdminModule {}
