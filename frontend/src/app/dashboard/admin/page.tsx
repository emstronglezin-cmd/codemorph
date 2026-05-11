'use client';

import { useQuery } from '@tanstack/react-query';
import { useState }  from 'react';
import { apiClient } from '@/lib/api/client';
import { cn }        from '@/lib/utils';
import { PlanBadge } from '@/components/subscription/PlanBadge';
import type { Plan } from '@/hooks/useSubscription';

// ── Types ────────────────────────────────────────────────
interface AdminOverview {
  totalUsers:        number;
  totalJobs:         number;
  activeJobs:        number;
  failedJobs24h:     number;
  successRate:       number;
  avgDurationMs:     number;
  revenueThisMonth:  number;
  mrr:               number;
  totalConversions:  number;
  aiTokensUsed:      number;
  errorCount:        number;
}

interface AdminUser {
  id:        string;
  name:      string;
  email:     string;
  plan:      Plan;
  status:    string;
  jobsCount: number;
  createdAt: string;
}

interface AdminJob {
  id:             string;
  status:         string;
  sourceLanguage: string;
  targetLanguage: string;
  userId:         string;
  createdAt:      string;
  completedAt?:   string;
  errorMessage?:  string;
}

// ── Fetchers ──────────────────────────────────────────────
const fetchOverview   = () => apiClient.get<AdminOverview>('/admin/overview').then(r => r.data);
const fetchUsers      = (p: number) => apiClient.get<{ data: AdminUser[]; total: number }>(`/admin/users?page=${p}&limit=15`).then(r => r.data);
const fetchJobs       = (p: number) => apiClient.get<{ data: AdminJob[]; total: number }>(`/admin/jobs?page=${p}&limit=15`).then(r => r.data);

// ── Helpers ───────────────────────────────────────────────
function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
function fmtDuration(ms: number): string {
  if (ms < 1_000)     return `${ms}ms`;
  if (ms < 60_000)    return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: '2-digit' });
}

const STATUS_BADGE: Record<string, string> = {
  pending:    'bg-slate-100 text-slate-600',
  analyzing:  'bg-blue-100 text-blue-700',
  converting: 'bg-violet-100 text-violet-700',
  done:       'bg-green-100 text-green-700',
  failed:     'bg-red-100 text-red-700',
  active:     'bg-green-100 text-green-700',
  inactive:   'bg-slate-100 text-slate-500',
  suspended:  'bg-red-100 text-red-700',
};

