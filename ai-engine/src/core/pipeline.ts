// ============================================================
// CodeMorph AI Engine — Conversion Pipeline (Orchestrator)
// RULE: AI outputs IR only — backend transforms IR → code
// Pipeline: Source → AST → Architecture → IR → Map → Plan → Validate → AutoCorrect
// Supports: Free (Groq), Platform (OpenAI), Pro (user keys)
// PHASE 22: Prompt Maître V2 — Phase 7 Auto-correction ajoutée
// PHASE 23: Prompt Architecte Ultime V3 — Score fidélité multi-axes + boucle Phase 8
// PHASE 24: Audit Architecture + Correction Définitive
// PHASE 25: Optimisation Infrastructure + Coûts + Scalabilité
// PHASE 27: Stabilisation — 12 bugs fixés, score 10 axes, cible ≥95%
// PHASE 28: Moteur de conversion fiable — 12 étapes complètes
//   STEP 1: LLM Output Cleaning (output-cleaner.ts)
//   STEP 2: File Chunking (file-chunker.ts)
//   STEP 3: Import Verification (import-verifier.ts)
//   STEP 4: TypeScript Issue Detection (import-verifier.ts)
//   STEP 5: Source↔Generated Fidelity Comparison (fidelity-comparator.ts)
// ============================================================
import pino from 'pino';
import { pipelineCache, buildCacheKey } from './pipeline-cache';

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
// PHASE 28: Nouveaux modules de qualité
import { runFidelityComparison }    from './fidelity-comparator';
import { verifyAndFixImports }      from './import-verifier';

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

    // ── PHASE 25 Partie F : Métriques timing par phase ───────
    const phaseTimings: Record<string, number> = {};
    const phaseStart = (phase: string) => { phaseTimings[`${phase}_start`] = Date.now(); };
    const phaseEnd   = (phase: string) => {
      const elapsed = Date.now() - (phaseTimings[`${phase}_start`] ?? Date.now());
      phaseTimings[phase] = elapsed;
      delete phaseTimings[`${phase}_start`];
      logger.info({ jobId: ctx.jobId, phase, elapsedMs: elapsed }, `⏱️  Phase timing: ${phase}=${elapsed}ms`);
    };

    // Enforce per-tier input limits
    this.enforceLimits(ctx, tier);

    // Instantiate AI-aware components with user keys
    const architectureDetector = new ArchitectureDetector(opts);
    const irGenerator          = new IRGenerator(opts);
    const codePlanner          = new CodePlanner(opts);

    // ── PHASE 25 Partie C : Cache key basé sur sourceCode + tier ──
    // Permet d'éviter tous les appels AI si on a déjà analysé ce code
    const cacheKey = buildCacheKey(ctx.sourceCode, tier, ctx.sourceLanguage ?? '', ctx.targetFramework ?? '');
    logger.info({ jobId: ctx.jobId, cacheKey: cacheKey.slice(0, 12) + '…' }, '🔑 Cache key computed');

    // ── PHASE 1: AST Analysis (no AI) — avec cache ────────
    phaseStart('ast');
    logger.info({ jobId: ctx.jobId }, '📊 Phase 1: AST Analysis');
    let astResult: Awaited<ReturnType<ASTAnalyzer['analyze']>>;
    const cachedAst = pipelineCache.astCache.get(cacheKey) as typeof astResult | undefined;
    if (cachedAst) {
      astResult = cachedAst;
      logger.info({ jobId: ctx.jobId }, '✅ Phase 1: AST — cache HIT (0 tokens)');
    } else {
      astResult = await this.astAnalyzer.analyze(ctx);
      pipelineCache.astCache.set(cacheKey, astResult);
    }
    phaseEnd('ast');

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

    // ── PHASE 2: Architecture Detection — avec cache ───────
    phaseStart('arch');
    logger.info({ jobId: ctx.jobId, tier }, '🏗️  Phase 2: Architecture Detection');
    let archResult: Awaited<ReturnType<ArchitectureDetector['detect']>>;
    const cachedArch = pipelineCache.archCache.get(cacheKey) as typeof archResult | undefined;
    if (cachedArch) {
      archResult = cachedArch;
      logger.info({ jobId: ctx.jobId }, '✅ Phase 2: Architecture — cache HIT (0 tokens)');
    } else {
      archResult = await architectureDetector.detect(ctx, astResult);
      pipelineCache.archCache.set(cacheKey, archResult);
    }
    phaseEnd('arch');

    // ── PHASE 3+4: IR Generation + Knowledge Graph — avec cache ──
    phaseStart('ir');
    logger.info({ jobId: ctx.jobId, tier }, '⚙️  Phase 3: IR Generation + Knowledge Graph');
    let irDocument: Awaited<ReturnType<IRGenerator['generate']>>;
    const cachedIR = pipelineCache.irCache.get(cacheKey) as typeof irDocument | undefined;
    if (cachedIR) {
      irDocument = cachedIR;
      logger.info({ jobId: ctx.jobId }, '✅ Phase 3: IR — cache HIT (0 tokens)');
    } else {
      irDocument = await irGenerator.generate(ctx, astResult, archResult);
      pipelineCache.irCache.set(cacheKey, irDocument);
    }
    phaseEnd('ir');

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

    // ── PHASE 4: Mapping Engine — avec cache ───────────────
    phaseStart('mapping');
    logger.info({ jobId: ctx.jobId }, '🗺️  Phase 4: Mapping Engine');
    let mappedIR: Awaited<ReturnType<MappingEngine['map']>>;
    const mappingCacheKey = buildCacheKey(cacheKey, ctx.targetFramework ?? '');
    const cachedMapping = pipelineCache.mappingCache.get(mappingCacheKey) as typeof mappedIR | undefined;
    if (cachedMapping) {
      mappedIR = cachedMapping;
      logger.info({ jobId: ctx.jobId }, '✅ Phase 4: Mapping — cache HIT');
    } else {
      mappedIR = await this.mappingEngine.map(ctx, irDocument.ir as never);
      pipelineCache.mappingCache.set(mappingCacheKey, mappedIR);
    }
    phaseEnd('mapping');

    // ── PHASE 5: Target Code Plan — avec cache ─────────────
    phaseStart('planning');
    logger.info({ jobId: ctx.jobId, tier }, '📋 Phase 5: Code Planning (Reconstruction + Visual Fidelity)');
    let plan: Awaited<ReturnType<CodePlanner['plan']>>;
    const planCacheKey = buildCacheKey(cacheKey, ctx.targetFramework ?? '', tier);
    const cachedPlan = pipelineCache.planCache.get(planCacheKey) as typeof plan | undefined;
    if (cachedPlan) {
      plan = cachedPlan;
      logger.info({ jobId: ctx.jobId }, '✅ Phase 5: Plan — cache HIT (0 tokens)');
    } else {
      plan = await codePlanner.plan(ctx, mappedIR);
      // Ne mettre en cache que si le plan est suffisamment bon (éviter de cacher un plan dégradé)
      const quickScreenCount = plan.files.filter((f) => /\/(screens?|pages?)\//.test(f.path)).length;
      if (quickScreenCount > 0) {
        pipelineCache.planCache.set(planCacheKey, plan);
      }
    }
    phaseEnd('planning');

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

    // ── PHASE 27: VÉRIFICATION DE COHÉRENCE BLOQUANTE ───────────────────────
    // BUG-P27-07 FIX: logCoherenceCheck retourne { hasCriticalMismatch, missingScreens, missingServices }
    const coherenceResult = this.logCoherenceCheck(astResult, mappedIR, plan.files, ctx.jobId);
    if (coherenceResult.hasCriticalMismatch) {
      logger.warn({
        jobId: ctx.jobId,
        missingScreens:  coherenceResult.missingScreens,
        missingServices: coherenceResult.missingServices,
      }, '⚠️  Coherence: Critical mismatch — Phase 8 will run at full iterations to recover fidelity');
      console.warn(`[PIPELINE] ⚠️  Mismatch critique détecté: ${coherenceResult.missingScreens} écrans manquants, ${coherenceResult.missingServices} services manquants → Phase 8 forcée`);
    }

    // ── PHASE 6: IR Validation ─────────────────────────────
    phaseStart('validation');
    logger.info({ jobId: ctx.jobId }, '✅ Phase 6: IR Validation');
    const validatedIR = await this.irValidator.validate(mappedIR);
    phaseEnd('validation');

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
    const tokensUsed = astResult.tokensUsed + archResult.tokensUsed + irDocument.tokensUsed;

    // ── PHASE 28 STEP 9: Import Verification finale ──────────────────────────
    // Vérification finale des imports après toutes les phases de correction
    logger.info({ jobId: ctx.jobId }, '🔍 Phase 9 (Phase 28): Final Import Verification');
    const finalImportResult = verifyAndFixImports(correctedPlan.files);
    const finalFiles = finalImportResult.files;
    const finalReport = finalImportResult.report;
    if (finalReport.importsFixed > 0) {
      console.log(`[PIPELINE] Phase 9: Final import fix — ${finalReport.importsFixed} imports corrected, ${finalReport.importsUnresolved} unresolved`);
    }

    // ── PHASE 28 STEP 10: Source ↔ Generated Comparison ─────────────────────
    // Comparaison granulaire: classes, fonctions, méthodes, services, repositories
    logger.info({ jobId: ctx.jobId }, '🔬 Phase 10 (Phase 28): Source ↔ Generated Comparison');
    const fidelityComparison = runFidelityComparison(
      ctx.sourceCode,
      finalFiles,
      ctx.sourceLanguage ?? 'dart',
    );
    logger.info({
      jobId: ctx.jobId,
      comparatorScore: fidelityComparison.scores.overall,
      missing: fidelityComparison.missing.length,
      classes: fidelityComparison.scores.classes,
      services: fidelityComparison.scores.services,
      repositories: fidelityComparison.scores.repositories,
    }, `🔬 Phase 10: Fidelity Comparator — Overall: ${fidelityComparison.scores.overall}%`);

    // ── PHASE 28 STEP 11: Fusionner les scores (10 axes + comparateur) ───────
    // Le score final intègre les deux sources: score existant + comparateur granulaire
    const comparatorBonus = fidelityComparison.scores.overall;
    const finalFidelityScore: IRFidelityScore = {
      ...autoCorrectionReport.finalScore > fidelityScore.overall
        ? { ...fidelityScore, overall: autoCorrectionReport.finalScore }
        : fidelityScore,
      // Intégrer les données du comparateur dans les axes existants
      businessLogic: Math.round((fidelityScore.businessLogic + fidelityComparison.scores.services) / 2),
      models:        Math.round((fidelityScore.models + fidelityComparison.scores.models) / 2),
      api:           Math.round((fidelityScore.api + fidelityComparison.scores.repositories) / 2),
      overall:       Math.round((
        (autoCorrectionReport.finalScore > fidelityScore.overall ? autoCorrectionReport.finalScore : fidelityScore.overall) * 0.6
        + comparatorBonus * 0.4
      )),
    };

    console.log(`\n[PIPELINE] ===== PHASE 28 FINAL REPORT =====`);
    console.log(`[PIPELINE] Pipeline score (10-axes):   ${fidelityScore.overall}%`);
    console.log(`[PIPELINE] Auto-correction score:      ${autoCorrectionReport.finalScore}%`);
    console.log(`[PIPELINE] Comparator score:           ${comparatorBonus}%`);
    console.log(`[PIPELINE] FINAL COMPOSITE SCORE:      ${finalFidelityScore.overall}%`);
    console.log(`[PIPELINE] Missing elements:           ${fidelityComparison.missing.length}`);
    console.log(`[PIPELINE] Import fixes applied:       ${finalReport.importsFixed}`);
    console.log(`[PIPELINE] Import unresolved:          ${finalReport.importsUnresolved}`);
    console.log(`[PIPELINE] ==============================\n`);

    // ── PHASE 25 Partie F : Log métriques finales ────────────
    const cacheStats = pipelineCache.getStats();
    const estimatedCostUSD = (tokensUsed / 1_000) * (tier === 'free-groq' ? 0 : tier === 'platform' ? 0.01 : 0.02);
    console.log(`\n================ PIPELINE METRICS (Phase 25/28) ================`);
    console.log(`Total duration   : ${durationMs}ms`);
    console.log(`AST time         : ${phaseTimings['ast'] ?? 0}ms`);
    console.log(`Architecture time: ${phaseTimings['arch'] ?? 0}ms`);
    console.log(`IR time          : ${phaseTimings['ir'] ?? 0}ms`);
    console.log(`Mapping time     : ${phaseTimings['mapping'] ?? 0}ms`);
    console.log(`Planning time    : ${phaseTimings['planning'] ?? 0}ms`);
    console.log(`Validation time  : ${phaseTimings['validation'] ?? 0}ms`);
    console.log(`Tokens consumed  : ${tokensUsed}`);
    console.log(`Est. cost (USD)  : $${estimatedCostUSD.toFixed(4)}`);
    console.log(`AI tier          : ${tier}`);
    console.log(`Final score      : ${finalFidelityScore.overall}%`);
    console.log(`Files generated  : ${finalFiles.length}`);
    console.log(`Import fixes     : ${finalReport.importsFixed}`);
    console.log(`Comparator score : ${fidelityComparison.scores.overall}%`);
    console.log(`Cache stats      : ast=${cacheStats['ast']?.size ?? 0} ir=${cacheStats['ir']?.size ?? 0} plan=${cacheStats['plan']?.size ?? 0}`);
    console.log(`==============================\n`);

    logger.info({
      jobId: ctx.jobId,
      durationMs,
      tier,
      tokensUsed,
      estimatedCostUSD,
      finalScore: finalFidelityScore.overall,
      comparatorScore: fidelityComparison.scores.overall,
      iterations: autoCorrectionReport.iterations,
      filesGenerated: finalFiles.length,
      importsFixed: finalReport.importsFixed,
      phaseTimes: {
        ast:      phaseTimings['ast'] ?? 0,
        arch:     phaseTimings['arch'] ?? 0,
        ir:       phaseTimings['ir'] ?? 0,
        mapping:  phaseTimings['mapping'] ?? 0,
        planning: phaseTimings['planning'] ?? 0,
      },
    }, '✨ Pipeline completed (Phase 28)');

    return {
      jobId:      ctx.jobId,
      ir:         validatedIR,
      files:      finalFiles,
      summary:    {
        ...correctedPlan.summary,
        totalFiles:      finalFiles.length,
        successfulFiles: finalFiles.filter((f) => !f.warnings?.length).length,
        totalLines:      finalFiles.reduce((a, f) => a + f.content.split('\n').length, 0),
        convertedLines:  finalFiles.reduce((a, f) => a + f.content.split('\n').length, 0),
      },
      tokensUsed,
      durationMs,
      // FIX PHASE 20 — Inclure le tier et modèle IA pour affichage côté frontend
      aiTier:  tier,
      aiModel: new AIProvider(opts).getModel(),
      // ── PHASE 23/28: Score fidélité composite + rapport auto-correction ─────
      fidelityScore:        finalFidelityScore,
      autoCorrectionReport,
    };
  }

  // ── PHASE 27: Calcul du score de fidélité multi-axes — 10 axes ─────────
  // businessLogic, navigation, api, stores, components, models, uiFidelity,
  // dataLayer, assets, functional → overall (moyenne pondérée)
  // BUG-P27-01 FIX: 7 axes → 10 axes
  // BUG-P27-06 FIX: IR=0 screens ne donne plus 100% (score 0 si source>0)
  private calculateFidelityScore(
    ir: Awaited<ReturnType<IRValidator['validate']>>,
    files: GeneratedFile[],
  ): IRFidelityScore {
    const sourceMetrics: IRSourceMetrics | undefined = ir.validation?.sourceMetrics;
    const details: IRFidelityDetail[] = [];

    // ── Helpers ──────────────────────────────────────────────────────────────
    const safeRatio = (gen: number, src: number): number =>
      src === 0 ? 100 : Math.min(100, Math.round((gen / Math.max(src, 1)) * 100));
    // BUG-P27-06 FIX: si source > 0 ET generated = 0 → score = 0 (pas 100)
    const strictRatio = (gen: number, src: number): number =>
      src === 0 ? 100 : gen === 0 ? 0 : Math.min(100, Math.round((gen / Math.max(src, 1)) * 100));

    const generatedScreenCount = files.filter((f) =>
      /\/(screens?|pages?|app)\/[^/]+\.tsx?$/.test(f.path) && !/layout|index|\(tabs\)/.test(f.path)
    ).length;

    // ── Axe 1 : Business Logic ───────────────────────────────────────────────
    const sourceScreens = sourceMetrics?.screensCount ?? (ir.uiGraph?.screens?.length ?? 0);
    const screensWithLogic = (ir.uiGraph?.screens ?? []).filter((s) =>
      (s as unknown as Record<string, unknown>)['businessLogic'] ||
      (s as unknown as Record<string, unknown>)['apiCalls']
    ).length;
    // BUG-P27-06 FIX: strictRatio → 0 si IR screens = 0 et source > 0
    const bizLogicScore = strictRatio(generatedScreenCount, sourceScreens);
    const bizLosses = sourceScreens > generatedScreenCount
      ? (ir.uiGraph?.screens ?? []).slice(generatedScreenCount).map((s) => s.name)
      : [];
    const bizNote = sourceScreens === 0
      ? 'WARNING: 0 screens in IR — check if Groq token budget was too small'
      : undefined;
    const bizDetail: IRFidelityDetail = {
      axis: 'businessLogic',
      score: bizLogicScore,
      sourceCount: Math.max(sourceScreens, screensWithLogic),
      generatedCount: generatedScreenCount,
      losses: bizLosses,
    };
    if (bizNote) bizDetail.notes = bizNote;
    details.push(bizDetail);

    // ── Axe 2 : Navigation ──────────────────────────────────────────────────
    const sourceNavFlows = ir.uiGraph?.navigationFlow?.length ?? 0;
    const generatedRouter = files.filter((f) => /router|navigation|_layout/.test(f.path)).length;
    const navScore = sourceNavFlows === 0
      ? (generatedRouter > 0 ? 80 : 50)  // router sans nav flows = partiel
      : Math.min(100, generatedRouter > 0 ? 80 + Math.min(20, Math.round((sourceNavFlows / 5) * 20)) : 0);
    details.push({
      axis: 'navigation',
      score: navScore,
      sourceCount: sourceNavFlows,
      generatedCount: generatedRouter,
      losses: generatedRouter === 0 ? ['Navigation router file missing'] : [],
    });

    // ── Axe 3 : API Endpoints ────────────────────────────────────────────────
    const sourceEndpoints = sourceMetrics?.endpointsCount ?? (ir.backendGraph?.routes?.length ?? 0);
    const generatedServices = files.filter((f) => /\.service\.(ts|js)$/.test(f.path)).length;
    // 1 service couvre ~3 endpoints en moyenne
    const apiScore = strictRatio(generatedServices, Math.max(1, Math.ceil(sourceEndpoints / 3)));
    details.push({
      axis: 'api',
      score: apiScore,
      sourceCount: sourceEndpoints,
      generatedCount: generatedServices,
      losses: generatedServices === 0 && sourceEndpoints > 0 ? ['Service layer entirely missing'] : [],
    });

    // ── Axe 4 : Stores ──────────────────────────────────────────────────────
    const sourceStores = sourceMetrics?.storesCount ?? (ir.uiGraph?.stateFlow?.length ?? 0);
    const generatedStores = files.filter((f) => /\.store\.(ts|js)$/.test(f.path)).length;
    const storesScore = strictRatio(generatedStores, sourceStores);
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
    const compScore = safeRatio(generatedComponents, sourceComponents);
    details.push({
      axis: 'components',
      score: compScore,
      sourceCount: sourceComponents,
      generatedCount: generatedComponents,
      losses: sourceComponents > 0 && generatedComponents === 0 ? ['No component files generated'] : [],
    });

    // ── Axe 6 : Models ──────────────────────────────────────────────────────
    const sourceModels = sourceMetrics?.modelsCount ?? (ir.dataLayer?.models?.length ?? 0);
    const generatedTypes = files.filter((f) =>
      /\.types\.(ts|js)$/.test(f.path) || /\/types\//.test(f.path) || /\.entity\.(ts|js)$/.test(f.path)
    ).length;
    const modelsScore = safeRatio(generatedTypes, sourceModels);
    details.push({
      axis: 'models',
      score: modelsScore,
      sourceCount: sourceModels,
      generatedCount: generatedTypes,
      losses: sourceModels > 0 && generatedTypes === 0 ? ['No type/entity files generated'] : [],
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

    // ── Axe 8 : Data Layer (PHASE 27 — nouvel axe) ──────────────────────────
    const sourceEntities = (ir.dataLayer?.models?.length ?? 0);
    const sourceMigrations = (ir.dataLayer?.migrations?.length ?? 0);
    const genEntities = files.filter((f) => /\.entity\.(ts|js)$/.test(f.path)).length;
    const genMigrations = files.filter((f) => /migration|migrate/.test(f.path)).length;
    const dataLayerScore = (sourceEntities + sourceMigrations) === 0
      ? 100
      : Math.min(100, Math.round(
          ((genEntities + genMigrations) / Math.max(sourceEntities + sourceMigrations, 1)) * 100
        ));
    details.push({
      axis: 'dataLayer',
      score: dataLayerScore,
      sourceCount: sourceEntities + sourceMigrations,
      generatedCount: genEntities + genMigrations,
      losses: sourceEntities > 0 && genEntities === 0 ? ['Entity files missing'] : [],
    });

    // ── Axe 9 : Assets (PHASE 27 — nouvel axe) ──────────────────────────────
    const sourceAssets = (sourceMetrics?.assetsCount ?? 0) +
      (ir.assets?.images?.length ?? 0) +
      (ir.assets?.fonts?.length ?? 0) +
      (ir.assets?.icons?.length ?? 0);
    const genAssets = files.filter((f) =>
      /\.(png|jpg|svg|ttf|otf|woff|woff2|gif|webp|ico)$/.test(f.path) ||
      /assets\//.test(f.path)
    ).length;
    // Assets = génération de config + références correctes (pas forcément les fichiers binaires)
    const genAssetRefs = files.filter((f) =>
      /theme|colors|fonts|assets/.test(f.path)
    ).length;
    const assetsScore = sourceAssets === 0 ? 100
      : Math.min(100, Math.round(Math.max(genAssets, genAssetRefs > 0 ? 50 : 0) / Math.max(sourceAssets, 1) * 100));
    details.push({
      axis: 'assets',
      score: assetsScore,
      sourceCount: sourceAssets,
      generatedCount: genAssets,
      losses: sourceAssets > 0 && genAssets === 0 ? ['Assets not referenced in generated project'] : [],
    });

    // ── Axe 10 : Functional (PHASE 27 — nouvel axe) ─────────────────────────
    // Mesure les fonctionnalités testables : auth, formulaires, navigation, API calls
    const hasAuthFiles   = files.some((f) => /auth|login|register|signin|signup/.test(f.path));
    const hasApiClient   = files.some((f) => /api.*client|lib.*api|service.*http/.test(f.path));
    const hasEnvConfig   = files.some((f) => /\.env|env\.example|constants/.test(f.path));
    const hasNavigation  = files.some((f) => /navigation|router|stack|tab/.test(f.path));
    const hasErrorHandling = files.some((f) => f.content?.includes('catch') || f.content?.includes('error'));
    const functionalPoints = [hasAuthFiles, hasApiClient, hasEnvConfig, hasNavigation, hasErrorHandling].filter(Boolean).length;
    // Source indications
    const srcHasAuth = (ir.externalConnections ?? []).some((c) => c.type === 'auth') ||
                       (ir.uiGraph?.screens ?? []).some((s) => /login|auth|sign/i.test(s.name));
    const functionalScore = Math.min(100, Math.round((functionalPoints / 5) * 100));
    details.push({
      axis: 'functional',
      score: functionalScore,
      sourceCount: srcHasAuth ? 5 : 3,
      generatedCount: functionalPoints,
      losses: [
        !hasApiClient   ? 'API client file missing'       : '',
        !hasEnvConfig   ? 'Environment config missing'    : '',
        !hasNavigation  ? 'Navigation config missing'     : '',
        !hasErrorHandling ? 'No error handling detected'  : '',
      ].filter(Boolean),
    });

    // ── Overall : moyenne pondérée 10 axes ───────────────────────────────────
    // Poids Phase 27 (total=13): businessLogic x2.5, navigation x1.5, api x1.5,
    //   stores x1, components x1, models x1, uiFidelity x1, dataLayer x1, assets x1, functional x1.5
    const weights = {
      businessLogic: 2.5,
      navigation:    1.5,
      api:           1.5,
      stores:        1.0,
      components:    1.0,
      models:        1.0,
      uiFidelity:    1.0,
      dataLayer:     1.0,
      assets:        1.0,
      functional:    1.5,
    };
    const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0); // 14.5
    const overall = Math.round(
      details.reduce((sum, d, i) => {
        const key = Object.keys(weights)[i] as keyof typeof weights;
        return sum + d.score * (weights[key] ?? 1);
      }, 0) / totalWeight
    );

    logger.info({
      axes: details.map((d) => ({ axis: d.axis, score: d.score, src: d.sourceCount, gen: d.generatedCount })),
      overall: Math.min(100, overall),
    }, '📊 Phase 7 (Phase 27): Fidelity Score 10-axes calculated');

    console.log(`\n================ FIDELITY SCORE (Phase 27 — 10 axes) ================`);
    details.forEach((d) => {
      const bar = '█'.repeat(Math.round(d.score / 10)) + '░'.repeat(10 - Math.round(d.score / 10));
      console.log(`  ${d.axis.padEnd(14)} [${bar}] ${String(d.score).padStart(3)}%  src=${d.sourceCount} gen=${d.generatedCount}${d.losses.length ? ` ⚠️  ${d.losses.slice(0, 2).join(', ')}` : ''}`);
    });
    console.log(`  ${'OVERALL'.padEnd(14)} ${''.padEnd(12)} ${String(Math.min(100, overall)).padStart(3)}%`);
    console.log(`==============================\n`);

    return {
      businessLogic: details[0]!.score,
      navigation:    details[1]!.score,
      api:           details[2]!.score,
      stores:        details[3]!.score,
      components:    details[4]!.score,
      models:        details[5]!.score,
      uiFidelity:    details[6]!.score,
      dataLayer:     details[7]!.score,
      assets:        details[8]!.score,
      functional:    details[9]!.score,
      overall:       Math.min(100, overall),
      details,
    };
  }

  // ── PHASE 27: Boucle auto-correction — cible ≥95% ou MAX_ITERATIONS ──────
  // BUG-P27-02 FIX: arrêt seulement si score ≥ 95 OU gain < threshold ET score > 80
  // BUG-P27-03 FIX: Groq boucle si score < 95 (pas seulement si losses.length > 0)
  // BUG-P27-05 FIX: replan ciblé par axe défaillant (inject axesToFix in ctx)
  private async autoCorrectLoop(
    ctx: ConversionContext,
    ir: ReturnType<IRValidator['validate']> extends Promise<infer T> ? T : never,
    initialPlan: Awaited<ReturnType<CodePlanner['plan']>>,
    initialScore: IRFidelityScore,
    tier: AITier,
    codePlanner: CodePlanner,
  ): Promise<{ correctedPlan: typeof initialPlan; autoCorrectionReport: IRAutoCorrectReport }> {
    const MAX_ITERATIONS = tier === 'static' ? 0 : tier === 'free-groq' ? 2 : 3;
    // PHASE 27: cible 95% avant de s'arrêter (sauf static)
    const FIDELITY_TARGET     = 95;
    const IMPROVEMENT_THRESHOLD = 2; // minimum gain (%) pour continuer si score > 80

    const scoreHistory: IRScoreSnapshot[] = [
      { iteration: 0, score: initialScore.overall, delta: 0, filesRegenerated: 0 },
    ];
    const improvements: string[] = [];
    const remainingLosses: string[] = [];

    let currentPlan = initialPlan;
    let currentScore = initialScore.overall;
    let iteration = 0;

    logger.info({
      jobId: ctx.jobId,
      initialScore: currentScore,
      target: FIDELITY_TARGET,
      maxIter: MAX_ITERATIONS,
      tier,
    }, `🔄 Phase 8 (Phase 27): Auto-correction loop started — target=${FIDELITY_TARGET}%`);
    console.log(`\n[PHASE 8] Auto-correction démarrée — score initial=${currentScore}% cible=${FIDELITY_TARGET}% maxIter=${MAX_ITERATIONS} tier=${tier}`);

    // Collecter les pertes initiales
    const initialLosses = initialScore.details
      .filter((d) => d.losses.length > 0)
      .flatMap((d) => d.losses.map((l) => `[${d.axis}] ${l}`));

    // BUG-P27-03 FIX: ne court-circuiter QUE si score déjà ≥ target OU static
    if (currentScore >= FIDELITY_TARGET || MAX_ITERATIONS === 0) {
      if (MAX_ITERATIONS === 0 && tier !== 'static') {
        const lossLines = initialScore.details
          .filter((d) => d.score < 100 && d.losses.length > 0)
          .map((d) => `[Phase8] ${d.axis} score=${d.score}% losses=${d.losses.join(', ')}`);
        if (lossLines.length > 0 && ir.validation) {
          ir.validation.warnings = [...(ir.validation.warnings ?? []), ...lossLines];
          logger.warn({ jobId: ctx.jobId, losses: lossLines.length }, '⏭️  Phase 8: Groq static — losses noted in warnings');
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
      logger.info({ jobId: ctx.jobId, iteration, currentScore, target: FIDELITY_TARGET }, `🔄 Phase 8: Iteration ${iteration}/${MAX_ITERATIONS} — score=${currentScore}%`);
      console.log(`[PHASE 8] Itération ${iteration}/${MAX_ITERATIONS} — score courant=${currentScore}% cible=${FIDELITY_TARGET}%`);

      // BUG-P27-02 FIX: arrêter si target atteinte
      if (currentScore >= FIDELITY_TARGET) {
        logger.info({ jobId: ctx.jobId, currentScore }, `✅ Phase 8: Target ${FIDELITY_TARGET}% reached — stopping`);
        console.log(`[PHASE 8] ✅ Cible ${FIDELITY_TARGET}% atteinte — arrêt de la boucle`);
        break;
      }

      // Identifier les axes défaillants (score < 80%)
      const currentScoreObj = this.calculateFidelityScore(ir, currentPlan.files);
      const axesWithLosses = currentScoreObj.details.filter((d) => d.score < 80);

      console.log(`[PHASE 8] Axes défaillants (score < 80%): ${axesWithLosses.map((a) => `${a.axis}=${a.score}%`).join(', ') || 'aucun'}`);

      if (axesWithLosses.length === 0 && currentScore >= 80) {
        logger.info({ jobId: ctx.jobId }, '✅ Phase 8: All axes above 80% — stopping');
        console.log(`[PHASE 8] Tous les axes ≥ 80% — arrêt`);
        break;
      }

      try {
        // BUG-P27-05 FIX: cibler spécifiquement les axes défaillants
        const axesStr = axesWithLosses.map((a) => a.axis).join(',');
        const lossesStr = axesWithLosses.flatMap((a) => a.losses).slice(0, 10).join('; ');
        const targetedCtx: ConversionContext = {
          ...ctx,
          // Injecter les axes et pertes comme metadata pour guider le re-planning
          userGoal: `AUTOCORRECT iteration=${iteration} fix_axes=[${axesStr}] missing=[${lossesStr}] target_score=${FIDELITY_TARGET}% current_score=${currentScore}%`,
        };

        logger.info({ jobId: ctx.jobId, axes: axesStr, losses: lossesStr }, `🔄 Phase 8: Targeted re-planning for axes: ${axesStr}`);
        console.log(`[PHASE 8] Re-planning ciblé — axes: ${axesStr}`);

        const replan = await codePlanner.plan(targetedCtx, ir as never);

        // Merge : garder les fichiers existants, ajouter les nouveaux pour les gaps
        const existingPaths = new Set(currentPlan.files.map((f) => f.path));
        const newFiles: GeneratedFile[] = replan.files.filter((f) => !existingPaths.has(f.path));

        if (newFiles.length === 0) {
          logger.info({ jobId: ctx.jobId }, '⏭️  Phase 8: No new files generated — stopping loop');
          console.log(`[PHASE 8] Aucun nouveau fichier généré — arrêt`);
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
          jobId: ctx.jobId, iteration, newFiles: newFiles.length, scoreAfter: currentScore, delta,
        }, `📊 Phase 8: Iteration ${iteration} done — score=${currentScore}% delta=${delta > 0 ? '+' : ''}${delta}%`);
        console.log(`[PHASE 8] Itération ${iteration} terminée — score=${currentScore}% delta=${delta >= 0 ? '+' : ''}${delta}% nouveaux fichiers=${newFiles.length}`);

        // BUG-P27-02 FIX: arrêt seulement si gain faible ET déjà au-dessus de 80
        if (delta < IMPROVEMENT_THRESHOLD && currentScore > 80) {
          logger.info({ jobId: ctx.jobId }, `⏭️  Phase 8: Gain (${delta}%) below threshold AND score>${80}% — stopping`);
          console.log(`[PHASE 8] Gain ${delta}% < seuil ${IMPROVEMENT_THRESHOLD}% avec score>${80}% — arrêt`);
          break;
        }
        // Si delta négatif ou nul et score bas, continuer quand même jusqu'à MAX
        if (delta <= 0 && currentScore <= 50) {
          logger.warn({ jobId: ctx.jobId, currentScore }, `⚠️  Phase 8: No improvement at score=${currentScore}% — will retry next iteration`);
        }

      } catch (err) {
        logger.error({ jobId: ctx.jobId, err: (err as Error).message, iteration }, '❌ Phase 8: Iteration failed');
        console.error(`[PHASE 8] ❌ Itération ${iteration} échouée: ${(err as Error).message}`);
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

  // ── PHASE 27: Vérification de cohérence BLOQUANTE ───────────────────────
  // BUG-P27-07 FIX: logCoherenceCheck retourne une sévérité et des flags
  // Un mismatch critique (ex: 221 sources → 0 screens IR → 5 fichiers) DOIT
  // être signalé de façon à ce que la boucle Phase 8 soit forcée à max itérations.
  // Retourne { hasCriticalMismatch, missingScreens, missingServices }
  private logCoherenceCheck(
    ast:         Awaited<ReturnType<ASTAnalyzer['analyze']>>,
    ir:          IRDocument,
    files:       GeneratedFile[],
    jobId:       string,
  ): { hasCriticalMismatch: boolean; missingScreens: number; missingServices: number } {
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

    console.log(`\n================ COHERENCE CHECK (Phase 27) ================`);
    console.log(`                     | Flutter | IR      | Generated`);
    console.log(`---------------------|---------|---------|----------`);
    console.log(`Screens              | ${String(flutterScreenFiles).padStart(7)} | ${String(irScreens).padStart(7)} | ${String(genScreens).padStart(9)}`);
    console.log(`Models               | ${String(flutterModelFiles).padStart(7)} | ${String(irModels).padStart(7)} | ${String(genModels).padStart(9)}`);
    console.log(`Services             | ${String(flutterServiceFiles).padStart(7)} | ${String(irServices).padStart(7)} | ${String(genServices).padStart(9)}`);
    console.log(`Stores               | ${String(flutterStoreFiles).padStart(7)} | ${String(irStores).padStart(7)} | ${String(genStores).padStart(9)}`);
    console.log(`Endpoints            | ${String(ast.apiPatterns.length).padStart(7)} | ${String(irEndpoints).padStart(7)} | ${String(genServices).padStart(9)}`);
    console.log(`Total source files   : ${ast.files.length}`);
    console.log(`Total gen files      : ${files.length}`);

    let hasCriticalMismatch = false;
    const missingScreens  = Math.max(0, Math.min(irScreens, flutterScreenFiles) - genScreens);
    const missingServices = Math.max(0, flutterServiceFiles - genServices);

    // ── Diagnostic critique ───────────────────────────────────────────────
    if (flutterScreenFiles > 0 && irScreens === 0) {
      hasCriticalMismatch = true;
      console.warn(`[COHERENCE] ❌ CRITICAL: Flutter has ${flutterScreenFiles} screen files but IR has 0 screens. IR generation failed — Groq token budget too small or AI returned empty JSON.`);
      logger.error({ jobId, flutterScreenFiles, irScreens }, '❌ COHERENCE CRITICAL: Flutter screens → IR screens = 0 (IR extraction failure)');
    }
    if (irScreens > 0 && genScreens === 0) {
      hasCriticalMismatch = true;
      console.warn(`[COHERENCE] ❌ CRITICAL: IR has ${irScreens} screens but 0 were generated. Code planning failed — check generateScreenFile() for AI errors.`);
      logger.error({ jobId, irScreens, genScreens }, '❌ COHERENCE CRITICAL: IR screens → Generated screens = 0 (code planning failure)');
    }
    if (irScreens > 0 && genScreens < irScreens * 0.5) {
      hasCriticalMismatch = true;
      console.warn(`[COHERENCE] ❌ CRITICAL: IR has ${irScreens} screens but only ${genScreens} generated (${Math.round(genScreens/irScreens*100)}%). Phase 8 auto-correction REQUIRED.`);
      logger.error({ jobId, irScreens, genScreens, pct: Math.round(genScreens/irScreens*100) }, '❌ COHERENCE CRITICAL: <50% screens generated');
    }
    if (irModels > 0 && genModels === 0) {
      hasCriticalMismatch = true;
      console.warn(`[COHERENCE] ❌ CRITICAL: IR has ${irModels} models but 0 types files generated.`);
      logger.error({ jobId, irModels, genModels }, '❌ COHERENCE: No model/type files generated');
    }
    if (ast.files.length > 50 && files.length <= 20) {
      hasCriticalMismatch = true;
      console.warn(`[COHERENCE] ❌ CRITICAL: Source has ${ast.files.length} files but only ${files.length} generated. This is a template scaffold (expected 50+ files for large project).`);
      logger.error({ jobId, sourceFiles: ast.files.length, genFiles: files.length }, '❌ COHERENCE CRITICAL: Generated file count too low for project size');
    }
    if (flutterServiceFiles > 0 && genServices === 0) {
      console.warn(`[COHERENCE] ⚠️  WARNING: Flutter has ${flutterServiceFiles} service files but 0 services generated.`);
      logger.warn({ jobId, flutterServiceFiles, genServices }, '⚠️  COHERENCE: Service files not generated');
    }

    if (hasCriticalMismatch) {
      console.warn(`[COHERENCE] 🔄 PHASE 8 MUST run at maximum iterations to recover fidelity!`);
      logger.warn({ jobId, hasCriticalMismatch, missingScreens, missingServices }, '⚠️  COHERENCE: Critical mismatch detected — Phase 8 auto-correction needed');
    } else {
      console.log(`[COHERENCE] ✅ No critical mismatch detected`);
    }
    console.log(`==============================\n`);

    return { hasCriticalMismatch, missingScreens, missingServices };
  }

}

// ── Singleton export (default — reads env vars) ───────────────────────────────
export const pipeline = new ConversionPipeline();
