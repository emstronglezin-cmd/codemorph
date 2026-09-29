// ============================================================
// CodeMorph — PHASE 36 TESTS
//
// TEST 1  Petit projet  → décision legacy préservée + conversion complète
// TEST 2  Projet moyen  → conversion complète
// TEST 3  Gros projet (~195K chars) → conversion complète sans requête géante
// TEST 4  Simulation HTTP 429 → backoff → retry contrôlé → pas de boucle infinie
// TEST 5  Même module deux fois → 2e appel = cache hit
// TEST 6  Deux modules dépendants → contexte transmis
// TEST 7  Erreur définitive → NonRetryableError → aucun retry
// TEST 8  Conversion interrompue → reprise des chunks terminés
// ============================================================
import { rmSync } from 'fs';
import {
  FakeAI, buildAst, buildArch, buildSourceCode, freshDirs, makeCtx, makeFile,
} from './fixtures';
import type { ASTFile } from '../../src/core/ast-analyzer';

// ── Helpers d'environnement ───────────────────────────────────────────────────
function setTestEnv(dirs: { cacheDir: string; stateDir: string }): void {
  process.env['PHASE36_ENABLED'] = 'true';
  process.env['PHASE36_THRESHOLD_CHARS'] = '60000';
  process.env['PHASE36_THRESHOLD_FILES'] = '25';
  process.env['AI_MAX_INPUT_TOKENS'] = '4000';
  process.env['AI_MAX_OUTPUT_TOKENS'] = '2800';
  process.env['AI_MAX_CONCURRENT_REQUESTS'] = '1';
  process.env['AI_CHUNK_SIZE_TOKENS'] = '2200';
  process.env['AI_RETRY_DELAY_MS'] = '10';
  process.env['AI_RETRY_MAX_ATTEMPTS'] = '4';
  process.env['AI_RETRY_MAX_DELAY_MS'] = '200';
  process.env['AI_CACHE_ENABLED'] = 'true';
  process.env['AI_CACHE_DIR'] = dirs.cacheDir;
  process.env['AI_STATE_DIR'] = dirs.stateDir;
  process.env['AI_RATE_LIMIT_TPM'] = '1000000'; // pas de pacing en test
  process.env['AI_MIN_INTERVAL_MS'] = '0';
  delete process.env['GROQ_API_KEY'];
  delete process.env['OPENAI_API_KEY'];
  // Reset du cache de config pour relire l'env
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { resetPhase36Config } = require('../../src/core/phase36/config');
  resetPhase36Config();
}

// ── Générateurs de projets de test ────────────────────────────────────────────
function screenContent(name: string, target = 3200, extraImports: string[] = []): string {
  const lines = [
    `import 'package:flutter/material.dart';`,
    `import 'package:flutter_riverpod/flutter_riverpod.dart';`,
    ...extraImports,
    ``,
    `class ${name} extends ConsumerStatefulWidget {`,
    `  const ${name}({super.key});`,
    `  @override`,
    `  ConsumerState<${name}> createState() => _${name}State();`,
    `}`,
    ``,
    `class _${name}State extends ConsumerState<${name}> {`,
  ];
  let i = 0;
  while (lines.join('\n').length < target) {
    lines.push(`  final _field${i} = 'value${i}'; // padding field number ${i} for size`);
    i++;
  }
  lines.push(
    `  @override`,
    `  Widget build(BuildContext context) {`,
    `    return Scaffold(appBar: AppBar(title: Text('${name}')), body: const SizedBox());`,
    `  }`,
    `}`,
  );
  return lines.join('\n');
}

function modelContent(name: string): string {
  return [
    `class ${name} {`,
    `  final String id;`,
    `  final String name;`,
    `  ${name}({required this.id, required this.name});`,
    `  factory ${name}.fromJson(Map<String, dynamic> json) => ${name}(id: json['id'], name: json['name']);`,
    `}`,
  ].join('\n');
}

function serviceContent(name: string): string {
  return [
    `import 'dart:convert';`,
    `import 'package:http/http.dart' as http;`,
    ``,
    `class ${name} {`,
    `  Future<String> login(String credentials) async {`,
    `    final res = await http.post(Uri.parse('API_BASE_URL' + '/auth/login'), body: credentials);`,
    `    return jsonDecode(res.body)['token'] as String;`,
    `  }`,
    `}`,
  ].join('\n');
}

