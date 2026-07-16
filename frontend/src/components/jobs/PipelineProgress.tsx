'use client';
// ============================================================
// CodeMorph — PipelineProgress Component
// PHASE 12 : Pipeline visuel animé temps réel
//   - 7 étapes visuelles avec état (pending / running / done / failed)
//   - Polling auto via useJob() (React Query, 3s si actif)
//   - Animation CSS pour l'étape en cours
//   - Barre de progression globale
// ============================================================
import type React from 'react';
import { useJob } from '@/hooks/useJobs';
import { cn }     from '@/lib/utils/cn';
import {
  CheckCircle2, XCircle, Loader2, Clock,
  FileSearch, Brain, Code2, PackageCheck,
  GitBranch, Upload, Zap,
} from 'lucide-react';

// ── Types ─────────────────────────────────────────────────
type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

interface PipelineStep {
  id:    string;
  label: string;
  icon:  React.ElementType;
  desc:  string;
}

// ── 7 étapes du pipeline CodeMorph ────────────────────────
const PIPELINE_STEPS: PipelineStep[] = [
  { id: 'queued',      label: 'En file',         icon: Clock,        desc: 'Job reçu, en attente du worker' },
  { id: 'ast-analysis',label: 'Analyse AST',     icon: FileSearch,   desc: 'Parsing et analyse de la structure du code' },
  { id: 'ir-build',    label: 'IR Build',         icon: Brain,        desc: 'Construction du document de représentation intermédiaire' },
  { id: 'ai-convert',  label: 'Conversion IA',   icon: Zap,          desc: 'Transformation du code via IA (LLM)' },
  { id: 'emit',        label: 'Génération',       icon: Code2,        desc: 'Émission des fichiers de sortie dans le langage cible' },
  { id: 'package',     label: 'Packaging',        icon: PackageCheck, desc: 'Création du ZIP de résultat' },
  { id: 'done',        label: 'Terminé',          icon: CheckCircle2, desc: 'Conversion complète' },
];

// ── Helpers ───────────────────────────────────────────────
function getStepStatus(
  stepId:       string,
  jobStatus:    string,
  currentPhase: string | null | undefined,
  phaseLogs?:   Array<{ phase: string; status: string }>,
): StepStatus {
  if (jobStatus === 'failed') {
    // Chercher si cette étape a échoué dans les logs
    const log = phaseLogs?.find(l => l.phase === stepId);
    if (log?.status === 'failed') return 'failed';
    if (log?.status === 'done')   return 'done';
    // Étapes après l'étape courante → skipped
    const currentIdx = PIPELINE_STEPS.findIndex(s => s.id === currentPhase);
    const stepIdx    = PIPELINE_STEPS.findIndex(s => s.id === stepId);
    if (stepIdx > currentIdx) return 'skipped';
    return 'done';
  }

  if (jobStatus === 'done' || jobStatus === 'completed') return 'done';

  // Chercher dans les logs
  const log = phaseLogs?.find(l => l.phase === stepId);
  if (log) {
    if (log.status === 'done')    return 'done';
    if (log.status === 'failed')  return 'failed';
    if (log.status === 'running') return 'running';
  }

  // Phase courante active
  if (currentPhase === stepId) return 'running';

  // Par position
  const currentIdx = PIPELINE_STEPS.findIndex(s => s.id === currentPhase);
  const stepIdx    = PIPELINE_STEPS.findIndex(s => s.id === stepId);

  if (stepIdx < currentIdx) return 'done';
  return 'pending';
}

function StepIcon({ step, status }: { step: PipelineStep; status: StepStatus }) {
  const Icon = step.icon;
  if (status === 'done')    return <CheckCircle2 className="h-4 w-4 text-green-400" />;
  if (status === 'failed')  return <XCircle      className="h-4 w-4 text-red-400" />;
  if (status === 'running') return <Loader2      className="h-4 w-4 text-primary animate-spin" />;
  if (status === 'skipped') return <Icon         className="h-4 w-4 text-muted-foreground/40" />;
  return <Icon className="h-4 w-4 text-muted-foreground/60" />;
}

