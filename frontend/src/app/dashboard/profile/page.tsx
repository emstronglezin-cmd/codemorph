'use client';
// ============================================================
// CodeMorph — Profile Page (/dashboard/profile)
// FIX-4 Phase 19 — Page Profil complète
// Sections :
//   1. Avatar + identité (nom, email, plan, date création)
//   2. Statistiques de conversions (depuis /jobs)
//   3. Connexion GitHub (statut + déconnecter)
//   4. Changer le mot de passe
//   5. Préférences (thème, langue, notifications)
//   6. Zone de danger (supprimer le compte)
// ============================================================
import type React from 'react';
import { useEffect, useState, useCallback } from 'react';
import {
  User, Mail, Lock, Trash2, Save, Eye, EyeOff, Check,
  Github, Zap, BarChart3, CheckCircle2, XCircle, Clock,
  Shield, Bell, Palette, LogOut, RefreshCw, AlertTriangle,
  TrendingUp, Code2, FileCode, Calendar, CreditCard,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAuthStore } from '@/stores/auth.store';
import { getAccessToken } from '@/lib/api/client';

// ── Constantes ────────────────────────────────────────────
const BACKEND = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

// ── Helpers ───────────────────────────────────────────────
function authH(): Record<string, string> {
  const t = getAccessToken();
  return { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' }).format(new Date(dateStr));
}

function unwrap<T>(data: unknown): T {
  if (data && typeof data === 'object' && 'data' in data) {
    return (data as { data: T }).data;
  }
  return data as T;
}

// ── Types ─────────────────────────────────────────────────
interface UserProfile {
  id:         string;
  name:       string;
  email:      string;
  avatarUrl?: string;
  plan:       string;
  role:       string;
  createdAt:  string;
}

interface GithubStatus {
  connected: boolean;
  login?:    string;
  avatarUrl?: string;
  authUrl:   string;
}

interface JobStats {
  total:      number;
  done:       number;
  failed:     number;
  active:     number;
  pending:    number;
  analyzing:  number;
  converting: number;
}

// ── Sub-components ────────────────────────────────────────

/** Wrapper de section uniforme */
function Section({ title, desc, icon: Icon, children, className = '' }: {
  title: string; desc: string; icon: React.ElementType;
  children: React.ReactNode; className?: string;
}) {
  return (
    <Card className={`border-border bg-card ${className}`}>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="h-4 w-4 text-primary" /> {title}
        </CardTitle>
        <CardDescription className="text-sm">{desc}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** Label + champ */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-foreground">{label}</label>
      {children}
    </div>
  );
}

/** Classe input standard */
const INPUT = 'w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 disabled:cursor-not-allowed';

/** Carte stat */
function StatCard({ label, value, icon, color = 'text-muted-foreground' }: {
  label: string; value: number; icon: React.ReactNode; color?: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-background p-4">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
        <span className={color}>{icon}</span>
      </div>
      <div className="min-w-0">
        <p className="text-xl font-bold text-foreground tabular-nums">{value}</p>
        <p className="text-xs text-muted-foreground truncate">{label}</p>
      </div>
    </div>
  );
}

/** Feedback banner */
function Feedback({ msg, type }: { msg: string; type: 'success' | 'error' | 'info' }) {
  const styles = {
    success: 'border-green-500/30 bg-green-500/10 text-green-400',
    error:   'border-red-500/30   bg-red-500/10   text-red-400',
    info:    'border-blue-500/30  bg-blue-500/10  text-blue-400',
  };
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${styles[type]}`}>
      {type === 'success' && <Check       className="mt-0.5 h-4 w-4 shrink-0" />}
      {type === 'error'   && <XCircle     className="mt-0.5 h-4 w-4 shrink-0" />}
      {type === 'info'    && <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
      <span>{msg}</span>
    </div>
  );
}

/** Badge plan */
function PlanBadge({ plan }: { plan: string }) {
  const cfg: Record<string, string> = {
    free:     'bg-muted text-muted-foreground border-border',
    pro:      'bg-blue-500/20 text-blue-400 border-blue-500/30',
    pro_max:  'bg-violet-500/20 text-violet-400 border-violet-500/30',
    lifetime: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  };
  const cls = cfg[plan.toLowerCase()] ?? cfg.free;
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold capitalize ${cls}`}>
      {plan === 'pro_max' ? 'Pro Max' : plan.charAt(0).toUpperCase() + plan.slice(1)}
    </span>
  );
}

