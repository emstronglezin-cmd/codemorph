import type React from 'react';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Conversions' };

export default function ConversionsPage(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Conversions</h1>
        <p className="text-muted-foreground">Track all your code conversion jobs.</p>
      </div>
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <p className="text-muted-foreground text-sm">No conversions yet. Start a new conversion from the dashboard.</p>
      </div>
    </div>
  );
}
