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
    res.json({ success: true, data: result });
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
