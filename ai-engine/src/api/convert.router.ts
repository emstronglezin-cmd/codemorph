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
      options: {
        preserveComments:   (options?.preserveComments as boolean) ?? true,
        generateTests:      (options?.generateTests as boolean) ?? true,
        strictMode:         (options?.strictMode as boolean) ?? true,
        addTypeAnnotations: (options?.addTypeAnnotations as boolean) ?? true,
      },
    };

    const aiOpts = extractAIKeys(req);

    // Count files in sourceCode
    const fileMarkerCount = (sourceCode.match(/\/\/\s*(?:=+\s*)?FILE:\s*/g) ?? []).length;
    console.log(`[PIPELINE] ━━━ AI Engine received conversion job ━━━`);
    console.log(`[PIPELINE] job=${ctx.jobId} src=${ctx.sourceFramework} tgt=${ctx.targetFramework}`);
    console.log(`[PIPELINE] Files detected: ${fileMarkerCount} (from file markers in sourceCode)`);
    console.log(`[PIPELINE] sourceCode.length=${sourceCode.length} chars callbackUrl=${callbackUrl ?? '(none)'}`);
    res.status(202).json({ jobId: ctx.jobId, accepted: true, message: 'Conversion pipeline started' });

    // Run pipeline + callback in background
    pipeline.run(ctx, aiOpts)
      .then(async (result) => {
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
          // FIX: format de callback attendu par le backend handleCallback()
          // Backend attend: { success, filesGenerated, linesGenerated, result, irDocument }
          const filesGenerated  = result.files?.length ?? 0;
          const linesGenerated  = result.files?.reduce(
            (acc: number, f: { content: string }) => acc + (f.content?.split('\n').length ?? 0), 0
          ) ?? 0;
          // FIX PHASE 20 — CRITICAL: ajouter X-AI-Engine-Secret au callback
          // Le backend (jobs.controller.ts) vérifie ce header avant d'accepter le callback.
          // Sans ce header → 401 UnauthorizedException → callback silencieusement rejeté
          // → job reste CONVERTING indéfiniment → watchdog FAILED après 5 min.
          const aiEngineSecret = process.env['AI_ENGINE_SECRET'] ?? '';
          const callbackHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
          };
          if (aiEngineSecret) {
            callbackHeaders['X-AI-Engine-Secret'] = aiEngineSecret;
          }
          await axios.post(callbackUrl, {
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
              // FIX PHASE 20 — Transmettre le provider IA au backend pour affichage frontend
              aiTier:  result.aiTier,
              aiModel: result.aiModel,
              // PHASE FINALE — Nouveaux champs
              compilationResult:  result.compilationResult,
              zipResult:          result.zipResult,
              conversionReport:   result.conversionReport?.text,
              // PHASE 2.5/6/8/12 (NOUVEAU) — Livrables obligatoires
              applicationSpec:    result.applicationSpec,
              contentValidation:  result.contentValidation,
              deliveryCheck:      result.deliveryCheck,
              testResults:        result.testResults,
              fidelityScore:      result.fidelityScore,
              conversionReportJson:    result.conversionReport?.json,
              conversionReportMarkdown: result.conversionReport?.markdown,
            },
            irDocument:     result.ir,
          }, { timeout: 15_000, headers: callbackHeaders }).catch((cbErr: Error) => {
            console.error(`[PIPELINE] Callback POST FAILED: ${cbErr.message} → ${callbackUrl}`);
          });
          console.log(`[PIPELINE] ━━━ Callback sent ━━━`);
          console.log(`[PIPELINE] Callback → ${callbackUrl}`);
          console.log(`[PIPELINE] filesGenerated=${filesGenerated} linesGenerated=${linesGenerated} secret=${aiEngineSecret ? 'SET' : 'NOT SET — callback may be rejected!'} aiTier=${result.aiTier ?? 'unknown'}`);
        }
      })
      .catch(async (err: Error) => {
        console.error(`[PIPELINE] Pipeline FAILED — job=${ctx.jobId} error=${err.message}`);
        if (callbackUrl) {
          const { default: axios } = await import('axios');
          // FIX: format d'erreur attendu par le backend handleCallback()
          // Backend attend: { success: false, error }
          // FIX PHASE 20 — CRITICAL: ajouter X-AI-Engine-Secret au callback d'erreur également
          const aiEngineSecret = process.env['AI_ENGINE_SECRET'] ?? '';
          const callbackHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
          };
          if (aiEngineSecret) {
            callbackHeaders['X-AI-Engine-Secret'] = aiEngineSecret;
          }
          await axios.post(callbackUrl, {
            success: false,
            jobId:   ctx.jobId,
            error:   err.message,
          }, { timeout: 15_000, headers: callbackHeaders }).catch((cbErr: Error) => {
            console.error(`[PIPELINE] Failure callback POST FAILED: ${cbErr.message}`);
          });
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
