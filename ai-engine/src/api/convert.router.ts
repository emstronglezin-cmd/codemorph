// ============================================================
// CodeMorph AI Engine — Convert Router
// Supports: Free (Groq), Platform (OpenAI), Pro (user keys)
// User keys passed via headers: X-OpenAI-Key, X-Anthropic-Key
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
    const { jobId, projectId, sourceCode, sourceLanguage, sourceFramework, targetFramework, userGoal, callbackUrl } = req.body as {
      jobId?:          string;
      projectId:       string;
      sourceCode?:     string;
      sourceLanguage?: string;
      sourceFramework: string;
      targetFramework: string;
      userGoal?:       string;
      callbackUrl?:    string;
    };

    const ctx: ConversionContext = {
      jobId:           jobId ?? uuidv4(),
      projectId,
      sourceCode:      sourceCode ?? '',
      sourceLanguage:  sourceLanguage ?? 'typescript',
      sourceFramework,
      targetFramework,
      ...(userGoal !== undefined ? { userGoal } : {}),
      options: {
        preserveComments:   true,
        generateTests:      true,
        strictMode:         true,
        addTypeAnnotations: true,
      },
    };

    const aiOpts = extractAIKeys(req);

    // Respond immediately with jobId
    res.status(202).json({ jobId: ctx.jobId, status: 'processing', message: 'Conversion pipeline started' });

    // Run pipeline + optional callback
    pipeline.run(ctx, aiOpts)
      .then(async (result) => {
        if (callbackUrl) {
          const { default: axios } = await import('axios');
          await axios.post(callbackUrl, {
            jobId:       result.jobId,
            status:      'completed',
            output:      { files: result.files, summary: result.summary, irDocument: result.ir },
            tokensUsed:  result.tokensUsed,
            durationMs:  result.durationMs,
          }).catch(() => null);
        }
      })
      .catch(async (err: Error) => {
        if (callbackUrl) {
          const { default: axios } = await import('axios');
          await axios.post(callbackUrl, {
            jobId:        ctx.jobId,
            status:       'failed',
            errorMessage: err.message,
          }).catch(() => null);
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
