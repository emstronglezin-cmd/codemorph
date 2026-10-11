// ============================================================
// CodeMorph — TESTS PHASE 40 : problème C, livraison silencieuse de la progression
// ------------------------------------------------------------
// CONSTAT : `ProgressReporter.sendAsync()` faisait `await fetch(...)` sans
// JAMAIS regarder `res.ok`. La route `/jobs/:id/progress` n'existait pas côté
// backend : chaque rapport recevait un 404, l'erreur partait dans un
// `catch {}` vide, et personne ne voyait que la progression n'arrivait pas.
//
// Ces tests vérifient que `res.ok` est désormais inspecté et que l'échec est
// journalisé une fois par code d'erreur — sans jamais journaliser le secret.
// ============================================================
import { ProgressReporter } from '../src/core/progress-reporter';

const SECRET = 'ai-engine-secret-TEST-ONLY-0000';

type FetchImpl = (...args: never[]) => Promise<unknown>;

function stubFetch(impl: FetchImpl): jest.Mock {
  const spy = jest.fn(impl as unknown as typeof fetch);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).fetch = spy;
  return spy;
}

function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spies = ['log', 'warn', 'error'].map((m) =>
    jest.spyOn(console, m as 'log').mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(' '));
    }),
  );
  return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
}

afterEach(() => jest.restoreAllMocks());

describe('ProgressReporter — un rapport non livré n\'est plus silencieux', () => {
  it('un 404 (route absente) est désormais JOURNALISÉ au lieu d\'être avalé', async () => {
    stubFetch(async () => ({ ok: false, status: 404, statusText: 'Not Found' }));
    const cap = captureConsole();
    try {
      const r = new ProgressReporter('http://backend/jobs/j1/progress', 'j1');
      await r.reportForce('phase_3_ir', 'Analyse IR', 5, 33, 'en cours');
    } finally {
      cap.restore();
    }

    const joined = cap.lines.join('\n');
    expect(joined).toContain('404');
    // Le log doit orienter vers la vraie cause : la route manquante.
    expect(joined).toMatch(/progress|route/i);
  });

  it('un 401/403 du backend (secret rejeté) est journalisé, SANS révéler le secret', async () => {
    const seenHeaders: Record<string, string>[] = [];
    // Le reporter lit le secret dans l'environnement, jamais dans un champ.
    process.env['AI_ENGINE_SECRET'] = SECRET;
    stubFetch(async (...args: never[]) => {
      const init = args[1] as { headers?: Record<string, string> };
      seenHeaders.push(init?.headers ?? {});
      return { ok: false, status: 401, statusText: 'Unauthorized' };
    });

    const cap = captureConsole();
    try {
      const r = new ProgressReporter('http://backend/jobs/j1/progress', 'j1');
      await r.reportForce('phase_3_ir', 'Analyse IR', 5, 33, 'en cours');
    } finally {
      cap.restore();
      delete process.env['AI_ENGINE_SECRET'];
    }

    const joined = cap.lines.join('\n');
    expect(joined).toContain('401');
    expect(joined).not.toContain(SECRET);
    // Le secret part bien dans l'en-tête, jamais dans les logs.
    expect(JSON.stringify(seenHeaders)).toContain(SECRET);
  });

  it('un même code d\'erreur n\'est journalisé qu\'UNE fois (pas de spam)', async () => {
    stubFetch(async () => ({ ok: false, status: 404, statusText: 'Not Found' }));
    const cap = captureConsole();
    try {
      const r = new ProgressReporter('http://backend/jobs/j1/progress', 'j1');
      for (let i = 0; i < 20; i++) {
        await r.reportForce('mapping', 'Mapping', i, 33, 'en cours');
      }
    } finally {
      cap.restore();
    }

    const auth404 = cap.lines.filter((l) => l.includes('404') && /progress/i.test(l));
    expect(auth404.length).toBe(1);
  });

  it('une erreur RÉSEAU (fetch qui rejette) est journalisée et ne fait pas planter le pipeline', async () => {
    stubFetch(async () => { throw new Error('ECONNREFUSED'); });
    const cap = captureConsole();
    try {
      const r = new ProgressReporter('http://backend/jobs/j1/progress', 'j1');
      await expect(
        r.reportForce('phase_3_ir', 'Analyse IR', 5, 33, 'en cours'),
      ).resolves.toBeUndefined(); // ne rejette JAMAIS : la progression n'est pas critique
      expect(cap.lines.join('\n')).toContain('ECONNREFUSED');
    } finally {
      cap.restore();
    }
  });

  it('une livraison réussie (200) ne produit aucun log d\'échec', async () => {
    const calls: unknown[] = [];
    stubFetch(async (...a: never[]) => { calls.push(a); return { ok: true, status: 200 }; });
    const cap = captureConsole();
    try {
      const r = new ProgressReporter('http://backend/jobs/j1/progress', 'j1');
      await r.reportForce('phase_3_ir', 'Analyse IR', 5, 33, 'en cours');
    } finally {
      cap.restore();
    }

    expect(calls).toHaveLength(1);
    expect(cap.lines.join('\n')).not.toMatch(/\[ProgressReporter\].*(404|401|403|ECONN)/);
  });

  it('après un échec puis un succès, la récupération est signalée une fois', async () => {
    let failing = true;
    stubFetch(async () => {
      if (failing) return { ok: false, status: 500, statusText: 'Internal Server Error' };
      return { ok: true, status: 200 };
    });

    const cap = captureConsole();
    try {
      const r = new ProgressReporter('http://backend/jobs/j1/progress', 'j1');
      await r.reportForce('phase_3_ir', 'Analyse IR', 5, 33, 'en cours');
      failing = false;
      await r.reportForce('phase_3_ir', 'Analyse IR', 6, 33, 'en cours');
    } finally {
      cap.restore();
    }

    expect(cap.lines.some((l) => /recover|rétabli|reprise/i.test(l))).toBe(true);
  });
});
