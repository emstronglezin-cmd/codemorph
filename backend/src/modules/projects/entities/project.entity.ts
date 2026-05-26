// ============================================================
// CodeMorph — Project Entity (TypeORM)
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
} from 'typeorm';
import { UserEntity } from '../../users/entities/user.entity';

@Entity('projects')
@Index(['ownerId'])
@Index(['status'])
export class ProjectEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ length: 100 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({
    type: 'enum',
    enum: ['active', 'archived', 'converting', 'completed', 'failed'],
    default: 'active',
  })
  status!: 'active' | 'archived' | 'converting' | 'completed' | 'failed';

  @Column({
    name: 'source_language',
    type: 'enum',
    enum: ['javascript', 'python', 'java', 'csharp', 'php', 'ruby', 'go'],
  })
  sourceLanguage!: 'javascript' | 'python' | 'java' | 'csharp' | 'php' | 'ruby' | 'go';

  @Column({
    name: 'target_language',
    type: 'enum',
    enum: ['typescript', 'rust', 'kotlin', 'swift', 'dart'],
  })
  targetLanguage!: 'typescript' | 'rust' | 'kotlin' | 'swift' | 'dart';

  @Column({ name: 'owner_id' })
  ownerId!: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'owner_id' })
  owner!: UserEntity;

  @Column({ name: 'org_id', nullable: true })
  orgId!: string | null;

  @Column({ name: 'ir_document', type: 'jsonb', nullable: true })
  irDocument!: Record<string, unknown> | null;

  @Column({ name: 'files_count', default: 0 })
  filesCount!: number;

  @Column({ name: 'lines_count', default: 0 })
  linesCount!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
