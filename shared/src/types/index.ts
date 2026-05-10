// ============================================================
// CodeMorph — Shared Types
// ============================================================

// ── Generic Utilities ─────────────────────────────────────
export type Nullable<T> = T | null;
export type Optional<T> = T | undefined;
export type Maybe<T> = T | null | undefined;
export type DeepPartial<T> = { [P in keyof T]?: DeepPartial<T[P]> };
export type DeepReadonly<T> = { readonly [P in keyof T]: DeepReadonly<T[P]> };
export type NonEmptyArray<T> = [T, ...T[]];
export type Prettify<T> = { [K in keyof T]: T[K] } & {};
export type Brand<T, B extends string> = T & { __brand: B };

// ── Pagination ────────────────────────────────────────────
export interface PaginationMeta {
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly totalPages: number;
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
}

export interface PaginatedResponse<T> {
  readonly data: T[];
  readonly meta: PaginationMeta;
}

export interface PaginationQuery {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  search?: string;
}

// ── API Response ─────────────────────────────────────────
export interface ApiResponse<T = unknown> {
  readonly success: boolean;
  readonly data?: T;
  readonly message?: string;
  readonly errors?: ApiError[];
  readonly meta?: Record<string, unknown>;
  readonly timestamp: string;
  readonly requestId?: string;
}

export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly field?: string;
  readonly details?: Record<string, unknown>;
}

// ── User & Auth ───────────────────────────────────────────
export type UserId = Brand<string, 'UserId'>;
export type OrgId = Brand<string, 'OrgId'>;
export type ProjectId = Brand<string, 'ProjectId'>;

export type UserRole = 'owner' | 'admin' | 'member' | 'viewer';
export type UserPlan = 'free' | 'starter' | 'pro' | 'enterprise';
export type UserStatus = 'active' | 'inactive' | 'suspended' | 'pending_verification';

export interface UserBase {
  readonly id: UserId;
  readonly email: string;
  readonly name: string;
  readonly avatarUrl: Nullable<string>;
  readonly role: UserRole;
  readonly plan: UserPlan;
  readonly status: UserStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly tokenType: 'Bearer';
}

export interface JwtPayload {
  readonly sub: UserId;
  readonly email: string;
  readonly role: UserRole;
  readonly plan: UserPlan;
  readonly orgId?: OrgId;
  readonly iat: number;
  readonly exp: number;
}

// ── Organization ──────────────────────────────────────────
export interface OrgBase {
  readonly id: OrgId;
  readonly name: string;
  readonly slug: string;
  readonly logoUrl: Nullable<string>;
  readonly plan: UserPlan;
  readonly ownerId: UserId;
  readonly memberCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OrgMember {
  readonly userId: UserId;
  readonly orgId: OrgId;
  readonly role: UserRole;
  readonly joinedAt: string;
}

// ── Project ───────────────────────────────────────────────
export type ProjectStatus = 'active' | 'archived' | 'converting' | 'completed' | 'failed';
export type SourceLanguage = 'javascript' | 'python' | 'java' | 'csharp' | 'php' | 'ruby' | 'go';
export type TargetLanguage = 'typescript' | 'rust' | 'kotlin' | 'swift' | 'dart';

export interface ProjectBase {
  readonly id: ProjectId;
  readonly name: string;
  readonly description: Nullable<string>;
  readonly status: ProjectStatus;
  readonly sourceLanguage: SourceLanguage;
  readonly targetLanguage: TargetLanguage;
  readonly ownerId: UserId;
  readonly orgId: Nullable<OrgId>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── IR (Intermediate Representation) ─────────────────────
export interface IRProjectMeta {
  name: string;
  type: 'web' | 'mobile' | 'backend' | 'fullstack' | 'library';
  sourceStack: string;
  targetStack: string;
  complexityScore: number;
  description?: string;
  version?: string;
}

export interface IRArchitecture {
  modules: IRModule[];
  layers: string[];
  patterns: string[];
}

export interface IRModule {
  name: string;
  path: string;
  dependencies: string[];
  exports: string[];
}

export interface IRUIGraph {
  screens: IRScreen[];
  components: IRComponent[];
  navigationFlow: IRNavFlow[];
  stateFlow: IRStateFlow[];
}

export interface IRScreen {
  id: string;
  name: string;
  path: string;
  components: string[];
  guards?: string[];
}

export interface IRComponent {
  id: string;
  name: string;
  type: 'page' | 'layout' | 'feature' | 'ui' | 'shared';
  props?: Record<string, string>;
  children?: string[];
}

export interface IRNavFlow {
  from: string;
  to: string;
  trigger: string;
  guard?: string;
}

export interface IRStateFlow {
  store: string;
  actions: string[];
  selectors: string[];
}

export interface IRBackendGraph {
  routes: IRRoute[];
  services: IRService[];
  entities: IREntity[];
  middlewares: IRMiddleware[];
}

export interface IRRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  handler: string;
  guards?: string[];
  middlewares?: string[];
}

export interface IRService {
  name: string;
  methods: string[];
  dependencies: string[];
}

export interface IREntity {
  name: string;
  fields: IRField[];
  relations?: IRRelation[];
}

export interface IRField {
  name: string;
  type: string;
  nullable?: boolean;
  unique?: boolean;
  default?: string;
}

export interface IRRelation {
  type: 'oneToOne' | 'oneToMany' | 'manyToMany' | 'manyToOne';
  target: string;
  field: string;
}

export interface IRMiddleware {
  name: string;
  scope: 'global' | 'module' | 'route';
}

export interface IRDataLayer {
  models: IREntity[];
  relationships: IRRelation[];
  migrations: IRMigration[];
}

export interface IRMigration {
  name: string;
  description: string;
  order: number;
}

export interface IRDependencyMap {
  keep: string[];
  replace: IRReplacement[];
  remove: string[];
  add: string[];
}

export interface IRReplacement {
  from: string;
  to: string;
  reason: string;
}

export interface IRConversionStep {
  step: number;
  action: string;
  target: string;
  details?: string;
  estimatedTime?: string;
}

export interface IRValidation {
  buildable: boolean;
  testsRequired: boolean;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  warnings?: string[];
  blockers?: string[];
}

export interface IRDocument {
  projectMeta: IRProjectMeta;
  architecture: IRArchitecture;
  uiGraph: IRUIGraph;
  backendGraph: IRBackendGraph;
  dataLayer: IRDataLayer;
  dependencyMap: IRDependencyMap;
  conversionPlan: IRConversionStep[];
  validation: IRValidation;
}

// ── Events ───────────────────────────────────────────────
export type EventType =
  | 'user.created'
  | 'user.updated'
  | 'user.deleted'
  | 'project.created'
  | 'project.updated'
  | 'project.deleted'
  | 'project.conversion.started'
  | 'project.conversion.completed'
  | 'project.conversion.failed'
  | 'org.created'
  | 'org.member.added'
  | 'org.member.removed'
  | 'billing.subscription.created'
  | 'billing.subscription.cancelled';

export interface DomainEvent<T = unknown> {
  readonly id: string;
  readonly type: EventType;
  readonly payload: T;
  readonly occurredAt: string;
  readonly version: number;
}

// ── Feature Flags ────────────────────────────────────────
export interface FeatureFlags {
  readonly aiEngine: boolean;
  readonly billing: boolean;
  readonly teams: boolean;
  readonly analytics: boolean;
  readonly darkMode: boolean;
  readonly betaFeatures: boolean;
}
