'use client';

// ============================================================
// CodeMorph — New Project Page
// FIX: Lecture correcte des erreurs wrappées par TransformInterceptor
//      { success: false, message: "...", code: "..." }
// FIX: URL import implémenté (POST /jobs/start/url)
// FIX: Progression détaillée — plus de spinner seul
// FIX: Affichage du vrai code + message HTTP d'erreur
// ============================================================

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getAccessToken } from '@/lib/api/client';

type ImportMethod = 'github' | 'zip' | 'url';

/** Étape de progression détaillée */
interface ProgressStep {
  label: string;
  status: 'waiting' | 'running' | 'done' | 'error';
}

const FRAMEWORKS = [
  {
    id:     'flutter-react',
    source: 'Flutter',
    target: 'React',
    sourceLang: 'flutter',
    targetLang: 'react',
    icon:   '🦋',
    badge:  'stable',
    desc:   'Dart + Flutter → React + TypeScript',
    free:   true,
  },
  {
    id:     'flutter-rn',
    source: 'Flutter',
    target: 'React Native',
    sourceLang: 'flutter',
    targetLang: 'react-native',
    icon:   '📱',
    badge:  'stable',
    desc:   'Dart + Flutter → Expo + React Native',
    free:   true,
  },
  {
    id:     'react-flutter',
    source: 'React',
    target: 'Flutter',
    sourceLang: 'react',
    targetLang: 'flutter',
    icon:   '🎯',
    badge:  'stable',
    desc:   'React + TypeScript → Flutter + Dart',
    free:   false,
  },
  {
    id:     'express-nestjs',
    source: 'Express.js',
    target: 'NestJS',
    sourceLang: 'javascript',
    targetLang: 'typescript',
    icon:   '🐈',
    badge:  'stable',
    desc:   'Express.js REST API → NestJS enterprise (decorators, DI)',
    free:   false,
  },
  {
    id:     'nodejs-nestjs',
    source: 'Node.js',
    target: 'NestJS',
    sourceLang: 'javascript',
    targetLang: 'typescript',
    icon:   '🦅',
    badge:  'beta',
    desc:   'Node.js vanilla → NestJS architecture modulaire',
    free:   false,
  },
];

const BACKEND = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

/** Construit les headers communs avec Authorization Bearer */
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = getAccessToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(extra ?? {}),
  };
}

/**
 * Extrait le message d'erreur depuis une réponse wrappée par TransformInterceptor/AllExceptionsFilter.
 * Format erreur  : { success: false, message: "...", code: "...", errors: [...] }
 * Format succès  : { success: true,  data: { ... } }
 */
function extractErrorMessage(
  data: Record<string, unknown>,
  httpStatus: number,
  fallback: string,
): string {
  // Erreur wrappée par AllExceptionsFilter
  if (data['success'] === false) {
    const code    = data['code']    ? ` [${data['code']}]` : '';
    const message = (data['message'] as string | undefined) ?? fallback;
    // Si des erreurs de validation sont présentes
    if (Array.isArray(data['errors']) && data['errors'].length > 0) {
      const errMsgs = (data['errors'] as Array<{ message?: string }>)
        .map((e) => e.message)
        .filter(Boolean)
        .join(', ');
      return `${message}${code}: ${errMsgs}`;
    }
    return `${message}${code}`;
  }

  // Réponse HTTP non-OK sans format NestJS
  return `HTTP ${httpStatus}: ${fallback}`;
}

/** Labels des étapes de progression selon la méthode d'import */
function getProgressSteps(method: ImportMethod): ProgressStep[] {
  const steps: ProgressStep[] = [
    { label: 'Creating project…',        status: 'waiting' },
  ];
  if (method === 'zip') {
    steps.push({ label: 'Uploading ZIP…',      status: 'waiting' });
  } else if (method === 'url') {
    steps.push({ label: 'Fetching URL…',       status: 'waiting' });
  } else {
    steps.push({ label: 'Connecting GitHub…',  status: 'waiting' });
  }
  steps.push({ label: 'Creating conversion…', status: 'waiting' });
  steps.push({ label: 'Starting worker…',      status: 'waiting' });
  return steps;
}

