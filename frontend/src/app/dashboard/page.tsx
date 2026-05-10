// ============================================================
// CodeMorph — Dashboard Home Page
// ============================================================
import type { Metadata } from 'next';
import {
  FolderCode,
  Zap,
  CheckCircle2,
  TrendingUp,
  ArrowUpRight,
  Plus,
  Clock,
  Code2,
} from 'lucide-react';
import Link from 'next/link';

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

export const metadata: Metadata = { title: 'Dashboard' };

// ── Mock data (to be replaced by real API) ────────────────
const STATS = [
  {
    label:  'Total Projects',
    value:  '12',
    delta:  '+3 this month',
    trend:  'up',
    icon:   FolderCode,
    color:  'text-brand-500',
    bg:     'bg-brand-500/10',
  },
  {
    label:  'Active Conversions',
    value:  '2',
    delta:  '1 running now',
    trend:  'neutral',
    icon:   Zap,
    color:  'text-warning',
    bg:     'bg-warning/10',
  },
  {
    label:  'Completed',
    value:  '47',
    delta:  '+12 this week',
    trend:  'up',
    icon:   CheckCircle2,
    color:  'text-success',
    bg:     'bg-success/10',
  },
  {
    label:  'Success Rate',
    value:  '98.3%',
    delta:  '+0.5% vs last month',
    trend:  'up',
    icon:   TrendingUp,
    color:  'text-info',
    bg:     'bg-info/10',
  },
] as const;

const RECENT_PROJECTS = [
  {
    id:    'proj_1',
    name:  'legacy-api-conversion',
    from:  'JavaScript',
    to:    'TypeScript',
    status:'completed',
    ago:   '2 hours ago',
    files: 48,
  },
  {
    id:    'proj_2',
    name:  'mobile-app-rewrite',
    from:  'Java',
    to:    'Kotlin',
    status:'converting',
    ago:   '34 min ago',
    files: 120,
  },
  {
    id:    'proj_3',
    name:  'django-to-nestjs',
    from:  'Python',
    to:    'TypeScript',
    status:'completed',
    ago:   'Yesterday',
    files: 87,
  },
  {
    id:    'proj_4',
    name:  'php-modernization',
    from:  'PHP',
    to:    'TypeScript',
    status:'failed',
    ago:   '3 days ago',
    files: 23,
  },
] as const;

const STATUS_CONFIG = {
  completed:  { label: 'Completed',  variant: 'success'  as const, dot: true },
  converting: { label: 'Converting', variant: 'warning'  as const, dot: true },
  failed:     { label: 'Failed',     variant: 'error'    as const, dot: true },
  pending:    { label: 'Pending',    variant: 'ghost'    as const, dot: true },
} as const;

// ─────────────────────────────────────────────────────────────
export default function DashboardPage(): React.JSX.Element {
  return (
    <div className="space-y-8 animate-fade-in">

      {/* ── Page Header ──────────────────────────────────── */}
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Welcome back. Here&apos;s what&apos;s happening with your projects.
          </p>
        </div>
        <Link href="/dashboard/projects/new">
          <Button leftIcon={<Plus className="h-4 w-4" />}>
            New project
          </Button>
        </Link>
      </div>

      {/* ── Stats Grid ───────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STATS.map((stat) => (
          <Card key={stat.label} className="stat-card">
            <CardContent className="p-6">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {stat.label}
                  </p>
                  <p className="text-3xl font-bold tracking-tight">{stat.value}</p>
                  <p className={`flex items-center gap-1 text-xs ${stat.trend === 'up' ? 'text-success' : 'text-muted-foreground'}`}>
                    {stat.trend === 'up' && <ArrowUpRight className="h-3 w-3" />}
                    {stat.delta}
                  </p>
                </div>
                <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${stat.bg}`}>
                  <stat.icon className={`h-5 w-5 ${stat.color}`} />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Recent Projects ──────────────────────────────── */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between pb-3">
            <div>
              <CardTitle className="text-base">Recent Projects</CardTitle>
              <CardDescription>Your latest code conversion projects</CardDescription>
            </div>
            <Link href="/dashboard/projects">
              <Button variant="ghost" size="sm" rightIcon={<ArrowUpRight className="h-3.5 w-3.5" />}>
                View all
              </Button>
            </Link>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {RECENT_PROJECTS.map((project) => {
                const status = STATUS_CONFIG[project.status];
                return (
                  <Link
                    key={project.id}
                    href={`/dashboard/projects/${project.id}`}
                    className="flex items-center gap-4 px-6 py-4 transition-colors hover:bg-accent/50"
                  >
                    {/* Icon */}
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                      <Code2 className="h-4 w-4 text-primary" />
                    </div>

                    {/* Info */}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{project.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {project.from} → {project.to} · {project.files} files
                      </p>
                    </div>

                    {/* Status */}
                    <div className="flex items-center gap-3">
                      <Badge variant={status.variant} dot={status.dot}>
                        {status.label}
                      </Badge>
                      <span className="hidden text-xs text-muted-foreground sm:block">
                        {project.ago}
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* ── Quick Actions ─────────────────────────────── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Quick Actions</CardTitle>
            <CardDescription>Common tasks at your fingertips</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <Link href="/dashboard/projects/new">
              <Button variant="outline" className="w-full justify-start gap-3" size="lg">
                <Plus className="h-4 w-4 text-primary" />
                New Conversion Project
              </Button>
            </Link>
            <Link href="/dashboard/projects">
              <Button variant="outline" className="w-full justify-start gap-3" size="lg">
                <FolderCode className="h-4 w-4 text-brand-500" />
                Browse Projects
              </Button>
            </Link>
            <Link href="/dashboard/conversions">
              <Button variant="outline" className="w-full justify-start gap-3" size="lg">
                <Zap className="h-4 w-4 text-warning" />
                Active Conversions
              </Button>
            </Link>
            <Link href="/dashboard/analytics">
              <Button variant="outline" className="w-full justify-start gap-3" size="lg">
                <TrendingUp className="h-4 w-4 text-success" />
                View Analytics
              </Button>
            </Link>

            <Separator className="my-2" />

            {/* Usage */}
            <div className="space-y-2 rounded-lg bg-surface-2 p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">AI Tokens used</span>
                <span className="font-medium">12,450 / 100,000</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-surface-3">
                <div
                  className="h-full rounded-full gradient-brand transition-all"
                  style={{ width: '12.45%' }}
                />
              </div>
              <p className="text-xs text-muted-foreground">12.45% of monthly quota used</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Activity Feed ─────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Recent Activity</CardTitle>
          <CardDescription>Latest events across your workspace</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {[
              { icon: CheckCircle2, color: 'text-success', msg: 'Project legacy-api-conversion completed successfully', time: '2 hours ago' },
              { icon: Zap,          color: 'text-warning',  msg: 'Conversion started on mobile-app-rewrite', time: '34 min ago' },
              { icon: FolderCode,   color: 'text-primary',  msg: 'New project php-modernization created', time: '3 days ago' },
              { icon: Clock,        color: 'text-info',     msg: 'Scheduled maintenance completed', time: '4 days ago' },
            ].map((item, i) => (
              <div key={i} className="flex items-start gap-3">
                <div className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-2`}>
                  <item.icon className={`h-3.5 w-3.5 ${item.color}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm">{item.msg}</p>
                  <p className="text-xs text-muted-foreground">{item.time}</p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
