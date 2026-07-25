// PHASE 25 Partie F: Health router enrichi avec métriques pipeline + cache stats
import { Router, Request, Response } from 'express';
import os from 'os';
import { metricsRegistry } from '../core/metrics-tracker';
import { pipelineCache }   from '../core/pipeline-cache';

export const healthRouter = Router();

healthRouter.get('/', (_req: Request, res: Response): void => {
  const uptime = process.uptime();
  const memUsage = process.memoryUsage();
  const loadAvg = os.loadavg();

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: `${Math.floor(uptime / 60)}m ${Math.floor(uptime % 60)}s`,
    process: {
      pid: process.pid,
      version: process.version,
      memoryUsage: {
        heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
        rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
        external: `${Math.round(memUsage.external / 1024 / 1024)}MB`,
      },
    },
    system: {
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      loadAverage: {
        '1m': (loadAvg[0] ?? 0).toFixed(2),
        '5m': (loadAvg[1] ?? 0).toFixed(2),
        '15m': (loadAvg[2] ?? 0).toFixed(2),
      },
      freeMemory: `${Math.round(os.freemem() / 1024 / 1024)}MB`,
      totalMemory: `${Math.round(os.totalmem() / 1024 / 1024)}MB`,
    },
    services: {
      openai: process.env.OPENAI_API_KEY ? 'configured' : 'not-configured',
    },
    capabilities: {
      frameworks: ['flutter-react', 'flutter-react-native', 'express-nestjs', 'nodejs-nestjs'],
      pipeline: ['ast-analysis', 'architecture-detection', 'ir-generation', 'mapping', 'code-planning', 'validation'],
    },
  });
});

healthRouter.get('/liveness', (_req: Request, res: Response): void => {
  res.status(200).json({ status: 'alive', timestamp: new Date().toISOString() });
});

healthRouter.get('/readiness', (_req: Request, res: Response): void => {
  const ready = !!process.env.OPENAI_API_KEY;
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not-ready',
    timestamp: new Date().toISOString(),
    checks: {
      openai: ready ? 'ok' : 'missing-api-key',
    },
  });
});

// ── PHASE 25 Partie F : GET /api/health/metrics ──────────────
// Expose métriques pipeline : conversions, tokens, coût, cache, mémoire
healthRouter.get('/metrics', (_req: Request, res: Response): void => {
  const summary    = metricsRegistry.getSummary();
  const recentJobs = metricsRegistry.getHistory(10);
  const cacheStats = pipelineCache.getStats();
  const memUsage   = process.memoryUsage();

  res.json({
    summary,
    cacheStats,
    recentJobs: recentJobs.map((j) => ({
      jobId:          j.jobId,
      tier:           j.tier,
      totalMs:        j.timings.total,
      tokens:         j.tokens.total,
      costUSD:        j.costUSD,
      filesGenerated: j.filesGenerated,
      fidelityScore:  j.fidelityScore,
      cacheHits:      j.cacheHits,
    })),
    process: {
      heapUsedMB:  Math.round(memUsage.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
      rssMB:       Math.round(memUsage.rss / 1024 / 1024),
      uptimeS:     Math.round(process.uptime()),
      cpus:        os.cpus().length,
      loadAvg1m:   (os.loadavg()[0] ?? 0).toFixed(2),
    },
    timestamp: new Date().toISOString(),
  });
});
