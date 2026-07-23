// ============================================================
// CodeMorph AI Engine — Conversion Pipeline (Orchestrator)
// RULE: AI outputs IR only — backend transforms IR → code
// Pipeline: Source → AST → Architecture → IR → Map → Plan → Validate → AutoCorrect
// Supports: Free (Groq), Platform (OpenAI), Pro (user keys)
// PHASE 22: Prompt Maître V2 — Phase 7 Auto-correction ajoutée
// PHASE 23: Prompt Architecte Ultime V3 — Score fidélité multi-axes + boucle Phase 8
// PHASE 24: Audit Architecture + Correction Définitive
//   - FIX BUG #1: Groq 15 000 chars tronquait TOUT — désormais truncation intelligente par fichier
//   - FIX BUG #6: MappingEngine clés case-sensitive (voir mapping-engine.ts)
//   - FIX BUG #10: Logs structurés complets (=== AST ===, === KG ===, === IR ===, etc.)
//   - FIX BUG #12: Vérification cohérence des comptages Flutter→IR→Planned→Generated
//   - FIX BUG #7: autoCorrectLoop activé pour Groq (max 1 itération)
// ============================================================
import pino from 'pino';

import type {
  ConversionContext, ConversionResult,
  IRFidelityScore, IRFidelityDetail, IRAutoCorrectReport, IRScoreSnapshot,
  IRSourceMetrics,
} from '../models/ir.types';
import { AIProvider, type AITier }  from './ai-provider';
import { ASTAnalyzer }              from './ast-analyzer';
import { ArchitectureDetector }     from './architecture-detector';
import { IRGenerator }              from './ir-generator';
import { MappingEngine }            from './mapping-engine';
import { CodePlanner }              from './code-planner';
import { IRValidator }              from '../validators/ir.validator';
import type { GeneratedFile, IRDocument } from '../models/ir.types';

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });

export interface PipelineOptions {
  userOpenAIKey?:    string;
  userAnthropicKey?: string;
}

export class ConversionPipeline {
  private readonly astAnalyzer:  ASTAnalyzer;
  private readonly irValidator:  IRValidator;
  private readonly mappingEngine: MappingEngine;

  constructor() {
    this.astAnalyzer   = new ASTAnalyzer();
    this.irValidator   = new IRValidator();
    this.mappingEngine = new MappingEngine();
  }

  // ── Resolve AI tier for logging / limit enforcement ──────
  static resolveTier(opts?: PipelineOptions): AITier {
    const p = new AIProvider(opts);
    return p.getTier();
  }

