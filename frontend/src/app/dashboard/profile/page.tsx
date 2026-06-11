import type React from 'react';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Profile' };

export default function ProfilePage(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Profile</h1>
        <p className="text-muted-foreground">Manage your personal information and preferences.</p>
      </div>
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <p className="text-muted-foreground text-sm">Profile settings coming soon.</p>
      </div>
    </div>
  );
}
