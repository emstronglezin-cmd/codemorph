'use client';
// ============================================================
// CodeMorph — NotificationCenter
// PHASE 13 : Centre de notifications
//   - Notifications dérivées de l'état des jobs (React Query)
//   - Badge compteur non-lu
//   - Dropdown liste notifications (terminé, échoué, actif)
//   - Marquer comme lu / Tout effacer
//   - Lien vers l'historique
// ============================================================
import type React from 'react';
import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import {
  Bell, CheckCircle2, XCircle, Loader2,
  Zap, X, ExternalLink,
} from 'lucide-react';
import { useJobs } from '@/hooks/useJobs';
import { cn }      from '@/lib/utils/cn';

// ── Types ─────────────────────────────────────────────────
interface Notification {
  id:        string;
  type:      'success' | 'error' | 'info' | 'warning';
  title:     string;
  body:      string;
  jobId:     string;
  timestamp: number;
  read:      boolean;
}

// ── Hook notifications ─────────────────────────────────────
function useNotifications() {
  const { data } = useJobs(1, 50);
  const jobs = data?.data ?? [];

  // Garder trace des états précédents pour détecter les transitions
  const prevStatesRef = useRef<Map<string, string>>(new Map());
  const [notifs, setNotifs] = useState<Notification[]>([]);

  useEffect(() => {
    const prev      = prevStatesRef.current;
    const newNotifs: Notification[] = [];

    for (const job of jobs) {
      const prevStatus = prev.get(job.id);

      // Nouvelle notification seulement si statut a changé
      if (prevStatus !== job.status) {
        if (job.status === 'done' || job.status === 'completed') {
          newNotifs.push({
            id:        `${job.id}-done-${Date.now()}`,
            type:      'success',
            title:     'Conversion terminée',
            body:      `${job.sourceLanguage} → ${job.targetLanguage} · ${job.filesGenerated ?? 0} fichiers`,
            jobId:     job.id,
            timestamp: Date.now(),
            read:      false,
          });
        } else if (job.status === 'failed') {
          newNotifs.push({
            id:        `${job.id}-failed-${Date.now()}`,
            type:      'error',
            title:     'Conversion échouée',
            body:      job.errorMessage ?? `${job.sourceLanguage} → ${job.targetLanguage}`,
            jobId:     job.id,
            timestamp: Date.now(),
            read:      false,
          });
        }
        prev.set(job.id, job.status);
      }
    }

    if (newNotifs.length > 0) {
      setNotifs(n => [...newNotifs, ...n].slice(0, 20)); // max 20
    }
  }, [jobs]);

  const markAllRead  = useCallback(() => setNotifs(n => n.map(x => ({ ...x, read: true }))), []);
  const clearAll     = useCallback(() => setNotifs([]), []);
  const markRead     = useCallback((id: string) => setNotifs(n => n.map(x => x.id === id ? { ...x, read: true } : x)), []);

  const unreadCount  = notifs.filter(n => !n.read).length;

  return { notifs, unreadCount, markAllRead, clearAll, markRead };
}

// ── Composant NotificationCenter ──────────────────────────
export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const { notifs, unreadCount, markAllRead, clearAll, markRead } = useNotifications();
  const panelRef = useRef<HTMLDivElement>(null);

  // Fermer au clic en dehors
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const NOTIF_ICONS: Record<string, React.ReactNode> = {
    success: <CheckCircle2 className="h-4 w-4 text-green-400" />,
    error:   <XCircle      className="h-4 w-4 text-red-400"   />,
    info:    <Zap          className="h-4 w-4 text-blue-400"  />,
    warning: <Loader2      className="h-4 w-4 text-warning animate-spin" />,
  };

  const NOTIF_BG: Record<string, string> = {
    success: 'bg-green-500/10 border-green-500/20',
    error:   'bg-red-500/10   border-red-500/20',
    info:    'bg-blue-500/10  border-blue-500/20',
    warning: 'bg-warning/10   border-warning/20',
  };

  function relTime(ts: number) {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60_000);
    if (m < 1)  return 'à l\'instant';
    if (m < 60) return `il y a ${m} min`;
    return `il y a ${Math.floor(m / 60)} h`;
  }

  return (
    <div className="relative" ref={panelRef}>
      {/* Bouton cloche */}
      <button
        onClick={() => { setOpen(!open); if (!open && unreadCount > 0) markAllRead(); }}
        className="relative flex h-8 w-8 items-center justify-center rounded-md hover:bg-accent transition-colors"
        aria-label="Notifications"
      >
        <Bell className="h-4 w-4 text-muted-foreground" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* Panneau */}
      {open && (
        <div className="absolute right-0 top-10 z-50 w-80 rounded-xl border border-border bg-popover shadow-lg animate-fade-in">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <p className="text-sm font-semibold text-foreground">Notifications</p>
            <div className="flex items-center gap-2">
              {notifs.length > 0 && (
                <button
                  onClick={clearAll}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Tout effacer
                </button>
              )}
              <button onClick={() => setOpen(false)}>
                <X className="h-4 w-4 text-muted-foreground hover:text-foreground" />
              </button>
            </div>
          </div>

          {/* Liste */}
          <div className="max-h-80 overflow-y-auto divide-y divide-border">
            {notifs.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <Bell className="h-8 w-8 text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground">Aucune notification</p>
                <p className="text-xs text-muted-foreground/60">
                  Vos notifications de conversion apparaîtront ici
                </p>
              </div>
            ) : (
              notifs.map(n => (
                <div
                  key={n.id}
                  onClick={() => markRead(n.id)}
                  className={cn(
                    'flex items-start gap-3 px-4 py-3 transition-colors cursor-pointer hover:bg-accent/30',
                    !n.read && 'bg-accent/10',
                  )}
                >
                  <div className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border mt-0.5',
                    NOTIF_BG[n.type],
                  )}>
                    {NOTIF_ICONS[n.type]}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={cn(
                      'text-sm font-medium leading-tight',
                      !n.read && 'text-foreground',
                      n.read  && 'text-muted-foreground',
                    )}>
                      {n.title}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">{n.body}</p>
                    <p className="text-xs text-muted-foreground/60 mt-0.5">{relTime(n.timestamp)}</p>
                  </div>
                  {!n.read && (
                    <div className="h-2 w-2 rounded-full bg-primary mt-1.5 shrink-0" />
                  )}
                </div>
              ))
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-border px-4 py-2.5">
            <Link
              href="/dashboard/history"
              onClick={() => setOpen(false)}
              className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ExternalLink className="h-3 w-3" />
              Voir tout l&apos;historique
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
