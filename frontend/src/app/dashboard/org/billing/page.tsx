import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Organisation Billing' };

export default function OrgBillingPage(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Organisation Billing</h1>
        <p className="text-muted-foreground">Manage billing for your organisation.</p>
      </div>
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <p className="text-muted-foreground text-sm">Organisation billing management coming soon.</p>
      </div>
    </div>
  );
}
