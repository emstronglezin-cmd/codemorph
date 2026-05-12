import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Team Members' };

export default function OrgMembersPage(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Team Members</h1>
        <p className="text-muted-foreground">Manage your team members and permissions.</p>
      </div>
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <p className="text-muted-foreground text-sm">Team management available on Pro Max plan.</p>
      </div>
    </div>
  );
}
