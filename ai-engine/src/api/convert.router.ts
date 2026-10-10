// ============================================================
// CodeMorph AI Engine — Convert Router
// Supports: Free (Groq), Platform (OpenAI), Pro (user keys)
// User keys passed via headers: X-OpenAI-Key, X-Anthropic-Key
//
// FIX PHASE 16 — INCOMPATIBILITÉ CALLBACK :
// Le backend (jobs.service.ts handleCallback) attend :
//   { success, filesGenerated, linesGenerated, result, irDocument, error }
// L'AI Engine envoyait :
//   { jobId, status, output: { files, summary, irDocument } }
//
// Fix: le callback est maintenant envoyé au format attendu par le backend.
// ============================================================
import { Router, type Request, type Response, type NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pipeline } from '../core/pipeline';
import type { ConversionContext } from '../models/ir.types';

export const convertRouter = Router();

// ── FIX PHASE 37 — Idempotence par jobId ───────────────────
// Le backend peut retenter un dispatch (429 edge, timeout réseau…) alors que
// le pipeline du même jobId tourne déjà côté AI Engine. Sans garde-fou, deux
// pipelines complets tourneraient en parallèle sur le même projet → double
// consommation de quota Groq et callbacks concurrents.
// Cette table borne (max 500 entrées, TTL 2h) rend POST /api/convert idempotent :
//   • jobId déjà EN COURS ('running')   → 202 "already in progress", pas de 2e pipeline
//   • jobId déjà RÉUSSI  ('succeeded')  → 202 (résultat préservé, jamais relancé)
//   • jobId en ÉCHEC    ('failed')      → le dispatch suivant relance le pipeline
//     (c'est le comportement attendu d'un retry après échec réel).
const RUNNING_PIPELINES = new Map<string, { startedAt: number; state: 'running' | 'succeeded' | 'failed' }>();
const RUNNING_PIPELINES_MAX = 500;
const RUNNING_PIPELINES_TTL_MS = 2 * 60 * 60 * 1000;

function pruneRunningPipelines(): void {
  const now = Date.now();
  for (const [jobId, entry] of RUNNING_PIPELINES.entries()) {
    if (now - entry.startedAt > RUNNING_PIPELINES_TTL_MS) RUNNING_PIPELINES.delete(jobId);
  }
  // Borne mémoire : supprimer d'abord les entrées terminées les plus anciennes
  if (RUNNING_PIPELINES.size > RUNNING_PIPELINES_MAX) {
    const entries = [...RUNNING_PIPELINES.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt);
    for (const [jobId, entry] of entries) {
      if (RUNNING_PIPELINES.size <= RUNNING_PIPELINES_MAX) break;
      if (entry.state !== 'running') RUNNING_PIPELINES.delete(jobId);
    }
  }
}

/** Test-only : vide la table d'idempotence. */
export function resetRunningPipelines(): void {
  RUNNING_PIPELINES.clear();
}

/** Test-only : lecture de l'état d'un jobId dans la table. */
export function getRunningPipelineState(jobId: string): 'running' | 'succeeded' | 'failed' | undefined {
  return RUNNING_PIPELINES.get(jobId)?.state;
}

// ── Helper: extract user AI keys from headers ──────────────
function extractAIKeys(req: Request): { userOpenAIKey?: string; userAnthropicKey?: string } {
  const openaiKey    = req.headers['x-openai-key'] as string | undefined;
  const anthropicKey = req.headers['x-anthropic-key'] as string | undefined;
  const result: { userOpenAIKey?: string; userAnthropicKey?: string } = {};
  if (openaiKey && openaiKey.startsWith('sk-'))       result.userOpenAIKey    = openaiKey;
  if (anthropicKey && anthropicKey.startsWith('sk-ant')) result.userAnthropicKey = anthropicKey;
  return result;
}

