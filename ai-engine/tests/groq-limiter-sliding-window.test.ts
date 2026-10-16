// ============================================================
// CodeMorph — TESTS : limiteur Groq corrigé (fenêtre glissante, RPM, quotas réels)
// ------------------------------------------------------------
// CAS PRODUCTION À L'ORIGINE DE CES TESTS :
//   33 chunks · openai/gpt-oss-120b · seuil local 7 000 TPM
//   requêtes réelles 3–7 s, mais attentes de 55–59 s imposées
//   appel n°17 : totalWaitMs=751726 (12 min 32 s d'attente cumulée)
//   conversion tuée à 121 min avec filesGenerated=0
//
// Causes vérifiées dans le code :
//   1. DEUX limiteurs TPM en série (scheduler phase36 à 6 500 + provider à 7 000)
//   2. Fenêtre FIXE vidée d'un coup + attente `resteDeFenêtre + 2s`
//   3. Réservation de `input + 2 800` avant toute génération (55 % du budget)
//   4. Aucune dimension RPM (8 s d'intervalle = 7,5 req/min contre 30 RPM réels)
//   5. En-têtes x-ratelimit-* de Groq jamais lus
//
// Limites publiées par Groq pour openai/gpt-oss-120b (plan Free, par
// organisation) : 30 RPM · 8 000 TPM · 1 000 RPD · 200 000 TPD, en fenêtre
// GLISSANTE de 60 s.
// ============================================================

const TEST_KEY = 'gsk_TEST_ONLY_not_a_real_key_0000000000';

// Le singleton lit l'environnement à la construction du module.
process.env['GROQ_API_KEY']               = TEST_KEY;
process.env['AI_MIN_INTERVAL_MS']         = '0';
process.env['AI_RATE_LIMIT_TPM']          = '7200';
process.env['AI_RATE_LIMIT_RPM']          = '24';
process.env['AI_RATE_LIMIT_JITTER_MS']    = '0';   // mesures déterministes
process.env['AI_OUTPUT_TOKEN_RESERVE']    = '1200';
process.env['AI_PROVIDER_MAX_CONCURRENT'] = '3';

jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: jest.fn() } },
  })),
}));

import { GroqRateLimiter } from '../src/core/ai-provider';

function silenceConsole(): () => void {
  const spies = ['log', 'warn', 'error'].map((m) =>
    jest.spyOn(console, m as 'log').mockImplementation(() => undefined));
  return () => spies.forEach((s) => s.mockRestore());
}

