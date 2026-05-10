// ============================================================
// CodeMorph — Button Component
// Design: Stripe / Vercel level premium
// ============================================================
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils/cn';

const buttonVariants = cva(
  // Base styles
  [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium',
    'ring-offset-background transition-all duration-150 ease-smooth',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
    'disabled:pointer-events-none disabled:opacity-50',
    'select-none',
  ],
  {
    variants: {
      variant: {
        // Primary — solid brand
        default: [
          'bg-primary text-primary-foreground shadow-sm',
          'hover:bg-primary/90 hover:shadow-glow-sm',
          'active:scale-[0.98] active:bg-primary/95',
        ],
        // Destructive
        destructive: [
          'bg-destructive text-destructive-foreground shadow-sm',
          'hover:bg-destructive/90 hover:shadow-glow-error',
          'active:scale-[0.98]',
        ],
        // Outline — Vercel-style
        outline: [
          'border border-border bg-background shadow-xs',
          'hover:bg-accent hover:text-accent-foreground hover:border-primary/30',
          'active:scale-[0.98]',
        ],
        // Secondary
        secondary: [
          'bg-secondary text-secondary-foreground shadow-xs',
          'hover:bg-secondary/80',
          'active:scale-[0.98]',
        ],
        // Ghost
        ghost: [
          'text-foreground',
          'hover:bg-accent hover:text-accent-foreground',
          'active:scale-[0.98]',
        ],
        // Link
        link: [
          'text-primary underline-offset-4',
          'hover:underline',
        ],
        // Premium / Gradient
        premium: [
          'gradient-brand text-white shadow-md',
          'hover:opacity-90 hover:shadow-glow-md',
          'active:scale-[0.98] active:opacity-95',
        ],
        // Glass (for dark hero sections)
        glass: [
          'border border-white/20 bg-white/10 text-white backdrop-blur-sm',
          'hover:bg-white/20 hover:border-white/30',
          'active:scale-[0.98]',
        ],
      },
      size: {
        xs:      'h-7  px-2.5 text-xs rounded-md gap-1.5',
        sm:      'h-8  px-3   text-xs rounded-md',
        default: 'h-9  px-4   text-sm',
        lg:      'h-10 px-6   text-sm',
        xl:      'h-12 px-8   text-base',
        icon:    'h-9  w-9',
        'icon-sm': 'h-8 w-8',
        'icon-lg': 'h-10 w-10',
        'icon-xs': 'h-7 w-7',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      loading = false,
      leftIcon,
      rightIcon,
      children,
      disabled,
      ...props
    },
    ref,
  ) => {
    const Comp = asChild ? Slot : 'button';

    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled ?? loading}
        aria-disabled={disabled ?? loading}
        {...props}
      >
        {loading ? (
          <span
            className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
            aria-hidden="true"
          />
        ) : (
          leftIcon && <span className="shrink-0" aria-hidden="true">{leftIcon}</span>
        )}
        {children}
        {!loading && rightIcon && (
          <span className="shrink-0" aria-hidden="true">{rightIcon}</span>
        )}
      </Comp>
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
