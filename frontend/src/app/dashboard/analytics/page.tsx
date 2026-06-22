'use client';
// ============================================================
// CodeMorph — Analytics Page (stats réelles depuis API)
// ============================================================
import type React from 'react';
import { useEffect, useState } from 'react';
import { TrendingUp, Zap, CheckCircle2, Clock, BarChart3, Code2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { getAccessToken } from '@/lib/api/client';

const BACKEND = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

interface Job {
  id: string; status: string; sourceLanguage: string; targetLanguage: string;
  progress: number; filesGenerated?: number; linesGenerated?: number; createdAt: string;
}
interface Project {
  id: string; name: string; sourceLanguage: string; targetLanguage: string; createdAt: string;
}

function authH() {
  const t = getAccessToken();
  return { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}

/** Mini barre horizontale pour visualisation */
function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max === 0 ? 0 : Math.round((value / max) * 100);
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-700 ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums w-6 text-right">{value}</span>
    </div>
  );
}

export default function AnalyticsPage(): React.JSX.Element {
  const [jobs,     setJobs]     = useState<Job[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    const h = authH();
    Promise.all([
      fetch(`${BACKEND}/jobs`,     { headers: h }).then(r => r.ok ? r.json() : { data: [] }),
      fetch(`${BACKEND}/projects`, { headers: h }).then(r => r.ok ? r.json() : { data: [] }),
    ]).then(([jd, pd]) => {
      setJobs(Array.isArray(jd.data ?? jd) ? (jd.data ?? jd) : []);
      setProjects(Array.isArray(pd.data ?? pd) ? (pd.data ?? pd) : []);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  // ── Calculs stats ────────────────────────────────────────
  const completed = jobs.filter(j => ['done','completed'].includes(j.status));
  const failed    = jobs.filter(j => j.status === 'failed');
  const active    = jobs.filter(j => ['pending','analyzing','converting'].includes(j.status));

  const successRate = completed.length + failed.length > 0
    ? ((completed.length / (completed.length + failed.length)) * 100).toFixed(1)
    : '100.0';

  const totalFiles = jobs.reduce((s, j) => s + (j.filesGenerated ?? 0), 0);
  const totalLines = jobs.reduce((s, j) => s + (j.linesGenerated ?? 0), 0);

  // Langages source les plus utilisés
  const langCount: Record<string, number> = {};
  jobs.forEach(j => { langCount[j.sourceLanguage] = (langCount[j.sourceLanguage] ?? 0) + 1; });
  const topLangs = Object.entries(langCount).sort((a,b) => b[1]-a[1]).slice(0, 6);
  const maxLang  = topLangs[0]?.[1] ?? 1;

  // Targets les plus utilisées
  const targetCount: Record<string, number> = {};
  jobs.forEach(j => { targetCount[j.targetLanguage] = (targetCount[j.targetLanguage] ?? 0) + 1; });
  const topTargets = Object.entries(targetCount).sort((a,b) => b[1]-a[1]).slice(0, 6);
  const maxTarget  = topTargets[0]?.[1] ?? 1;

  // Jobs par statut (pour le donut textuel)
  const statusData = [
    { label: 'Terminés',    value: completed.length, color: 'bg-success'   },
    { label: 'Actifs',      value: active.length,    color: 'bg-warning'   },
    { label: 'Échoués',     value: failed.length,    color: 'bg-red-500'   },
  ].filter(d => d.value > 0);

  // Activité des 7 derniers jours
  const days7: Record<string, number> = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    days7[d.toISOString().slice(0, 10)] = 0;
  }
  jobs.forEach(j => {
    const day = j.createdAt.slice(0, 10);
    if (day in days7) days7[day]++;
  });
  const dayEntries = Object.entries(days7);
  const maxDay = Math.max(...dayEntries.map(d => d[1]), 1);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
        <p className="text-muted-foreground">Statistiques et métriques de conversion en temps réel.</p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[
          { label:'Total Jobs',      value: loading ? '…' : String(jobs.length),       icon:Zap,          color:'text-warning',  bg:'bg-warning/10'  },
          { label:'Taux de succès',  value: loading ? '…' : `${successRate}%`,         icon:TrendingUp,   color:'text-success',  bg:'bg-success/10'  },
          { label:'Fichiers générés',value: loading ? '…' : totalFiles.toLocaleString(),icon:Code2,        color:'text-info',     bg:'bg-info/10'     },
          { label:'Projets total',   value: loading ? '…' : String(projects.length),   icon:CheckCircle2, color:'text-primary',  bg:'bg-primary/10'  },
        ].map(kpi => (
          <Card key={kpi.label}>
            <CardContent className="p-5">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">{kpi.label}</p>
                  <p className="text-2xl font-bold mt-1">{kpi.value}</p>
                </div>
                <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${kpi.bg}`}>
                  <kpi.icon className={`h-4 w-4 ${kpi.color}`} />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">

        {/* Activité 7 jours */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="h-4 w-4" /> Activité — 7 derniers jours
            </CardTitle>
            <CardDescription>Nombre de jobs lancés par jour</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-3">{[1,2,3,4,5,6,7].map(i => <div key={i} className="h-6 rounded bg-muted animate-pulse" />)}</div>
            ) : (
              <div className="space-y-3">
                {dayEntries.map(([day, count]) => (
                  <div key={day} className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground w-20 shrink-0">
                      {new Date(day + 'T12:00:00').toLocaleDateString('fr-FR', { weekday:'short', day:'numeric', month:'short' })}
                    </span>
                    <div className="flex-1 h-6 rounded-lg bg-muted overflow-hidden relative">
                      <div
                        className="h-full rounded-lg bg-primary/70 transition-all duration-700"
                        style={{ width: `${maxDay === 0 ? 0 : (count/maxDay)*100}%` }}
                      />
                      {count > 0 && (
                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs font-medium text-white">
                          {count}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Répartition des statuts */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4" /> Répartition des statuts
            </CardTitle>
            <CardDescription>Distribution des jobs par état</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-4">{[1,2,3].map(i => <div key={i} className="h-8 rounded bg-muted animate-pulse" />)}</div>
            ) : jobs.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">Aucune donnée disponible</p>
            ) : (
              <div className="space-y-4">
                {statusData.map(s => (
                  <div key={s.label} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium">{s.label}</span>
                      <span className="text-muted-foreground">
                        {s.value} ({jobs.length > 0 ? Math.round((s.value/jobs.length)*100) : 0}%)
                      </span>
                    </div>
                    <div className="h-3 rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-700 ${s.color}`}
                        style={{ width: `${jobs.length === 0 ? 0 : (s.value/jobs.length)*100}%` }}
                      />
                    </div>
                  </div>
                ))}
                {statusData.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-8">Aucun job à afficher</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Top langages source */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Code2 className="h-4 w-4" /> Langages source
            </CardTitle>
            <CardDescription>Les langages les plus convertis</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-5 rounded bg-muted animate-pulse" />)}</div>
            ) : topLangs.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">Aucune donnée disponible</p>
            ) : (
              <div className="space-y-3">
                {topLangs.map(([lang, count]) => (
                  <div key={lang} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="font-medium capitalize">{lang}</span>
                    </div>
                    <Bar value={count} max={maxLang} color="bg-violet-500" />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Top langages cible */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="h-4 w-4" /> Langages cible
            </CardTitle>
            <CardDescription>Les cibles de conversion les plus populaires</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-5 rounded bg-muted animate-pulse" />)}</div>
            ) : topTargets.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">Aucune donnée disponible</p>
            ) : (
              <div className="space-y-3">
                {topTargets.map(([lang, count]) => (
                  <div key={lang} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="font-medium capitalize">{lang}</span>
                    </div>
                    <Bar value={count} max={maxTarget} color="bg-indigo-500" />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Résumé global */}
      {!loading && totalLines > 0 && (
        <Card>
          <CardContent className="p-6">
            <div className="flex flex-wrap items-center justify-around gap-6 text-center">
              <div>
                <p className="text-3xl font-bold text-primary">{totalLines.toLocaleString('fr-FR')}</p>
                <p className="text-sm text-muted-foreground mt-1">Lignes de code générées</p>
              </div>
              <div className="h-12 w-px bg-border hidden sm:block" />
              <div>
                <p className="text-3xl font-bold text-success">{totalFiles.toLocaleString('fr-FR')}</p>
                <p className="text-sm text-muted-foreground mt-1">Fichiers créés</p>
              </div>
              <div className="h-12 w-px bg-border hidden sm:block" />
              <div>
                <p className="text-3xl font-bold text-info">{successRate}%</p>
                <p className="text-sm text-muted-foreground mt-1">Taux de succès global</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
