import type React from 'react';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Organisation' };

export default function OrgPage(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Organisation</h1>
        <p className="text-muted-foreground">Manage your team and organisation settings.</p>
      </div>
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <p className="text-muted-foreground text-sm">Organisation workspace coming soon. Available on Pro Max plan.</p>
      </div>
    </div>
  );
}
