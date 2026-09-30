// ============================================================
// CodeMorph AI Engine — PHASE 36: Semantic Pipeline (orchestrateur)
//
// Pipeline pour les GROS projets sur infrastructure gratuite :
//
//   SOURCE PROJECT
//        ↓
//   GLOBAL PROJECT ANALYSIS  (statique, 0 token IA)
//        ↓
//   PROJECT MANIFEST         (architecture, modules, relations…)
//        ↓
//   SEMANTIC CHUNKS          (groupes sémantiques sous budget tokens)
//        ↓
//   MODULE ANALYSIS          (queue contrôlée, cache, resume, résilience 429)
//        ↓
//   MODULE IRs
//        ↓
//   MERGE / RECONCILIATION   (dédup + fusion — jamais une simple concaténation)
//        ↓
//   GLOBAL IR
//        ↓
//   COHERENCE PASS + REPAIR  (navigation, routes, imports, refs croisées)
//        ↓
//   IRDocument               (compatible avec le pipeline existant
//                             mapping → planning → génération → validation)
// ============================================================

import type {
  ConversionContext, IRDocument, IRKnowledgeEdge, IRKnowledgeGraph, IRKnowledgeNode,
  IRSourceMetrics,
} from '../../models/ir.types';
import type { ASTResult } from '../ast-analyzer';
import type { ArchResult } from '../architecture-detector';
import { createHash } from 'crypto';
import { FRAMEWORK_DEP_MAPS } from '../ir-generator';
import {
  getPhase36Config, estimateTokens, resetPhase36Config,
} from './config';
import { buildProjectManifest, shouldUseSemanticPipeline } from './project-manifest';
import { buildSemanticChunks, hydrateChunks } from './semantic-chunker';
import { renderGlobalContext } from './global-context';
import { ModuleCache, buildModuleCacheKey } from './module-cache';
import { ChunkStateManager } from './chunk-state';
import { runScheduled } from './scheduler';
import { analyzeChunk, mergeModuleIRs, summarizeGlobalIR } from './module-ir';
import { runCoherencePass } from './coherence';
import type {
  CoherenceReport, GlobalIR, MergeReport, ModuleIR, ProjectManifest, SemanticAIProvider,
} from './types';

export interface SemanticPipelineResult {
  ir: IRDocument;
  tokensUsed: number;
  manifest: ProjectManifest;
  chunkCount: number;
  mergeReport: MergeReport;
  coherenceReport: CoherenceReport;
  resumedChunks: number;
  cacheHits: number;
  cacheMisses: number;
  durationMs: number;
}

export interface SemanticRuntimeOptions {
  userOpenAIKey?:    string;
  userAnthropicKey?: string;
}

// ── Extraction des blocs "// === FILE: path ===" du sourceCode ────────────────
const FILE_PATTERN = /\/\/\s*(?:=+\s*)?FILE:\s*(.+?)(?:\s*=+)?\s*\n([\s\S]*?)(?=\/\/\s*(?:=+\s*)?FILE:|$)/g;

export function extractFileContents(sourceCode: string): Map<string, string> {
  const map = new Map<string, string>();
  let m: RegExpExecArray | null;
  FILE_PATTERN.lastIndex = 0;
  while ((m = FILE_PATTERN.exec(sourceCode)) !== null) {
    const path = (m[1] ?? '').trim();
    const content = (m[2] ?? '').trim();
    if (path && content) map.set(path, content);
  }
  return map;
}

function hashSource(sourceCode: string): string {
  return createHash('sha256').update(sourceCode).digest('hex').slice(0, 24);
}

