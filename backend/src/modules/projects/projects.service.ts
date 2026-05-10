// ============================================================
// CodeMorph — Projects Service
// ============================================================
import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import type { UserId, ProjectId } from '@codemorph/shared';
import { buildPaginationMeta } from '@codemorph/shared';
import { ProjectEntity } from './entities/project.entity';

interface CreateProjectInput {
  name: string;
  description?: string | null;
  sourceLanguage: ProjectEntity['sourceLanguage'];
  targetLanguage: ProjectEntity['targetLanguage'];
  ownerId: UserId;
  orgId?: string | null;
}

@Injectable()
export class ProjectsService {
  constructor(
    @InjectRepository(ProjectEntity)
    private readonly projectsRepo: Repository<ProjectEntity>,
  ) {}

  async create(input: CreateProjectInput): Promise<ProjectEntity> {
    const project = this.projectsRepo.create({
      id:             uuidv4(),
      name:           input.name,
      description:    input.description ?? null,
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      ownerId:        input.ownerId as string,
      orgId:          input.orgId ?? null,
      status:         'active',
    });
    return this.projectsRepo.save(project);
  }

  async findAllByOwner(
    ownerId: UserId,
    page = 1,
    limit = 20,
  ): Promise<{ data: ProjectEntity[]; meta: ReturnType<typeof buildPaginationMeta> }> {
    const [data, total] = await this.projectsRepo.findAndCount({
      where: { ownerId: ownerId as string },
      skip:  (page - 1) * limit,
      take:  limit,
      order: { createdAt: 'DESC' },
    });
    return { data, meta: buildPaginationMeta(total, page, limit) };
  }

  async findById(id: ProjectId): Promise<ProjectEntity | null> {
    return this.projectsRepo.findOne({ where: { id: id as string } });
  }

  async findByIdOrFail(id: ProjectId, userId: UserId): Promise<ProjectEntity> {
    const project = await this.findById(id);
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    if (project.ownerId !== (userId as string)) {
      throw new ForbiddenException('Access denied');
    }
    return project;
  }

  async update(
    id: ProjectId,
    userId: UserId,
    input: Partial<Pick<ProjectEntity, 'name' | 'description' | 'status'>>,
  ): Promise<ProjectEntity> {
    const project = await this.findByIdOrFail(id, userId);
    Object.assign(project, input);
    return this.projectsRepo.save(project);
  }

  async delete(id: ProjectId, userId: UserId): Promise<void> {
    const project = await this.findByIdOrFail(id, userId);
    await this.projectsRepo.remove(project);
  }

  async updateStatus(id: ProjectId, status: ProjectEntity['status']): Promise<void> {
    await this.projectsRepo.update(id as string, { status });
  }
}
