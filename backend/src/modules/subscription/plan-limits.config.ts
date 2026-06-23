// ============================================================
// CodeMorph — Plan Limits Configuration
// Single source of truth for all plan restrictions
// ============================================================

export const PLANS = ['free', 'pro', 'pro_max'] as const;
export type Plan = (typeof PLANS)[number];

export interface PlanLimits {
  // Conversions
  conversionsPerMonth: number;         // -1 = unlimited
  concurrentJobs: number;              // max parallel jobs per user
  maxSourceFileSizeMb: number;         // max ZIP / repo size
  maxFilesPerProject: number;          // file count cap
  maxLinesOfCode: number;              // LOC cap (-1 = unlimited)

  // Projects
  maxProjects: number;                 // -1 = unlimited
  projectRetentionDays: number;        // how long results are kept

  // Features
  githubExport: boolean;               // push results to GitHub PR
  priorityQueue: boolean;              // front of Bull queue
  advancedFrameworks: boolean;         // all 4 conversions or subset
  teamWorkspace: boolean;              // org-level sharing
  advancedAnalytics: boolean;          // usage analytics dashboard
  apiAccess: boolean;                  // REST API key access
  customGoalPrompt: boolean;           // custom AI goal prompts
  irDownload: boolean;                 // download raw IR JSON
  watermark: boolean;                  // add watermark to output

  // Queue
  queuePriority: number;               // Bull priority (1 = highest, 10 = lowest)
  aiRequestsPerHour: number;           // OpenAI call throttle (-1 = unlimited)

  // Support
  supportLevel: 'community' | 'email' | 'priority';
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: {
    conversionsPerMonth:  3,
    concurrentJobs:       1,
    maxSourceFileSizeMb:  5,
    maxFilesPerProject:   50,
    maxLinesOfCode:       5_000,
    maxProjects:          1,
    projectRetentionDays: 7,
    githubExport:         false,
    priorityQueue:        false,
    advancedFrameworks:   false,   // only Flutter→React allowed
    teamWorkspace:        false,
    advancedAnalytics:    false,
    apiAccess:            false,
    customGoalPrompt:     false,
    irDownload:           false,
    watermark:            true,
    queuePriority:        10,      // lowest priority
    aiRequestsPerHour:    5,
    supportLevel:         'community',
  },

  pro: {
    conversionsPerMonth:  50,
    concurrentJobs:       3,
    maxSourceFileSizeMb:  25,
    maxFilesPerProject:   500,
    maxLinesOfCode:       100_000,
    maxProjects:          20,
    projectRetentionDays: 90,
    githubExport:         true,
    priorityQueue:        true,
    advancedFrameworks:   true,    // all 4 conversions
    teamWorkspace:        false,
    advancedAnalytics:    true,
    apiAccess:            false,
    customGoalPrompt:     true,
    irDownload:           true,
    watermark:            false,
    queuePriority:        5,
    aiRequestsPerHour:    60,
    supportLevel:         'email',
  },

  pro_max: {
    conversionsPerMonth:  -1,      // unlimited
    concurrentJobs:       10,
    maxSourceFileSizeMb:  100,
    maxFilesPerProject:   -1,      // unlimited
    maxLinesOfCode:       -1,
    maxProjects:          -1,
    projectRetentionDays: 365,
    githubExport:         true,
    priorityQueue:        true,
    advancedFrameworks:   true,
    teamWorkspace:        true,
    advancedAnalytics:    true,
    apiAccess:            true,
    customGoalPrompt:     true,
    irDownload:           true,
    watermark:            false,
    queuePriority:        1,       // highest priority
    aiRequestsPerHour:    -1,
    supportLevel:         'priority',
  },
};

export const PLAN_DISPLAY: Record<Plan, { name: string; price: { monthly: number; annual: number }; badge: string; color: string }> = {
  free: {
    name:  'Free',
    price: { monthly: 0, annual: 0 },
    badge: 'Free',
    color: 'slate',
  },
  pro: {
    name:  'Pro',
    price: { monthly: 29, annual: 23 },   // annual = monthly equivalent
    badge: 'Most Popular',
    color: 'indigo',
  },
  pro_max: {
    name:  'Pro Max',
    price: { monthly: 79, annual: 63 },
    badge: 'Enterprise',
    color: 'violet',
  },
};

export function getPlanLimits(plan: string): PlanLimits {
  if (plan in PLAN_LIMITS) return PLAN_LIMITS[plan as Plan];
  return PLAN_LIMITS.free;
}

export function isUnlimited(value: number): boolean {
  return value === -1;
}

export function getAllowedFrameworks(plan: Plan): string[] {
  if (plan === 'free') return ['flutter-react', 'flutter-rn'];  // free: flutter→react/rn
  return ['flutter-react', 'flutter-rn', 'react-flutter', 'express-nestjs', 'nodejs-nestjs'];
}
