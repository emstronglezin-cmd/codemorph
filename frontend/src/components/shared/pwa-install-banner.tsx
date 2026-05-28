'use client';

// ============================================================
// CodeMorph — PWA Install Banner
// Shows a non-intrusive "Add to Home Screen" prompt on
// browsers that support the beforeinstallprompt event.
// Auto-dismisses, respects user's "dismiss" choice (30d).
// ============================================================

import * as React from 'react';
import { Download, X, Code2 } from 'lucide-react';

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

const DISMISS_KEY   = 'codemorph_pwa_dismissed_at';
const DISMISS_DAYS  = 30;

export function PwaInstallBanner(): React.JSX.Element | null {
  const [deferredPrompt, setDeferredPrompt] = React.useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible]               = React.useState(false);
  const [installing, setInstalling]         = React.useState(false);

  React.useEffect(() => {
    // Don't show if already installed (standalone mode)
    if (window.matchMedia('(display-mode: standalone)').matches) return;
    if ((window.navigator as { standalone?: boolean }).standalone) return;

    // Don't show if user dismissed recently
    const dismissedAt = localStorage.getItem(DISMISS_KEY);
    if (dismissedAt) {
      const diff = Date.now() - parseInt(dismissedAt, 10);
      if (diff < DISMISS_DAYS * 24 * 60 * 60 * 1000) return;
    }

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      // Small delay so it doesn't pop immediately on load
      setTimeout(() => setVisible(true), 3000);
    };

    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt) return;
    setInstalling(true);
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setVisible(false);
    } else {
      dismiss();
    }
    setInstalling(false);
    setDeferredPrompt(null);
  };

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, Date.now().toString());
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div
      role="banner"
      aria-label="Install CodeMorph app"
      className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-sm animate-in slide-in-from-bottom-4 duration-300"
    >
      <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-4 shadow-lg backdrop-blur-sm">
        {/* App icon */}
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl gradient-brand shadow-glow-sm">
          <Code2 className="h-5 w-5 text-white" />
        </div>

        {/* Text */}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-tight">Install CodeMorph</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Add to your home screen for quick access
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={handleInstall}
            disabled={installing}
            aria-label="Install app"
            className="flex h-8 items-center gap-1.5 rounded-lg gradient-brand px-3 text-xs font-semibold text-white hover:opacity-90 transition-opacity disabled:opacity-60"
          >
            <Download className="h-3.5 w-3.5" />
            {installing ? 'Installing…' : 'Install'}
          </button>
          <button
            onClick={dismiss}
            aria-label="Dismiss install banner"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
