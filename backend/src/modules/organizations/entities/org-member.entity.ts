// ============================================================
// CodeMorph — OrgMember Entity (TypeORM)
// ============================================================
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { UserEntity }         from '../../users/entities/user.entity';
import { OrganizationEntity } from './organization.entity';

@Entity('org_members')
@Index(['orgId', 'userId'], { unique: true })
export class OrgMemberEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'org_id' })
  orgId!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org!: OrganizationEntity;

  @Column({ name: 'user_id' })
  userId!: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: UserEntity;

  @Column({
    type: 'enum',
    enum: ['owner', 'admin', 'member', 'viewer'],
    default: 'member',
  })
  role!: 'owner' | 'admin' | 'member' | 'viewer';

  @CreateDateColumn({ name: 'joined_at', type: 'timestamptz' })
  joinedAt!: Date;
}
