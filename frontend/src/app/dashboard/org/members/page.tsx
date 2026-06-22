'use client';
// ============================================================
// CodeMorph — Team Members Page
// ============================================================
import type React from 'react';
import Link from 'next/link';
import { Users, Crown, Zap, Shield, ArrowRight, Star } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

const FEATURES_PRO_MAX = [
  { icon: Users,  title: 'Membres illimités',       desc: 'Invitez toute votre équipe sans restriction.' },
  { icon: Shield, title: 'Rôles & permissions',     desc: 'Admin, Editor, Viewer — contrôle granulaire.' },
  { icon: Zap,    title: 'Projets partagés',         desc: 'Tous les membres voient et collaborent sur les mêmes projets.' },
  { icon: Star,   title: 'Support dédié 24h/7j',    desc: 'Un agent dédié pour votre organisation.' },
];

export default function OrgMembersPage(): React.JSX.Element {
  return (
    <div className="space-y-8 max-w-3xl mx-auto">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Team Members</h1>
        <p className="text-muted-foreground">Gérez les membres de votre équipe et leurs permissions.</p>
      </div>

      {/* Hero upgrade card */}
      <Card className="relative overflow-hidden border-0 bg-gradient-to-br from-violet-950 to-indigo-950">
        {/* Déco */}
        <div className="absolute top-0 right-0 w-64 h-64 rounded-full bg-violet-500/10 blur-3xl -translate-y-1/2 translate-x-1/2" />
        <div className="absolute bottom-0 left-0 w-48 h-48 rounded-full bg-indigo-500/10 blur-3xl translate-y-1/2 -translate-x-1/2" />

        <CardContent className="relative p-8 space-y-6">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 bg-violet-500/20 border border-violet-500/30 text-violet-300 text-xs font-semibold px-3 py-1.5 rounded-full">
            <Crown className="h-3.5 w-3.5" />
            Pro Max uniquement
          </div>

          {/* Titre */}
          <div className="space-y-2">
            <h2 className="text-2xl font-bold text-white">
              Collaborez en équipe
            </h2>
            <p className="text-slate-300 text-sm leading-relaxed max-w-lg">
              La gestion d&apos;équipe est disponible à partir du plan <strong className="text-white">Pro Max</strong>.
              Invitez vos collègues, assignez des rôles et travaillez ensemble sur vos projets de conversion.
            </p>
          </div>

          {/* Features grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {FEATURES_PRO_MAX.map(f => (
              <div key={f.title} className="flex items-start gap-3 bg-white/5 rounded-xl p-4">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/20">
                  <f.icon className="h-4 w-4 text-violet-300" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-white">{f.title}</p>
                  <p className="text-xs text-slate-400 mt-0.5">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>

          {/* CTA */}
          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            <Link href="/dashboard/billing">
              <Button
                className="bg-gradient-to-r from-indigo-600 to-violet-600 hover:opacity-90 text-white font-semibold shadow-lg shadow-violet-500/25 gap-2"
                size="lg"
              >
                <Crown className="h-4 w-4" />
                Passer au Pro Max — $10/mois
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
            <Link href="/pricing">
              <Button variant="outline" size="lg" className="border-slate-600 text-slate-300 hover:bg-white/5">
                Voir tous les plans
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>

      {/* Avantages supplémentaires */}
      <div className="rounded-xl border border-border bg-card p-6 space-y-4">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Inclus dans Pro Max
        </h3>
        <div className="space-y-3">
          {[
            'Conversions illimitées par mois',
            'Accès à tous les langages de conversion',
            'API directe pour intégrations CI/CD',
            'Historique illimité des projets',
            'Gestion d\'équipe et permissions avancées',
            'Support dédié prioritaire',
          ].map((item, i) => (
            <div key={i} className="flex items-center gap-3 text-sm">
              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success/10">
                <svg className="h-3 w-3 text-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <span className="text-foreground">{item}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
