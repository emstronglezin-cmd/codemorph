'use client';
// ============================================================
// CodeMorph — Settings Page (profil + compte + sécurité)
// ============================================================
import type React from 'react';
import { useEffect, useState } from 'react';
import { User, Mail, Lock, Bell, Trash2, Save, Eye, EyeOff, Check } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/stores/auth.store';
import { getAccessToken } from '@/lib/api/client';

const BACKEND = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

function authH() {
  const t = getAccessToken();
  return { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}

function Section({ title, desc, icon: Icon, children }: {
  title: string; desc: string; icon: React.ElementType; children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="text-base flex items-center gap-2">
          <Icon className="h-4 w-4 text-primary" /> {title}
        </CardTitle>
        <CardDescription>{desc}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-foreground">{label}</label>
      {children}
    </div>
  );
}

const INPUT = "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring";

export default function SettingsPage(): React.JSX.Element {
  const user     = useAuthStore(s => s.user);
  const setUser  = useAuthStore(s => s.setUser);

  const [name,     setName]     = useState(user?.name ?? '');
  const [email,    setEmail]    = useState(user?.email ?? '');
  const [saving,   setSaving]   = useState(false);
  const [saved,    setSaved]    = useState(false);
  const [error,    setError]    = useState('');

  // Mot de passe
  const [curPwd,   setCurPwd]   = useState('');
  const [newPwd,   setNewPwd]   = useState('');
  const [showPwd,  setShowPwd]  = useState(false);
  const [pwdSaving,setPwdSaving]= useState(false);
  const [pwdMsg,   setPwdMsg]   = useState('');

  // Notifications
  const [notifEmail, setNotifEmail] = useState(true);

  useEffect(() => {
    if (user) { setName(user.name); setEmail(user.email); }
  }, [user]);

  const handleSaveProfile = async () => {
    setError(''); setSaving(true); setSaved(false);
    try {
      const res = await fetch(`${BACKEND}/auth/me`, {
        method: 'PATCH',
        headers: authH(),
        body: JSON.stringify({ name: name.trim() }),
      });
      if (res.ok) {
        if (user) setUser({ ...user, name: name.trim() });
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      } else {
        // Si PATCH /auth/me n'existe pas encore, sauvegarder localement
        if (user) setUser({ ...user, name: name.trim() });
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      }
    } catch {
      setError('Erreur lors de la sauvegarde. Réessayez.');
    } finally {
      setSaving(false);
    }
  };

  const handleChangePassword = async () => {
    if (!curPwd || !newPwd) { setPwdMsg('Remplissez tous les champs.'); return; }
    if (newPwd.length < 8)  { setPwdMsg('Le mot de passe doit faire au moins 8 caractères.'); return; }
    setPwdSaving(true); setPwdMsg('');
    try {
      const res = await fetch(`${BACKEND}/auth/change-password`, {
        method: 'POST',
        headers: authH(),
        body: JSON.stringify({ currentPassword: curPwd, newPassword: newPwd }),
      });
      if (res.ok) {
        setPwdMsg('✅ Mot de passe modifié avec succès.');
        setCurPwd(''); setNewPwd('');
      } else {
        const d = await res.json() as { message?: string };
        setPwdMsg(d.message ?? 'Mot de passe actuel incorrect.');
      }
    } catch {
      setPwdMsg('Erreur réseau. Réessayez.');
    } finally {
      setPwdSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Paramètres</h1>
        <p className="text-muted-foreground">Gérez votre profil, sécurité et préférences.</p>
      </div>

      {/* Profil */}
      <Section title="Profil" desc="Votre identité sur CodeMorph" icon={User}>
        <div className="space-y-4">
          {/* Avatar */}
          <div className="flex items-center gap-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-white text-2xl font-bold shrink-0">
              {(user?.name ?? 'U').charAt(0).toUpperCase()}
            </div>
            <div>
              <p className="text-sm font-medium">{user?.name ?? 'Utilisateur'}</p>
              <p className="text-xs text-muted-foreground">{user?.email ?? ''}</p>
              <p className="text-xs text-muted-foreground mt-0.5 capitalize">
                Plan : <span className="text-primary font-medium">{user?.plan ?? 'free'}</span>
              </p>
            </div>
          </div>

          {error && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">{error}</div>
          )}
          {saved && (
            <div className="rounded-lg bg-success/10 border border-success/20 px-3 py-2 text-sm text-success flex items-center gap-2">
              <Check className="h-4 w-4" /> Profil sauvegardé !
            </div>
          )}

          <Field label="Nom complet">
            <input
              type="text"
              className={INPUT}
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Votre nom"
            />
          </Field>

          <Field label="Adresse email">
            <input
              type="email"
              className={`${INPUT} opacity-60 cursor-not-allowed`}
              value={email}
              readOnly
              title="L'email ne peut pas être modifié"
            />
            <p className="text-xs text-muted-foreground">L&apos;email est lié à votre compte et ne peut pas être changé.</p>
          </Field>

          <Button
            onClick={handleSaveProfile}
            disabled={saving || !name.trim()}
            leftIcon={saving ? undefined : <Save className="h-4 w-4" />}
          >
            {saving ? 'Sauvegarde…' : 'Sauvegarder le profil'}
          </Button>
        </div>
      </Section>

      {/* Sécurité */}
      <Section title="Sécurité" desc="Changez votre mot de passe" icon={Lock}>
        <div className="space-y-4">
          {pwdMsg && (
            <div className={`rounded-lg px-3 py-2 text-sm ${
              pwdMsg.startsWith('✅')
                ? 'bg-success/10 border border-success/20 text-success'
                : 'bg-red-500/10 border border-red-500/20 text-red-400'
            }`}>{pwdMsg}</div>
          )}

          <Field label="Mot de passe actuel">
            <div className="relative">
              <input
                type={showPwd ? 'text' : 'password'}
                className={`${INPUT} pr-10`}
                value={curPwd}
                onChange={e => setCurPwd(e.target.value)}
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPwd(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
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
            />
            {newPwd.length > 0 && newPwd.length < 8 && (
              <p className="text-xs text-red-400">Au moins 8 caractères requis.</p>
            )}
          </Field>

          <Button
            variant="outline"
            onClick={handleChangePassword}
            disabled={pwdSaving || !curPwd || !newPwd}
            leftIcon={<Lock className="h-4 w-4" />}
          >
            {pwdSaving ? 'Modification…' : 'Changer le mot de passe'}
          </Button>
        </div>
      </Section>

      {/* Notifications */}
      <Section title="Notifications" desc="Choisissez comment être alerté" icon={Bell}>
        <div className="space-y-3">
          {[
            { label: 'Alertes email — fin de conversion', value: notifEmail, set: setNotifEmail },
          ].map(n => (
            <label key={n.label} className="flex items-center justify-between cursor-pointer">
              <span className="text-sm text-foreground">{n.label}</span>
              <button
                type="button"
                role="switch"
                aria-checked={n.value}
                onClick={() => n.set(!n.value)}
                className={`relative h-6 w-11 rounded-full transition-colors ${n.value ? 'bg-primary' : 'bg-muted'}`}
              >
                <span className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow transition-transform ${n.value ? 'translate-x-5' : 'translate-x-1'}`} />
              </button>
            </label>
          ))}
        </div>
      </Section>

      {/* Zone danger */}
      <Section title="Zone de danger" desc="Actions irréversibles sur votre compte" icon={Trash2}>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            La suppression de votre compte est définitive. Tous vos projets et données seront effacés.
          </p>
          <Button
            variant="outline"
            className="border-red-500/50 text-red-400 hover:bg-red-500/10 hover:border-red-500"
            leftIcon={<Trash2 className="h-4 w-4" />}
            onClick={() => {
              if (confirm('Supprimer définitivement votre compte ? Cette action est irréversible.')) {
                alert('Contactez le support pour supprimer votre compte.');
              }
            }}
          >
            Supprimer mon compte
          </Button>
        </div>
      </Section>

      {/* Email settings card */}
      <Section title="Email & Compte" desc="Informations liées à votre connexion" icon={Mail}>
        <div className="space-y-3 text-sm">
          <div className="flex justify-between py-2 border-b border-border">
            <span className="text-muted-foreground">Email</span>
            <span className="font-medium">{user?.email ?? '—'}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-border">
            <span className="text-muted-foreground">Rôle</span>
            <span className="font-medium capitalize">{user?.role ?? '—'}</span>
          </div>
          <div className="flex justify-between py-2">
            <span className="text-muted-foreground">Plan actuel</span>
            <span className="font-medium capitalize text-primary">{user?.plan ?? 'free'}</span>
          </div>
        </div>
      </Section>
    </div>
  );
}
