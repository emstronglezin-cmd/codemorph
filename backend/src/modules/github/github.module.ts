import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { GitHubApiService } from './github-api.service';
import { UserEntity } from '../users/entities/user.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity]),
    HttpModule,
  ],
  providers: [GitHubApiService],
  exports: [GitHubApiService],
})
export class GitHubModule {}
