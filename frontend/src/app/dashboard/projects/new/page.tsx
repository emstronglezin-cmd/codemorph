'use client';

// ============================================================
// CodeMorph — New Project Page
// FIX 12: Authorization Bearer header sur tous les fetch()
//          sourceLanguage / targetLanguage normalisés (lowercase + tiret)
//          Upload ZIP protégé par le token
// ============================================================

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getAccessToken } from '@/lib/api/client';

type ImportMethod = 'github' | 'zip' | 'url';

const FRAMEWORKS = [
  {
    id:     'flutter-react',
    source: 'Flutter',
    target: 'React',
    // valeurs normalisées pour le backend (varchar, lowercase)
    sourceLang: 'flutter',
    targetLang: 'react',
    icon:   '🦋',
    badge:  'stable',
    desc:   'Dart + Flutter → React + TypeScript',
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

export default function NewProjectPage() {
  const router = useRouter();
  const [step, setStep]         = useState<1 | 2 | 3>(1);
  const [method, setMethod]     = useState<ImportMethod>('github');
  const [framework, setFramework] = useState('');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');

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

  // ── Upload ZIP ──────────────────────────────────────────
  const uploadZip = async (): Promise<string> => {
    if (!zipFile) throw new Error('No ZIP file selected');
    const token = getAccessToken();
    const fd    = new FormData();
    fd.append('file', zipFile);

    const res = await fetch(`${BACKEND}/uploads/zip`, {
      method:  'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      // NB: pas de Content-Type — laissé au navigateur pour multipart/form-data
      body:    fd,
    });
    const data = await res.json() as { data?: { zipPath?: string }; zipPath?: string; error?: { message?: string } };
    if (!res.ok) throw new Error(data.error?.message ?? 'Upload failed');
    const path = data.data?.zipPath ?? data.zipPath ?? '';
    setZipPath(path);
    return path;
  };

  // ── Start conversion ────────────────────────────────────
  const handleStart = async () => {
    if (!framework) { setError('Select a conversion framework'); return; }
    setLoading(true);
    setError('');

    try {
      const fw = FRAMEWORKS.find((f) => f.id === framework)!;

      // 1. Créer le projet avec Authorization Bearer
      const projRes = await fetch(`${BACKEND}/projects`, {
        method:  'POST',
        headers: authHeaders(),
        body:    JSON.stringify({
          name:           projectName.trim(),
          description:    description.trim() || undefined,
          // Passer sourceLanguage/targetLanguage normalisés dès la création
          sourceLanguage: fw.sourceLang,
          targetLanguage: fw.targetLang,
        }),
      });

      const projData = await projRes.json() as {
        data?:  { id?: string };
        id?:    string;
        error?: { message?: string };
      };
      if (!projRes.ok) throw new Error(projData.error?.message ?? 'Project creation failed');
      const projectId = projData.data?.id ?? projData.id ?? '';
      if (!projectId) throw new Error('Project ID manquant dans la réponse');

      // 2. Démarrer le job avec Authorization Bearer
      let jobRes: Response;

      if (method === 'github') {
        jobRes = await fetch(`${BACKEND}/jobs/start/github`, {
          method:  'POST',
          headers: authHeaders(),
          body:    JSON.stringify({
            projectId,
            sourceLanguage: fw.sourceLang,   // 'flutter'
            targetLanguage: fw.targetLang,   // 'react-native'
            repo:           githubRepo.trim(),
            branch:         githubBranch.trim() || 'main',
            goalPrompt:     goalPrompt.trim() || undefined,
          }),
        });
      } else if (method === 'zip') {
        // Uploader le ZIP si pas encore fait
        const zPath = zipPath || await uploadZip();
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
        throw new Error('URL import not yet supported');
      }

      const jobData = await jobRes.json() as {
        data?:  { id?: string };
        id?:    string;
        error?: { message?: string };
      };
      if (!jobRes.ok) throw new Error(jobData.error?.message ?? 'Job start failed');
      const jobId = jobData.data?.id ?? jobData.id ?? '';
      if (!jobId) throw new Error('Job ID manquant dans la réponse');

      // 3. Rediriger vers le tracker du job
      router.push(`/dashboard/projects/${projectId}/job/${jobId}`);
    } catch (err) {
      setError((err as Error).message);
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
                    setZipPath(''); // reset path si nouveau fichier
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
              <Input
                label="Public repository URL"
                placeholder="https://github.com/user/repo/archive/main.zip"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
              />
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
            {error && (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
                {error}
              </div>
            )}

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

            <div className="flex gap-3">
              <Button variant="outline" onClick={() => setStep(2)} className="flex-1">
                ← Back
              </Button>
              <Button
                variant="premium"
                className="flex-1"
                disabled={!framework || loading}
                loading={loading}
                onClick={handleStart}
              >
                🚀 Start Conversion
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
