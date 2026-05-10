// ============================================================
// CodeMorph — Shared Zod Schemas (validation runtime)
// ============================================================
import { z } from 'zod';

// ── Primitives ───────────────────────────────────────────
export const UserIdSchema = z.string().uuid().brand<'UserId'>();
export const OrgIdSchema = z.string().uuid().brand<'OrgId'>();
export const ProjectIdSchema = z.string().uuid().brand<'ProjectId'>();

export const EmailSchema = z.string().email().toLowerCase().trim();
export const PasswordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must not exceed 128 characters')
  .regex(/[A-Z]/, 'Must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Must contain at least one number');

export const SlugSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9-]+$/, 'Slug must only contain lowercase letters, numbers, and hyphens');

// ── Pagination ───────────────────────────────────────────
export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().max(255).optional(),
});

// ── Auth ─────────────────────────────────────────────────
export const SignUpSchema = z.object({
  name: z.string().min(2).max(100).trim(),
  email: EmailSchema,
  password: PasswordSchema,
  acceptTerms: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the terms of service' }),
  }),
});

export const SignInSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1, 'Password is required'),
  rememberMe: z.boolean().default(false),
});

export const ForgotPasswordSchema = z.object({
  email: EmailSchema,
});

export const ResetPasswordSchema = z
  .object({
    token: z.string().min(1),
    password: PasswordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

export const RefreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});

// ── User ─────────────────────────────────────────────────
export const UpdateProfileSchema = z.object({
  name: z.string().min(2).max(100).trim().optional(),
  avatarUrl: z.string().url().nullable().optional(),
});

export const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: PasswordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

// ── Organization ──────────────────────────────────────────
export const CreateOrgSchema = z.object({
  name: z.string().min(2).max(100).trim(),
  slug: SlugSchema,
  logoUrl: z.string().url().nullable().optional(),
});

export const UpdateOrgSchema = z.object({
  name: z.string().min(2).max(100).trim().optional(),
  logoUrl: z.string().url().nullable().optional(),
});

export const InviteMemberSchema = z.object({
  email: EmailSchema,
  role: z.enum(['admin', 'member', 'viewer']),
});

// ── Project ───────────────────────────────────────────────
export const CreateProjectSchema = z.object({
  name: z.string().min(2).max(100).trim(),
  description: z.string().max(500).trim().nullable().optional(),
  sourceLanguage: z.enum(['javascript', 'python', 'java', 'csharp', 'php', 'ruby', 'go']),
  targetLanguage: z.enum(['typescript', 'rust', 'kotlin', 'swift', 'dart']),
  orgId: OrgIdSchema.optional(),
});

export const UpdateProjectSchema = z.object({
  name: z.string().min(2).max(100).trim().optional(),
  description: z.string().max(500).trim().nullable().optional(),
});

// ── IR Document ───────────────────────────────────────────
export const IRProjectMetaSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['web', 'mobile', 'backend', 'fullstack', 'library']),
  sourceStack: z.string().min(1),
  targetStack: z.string().min(1),
  complexityScore: z.number().min(0).max(100),
  description: z.string().optional(),
  version: z.string().optional(),
});

export const IRDocumentSchema = z.object({
  projectMeta: IRProjectMetaSchema,
  architecture: z.object({
    modules: z.array(z.any()),
    layers: z.array(z.string()),
    patterns: z.array(z.string()),
  }),
  uiGraph: z.object({
    screens: z.array(z.any()),
    components: z.array(z.any()),
    navigationFlow: z.array(z.any()),
    stateFlow: z.array(z.any()),
  }),
  backendGraph: z.object({
    routes: z.array(z.any()),
    services: z.array(z.any()),
    entities: z.array(z.any()),
    middlewares: z.array(z.any()),
  }),
  dataLayer: z.object({
    models: z.array(z.any()),
    relationships: z.array(z.any()),
    migrations: z.array(z.any()),
  }),
  dependencyMap: z.object({
    keep: z.array(z.string()),
    replace: z.array(z.any()),
    remove: z.array(z.string()),
    add: z.array(z.string()),
  }),
  conversionPlan: z.array(
    z.object({
      step: z.number().int().positive(),
      action: z.string(),
      target: z.string(),
      details: z.string().optional(),
      estimatedTime: z.string().optional(),
    }),
  ),
  validation: z.object({
    buildable: z.boolean(),
    testsRequired: z.boolean(),
    riskLevel: z.enum(['low', 'medium', 'high', 'critical']),
    warnings: z.array(z.string()).optional(),
    blockers: z.array(z.string()).optional(),
  }),
});

// ── Type Exports ──────────────────────────────────────────
export type SignUpInput = z.infer<typeof SignUpSchema>;
export type SignInInput = z.infer<typeof SignInSchema>;
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;
export type UpdateProfileInput = z.infer<typeof UpdateProfileSchema>;
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;
export type CreateOrgInput = z.infer<typeof CreateOrgSchema>;
export type UpdateOrgInput = z.infer<typeof UpdateOrgSchema>;
export type InviteMemberInput = z.infer<typeof InviteMemberSchema>;
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;
export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>;
export type PaginationQueryInput = z.infer<typeof PaginationQuerySchema>;
export type IRDocumentInput = z.infer<typeof IRDocumentSchema>;
