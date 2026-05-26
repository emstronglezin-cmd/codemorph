import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { UserEntity } from '../users/entities/user.entity';
import { Plan } from './plan-limits.config';

export enum SubscriptionStatus {
  ACTIVE    = 'active',
  TRIALING  = 'trialing',
  PAST_DUE  = 'past_due',
  CANCELED  = 'canceled',
  EXPIRED   = 'expired',
  PAUSED    = 'paused',
}

export enum BillingInterval {
  MONTHLY = 'monthly',
  ANNUAL  = 'annual',
}

export enum BillingProvider {
  STRIPE       = 'stripe',
  LEMONSQUEEZY = 'lemonsqueezy',
  PADDLE       = 'paddle',
  MANUAL       = 'manual',
}

@Entity('subscriptions')
@Index(['userId', 'status'])
@Index(['providerSubscriptionId'])
@Index(['currentPeriodEnd'])
export class SubscriptionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;
  @Column()
  userId!: string;
  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: UserEntity;
  @Column({ type: 'varchar', length: 32 })
  plan!: Plan;
  @Column({ type: 'enum', enum: SubscriptionStatus, default: SubscriptionStatus.ACTIVE })
  status!: SubscriptionStatus;
  @Column({ type: 'enum', enum: BillingInterval, default: BillingInterval.MONTHLY })
  interval!: BillingInterval;
  @Column({ type: 'enum', enum: BillingProvider, default: BillingProvider.STRIPE })
  provider!: BillingProvider;
  // Provider references
  @Column({ nullable: true })
  providerSubscriptionId!: string;
  @Column({ nullable: true })
  providerCustomerId!: string;
  @Column({ nullable: true })
  providerPriceId!: string;
  // Billing period
  @Column({ type: 'timestamptz', nullable: true })
  currentPeriodStart!: Date;
  @Column({ type: 'timestamptz', nullable: true })
  currentPeriodEnd!: Date;
  @Column({ type: 'timestamptz', nullable: true })
  trialEnd!: Date;
  @Column({ type: 'timestamptz', nullable: true })
  canceledAt!: Date;
  @Column({ type: 'timestamptz', nullable: true })
  cancelAtPeriodEnd!: Date;
  // Pricing snapshot (at time of purchase)
  @Column({ type: 'int', default: 0 })
  priceAmountCents!: number;
  @Column({ length: 3, default: 'usd' })
  currency!: string;
  // Metadata
  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown>;
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
