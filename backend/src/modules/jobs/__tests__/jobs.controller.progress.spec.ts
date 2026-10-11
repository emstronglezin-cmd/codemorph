// ============================================================
// CodeMorph — TESTS PHASE 40 : problème C, la route de progression existe
// ------------------------------------------------------------
// CONSTAT (cause racine du « bloqué à 50 % ») : `dispatchToAiEngine()` passait
// à l'AI Engine `progressUrl = ${apiUrl}/jobs/${id}/progress`, mais aucune route
// de ce nom n'était déclarée dans jobs.controller.ts. Chaque POST faisait 404.
//
// Ces tests verrouillent l'existence et le comportement de la route :
//   • elle est bien déclarée en POST sur ':id/progress' ;
//   • elle est publique (l'AI Engine n'a pas de JWT) mais protégée par
//     X-AI-Engine-Secret, comme /:id/callback ;
//   • elle délègue à handleProgress ;
//   • une erreur interne ne casse PAS le pipeline de l'AI Engine (200 + ok:false).
// ============================================================
import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { JobsController } from '../jobs.controller';

const SECRET = 'shared-secret-TEST-ONLY';

function makeController(opts: {
  secret?: string;
  handleProgress?: jest.Mock;
}): { controller: JobsController; handleProgress: jest.Mock; logs: string[] } {
  const handleProgress = opts.handleProgress
    ?? jest.fn().mockResolvedValue({ progress: 62, phase: 'phase_3_ir' });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jobsService = { handleProgress } as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const uploadsService = {} as any;
  const config = {
    get: jest.fn((key: string, dflt?: string) => (key === 'AI_ENGINE_SECRET' ? (opts.secret ?? '') : dflt)),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const controller = new JobsController(jobsService, uploadsService, config);

  const logs: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (controller as any).logger = { log: () => undefined, warn: (...a: unknown[]) => logs.push(a.map(String).join(' ')), error: () => undefined };

  return { controller, handleProgress, logs };
}

function reqWith(secret?: string): never {
  return { headers: secret ? { 'x-ai-engine-secret': secret } : {} } as never;
}

const BODY = { phase: 'phase_3_ir', phaseName: 'Analyse IR', filesDone: 15, filesTotal: 33 };

describe('POST /jobs/:id/progress — la route existe (régression du 404 silencieux)', () => {
  it('est déclarée en POST sur le chemin \':id/progress\'', () => {
    const proto = JobsController.prototype;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (proto as any).progress;
    expect(typeof handler).toBe('function');

    // Nest stocke le chemin en string simple pour une route mono-segment.
    const path = Reflect.getMetadata('path', handler);
    expect(Array.isArray(path) ? path[0] : path).toBe(':id/progress');
    expect(Reflect.getMetadata('method', handler)).toBe(1); // 1 = POST dans Nest
    expect(Reflect.getMetadata('__httpCode__', handler)).toBe(200);
  });

  it('est publique (l\'AI Engine n\'a pas de JWT)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (JobsController.prototype as any).progress;
    expect(Reflect.getMetadata('isPublic', handler)).toBe(true);
  });

  it('secret valide → délègue à handleProgress et renvoie la progression réelle', async () => {
    const { controller, handleProgress } = makeController({ secret: SECRET });

    const res = await controller.progress('job-id-1', reqWith(SECRET), BODY);

    expect(handleProgress).toHaveBeenCalledWith('job-id-1', BODY);
    expect(res).toEqual({ ok: true, progress: 62, phase: 'phase_3_ir' });
  });

  it('secret absent → 401, handleProgress n\'est PAS appelé', async () => {
    const { controller, handleProgress, logs } = makeController({ secret: SECRET });

    await expect(controller.progress('job-id-1', reqWith(undefined), BODY))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(handleProgress).not.toHaveBeenCalled();
    // Le rejet est journalisé, sans jamais révéler le secret attendu.
    expect(logs.join('\n')).toContain('[PROGRESS-REJECTED]');
    expect(logs.join('\n')).not.toContain(SECRET);
  });

  it('secret erroné → 401, sans fuite du secret fourni ni attendu', async () => {
    const { controller, handleProgress, logs } = makeController({ secret: SECRET });

    await expect(controller.progress('job-id-1', reqWith('wrong-secret'), BODY))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(handleProgress).not.toHaveBeenCalled();
    const joined = logs.join('\n');
    expect(joined).not.toContain(SECRET);
    expect(joined).not.toContain('wrong-secret');
    expect(joined).toContain('(set but wrong)');
  });

  it('aucun secret configuré → la route reste ouverte (environnement de dev)', async () => {
    const { controller, handleProgress } = makeController({ secret: '' });

    const res = await controller.progress('job-id-1', reqWith(undefined), BODY);

    expect(handleProgress).toHaveBeenCalled();
    expect(res.ok).toBe(true);
  });

  it('erreur interne de handleProgress → 200 avec ok:false, le pipeline continue', async () => {
    const { controller, logs } = makeController({
      secret: SECRET,
      handleProgress: jest.fn().mockRejectedValue(new Error('DB unavailable')),
    });

    // Ne doit PAS rejeter : l'AI Engine ne doit jamais s'arrêter sur un rapport.
    const res = await controller.progress('job-id-1', reqWith(SECRET), BODY);

    expect(res.ok).toBe(false);
    expect(logs.join('\n')).toContain('[PROGRESS-FAILED]');
  });
});
