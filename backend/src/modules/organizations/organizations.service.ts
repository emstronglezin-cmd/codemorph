// ============================================================
// CodeMorph — Organizations Service
// ============================================================
import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import type { UserId, OrgId } from '@codemorph/shared';
import { OrganizationEntity } from './entities/organization.entity';
import { OrgMemberEntity }    from './entities/org-member.entity';

@Injectable()
export class OrganizationsService {
  constructor(
    @InjectRepository(OrganizationEntity)
    private readonly orgsRepo: Repository<OrganizationEntity>,
    @InjectRepository(OrgMemberEntity)
    private readonly membersRepo: Repository<OrgMemberEntity>,
  ) {}

  async create(input: { name: string; slug: string; logoUrl?: string | null }, ownerId: UserId): Promise<OrganizationEntity> {
    const existing = await this.orgsRepo.findOne({ where: { slug: input.slug } });
    if (existing) throw new ConflictException('Organization slug already taken');

    const org = this.orgsRepo.create({
      id:      uuidv4(),
      name:    input.name,
      slug:    input.slug,
      logoUrl: input.logoUrl ?? null,
      plan:    'free',
      ownerId: ownerId as string,
    });
    const saved = await this.orgsRepo.save(org);

    // Add owner as first member
    await this.membersRepo.save(this.membersRepo.create({
      id:     uuidv4(),
      orgId:  saved.id,
      userId: ownerId as string,
      role:   'owner',
    }));

    return saved;
  }

  async findById(id: OrgId): Promise<OrganizationEntity | null> {
    return this.orgsRepo.findOne({ where: { id: id as string } });
  }

  async findByIdOrFail(id: OrgId): Promise<OrganizationEntity> {
    const org = await this.findById(id);
    if (!org) throw new NotFoundException(`Organization ${id} not found`);
    return org;
  }

  async findBySlug(slug: string): Promise<OrganizationEntity | null> {
    return this.orgsRepo.findOne({ where: { slug } });
  }

  async findByUser(userId: UserId): Promise<OrganizationEntity[]> {
    const members = await this.membersRepo.find({
      where: { userId: userId as string },
      relations: ['org'],
    });
    return members.map((m) => m.org);
  }

  async update(id: OrgId, input: { name?: string; logoUrl?: string | null }, userId: UserId): Promise<OrganizationEntity> {
    const org = await this.findByIdOrFail(id);
    if (org.ownerId !== (userId as string)) throw new ForbiddenException('Only the owner can update the organization');
    Object.assign(org, input);
    return this.orgsRepo.save(org);
  }

  async getMembers(id: OrgId): Promise<OrgMemberEntity[]> {
    return this.membersRepo.find({
      where: { orgId: id as string },
      relations: ['user'],
      order: { joinedAt: 'ASC' },
    });
  }

  async addMember(orgId: OrgId, userId: UserId, role: OrgMemberEntity['role'] = 'member'): Promise<OrgMemberEntity> {
    const existing = await this.membersRepo.findOne({
      where: { orgId: orgId as string, userId: userId as string },
    });
    if (existing) throw new ConflictException('User is already a member');

    const member = this.membersRepo.create({
      id:     uuidv4(),
      orgId:  orgId as string,
      userId: userId as string,
      role,
    });
    return this.membersRepo.save(member);
  }

  async removeMember(orgId: OrgId, userId: UserId, requesterId: UserId): Promise<void> {
    const org = await this.findByIdOrFail(orgId);
    if (org.ownerId !== (requesterId as string)) throw new ForbiddenException('Only the owner can remove members');
    if (userId === requesterId) throw new ForbiddenException('Owner cannot remove themselves');

    const member = await this.membersRepo.findOne({
      where: { orgId: orgId as string, userId: userId as string },
    });
    if (!member) throw new NotFoundException('Member not found');
    await this.membersRepo.remove(member);
  }
}