  // ── Enforce free-tier limits ─────────────────────────────
  // FIX PHASE 24 — BUG #1 CRITIQUE:
  // AVANT: ctx.sourceCode.slice(0, 15_000) → TOUT le projet tronqué à 15 000 chars
  // PROBLÈME: Un projet Flutter 221 fichiers ≈ 500 000+ chars.
  //   Avec slice(0, 15_000), seuls les 2-3 premiers fichiers sont transmis.
  //   L'AST reçoit 15 000 chars → parse 2-3 fichiers → 0 screens détectés → template générique.
  //
  // Fix: troncature intelligente par fichier
  //   1. Compter les fichiers dans sourceCode
  //   2. Distribuer le budget (15 000 chars) sur tous les fichiers équitablement
  //   3. Prioriser les fichiers screens/pages/views (les plus importants pour la reconstruction)
  //   4. Logger le nombre de fichiers gardés vs total
  //
  // IMPORTANT: Cette limite est contournée pour les tiers payants (platform/pro).
  private enforceLimits(ctx: ConversionContext, tier: AITier): void {
    if (tier === 'static') {
      const limits = AIProvider.getLimits(tier);
      if (ctx.sourceCode.length > limits.maxInputChars) {
        ctx.sourceCode = ctx.sourceCode.slice(0, limits.maxInputChars);
        logger.warn({ jobId: ctx.jobId, tier }, `⚠️  Source code truncated to ${limits.maxInputChars} chars (static tier limit)`);
      }
      return;
    }

    if (tier === 'free-groq') {
      const limits = AIProvider.getLimits(tier);
      const totalChars = ctx.sourceCode.length;

      if (totalChars <= limits.maxInputChars) return; // No truncation needed

      // ── Troncature intelligente par fichier ────────────────────────────────
      // Extraire tous les blocs fichiers
      const filePattern = /\/\/\s*(?:=+\s*)?FILE:\s*(.+?)(?:\s*=+)?\n([\s\S]*?)(?=\/\/\s*(?:=+\s*)?FILE:|$)/g;
      type FileBlock = { path: string; content: string; header: string; priority: number };
      const allFileBlocks: FileBlock[] = [];
      let match: RegExpExecArray | null;

      while ((match = filePattern.exec(ctx.sourceCode)) !== null) {
        const path    = (match[1] ?? '').trim();
        const content = (match[2] ?? '').trim();
        if (!path || !content) continue;
        const header  = `// === FILE: ${path} ===\n`;
        // Priorité: screens/pages/views/widgets/services d'abord
        const priority = /screen|page|view|widget|service|repository|store|provider|bloc|cubit|model/i.test(path) ? 0 : 1;
        allFileBlocks.push({ path, content, header, priority });
      }

      if (allFileBlocks.length === 0) {
        // Pas de marqueurs fichiers → troncature classique
        ctx.sourceCode = ctx.sourceCode.slice(0, limits.maxInputChars);
        logger.warn({ jobId: ctx.jobId, tier }, `⚠️  Source code (no file markers) truncated to ${limits.maxInputChars} chars`);
        return;
      }

      // Trier par priorité : fichiers métier d'abord
      allFileBlocks.sort((a, b) => a.priority - b.priority);

      // Distribuer le budget chars sur les fichiers
      const CHARS_PER_FILE_GROQ = Math.floor(limits.maxInputChars / Math.min(allFileBlocks.length, 30));
      const HEADER_BUDGET = 50; // chars pour le header "// === FILE: path ==="

      let budget = limits.maxInputChars;
      const keptBlocks: string[] = [];
      let keptCount = 0;

      for (const block of allFileBlocks) {
        if (budget <= 0) break;
        const maxContent = Math.min(CHARS_PER_FILE_GROQ - HEADER_BUDGET, budget - HEADER_BUDGET);
        if (maxContent <= 50) break; // trop peu de place
        const truncContent = block.content.slice(0, maxContent);
        const entry = `${block.header}${truncContent}\n\n`;
        keptBlocks.push(entry);
        budget -= entry.length;
        keptCount++;
      }

      const newSourceCode = keptBlocks.join('');
      logger.warn({
        jobId:     ctx.jobId,
        tier,
        totalFiles: allFileBlocks.length,
        keptFiles:  keptCount,
        originalChars: totalChars,
        finalChars: newSourceCode.length,
      }, `⚠️  FIX BUG#1: Smart file truncation: ${keptCount}/${allFileBlocks.length} files kept (${newSourceCode.length}/${totalChars} chars)`);

      console.log(`[PIPELINE] FIX BUG#1 smart truncation — totalFiles=${allFileBlocks.length} keptFiles=${keptCount} chars=${newSourceCode.length}/${totalChars}`);
      ctx.sourceCode = newSourceCode;
    }
  }