/** Point d'entrée unique : le pipeline principal demande une IR pour un gros projet. */
export async function runSemanticPipeline(
  ctx: ConversionContext,
  ast: ASTResult,
  arch: ArchResult,
  ai: SemanticAIProvider,
  opts: {
    onProgress?: (done: number, total: number, message: string) => void;
  } = {},
): Promise<SemanticPipelineResult> {
  const cfg = getPhase36Config();
  const t0 = Date.now();
  const log = (line: string): void => console.log(line);
  const model = ai.getModel();

  // ── 1. GLOBAL PROJECT ANALYSIS (statique) ──────────────────────────────────
  const manifest = buildProjectManifest(
    ctx.projectId, ctx.sourceFramework ?? 'unknown', ctx.targetFramework ?? 'unknown', ast, arch,
  );
  log(
    `[PHASE36] project=${manifest.projectId} manifest built — files=${manifest.totalFiles} ` +
    `chars=${manifest.totalChars} modules=${manifest.modules.length} ` +
    `roles=${JSON.stringify(manifest.roleCounts)} relations=${manifest.relations.length}`,
  );

  // ── 2. SEMANTIC CHUNKING ───────────────────────────────────────────────────
  const plan = buildSemanticChunks(manifest);
  const contentByPath = extractFileContents(ctx.sourceCode);
  const chunks = hydrateChunks(plan.chunks, contentByPath);

  // Les fichiers sans marqueur FILE (rares) sont signalés — jamais supprimés
  const missingContent = manifest.files.filter((f) => !contentByPath.has(f.path));
  if (missingContent.length > 0) {
    log(
      `[PHASE36] ⚠️  ${missingContent.length} manifest file(s) have no FILE marker content ` +
      `(empty files or markers missing) — listed, not dropped: ` +
      missingContent.slice(0, 8).map((f) => f.path).join(', '),
    );
  }

  const globalCtxPreview = renderGlobalContext(manifest);
  log(
    `[PHASE36] project=${manifest.projectId} chunked — chunks=${chunks.length} ` +
    `totalSourceTokens≈${Math.ceil((manifest.totalChars / 4) * 1.08)} ` +
    `globalContextTokens≈${estimateTokens(globalCtxPreview)} budget/request=${cfg.maxInputTokens} ` +
    `concurrency=${cfg.maxConcurrentRequests}`,
  );

  const sourceHash = hashSource(ctx.sourceCode);

  // ── 3. RESUME : charger les chunks déjà terminés (plans gratuits) ──────────
  const state = new ChunkStateManager();
  const init = state.initialize({
    projectId: ctx.projectId,
    targetFramework: ctx.targetFramework ?? 'unknown',
    sourceHash,
    chunks,
  });
  if (init.resumed > 0) {
    log(`[AI-RESUME] project=${ctx.projectId} resumedChunks=${init.resumed}/${init.total} (previously completed chunks are NOT re-analyzed)`);
  }

  const cache = new ModuleCache();
  const analyzed = new Map<string, ModuleIR>();
  let cacheHits = 0;

  // Restaurer les chunks done depuis l'état (resume) ou le cache disque
  for (const chunk of chunks) {
    if (state.isDone(chunk.id)) {
      const saved = state.getDoneModuleIR(chunk.id);
      if (saved) {
        analyzed.set(chunk.id, saved);
        cacheHits++;
        continue;
      }
    }
    // Cache disque content-addressed (survit aux redémarrages, même job)
    const key = buildModuleCacheKey({
      chunkContent: Object.entries(chunk.filesContent).map(([p, c]) => `${p}\x00${c}`).join('\x01'),
      files: chunk.files.map((f) => f.path),
      promptVersion: cfg.promptVersion,
      model,
      sourceFramework: ctx.sourceFramework ?? 'unknown',
      targetFramework: ctx.targetFramework ?? 'unknown',
    });
    const cachedIR = cache.get(key);
    if (cachedIR) {
      analyzed.set(chunk.id, cachedIR);
      state.markDone(chunk.id, cachedIR);
      log(`[AI-CACHE] project=${ctx.projectId} chunk=${chunk.id} HIT`);
    }
  }
  cacheHits = [...analyzed.values()].filter((ir) => ir.cacheHit).length;

  // ── 4. MODULE ANALYSIS — queue contrôlée ───────────────────────────────────
  const pending = state.pendingChunks(chunks);
  const total = chunks.length;
  if (pending.length > 0) {
    log(
      `[PHASE36] project=${ctx.projectId} scheduling ${pending.length}/${total} chunks ` +
      `(skipping ${total - pending.length} already done via cache/resume)`,
    );
  }

  let doneCount = total - pending.length;
  const schedule = await runScheduled<ModuleIR>(
    pending.map((chunk) => ({
      id: chunk.id,
      estimatedTokens: estimateTokens(Object.values(chunk.filesContent).join('')) + cfg.globalContextTokens + cfg.depContextTokens,
      run: async (): Promise<ModuleIR> => {
        state.markRunning(chunk.id);
        try {
          const ir = await analyzeChunk(chunk, manifest, {
            ai,
            model,
            manifest,
            analyzed,
            log,
            jobId: ctx.jobId,
          });
          state.markDone(chunk.id, ir);
          const cacheKey = buildModuleCacheKey({
            chunkContent: Object.entries(chunk.filesContent).map(([p, c]) => `${p}\x00${c}`).join('\x01'),
            files: chunk.files.map((f) => f.path),
            promptVersion: cfg.promptVersion,
            model,
            sourceFramework: ctx.sourceFramework ?? 'unknown',
            targetFramework: ctx.targetFramework ?? 'unknown',
          });
          cache.set(cacheKey, ir, { promptVersion: cfg.promptVersion, model });
          return ir;
        } catch (err) {
          state.markFailed(chunk.id, (err as Error).message);
          throw err;
        }
      },
    })),
    {
      concurrency: cfg.maxConcurrentRequests,
      onProgress: (_completed, totalTasks, lastId) => {
        doneCount++;
        opts.onProgress?.(doneCount, total, `Module analysis ${doneCount}/${total} (${lastId})`);
        if (doneCount % 5 === 0 || doneCount === totalTasks) {
          log(`[PHASE36] project=${ctx.projectId} progress=${doneCount}/${total} chunks analyzed`);
        }
      },
    },
  );

  // Collecter les résultats réussis
  for (const [chunkId, ir] of schedule.results.entries()) {
    analyzed.set(chunkId, ir);
  }

  // ── 5. Échec définitif d'un chunk → échec explicite (avec possibilité de resume) ──
  if (schedule.errors.size > 0) {
    const failedChunks = [...schedule.errors.entries()]
      .map(([id, err]) => `${id}: ${(err as Error).message}`)
      .join('; ');
    log(`[PHASE36] project=${ctx.projectId} ❌ ${schedule.errors.size} chunk(s) failed definitively — state saved, conversion can be resumed: ${failedChunks.slice(0, 400)}`);
    throw new Error(
      `[PHASE36] ${schedule.errors.size}/${total} module(s) failed after retries+backoff. ` +
      `Completed chunks are checkpointed — retrying the conversion will resume where it stopped. ` +
      `Failures: ${failedChunks.slice(0, 600)}`,
    );
  }

  const moduleIRs = chunks
    .map((c) => analyzed.get(c.id))
    .filter((ir): ir is ModuleIR => ir !== undefined);

  // ── 6. MERGE / RECONCILIATION → GlobalIR ───────────────────────────────────
  const { globalIR, report: mergeReport } = mergeModuleIRs(moduleIRs, manifest);
  log(
    `[AI-MERGE] project=${ctx.projectId} modules=${moduleIRs.length} ` +
    `duplicatesRemoved=${mergeReport.duplicatesRemoved} conflictsResolved=${mergeReport.conflictsResolved.length} ` +
    `status=${mergeReport.status}`,
  );
  log(`[AI-MERGE] project=${ctx.projectId} ${summarizeGlobalIR(globalIR)}`);

  // ── 7. COHERENCE PASS + REPAIR ─────────────────────────────────────────────
  const coherence = runCoherencePass(globalIR, manifest);
  log(
    `[AI-COHERENCE] project=${ctx.projectId} issues=${coherence.report.issues.length} ` +
    `critical=${coherence.report.criticalCount} warnings=${coherence.report.warningCount} ` +
    `autoFixed=${coherence.report.fixedCount}`,
  );
  for (const issue of coherence.report.issues.slice(0, 10)) {
    log(`[AI-COHERENCE]   [${issue.severity}] ${issue.kind}: ${issue.detail}`);
  }

  // ── 8. IRDocument final (compatible pipeline existant) ─────────────────────
  const ir = buildIRDocument(ctx, ast, arch, manifest, coherence.ir, coherence.report, moduleIRs);

  // Purger l'état si tout est terminé
  state.finalizeIfComplete();

  const tokensUsed = moduleIRs.reduce((a, m) => a + m.tokensUsed, 0);
  const stats = cache.stats();
  log(
    `[PHASE36] project=${ctx.projectId} DONE — chunks=${chunks.length} tokensUsed=${tokensUsed} ` +
    `cacheHits=${cacheHits}/${total} cacheStats(hit=${stats.hits},miss=${stats.misses}) ` +
    `durationMs=${Date.now() - t0}`,
  );

  return {
    ir,
    tokensUsed,
    manifest,
    chunkCount: chunks.length,
    mergeReport: coherence.report.issues.length > 0 && coherence.report.criticalCount > 0
      ? { ...mergeReport, status: 'partial' }
      : mergeReport,
    coherenceReport: coherence.report,
    resumedChunks: init.resumed,
    cacheHits,
    cacheMisses: stats.misses,
    durationMs: Date.now() - t0,
  };
}

