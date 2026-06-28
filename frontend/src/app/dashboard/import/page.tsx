'use client';
// ============================================================
// CodeMorph — /dashboard/import → REDIRECT
// Cette page est remplacée par le flux inline dans /dashboard/projects/new
// Les utilisateurs sont redirigés vers /dashboard/history
// ============================================================
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

export default function ImportRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    // Rediriger vers la page Historique — le flux GitHub est désormais inline
    // dans l'étape 2 de /dashboard/projects/new
    router.replace('/dashboard/history');
  }, [router]);

  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Redirection vers l'historique…</p>
      </div>
    </div>
  );
}
