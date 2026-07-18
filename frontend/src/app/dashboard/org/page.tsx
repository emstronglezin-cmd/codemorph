'use client';
// ============================================================
// CodeMorph — Organisation Page (/dashboard/org)
// FIX-6 Phase 19 — Page réelle avec données API
// Plan free : affiche upgrade CTA + info plan actuel
// Plan pro/pro_max : affiche membres et settings org
// ============================================================
import type React from 'react';
import { useEffect, useState } from 'react';
import {
  Users, Crown, Shield, Mail, Clock, RefreshCw,
  Building2, Zap, Check, AlertTriangle, UserPlus,
  ExternalLink, Star,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAuthStore } from '@/stores/auth.store';
import { getAccessToken } from '@/lib/api/client';

const BACKEND = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

function authH(): Record<string, string> {
  const t = getAccessToken();
  return { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}

function unwrap<T>(data: unknown): T {
  if (data && typeof data === 'object' && 'data' in data) return (data as { data: T }).data;
  return data as T;
}

interface OrgStats {
  totalMembers:      number;
  totalProjects:     number;
  totalConversions:  number;
  storageUsed:       number;
}

interface Member {
  id:        string;
  name:      string;
  email:     string;
  role:      string;
  plan:      string;
  joinedAt:  string;
  avatarUrl?: string;
}

// ── Plan feature list ─────────────────────────────────────
const PLANS = [
  {
    name: 'Free',
    price: '0€',
    features: ['1 projet', '5 conversions/mois', 'GitHub public seulement', 'Support communauté'],
    current: true,
    highlight: false,
  },
  {
    name: 'Pro',
    price: '19€/mois',
    features: ['Projets illimités', '100 conversions/mois', 'GitHub privé', 'Support prioritaire', 'Analytics avancées'],
    current: false,
    highlight: true,
  },
  {
    name: 'Pro Max',
    price: '49€/mois',
    features: ['Tout Pro', 'Équipe jusqu\'à 5 membres', 'CI/CD intégration', 'API accès', 'Support dédié', 'SLA 99.9%'],
    current: false,
    highlight: false,
  },
];

export default function OrgPage(): React.JSX.Element {
  const user  = useAuthStore(s => s.user);
  const plan  = user?.plan ?? 'free';
  const isPro = ['pro', 'pro_max', 'lifetime'].includes(plan.toLowerCase());

  const [stats,   setStats]   = useState<OrgStats | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isPro) { setLoading(false); return; }

    const h = authH();
    Promise.allSettled([
      fetch(`${BACKEND}/jobs/stats`,  { headers: h }),
      fetch(`${BACKEND}/projects`,    { headers: h }),
      fetch(`${BACKEND}/users/me`,    { headers: h }),
    ]).then(async ([statsRes, projRes, userRes]) => {
      let totalConversions = 0;
      let totalProjects    = 0;

      if (statsRes.status === 'fulfilled' && statsRes.value.ok) {
        const d = unwrap<{ total?: number }>(await statsRes.value.json() as unknown);
        totalConversions = d?.total ?? 0;
      }
      if (projRes.status === 'fulfilled' && projRes.value.ok) {
        const d = unwrap<{ total?: number; data?: unknown[] }>(await projRes.value.json() as unknown);
        totalProjects = (d as { total?: number; data?: unknown[] })?.total ?? (Array.isArray((d as { data?: unknown[] }).data) ? (d as { data?: unknown[] }).data!.length : 0);
      }

      let me: Member | null = null;
      if (userRes.status === 'fulfilled' && userRes.value.ok) {
        const d = unwrap<Member>(await userRes.value.json() as unknown);
        me = d;
      }

      setStats({ totalMembers: 1, totalProjects, totalConversions, storageUsed: 0 });
      if (me) setMembers([{ ...me, role: 'owner', joinedAt: me.joinedAt ?? new Date().toISOString() }]);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [isPro]);

  // ── PLAN FREE → Upgrade CTA ────────────────────────────
  if (!isPro) {
    return (
      <div className="mx-auto w-full max-w-4xl space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Organisation</h1>
          <p className="text-sm text-muted-foreground">Gérez votre équipe et les ressources partagées.</p>
        </div>

        {/* Bannière plan actuel */}
        <div className="flex items-start gap-3 rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-4">
          <AlertTriangle className="h-5 w-5 shrink-0 text-yellow-400 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-yellow-400">
              Fonctionnalité disponible sur Plan Pro Max
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Vous êtes actuellement sur le plan <span className="font-semibold capitalize text-foreground">{plan}</span>.
              Passez au plan Pro Max pour gérer une équipe jusqu&apos;à 5 membres, accéder aux intégrations CI/CD et bénéficier d&apos;un support dédié.
            </p>
          </div>
        </div>

        {/* Grille des plans */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {PLANS.map(p => (
            <Card
              key={p.name}
              className={`relative flex flex-col overflow-hidden transition-all ${
                p.highlight
                  ? 'border-primary/50 ring-1 ring-primary/30 shadow-lg'
                  : p.current
                  ? 'border-border opacity-80'
                  : 'border-border hover:border-primary/30'
              }`}
            >
              {p.highlight && (
                <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-indigo-500 via-violet-500 to-pink-500" />
              )}
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{p.name}</CardTitle>
                  {p.current && <Badge variant="default" size="sm">Actuel</Badge>}
                  {p.highlight && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-primary/20 px-2 py-0.5 text-xs font-medium text-primary">
                      <Star className="h-3 w-3" /> Populaire
                    </span>
                  )}
                </div>
                <p className="text-2xl font-bold text-foreground mt-1">{p.price}</p>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col justify-between gap-4">
                <ul className="space-y-2">
                  {p.features.map(f => (
                    <li key={f} className="flex items-start gap-2 text-sm text-muted-foreground">
                      <Check className="h-4 w-4 shrink-0 text-green-400 mt-0.5" />
                      {f}
                    </li>
                  ))}
                </ul>
                {!p.current && (
                  <a
                    href="/dashboard/billing"
                    className={`inline-flex w-full items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition-colors gap-2 ${
                      p.highlight
                        ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                        : 'border border-border hover:bg-muted text-foreground'
                    }`}
                  >
                    <Zap className="h-4 w-4" />
                    Passer à {p.name}
                  </a>
                )}
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Fonctionnalités org preview */}
        <Card className="border-dashed border-border bg-card/50">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              Aperçu — Espace Équipe (Pro Max)
            </CardTitle>
            <CardDescription>Voici ce que vous débloquerez avec le plan Pro Max</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {[
                { icon: Users,     label: 'Membres de l\'équipe',      desc: 'Invitez jusqu\'à 5 collaborateurs' },
                { icon: Shield,    label: 'Rôles et permissions',       desc: 'Admin, Éditeur, Lecture seule' },
                { icon: Zap,       label: 'Conversions partagées',      desc: '500 conversions/mois pour toute l\'équipe' },
                { icon: ExternalLink, label: 'Intégrations CI/CD',     desc: 'GitHub Actions, GitLab CI, Jenkins' },
              ].map(f => (
                <div key={f.label} className="flex items-start gap-3 rounded-lg bg-muted/30 p-3 opacity-60">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <f.icon className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">{f.label}</p>
                    <p className="text-xs text-muted-foreground">{f.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── PLAN PRO/PRO_MAX → Vraie page org ─────────────────
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Organisation</h1>
          <p className="text-sm text-muted-foreground">Gérez votre équipe et les ressources partagées.</p>
        </div>
        <div className="flex flex-wrap gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={() => window.location.reload()} className="gap-2">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Actualiser
          </Button>
          <Button size="sm" className="gap-2" disabled>
            <UserPlus className="h-4 w-4" />
            Inviter un membre
          </Button>
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: 'Membres',      value: stats.totalMembers,     icon: <Users      className="h-4 w-4 text-blue-400" /> },
            { label: 'Projets',      value: stats.totalProjects,    icon: <Building2  className="h-4 w-4 text-violet-400" /> },
            { label: 'Conversions',  value: stats.totalConversions, icon: <Zap        className="h-4 w-4 text-yellow-400" /> },
            { label: 'Plan',         value: plan.toUpperCase(),     icon: <Crown      className="h-4 w-4 text-amber-400" /> },
          ].map(s => (
            <Card key={s.label}>
              <CardContent className="flex items-center gap-3 p-4">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                  {s.icon}
                </div>
                <div className="min-w-0">
                  <p className="text-lg font-bold text-foreground truncate">{s.value}</p>
                  <p className="text-xs text-muted-foreground">{s.label}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Membres */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" /> Membres de l&apos;équipe
          </CardTitle>
          <CardDescription>
            {members.length} membre{members.length !== 1 ? 's' : ''} dans votre organisation
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-3">
              {[1, 2].map(i => (
                <div key={i} className="flex items-center gap-3 py-2">
                  <div className="h-10 w-10 rounded-full bg-muted animate-pulse" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3.5 w-32 rounded bg-muted animate-pulse" />
                    <div className="h-3 w-48 rounded bg-muted animate-pulse" />
                  </div>
                </div>
              ))}
            </div>
          ) : members.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
                <Users className="h-7 w-7 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground">Aucun membre pour l&apos;instant.</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {members.map(m => (
                <div key={m.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4">
                  {/* Avatar */}
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    {m.avatarUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={m.avatarUrl} alt={m.name} className="h-10 w-10 rounded-full object-cover shrink-0" />
                    ) : (
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-sm font-bold text-white">
                        {m.name.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{m.name}</p>
                      <p className="text-xs text-muted-foreground flex items-center gap-1 truncate">
                        <Mail className="h-3 w-3 shrink-0" /> {m.email}
                      </p>
                    </div>
                  </div>

                  {/* Role + Date */}
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                      m.role === 'owner' ? 'border-amber-500/30 bg-amber-500/10 text-amber-400' :
                      m.role === 'admin' ? 'border-blue-500/30 bg-blue-500/10 text-blue-400' :
                      'border-border bg-muted text-muted-foreground'
                    }`}>
                      {m.role === 'owner' && <Crown className="h-3 w-3" />}
                      {m.role === 'admin' && <Shield className="h-3 w-3" />}
                      <span className="capitalize">{m.role}</span>
                    </span>
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      {new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(m.joinedAt))}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Invitations désactivées si pas pro_max */}
      {plan !== 'pro_max' && (
        <div className="flex items-start gap-3 rounded-xl border border-blue-500/20 bg-blue-500/5 p-4">
          <Zap className="h-5 w-5 shrink-0 text-blue-400 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-blue-400">Invitation de membres — Plan Pro Max requis</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Vous êtes sur le plan <span className="font-semibold text-foreground capitalize">{plan}</span>.
              Passez au plan Pro Max pour inviter jusqu&apos;à 5 membres dans votre organisation.
            </p>
            <a href="/dashboard/billing" className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-blue-400 hover:text-blue-300">
              Voir les plans <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
