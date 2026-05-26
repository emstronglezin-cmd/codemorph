import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, ManyToOne, JoinColumn, Index, Unique,
} from 'typeorm';
import { UserEntity } from '../users/entities/user.entity';

@Entity('usage_quotas')
@Index(['userId', 'periodStart'])
@Unique(['userId', 'periodStart'])
export class UsageQuotaEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;
  @Column()
  userId!: string;
  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: UserEntity;
  // Billing period (YYYY-MM-01 normalized)
  @Column({ type: 'date' })
  periodStart!: Date;
  @Column({ type: 'date' })
  periodEnd!: Date;
  // Conversion usage
  @Column({ type: 'int', default: 0 })
  conversionsUsed!: number;
  @Column({ type: 'int', default: 0 })
  conversionsLimit!: number;  // snapshot of plan limit at period start

  // AI tokens/requests
  @Column({ type: 'int', default: 0 })
  aiRequestsUsed!: number;
  @Column({ type: 'int', default: 0 })
  aiTokensUsed!: number;
  // Storage
  @Column({ type: 'bigint', default: 0 })
  storageBytesUsed!: string;  // stored as string due to bigint

  // Files processed
  @Column({ type: 'int', default: 0 })
  filesProcessed!: number;
  @Column({ type: 'int', default: 0 })
  linesProcessed!: number;
  // Plan snapshot
  @Column({ length: 32 })
  plan!: string;
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
