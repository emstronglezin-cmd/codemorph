// ============================================================
// CodeMorph AI Engine — Convert Router
// ============================================================
import { Router, type Request, type Response, type NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pipeline } from '../core/pipeline';
import type { ConversionContext } from '../models/ir.types';

export const convertRouter = Router();

// POST /api/convert
convertRouter.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { jobId, projectId, irDocument, sourceCode, sourceLanguage, sourceFramework, targetFramework, userGoal, callbackUrl } = req.body as {
      jobId?:          string;
      projectId:       string;
      irDocument?:     unknown;
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
      userGoal,
      options: {
        preserveComments:   true,
        generateTests:      true,
        strictMode:         true,
        addTypeAnnotations: true,
      },
    };

    // Run async pipeline — respond immediately with jobId
    res.status(202).json({ jobId: ctx.jobId, status: 'processing', message: 'Conversion pipeline started' });

    // Run pipeline and callback
    pipeline.run(ctx)
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

// POST /api/convert/sync — synchronous (for testing, small files)
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
      projectId,
      sourceCode,
      sourceLanguage: 'typescript',
      sourceFramework,
      targetFramework,
      userGoal,
      options: { preserveComments: true, generateTests: false, strictMode: true, addTypeAnnotations: true },
    };

    const result = await pipeline.run(ctx);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// GET /api/convert/frameworks — list supported conversions
convertRouter.get('/frameworks', (_req: Request, res: Response): void => {
  res.json({
    supported: [
      { source: 'Flutter',  target: 'React',         type: 'frontend', status: 'stable' },
      { source: 'Flutter',  target: 'React Native',  type: 'mobile',   status: 'stable' },
      { source: 'Express',  target: 'NestJS',        type: 'backend',  status: 'stable' },
      { source: 'Node.js',  target: 'NestJS',        type: 'backend',  status: 'stable' },
    ],
  });
});