// ── POST /api/convert — async (fire and forget + callback) ─
convertRouter.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  // FIX PHASE 33 — [AI-ENGINE-REQUEST] : premier log absolu dès réception HTTP,
  // avant toute validation SSRF, guard ou construction de contexte.
  // Permet de confirmer côté Runtime que la requête du Backend est bien arrivée.
  const requestId = (req.headers['x-request-id'] as string | undefined) ?? `req-${Date.now()}`;
  const rawJobId  = (req.body as Record<string, unknown>)?.jobId as string | undefined;
  console.log(
    `[AI-ENGINE-REQUEST] route=POST /api/convert requestId=${requestId} ` +
    `jobId=${rawJobId ?? '(not yet parsed)'} ` +
    `sourceFramework=${(req.body as Record<string, unknown>)?.sourceFramework ?? '?'} ` +
    `targetFramework=${(req.body as Record<string, unknown>)?.targetFramework ?? '?'} ` +
    `hasCallbackUrl=${!!(req.body as Record<string, unknown>)?.callbackUrl} ` +
    `ip=${req.ip ?? req.socket?.remoteAddress ?? 'unknown'}`,
  );

  try {
    const {
      jobId,
      projectId,
      sourceCode,
      sourceLanguage,
      sourceFramework,
      targetFramework,
      userGoal,
      callbackUrl,
      progressUrl,
      options,
    } = req.body as {
      jobId?:          string;
      projectId:       string;
      sourceCode?:     string;
      sourceLanguage?: string;
      sourceFramework: string;
      targetFramework: string;
      userGoal?:       string;
      callbackUrl?:    string;
      progressUrl?:    string;  // URL pour les mises à jour de progression (PHASE 28)
      options?:        Record<string, unknown>;
    };

    // Guard: champs obligatoires
    if (!sourceFramework && !sourceLanguage) {
      res.status(400).json({ error: 'sourceFramework or sourceLanguage is required' });
      return;
    }
    if (!targetFramework) {
      res.status(400).json({ error: 'targetFramework is required' });
      return;
    }
    if (!sourceCode || sourceCode.trim().length === 0) {
      res.status(400).json({ error: 'sourceCode is required and must not be empty' });
      return;
    }

    // FIX PHASE 5/6 — SEC-04 : validation SSRF du callbackUrl
    // FIX PHASE 6: import depuis utils/ssrf.ts (pas '../index' → plus d'import circulaire)
    if (callbackUrl) {
      const { isCallbackUrlSafe } = await import('../utils/ssrf');
      if (!isCallbackUrlSafe(callbackUrl)) {
        console.warn(`[SEC-04] SSRF attempt blocked: callbackUrl="${callbackUrl}"`);
        res.status(400).json({ error: `Invalid callbackUrl — SSRF protection blocked this host: ${callbackUrl}` });
        return;
      }
    }

    const ctx: ConversionContext = {
      jobId:           jobId ?? uuidv4(),
      projectId:       projectId ?? jobId ?? uuidv4(),
      sourceCode:      sourceCode ?? '',
      sourceLanguage:  sourceLanguage ?? sourceFramework ?? 'typescript',
      sourceFramework: sourceFramework ?? sourceLanguage ?? 'typescript',
      targetFramework: targetFramework,
      ...(userGoal !== undefined ? { userGoal } : {}),
      ...(progressUrl ? { progressUrl } : {}),
      options: {
        preserveComments:   (options?.preserveComments as boolean) ?? true,
        generateTests:      (options?.generateTests as boolean) ?? true,
        strictMode:         (options?.strictMode as boolean) ?? true,
        addTypeAnnotations: (options?.addTypeAnnotations as boolean) ?? true,
      },
    };

    const aiOpts = extractAIKeys(req);

    // FIX PHASE 37 — Idempotence : si un pipeline tourne déjà pour ce jobId
    // (dispatch retenté par le backend pendant la conversion), on répond 202
    // sans relancer de pipeline. Évite la double consommation de quota et les
    // callbacks concurrents. Le premier pipeline en cours reste la seule source.
    pruneRunningPipelines();
    const existingRun = RUNNING_PIPELINES.get(ctx.jobId);
    if (existingRun && existingRun.state === 'running') {
      console.warn(
        `[AI-ENGINE-DUPLICATE] requestId=${requestId} jobId=${ctx.jobId} — pipeline déjà en cours ` +
        `(démarré il y a ${Math.round((Date.now() - existingRun.startedAt) / 1000)}s). ` +
        `Réponse 202 sans relancer de second pipeline.`,
      );
      res.status(202).json({
        jobId: ctx.jobId,
        accepted: true,
        message: 'Conversion already in progress — duplicate dispatch ignored',
      });
      return;
    }
    if (existingRun && existingRun.state === 'succeeded') {
      console.warn(
        `[AI-ENGINE-DUPLICATE] requestId=${requestId} jobId=${ctx.jobId} — conversion déjà RÉUSSIE. ` +
        `Résultat préservé, aucune ré-exécution.`,
      );
      res.status(202).json({
        jobId: ctx.jobId,
        accepted: true,
        message: 'Conversion already completed — result preserved',
      });
      return;
    }
    // state 'failed' ou absent → (re)démarrage légitime du pipeline
    RUNNING_PIPELINES.set(ctx.jobId, { startedAt: Date.now(), state: 'running' });

    // Count files in sourceCode
    const fileMarkerCount = (sourceCode.match(/\/\/\s*(?:=+\s*)?FILE:\s*/g) ?? []).length;
    console.log(`[PIPELINE] ━━━ AI Engine received conversion job ━━━`);
    console.log(`[PIPELINE] job=${ctx.jobId} src=${ctx.sourceFramework} tgt=${ctx.targetFramework}`);
    console.log(`[PIPELINE] Files detected: ${fileMarkerCount} (from file markers in sourceCode)`);
    console.log(`[PIPELINE] sourceCode.length=${sourceCode.length} chars callbackUrl=${callbackUrl ?? '(none)'}`);

    // FIX PHASE 34 — [AI-ENGINE-ACCEPTED] : log émis AVANT le 202 HTTP pour confirmer que
    // l'AI Engine accepte bien le job et démarre le pipeline.
    // Correspond au [DISPATCH-RESPONSE] côté Backend — les deux jobId doivent être identiques.
    console.log(
      `[AI-ENGINE-ACCEPTED] requestId=${requestId} jobId=${ctx.jobId} ` +
      `aiEngineJobId=${ctx.jobId} sourceFramework=${ctx.sourceFramework} ` +
      `targetFramework=${ctx.targetFramework} hasCallbackUrl=${!!callbackUrl} ` +
      `sourceChars=${sourceCode.length} fileMarkers=${fileMarkerCount}`,
    );

    res.status(202).json({ jobId: ctx.jobId, accepted: true, message: 'Conversion pipeline started' });

    // Run pipeline + callback in background
    pipeline.run(ctx, aiOpts)
      .then(async (result) => {
        // FIX PHASE 37 — conversion réussie : plus jamais ré-exécutée pendant le TTL
        const run = RUNNING_PIPELINES.get(ctx.jobId);
        if (run) run.state = 'succeeded';
        const filesCount = result.files?.length ?? 0;
        const linesTotal = result.files?.reduce((acc: number, f: { content: string }) => acc + (f.content?.split('\n').length ?? 0), 0) ?? 0;
        console.log(`[PIPELINE] ━━━ Pipeline completed ━━━`);
        console.log(`[PIPELINE] job=${ctx.jobId} Generated files: ${filesCount} | Total lines: ${linesTotal} | Duration: ${result.durationMs}ms`);
        result.files?.slice(0, 5).forEach((f: { path: string }, i: number) => {
          console.log(`[PIPELINE]   [${i+1}] ${f.path}`);
        });
        if (filesCount > 5) console.log(`[PIPELINE]   ... and ${filesCount - 5} more files`);

        // ── Phase 9: Afficher le CONVERSION REPORT dans les logs (si disponible)
        if (result.conversionReport?.text) {
          console.log(result.conversionReport.text);
        }

        // ── Phase 5: Afficher le statut compilation
        if (result.compilationResult) {
          const cr = result.compilationResult;
          console.log(`[PIPELINE] ━━━ Compilation ━━━`);
          console.log(`[PIPELINE] Status: ${cr.success ? '✅ PASS' : '❌ FAIL'} | Errors: ${cr.errorsCount} | Warnings: ${cr.warningsCount} | Fixed: ${cr.filesFixed} | Duration: ${cr.duration}ms`);
        }

        // ── Phase 8: Afficher le statut ZIP
        if (result.zipResult) {
          const zr = result.zipResult;
          console.log(`[PIPELINE] ━━━ ZIP ━━━`);
          console.log(`[PIPELINE] Status: ${zr.success ? '✅ OK' : '❌ FAIL'} | Files: ${zr.fileCount} | Size: ${(zr.totalBytes / 1024).toFixed(1)} KB | Path: ${zr.zipPath}`);
        }

        // ── Phase 12 (NOUVEAU): Afficher le statut Delivery Check
        if (result.deliveryCheck) {
          const dc = result.deliveryCheck;
          const statusIcon = dc.status === 'READY' ? '✅' : '⚠️';
          console.log(`[PIPELINE] ━━━ Delivery Check ━━━`);
          console.log(`[PIPELINE] ${statusIcon} Status: ${dc.status} | Score: ${dc.score}% | Blockers: ${dc.blockers?.length ?? 0} | Warnings: ${dc.warnings?.length ?? 0}`);
          if (dc.blockers && dc.blockers.length > 0) {
            dc.blockers.forEach((b: string) => console.log(`[PIPELINE]   🔴 ${b}`));
          }
        }

        // ── Phase 8 fonctionnelle (NOUVEAU): Afficher le résumé des tests
        if (result.testResults) {
          const tr = result.testResults;
          console.log(`[PIPELINE] ━━━ Functional Tests ━━━`);
          console.log(`[PIPELINE] ${tr.overallStatus} | Total: ${tr.totalTests} | PASS: ${tr.passed} | PARTIAL: ${tr.partial} | FAIL: ${tr.failed} | NOT_TESTABLE: ${tr.notTestable}`);
        }

        // ── Phase 6 (NOUVEAU): Afficher le résumé Content Validation
        if (result.contentValidation) {
          const cv = result.contentValidation;
          console.log(`[PIPELINE] ━━━ Content Validation ━━━`);
          console.log(`[PIPELINE] Total: ${cv.totalFiles} | Converted: ${cv.convertedFiles} | SHELL: ${cv.shellFiles} | Rate: ${cv.conversionRate}%`);
          if (cv.shellFiles > 0) {
            console.log(`[PIPELINE] ⚠️  ${cv.shellFiles} SHELL files detected — counted as score=0`);
          }
        }
        if (callbackUrl) {
          const { default: axios } = await import('axios');
          const filesGenerated  = result.files?.length ?? 0;
          const linesGenerated  = result.files?.reduce(
            (acc: number, f: { content: string }) => acc + (f.content?.split('\n').length ?? 0), 0
          ) ?? 0;
          const aiEngineSecret = process.env['AI_ENGINE_SECRET'] ?? '';
          const callbackHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
          };
          if (aiEngineSecret) {
            callbackHeaders['X-AI-Engine-Secret'] = aiEngineSecret;
          }

          // FIX PHASE 32 — CALLBACK RETRY + LOGS STRUCTURÉS
          // AVANT: un seul axios.post avec .catch() silencieux.
          //   Si le backend était en sleep mode Render (cold start ~30s) ou avait un timeout,
          //   le callback échouait silencieusement → job restait RUNNING indéfiniment.
          // MAINTENANT: 3 tentatives avec backoff (0s, 10s, 30s).
          //   Si toutes échouent → log [CALLBACK-FAILED] explicite (visible dans Render logs).
          const callbackPayload = {
            success:        true,
            jobId:          result.jobId,
            filesGenerated,
            linesGenerated,
            result: {
              files:           result.files,
              summary:         result.summary,
              sourceLanguage:  ctx.sourceLanguage,
              targetLanguage:  ctx.targetFramework,
              conversionType:  'ai',
              generatedAt:     new Date().toISOString(),
              aiTier:  result.aiTier,
              aiModel: result.aiModel,
              compilationResult:  result.compilationResult,
              zipResult:          result.zipResult,
              conversionReport:   result.conversionReport?.text,
              applicationSpec:    result.applicationSpec,
              contentValidation:  result.contentValidation,
              deliveryCheck:      result.deliveryCheck,
              testResults:        result.testResults,
              fidelityScore:      result.fidelityScore,
              conversionReportJson:    result.conversionReport?.json,
              conversionReportMarkdown: result.conversionReport?.markdown,
              // ── PHASE 36: rapport du pipeline sémantique (gros projets) ──────
              phase36Report:      result.phase36Report,
            },
            irDocument:     result.ir,
          };

          const MAX_CALLBACK_ATTEMPTS = 3;
          const CALLBACK_DELAYS_MS = [0, 10_000, 30_000]; // 0s, 10s, 30s
          let callbackSent = false;
          for (let attempt = 1; attempt <= MAX_CALLBACK_ATTEMPTS; attempt++) {
            const delay = CALLBACK_DELAYS_MS[attempt - 1] ?? 0;
            if (delay > 0) {
              console.log(`[CALLBACK-RETRY] job=${ctx.jobId} attempt=${attempt}/${MAX_CALLBACK_ATTEMPTS} waiting ${delay}ms before retry`);
              await new Promise<void>((r) => setTimeout(r, delay));
            }
            try {
              const cbStart = Date.now();
              console.log(
                `[CALLBACK-SEND] job=${ctx.jobId} attempt=${attempt}/${MAX_CALLBACK_ATTEMPTS} ` +
                `→ ${callbackUrl} filesGenerated=${filesGenerated} ` +
                `secret=${aiEngineSecret ? 'SET' : 'NOT SET — will likely be rejected!'} ` +
                `aiTier=${result.aiTier ?? 'unknown'}`,
              );
              await axios.post(callbackUrl, callbackPayload, { timeout: 20_000, headers: callbackHeaders });
              console.log(
                `[CALLBACK-SEND-OK] job=${ctx.jobId} attempt=${attempt} ` +
                `durationMs=${Date.now() - cbStart} → ${callbackUrl}`,
              );
              callbackSent = true;
              break;
            } catch (cbErr: unknown) {
              const msg = (cbErr as Error).message ?? String(cbErr);
              const status = (cbErr as { response?: { status?: number } })?.response?.status;
              console.error(
                `[CALLBACK-SEND-FAIL] job=${ctx.jobId} attempt=${attempt}/${MAX_CALLBACK_ATTEMPTS} ` +
                `url=${callbackUrl} httpStatus=${status ?? 'NO_RESPONSE'} error=${msg}`,
              );
              if (status === 401 || status === 403) {
                console.error(
                  `[CALLBACK-AUTH-REJECTED] job=${ctx.jobId} — Backend rejected callback with ${status}. ` +
                  `Check AI_ENGINE_SECRET matches on both Backend and AI Engine Render env vars.`,
                );
                break; // Pas la peine de réessayer si c'est un 401/403
              }
            }
          }
          if (!callbackSent) {
            console.error(
              `[CALLBACK-FAILED] job=${ctx.jobId} — ALL ${MAX_CALLBACK_ATTEMPTS} callback attempts FAILED. ` +
              `callbackUrl=${callbackUrl}. ` +
              `Job will remain RUNNING on backend until watchdog kills it (Phase 31: 120min absolute timeout).`,
            );
          }
        }
      })
      .catch(async (err: Error) => {
        // FIX PHASE 37 — échec réel : un dispatch ultérieur du même jobId pourra relancer
        const run = RUNNING_PIPELINES.get(ctx.jobId);
        if (run) run.state = 'failed';
        console.error(`[PIPELINE-FAILED] job=${ctx.jobId} error=${err.message}`);
        if (callbackUrl) {
          const { default: axios } = await import('axios');
          const aiEngineSecret = process.env['AI_ENGINE_SECRET'] ?? '';
          const callbackHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
          if (aiEngineSecret) callbackHeaders['X-AI-Engine-Secret'] = aiEngineSecret;

          // Retry aussi pour le callback d'erreur
          const MAX_ERR_ATTEMPTS = 3;
          const ERR_DELAYS_MS = [0, 5_000, 15_000];
          for (let attempt = 1; attempt <= MAX_ERR_ATTEMPTS; attempt++) {
            const delay = ERR_DELAYS_MS[attempt - 1] ?? 0;
            if (delay > 0) await new Promise<void>((r) => setTimeout(r, delay));
            try {
              console.log(
                `[CALLBACK-SEND] job=${ctx.jobId} FAILURE callback attempt=${attempt}/${MAX_ERR_ATTEMPTS} ` +
                `→ ${callbackUrl} error="${err.message}"`,
              );
              await axios.post(callbackUrl, {
                success: false,
                jobId:   ctx.jobId,
                error:   err.message,
              }, { timeout: 15_000, headers: callbackHeaders });
              console.log(`[CALLBACK-SEND-OK] job=${ctx.jobId} FAILURE callback sent attempt=${attempt}`);
              break;
            } catch (cbErr: unknown) {
              const msg = (cbErr as Error).message ?? String(cbErr);
              const status = (cbErr as { response?: { status?: number } })?.response?.status;
              console.error(
                `[CALLBACK-SEND-FAIL] job=${ctx.jobId} FAILURE callback attempt=${attempt}/${MAX_ERR_ATTEMPTS} ` +
                `httpStatus=${status ?? 'NO_RESPONSE'} error=${msg}`,
              );
              if (attempt === MAX_ERR_ATTEMPTS) {
                console.error(
                  `[CALLBACK-FAILED] job=${ctx.jobId} — ALL ${MAX_ERR_ATTEMPTS} FAILURE callback attempts failed. ` +
                  `Job will remain RUNNING until watchdog (Phase 31: 120min absolute timeout).`,
                );
              }
            }
          }
        }
      });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/convert/sync — synchronous (small files, testing)
