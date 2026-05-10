import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { UserEntity } from '../users/entities/user.entity';
import { ProjectEntity } from '../projects/entities/project.entity';

export enum JobStatus {
  PENDING = 'pending',
  ANALYZING = 'analyzing',
  CONVERTING = 'converting',
  DONE = 'done',
  FAILED = 'failed',
}

export enum JobType {
  GITHUB_IMPORT = 'github_import',
  ZIP_IMPORT = 'zip_import',
  URL_IMPORT = 'url_import',
  CONVERSION = 'conversion',
}

@Entity('jobs')
@Index(['userId', 'status'])
@Index(['projectId', 'createdAt'])
export class JobEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: JobType })
  type: JobType;

  @Column({ type: 'enum', enum: JobStatus, default: JobStatus.PENDING })
  status: JobStatus;

  @Column({ nullable: true })
  sourceLanguage: string;

  @Column({ nullable: true })
  targetLanguage: string;

  @Column({ nullable: true })
  sourceRepo: string;

  @Column({ nullable: true })
  sourceBranch: string;

  @Column({ nullable: true })
  zipPath: string;

  @Column({ nullable: true })
  aiEngineJobId: string;

  @Column({ type: 'int', default: 0 })
  progress: number;

  @Column({ nullable: true })
  currentPhase: string;

  @Column({ type: 'jsonb', nullable: true })
  phaseLogs: Array<{ phase: string; status: string; message: string; timestamp: string }>;

  @Column({ type: 'jsonb', nullable: true })
  irDocument: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  result: Record<string, unknown>;

  @Column({ nullable: true })
  errorMessage: string;

  @Column({ type: 'jsonb', nullable: true })
  errorDetails: Record<string, unknown>;

  @Column({ nullable: true })
  outputZipPath: string;

  @Column({ nullable: true })
  outputGithubPrUrl: string;

  @Column({ type: 'int', nullable: true })
  filesGenerated: number;

  @Column({ type: 'int', nullable: true })
  linesGenerated: number;

  @Column({ nullable: true })
  startedAt: Date;

  @Column({ nullable: true })
  completedAt: Date;

  @Column()
  userId: string;

  @Column({ nullable: true })
  projectId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: UserEntity;

  @ManyToOne(() => ProjectEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'projectId' })
  project: ProjectEntity;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
