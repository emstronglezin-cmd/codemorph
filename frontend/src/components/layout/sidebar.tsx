// ============================================================
// CodeMorph — Sidebar Layout Component
// ============================================================
'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  FolderGit2,
  Zap,
  BarChart3,
  Settings,
  Users,
  CreditCard,
  HelpCircle,
  ChevronLeft,
  ChevronRight,
  Code2,
} from 'lucide-react';

// ── Tooltip stubs (Radix UI pending) ─────────────────────
function Tooltip({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <>{children}</>;
}
function TooltipTrigger({ children, asChild: _ }: { children: React.ReactNode; asChild?: boolean }): React.JSX.Element {
  return <>{children}</>;
}
function TooltipContent({ children, side: _, className: __ }: { children: React.ReactNode; side?: string; className?: string }): React.JSX.Element {
  return <>{children}</>;
}

import { cn } from '@/lib/utils/cn';
import { Separator } from '@/components/ui/separator';

// ── Nav items config ──────────────────────────────────────
const MAIN_NAV = [
  { label: 'Dashboard',  href: '/dashboard',          icon: LayoutDashboard },
  { label: 'Projects',   href: '/dashboard/projects',  icon: FolderGit2 },
  { label: 'Conversions',href: '/dashboard/conversions',icon: Zap },
  { label: 'Analytics',  href: '/dashboard/analytics', icon: BarChart3 },
] as const;

const ORG_NAV = [
  { label: 'Team',       href: '/dashboard/org/members',  icon: Users },
  { label: 'Billing',    href: '/dashboard/org/billing',  icon: CreditCard },
  { label: 'Settings',   href: '/dashboard/settings',     icon: Settings },
] as const;

interface SidebarProps {
  collapsed?: boolean;
  onCollapse?: (collapsed: boolean) => void;
}

export function Sidebar({ collapsed = false, onCollapse }: SidebarProps): React.JSX.Element {
  const pathname = usePathname();

  const isActive = (href: string): boolean =>
    href === '/dashboard' ? pathname === href : pathname.startsWith(href);

  return (
    <aside
      className={cn(
        'relative flex h-full flex-col border-r border-border bg-surface-0',
        'transition-all duration-300 ease-smooth',
        collapsed ? 'w-16' : 'w-60',
      )}
    >
      {/* Logo */}
      <div className={cn('flex h-14 items-center border-b border-border px-3', collapsed && 'justify-center')}>
        <Link href="/dashboard" className="flex items-center gap-2.5 min-w-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg gradient-brand shadow-glow-sm">
            <Code2 className="h-4 w-4 text-white" />
          </div>
          {!collapsed && (
            <span className="truncate text-base font-bold tracking-tight gradient-text">
              CodeMorph
            </span>
          )}
        </Link>
      </div>

      {/* Nav */}
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2 scrollbar-hide">
        {/* Main */}
        <div className="space-y-0.5">
          {!collapsed && (
            <p className="mb-1 px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
              Main
            </p>
          )}
          {MAIN_NAV.map((item) => (
            <NavItem
              key={item.href}
              {...item}
              active={isActive(item.href)}
              collapsed={collapsed}
            />
          ))}
        </div>

        <Separator className="my-2" />

        {/* Organization */}
        <div className="space-y-0.5">
          {!collapsed && (
            <p className="mb-1 px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
              Organization
            </p>
          )}
          {ORG_NAV.map((item) => (
            <NavItem
              key={item.href}
              {...item}
              active={isActive(item.href)}
              collapsed={collapsed}
            />
          ))}
        </div>
      </nav>

      {/* Footer */}
      <div className="border-t border-border p-2">
        {!collapsed && (
          <NavItem
            label="Help & Docs"
            href="/docs"
            icon={HelpCircle}
            active={false}
            collapsed={false}
          />
        )}
      </div>

      {/* Collapse toggle */}
      <button
        onClick={() => onCollapse?.(!collapsed)}
        className={cn(
          'absolute -right-3 top-[calc(50%-16px)] z-10',
          'flex h-6 w-6 items-center justify-center',
          'rounded-full border border-border bg-background shadow-sm',
          'text-muted-foreground transition-all hover:text-foreground hover:shadow-md',
        )}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronLeft className="h-3 w-3" />}
      </button>
    </aside>
  );
}

// ── Nav Item ──────────────────────────────────────────────
interface NavItemProps {
  label: string;
  href: string;
  icon: React.ElementType;
  active: boolean;
  collapsed: boolean;
}

function NavItem({ label, href, icon: Icon, active, collapsed }: NavItemProps): React.JSX.Element {
  const item = (
    <Link
      href={href}
      className={cn(
        'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium',
        'transition-all duration-150',
        active
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        collapsed && 'justify-center px-2',
      )}
    >
      <Icon className={cn('shrink-0', active ? 'h-4 w-4 text-primary' : 'h-4 w-4')} />
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{item}</TooltipTrigger>
        <TooltipContent side="right" className="font-medium">
          {label}
        </TooltipContent>
      </Tooltip>
    );
  }

  return item;
}


