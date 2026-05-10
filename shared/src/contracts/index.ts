// ============================================================
// CodeMorph — API Contracts (frontend ↔ backend interface)
// ============================================================
import type { AuthTokens, IRDocument, OrgBase, OrgMember, PaginatedResponse, ProjectBase, UserBase } from '../types/index.js';

// ── Auth Contracts ────────────────────────────────────────
export interface SignUpRequest {
  name: string;
  email: string;
  password: string;
  acceptTerms: true;
}

export interface SignUpResponse {
  user: UserBase;
  tokens: AuthTokens;
  message: string;
}

export interface SignInRequest {
  email: string;
  password: string;
  rememberMe?: boolean;
}

export interface SignInResponse {
  user: UserBase;
  tokens: AuthTokens;
}

export interface RefreshTokenRequest {
  refreshToken: string;
}

export interface RefreshTokenResponse {
  tokens: AuthTokens;
}

export interface ForgotPasswordRequest {
  email: string;
}

export interface ResetPasswordRequest {
  token: string;
  password: string;
  confirmPassword: string;
}

// ── User Contracts ────────────────────────────────────────
export interface GetMeResponse {
  user: UserBase;
}

export interface UpdateProfileRequest {
  name?: string;
  avatarUrl?: string | null;
}

export interface UpdateProfileResponse {
  user: UserBase;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

// ── Organization Contracts ────────────────────────────────
export interface CreateOrgRequest {
  name: string;
  slug: string;
  logoUrl?: string | null;
}

export interface CreateOrgResponse {
  org: OrgBase;
}

export interface GetOrgResponse {
  org: OrgBase;
}

export interface UpdateOrgRequest {
  name?: string;
  logoUrl?: string | null;
}

export interface GetOrgMembersResponse {
  members: OrgMember[];
}

export interface InviteMemberRequest {
  email: string;
  role: 'admin' | 'member' | 'viewer';
}

// ── Project Contracts ─────────────────────────────────────
export interface CreateProjectRequest {
  name: string;
  description?: string | null;
  sourceLanguage: ProjectBase['sourceLanguage'];
  targetLanguage: ProjectBase['targetLanguage'];
  orgId?: string;
}

export interface CreateProjectResponse {
  project: ProjectBase;
}

export interface GetProjectResponse {
  project: ProjectBase;
}

export interface GetProjectsResponse extends PaginatedResponse<ProjectBase> {}

export interface UpdateProjectRequest {
  name?: string;
  description?: string | null;
}

// ── Conversion Contracts ──────────────────────────────────
export interface StartConversionRequest {
  projectId: string;
  irDocument: IRDocument;
  options?: ConversionOptions;
}

export interface ConversionOptions {
  preserveComments: boolean;
  generateTests: boolean;
  addTypeAnnotations: boolean;
  strictMode: boolean;
  targetFramework?: string;
}

export interface ConversionJobResponse {
  jobId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  projectId: string;
  progress?: number;
  estimatedCompletionMs?: number;
  startedAt: string;
}

export interface ConversionResultResponse {
  jobId: string;
  status: 'completed' | 'failed';
  projectId: string;
  output?: ConversionOutput;
  error?: string;
  duration: number;
  completedAt: string;
}

export interface ConversionOutput {
  files: ConvertedFile[];
  summary: ConversionSummary;
  irDocument: IRDocument;
}

export interface ConvertedFile {
  originalPath: string;
  convertedPath: string;
  language: string;
  content: string;
  linesConverted: number;
  warnings: string[];
}

export interface ConversionSummary {
  totalFiles: number;
  successfulFiles: number;
  failedFiles: number;
  totalLines: number;
  convertedLines: number;
  duration: number;
  tokensUsed: number;
}

// ── AI Engine Contracts ───────────────────────────────────
export interface ParseIRRequest {
  sourceCode: string;
  sourceLanguage: string;
  targetLanguage: string;
  context?: string;
}

export interface ParseIRResponse {
  irDocument: IRDocument;
  confidence: number;
  warnings: string[];
  processingTime: number;
}

export interface GenerateCodeRequest {
  irDocument: IRDocument;
  targetLanguage: string;
  options: ConversionOptions;
}

export interface GenerateCodeResponse {
  files: ConvertedFile[];
  tokensUsed: number;
  processingTime: number;
}

// ── Analytics Contracts ───────────────────────────────────
export interface UsageStats {
  projectsCount: number;
  conversionsCount: number;
  tokensUsed: number;
  successRate: number;
  period: 'day' | 'week' | 'month' | 'year';
}

export interface DashboardStats {
  totalProjects: number;
  activeConversions: number;
  completedConversions: number;
  tokensUsedThisMonth: number;
  tokensLimitThisMonth: number;
  successRate: number;
}
