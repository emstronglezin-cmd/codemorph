import type React from 'react';
// ============================================================
// CodeMorph — Landing Page (Marketing)
// Design: Stripe / Vercel / Linear quality
// ============================================================
import Link from 'next/link';
import type { Metadata } from 'next';
import { Code2, Zap, Shield, Globe, GitBranch, Cpu, ArrowRight, Check } from 'lucide-react';

export const metadata: Metadata = {
  title: 'CodeMorph — AI-Powered Code Conversion',
  description:
    'Convert Flutter to React, Swift to Kotlin, Vue to Angular — with AI precision. Enterprise-grade code migration, zero manual work.',
};

// ── Data ──────────────────────────────────────────────────────────────────────

const FEATURES = [
  {
    icon: Cpu,
    title: 'IR-based conversion',
    description:
      'Every conversion goes through an Intermediate Representation layer — not a naive find-and-replace. Your logic, state management, and architecture are preserved.',
  },
  {
    icon: Zap,
    title: 'Instant results',
    description:
      'Get production-ready output in seconds. Our AI engine processes codebases of any size without timeouts or rate limits on Pro plans.',
  },
  {
    icon: Shield,
    title: 'Enterprise-grade security',
    description:
      'SOC 2 aligned. Your source code never leaves our encrypted pipeline. Zero data retention policy available for enterprise customers.',
  },
  {
    icon: Globe,
    title: '20+ language pairs',
    description:
      'Flutter → React, Swift → Kotlin, Vue → React, Angular → Next.js, Python → TypeScript — and more added every month.',
  },
  {
    icon: GitBranch,
    title: 'Version control integration',
    description:
      'Connect your GitHub or GitLab repository. CodeMorph creates a PR with the converted code, ready for review.',
  },
  {
    icon: Code2,
    title: 'Full project conversion',
    description:
      'Not just a single file — CodeMorph converts entire projects: components, routing, state, API calls, styling, and tests.',
  },
] as const;

const CONVERSIONS = [
  { from: 'Flutter', to: 'React', badge: 'Popular' },
  { from: 'React Native', to: 'Flutter', badge: null },
  { from: 'Vue 2', to: 'React', badge: null },
  { from: 'Angular', to: 'Next.js', badge: 'New' },
  { from: 'Swift', to: 'Kotlin', badge: null },
  { from: 'Python', to: 'TypeScript', badge: null },
] as const;

const PLAN_FREE = ['5 conversions/month', 'Up to 500 lines', 'Community support', 'Web access'];
const PLAN_PRO  = [
  'Unlimited conversions',
  'Projects up to 50k lines',
  'Priority AI queue',
  'GitHub/GitLab PR integration',
  'Email support',
  'API access',
];

// ── Component ─────────────────────────────────────────────────────────────────

