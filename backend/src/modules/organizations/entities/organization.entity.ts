// ============================================================
// CodeMorph — Organization Entity (TypeORM)
// ============================================================
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
  OneToMany,
} from 'typeorm';
import { UserEntity } from '../../users/entities/user.entity';

@Entity('organizations')
@Index(['slug'], { unique: true })
export class OrganizationEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ length: 100 })
  name!: string;

  @Column({ unique: true, length: 64 })
  slug!: string;

  @Column({ name: 'logo_url', nullable: true, length: 500 })
  logoUrl!: string | null;

  @Column({
    type: 'enum',
    enum: ['free', 'pro', 'pro_max'],
    default: 'free',
  })
  plan!: 'free' | 'pro' | 'pro_max';

  @Column({ name: 'owner_id' })
  ownerId!: string;

  @ManyToOne(() => UserEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'owner_id' })
  owner!: UserEntity;

  @Column({ name: 'stripe_subscription_id', nullable: true, length: 100 })
  stripeSubscriptionId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
