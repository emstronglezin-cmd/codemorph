// ============================================================
// CodeMorph — Skeleton Component
// ============================================================
import * as React from 'react';
import { cn } from '@/lib/utils/cn';

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'circular' | 'text';
}

function Skeleton({ className, variant = 'default', ...props }: SkeletonProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'shimmer',
        variant === 'circular' && 'rounded-full',
        variant === 'text'    && 'h-4 rounded-md',
        variant === 'default' && 'rounded-lg',
        className,
      )}
      {...props}
    />
  );
}

// Preset skeleton compositions
function SkeletonCard(): React.JSX.Element {
  return (
    <div className="rounded-xl border border-border p-6 space-y-4">
      <div className="flex items-center gap-3">
        <Skeleton variant="circular" className="h-10 w-10" />
        <div className="space-y-2 flex-1">
          <Skeleton variant="text" className="w-1/3" />
          <Skeleton variant="text" className="w-1/4 h-3" />
        </div>
      </div>
      <Skeleton className="h-24 w-full" />
      <div className="space-y-2">
        <Skeleton variant="text" className="w-full" />
        <Skeleton variant="text" className="w-3/4" />
      </div>
    </div>
  );
}

function SkeletonTable({ rows = 5 }: { rows?: number }): React.JSX.Element {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 py-3 border-b border-border last:border-0">
          <Skeleton variant="circular" className="h-8 w-8" />
          <Skeleton variant="text" className="flex-1" />
          <Skeleton variant="text" className="w-24" />
          <Skeleton variant="text" className="w-16" />
        </div>
      ))}
    </div>
  );
}

function SkeletonStats(): React.JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="rounded-xl border border-border p-6 space-y-3">
          <Skeleton variant="text" className="w-1/2 h-3" />
          <Skeleton variant="text" className="w-3/4 h-7" />
          <Skeleton variant="text" className="w-1/3 h-3" />
        </div>
      ))}
    </div>
  );
}

export { Skeleton, SkeletonCard, SkeletonTable, SkeletonStats };