// ── Construction de l'IRDocument (même schéma que IRGenerator) ─────────────────
function buildIRDocument(
  ctx: ConversionContext,
  ast: ASTResult,
  arch: ArchResult,
  manifest: ProjectManifest,
  globalIR: GlobalIR,
  coherence: CoherenceReport,
  moduleIRs: ModuleIR[],
): IRDocument {
  const warnings: string[] = coherence.issues
    .filter((i) => i.severity === 'warning')
    .slice(0, 20)
    .map((i) => `[coherence:${i.kind}] ${i.detail}`);
  const blockers = coherence.issues
    .filter((i) => i.severity === 'critical' && !i.autoFixable)
    .slice(0, 10)
    .map((i) => `[coherence:${i.kind}] ${i.detail}`);

  const sourceMetrics: IRSourceMetrics = {
    screensCount:   globalIR.screens.length,
    modelsCount:    globalIR.models.length,
    servicesCount:  globalIR.services.length,
    endpointsCount: globalIR.routes.length,
    storesCount:    globalIR.stateFlow.length,
    assetsCount:    ast.assetFiles?.length ?? 0,
    featuresDetected: [
      ...(ast.statePatterns ?? []),
      ...(ast.externalServices ?? []),
      ...(ast.authPatterns ?? []),
    ],
  };

  const riskLevel = blockers.length > 0 ? 'high' : warnings.length > 3 ? 'medium' : 'low';

  const frameworkMap = FRAMEWORK_DEP_MAPS[`${ctx.sourceFramework}->${ctx.targetFramework}`]
    ?? { keep: [], replace: [], remove: [], add: [] };

  const ir: IRDocument = {
    projectMeta: {
      name: ctx.projectId,
      type: (ctx.sourceFramework ?? '').toLowerCase().includes('flutter') ? 'mobile' : 'backend',
      sourceStack: ctx.sourceFramework ?? 'unknown',
      targetStack: ctx.targetFramework ?? 'unknown',
      complexityScore: Math.min(100, 30 + Math.floor(manifest.totalFiles * 1.2)),
      description: ctx.userGoal ?? `Semantic conversion ${ctx.sourceFramework} → ${ctx.targetFramework} (Phase 36)`,
      version: '1.0.0',
      sourceFiles: manifest.totalFiles,
      totalLines: manifest.totalLines,
      detectedFrameworks: [ctx.sourceFramework ?? 'unknown', ...arch.patterns],
    },
    architecture: {
      modules: arch.modules.map((m) => ({
        name: m.name,
        path: m.path,
        type: m.role as 'feature' | 'shared' | 'core' | 'infra' | 'ui',
        dependencies: [],
        exports: [],
        complexity: Math.floor(m.files.length * 10),
      })),
      layers: arch.layers,
      patterns: arch.patterns,
    },
    uiGraph: {
      screens: globalIR.screens.map((s) => ({
        id: s.id,
        name: s.name,
        path: s.path,
        route: s.route,
        components: s.components,
        guards: [],
        purpose: s.purpose,
        businessLogic: s.businessLogic,
        apiCalls: s.apiCalls,
        states: s.states,
      })),
      components: globalIR.components.map((c) => ({
        id: c.id,
        name: c.name,
        type: 'ui' as const,
        props: c.props.map((p) => ({ name: p.name, type: p.type, required: p.required })),
        children: c.children,
      })),
      navigationFlow: globalIR.navigationFlow.map((n) => ({
        from: n.from,
        to: n.to,
        trigger: n.trigger,
        ...(n.guard ? { guard: n.guard } : {}),
      })),
      stateFlow: globalIR.stateFlow.map((s) => ({
        store: s.store,
        actions: s.actions,
        selectors: [],
      })),
    },
    backendGraph: {
      routes: globalIR.routes.map((r) => ({
        method: r.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        path: r.path,
        handler: r.handler,
        guards: r.guards,
        middlewares: r.middlewares,
      })),
      services: globalIR.services.map((s) => ({
        name: s.name,
        methods: s.methods.map((m) => ({
          name: m.name,
          params: m.params.map((p) => ({ name: p, type: 'unknown' })),
          returnType: m.returnType,
          async: m.async,
        })),
        dependencies: s.dependencies,
      })),
      entities: [],
      middlewares: [],
    },
    dataLayer: {
      models: globalIR.models.map((m) => ({
        name: m.name,
        table: m.table,
        fields: m.fields.map((f) => ({
          name: f.name,
          type: f.type,
          nullable: f.nullable,
          unique: f.unique,
          primary: f.primary,
        })),
        relations: m.relations.map((r) => ({
          type: mapRelationType(r.type),
          target: r.target,
          field: r.field,
        })),
      })),
      relationships: [],
      migrations: [],
    },
    dependencyMap: frameworkMap,
    conversionPlan: buildConversionSteps(manifest, moduleIRs.length),
    validation: {
      buildable: blockers.length === 0,
      testsRequired: true,
      riskLevel,
      warnings,
      blockers,
      coverage: Math.min(100, 60 + manifest.totalFiles * 2),
      sourceMetrics,
    },
    envVars: globalIR.envVars.map((key) => ({
      key,
      description: `Environment variable: ${key}`,
      required: true,
      example: key.toLowerCase().includes('url')
        ? 'https://api.example.com'
        : key.toLowerCase().includes('key') || key.toLowerCase().includes('secret')
          ? 'your-secret-key'
          : 'value',
    })),
    knowledgeGraph: buildKnowledgeGraph(globalIR),
  };

  return ir;
}

