// ============================================================
// CodeMorph — Dashboard Header Component
// ============================================================
'use client';

import * as React from 'react';
import Link from 'next/link';
import { Bell, Search, Sun, Moon, Command, Menu } from 'lucide-react';

import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

interface HeaderProps {
  className?: string;
  onMobileMenuToggle?: () => void;
}

export function Header({ className, onMobileMenuToggle }: HeaderProps): React.JSX.Element {
  const [isDark, setIsDark] = React.useState(false);

  const toggleTheme = (): void => {
    setIsDark((prev) => !prev);
    document.documentElement.classList.toggle('dark');
  };

  return (
    <header
      className={cn(
        'flex items-center gap-4 border-b border-border px-4',
        'bg-background/80 backdrop-blur-xl',
        'sticky top-0 z-30',
        // PWA safe-area for iPhone Dynamic Island / notch
        'pwa-header-offset',
        className,
      )}
      style={{
        paddingTop: `calc(env(safe-area-inset-top, 0px))`,
        minHeight: `calc(56px + env(safe-area-inset-top, 0px))`,
      }}
    >
      {/* Mobile menu button — visible only on small screens */}
      {onMobileMenuToggle && (
        <button
          onClick={onMobileMenuToggle}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-border hover:bg-surface-1 transition-colors lg:hidden"
          aria-label="Open menu"
        >
          <Menu className="h-4 w-4" />
        </button>
      )}

      {/* Search trigger */}
      <button
        className={cn(
          'flex flex-1 max-w-sm items-center gap-2 rounded-lg border border-border',
          'bg-surface-1 px-3 py-1.5 text-sm text-muted-foreground',
          'transition-all hover:border-primary/30 hover:bg-surface-2',
        )}
        aria-label="Open search"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="flex-1 text-left">Search...</span>
        <kbd className="pointer-events-none flex h-5 select-none items-center gap-1 rounded border border-border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
          <Command className="h-3 w-3" />K
        </kbd>
      </button>

      <div className="ml-auto flex items-center gap-1.5">
        {/* Theme toggle */}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={toggleTheme}
          aria-label="Toggle theme"
        >
          {isDark ? (
            <Sun className="h-4 w-4" />
          ) : (
            <Moon className="h-4 w-4" />
          )}
        </Button>

        {/* Notifications */}
        <Button variant="ghost" size="icon-sm" className="relative" aria-label="Notifications">
          <Bell className="h-4 w-4" />
          <span className="absolute right-1.5 top-1.5 flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
          </span>
        </Button>

        {/* User avatar */}
        <Link href="/dashboard/profile">
          <Avatar size="sm" className="cursor-pointer ring-2 ring-transparent hover:ring-primary/30 transition-all">
            <AvatarImage src="" alt="User avatar" />
            <AvatarFallback>CM</AvatarFallback>
          </Avatar>
        </Link>
      </div>
    </header>
  );
}