export default function NewProjectPage() {
  const router = useRouter();
  const [step, setStep]         = useState<1 | 2 | 3>(1);
  const [method, setMethod]     = useState<ImportMethod>('github');
  const [framework, setFramework] = useState('');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [progressSteps, setProgressSteps] = useState<ProgressStep[]>([]);

  // Step 1
  const [projectName, setProjectName]   = useState('');
  const [description, setDescription]   = useState('');

  // Import source
  const [githubRepo, setGithubRepo]     = useState('');
  const [githubBranch, setGithubBranch] = useState('main');
  const [zipFile, setZipFile]           = useState<File | null>(null);
  const [sourceUrl, setSourceUrl]       = useState('');
  const [goalPrompt, setGoalPrompt]     = useState('');
  const [zipPath, setZipPath]           = useState('');

  // ── Mise à jour d'une étape de progression ───────────────
  const updateStep = (index: number, status: ProgressStep['status']) => {
    setProgressSteps((prev) => {
      const next = [...prev];
      if (next[index]) next[index] = { ...next[index], status };
      return next;
    });
  };

  // ── Upload ZIP ──────────────────────────────────────────
  const uploadZip = async (): Promise<string> => {
    if (!zipFile) throw new Error('Aucun fichier ZIP sélectionné');
    const token = getAccessToken();
    const fd    = new FormData();
    fd.append('file', zipFile);

    const res  = await fetch(`${BACKEND}/uploads/zip`, {
      method:  'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body:    fd,
    });
    const raw  = await res.json() as Record<string, unknown>;

    if (!res.ok) {
      const msg = extractErrorMessage(raw, res.status, 'Upload failed');
      throw new Error(msg);
    }

    // Succès wrappé : { success: true, data: { zipPath, fileName, sizeBytes } }
    const inner = (raw['data'] as Record<string, unknown> | undefined) ?? raw;
    const p     = (inner['zipPath'] as string | undefined) ?? '';
    if (!p) throw new Error('ZIP uploaded but server returned no zipPath');
    setZipPath(p);
    return p;
  };

  // ── Start conversion ────────────────────────────────────
  const handleStart = async () => {
    if (!framework) { setError('Sélectionne un framework de conversion'); return; }
    setLoading(true);
    setError('');

    const steps = getProgressSteps(method);
    setProgressSteps(steps);

    try {
      const fw = FRAMEWORKS.find((f) => f.id === framework)!;

      // ── Step 0: Créer le projet ──────────────────────────
      updateStep(0, 'running');
      const projRes  = await fetch(`${BACKEND}/projects`, {
        method:  'POST',
        headers: authHeaders(),
        body:    JSON.stringify({
          name:           projectName.trim(),
          description:    description.trim() || undefined,
          sourceLanguage: fw.sourceLang,
          targetLanguage: fw.targetLang,
        }),
      });
      const projRaw  = await projRes.json() as Record<string, unknown>;

      if (!projRes.ok) {
        const msg = extractErrorMessage(projRaw, projRes.status, 'Project creation failed');
        throw new Error(msg);
      }
      // Réponse wrappée : { success: true, data: { id, name, ... } }
      const projData  = (projRaw['data'] as Record<string, unknown> | undefined) ?? projRaw;
      const projectId = (projData['id'] as string | undefined) ?? '';
      if (!projectId) throw new Error('Project created but server returned no ID');

      updateStep(0, 'done');

      // ── Step 1: Import source ────────────────────────────
      updateStep(1, 'running');

      let jobRes: Response;

      if (method === 'github') {
        if (!githubRepo.trim()) throw new Error('Dépôt GitHub requis (ex: owner/repo)');

        jobRes = await fetch(`${BACKEND}/jobs/start/github`, {
          method:  'POST',
          headers: authHeaders(),
          body:    JSON.stringify({
            projectId,
            sourceLanguage: fw.sourceLang,
            targetLanguage: fw.targetLang,
            repo:           githubRepo.trim(),
            branch:         githubBranch.trim() || 'main',
            goalPrompt:     goalPrompt.trim() || undefined,
          }),
        });

      } else if (method === 'zip') {
        // Uploader le ZIP si pas encore fait
        const zPath = zipPath || await uploadZip();
        updateStep(1, 'done');
        updateStep(2, 'running');

        jobRes = await fetch(`${BACKEND}/jobs/start/zip`, {
          method:  'POST',
          headers: authHeaders(),
          body:    JSON.stringify({
            projectId,
            sourceLanguage: fw.sourceLang,
            targetLanguage: fw.targetLang,
            zipPath:        zPath,
            goalPrompt:     goalPrompt.trim() || undefined,
          }),
        });

      } else {
        // URL import
        if (!sourceUrl.trim()) throw new Error('URL publique requise');

        jobRes = await fetch(`${BACKEND}/jobs/start/url`, {
          method:  'POST',
          headers: authHeaders(),
          body:    JSON.stringify({
            projectId,
            sourceLanguage: fw.sourceLang,
            targetLanguage: fw.targetLang,
            sourceUrl:      sourceUrl.trim(),
            goalPrompt:     goalPrompt.trim() || undefined,
          }),
        });
      }

      updateStep(1, 'done');

      // ── Step 2: Lire la réponse du job ─────────────────
      updateStep(method === 'zip' ? 2 : 2, 'running');
      const jobRaw = await jobRes.json() as Record<string, unknown>;

      if (!jobRes.ok) {
        // CRITICAL: lire le vrai message depuis la réponse wrappée
        const msg = extractErrorMessage(jobRaw, jobRes.status, 'Job creation failed');
        throw new Error(msg);
      }

      // Réponse wrappée : { success: true, data: { id, status, ... } }
      const jobData = (jobRaw['data'] as Record<string, unknown> | undefined) ?? jobRaw;
      const jobId   = (jobData['id'] as string | undefined) ?? '';
      if (!jobId) throw new Error('Job created but server returned no ID');

      const jobStatus = (jobData['status'] as string | undefined) ?? '';

      // Job immédiatement FAILED (ex: queue Redis indisponible)
      if (jobStatus === 'failed') {
        const errMsg = (jobData['errorMessage'] as string | undefined) ?? 'Job creation failed immediately';
        throw new Error(errMsg);
      }

      updateStep(2, 'done');

      // ── Step 3: Worker démarré ──────────────────────────
      const lastIdx = steps.length - 1;
      updateStep(lastIdx, 'done');

      // ── Rediriger vers le tracker du job ────────────────
      router.push(`/dashboard/projects/${projectId}/job/${jobId}`);

    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      // Marquer l'étape courante comme erreur
      setProgressSteps((prev) => {
        const runningIdx = prev.findIndex((s) => s.status === 'running');
        if (runningIdx >= 0) {
          const next = [...prev];
          next[runningIdx] = { ...next[runningIdx], status: 'error' };
          return next;
        }
        return prev;
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-8 py-8">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-foreground">New Conversion Project</h1>
        <p className="text-muted-foreground mt-1">Import your source code and choose a conversion target</p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-3">
        {(['Project Details', 'Import Source', 'Conversion Target'] as const).map((label, i) => (
          <div key={label} className="flex items-center gap-2">
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold transition-colors ${
                step > i + 1
                  ? 'bg-green-500 text-white'
                  : step === i + 1
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {step > i + 1 ? '✓' : i + 1}
            </div>
            <span className={`text-sm font-medium ${step === i + 1 ? 'text-foreground' : 'text-muted-foreground'}`}>
              {label}
            </span>
            {i < 2 && <div className="w-12 h-px bg-border" />}
          </div>
        ))}
      </div>

      {/* ── Step 1: Project Details ──────────────────────────── */}
      {step === 1 && (
        <Card variant="elevated">
          <CardHeader>
            <CardTitle>Project Details</CardTitle>
            <CardDescription>Give your project a name and description</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input
              label="Project name"
              placeholder="my-flutter-to-react"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              required
            />
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Description (optional)</label>
              <textarea
                className="w-full min-h-[80px] rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                placeholder="Describe what this project does…"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <Button
              onClick={() => setStep(2)}
              disabled={!projectName.trim()}
              className="w-full"
              variant="premium"
            >
              Continue →
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ── Step 2: Import Source ────────────────────────────── */}
      {step === 2 && (
        <Card variant="elevated">
          <CardHeader>
            <CardTitle>Import Source Code</CardTitle>
            <CardDescription>Choose how to import your codebase</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Method selector */}
            <div className="grid grid-cols-3 gap-3">
              {(
                [
                  { id: 'github', label: 'GitHub Repo', icon: '🐙' },
                  { id: 'zip',    label: 'Upload ZIP',  icon: '📦' },
                  { id: 'url',    label: 'Public URL',  icon: '🔗' },
                ] as { id: ImportMethod; label: string; icon: string }[]
              ).map((m) => (
                <button
                  key={m.id}
                  onClick={() => setMethod(m.id)}
                  className={`p-4 rounded-xl border-2 text-center transition-all ${
                    method === m.id
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-primary/40'
                  }`}
                >
                  <div className="text-2xl mb-1">{m.icon}</div>
                  <div className="text-sm font-medium">{m.label}</div>
                </button>
              ))}
            </div>

            {/* GitHub */}
            {method === 'github' && (
              <div className="space-y-3">
                <Input
                  label="Repository (owner/repo)"
                  placeholder="facebook/react"
                  value={githubRepo}
                  onChange={(e) => setGithubRepo(e.target.value)}
                />
                <Input
                  label="Branch"
                  placeholder="main"
                  value={githubBranch}
                  onChange={(e) => setGithubBranch(e.target.value)}
                />
              </div>
            )}

            {/* ZIP */}
            {method === 'zip' && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-foreground">ZIP file (max 50MB)</label>
                <div
                  className="border-2 border-dashed border-border rounded-xl p-8 text-center cursor-pointer hover:border-primary/40 transition-colors"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    setZipFile(e.dataTransfer.files[0] ?? null);
                    setZipPath('');
                  }}
                  onClick={() => document.getElementById('zip-input')?.click()}
                >
                  <div className="text-4xl mb-2">📦</div>
                  <p className="text-sm text-muted-foreground">
                    {zipFile ? zipFile.name : 'Drag & drop or click to upload a ZIP file'}
                  </p>
                  {zipFile && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {(zipFile.size / 1024 / 1024).toFixed(2)} MB
                    </p>
                  )}
                </div>
                <input
                  id="zip-input"
                  type="file"
                  accept=".zip"
                  className="hidden"
                  onChange={(e) => {
                    setZipFile(e.target.files?.[0] ?? null);
                    setZipPath('');
                  }}
                />
              </div>
            )}

            {/* URL */}
            {method === 'url' && (
              <div className="space-y-3">
                <Input
                  label="Public repository URL"
                  placeholder="https://github.com/user/repo/archive/refs/heads/main.zip"
                  value={sourceUrl}
                  onChange={(e) => setSourceUrl(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  💡 Pour GitHub: utilisez l&apos;URL d&apos;archive&nbsp;
                  <code className="bg-muted px-1 rounded text-xs">
                    https://github.com/OWNER/REPO/archive/refs/heads/BRANCH.zip
                  </code>
                </p>
              </div>
            )}

            {/* Goal prompt */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                Conversion goal (optional)
              </label>
              <textarea
                className="w-full min-h-[80px] rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                placeholder="Describe any specific requirements for the conversion, e.g. 'Keep the same folder structure, use Zustand for state management'…"
                value={goalPrompt}
                onChange={(e) => setGoalPrompt(e.target.value)}
              />
            </div>

            <div className="flex gap-3">
              <Button variant="outline" onClick={() => setStep(1)} className="flex-1">
                ← Back
              </Button>
              <Button
                variant="premium"
                className="flex-1"
                disabled={
                  method === 'github' ? !githubRepo.trim()
                  : method === 'zip'  ? !zipFile
                  : !sourceUrl.trim()
                }
                onClick={() => setStep(3)}
              >
                Continue →
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Step 3: Conversion Target ────────────────────────── */}
      {step === 3 && (
        <Card variant="elevated">
          <CardHeader>
            <CardTitle>Choose Conversion Framework</CardTitle>
            <CardDescription>Select the source → target stack for AI conversion</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">

            {/* ── Progression détaillée ── */}
            {loading && progressSteps.length > 0 && (
              <div className="p-4 rounded-xl border border-border bg-muted/30 space-y-2">
                <p className="text-sm font-semibold text-foreground mb-3">🚀 Starting conversion…</p>
                {progressSteps.map((s, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className={`w-5 h-5 rounded-full flex items-center justify-center text-xs flex-shrink-0 ${
                      s.status === 'done'    ? 'bg-green-500 text-white'
                      : s.status === 'running' ? 'bg-primary text-white animate-pulse'
                      : s.status === 'error'   ? 'bg-red-500 text-white'
                      : 'bg-muted-foreground/20 text-muted-foreground'
                    }`}>
                      {s.status === 'done'    ? '✓'
                       : s.status === 'running' ? '⟳'
                       : s.status === 'error'   ? '✗'
                       : '·'}
                    </div>
                    <span className={`text-sm ${
                      s.status === 'done'    ? 'text-green-500 line-through'
                      : s.status === 'running' ? 'text-foreground font-medium'
                      : s.status === 'error'   ? 'text-red-400'
                      : 'text-muted-foreground'
                    }`}>
                      {s.label}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* ── Erreur ── */}
            {error && (
              <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 space-y-1">
                <p className="text-sm font-semibold text-red-400">❌ Conversion failed</p>
                <p className="text-sm text-red-400/80 break-words">{error}</p>
              </div>
            )}

            {/* ── Framework cards ── */}
            {!loading && (
              <div className="grid grid-cols-1 gap-3">
                {FRAMEWORKS.map((fw) => (
                  <button
                    key={fw.id}
                    onClick={() => setFramework(fw.id)}
                    className={`p-4 rounded-xl border-2 text-left transition-all ${
                      framework === fw.id
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/40'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{fw.icon}</span>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-foreground">{fw.source}</span>
                          <span className="text-muted-foreground">→</span>
                          <span className="font-semibold text-foreground">{fw.target}</span>
                          <Badge variant="success" size="sm">{fw.badge}</Badge>
                          {!fw.free && (
                            <Badge variant="warning" size="sm">Pro</Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">{fw.desc}</p>
                      </div>
                      {framework === fw.id && (
                        <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center text-white text-xs">
                          ✓
                        </div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}

            <div className="flex gap-3">
              <Button variant="outline" onClick={() => setStep(2)} className="flex-1" disabled={loading}>
                ← Back
              </Button>
              <Button
                variant="premium"
                className="flex-1"
                disabled={!framework || loading}
                loading={loading}
                onClick={handleStart}
              >
                {loading ? 'Starting…' : '🚀 Start Conversion'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
