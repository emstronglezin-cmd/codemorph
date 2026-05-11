// ============================================================
// CodeMorph — Users Service
// ============================================================
import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import type { UserId } from '@codemorph/shared';
import { UserEntity } from './entities/user.entity';

interface CreateUserInput {
  name: string;
  email: string;
  passwordHash: string;
  avatarUrl?: string | null;
  oauthProvider?: string | null;
  oauthProviderId?: string | null;
  githubAccessToken?: string | null;
  status?: UserEntity['status'];
  emailVerified?: boolean;
}

interface UpdateUserInput {
  name?: string;
  avatarUrl?: string | null;
  status?: UserEntity['status'];
  emailVerified?: boolean;
  stripeCustomerId?: string;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly usersRepo: Repository<UserEntity>,
  ) {}

  // ── Create ────────────────────────────────────────────
  async create(input: CreateUserInput): Promise<UserEntity> {
    const existing = await this.findByEmail(input.email);
    if (existing) throw new ConflictException('Email already in use');

    const user = this.usersRepo.create({
      id:              uuidv4(),
      name:            input.name,
      email:           input.email.toLowerCase().trim(),
      passwordHash:    input.passwordHash,
      avatarUrl:       input.avatarUrl ?? null,
      oauthProvider:   input.oauthProvider ?? null,
      oauthProviderId: input.oauthProviderId ?? null,
      githubAccessToken: input.githubAccessToken ?? null,
      role:            'member',
      plan:            'free',
      status:          input.status ?? 'pending_verification',
      emailVerified:   input.emailVerified ?? false,
    });

    return this.usersRepo.save(user);
  }

  // ── Find by ID ────────────────────────────────────────
  async findById(id: UserId): Promise<UserEntity | null> {
    return this.usersRepo.findOne({ where: { id: id as string } });
  }

  // ── Find by ID (throws) ───────────────────────────────
  async findByIdOrFail(id: UserId): Promise<UserEntity> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException(`User ${id} not found`);
    return user;
  }

  // ── Find by email ─────────────────────────────────────
  async findByEmail(email: string): Promise<UserEntity | null> {
    return this.usersRepo
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.email = :email', { email: email.toLowerCase().trim() })
      .getOne();
  }

  // ── Update ────────────────────────────────────────────
  async update(id: UserId, input: UpdateUserInput): Promise<UserEntity> {
    const user = await this.findByIdOrFail(id);
    Object.assign(user, input);
    return this.usersRepo.save(user);
  }

  // ── Update last login ────────────────────────────────
  async updateLastLogin(id: UserId): Promise<void> {
    await this.usersRepo.update(id as string, { lastLoginAt: new Date() });
  }

  // ── Update password ───────────────────────────────────
  async updatePassword(id: UserId, passwordHash: string): Promise<void> {
    await this.usersRepo.update(id as string, { passwordHash });
  }

  // ── Soft delete ───────────────────────────────────────
  async deactivate(id: UserId): Promise<void> {
    await this.usersRepo.update(id as string, { status: 'inactive' });
  }

  // ── Find by OAuth provider ────────────────────────────
  async findByOAuth(provider: string, providerId: string): Promise<UserEntity | null> {
    return this.usersRepo.findOne({
      where: { oauthProvider: provider, oauthProviderId: providerId },
    });
  }

  // ── Update OAuth info ─────────────────────────────────
  async updateOAuth(
    id: string,
    data: {
      oauthProvider?: string | null;
      oauthProviderId?: string | null;
      avatarUrl?: string | null;
      githubAccessToken?: string | null;
      status?: UserEntity['status'];
    },
  ): Promise<void> {
    await this.usersRepo.update(id, data);
  }

  // ── Find by Stripe customer ID ────────────────────────
  async findByStripeCustomerId(customerId: string): Promise<UserEntity | null> {
    return this.usersRepo.findOne({ where: { stripeCustomerId: customerId } });
  }

  // ── Count ─────────────────────────────────────────────
  async count(): Promise<number> {
    return this.usersRepo.count();
  }

  // ── Paginated list (admin) ────────────────────────────
  async findAll(page = 1, limit = 20): Promise<{ data: UserEntity[]; total: number }> {
    const [data, total] = await this.usersRepo.findAndCount({
      skip:  (page - 1) * limit,
      take:  limit,
      order: { createdAt: 'DESC' },
    });
    return { data, total };
  }
}
