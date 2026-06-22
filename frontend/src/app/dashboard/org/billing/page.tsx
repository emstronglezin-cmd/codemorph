'use client';
// ============================================================
// CodeMorph — Organisation Billing (redirect vers billing perso)
// ============================================================
import type React from 'react';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function OrgBillingPage(): React.JSX.Element {
  const router = useRouter();
  useEffect(() => { router.replace('/dashboard/billing'); }, [router]);
  return (
    <div className="flex items-center justify-center h-64">
      <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