// ── Stat card ─────────────────────────────────────────────
function KPICard({ icon, label, value, sub, trend }: {
  icon: string; label: string; value: string | number; sub?: string; trend?: 'up' | 'down' | 'neutral';
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-3">
        <span className="text-2xl">{icon}</span>
        {trend && (
          <span className={cn(
            'text-xs font-semibold px-1.5 py-0.5 rounded-full',
            trend === 'up'   ? 'text-green-700 bg-green-100' :
            trend === 'down' ? 'text-red-700 bg-red-100' :
                               'text-slate-600 bg-slate-100',
          )}>
            {trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→'}
          </span>
        )}
      </div>
      <p className="text-2xl font-extrabold text-slate-900">{value}</p>
      <p className="text-xs font-medium text-slate-500 mt-0.5">{label}</p>
      {sub && <p className="text-xs text-slate-400 mt-1">{sub}</p>}
    </div>
  );
}

// ── Main component ────────────────────────────────────────
export default function AdminDashboardPage() {
  const [tab,       setTab]       = useState<'overview' | 'users' | 'jobs'>('overview');
  const [usersPage, setUsersPage] = useState(1);
  const [jobsPage,  setJobsPage]  = useState(1);

  const { data: overview, isLoading: ovLoading } = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn:  fetchOverview,
    refetchInterval: 30_000,
  });

  const { data: usersData, isLoading: usersLoading } = useQuery({
    queryKey: ['admin', 'users', usersPage],
    queryFn:  () => fetchUsers(usersPage),
    enabled:  tab === 'users',
  });

  const { data: jobsData, isLoading: jobsLoading } = useQuery({
    queryKey: ['admin', 'jobs', jobsPage],
    queryFn:  () => fetchJobs(jobsPage),
    enabled:  tab === 'jobs',
  });

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-8">

      {/* ── Header ──────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Admin Dashboard</h1>
          <p className="text-sm text-slate-500 mt-1">Vue d'ensemble de la plateforme CodeMorph</p>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-full">
          <span className="w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
          <span className="text-xs font-semibold text-amber-700">Live · Mise à jour toutes les 30s</span>
        </div>
      </div>

      {/* ── KPI Grid ────────────────────────────────────── */}
      {ovLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[...Array(8)].map((_, i) => <div key={i} className="h-28 bg-slate-100 rounded-2xl animate-pulse" />)}
        </div>
      ) : overview ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <KPICard icon="👥" label="Utilisateurs total" value={fmtNum(overview.totalUsers)} trend="up" />
          <KPICard icon="⚡" label="Jobs total"        value={fmtNum(overview.totalJobs)} sub={`${overview.activeJobs} actifs`} />
          <KPICard icon="✅" label="Taux de succès"    value={`${overview.successRate}%`} trend={overview.successRate >= 90 ? 'up' : 'down'} />
          <KPICard icon="⏱️" label="Durée moyenne"    value={fmtDuration(overview.avgDurationMs)} />
          <KPICard icon="💰" label="MRR"               value={`$${fmtNum(overview.mrr)}`}            trend="up" />
          <KPICard icon="💳" label="Revenue ce mois"   value={`$${fmtNum(overview.revenueThisMonth)}`} />
          <KPICard icon="🤖" label="Tokens AI utilisés" value={fmtNum(overview.aiTokensUsed)}          sub="7 derniers jours" />
          <KPICard icon="🐛" label="Erreurs 24h"       value={overview.errorCount}                    trend={overview.errorCount > 10 ? 'down' : 'neutral'} />
        </div>
      ) : null}

      {/* ── Tabs ────────────────────────────────────────── */}
      <div className="flex gap-1 border-b border-slate-200">
        {([
          { id: 'overview', label: '📊 Vue d\'ensemble' },
          { id: 'users',    label: '👥 Utilisateurs'    },
          { id: 'jobs',     label: '⚡ Jobs'             },
        ] as const).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'px-4 py-2.5 text-sm font-semibold border-b-2 transition-all',
              tab === t.id
                ? 'border-violet-600 text-violet-700'
                : 'border-transparent text-slate-500 hover:text-slate-700',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Overview Tab ────────────────────────────────── */}
      {tab === 'overview' && overview && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Conversion stats */}
          <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
            <h3 className="font-bold text-slate-900 mb-4">Conversions</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between py-2 border-b border-slate-100">
                <span className="text-sm text-slate-600">Total conversions</span>
                <span className="font-bold text-slate-900">{fmtNum(overview.totalConversions)}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-slate-100">
                <span className="text-sm text-slate-600">Jobs actifs maintenant</span>
                <span className="font-bold text-violet-700">{overview.activeJobs}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-slate-100">
                <span className="text-sm text-slate-600">Échecs dernières 24h</span>
                <span className={cn('font-bold', overview.failedJobs24h > 5 ? 'text-red-600' : 'text-slate-900')}>
                  {overview.failedJobs24h}
                </span>
              </div>
              <div className="flex items-center justify-between py-2">
                <span className="text-sm text-slate-600">Taux de succès global</span>
                <div className="flex items-center gap-2">
                  <div className="w-24 h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className={cn('h-full rounded-full', overview.successRate >= 90 ? 'bg-green-500' : overview.successRate >= 70 ? 'bg-amber-500' : 'bg-red-500')}
                      style={{ width: `${overview.successRate}%` }}
                    />
                  </div>
                  <span className="font-bold text-slate-900 text-sm">{overview.successRate}%</span>
                </div>
              </div>
            </div>
          </div>

          {/* Revenue */}
          <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
            <h3 className="font-bold text-slate-900 mb-4">Revenus</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between py-2 border-b border-slate-100">
                <span className="text-sm text-slate-600">MRR (Monthly Recurring)</span>
                <span className="font-bold text-green-700">${fmtNum(overview.mrr)}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-slate-100">
                <span className="text-sm text-slate-600">Revenue ce mois</span>
                <span className="font-bold text-slate-900">${fmtNum(overview.revenueThisMonth)}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-slate-100">
                <span className="text-sm text-slate-600">Tokens AI (7j)</span>
                <span className="font-bold text-slate-900">{fmtNum(overview.aiTokensUsed)}</span>
              </div>
              <div className="flex items-center justify-between py-2">
                <span className="text-sm text-slate-600">Coût estimé AI (7j)</span>
                <span className="font-bold text-amber-700">
                  ${((overview.aiTokensUsed / 1_000) * 0.01).toFixed(2)}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Users Tab ───────────────────────────────────── */}
      {tab === 'users' && (
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
          {usersLoading ? (
            <div className="p-6 space-y-3">
              {[...Array(8)].map((_, i) => <div key={i} className="h-10 bg-slate-100 rounded-lg animate-pulse" />)}
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      {['Utilisateur', 'Email', 'Plan', 'Statut', 'Jobs', 'Inscrit le'].map(h => (
                        <th key={h} className="text-left py-3.5 px-4 font-semibold text-slate-600 text-xs uppercase tracking-wide">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {usersData?.data.map((user) => (
                      <tr key={user.id} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                        <td className="py-3 px-4">
                          <span className="font-medium text-slate-800">{user.name}</span>
                        </td>
                        <td className="py-3 px-4 text-slate-500">{user.email}</td>
                        <td className="py-3 px-4"><PlanBadge plan={user.plan} size="sm" /></td>
                        <td className="py-3 px-4">
                          <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full', STATUS_BADGE[user.status] ?? STATUS_BADGE.inactive)}>
                            {user.status}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-slate-600">{user.jobsCount}</td>
                        <td className="py-3 px-4 text-slate-400">{fmtDate(user.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination
                page={usersPage}
                total={usersData?.total ?? 0}
                perPage={15}
                onPageChange={setUsersPage}
              />
            </>
          )}
        </div>
      )}

      {/* ── Jobs Tab ────────────────────────────────────── */}
      {tab === 'jobs' && (
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
          {jobsLoading ? (
            <div className="p-6 space-y-3">
              {[...Array(8)].map((_, i) => <div key={i} className="h-10 bg-slate-100 rounded-lg animate-pulse" />)}
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      {['ID', 'Source → Target', 'Statut', 'Utilisateur', 'Créé le', 'Terminé le'].map(h => (
                        <th key={h} className="text-left py-3.5 px-4 font-semibold text-slate-600 text-xs uppercase tracking-wide">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {jobsData?.data.map((job) => (
                      <tr key={job.id} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                        <td className="py-3 px-4 font-mono text-xs text-slate-400">
                          {job.id.slice(0, 8)}…
                        </td>
                        <td className="py-3 px-4">
                          <span className="font-medium text-slate-800">
                            {job.sourceLanguage} → {job.targetLanguage}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          <span className={cn('text-xs font-semibold px-2 py-0.5 rounded-full capitalize', STATUS_BADGE[job.status] ?? STATUS_BADGE.pending)}>
                            {job.status}
                          </span>
                        </td>
                        <td className="py-3 px-4 font-mono text-xs text-slate-400">
                          {job.userId.slice(0, 8)}…
                        </td>
                        <td className="py-3 px-4 text-slate-400">{fmtDate(job.createdAt)}</td>
                        <td className="py-3 px-4 text-slate-400">
                          {job.completedAt ? fmtDate(job.completedAt) : (
                            job.status === 'failed'
                              ? <span className="text-red-500 text-xs" title={job.errorMessage}>Erreur</span>
                              : <span className="text-violet-500">En cours…</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination
                page={jobsPage}
                total={jobsData?.total ?? 0}
                perPage={15}
                onPageChange={setJobsPage}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Pagination component ──────────────────────────────────
function Pagination({ page, total, perPage, onPageChange }: {
  page: number; total: number; perPage: number; onPageChange: (p: number) => void;
}) {
  const totalPages = Math.ceil(total / perPage);
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 bg-slate-50/50">
      <p className="text-xs text-slate-500">
        {((page - 1) * perPage) + 1}–{Math.min(page * perPage, total)} sur {total}
      </p>
      <div className="flex gap-1">
        <button
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className="px-3 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-white disabled:opacity-40 transition-colors"
        >
          ← Préc
        </button>
        <span className="px-3 py-1.5 text-xs font-bold text-slate-700">
          {page} / {totalPages}
        </span>
        <button
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          className="px-3 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-white disabled:opacity-40 transition-colors"
        >
          Suiv →
        </button>
      </div>
    </div>
  );
}
