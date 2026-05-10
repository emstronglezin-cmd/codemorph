// ============================================================
// CodeMorph — Badge Component
// ============================================================
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils/cn';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default:     'border-transparent bg-primary text-primary-foreground',
        secondary:   'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        outline:     'border-border text-foreground',
        success:     'border-transparent bg-success/15 text-success',
        warning:     'border-transparent bg-warning/15 text-warning',
        error:       'border-transparent bg-error/15 text-error',
        info:        'border-transparent bg-info/15 text-info',
        premium:     'border-transparent gradient-brand text-white',
        ghost:       'border-transparent bg-muted text-muted-foreground',
      },
      size: {
        sm: 'px-2 py-0 text-[10px]',
        default: 'px-2.5 py-0.5 text-xs',
        lg: 'px-3 py-1 text-sm',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {
  dot?: boolean;
}

function Badge({ className, variant, size, dot, children, ...props }: BadgeProps): React.JSX.Element {
  return (
    <div className={cn(badgeVariants({ variant, size }), className)} {...props}>
      {dot && (
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            variant === 'success' && 'bg-success',
            variant === 'warning' && 'bg-warning',
            variant === 'error' && 'bg-error',
            variant === 'info' && 'bg-info',
            (!variant || variant === 'default') && 'bg-primary-foreground',
          )}
        />
      )}
      {children}
    </div>
  );
}

export { Badge, badgeVariants };