// ── Main Page ─────────────────────────────────────────────
export default function ProfilePage(): React.JSX.Element {
  const authUser = useAuthStore(s => s.user);
  const setUser  = useAuthStore(s => s.setUser);
  const signOut  = useAuthStore(s => s.signOut);

  // ── State: données ────────────────────────────────────
  const [profile,  setProfile]  = useState<UserProfile | null>(null);
  const [github,   setGithub]   = useState<GithubStatus | null>(null);
  const [stats,    setStats]    = useState<JobStats | null>(null);
  const [loadingData, setLoadingData] = useState(true);

  // ── State: formulaires ────────────────────────────────
  const [name,      setName]      = useState('');
  const [saving,    setSaving]    = useState(false);
  const [saveMsg,   setSaveMsg]   = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [curPwd,    setCurPwd]    = useState('');
  const [newPwd,    setNewPwd]    = useState('');
  const [confPwd,   setConfPwd]   = useState('');
  const [showPwd,   setShowPwd]   = useState(false);
  const [pwdSaving, setPwdSaving] = useState(false);
  const [pwdMsg,    setPwdMsg]    = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [ghLoading, setGhLoading] = useState(false);
  const [ghMsg,     setGhMsg]     = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [delConfirm, setDelConfirm] = useState('');
  const [deleting,   setDeleting]   = useState(false);
  const [delMsg,     setDelMsg]     = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Préférences (stockées localement)
  const [notifEmail,   setNotifEmail]   = useState(true);
  const [notifBrowser, setNotifBrowser] = useState(false);

  // ── Charger les données ───────────────────────────────
  const loadData = useCallback(async () => {
    setLoadingData(true);
    try {
      const h = authH();
      const [profileRes, githubRes, statsRes] = await Promise.allSettled([
        fetch(`${BACKEND}/users/me`,        { headers: h }),
        fetch(`${BACKEND}/auth/github-status`, { headers: h }),
        fetch(`${BACKEND}/jobs/stats`,      { headers: h }),
      ]);

      // Profile
      if (profileRes.status === 'fulfilled' && profileRes.value.ok) {
        const raw  = await profileRes.value.json() as unknown;
        const data = unwrap<UserProfile>(raw);
        setProfile(data);
        setName(data.name ?? '');
      }

      // GitHub status
      if (githubRes.status === 'fulfilled' && githubRes.value.ok) {
        const raw  = await githubRes.value.json() as unknown;
        const data = unwrap<GithubStatus>(raw);
        setGithub(data);
      }

      // Stats
      if (statsRes.status === 'fulfilled' && statsRes.value.ok) {
        const raw  = await statsRes.value.json() as unknown;
        const data = unwrap<JobStats>(raw);
        setStats(data);
      }
    } finally {
      setLoadingData(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
    // Préférences locales
    if (typeof window !== 'undefined') {
      setNotifEmail(localStorage.getItem('cm_pref_notif_email') !== 'false');
      setNotifBrowser(localStorage.getItem('cm_pref_notif_browser') === 'true');
    }
  }, [loadData]);

  // ── Sauvegarder le profil ─────────────────────────────
  const handleSaveProfile = async () => {
    if (!name.trim()) return;
    setSaving(true); setSaveMsg(null);
    try {
      const res = await fetch(`${BACKEND}/users/me`, {
        method:  'PATCH',
        headers: authH(),
        body:    JSON.stringify({ name: name.trim() }),
      });
      if (res.ok) {
        const raw  = await res.json() as unknown;
        const data = unwrap<UserProfile>(raw);
        setProfile(data);
        if (authUser) setUser({ ...authUser, name: data.name });
        setSaveMsg({ type: 'success', text: 'Profil mis à jour avec succès.' });
        setTimeout(() => setSaveMsg(null), 4000);
      } else {
        const d = await res.json().catch(() => ({})) as { message?: string };
        setSaveMsg({ type: 'error', text: d.message ?? 'Erreur lors de la sauvegarde.' });
      }
    } catch {
      setSaveMsg({ type: 'error', text: 'Erreur réseau. Réessayez.' });
    } finally {
      setSaving(false);
    }
  };

  // ── Changer le mot de passe ───────────────────────────
  const handleChangePassword = async () => {
    if (!curPwd || !newPwd || !confPwd) {
      setPwdMsg({ type: 'error', text: 'Remplissez tous les champs.' }); return;
    }
    if (newPwd.length < 8) {
      setPwdMsg({ type: 'error', text: 'Le nouveau mot de passe doit faire au moins 8 caractères.' }); return;
    }
    if (newPwd !== confPwd) {
      setPwdMsg({ type: 'error', text: 'Les mots de passe ne correspondent pas.' }); return;
    }
    setPwdSaving(true); setPwdMsg(null);
    try {
      const res = await fetch(`${BACKEND}/auth/change-password`, {
        method:  'POST',
        headers: authH(),
        body:    JSON.stringify({ currentPassword: curPwd, newPassword: newPwd }),
      });
      if (res.ok) {
        setPwdMsg({ type: 'success', text: 'Mot de passe modifié avec succès.' });
        setCurPwd(''); setNewPwd(''); setConfPwd('');
        setTimeout(() => setPwdMsg(null), 5000);
      } else {
        const d = await res.json().catch(() => ({})) as { message?: string };
        setPwdMsg({ type: 'error', text: d.message ?? 'Mot de passe actuel incorrect.' });
      }
    } catch {
      setPwdMsg({ type: 'error', text: 'Erreur réseau. Réessayez.' });
    } finally {
      setPwdSaving(false);
    }
  };

  // ── Déconnecter GitHub ────────────────────────────────
  const handleDisconnectGithub = async () => {
    if (!confirm('Déconnecter GitHub ? Vous ne pourrez plus importer de dépôts GitHub.')) return;
    setGhLoading(true); setGhMsg(null);
    try {
      const res = await fetch(`${BACKEND}/users/me/github`, {
        method:  'DELETE',
        headers: authH(),
      });
      if (res.ok || res.status === 204) {
        setGithub(prev => prev ? { ...prev, connected: false, login: undefined } : null);
        setGhMsg({ type: 'success', text: 'GitHub déconnecté avec succès.' });
        setTimeout(() => setGhMsg(null), 4000);
      } else {
        const d = await res.json().catch(() => ({})) as { message?: string };
        setGhMsg({ type: 'error', text: d.message ?? 'Impossible de déconnecter GitHub.' });
      }
    } catch {
      setGhMsg({ type: 'error', text: 'Erreur réseau. Réessayez.' });
    } finally {
      setGhLoading(false);
    }
  };

  // ── Supprimer le compte ───────────────────────────────
  const handleDeleteAccount = async () => {
    if (delConfirm !== 'SUPPRIMER') {
      setDelMsg({ type: 'error', text: 'Tapez exactement SUPPRIMER pour confirmer.' }); return;
    }
    setDeleting(true); setDelMsg(null);
    try {
      const res = await fetch(`${BACKEND}/users/me`, {
        method:  'DELETE',
        headers: authH(),
      });
      if (res.ok || res.status === 204) {
        setDelMsg({ type: 'success', text: 'Compte supprimé. Déconnexion en cours…' });
        setTimeout(() => void signOut(), 2000);
      } else {
        const d = await res.json().catch(() => ({})) as { message?: string };
        setDelMsg({ type: 'error', text: d.message ?? 'Erreur lors de la suppression.' });
      }
    } catch {
      setDelMsg({ type: 'error', text: 'Erreur réseau. Réessayez.' });
    } finally {
      setDeleting(false);
    }
  };

  // ── Préférences ───────────────────────────────────────
  const togglePref = (key: string, value: boolean) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(key, String(value));
    }
  };

  // Données affichées (fallback sur authUser)
  const displayName  = profile?.name      ?? authUser?.name    ?? '—';
  const displayEmail = profile?.email     ?? authUser?.email   ?? '—';
  const displayPlan  = profile?.plan      ?? authUser?.plan    ?? 'free';
  const displayRole  = profile?.role      ?? authUser?.role    ?? 'user';
  const displayDate  = profile?.createdAt ?? null;
  const initials     = displayName.charAt(0).toUpperCase();

  // ── Render ────────────────────────────────────────────
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-0 sm:px-0">

      {/* ── En-tête ── */}
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Mon profil</h1>
          <p className="text-sm text-muted-foreground">Gérez votre identité, sécurité et préférences.</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void loadData()}
          disabled={loadingData}
          className="self-start gap-2 sm:self-auto"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loadingData ? 'animate-spin' : ''}`} />
          Actualiser
        </Button>
      </div>

      {/* ══════════════════════════════════════════════════
          1. CARTE IDENTITÉ
      ══════════════════════════════════════════════════ */}
      <Section title="Identité" desc="Votre profil public sur CodeMorph" icon={User}>
        <div className="space-y-5">

          {/* Avatar + infos */}
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            {/* Avatar */}
            <div className="flex shrink-0 flex-col items-center gap-2">
              <div className="relative">
                {(profile?.avatarUrl ?? authUser?.avatarUrl) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={profile?.avatarUrl ?? authUser?.avatarUrl}
                    alt={displayName}
                    className="h-20 w-20 rounded-full object-cover ring-2 ring-border"
                  />
                ) : (
                  <div className="flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-3xl font-bold text-white ring-2 ring-border">
                    {initials}
                  </div>
                )}
                {/* Indicateur plan */}
                <span className="absolute -bottom-1 -right-1">
                  <PlanBadge plan={displayPlan} />
                </span>
              </div>
            </div>

            {/* Infos rapides */}
            <div className="flex-1 space-y-2 min-w-0">
              <p className="text-lg font-semibold text-foreground truncate">{displayName}</p>
              <p className="text-sm text-muted-foreground truncate">{displayEmail}</p>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Shield   className="h-3.5 w-3.5" />
                  Rôle : <span className="capitalize font-medium text-foreground ml-1">{displayRole}</span>
                </span>
                <span className="flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5" />
                  Membre depuis : <span className="font-medium text-foreground ml-1">{formatDate(displayDate)}</span>
                </span>
                <span className="flex items-center gap-1">
                  <CreditCard className="h-3.5 w-3.5" />
                  Plan : <span className="ml-1"><PlanBadge plan={displayPlan} /></span>
                </span>
              </div>
            </div>
          </div>

          {/* Formulaire modification nom */}
          {saveMsg && <Feedback msg={saveMsg.text} type={saveMsg.type} />}

          <Field label="Nom complet">
            <input
              type="text"
              className={INPUT}
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Votre nom"
              disabled={saving || loadingData}
            />
          </Field>

          <Field label="Adresse email">
            <input
              type="email"
              className={INPUT}
              value={displayEmail}
              readOnly
              disabled
              title="L'email ne peut pas être modifié"
            />
            <p className="mt-1 text-xs text-muted-foreground">L&apos;email est lié à votre compte et ne peut pas être changé.</p>
          </Field>

          <div className="flex flex-wrap gap-3">
            <Button
              onClick={() => void handleSaveProfile()}
              disabled={saving || !name.trim() || name.trim() === (profile?.name ?? authUser?.name ?? '')}
              className="gap-2"
            >
              {saving
                ? <><RefreshCw className="h-4 w-4 animate-spin" /> Sauvegarde…</>
                : <><Save       className="h-4 w-4" /> Sauvegarder</>
              }
            </Button>
          </div>
        </div>
      </Section>

      {/* ══════════════════════════════════════════════════
          2. STATISTIQUES
      ══════════════════════════════════════════════════ */}
      <Section title="Statistiques de conversions" desc="Vos activités CodeMorph" icon={BarChart3}>
        {loadingData && !stats ? (
          <div className="flex items-center justify-center py-8">
            <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : stats ? (
          <div className="space-y-4">
            {/* Grille stats */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <StatCard label="Total"      value={stats.total}     icon={<BarChart3    className="h-4 w-4" />} color="text-muted-foreground" />
              <StatCard label="Terminés"   value={stats.done}      icon={<CheckCircle2 className="h-4 w-4" />} color="text-green-400" />
              <StatCard label="Actifs"     value={stats.active}    icon={<Zap          className="h-4 w-4" />} color="text-blue-400" />
              <StatCard label="En attente" value={stats.pending}   icon={<Clock        className="h-4 w-4" />} color="text-yellow-400" />
              <StatCard label="Échecs"     value={stats.failed}    icon={<XCircle      className="h-4 w-4" />} color="text-red-400" />
              <StatCard label="Taux succès" value={
                stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0
              } icon={<TrendingUp className="h-4 w-4" />} color="text-violet-400" />
            </div>

            {/* Barre de progression visuelle */}
            {stats.total > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Répartition</p>
                <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
                  {stats.done > 0 && (
                    <div
                      className="bg-green-500 transition-all duration-700"
                      style={{ width: `${(stats.done / stats.total) * 100}%` }}
                      title={`Terminés : ${stats.done}`}
                    />
                  )}
                  {(stats.active) > 0 && (
                    <div
                      className="bg-blue-500 transition-all duration-700"
                      style={{ width: `${(stats.active / stats.total) * 100}%` }}
                      title={`Actifs : ${stats.active}`}
                    />
                  )}
                  {stats.pending > 0 && (
                    <div
                      className="bg-yellow-500 transition-all duration-700"
                      style={{ width: `${(stats.pending / stats.total) * 100}%` }}
                      title={`En attente : ${stats.pending}`}
                    />
                  )}
                  {stats.failed > 0 && (
                    <div
                      className="bg-red-500 transition-all duration-700"
                      style={{ width: `${(stats.failed / stats.total) * 100}%` }}
                      title={`Échecs : ${stats.failed}`}
                    />
                  )}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-green-500" />Terminés</span>
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-blue-500"  />Actifs</span>
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-yellow-500"/>En attente</span>
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-red-500"   />Échecs</span>
                </div>
              </div>
            )}

            {stats.total === 0 && (
              <div className="flex flex-col items-center gap-3 py-6 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
                  <Code2 className="h-7 w-7 text-muted-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">Aucune conversion pour l&apos;instant.</p>
                <a
                  href="/dashboard/projects/new"
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity"
                >
                  <Zap className="h-4 w-4" /> Lancer une conversion
                </a>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground py-4 text-center">Statistiques indisponibles.</p>
        )}
      </Section>

      {/* ══════════════════════════════════════════════════
          3. GITHUB
      ══════════════════════════════════════════════════ */}
      <Section title="Connexion GitHub" desc="Importez vos dépôts directement depuis GitHub" icon={Github}>
        <div className="space-y-4">
          {ghMsg && <Feedback msg={ghMsg.text} type={ghMsg.type} />}

          {loadingData && !github ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <RefreshCw className="h-4 w-4 animate-spin" /> Chargement…
            </div>
          ) : github?.connected ? (
            /* GitHub connecté */
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-green-500/20 ring-1 ring-green-500/30">
                  <Github className="h-5 w-5 text-green-400" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground flex items-center gap-2">
                    GitHub connecté
                    <span className="inline-flex h-2 w-2 rounded-full bg-green-400" />
                  </p>
                  {github.login && (
                    <p className="text-xs text-muted-foreground">@{github.login}</p>
                  )}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleDisconnectGithub()}
                disabled={ghLoading}
                className="border-red-500/30 text-red-400 hover:bg-red-500/10 hover:border-red-500 self-start sm:self-auto gap-2 shrink-0"
              >
                {ghLoading
                  ? <><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Déconnexion…</>
                  : <><LogOut className="h-3.5 w-3.5" /> Déconnecter GitHub</>
                }
              </Button>
            </div>
          ) : (
            /* GitHub non connecté */
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted ring-1 ring-border">
                  <Github className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">GitHub non connecté</p>
                  <p className="text-xs text-muted-foreground">Connectez GitHub pour importer vos dépôts.</p>
                </div>
              </div>
              <a
                href={`${BACKEND}/auth/github`}
                className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors self-start sm:self-auto"
              >
                <Github className="h-4 w-4" />
                Connecter GitHub
              </a>
            </div>
          )}

          {/* Note de confidentialité */}
          <p className="text-xs text-muted-foreground border-t border-border pt-3 mt-2">
            <Shield className="inline h-3.5 w-3.5 mr-1 opacity-60" />
            Votre token GitHub est chiffré et n&apos;est jamais partagé. Il est utilisé uniquement pour lister et importer vos dépôts.
          </p>
        </div>
      </Section>

      {/* ══════════════════════════════════════════════════
          4. SÉCURITÉ — CHANGER MOT DE PASSE
      ══════════════════════════════════════════════════ */}
      <Section title="Sécurité" desc="Changez votre mot de passe" icon={Lock}>
        <div className="space-y-4">
          {pwdMsg && <Feedback msg={pwdMsg.text} type={pwdMsg.type} />}

          <Field label="Mot de passe actuel">
            <div className="relative">
              <input
                type={showPwd ? 'text' : 'password'}
                className={`${INPUT} pr-10`}
                value={curPwd}
                onChange={e => setCurPwd(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
              />
              <button
                type="button"
                onClick={() => setShowPwd(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showPwd ? 'Masquer' : 'Afficher'}
              >
                {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </Field>

          <Field label="Nouveau mot de passe">
            <input
              type={showPwd ? 'text' : 'password'}
              className={INPUT}
              value={newPwd}
              onChange={e => setNewPwd(e.target.value)}
              placeholder="Minimum 8 caractères"
              autoComplete="new-password"
            />
            {newPwd.length > 0 && newPwd.length < 8 && (
              <p className="mt-1 text-xs text-red-400">Au moins 8 caractères requis.</p>
            )}
          </Field>

          <Field label="Confirmer le nouveau mot de passe">
            <input
              type={showPwd ? 'text' : 'password'}
              className={INPUT}
              value={confPwd}
              onChange={e => setConfPwd(e.target.value)}
              placeholder="Répétez le mot de passe"
              autoComplete="new-password"
            />
            {confPwd.length > 0 && newPwd !== confPwd && (
              <p className="mt-1 text-xs text-red-400">Les mots de passe ne correspondent pas.</p>
            )}
          </Field>

          {/* Indicateur force */}
          {newPwd.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Force du mot de passe</p>
              <div className="flex gap-1">
                {[1,2,3,4].map(i => (
                  <div
                    key={i}
                    className={`h-1.5 flex-1 rounded-full transition-colors ${
                      i <= (newPwd.length >= 12 ? 4 : newPwd.length >= 10 ? 3 : newPwd.length >= 8 ? 2 : 1)
                        ? i === 1 ? 'bg-red-500'
                        : i === 2 ? 'bg-yellow-500'
                        : i === 3 ? 'bg-blue-500'
                        : 'bg-green-500'
                        : 'bg-muted'
                    }`}
                  />
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {newPwd.length < 8  ? 'Trop court' :
                 newPwd.length < 10 ? 'Faible' :
                 newPwd.length < 12 ? 'Moyen' : 'Fort'}
              </p>
            </div>
          )}

          <Button
            variant="outline"
            onClick={() => void handleChangePassword()}
            disabled={pwdSaving || !curPwd || !newPwd || !confPwd || newPwd !== confPwd}
            className="gap-2"
          >
            {pwdSaving
              ? <><RefreshCw className="h-4 w-4 animate-spin" /> Modification…</>
              : <><Lock className="h-4 w-4" /> Changer le mot de passe</>
            }
          </Button>
        </div>
      </Section>

      {/* ══════════════════════════════════════════════════
          5. PRÉFÉRENCES
      ══════════════════════════════════════════════════ */}
      <Section title="Préférences" desc="Personnalisez votre expérience CodeMorph" icon={Palette}>
        <div className="space-y-4">

          {/* Notifications */}
          <div className="space-y-3">
            <p className="text-sm font-medium text-foreground flex items-center gap-2">
              <Bell className="h-4 w-4 text-primary" /> Notifications
            </p>
            <div className="space-y-2.5">
              {[
                { label: 'Alertes email — fin de conversion', key: 'cm_pref_notif_email', value: notifEmail, set: setNotifEmail },
                { label: 'Notifications navigateur — jobs actifs', key: 'cm_pref_notif_browser', value: notifBrowser, set: setNotifBrowser },
              ].map(n => (
                <label key={n.key} className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-border p-3 hover:bg-muted/40 transition-colors">
                  <span className="text-sm text-foreground">{n.label}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={n.value}
                    onClick={() => { n.set(!n.value); togglePref(n.key, !n.value); }}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ${n.value ? 'bg-primary' : 'bg-muted'}`}
                  >
                    <span
                      className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow transition-transform ${n.value ? 'translate-x-5' : 'translate-x-1'}`}
                    />
                  </button>
                </label>
              ))}
            </div>
          </div>

          {/* Raccourcis clavier */}
          <div className="rounded-lg border border-border p-3 space-y-2">
            <p className="text-sm font-medium text-foreground flex items-center gap-2">
              <FileCode className="h-4 w-4 text-primary" /> Raccourcis clavier
            </p>
            <div className="grid grid-cols-1 gap-1.5 text-xs text-muted-foreground sm:grid-cols-2">
              {[
                { keys: '⌘ K', desc: 'Palette de commandes' },
                { keys: '⌘ N', desc: 'Nouveau projet' },
                { keys: '⌘ H', desc: 'Historique' },
                { keys: '⌘ P', desc: 'Profil' },
              ].map(k => (
                <div key={k.keys} className="flex items-center justify-between gap-2 rounded bg-muted/50 px-2.5 py-1.5">
                  <span>{k.desc}</span>
                  <kbd className="font-mono rounded border border-border bg-background px-1.5 py-0.5 text-[10px]">{k.keys}</kbd>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Section>

      {/* ══════════════════════════════════════════════════
          6. ZONE DE DANGER
      ══════════════════════════════════════════════════ */}
      <Section
        title="Zone de danger"
        desc="Actions irréversibles sur votre compte"
        icon={Trash2}
        className="border-red-500/20"
      >
        <div className="space-y-4">
          {delMsg && <Feedback msg={delMsg.text} type={delMsg.type} />}

          <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 space-y-3">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 shrink-0 text-red-400 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-red-400">Supprimer votre compte</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Cette action est <strong>irréversible</strong>. Tous vos projets, conversions et données seront définitivement supprimés.
                  Vous serez déconnecté immédiatement.
                </p>
              </div>
            </div>

            <Field label={`Tapez SUPPRIMER pour confirmer`}>
              <input
                type="text"
                className={`${INPUT} border-red-500/30 focus:ring-red-500/50`}
                value={delConfirm}
                onChange={e => setDelConfirm(e.target.value)}
                placeholder="SUPPRIMER"
                disabled={deleting}
                autoComplete="off"
              />
            </Field>

            <Button
              onClick={() => void handleDeleteAccount()}
              disabled={deleting || delConfirm !== 'SUPPRIMER'}
              className="w-full gap-2 border-red-500/50 bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:border-red-500"
              variant="outline"
            >
              {deleting
                ? <><RefreshCw className="h-4 w-4 animate-spin" /> Suppression…</>
                : <><Trash2 className="h-4 w-4" /> Supprimer définitivement mon compte</>
              }
            </Button>
          </div>
        </div>
      </Section>

    </div>
  );
}
