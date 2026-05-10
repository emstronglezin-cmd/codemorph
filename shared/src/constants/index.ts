// ============================================================
// CodeMorph — Shared Constants
// ============================================================

// ── App ──────────────────────────────────────────────────
export const APP_NAME = 'CodeMorph' as const;
export const APP_VERSION = '1.0.0' as const;
export const APP_DESCRIPTION = 'AI-Powered Code Conversion SaaS' as const;

// ── Pagination ───────────────────────────────────────────
export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
  MIN_LIMIT: 1,
} as const;

// ── Plans & Limits ───────────────────────────────────────
export const PLAN_LIMITS = {
  free: {
    projectsPerMonth: 3,
    filesPerProject: 10,
    maxFileSizeKb: 100,
    aiTokensPerMonth: 10_000,
    teamMembers: 1,
    historyDays: 7,
  },
  starter: {
    projectsPerMonth: 20,
    filesPerProject: 50,
    maxFileSizeKb: 500,
    aiTokensPerMonth: 100_000,
    teamMembers: 5,
    historyDays: 30,
  },
  pro: {
    projectsPerMonth: 100,
    filesPerProject: 500,
    maxFileSizeKb: 5_000,
    aiTokensPerMonth: 1_000_000,
    teamMembers: 25,
    historyDays: 90,
  },
  enterprise: {
    projectsPerMonth: Infinity,
    filesPerProject: Infinity,
    maxFileSizeKb: Infinity,
    aiTokensPerMonth: Infinity,
    teamMembers: Infinity,
    historyDays: Infinity,
  },
} as const;

// ── Auth ─────────────────────────────────────────────────
export const AUTH = {
  TOKEN_HEADER: 'Authorization',
  TOKEN_PREFIX: 'Bearer',
  REFRESH_TOKEN_COOKIE: 'cm_refresh_token',
  SESSION_COOKIE: 'cm_session',
  COOKIE_MAX_AGE: 7 * 24 * 60 * 60, // 7 days in seconds
  PASSWORD_MIN_LENGTH: 8,
  PASSWORD_MAX_LENGTH: 128,
  MAX_LOGIN_ATTEMPTS: 5,
  LOCKOUT_DURATION_MINUTES: 15,
} as const;

// ── API ──────────────────────────────────────────────────
export const API = {
  PREFIX: 'api/v1',
  VERSION: 'v1',
  RATE_LIMIT: {
    PUBLIC: { windowMs: 60_000, max: 60 },
    AUTHENTICATED: { windowMs: 60_000, max: 300 },
    AI: { windowMs: 60_000, max: 10 },
  },
  TIMEOUT_MS: 30_000,
  MAX_PAYLOAD_SIZE: '50mb',
} as const;

// ── HTTP Status ───────────────────────────────────────────
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
} as const;

// ── Error Codes ───────────────────────────────────────────
export const ERROR_CODES = {
  // Auth
  AUTH_INVALID_CREDENTIALS: 'AUTH_001',
  AUTH_TOKEN_EXPIRED: 'AUTH_002',
  AUTH_TOKEN_INVALID: 'AUTH_003',
  AUTH_INSUFFICIENT_PERMISSIONS: 'AUTH_004',
  AUTH_ACCOUNT_LOCKED: 'AUTH_005',
  AUTH_EMAIL_NOT_VERIFIED: 'AUTH_006',

  // User
  USER_NOT_FOUND: 'USER_001',
  USER_ALREADY_EXISTS: 'USER_002',
  USER_SUSPENDED: 'USER_003',

  // Project
  PROJECT_NOT_FOUND: 'PROJ_001',
  PROJECT_LIMIT_REACHED: 'PROJ_002',
  PROJECT_ALREADY_EXISTS: 'PROJ_003',
  PROJECT_CONVERSION_FAILED: 'PROJ_004',

  // AI Engine
  AI_QUOTA_EXCEEDED: 'AI_001',
  AI_MODEL_UNAVAILABLE: 'AI_002',
  AI_PROCESSING_FAILED: 'AI_003',
  AI_INVALID_INPUT: 'AI_004',

  // Billing
  BILLING_PAYMENT_FAILED: 'BILL_001',
  BILLING_SUBSCRIPTION_EXPIRED: 'BILL_002',
  BILLING_PLAN_LIMIT_REACHED: 'BILL_003',

  // General
  VALIDATION_FAILED: 'GEN_001',
  RESOURCE_NOT_FOUND: 'GEN_002',
  INTERNAL_ERROR: 'GEN_003',
  RATE_LIMIT_EXCEEDED: 'GEN_004',
} as const;

// ── Routes (Frontend) ─────────────────────────────────────
export const ROUTES = {
  // Public
  HOME: '/',
  SIGN_IN: '/auth/sign-in',
  SIGN_UP: '/auth/sign-up',
  FORGOT_PASSWORD: '/auth/forgot-password',
  RESET_PASSWORD: '/auth/reset-password',
  VERIFY_EMAIL: '/auth/verify-email',

  // Dashboard
  DASHBOARD: '/dashboard',
  PROJECTS: '/dashboard/projects',
  PROJECT_NEW: '/dashboard/projects/new',
  PROJECT_DETAIL: (id: string) => `/dashboard/projects/${id}`,
  PROJECT_SETTINGS: (id: string) => `/dashboard/projects/${id}/settings`,

  // Organization
  ORG_SETTINGS: '/dashboard/org/settings',
  ORG_MEMBERS: '/dashboard/org/members',
  ORG_BILLING: '/dashboard/org/billing',

  // User
  PROFILE: '/dashboard/profile',
  SETTINGS: '/dashboard/settings',

  // Misc
  DOCS: '/docs',
  PRICING: '/pricing',
  CHANGELOG: '/changelog',
} as const;

// ── Languages ─────────────────────────────────────────────
export const SOURCE_LANGUAGES = [
  { value: 'javascript', label: 'JavaScript', icon: 'js' },
  { value: 'python', label: 'Python', icon: 'py' },
  { value: 'java', label: 'Java', icon: 'java' },
  { value: 'csharp', label: 'C#', icon: 'cs' },
  { value: 'php', label: 'PHP', icon: 'php' },
  { value: 'ruby', label: 'Ruby', icon: 'rb' },
  { value: 'go', label: 'Go', icon: 'go' },
] as const;

export const TARGET_LANGUAGES = [
  { value: 'typescript', label: 'TypeScript', icon: 'ts' },
  { value: 'rust', label: 'Rust', icon: 'rs' },
  { value: 'kotlin', label: 'Kotlin', icon: 'kt' },
  { value: 'swift', label: 'Swift', icon: 'swift' },
  { value: 'dart', label: 'Dart', icon: 'dart' },
] as const;

// ── Events ────────────────────────────────────────────────
export const QUEUE_NAMES = {
  EMAIL: 'cm:queue:email',
  CONVERSION: 'cm:queue:conversion',
  ANALYTICS: 'cm:queue:analytics',
  NOTIFICATIONS: 'cm:queue:notifications',
} as const;

export const CACHE_KEYS = {
  USER: (id: string) => `cm:user:${id}`,
  ORG: (id: string) => `cm:org:${id}`,
  PROJECT: (id: string) => `cm:project:${id}`,
  RATE_LIMIT: (ip: string) => `cm:rl:${ip}`,
  SESSION: (token: string) => `cm:session:${token}`,
  FEATURE_FLAGS: 'cm:feature-flags',
} as const;
