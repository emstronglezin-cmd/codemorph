// ============================================================
// CodeMorph — Organizations Module
// ============================================================
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OrganizationsController } from './organizations.controller';
import { OrganizationsService }    from './organizations.service';
import { OrganizationEntity }      from './entities/organization.entity';
import { OrgMemberEntity }         from './entities/org-member.entity';

@Module({
  imports:     [TypeOrmModule.forFeature([OrganizationEntity, OrgMemberEntity])],
  controllers: [OrganizationsController],
  providers:   [OrganizationsService],
  exports:     [OrganizationsService],
})
export class OrganizationsModule {}