export default function LandingPage(): React.JSX.Element {
  return (
    <>
      {/* ── Nav ──────────────────────────────────────────────────────────── */}
      <header className="fixed inset-x-0 top-0 z-40 border-b border-border/40 bg-background/80 backdrop-blur-md">
        <nav className="container flex h-14 items-center justify-between">
          <Link href="/" className="flex items-center gap-2 font-bold text-foreground">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg gradient-brand shadow-glow-sm">
              <Code2 className="h-3.5 w-3.5 text-white" />
            </div>
            CodeMorph
          </Link>

          <div className="hidden items-center gap-6 text-sm font-medium text-muted-foreground md:flex">
            <Link href="/pricing" className="hover:text-foreground transition-colors">Pricing</Link>
            <Link href="/docs"    className="hover:text-foreground transition-colors">Docs</Link>
            <Link href="/blog"    className="hover:text-foreground transition-colors">Blog</Link>
          </div>

          <div className="flex items-center gap-3">
            <Link
              href="/auth/sign-in"
              className="hidden text-sm font-medium text-muted-foreground hover:text-foreground transition-colors sm:block"
            >
              Sign in
            </Link>
            <Link
              href="/auth/sign-up"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg gradient-brand px-4 text-sm font-semibold text-white shadow-sm hover:opacity-90 transition-all"
            >
              Get started <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </nav>
      </header>

      <main className="min-h-screen">
        {/* ── Hero ─────────────────────────────────────────────────────────── */}
        <section className="relative flex min-h-screen flex-col items-center justify-center px-4 pt-14 text-center">
          {/* Background glow */}
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="absolute left-1/2 top-1/3 h-[600px] w-[800px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/5 blur-3xl" />
          </div>

          {/* Beta badge */}
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/5 px-4 py-1.5 text-sm font-medium text-primary">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
            Now in public beta — free to try
          </div>

          <h1 className="mb-6 max-w-4xl text-5xl font-bold tracking-tight sm:text-6xl lg:text-7xl">
            Convert code between{' '}
            <span className="gradient-text">any framework</span>{' '}
            with AI precision
          </h1>

          <p className="mb-10 max-w-2xl text-lg text-muted-foreground sm:text-xl">
            CodeMorph analyzes your codebase, builds an Intermediate Representation,
            and generates production-ready code in your target framework.
            No manual rewrites. No logic drift.
          </p>

          <div className="flex flex-wrap items-center justify-center gap-4">
            <Link
              href="/auth/sign-up"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-xl gradient-brand px-8 text-base font-semibold text-white shadow-lg hover:opacity-90 hover:shadow-glow-md transition-all"
            >
              Start for free <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="/pricing"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-xl border border-border bg-background px-8 text-base font-semibold hover:bg-accent transition-all"
            >
              View pricing
            </Link>
          </div>

          {/* Social proof */}
          <div className="mt-16 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm text-muted-foreground">
            <span>Trusted by <strong className="text-foreground">500+</strong> engineering teams</span>
            <span className="hidden sm:block">·</span>
            <span><strong className="text-foreground">2M+</strong> files converted</span>
            <span className="hidden sm:block">·</span>
            <span>SOC 2 aligned</span>
          </div>
        </section>

        {/* ── Conversion pairs ──────────────────────────────────────────────── */}
        <section className="border-y border-border bg-surface-1 py-12">
          <div className="container">
            <p className="mb-8 text-center text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Supported conversions
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              {CONVERSIONS.map(({ from, to, badge }) => (
                <div
                  key={`${from}-${to}`}
                  className="flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium shadow-sm"
                >
                  <span className="font-semibold text-foreground">{from}</span>
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="font-semibold text-foreground">{to}</span>
                  {badge && (
                    <span className="ml-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
                      {badge}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Features grid ────────────────────────────────────────────────── */}
        <section className="py-24">
          <div className="container">
            <div className="mx-auto mb-16 max-w-2xl text-center">
              <h2 className="mb-4 text-3xl font-bold tracking-tight sm:text-4xl">
                Built for production-grade migrations
              </h2>
              <p className="text-lg text-muted-foreground">
                Every feature is designed for real engineering teams — not demos.
              </p>
            </div>

            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map(({ icon: Icon, title, description }) => (
                <div
                  key={title}
                  className="group relative overflow-hidden rounded-xl border border-border bg-card p-6 shadow-card transition-shadow hover:shadow-card-hover"
                >
                  <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-surface-1">
                    <Icon className="h-5 w-5 text-primary" />
                  </div>
                  <h3 className="mb-2 font-semibold">{title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── How it works ─────────────────────────────────────────────────── */}
        <section className="border-y border-border bg-surface-1 py-24">
          <div className="container">
            <div className="mx-auto mb-16 max-w-2xl text-center">
              <h2 className="mb-4 text-3xl font-bold tracking-tight sm:text-4xl">
                How CodeMorph works
              </h2>
              <p className="text-lg text-muted-foreground">
                Three steps to production-ready converted code.
              </p>
            </div>

            <div className="relative mx-auto grid max-w-4xl gap-8 sm:grid-cols-3">
              {[
                {
                  step: '01',
                  title: 'Upload your project',
                  desc:  'Drop a ZIP, paste a GitHub URL, or connect your repository. We support any directory structure.',
                },
                {
                  step: '02',
                  title: 'AI builds the IR',
                  desc:  'Our engine parses your code into a framework-agnostic Intermediate Representation — preserving every business rule.',
                },
                {
                  step: '03',
                  title: 'Download converted code',
                  desc:  'Get clean, typed, linted output in your target framework. Ready to open a PR.',
                },
              ].map(({ step, title, desc }) => (
                <div key={step} className="relative flex flex-col gap-4">
                  <div className="text-4xl font-black text-primary/20">{step}</div>
                  <h3 className="text-lg font-semibold">{title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Pricing ──────────────────────────────────────────────────────── */}
        <section className="py-24">
          <div className="container">
            <div className="mx-auto mb-16 max-w-2xl text-center">
              <h2 className="mb-4 text-3xl font-bold tracking-tight sm:text-4xl">
                Simple, transparent pricing
              </h2>
              <p className="text-lg text-muted-foreground">
                Start free. Upgrade when you need more.
              </p>
            </div>

            <div className="mx-auto grid max-w-3xl gap-6 sm:grid-cols-2">
              {/* Free */}
              <div className="rounded-xl border border-border bg-card p-8 shadow-card">
                <div className="mb-6">
                  <p className="text-sm font-semibold text-muted-foreground">Free</p>
                  <div className="mt-2 flex items-baseline gap-1">
                    <span className="text-4xl font-black">$0</span>
                    <span className="text-muted-foreground">/month</span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">Forever free. No credit card.</p>
                </div>
                <ul className="mb-8 space-y-3">
                  {PLAN_FREE.map((f) => (
                    <li key={f} className="flex items-center gap-2.5 text-sm">
                      <Check className="h-4 w-4 shrink-0 text-primary" />
                      {f}
                    </li>
                  ))}
                </ul>
                <Link
                  href="/auth/sign-up"
                  className="flex h-10 w-full items-center justify-center rounded-lg border border-border bg-background text-sm font-semibold hover:bg-accent transition-all"
                >
                  Get started free
                </Link>
              </div>

              {/* Pro */}
              <div className="relative overflow-hidden rounded-xl border border-primary/50 bg-card p-8 shadow-glow-sm">
                <div className="absolute right-4 top-4 rounded-full gradient-brand px-3 py-0.5 text-xs font-bold text-white shadow-sm">
                  Most popular
                </div>
                <div className="mb-6">
                  <p className="text-sm font-semibold text-primary">Pro</p>
                  <div className="mt-2 flex items-baseline gap-1">
                    <span className="text-4xl font-black">$29</span>
                    <span className="text-muted-foreground">/month</span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">Everything you need for serious migrations.</p>
                </div>
                <ul className="mb-8 space-y-3">
                  {PLAN_PRO.map((f) => (
                    <li key={f} className="flex items-center gap-2.5 text-sm">
                      <Check className="h-4 w-4 shrink-0 text-primary" />
                      {f}
                    </li>
                  ))}
                </ul>
                <Link
                  href="/auth/sign-up?plan=pro"
                  className="flex h-10 w-full items-center justify-center rounded-lg gradient-brand text-sm font-semibold text-white shadow-sm hover:opacity-90 transition-all"
                >
                  Start Pro trial
                </Link>
              </div>
            </div>

            <p className="mt-6 text-center text-sm text-muted-foreground">
              Need enterprise?{' '}
              <Link href="/contact" className="text-primary hover:underline">
                Contact us →
              </Link>
            </p>
          </div>
        </section>

        {/* ── CTA ──────────────────────────────────────────────────────────── */}
        <section className="border-t border-border py-24">
          <div className="container text-center">
            <h2 className="mb-4 text-3xl font-bold tracking-tight sm:text-4xl">
              Ready to migrate your codebase?
            </h2>
            <p className="mb-8 text-lg text-muted-foreground">
              Join 500+ teams using CodeMorph in production.
            </p>
            <Link
              href="/auth/sign-up"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-xl gradient-brand px-10 text-base font-semibold text-white shadow-lg hover:opacity-90 hover:shadow-glow-md transition-all"
            >
              Start for free — no credit card required
            </Link>
          </div>
        </section>
      </main>

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <footer className="border-t border-border bg-surface-1 py-12">
        <div className="container">
          <div className="flex flex-col items-center justify-between gap-6 sm:flex-row">
            <Link href="/" className="flex items-center gap-2 text-sm font-bold">
              <div className="flex h-6 w-6 items-center justify-center rounded gradient-brand">
                <Code2 className="h-3 w-3 text-white" />
              </div>
              CodeMorph
            </Link>

            <nav className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
              <Link href="/pricing" className="hover:text-foreground transition-colors">Pricing</Link>
              <Link href="/docs"    className="hover:text-foreground transition-colors">Docs</Link>
              <Link href="/blog"    className="hover:text-foreground transition-colors">Blog</Link>
              <Link href="/privacy" className="hover:text-foreground transition-colors">Privacy</Link>
              <Link href="/terms"   className="hover:text-foreground transition-colors">Terms</Link>
            </nav>

            <p className="text-xs text-muted-foreground">
              © {new Date().getFullYear()} CodeMorph Inc.
            </p>
          </div>
        </div>
      </footer>
    </>
  );
}