  // ── Main pipeline ─────────────────────────────────────────
  async run(ctx: ConversionContext, opts?: PipelineOptions): Promise<ConversionResult> {
    const startTime = Date.now();
    const tier = ConversionPipeline.resolveTier(opts);
    logger.info({ jobId: ctx.jobId, tier }, '🚀 Pipeline started');

    // Enforce per-tier input limits
    this.enforceLimits(ctx, tier);

    // Instantiate AI-aware components with user keys
    const architectureDetector = new ArchitectureDetector(opts);
    const irGenerator          = new IRGenerator(opts);
    const codePlanner          = new CodePlanner(opts);

    // ── PHASE 1: AST Analysis (no AI) ─────────────────────
    logger.info({ jobId: ctx.jobId }, '📊 Phase 1: AST Analysis');
    const astResult = await this.astAnalyzer.analyze(ctx);

    // ── LOG STRUCTURÉ: AST ────────────────────────────────
    console.log(`\n================ AST ================`);
    console.log(`Files found      : ${astResult.files.length}`);
    console.log(`Dart/source files: ${astResult.files.filter((f) => /\.(dart|tsx?|jsx?)$/.test(f.path)).length}`);
    console.log(`Screens files    : ${astResult.files.filter((f) => /screen|page|view/i.test(f.path)).length}`);
    console.log(`Widget files     : ${astResult.files.filter((f) => /widget|component/i.test(f.path)).length}`);
    console.log(`Service files    : ${astResult.files.filter((f) => /service|repository|repo/i.test(f.path)).length}`);
    console.log(`Model files      : ${astResult.files.filter((f) => /model|entity|dto/i.test(f.path)).length}`);
    console.log(`Store files      : ${astResult.files.filter((f) => /store|bloc|cubit|provider|riverpod|getx|redux|zustand/i.test(f.path)).length}`);
    console.log(`State patterns   : ${astResult.statePatterns.join(', ') || '(none)'}`);
    console.log(`Auth patterns    : ${astResult.authPatterns.join(', ') || '(none)'}`);
    console.log(`External services: ${astResult.externalServices.join(', ') || '(none)'}`);
    console.log(`Navigation       : ${astResult.navigationPattern || '(none)'}`);
    console.log(`API patterns     : ${astResult.apiPatterns.join(', ') || '(none)'}`);
    console.log(`Assets detected  : ${astResult.assetFiles.length}`);
    console.log(`Env vars detected: ${astResult.envVarKeys.length} [${astResult.envVarKeys.slice(0, 5).join(', ')}${astResult.envVarKeys.length > 5 ? '...' : ''}]`);
    console.log(`Docs             : ${astResult.projectDocs.length}`);
    console.log(`CI/CD configs    : ${astResult.cicdConfigs.length}`);
    console.log(`Test files       : ${astResult.testFiles.length}`);
    console.log(`Config files     : ${astResult.configFiles.length}`);
    console.log(`Scripts          : ${astResult.scripts.length}`);
    console.log(`Dependencies     : ${astResult.dependencies.length}`);
    console.log(`Classes total    : ${astResult.classNames.length}`);
    console.log(`Functions total  : ${astResult.functions.length}`);
    console.log(`Tokens used      : ${astResult.tokensUsed}`);
    console.log(`==============================\n`);

    // ── PHASE 2: Architecture Detection ───────────────────
    logger.info({ jobId: ctx.jobId, tier }, '🏗️  Phase 2: Architecture Detection');
    const archResult = await architectureDetector.detect(ctx, astResult);

    // ── PHASE 3+4: IR Generation + Knowledge Graph ────────
    logger.info({ jobId: ctx.jobId, tier }, '⚙️  Phase 3: IR Generation + Knowledge Graph');
    const irDocument = await irGenerator.generate(ctx, astResult, archResult);

    // ── LOG STRUCTURÉ: KNOWLEDGE GRAPH ───────────────────
    const kg = irDocument.ir.knowledgeGraph;
    console.log(`\n================ KNOWLEDGE GRAPH ================`);
    console.log(`Nodes     : ${kg?.nodes.length ?? 0}`);
    console.log(`Edges     : ${kg?.edges.length ?? 0}`);
    console.log(`Screens   : ${kg?.nodes.filter((n) => n.type === 'screen').length ?? 0}`);
    console.log(`Models    : ${kg?.nodes.filter((n) => n.type === 'model').length ?? 0}`);
    console.log(`Services  : ${kg?.nodes.filter((n) => n.type === 'service').length ?? 0}`);
    console.log(`Stores    : ${kg?.nodes.filter((n) => n.type === 'store').length ?? 0}`);
    console.log(`API       : ${kg?.nodes.filter((n) => n.type === 'api-endpoint').length ?? 0}`);
    console.log(`Assets    : ${kg?.nodes.filter((n) => n.type === 'asset').length ?? 0}`);
    console.log(`Bus. Rules: ${kg?.nodes.filter((n) => n.type === 'business-rule').length ?? 0}`);
    if ((kg?.nodes.length ?? 0) === 0) {
      console.warn(`[PIPELINE] ⚠️  WARNING BUG#3: Knowledge Graph has 0 nodes — KG was built from empty IR. Screens must be populated first.`);
    }
    console.log(`==============================\n`);

    // ── LOG STRUCTURÉ: IR ─────────────────────────────────
    const ir = irDocument.ir;
    const irScreens    = ir.uiGraph?.screens?.length ?? 0;
    const irComponents = ir.uiGraph?.components?.length ?? 0;
    const irStores     = ir.uiGraph?.stateFlow?.length ?? 0;
    const irRoutes     = ir.backendGraph?.routes?.length ?? 0;
    const irServices   = ir.backendGraph?.services?.length ?? 0;
    const irModels     = ir.dataLayer?.models?.length ?? 0;
    const irNavFlows   = ir.uiGraph?.navigationFlow?.length ?? 0;
    const irAssets     = (ir.assets?.images?.length ?? 0) + (ir.assets?.icons?.length ?? 0) + (ir.assets?.fonts?.length ?? 0);
    const irEnvVars    = ir.envVars?.length ?? 0;
    console.log(`\n================ IR ================`);
    console.log(`Screens    : ${irScreens}`);
    console.log(`Components : ${irComponents}`);
    console.log(`Stores     : ${irStores}`);
    console.log(`Nav Flows  : ${irNavFlows}`);
    console.log(`Routes     : ${irRoutes}`);
    console.log(`Services   : ${irServices}`);
    console.log(`Models     : ${irModels}`);
    console.log(`Assets     : ${irAssets}`);
    console.log(`Env Vars   : ${irEnvVars}`);
    console.log(`ExtConns   : ${ir.externalConnections?.length ?? 0}`);
    console.log(`Design Tkns: ${ir.designTokens ? `yes (${ir.designTokens.colors?.length ?? 0} colors)` : 'no'}`);
    console.log(`KG nodes   : ${ir.knowledgeGraph?.nodes.length ?? 0}`);
    if (irScreens === 0) {
      console.warn(`[PIPELINE] ⚠️  CRITICAL: IR has 0 screens from ${astResult.files.length} source files. Code planning will generate scaffold only.`);
    }
    console.log(`==============================\n`);

    // ── PHASE 4: Mapping Engine ────────────────────────────
    logger.info({ jobId: ctx.jobId }, '🗺️  Phase 4: Mapping Engine');
    const mappedIR = await this.mappingEngine.map(ctx, irDocument.ir as never);

    // ── PHASE 5: Target Code Plan ──────────────────────────
    logger.info({ jobId: ctx.jobId, tier }, '📋 Phase 5: Code Planning (Reconstruction + Visual Fidelity)');
    const plan = await codePlanner.plan(ctx, mappedIR);

    // ── LOG STRUCTURÉ: RESULT (après planning) ────────────
    const genScreens    = plan.files.filter((f) => /\/(screens?|pages?|app)\/[^/]+\.(tsx?|jsx?)$/.test(f.path) && !/_layout|index|tabs/.test(f.path)).length;
    const genComponents = plan.files.filter((f) => /\/components\/[^/]+\.(tsx?|jsx?)$/.test(f.path)).length;
    const genStores     = plan.files.filter((f) => /\.store\.(ts|js)$/.test(f.path)).length;
    const genServices   = plan.files.filter((f) => /\.service\.(ts|js)$/.test(f.path)).length;
    const genModels     = plan.files.filter((f) => /\.types\.(ts|js)$/.test(f.path) || /\/types\//.test(f.path)).length;
    const genRouter     = plan.files.filter((f) => /router|navigation|_layout/.test(f.path)).length;
    console.log(`\n================ RESULT (after Code Planning) ================`);
    console.log(`Generated Screens    : ${genScreens}`);
    console.log(`Generated Components : ${genComponents}`);
    console.log(`Generated Stores     : ${genStores}`);
    console.log(`Generated Services   : ${genServices}`);
    console.log(`Generated Models     : ${genModels}`);
    console.log(`Generated Router     : ${genRouter}`);
    console.log(`Total Files          : ${plan.files.length}`);
    console.log(`Total Lines          : ${plan.summary.totalLines}`);
    console.log(`==============================\n`);

    // ── FIX BUG #12: VÉRIFICATION DE COHÉRENCE ────────────
    // Comparer: Flutter→AST files → IR screens → planned screens → generated screens
    this.logCoherenceCheck(astResult, mappedIR, plan.files, ctx.jobId);

    // ── PHASE 6: IR Validation ─────────────────────────────
    logger.info({ jobId: ctx.jobId }, '✅ Phase 6: IR Validation');
    const validatedIR = await this.irValidator.validate(mappedIR);

    // ── PHASE 7: Fidelity Score multi-axes ─────────────────────────────────
    logger.info({ jobId: ctx.jobId, tier }, '📐 Phase 7: Fidelity Score Calculation');
    const fidelityScore = this.calculateFidelityScore(validatedIR, plan.files);
    logger.info({
      jobId: ctx.jobId,
      overall: fidelityScore.overall,
      businessLogic: fidelityScore.businessLogic,
      navigation: fidelityScore.navigation,
      api: fidelityScore.api,
      stores: fidelityScore.stores,
      uiFidelity: fidelityScore.uiFidelity,
    }, `📊 Phase 7: Fidelity Score — Overall: ${fidelityScore.overall}%`);

    // ── PHASE 8: Auto-correction boucle (max 3 itérations) ─────────────────
    logger.info({ jobId: ctx.jobId, tier }, '🔄 Phase 8: Auto-correction Loop');
    const { correctedPlan, autoCorrectionReport } = await this.autoCorrectLoop(
      ctx, validatedIR, plan, fidelityScore, tier, codePlanner,
    );

    const durationMs = Date.now() - startTime;
    logger.info({
      jobId: ctx.jobId,
      durationMs,
      tier,
      finalScore: autoCorrectionReport.finalScore,
      iterations: autoCorrectionReport.iterations,
    }, '✨ Pipeline completed');

    return {
      jobId:      ctx.jobId,
      ir:         validatedIR,
      files:      correctedPlan.files,
      summary:    correctedPlan.summary,
      tokensUsed: astResult.tokensUsed + archResult.tokensUsed + irDocument.tokensUsed,
      durationMs,
      // FIX PHASE 20 — Inclure le tier et modèle IA pour affichage côté frontend
      aiTier:  tier,
      aiModel: new AIProvider(opts).getModel(),
      // ── PHASE 23: Score fidélité + rapport auto-correction ──────────────
      fidelityScore:        autoCorrectionReport.finalScore > fidelityScore.overall
        ? { ...fidelityScore, overall: autoCorrectionReport.finalScore }
        : fidelityScore,
      autoCorrectionReport,
    };
  }

  // ── PHASE 7: Calcul du score de fidélité multi-axes ─────────────────────
  // Prompt Architecte V3 — 7 axes mesurés : businessLogic, navigation, api,
  // stores, components, models, uiFidelity → overall (moyenne pondérée)
  private calculateFidelityScore(
    ir: Awaited<ReturnType<IRValidator['validate']>>,
    files: GeneratedFile[],
  ): IRFidelityScore {
    const sourceMetrics: IRSourceMetrics | undefined = ir.validation?.sourceMetrics;
    const details: IRFidelityDetail[] = [];

    // ── Axe 1 : Business Logic ───────────────────────────────────────────────
    const screensWithLogic = (ir.uiGraph?.screens ?? []).filter((s) =>
      (s as unknown as Record<string, unknown>)['businessLogic'] ||
      (s as unknown as Record<string, unknown>)['apiCalls']
    ).length;
    const generatedScreenCount = files.filter((f) =>
      /\/(screens?|pages?|app)\/[^/]+\.tsx?$/.test(f.path) && !/layout|index|\(tabs\)/.test(f.path)
    ).length;
    const sourceScreens = sourceMetrics?.screensCount ?? (ir.uiGraph?.screens?.length ?? 0);
    const bizLogicScore = sourceScreens === 0 ? 100 : Math.round((generatedScreenCount / Math.max(sourceScreens, 1)) * 100);
    details.push({
      axis: 'businessLogic',
      score: Math.min(100, bizLogicScore),
      sourceCount: screensWithLogic,
      generatedCount: generatedScreenCount,
      losses: sourceScreens > generatedScreenCount
        ? (ir.uiGraph?.screens ?? []).slice(generatedScreenCount).map((s) => s.name)
        : [],
    });

    // ── Axe 2 : Navigation ──────────────────────────────────────────────────
    const sourceNavFlows = ir.uiGraph?.navigationFlow?.length ?? 0;
    const generatedRouter = files.filter((f) =>
      /router|navigation|_layout/.test(f.path)
    ).length;
    const navScore = sourceNavFlows === 0 ? 100 : Math.min(100, generatedRouter > 0 ? 85 + Math.min(15, sourceNavFlows) : 0);
    details.push({
      axis: 'navigation',
      score: navScore,
      sourceCount: sourceNavFlows,
      generatedCount: generatedRouter,
      losses: generatedRouter === 0 && sourceNavFlows > 0 ? ['Navigation router missing'] : [],
    });

    // ── Axe 3 : API Endpoints ────────────────────────────────────────────────
    const sourceEndpoints = sourceMetrics?.endpointsCount ?? (ir.backendGraph?.routes?.length ?? 0);
    const generatedServices = files.filter((f) => /\.service\.(ts|js)$/.test(f.path)).length;
    const apiScore = sourceEndpoints === 0 ? 100
      : Math.min(100, Math.round((generatedServices / Math.max(Math.ceil(sourceEndpoints / 3), 1)) * 100));
    details.push({
      axis: 'api',
      score: apiScore,
      sourceCount: sourceEndpoints,
      generatedCount: generatedServices,
      losses: generatedServices === 0 && sourceEndpoints > 0 ? ['Service layer missing'] : [],
    });

    // ── Axe 4 : Stores ──────────────────────────────────────────────────────
    const sourceStores = sourceMetrics?.storesCount ?? (ir.uiGraph?.stateFlow?.length ?? 0);
    const generatedStores = files.filter((f) => /\.store\.(ts|js)$/.test(f.path)).length;
    const storesScore = sourceStores === 0 ? 100
      : Math.min(100, Math.round((generatedStores / Math.max(sourceStores, 1)) * 100));
    details.push({
      axis: 'stores',
      score: storesScore,
      sourceCount: sourceStores,
      generatedCount: generatedStores,
      losses: sourceStores > generatedStores
        ? (ir.uiGraph?.stateFlow ?? []).slice(generatedStores).map((sf) => sf.store)
        : [],
    });

    // ── Axe 5 : Components ──────────────────────────────────────────────────
    const sourceComponents = ir.uiGraph?.components?.length ?? 0;
    const generatedComponents = files.filter((f) =>
      /\/components\/[^/]+\.tsx?$/.test(f.path)
    ).length;
    const compScore = sourceComponents === 0 ? 100
      : Math.min(100, Math.round((generatedComponents / Math.max(sourceComponents, 1)) * 100));
    details.push({
      axis: 'components',
      score: compScore,
      sourceCount: sourceComponents,
      generatedCount: generatedComponents,
      losses: [],
    });

    // ── Axe 6 : Models ──────────────────────────────────────────────────────
    const sourceModels = sourceMetrics?.modelsCount ?? (ir.dataLayer?.models?.length ?? 0);
    const generatedTypes = files.filter((f) =>
      /\.types\.(ts|js)$/.test(f.path) || /\/types\//.test(f.path) || /\.entity\.(ts|js)$/.test(f.path)
    ).length;
    const modelsScore = sourceModels === 0 ? 100
      : Math.min(100, Math.round((generatedTypes / Math.max(sourceModels, 1)) * 100));
    details.push({
      axis: 'models',
      score: modelsScore,
      sourceCount: sourceModels,
      generatedCount: generatedTypes,
      losses: [],
    });

    // ── Axe 7 : UI Fidelity (design tokens + visual structure) ──────────────
    const hasDesignTokens = !!(ir as IRDocument & { designTokens?: unknown }).designTokens;
    const hasThemeFiles   = files.some((f) => /theme|colors|spacing/.test(f.path));
    const uiFidelityScore = hasDesignTokens && hasThemeFiles ? 90
      : hasDesignTokens || hasThemeFiles ? 70
      : generatedScreenCount > 0 ? 50
      : 20;
    details.push({
      axis: 'uiFidelity',
      score: uiFidelityScore,
      sourceCount: hasDesignTokens ? 1 : 0,
      generatedCount: hasThemeFiles ? 1 : 0,
      losses: !hasDesignTokens ? ['Design tokens not extracted from source'] : [],
    });

    // ── Overall : moyenne pondérée ────────────────────────────────────────────
    // Poids : businessLogic x2, navigation x1.5, api x1.5, stores x1, components x1, models x1, uiFidelity x1
    const weights = { businessLogic: 2, navigation: 1.5, api: 1.5, stores: 1, components: 1, models: 1, uiFidelity: 1 };
    const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
    const overall = Math.round(
      (details[0]!.score * weights.businessLogic +
       details[1]!.score * weights.navigation +
       details[2]!.score * weights.api +
       details[3]!.score * weights.stores +
       details[4]!.score * weights.components +
       details[5]!.score * weights.models +
       details[6]!.score * weights.uiFidelity) / totalWeight
    );

    return {
      businessLogic: details[0]!.score,
      navigation:    details[1]!.score,
      api:           details[2]!.score,
      stores:        details[3]!.score,
      components:    details[4]!.score,
      models:        details[5]!.score,
      uiFidelity:    details[6]!.score,
      overall:       Math.min(100, overall),
      details,
    };
  }

  // ── PHASE 8: Boucle auto-correction (max 3 itérations) ──────────────────
  // Prompt Architecte V3 — Identifie pertes → régénère → recalcule score
  private async autoCorrectLoop(
    ctx: ConversionContext,
    ir: ReturnType<IRValidator['validate']> extends Promise<infer T> ? T : never,
    initialPlan: Awaited<ReturnType<CodePlanner['plan']>>,
    initialScore: IRFidelityScore,
    tier: AITier,
    codePlanner: CodePlanner,
  ): Promise<{ correctedPlan: typeof initialPlan; autoCorrectionReport: IRAutoCorrectReport }> {
    const MAX_ITERATIONS = tier === 'static' ? 0 : tier === 'free-groq' ? 1 : 3;
    // FIX PHASE 24 — BUG #8: Groq avait MAX_ITERATIONS=0 → aucune auto-correction
    // Fix: Groq autorisé à faire 1 itération pour rattraper les écrans manquants
    const IMPROVEMENT_THRESHOLD = 3; // minimum gain (%) pour continuer

    const scoreHistory: IRScoreSnapshot[] = [
      { iteration: 0, score: initialScore.overall, delta: 0, filesRegenerated: 0 },
    ];
    const improvements: string[] = [];
    const remainingLosses: string[] = [];

    let currentPlan = initialPlan;
    let currentScore = initialScore.overall;
    let iteration = 0;

    // Collecter les pertes initiales
    const initialLosses = initialScore.details
      .filter((d) => d.losses.length > 0)
      .flatMap((d) => d.losses.map((l) => `[${d.axis}] ${l}`));

    if (initialLosses.length === 0 || MAX_ITERATIONS === 0) {
      if (MAX_ITERATIONS === 0 && tier !== 'static') {
        // Groq: noter les pertes dans les warnings sans régénérer
        const lossLines = initialScore.details
          .filter((d) => d.score < 100 && d.losses.length > 0)
          .map((d) => `[Phase8] ${d.axis} score=${d.score}% losses=${d.losses.join(', ')}`);
        if (lossLines.length > 0 && ir.validation) {
          ir.validation.warnings = [...(ir.validation.warnings ?? []), ...lossLines];
          logger.warn({ jobId: ctx.jobId, losses: lossLines.length }, '⏭️  Phase 8: Groq — losses noted in warnings, regeneration skipped');
        }
      }
      remainingLosses.push(...initialLosses);

      return {
        correctedPlan: currentPlan,
        autoCorrectionReport: {
          iterations: 0,
          maxIterations: MAX_ITERATIONS,
          initialScore: initialScore.overall,
          finalScore: currentScore,
          scoreHistory,
          improvements,
          remainingLosses,
          completedAt: new Date().toISOString(),
        },
      };
    }

    // ── Boucle d'itération ────────────────────────────────────────────────
    for (iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
      logger.info({ jobId: ctx.jobId, iteration, currentScore }, `🔄 Phase 8: Iteration ${iteration}/${MAX_ITERATIONS}`);

      const axesWithLosses = initialScore.details.filter((d) => d.score < 80 && d.losses.length > 0);
      if (axesWithLosses.length === 0) {
        logger.info({ jobId: ctx.jobId }, '✅ Phase 8: No significant losses remaining — stopping');
        break;
      }

      try {
        logger.info({ jobId: ctx.jobId, axes: axesWithLosses.map((a) => a.axis) }, '🔄 Phase 8: Re-planning for losses');
        const replan = await codePlanner.plan(ctx, ir as never);

        // Merge : garder les fichiers existants, ajouter les nouveaux pour les gaps
        const existingPaths = new Set(currentPlan.files.map((f) => f.path));
        const newFiles: GeneratedFile[] = replan.files.filter((f) => !existingPaths.has(f.path));

        if (newFiles.length === 0) {
          logger.info({ jobId: ctx.jobId }, '⏭️  Phase 8: No new files generated — stopping loop');
          break;
        }

        const mergedFiles = [...currentPlan.files, ...newFiles];
        currentPlan = {
          files: mergedFiles,
          summary: {
            ...currentPlan.summary,
            totalFiles:      mergedFiles.length,
            successfulFiles: mergedFiles.filter((f) => !f.warnings?.length).length,
            totalLines:      mergedFiles.reduce((a, f) => a + f.content.split('\n').length, 0),
            convertedLines:  mergedFiles.reduce((a, f) => a + f.content.split('\n').length, 0),
          },
        };

        // Recalculer le score
        const newScore = this.calculateFidelityScore(ir, currentPlan.files);
        const delta = newScore.overall - currentScore;
        currentScore = newScore.overall;

        scoreHistory.push({ iteration, score: currentScore, delta, filesRegenerated: newFiles.length });
        improvements.push(...newFiles.map((f) => `[iter${iteration}] Added: ${f.path}`));

        logger.info({
          jobId: ctx.jobId,
          iteration,
          newFiles: newFiles.length,
          scoreAfter: currentScore,
          delta,
        }, `📊 Phase 8: Iteration ${iteration} done — score=${currentScore}% delta=${delta > 0 ? '+' : ''}${delta}%`);

        // Arrêt si gain insuffisant
        if (delta < IMPROVEMENT_THRESHOLD) {
          logger.info({ jobId: ctx.jobId }, `⏭️  Phase 8: Gain (${delta}%) below threshold (${IMPROVEMENT_THRESHOLD}%) — stopping`);
          break;
        }

      } catch (err) {
        logger.error({ jobId: ctx.jobId, err: (err as Error).message, iteration }, '❌ Phase 8: Iteration failed');
        break;
      }
    }

    // Collecter les pertes restantes
    const finalScore = this.calculateFidelityScore(ir, currentPlan.files);
    remainingLosses.push(
      ...finalScore.details
        .filter((d) => d.losses.length > 0)
        .flatMap((d) => d.losses.map((l) => `[${d.axis}] ${l}`))
    );

    logger.info({
      jobId: ctx.jobId,
      iterations: iteration,
      initialScore: initialScore.overall,
      finalScore: currentScore,
      improvements: improvements.length,
      remainingLosses: remainingLosses.length,
    }, `✅ Phase 8: Auto-correction loop complete`);

    return {
      correctedPlan: currentPlan,
      autoCorrectionReport: {
        iterations:      iteration,
        maxIterations:   MAX_ITERATIONS,
        initialScore:    initialScore.overall,
        finalScore:      currentScore,
        scoreHistory,
        improvements,
        remainingLosses,
        completedAt:     new Date().toISOString(),
      },
    };
  }

  // ── FIX BUG #12: Vérification de cohérence des comptages ────────────────
  // Flutter source files → IR screens → planned screens → generated screens
  // Les nombres DOIVENT être cohérents. Si pas, logger des avertissements critiques.
  private logCoherenceCheck(
    ast:         Awaited<ReturnType<ASTAnalyzer['analyze']>>,
    ir:          IRDocument,
    files:       GeneratedFile[],
    jobId:       string,
  ): void {
    const flutterScreenFiles = ast.files.filter((f) => /screen|page|view/i.test(f.path)).length;
    const flutterModelFiles  = ast.files.filter((f) => /model|entity|dto/i.test(f.path)).length;
    const flutterServiceFiles = ast.files.filter((f) => /service|repository/i.test(f.path)).length;
    const flutterStoreFiles  = ast.files.filter((f) => /bloc|cubit|store|provider|getx/i.test(f.path)).length;

    const irScreens   = ir.uiGraph?.screens?.length ?? 0;
    const irModels    = ir.dataLayer?.models?.length ?? 0;
    const irServices  = ir.backendGraph?.services?.length ?? 0;
    const irStores    = ir.uiGraph?.stateFlow?.length ?? 0;
    const irEndpoints = ir.backendGraph?.routes?.length ?? 0;

    const genScreens  = files.filter((f) => /\/(screens?|pages?|app)\/[^/]+\.(tsx?|jsx?)$/.test(f.path) && !/_layout|index|tabs/.test(f.path)).length;
    const genModels   = files.filter((f) => /\.types\.(ts|js)$/.test(f.path) || /\/types\//.test(f.path)).length;
    const genServices = files.filter((f) => /\.service\.(ts|js)$/.test(f.path)).length;
    const genStores   = files.filter((f) => /\.store\.(ts|js)$/.test(f.path)).length;

    console.log(`\n================ COHERENCE CHECK ================`);
    console.log(`                     | Flutter | IR      | Generated`);
    console.log(`---------------------|---------|---------|----------`);
    console.log(`Screens              | ${String(flutterScreenFiles).padStart(7)} | ${String(irScreens).padStart(7)} | ${String(genScreens).padStart(9)}`);
    console.log(`Models               | ${String(flutterModelFiles).padStart(7)} | ${String(irModels).padStart(7)} | ${String(genModels).padStart(9)}`);
    console.log(`Services             | ${String(flutterServiceFiles).padStart(7)} | ${String(irServices).padStart(7)} | ${String(genServices).padStart(9)}`);
    console.log(`Stores               | ${String(flutterStoreFiles).padStart(7)} | ${String(irStores).padStart(7)} | ${String(genStores).padStart(9)}`);
    console.log(`Endpoints            | ${String(ast.apiPatterns.length).padStart(7)} | ${String(irEndpoints).padStart(7)} | ${String(genServices).padStart(9)}`);
    console.log(`Total source files   : ${ast.files.length}`);
    console.log(`Total gen files      : ${files.length}`);

    // Avertissements critiques
    if (flutterScreenFiles > 0 && irScreens === 0) {
      console.warn(`[COHERENCE] ❌ CRITICAL: Flutter has ${flutterScreenFiles} screen files but IR has 0 screens. IR generation failed. Check Groq token limits.`);
      logger.warn({ jobId, flutterScreenFiles, irScreens }, '❌ COHERENCE: Flutter screens → IR screens MISMATCH');
    }
    if (irScreens > 0 && genScreens === 0) {
      console.warn(`[COHERENCE] ❌ CRITICAL: IR has ${irScreens} screens but 0 were generated. Code planning failed. Check generateScreenFile() errors.`);
      logger.warn({ jobId, irScreens, genScreens }, '❌ COHERENCE: IR screens → Generated screens MISMATCH');
    }
    if (irScreens > 0 && genScreens < irScreens * 0.5) {
      console.warn(`[COHERENCE] ⚠️  WARNING: IR has ${irScreens} screens but only ${genScreens} generated (${Math.round(genScreens/irScreens*100)}%). Low fidelity.`);
    }
    if (irModels > 0 && genModels === 0) {
      console.warn(`[COHERENCE] ⚠️  WARNING: IR has ${irModels} models but 0 types files generated.`);
    }
    if (ast.files.length > 50 && files.length <= 20) {
      console.warn(`[COHERENCE] ❌ CRITICAL: Source has ${ast.files.length} files but only ${files.length} generated. Likely a template (expected 50+ files for 221 source files).`);
    }
    console.log(`==============================\n`);
  }

}

// ── Singleton export (default — reads env vars) ───────────────────────────────
export const pipeline = new ConversionPipeline();