convertRouter.post('/sync', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { projectId, sourceCode, sourceFramework, targetFramework, userGoal } = req.body as {
      projectId:       string;
      sourceCode:      string;
      sourceFramework: string;
      targetFramework: string;
      userGoal?:       string;
    };

    const ctx: ConversionContext = {
      jobId:          uuidv4(),
      projectId:      projectId ?? 'sync-test',
      sourceCode,
      sourceLanguage: 'typescript',
      sourceFramework,
      targetFramework,
      ...(userGoal !== undefined ? { userGoal } : {}),
      options: { preserveComments: true, generateTests: false, strictMode: true, addTypeAnnotations: true },
    };

    const aiOpts = extractAIKeys(req);
    const result = await pipeline.run(ctx, aiOpts);

    // Phase 9: Afficher le CONVERSION REPORT dans les logs
    if (result.conversionReport?.text) {
      console.log(result.conversionReport.text);
    }

    // Phase 12 (NOUVEAU): Log delivery check status
    if (result.deliveryCheck) {
      const dc = result.deliveryCheck;
      const statusIcon = dc.status === 'READY' ? '✅' : '⚠️';
      console.log(`[SYNC] ${statusIcon} Delivery: ${dc.status} | Score: ${dc.score}% | Blockers: ${dc.blockers?.length ?? 0}`);
    }

    // Phase 6 (NOUVEAU): Log content validation
    if (result.contentValidation) {
      const cv = result.contentValidation;
      console.log(`[SYNC] Content: ${cv.convertedFiles}/${cv.totalFiles} converted | SHELL: ${cv.shellFiles} | Rate: ${cv.conversionRate}%`);
    }

    // Phase 8 fonctionnelle (NOUVEAU): Log test results
    if (result.testResults) {
      const tr = result.testResults;
      console.log(`[SYNC] Tests: ${tr.overallStatus} | PASS: ${tr.passed}/${tr.totalTests} | FAIL: ${tr.failed}`);
    }

    // Retourner l'ensemble du résultat incluant les 7 livrables obligatoires
    res.json({
      success: true,
      data: {
        // Identifiant et IR
        jobId:               result.jobId,
        ir:                  result.ir,
        // Fichiers générés
        files:               result.files,
        summary:             result.summary,
        // Méta
        tokensUsed:          result.tokensUsed,
        durationMs:          result.durationMs,
        aiTier:              result.aiTier,
        aiModel:             result.aiModel,
        // Scores et rapports
        fidelityScore:       result.fidelityScore,
        autoCorrectionReport: result.autoCorrectionReport,
        // ── LIVRABLES OBLIGATOIRES (7) ───────────────────────────────────
        // 1. application-spec.json
        applicationSpec:     result.applicationSpec,
        // 2. conversion-report.json + .md
        conversionReport:    result.conversionReport,
        // 3. fidelity-report.json (score + details)
        fidelityReport: result.fidelityScore ? {
          overall:        result.fidelityScore.overall,
          applicableAxes: result.fidelityScore.applicableAxes,
          naAxes:         result.fidelityScore.naAxes,
          details:        result.fidelityScore.details,
          deliveryStatus: result.deliveryCheck?.status,
          generatedAt:    new Date().toISOString(),
        } : undefined,
        // 4. content-validation (SHELL detection)
        contentValidation:   result.contentValidation,
        // 5. delivery-check.json (READY/NEEDS_REPAIR)
        deliveryCheck:       result.deliveryCheck,
        // 6. test-results.json
        testResults:         result.testResults,
        // 7. target.zip
        compilationResult:   result.compilationResult,
        zipResult:           result.zipResult,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/convert/frameworks — supported conversions
convertRouter.get('/frameworks', (_req: Request, res: Response): void => {
  res.json({
    supported: [
      { source: 'Flutter',  target: 'React',        type: 'frontend', status: 'stable' },
      { source: 'Flutter',  target: 'React Native', type: 'mobile',   status: 'stable' },
      { source: 'Express',  target: 'NestJS',       type: 'backend',  status: 'stable' },
      { source: 'Node.js',  target: 'NestJS',       type: 'backend',  status: 'stable' },
    ],
    tiers: {
      free:       { model: 'Llama 3.1 8B (Groq)', maxInputChars: 15_000, maxFilesGenerated: 10,  dailyLimit: 5 },
      pro:        { model: 'gpt-4o (user key)',    maxInputChars: 200_000, maxFilesGenerated: 100, dailyLimit: 'unlimited' },
      proMax:     { model: 'claude-3-5-sonnet',    maxInputChars: 200_000, maxFilesGenerated: 100, dailyLimit: 'unlimited' },
    },
  });
});