// ── Composant Principal ────────────────────────────────────
interface PipelineProgressProps {
  jobId:   string;
  compact?: boolean;
}

export function PipelineProgress({ jobId, compact = false }: PipelineProgressProps) {
  const { data: job, isLoading } = useJob(jobId, true);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!job) return null;

  const progress     = job.progress ?? 0;
  const currentPhase = job.currentPhase;
  const phaseLogs    = job.phaseLogs;
  const isActive     = ['pending','analyzing','converting'].includes(job.status);

  return (
    <div className="space-y-4">
      {/* Barre globale */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground font-medium">Progression globale</span>
          <span className={cn(
            'font-bold tabular-nums',
            job.status === 'done'   ? 'text-green-400' :
            job.status === 'failed' ? 'text-red-400'   : 'text-primary',
          )}>
            {progress}%
          </span>
        </div>
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div
            className={cn(
              'h-full rounded-full transition-all duration-700',
              job.status === 'done'   ? 'bg-green-500' :
              job.status === 'failed' ? 'bg-red-500'   : 'bg-primary',
              isActive && 'animate-pulse',
            )}
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Étapes */}
      {!compact && (
        <div className="space-y-1.5">
          {PIPELINE_STEPS.map((step, idx) => {
            const status  = getStepStatus(step.id, job.status, currentPhase, phaseLogs);
            const isLast  = idx === PIPELINE_STEPS.length - 1;

            return (
              <div key={step.id} className="flex items-start gap-3">
                {/* Icône + connecteur vertical */}
                <div className="flex flex-col items-center">
                  <div className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border',
                    status === 'done'    ? 'border-green-500/30 bg-green-500/10' :
                    status === 'failed'  ? 'border-red-500/30   bg-red-500/10'   :
                    status === 'running' ? 'border-primary/50   bg-primary/10'   :
                    status === 'skipped' ? 'border-border/30    bg-transparent'  :
                                          'border-border        bg-transparent',
                  )}>
                    <StepIcon step={step} status={status} />
                  </div>
                  {!isLast && (
                    <div className={cn(
                      'w-px flex-1 min-h-[12px] mt-0.5',
                      status === 'done' ? 'bg-green-500/30' : 'bg-border/50',
                    )} />
                  )}
                </div>

                {/* Label + description */}
                <div className={cn(
                  'flex-1 pb-2 min-w-0',
                  isLast && 'pb-0',
                )}>
                  <p className={cn(
                    'text-sm font-medium leading-tight',
                    status === 'done'    ? 'text-green-400' :
                    status === 'failed'  ? 'text-red-400'   :
                    status === 'running' ? 'text-foreground' :
                    status === 'skipped' ? 'text-muted-foreground/40' :
                                          'text-muted-foreground',
                  )}>
                    {step.label}
                    {status === 'running' && (
                      <span className="ml-2 text-xs text-primary animate-pulse">● en cours</span>
                    )}
                  </p>
                  {!compact && status !== 'pending' && status !== 'skipped' && (
                    <p className="text-xs text-muted-foreground/70 mt-0.5">{step.desc}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Message d'erreur */}
      {job.status === 'failed' && job.errorMessage && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
          <p className="text-xs text-red-400 font-medium mb-1">Erreur de conversion</p>
          <p className="text-xs text-red-400/80">{job.errorMessage}</p>
        </div>
      )}

      {/* Résultat si terminé */}
      {job.status === 'done' && (
        <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-3 flex items-center gap-3">
          <CheckCircle2 className="h-5 w-5 text-green-400 shrink-0" />
          <div>
            <p className="text-sm text-green-400 font-medium">Conversion terminée</p>
            <p className="text-xs text-green-400/70">
              {job.filesGenerated ?? 0} fichiers générés
              {job.linesGenerated ? ` · ${job.linesGenerated.toLocaleString()} lignes` : ''}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
