'use client';
// ============================================================
// CodeMorph — Health Screen (/dashboard/health)
// PHASE 14 : Observabilité
//   - Statut Backend (GET /health)
//   - Statut Redis (via /health)
//   - Statut Bull Queue (via /health)
//   - Statut DB (via /health)
//   - Jobs actifs en temps réel
//   - Auto-refresh 30s
// ============================================================
import type React from 'react';
import { useEffect, useState, useCallback } from 'react';
import {
  Activity, CheckCircle2, XCircle, AlertTriangle,
  Loader2, RefreshCw, Database, Zap, Server,
  Clock,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge }  from '@/components/ui/badge';
import { getAccessToken } from '@/lib/api/client';
import { cn } from '@/lib/utils/cn';

const BACKEND = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

// ── Types ─────────────────────────────────────────────────
interface HealthStatus {
  status: 'ok' | 'error' | 'warning' | 'loading' | 'unknown';
  info?:  Record<string, unknown>;
  error?: string;
}

interface HealthReport {
  overall: 'ok' | 'degraded' | 'down' | 'loading';
  backend: HealthStatus;
  db:      HealthStatus;
  redis:   HealthStatus;
  queue:   HealthStatus;
  lastChecked: Date | null;
}

// ── Helpers ───────────────────────────────────────────────
function authH() {
  const t = getAccessToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

function StatusIcon({ status }: { status: HealthStatus['status'] }) {
  if (status === 'ok')      return <CheckCircle2 className="h-5 w-5 text-green-400" />;
  if (status === 'error')   return <XCircle      className="h-5 w-5 text-red-400"   />;
  if (status === 'warning') return <AlertTriangle className="h-5 w-5 text-warning"  />;
  if (status === 'loading') return <Loader2      className="h-5 w-5 text-muted-foreground animate-spin" />;
  return <AlertTriangle className="h-5 w-5 text-muted-foreground" />;
}

function statusLabel(s: HealthStatus['status']): string {
  const m: Record<string, string> = {
    ok: 'Opérationnel', error: 'En panne', warning: 'Dégradé',
    loading: 'Vérification…', unknown: 'Inconnu',
  };
  return m[s] ?? s;
}

function statusVariant(s: HealthStatus['status']): 'success'|'error'|'warning'|'default' {
  if (s === 'ok')      return 'success';
  if (s === 'error')   return 'error';
  if (s === 'warning') return 'warning';
  return 'default';
}

// ── Main Page ─────────────────────────────────────────────
export default function HealthPage(): React.JSX.Element {
  const [report, setReport] = useState<HealthReport>({
    overall:     'loading',
    backend:     { status: 'loading' },
    db:          { status: 'loading' },
    redis:       { status: 'loading' },
    queue:       { status: 'loading' },
    lastChecked: null,
  });
  const [loading, setLoading] = useState(false);

  const checkHealth = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${BACKEND}/health`, { headers: authH() });
      const raw = await res.json() as Record<string, unknown>;

      // Analyser la réponse Terminus
      const details = raw['info'] as Record<string, { status: string }> ?? {};
      const err     = raw['error'] as Record<string, { status: string; message?: string }> ?? {};

      const getStatus = (key: string): HealthStatus => {
        if (details[key]) return { status: details[key].status === 'up' ? 'ok' : 'warning', info: details[key] as Record<string, unknown> };
        if (err[key])     return { status: 'error', error: err[key].message ?? 'Service unavailable', info: err[key] as Record<string, unknown> };
        return { status: 'unknown' };
      };

      const backend: HealthStatus = res.ok ? { status: 'ok' } : { status: 'error', error: `HTTP ${res.status}` };
      const db    = getStatus('database');
      const redis = getStatus('redis') ?? getStatus('redis-cache');
      const queue = getStatus('bullQueue') ?? getStatus('queue');

      const allStatuses = [backend.status, db.status, redis.status, queue.status];
      const overall = allStatuses.includes('error') ? 'down' :
                      allStatuses.includes('warning') || allStatuses.includes('unknown') ? 'degraded' : 'ok';

      setReport({ overall, backend, db, redis, queue, lastChecked: new Date() });
    } catch (e) {
      setReport(r => ({
        ...r,
        overall: 'down',
        backend: { status: 'error', error: (e as Error).message },
        lastChecked: new Date(),
      }));
    } finally {
      setLoading(false);
    }
  }, []);

  // Check au montage + toutes les 30s
  useEffect(() => {
    void checkHealth();
    const id = setInterval(() => void checkHealth(), 30_000);
    return () => clearInterval(id);
  }, [checkHealth]);

  const SERVICES = [
    { key: 'backend', label: 'Backend API',  icon: Server,   status: report.backend },
    { key: 'db',      label: 'PostgreSQL',   icon: Database, status: report.db      },
    { key: 'redis',   label: 'Redis / Cache',icon: Activity, status: report.redis   },
    { key: 'queue',   label: 'Bull Queue',   icon: Zap,      status: report.queue   },
  ];

  const OVERALL_CFG = {
    ok:      { label: 'Tous les services opérationnels',   color: 'text-green-400',  bg: 'bg-green-500/10  border-green-500/30'  },
    degraded:{ label: 'Services dégradés',                 color: 'text-warning',    bg: 'bg-warning/10    border-warning/30'    },
    down:    { label: 'Services en panne',                  color: 'text-red-400',    bg: 'bg-red-500/10    border-red-500/30'    },
    loading: { label: 'Vérification en cours…',            color: 'text-muted-foreground', bg: 'bg-muted border-border' },
  };

  const cfg = OVERALL_CFG[report.overall];

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Activity className="h-6 w-6 text-primary" />
            Santé du système
          </h1>
          <p className="text-sm text-muted-foreground">
            Statut en temps réel de tous les services CodeMorph
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void checkHealth()}
          disabled={loading}
          className="gap-2"
        >
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          Actualiser
        </Button>
      </div>

      {/* Statut global */}
      <div className={cn('flex items-center gap-4 rounded-xl border p-4', cfg.bg)}>
        {report.overall === 'loading'
          ? <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          : report.overall === 'ok'
            ? <CheckCircle2 className="h-6 w-6 text-green-400" />
            : report.overall === 'degraded'
              ? <AlertTriangle className="h-6 w-6 text-warning" />
              : <XCircle className="h-6 w-6 text-red-400" />
        }
        <div>
          <p className={cn('font-semibold', cfg.color)}>{cfg.label}</p>
          {report.lastChecked && (
            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
              <Clock className="h-3 w-3" />
              Dernière vérification : {report.lastChecked.toLocaleTimeString('fr-FR')}
            </p>
          )}
        </div>
      </div>

      {/* Services */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {SERVICES.map(({ key, label, icon: Icon, status }) => (
          <Card key={key} className={cn(
            'border',
            status.status === 'ok'      ? 'border-green-500/20' :
            status.status === 'error'   ? 'border-red-500/20'   :
            status.status === 'warning' ? 'border-warning/20'   : 'border-border',
          )}>
            <CardHeader className="pb-3 flex-row items-center gap-3">
              <div className={cn(
                'flex h-9 w-9 items-center justify-center rounded-lg',
                status.status === 'ok'      ? 'bg-green-500/10' :
                status.status === 'error'   ? 'bg-red-500/10'   :
                status.status === 'warning' ? 'bg-warning/10'   : 'bg-muted',
              )}>
                <Icon className={cn(
                  'h-5 w-5',
                  status.status === 'ok'      ? 'text-green-400' :
                  status.status === 'error'   ? 'text-red-400'   :
                  status.status === 'warning' ? 'text-warning'   : 'text-muted-foreground',
                )} />
              </div>
              <div className="flex-1">
                <CardTitle className="text-sm font-medium">{label}</CardTitle>
              </div>
              <div className="flex items-center gap-2">
                <StatusIcon status={status.status} />
                <Badge variant={statusVariant(status.status)} size="sm">
                  {statusLabel(status.status)}
                </Badge>
              </div>
            </CardHeader>
            {(status.error || status.info) && (
              <CardContent className="pt-0">
                {status.error && (
                  <p className="text-xs text-red-400 bg-red-500/5 rounded px-2 py-1 font-mono">
                    {status.error}
                  </p>
                )}
                {status.info && !status.error && (
                  <pre className="text-xs text-muted-foreground bg-muted/50 rounded px-2 py-1 overflow-auto max-h-24">
                    {JSON.stringify(status.info, null, 2)}
                  </pre>
                )}
              </CardContent>
            )}
          </Card>
        ))}
      </div>

      {/* Info actualisation */}
      <p className="text-center text-xs text-muted-foreground">
        Actualisation automatique toutes les 30 secondes
      </p>
    </div>
  );
}
