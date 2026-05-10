// ============================================================
// CodeMorph — Input Component
// ============================================================
import * as React from 'react';

import { cn } from '@/lib/utils/cn';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  leftElement?: React.ReactNode;
  rightElement?: React.ReactNode;
  error?: boolean;
  label?: string;
  hint?: string;
  errorMessage?: string;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, leftElement, rightElement, error, label, hint, errorMessage, id, ...props }, ref) => {
    const inputId = id ?? React.useId();

    return (
      <div className="w-full space-y-1.5">
        {label && (
          <label
            htmlFor={inputId}
            className="text-sm font-medium leading-none text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          >
            {label}
          </label>
        )}
        <div className="relative flex items-center">
          {leftElement && (
            <div className="pointer-events-none absolute left-3 flex items-center text-muted-foreground">
              {leftElement}
            </div>
          )}
          <input
            id={inputId}
            type={type}
            className={cn(
              'flex h-9 w-full rounded-lg border border-input bg-background px-3 py-2',
              'text-sm text-foreground placeholder:text-muted-foreground',
              'shadow-xs transition-all duration-150',
              'file:border-0 file:bg-transparent file:text-sm file:font-medium',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0',
              'focus-visible:border-primary',
              'disabled:cursor-not-allowed disabled:opacity-50',
              'hover:border-border/80',
              error && 'border-destructive focus-visible:ring-destructive',
              leftElement && 'pl-9',
              rightElement && 'pr-9',
              className,
            )}
            ref={ref}
            aria-invalid={error}
            aria-describedby={errorMessage ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
            {...props}
          />
          {rightElement && (
            <div className="absolute right-3 flex items-center text-muted-foreground">
              {rightElement}
            </div>
          )}
        </div>
        {hint && !errorMessage && (
          <p id={`${inputId}-hint`} className="text-xs text-muted-foreground">
            {hint}
          </p>
        )}
        {errorMessage && (
          <p id={`${inputId}-error`} className="text-xs text-destructive" role="alert">
            {errorMessage}
          </p>
        )}
      </div>
    );
  },
);
Input.displayName = 'Input';

export { Input };