function mapRelationType(t: string): 'oneToOne' | 'oneToMany' | 'manyToMany' | 'manyToOne' {
  const normalized = t.toLowerCase().replace(/[^a-z]/g, '');
  if (normalized.includes('manytomany')) return 'manyToMany';
  if (normalized.includes('manytoone') || normalized.includes('belongsto')) return 'manyToOne';
  if (normalized.includes('onetomany') || normalized.includes('hasmany')) return 'oneToMany';
  return 'oneToOne';
}

function buildConversionSteps(manifest: ProjectManifest, chunkCount: number): IRDocument['conversionPlan'] {
  return [
    { step: 1, phase: 'parse',    action: 'Parse source AST',                       target: 'source',            estimatedTime: '5s' },
    { step: 2, phase: 'analyze',  action: 'Build global project manifest',          target: 'manifest',          estimatedTime: '2s' },
    { step: 3, phase: 'analyze',  action: `Semantic chunking (${chunkCount} chunks)`, target: 'chunks',          estimatedTime: '1s', dependencies: [2] },
    { step: 4, phase: 'analyze',  action: 'Per-module IR extraction',               target: 'moduleIRs',         estimatedTime: `${chunkCount * 20}s`, dependencies: [3] },
    { step: 5, phase: 'map',      action: 'Merge + reconcile Global IR',            target: 'globalIR',          estimatedTime: '2s', dependencies: [4] },
    { step: 6, phase: 'validate', action: 'Coherence pass + repair',                target: 'ir',                estimatedTime: '1s', dependencies: [5] },
    { step: 7, phase: 'generate', action: `Generate ${manifest.targetFramework} files`, target: 'output',        estimatedTime: '60s', dependencies: [6] },
  ];
}

