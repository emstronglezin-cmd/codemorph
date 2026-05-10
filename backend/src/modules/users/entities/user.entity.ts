// ============================================================
// CodeMorph — User Entity (TypeORM)
// ============================================================
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  OneToMany,
} from 'typeorm';

@Entity('users')
@Index(['email'], { unique: true })
export class UserEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ length: 100 })
  name!: string;

  @Column({ unique: true, length: 255 })
  email!: string;

  @Column({ name: 'password_hash', select: false })
  passwordHash!: string;

  @Column({ name: 'avatar_url', nullable: true, length: 500 })
  avatarUrl!: string | null;

  @Column({
    type: 'enum',
    enum: ['owner', 'admin', 'member', 'viewer'],
    default: 'member',
  })
  role!: 'owner' | 'admin' | 'member' | 'viewer';

  @Column({
    type: 'enum',
    enum: ['free', 'starter', 'pro', 'enterprise'],
    default: 'free',
  })
  plan!: 'free' | 'starter' | 'pro' | 'enterprise';

  @Column({
    type: 'enum',
    enum: ['active', 'inactive', 'suspended', 'pending_verification'],
    default: 'pending_verification',
  })
  status!: 'active' | 'inactive' | 'suspended' | 'pending_verification';

  @Column({ name: 'email_verified', default: false })
  emailVerified!: boolean;

  @Column({ name: 'last_login_at', nullable: true, type: 'timestamptz' })
  lastLoginAt!: Date | null;

  @Column({ name: 'stripe_customer_id', nullable: true, length: 100 })
  stripeCustomerId!: string | null;

  // ── OAuth fields ──────────────────────────────────────────
  @Column({ name: 'oauth_provider', nullable: true, length: 32 })
  oauthProvider!: string | null;

  @Column({ name: 'oauth_provider_id', nullable: true, length: 255 })
  oauthProviderId!: string | null;

  @Column({ name: 'github_access_token', nullable: true, length: 512, select: false })
  githubAccessToken!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
