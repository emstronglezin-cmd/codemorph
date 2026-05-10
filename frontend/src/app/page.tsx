// ============================================================
// CodeMorph — Landing Page (Marketing)
// ============================================================
import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'CodeMorph — AI-Powered Code Conversion SaaS',
};

export default function LandingPage(): React.JSX.Element {
  return (
    <main className="min-h-screen gradient-mesh">
      {/* Hero */}
      <section className="relative flex min-h-screen flex-col items-center justify-center px-4 text-center">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/5 px-4 py-1.5 text-sm font-medium text-primary">
          <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
          Now in public beta — free to try
        </div>

        <h1 className="mb-6 max-w-4xl text-5xl font-bold tracking-tight lg:text-7xl">
          Convert code between{' '}
          <span className="gradient-text">any language</span>{' '}
          with AI precision
        </h1>

        <p className="mb-10 max-w-2xl text-lg text-muted-foreground lg:text-xl">
          CodeMorph analyzes your codebase, generates an Intermediate Representation,
          and produces production-ready code in your target language. Enterprise-grade
          quality, zero manual work.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-4">
          <Link
            href="/auth/sign-up"
            className="inline-flex h-12 items-center justify-center gap-2 rounded-xl gradient-brand px-8 text-base font-semibold text-white shadow-lg hover:opacity-90 hover:shadow-glow-md transition-all"
          >
            Get started free →
          </Link>
          <Link
            href="/docs"
            className="inline-flex h-12 items-center justify-center gap-2 rounded-xl border border-border bg-background px-8 text-base font-semibold hover:bg-accent transition-all"
          >
            View documentation
          </Link>
        </div>

        {/* Trusted by */}
        <p className="mt-16 text-sm text-muted-foreground">
          Trusted by 500+ engineering teams worldwide
        </p>
      </section>
    </main>
  );
}