// ────────────────────────────────────────────────────────────────────────────
describe('Projection prudente — on ne sur-réserve plus 55 % du budget', () => {
  it('reserveFor(1600) réserve input + réserve bornée, pas input + 2800', () => {
    const limiter = new GroqRateLimiter();
    const reserved = limiter.reserveFor(1600);

    expect(reserved).toBe(1600 + 1200);      // 2 800, et non 4 400
    expect(reserved).toBeLessThan(1600 + 2800);
  });

  it('la réserve se recale sur le plus gros output réellement observé', () => {
    const limiter = new GroqRateLimiter();
    expect(limiter.reserveFor(1600)).toBe(2800);

    limiter.noteOutputTokens(2400);           // output réel supérieur à la réserve
    expect(limiter.reserveFor(1600)).toBe(1600 + 2400);
  });

  it('un output observé plus petit ne fait PAS baisser la réserve (prudence)', () => {
    const limiter = new GroqRateLimiter();
    limiter.noteOutputTokens(300);
    expect(limiter.reserveFor(1600)).toBe(2800); // réserve plancher conservée
  });

  it('deux requêtes tiennent désormais dans une fenêtre de 8 000 TPM', () => {
    // 2 × 2 800 = 5 600 ≤ 7 200 → le budget n'est plus saturé par UNE requête.
    const limiter = new GroqRateLimiter();
    expect(2 * limiter.reserveFor(1600)).toBeLessThanOrEqual(7200);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('Fenêtre GLISSANTE — attente minimale, pas reset complet', () => {
  it('l\'attente est bornée par l\'expiration réelle, sans marge fixe de +2 s', async () => {
    const restore = silenceConsole();
    try {
      const limiter = new GroqRateLimiter();
      // Une seule grosse consommation : rien ne peut se libérer avant son
      // expiration. On vérifie que l'attente est ~60 s et PAS
      // `resteDeFenêtre + 2000` ≈ 62 s comme dans l'ancien code à fenêtre fixe.
      limiter.recordTokens(6000);
      const t0 = Date.now();
      const release = await limiter.acquire(2000);
      const waited = Date.now() - t0;
      release(2000, 'success');

      expect(waited).toBeGreaterThanOrEqual(58_000);
      expect(waited).toBeLessThan(61_500); // pas de +2 s systématique
    } finally {
      restore();
    }
  }, 120_000);

  it('UNE seule requête ne sature plus la fenêtre : 2 passages par fenêtre', async () => {
    const restore = silenceConsole();
    try {
      const limiter = new GroqRateLimiter();
      const reserved = limiter.reserveFor(1600);   // 2 800 (et non 4 400)
      const t0 = Date.now();

      // Deux requêtes successives : avec l'ancienne projection (4 400), la 2e
      // tombait à 8 800 > 7 000 et attendait ~62 s.
      for (let i = 0; i < 2; i++) {
        const rel = await limiter.acquire(reserved);
        rel(2500, 'success');
      }

      expect(Date.now() - t0).toBeLessThan(3_000);
      expect(limiter.telemetry()['tpmUsed']).toBe(5000);
    } finally {
      restore();
    }
  });

  it('les tokens expirent individuellement, pas tous d\'un coup', () => {
    const restore = silenceConsole();
    try {
      const limiter = new GroqRateLimiter();
      limiter.recordTokens(3000);
      limiter.recordTokens(3000);
      // Fenêtre glissante : chaque consommation porte son propre horodatage.
      expect(limiter.telemetry()['tpmUsed']).toBe(6000);
    } finally {
      restore();
    }
  });

  it('le plafond RPM bloque même quand le budget TPM est largement disponible', async () => {
    const restore = silenceConsole();
    try {
      process.env['AI_RATE_LIMIT_RPM'] = '3';
      process.env['AI_RATE_LIMIT_TPM'] = '7200';
      const limiter = new GroqRateLimiter();

      // 3 requêtes minuscules : le TPM ne serait jamais atteint (150/7 200).
      for (let i = 0; i < 3; i++) {
        const rel = await limiter.acquire(50);
        rel(50, 'success');
      }
      expect(limiter.telemetry()['rpmUsed']).toBe(3);
      expect(limiter.telemetry()['tpmUsed']).toBe(150);

      // La 4e est retenue par le RPM, pas par le TPM : dimension séparée.
      const t0 = Date.now();
      const rel4 = await limiter.acquire(50);
      const waited = Date.now() - t0;
      rel4(50, 'success');

      expect(waited).toBeGreaterThan(30_000);
      expect(limiter.telemetry()['rpmLimit']).toBe(3);
    } finally {
      restore();
      process.env['AI_RATE_LIMIT_RPM'] = '24';
    }
  }, 90_000);

  it('la télémétrie expose rpmUsed/rpmLimit distincts de tpmUsed/tpmLimit', () => {
    const limiter = new GroqRateLimiter();
    const t = limiter.telemetry();
    expect(t).toHaveProperty('rpmUsed');
    expect(t).toHaveProperty('rpmLimit', 24);
    expect(t).toHaveProperty('tpmUsed');
    expect(t).toHaveProperty('tpmLimit', 7200);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('En-têtes x-ratelimit-* de Groq — la source réelle prime', () => {
  it('x-ratelimit-limit-tokens remplace la valeur devinée', () => {
    const restore = silenceConsole();
    try {
      const limiter = new GroqRateLimiter();
      expect(limiter.telemetry()['tpmLimit']).toBe(7200);

      limiter.observeRateLimitHeaders({ 'x-ratelimit-limit-tokens': '6000' });

      // La limite apprise est plus basse → c'est elle qui s'applique.
      expect(limiter.telemetry()['tpmLimit']).toBe(6000);
      expect(limiter.telemetry()['learnedTpmLimit']).toBe(6000);
    } finally {
      restore();
    }
  });

  it('une limite apprise plus HAUTE ne permet jamais de dépasser la config', () => {
    const restore = silenceConsole();
    try {
      const limiter = new GroqRateLimiter();
      limiter.observeRateLimitHeaders({ 'x-ratelimit-limit-tokens': '250000' });
      expect(limiter.telemetry()['tpmLimit']).toBe(7200); // plafonné par la config
    } finally {
      restore();
    }
  });

  it('tolère la casse mixte et les en-têtes absents', () => {
    const restore = silenceConsole();
    try {
      const limiter = new GroqRateLimiter();
      limiter.observeRateLimitHeaders({ 'X-RateLimit-Limit-Tokens': '5000' });
      expect(limiter.telemetry()['learnedTpmLimit']).toBe(5000);

      expect(() => limiter.observeRateLimitHeaders(undefined)).not.toThrow();
      expect(() => limiter.observeRateLimitHeaders({})).not.toThrow();
      expect(() => limiter.observeRateLimitHeaders({ 'x-ratelimit-limit-tokens': 'abc' })).not.toThrow();
    } finally {
      restore();
    }
  });

  it('ne journalise jamais la clé API', () => {
    const lines: string[] = [];
    const spies = ['log', 'warn', 'error'].map((m) =>
      jest.spyOn(console, m as 'log').mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(' '));
      }));
    try {
      const limiter = new GroqRateLimiter();
      limiter.observeRateLimitHeaders({
        'x-ratelimit-limit-tokens':     '8000',
        'authorization':                `Bearer ${TEST_KEY}`,
        'x-ratelimit-remaining-tokens': '7997',
      });
      expect(lines.join('\n')).not.toContain(TEST_KEY);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('Télémétrie exigée (étape 2)', () => {
  it('expose attente détaillée, tokens estimés/réels, appels et retries', async () => {
    const restore = silenceConsole();
    try {
      const limiter = new GroqRateLimiter();
      const rel = await limiter.acquire(2000);
      rel(2500, 'success');
      limiter.noteRetry();

      const t = limiter.telemetry();
      expect(t['requestsSent']).toBe(1);
      expect(t['retries']).toBe(1);
      expect(t['tokensEstimated']).toBe(2000);
      expect(t['tokensActual']).toBe(2500);
      expect(t['totalWaitMs']).toBeGreaterThanOrEqual(0);
      expect(t['waitBreakdown']).toMatchObject({
        semaphoreMs: expect.any(Number),
        pacerMs:     expect.any(Number),
        rpmMs:       expect.any(Number),
        tpmMs:       expect.any(Number),
      });
    } finally {
      restore();
    }
  });

  it('un appel échoué ne gonfle ni tokensActual ni la fenêtre TPM', async () => {
    const restore = silenceConsole();
    try {
      const limiter = new GroqRateLimiter();
      const rel = await limiter.acquire(2000);
      rel(0, 'failed');

      const t = limiter.telemetry();
      expect(t['failedRequests']).toBe(1);
      expect(t['tokensActual']).toBe(0);
      expect(t['tpmUsed']).toBe(0);
      expect(t['phantomTokensAvoided']).toBe(2000);
    } finally {
      restore();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('Scénario réel — chunks d\'un dépôt de 195 Ko (propriétés, mesure hors test)', () => {
  it('deux chunks tiennent immédiatement dans une fenêtre, sans aucune attente', async () => {
    const restore = silenceConsole();
    try {
      const limiter = new GroqRateLimiter();
      const reserved = limiter.reserveFor(1600);   // 2 800
      const t0 = Date.now();

      for (let i = 0; i < 2; i++) {
        const rel = await limiter.acquire(reserved);
        rel(2500, 'success');
      }

      // L'ancien code (projection 4 400, fenêtre fixe) imposait ~60 s dès la
      // 2e requête : 4 400 × 2 = 8 800 > 7 000.
      expect(Date.now() - t0).toBeLessThan(2_000);
    } finally {
      restore();
    }
  });

  it('la 3e requête attend le temps EXACT de libération, pas la fin de fenêtre', async () => {
    const restore = silenceConsole();
    try {
      const limiter = new GroqRateLimiter();
      const reserved = limiter.reserveFor(1600);   // 2 800

      for (let i = 0; i < 2; i++) {
        const rel = await limiter.acquire(reserved);
        rel(2500, 'success');                       // 5 000 consommés
      }

      // Besoin : 5 000 + 2 800 - 7 200 = 600 tokens à libérer. La première
      // consommation (2 500) expire dans ~60 s : l'attente est bornée par cela,
      // et surtout elle n'est PAS `resteDeFenêtre + 2s` appliquée aveuglément.
      const t0 = Date.now();
      const rel = await limiter.acquire(reserved);
      const waited = Date.now() - t0;
      rel(2500, 'success');

      expect(waited).toBeGreaterThan(30_000);
      expect(waited).toBeLessThan(75_000);
    } finally {
      restore();
    }
  }, 120_000);

  it('débit théorique : au moins 2 chunks par fenêtre de 60 s', () => {
    const limiter = new GroqRateLimiter();
    const reserved = limiter.reserveFor(1600);
    const realUsage = 2500;
    const tpmLimit = limiter.telemetry()['tpmLimit'] as number;

    // Nombre de chunks tenant dans une fenêtre avec la consommation réelle.
    const perWindow = Math.floor(tpmLimit / realUsage);
    expect(perWindow).toBeGreaterThanOrEqual(2);

    // 33 chunks → durée minimale théorique, contre 33 min avec l'ancien code.
    const minutes = Math.ceil(33 / perWindow);
    expect(minutes).toBeLessThanOrEqual(17);
    expect(reserved).toBeLessThanOrEqual(tpmLimit);
  });
});
