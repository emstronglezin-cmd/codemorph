'use client';
// ============================================================
// CodeMorph — Offline Fallback Page (PWA)
// Shown when user is offline and page isn't cached
// ============================================================
import type React from 'react';

export default function OfflinePage(): React.JSX.Element {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-4 text-center">
      {/* Icon */}
      <div className="mb-8 flex h-20 w-20 items-center justify-center rounded-2xl border border-border bg-surface-1 shadow-card">
        <svg
          className="h-10 w-10 text-muted-foreground"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15"
          />
        </svg>
      </div>

      {/* Text */}
      <h1 className="mb-3 text-2xl font-bold tracking-tight">You&apos;re offline</h1>
      <p className="mb-8 max-w-sm text-muted-foreground">
        It looks like you lost your internet connection. Check your network and try again.
        Your recent conversions are still available locally.
      </p>

      {/* Actions */}
      <div className="flex flex-col items-center gap-3 sm:flex-row">
        <button
          onClick={() => window.location.reload()}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg gradient-brand px-6 text-sm font-semibold text-white shadow-sm hover:opacity-90 transition-all"
        >
          Try again
        </button>
        <a
          href="/dashboard"
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-background px-6 text-sm font-semibold hover:bg-accent transition-all"
        >
          Go to Dashboard
        </a>
      </div>

      {/* Status */}
      <p className="mt-12 text-xs text-muted-foreground">
        CodeMorph PWA — offline mode
      </p>
    </main>
  );
}