/** Knowledge graph compact construit depuis la GlobalIR (relations inter-modules préservées). */
function buildKnowledgeGraph(globalIR: GlobalIR): IRKnowledgeGraph {
  const nodes: IRKnowledgeNode[] = [];
  const edges: IRKnowledgeEdge[] = [];

  const addNode = (id: string, type: IRKnowledgeNode['type'], name: string, path?: string): void => {
    if (!nodes.some((n) => n.id === id)) {
      nodes.push({ id, type, name, ...(path ? { path } : {}) });
    }
  };
  const addEdge = (from: string, to: string, relation: IRKnowledgeEdge['relation'], weight?: number): void => {
    if (!edges.some((e) => e.from === from && e.to === to && e.relation === relation)) {
      edges.push({ from, to, relation, ...(weight !== undefined ? { weight } : {}) });
    }
  };

  for (const s of globalIR.screens) addNode(s.id, 'screen', s.name, s.path);
  for (const c of globalIR.components) addNode(c.id, 'component', c.name, c.path || undefined);
  for (const st of globalIR.stateFlow) addNode(`store-${st.store.toLowerCase().replace(/\s+/g, '-')}`, 'store', st.store);
  for (const sv of globalIR.services) addNode(`service-${sv.name.toLowerCase().replace(/\s+/g, '-')}`, 'service', sv.name);
  for (const m of globalIR.models) addNode(`model-${m.name.toLowerCase()}`, 'model', m.name, m.path || undefined);
  for (const r of globalIR.routes) {
    addNode(
      `api-${r.method.toLowerCase()}-${r.path.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`,
      'api-endpoint',
      `${r.method} ${r.path}`,
      r.path,
    );
  }

  for (const n of globalIR.navigationFlow) {
    addEdge(n.from, n.to, 'navigates-to', 1);
  }
  for (const rel of globalIR.relations) {
    const fromId = guessNodeId(rel.from, globalIR);
    const toId   = guessNodeId(rel.to, globalIR);
    if (fromId && toId) {
      const relation: IRKnowledgeEdge['relation'] =
        toId.startsWith('store-')   ? 'uses-store'   :
        toId.startsWith('service-') ? 'calls-service':
        toId.startsWith('model-')   ? 'uses-model'   : 'depends-on';
      addEdge(fromId, toId, relation, 0.8);
    }
  }
  for (const a of globalIR.apiCalls) {
    const usedById = guessNodeId(a.usedBy, globalIR);
    const epId = `api-${a.method.toLowerCase()}-${a.url.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`;
    addNode(epId, 'api-endpoint', `${a.method} ${a.url}`, a.url);
    if (usedById) addEdge(usedById, epId, 'calls-api', 0.9);
  }

  return {
    nodes,
    edges,
    metadata: {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      buildTimestamp: new Date().toISOString(),
      version: '36.0',
    },
  };
}

function guessNodeId(name: string, ir: GlobalIR): string | undefined {
  const normName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  // Écrans : matcher par id OU par nom normalisé (screen-screen_0 ≈ Screen0)
  const screen = ir.screens.find((s) =>
    norm(s.id) === normName || norm(s.id) === `screen-${normName}` || norm(s.name) === normName,
  );
  if (screen) return screen.id;
  if (ir.services.some((s) => norm(s.name) === normName)) return `service-${normName}`;
  if (ir.models.some((m) => norm(m.name) === normName)) return `model-${normName}`;
  if (ir.stateFlow.some((s) => norm(s.store) === normName)) return `store-${normName}`;
  const comp = ir.components.find((c) => norm(c.name) === normName);
  if (comp) return comp.id;
  return undefined;
}

// ── Décision d'activation (réexport pratique pour pipeline.ts) ─────────────────
export { shouldUseSemanticPipeline, resetPhase36Config };
