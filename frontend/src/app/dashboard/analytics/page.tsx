import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Analytics' };

export default function AnalyticsPage(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
        <p className="text-muted-foreground">Usage statistics and conversion metrics.</p>
      </div>
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <p className="text-muted-foreground text-sm">Analytics dashboard coming soon.</p>
      </div>
    </div>
  );
}