function buildProject(fileCount: number): ASTFile[] {
  // Pré-calculer les chemins pour que les écrans importent de VRAIS fichiers
  const pathFor = (i: number): string => {
    const kind = i % 4;
    if (kind === 0) return `lib/features/home/screen_${i}.dart`;
    if (kind === 1) return `lib/models/item_model_${i}.dart`;
    if (kind === 2) return `lib/services/api_service_${i}.dart`;
    return `lib/widgets/card_widget_${i}.dart`;
  };
  const files: ASTFile[] = [];
  for (let i = 0; i < fileCount; i++) {
    const kind = i % 4;
    if (kind === 0) {
      // L'écran i importe le modèle (i+1) et le service (i+2) du même cycle
      const modelImp = `import 'package:demo/${pathFor(i + 1).replace(/^lib\//, '')}';`;
      const serviceImp = `import 'package:demo/${pathFor(i + 2).replace(/^lib\//, '')}';`;
      files.push(makeFile(pathFor(i), screenContent(`Screen${i}`, 7000, [modelImp, serviceImp])));
    }
    else if (kind === 1) files.push(makeFile(pathFor(i), modelContent(`ItemModel${i}`)));
    else if (kind === 2) files.push(makeFile(pathFor(i), serviceContent(`ApiService${i}`)));
    else files.push(makeFile(pathFor(i), screenContent(`CardWidget${i}`, 5000)));
  }
  return files;
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST 1 — Petit projet : décision legacy + conversion complète
// ══════════════════════════════════════════════════════════════════════════════
describe('TEST 1 — petit projet', () => {
  const dirs = freshDirs();
  beforeAll(() => setTestEnv(dirs));
  afterAll(() => rmSync(dirs.cacheDir, { recursive: true, force: true }));

  it('décision : un petit projet reste sur le pipeline legacy (0 régression)', async () => {
    const { shouldUseSemanticPipeline } = await import('../../src/core/phase36/project-manifest');
    const decision = shouldUseSemanticPipeline(30_000, 12, 'free-groq');
    expect(decision.use).toBe(false);
  });

  it('conversion complète du pipeline réel (tier static, offline) sur un petit projet', async () => {
    const { ConversionPipeline } = await import('../../src/core/pipeline');
    const files = buildProject(8);
    const ctx = makeCtx('small-project', buildSourceCode(files));
    const pipeline = new ConversionPipeline();
    const result = await pipeline.run(ctx);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.ir).toBeDefined();
    expect(result.phase36Report).toBeUndefined(); // petit projet → pas de pipeline sémantique
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TEST 2 — Projet moyen : conversion complète
// ══════════════════════════════════════════════════════════════════════════════
describe('TEST 2 — projet moyen', () => {
  const dirs = freshDirs();
  beforeAll(() => setTestEnv(dirs));
  afterAll(() => rmSync(dirs.cacheDir, { recursive: true, force: true }));

  it('conversion complète via le pipeline réel (tier static, offline)', async () => {
    const { ConversionPipeline } = await import('../../src/core/pipeline');
    const files = buildProject(20); // ~20 fichiers ≈ 45K chars → sous le seuil
    const ctx = makeCtx('medium-project', buildSourceCode(files));
    const pipeline = new ConversionPipeline();
    const result = await pipeline.run(ctx);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.phase36Report).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TEST 3 — Gros projet (~195K chars) : pipeline sémantique, AUCUNE requête géante
// ══════════════════════════════════════════════════════════════════════════════
describe('TEST 3 — gros projet (~195K chars)', () => {
  const dirs = freshDirs();
  beforeAll(() => setTestEnv(dirs));
  afterAll(() => rmSync(dirs.cacheDir, { recursive: true, force: true }));

  it('conversion complète par analyse sémantique — chaque requête ≤ budget', async () => {
    const { runSemanticPipeline, shouldUseSemanticPipeline } = await import('../../src/core/phase36/semantic-pipeline');
    const { estimateTokens } = await import('../../src/core/phase36/config');

    const files = buildProject(60); // 15 écrans×7K + 15 widgets×5K + models/services ≈ 195K chars
    const sourceCode = buildSourceCode(files);
    expect(sourceCode.length).toBeGreaterThan(150_000);

    const decision = shouldUseSemanticPipeline(sourceCode.length, files.length, 'free-groq');
    expect(decision.use).toBe(true);

    const ctx = makeCtx('big-project', sourceCode);
    const fake = new FakeAI();
    const progressUpdates: Array<[number, number]> = [];
    const result = await runSemanticPipeline(
      ctx, buildAst(files), buildArch(files), fake,
      { onProgress: (done, total) => progressUpdates.push([done, total]) },
    );

    // ── Chunks et requêtes ──
    expect(result.chunkCount).toBeGreaterThan(5);
    expect(fake.callCount).toBe(result.chunkCount);

    // ── AUCUNE requête géante : chaque prompt ≤ AI_MAX_INPUT_TOKENS (4000) ──
    const { getPhase36Config } = await import('../../src/core/phase36/config');
    const budget = getPhase36Config().maxInputTokens;
    for (const call of fake.calls) {
      const prompt = call.messages.map((m) => m.content).join('\n');
      const tokens = estimateTokens(prompt);
      expect(tokens).toBeLessThanOrEqual(budget);
    }

    // ── Couverture : 100% des fichiers sources présents dans les chunks ──
    const ir = result.ir;
    expect(ir).toBeDefined();
    expect(ir.projectMeta.sourceFiles).toBe(files.length);

    // ── Qualité : écrans extraits + relations inter-modules conservées ──
    const expectedScreens = files.filter((f) => /screen/.test(f.path)).length;
    expect(ir.uiGraph.screens.length).toBe(expectedScreens);
    expect(ir.uiGraph.screens.length).toBeGreaterThan(10);

    // Relations Global IR : chaque écran référence AuthService (calls-service)
    const serviceEdges = (ir.knowledgeGraph?.edges ?? []).filter((e) => e.relation === 'calls-service');
    expect(serviceEdges.length).toBeGreaterThan(0);

    // Global IR conserve models/services extraits
    expect(ir.dataLayer.models.length).toBeGreaterThan(0);
    expect(ir.backendGraph.services.length).toBeGreaterThan(0);

    // Progression rapportée
    expect(progressUpdates.length).toBeGreaterThan(0);
    expect(progressUpdates[progressUpdates.length - 1]?.[0]).toBe(result.chunkCount);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TEST 4 — Simulation HTTP 429 : backoff, retry contrôlé, pas de boucle infinie
// ══════════════════════════════════════════════════════════════════════════════
describe('TEST 4 — gestion des 429', () => {
  const dirs = freshDirs();
  beforeAll(() => setTestEnv(dirs));
  afterAll(() => rmSync(dirs.cacheDir, { recursive: true, force: true }));

  it('un 429 avec Retry-After est absorbé par backoff puis réussit', async () => {
    const { analyzeChunk } = await import('../../src/core/phase36/module-ir');
    const { buildProjectManifest } = await import('../../src/core/phase36/project-manifest');
    const { buildSemanticChunks, hydrateChunks } = await import('../../src/core/phase36/semantic-chunker');
    const { extractFileContents } = await import('../../src/core/phase36/semantic-pipeline');

    const files = buildProject(8);
    const manifest = buildProjectManifest('p429', 'Flutter', 'React Native', buildAst(files), buildArch(files));
    const chunks = hydrateChunks(buildSemanticChunks(manifest).chunks, extractFileContents(buildSourceCode(files)));
    expect(chunks.length).toBeGreaterThan(0);

    const fake = new FakeAI();
    const error429 = new Error('429 Too Many Requests. Please try again in 0.05s');
    fake.enqueue(error429, error429); // 2 × 429 puis réponse par défaut
    const logs: string[] = [];

    const ir = await analyzeChunk(chunks[0]!, manifest, { ai: fake, model: fake.getModel(), manifest, analyzed: new Map(), log: (l) => logs.push(l) });
    expect(ir).toBeDefined();
    expect(fake.callCount).toBe(3); // 1 initiale + 2 retries

    const retryLog = logs.find((l) => l.includes('[AI-RETRY]') && l.includes('reason=429'));
    expect(retryLog).toBeDefined();
    expect(retryLog).toContain('attempt=1/4');
  });

  it('429 permanents → abandon APRÈS max attempts (aucune boucle infinie)', async () => {
    const { analyzeChunk } = await import('../../src/core/phase36/module-ir');
    const { buildProjectManifest } = await import('../../src/core/phase36/project-manifest');
    const { buildSemanticChunks, hydrateChunks } = await import('../../src/core/phase36/semantic-chunker');
    const { extractFileContents } = await import('../../src/core/phase36/semantic-pipeline');
    const { NonRetryableAIError } = await import('../../src/core/phase36/resilience');

    const files = buildProject(8);
    const manifest = buildProjectManifest('p429b', 'Flutter', 'React Native', buildAst(files), buildArch(files));
    const chunks = hydrateChunks(buildSemanticChunks(manifest).chunks, extractFileContents(buildSourceCode(files)));

    const fake = new FakeAI();
    fake.onChat = () => { throw new Error('429 rate limit exceeded'); };

    await expect(
      analyzeChunk(chunks[0]!, manifest, { ai: fake, model: fake.getModel(), manifest, analyzed: new Map(), log: () => {} }),
    ).rejects.toThrow(NonRetryableAIError);

    expect(fake.callCount).toBe(4); // AI_RETRY_MAX_ATTEMPTS=4, jamais plus
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TEST 5 — Cache : même module deux fois → 2e appel = CACHE HIT
// ══════════════════════════════════════════════════════════════════════════════
describe('TEST 5 — cache module', () => {
  const dirs = freshDirs();
  beforeAll(() => setTestEnv(dirs));
  afterAll(() => rmSync(dirs.cacheDir, { recursive: true, force: true }));

  it('deuxième conversion identique : 0 appel IA, cacheHits = chunkCount', async () => {
    const { runSemanticPipeline } = await import('../../src/core/phase36/semantic-pipeline');
    const files = buildProject(12);
    const sourceCode = buildSourceCode(files);
    const ctx = makeCtx('cache-project', sourceCode);

    // RUN 1 — cache miss → appels IA
    const fake1 = new FakeAI();
    const result1 = await runSemanticPipeline(ctx, buildAst(files), buildArch(files), fake1);
    expect(fake1.callCount).toBe(result1.chunkCount);
    expect(result1.cacheHits).toBe(0);

    // RUN 2 — contenu identique → CACHE HIT partout
    const fake2 = new FakeAI();
    const result2 = await runSemanticPipeline(ctx, buildAst(files), buildArch(files), fake2);
    expect(fake2.callCount).toBe(0);
    expect(result2.cacheHits).toBe(result2.chunkCount);

    // Les résultats sont identiques (même IR sémantique)
    expect(result2.ir.uiGraph.screens.length).toBe(result1.ir.uiGraph.screens.length);
    expect(result2.ir.dataLayer.models.length).toBe(result1.ir.dataLayer.models.length);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TEST 6 — Modules dépendants : contexte transmis
// ══════════════════════════════════════════════════════════════════════════════
describe('TEST 6 — dépendances inter-modules', () => {
  const dirs = freshDirs();
  beforeAll(() => setTestEnv(dirs));
  afterAll(() => rmSync(dirs.cacheDir, { recursive: true, force: true }));

  it('le prompt du chunk dépendant contient les signatures du module dépendu', async () => {
    const { runSemanticPipeline } = await import('../../src/core/phase36/semantic-pipeline');
    const { buildProjectManifest } = await import('../../src/core/phase36/project-manifest');
    const { buildSemanticChunks, hydrateChunks } = await import('../../src/core/phase36/semantic-chunker');
    const { extractFileContents } = await import('../../src/core/phase36/semantic-pipeline');

    const files = buildProject(8); // screens importent auth_service + user model
    const sourceCode = buildSourceCode(files);
    const manifest = buildProjectManifest('deps-project', 'Flutter', 'React Native', buildAst(files), buildArch(files));

    // Le manifest résout les relations import → fichier
    expect(manifest.relations.length).toBeGreaterThan(0);

    const chunks = hydrateChunks(buildSemanticChunks(manifest).chunks, extractFileContents(sourceCode));
    const screenChunk = chunks.find((c) => c.role === 'screen' && c.externalDeps.length > 0);
    expect(screenChunk).toBeDefined();
    expect(screenChunk!.externalDeps.length).toBeGreaterThan(0);

    // Exécution complète — vérifier le prompt du chunk dépendant
    const fake = new FakeAI();
    const ctx = makeCtx('deps-project', sourceCode);
    await runSemanticPipeline(ctx, buildAst(files), buildArch(files), fake);

    const depCall = fake.calls.find((call) =>
      call.messages.some((m) =>
        m.content.includes(`MODULE TO ANALYZE: "${screenChunk!.moduleId}"`) &&
        m.content.includes(screenChunk!.externalDeps[0]!),
      ),
    );
    expect(depCall).toBeDefined();

    const depPrompt = depCall!.messages.map((m) => m.content).join('\n');
    // Contexte global présent
    expect(depPrompt).toContain('GLOBAL PROJECT CONTEXT');
    // Signatures de dépendances présentes (exports/classes du module dépendu)
    expect(depPrompt).toContain('DEPENDENCY SIGNATURES');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TEST 7 — Erreur définitive : NonRetryableError, AUCUN retry
// ══════════════════════════════════════════════════════════════════════════════
describe('TEST 7 — erreur définitive', () => {
  const dirs = freshDirs();
  beforeAll(() => setTestEnv(dirs));
  afterAll(() => rmSync(dirs.cacheDir, { recursive: true, force: true }));

  it('401 → NonRetryableAIError immédiate, exactement 1 appel', async () => {
    const { analyzeChunk } = await import('../../src/core/phase36/module-ir');
    const { buildProjectManifest } = await import('../../src/core/phase36/project-manifest');
    const { buildSemanticChunks, hydrateChunks } = await import('../../src/core/phase36/semantic-chunker');
    const { extractFileContents } = await import('../../src/core/phase36/semantic-pipeline');
    const { NonRetryableAIError } = await import('../../src/core/phase36/resilience');

    const files = buildProject(8);
    const manifest = buildProjectManifest('p401', 'Flutter', 'React Native', buildAst(files), buildArch(files));
    const chunks = hydrateChunks(buildSemanticChunks(manifest).chunks, extractFileContents(buildSourceCode(files)));

    const fake = new FakeAI();
    fake.onChat = () => { throw new Error('401 Unauthorized: invalid api key'); };

    await expect(
      analyzeChunk(chunks[0]!, manifest, { ai: fake, model: fake.getModel(), manifest, analyzed: new Map(), log: () => {} }),
    ).rejects.toThrow(NonRetryableAIError);

    expect(fake.callCount).toBe(1); // AUCUN retry inutile
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TEST 8 — Conversion interrompue → reprise des chunks terminés
// ══════════════════════════════════════════════════════════════════════════════
describe('TEST 8 — reprise (resume)', () => {
  const dirs = freshDirs();
  beforeAll(() => setTestEnv(dirs));
  afterAll(() => {
    rmSync(dirs.cacheDir, { recursive: true, force: true });
    rmSync(dirs.stateDir, { recursive: true, force: true });
  });

  it('échec au chunk N → re-run : chunks 1..N-1 NOT re-analysés, reprise au N', async () => {
    const { runSemanticPipeline } = await import('../../src/core/phase36/semantic-pipeline');
    const files = buildProject(12);
    const sourceCode = buildSourceCode(files);
    const ctx = makeCtx('resume-project', sourceCode);
    const ast = buildAst(files);
    const arch = buildArch(files);

    // ── RUN 1 : échec définitif sur un chunk du milieu ──
    const fakeFail = new FakeAI();
    fakeFail.onChat = (call) => {
      const prompt = call.messages.map((m) => m.content).join('\n');
      // Faire échouer DÉFINITIVEMENT le chunk qui contient item_model_4
      if (prompt.includes('SOURCE FILE: lib/services/api_service_6.dart')) {
        throw new Error('401 Unauthorized: invalid api key');
      }
      return FakeAI.defaultResponse(prompt);
    };
    await expect(runSemanticPipeline(ctx, ast, arch, fakeFail)).rejects.toThrow(/failed after retries|PHASE36/);
    const failedRunCalls = fakeFail.callCount;
    expect(failedRunCalls).toBeGreaterThan(0);

    // ── RUN 2 : provider sain → reprise SANS tout recommencer ──
    const fakeOk = new FakeAI();
    const result2 = await runSemanticPipeline(ctx, ast, arch, fakeOk);

    expect(result2.resumedChunks).toBeGreaterThan(0);
    // Le nombre d'appels du run 2 est strictement inférieur au nombre total de chunks
    // (les chunks déjà complétés au run 1 ne sont PAS re-analysés)
    expect(fakeOk.callCount).toBeLessThan(result2.chunkCount);
    // Tous les chunks sont maintenant analysés (via resume + run 2)
    expect(fakeOk.callCount + result2.resumedChunks).toBe(result2.chunkCount);
    // La conversion est complète
    expect(result2.ir.uiGraph.screens.length).toBeGreaterThan(0);
    expect(result2.ir.dataLayer.models.length).toBeGreaterThan(0);
    // L'écran du chunk qui avait échoué est maintenant extrait (modèle 4 → écran 4 présent)
    expect(result2.ir.uiGraph.screens.length).toBe(files.filter((f) => /screen/.test(f.path)).length);
  });
});
