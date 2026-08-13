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
// PHASE FINALE: Nouveaux modules (5, 4, 8, 9)
import { compileDartFiles }         from './dart-compiler';
import { packageToZip }             from './zip-packager';
import { buildConversionReport, formatConversionReport } from './conversion-report';
import { extractDesignSystem, generateThemeFiles }       from './ui-fidelity-extractor';
import { detectSourceLayers, summarizeLayerPresence }    from './layer-detector';
import type { CompilationResult }   from './dart-compiler';
import type { ZipPackageResult }    from './zip-packager';
import type { ConversionReport }    from './conversion-report';
import type { LayerDetectionResult } from './layer-detector';
// ── NEW PHASES: Application Spec, Content Validation, Delivery Check ─────────
import { buildApplicationSpec, summarizeSpecForPrompt }  from './application-spec-builder';
import { validateAllFiles, formatContentReport }          from './content-validator';
import { runStaticValidationSync }                        from './static-validator';
import { runDeliveryCheck, formatDeliveryReport }         from './delivery-checker';
import { buildFunctionalTestResults, formatTestResultsReport } from './functional-test-runner';
import type {
  ApplicationSpec, ContentValidationReport,
  DeliveryCheckResult, TestResultsReport,
} from '../models/ir.types';

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
  // ── FIX "sourceCode tronqué" — Résumé structurel statique ─────────────
  // Analyse le sourceCode complet (non tronqué) pour extraire les compteurs
  // importants. Ce résumé est préservé même après la troncature et sera
  // injecté dans le contexte de l'IR generator pour éviter les "0 screens".
  private buildStructuralSummary(sourceCode: string): string {
    const lines = sourceCode.split('\n');
    const allPaths: string[] = [];

    // Extraire les chemins depuis les marqueurs "// === FILE: path ==="
    const fileMarker = /\/\/\s*=+\s*FILE:\s*(.+?)\s*=+/;
    for (const line of lines) {
      const m = line.match(fileMarker);
      if (m?.[1]) allPaths.push(m[1].trim());
    }

    // Compteurs par type
    const count = (patterns: RegExp[]): number =>
      allPaths.filter((p) => patterns.some((pat) => pat.test(p))).length;

    const screens    = count([/screen|page|view/i]);
    const widgets    = count([/widget|component/i]);
    const services   = count([/service/i]);
    const repos      = count([/repo/i]);
    const stores     = count([/store|bloc|cubit|provider|notifier|slice|atom/i]);
    const models     = count([/model|entity|dto|schema/i]);
    const api        = count([/api|network|http|remote|client/i]);
    const assets     = count([/assets?|images?|fonts?|icons?/i]);
    const navigation = count([/navigation|router|routing|routes?|stack/i]);
    const migrations = count([/migration|seed/i]);

    // Détecter framework à partir des extensions
    const hasDart  = allPaths.some((p) => p.endsWith('.dart'));
    const hasTsx   = allPaths.some((p) => p.endsWith('.tsx') || p.endsWith('.jsx'));
    const hasVue   = allPaths.some((p) => p.endsWith('.vue'));
    const framework = hasDart ? 'flutter' : hasVue ? 'vue' : hasTsx ? 'react/rn' : 'unknown';

    // Patterns de contenu (limités aux 50 000 premiers chars pour rapidité)
    const codeSlice    = sourceCode.slice(0, 50_000);
    const httpCalls    = (codeSlice.match(/fetch\s*\(|axios\.|http\.(get|post)|dio\.(get|post)/g) ?? []).length;
    const stateSignals = [
      /StateNotifierProvider/.test(codeSlice) ? 'Riverpod' : '',
      /extends Bloc</.test(codeSlice) ? 'Bloc' : '',
      /extends Cubit</.test(codeSlice) ? 'Cubit' : '',
      /ChangeNotifierProvider/.test(codeSlice) ? 'Provider' : '',
      /zustand/.test(codeSlice) ? 'Zustand' : '',
      /createStore\(/.test(codeSlice) ? 'Redux' : '',
    ].filter(Boolean);

    const summary = [
      `STRUCTURAL_SUMMARY (pre-truncation):`,
      `  framework=${framework}  totalFiles=${allPaths.length}`,
      `  screens=${screens}  components=${widgets}  services=${services}`,
      `  repos=${repos}  stores=${stores}  models=${models}`,
      `  api=${api}  assets=${assets}  navigation=${navigation}  migrations=${migrations}`,
      `  httpCalls=${httpCalls}  stateManagement=[${stateSignals.join(', ')}]`,
    ].join('\n');

    return summary;
  }

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

    // ── FIX "sourceCode tronqué" — étape 1 : résumé structurel avant truncation ──
    // Construire le résumé structurel AVANT d'appliquer les limites, pour préserver
    // les compteurs screens/services/stores même si le code est tronqué.
    ctx.structuralSummary = this.buildStructuralSummary(ctx.sourceCode);
    console.log(`[PIPELINE] Structural summary built BEFORE truncation: ${ctx.structuralSummary.slice(0, 200)}`);

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

    // ── PHASE 2.5: Application Spec Builder (Phases 1-3 du cahier des charges) ─
    // RÈGLE ABSOLUE: Construire la spec AVANT toute génération de fichiers.
    // La spec devient la source de vérité pour toute la reconstruction.
    logger.info({ jobId: ctx.jobId }, '📋 Phase 2.5: Application Spec Builder (exhaustive source analysis)');
    let appSpec: ApplicationSpec | undefined;
    try {
      appSpec = buildApplicationSpec(
        ctx.sourceCode,
        astResult,
        archResult,
        // Pass minimal IR result proxy (real IR not yet built — use AST/arch data)
        { ir: { uiGraph: { screens: [], components: [], navigationFlow: [], stateFlow: [] }, backendGraph: { routes: [], services: [], entities: [], middlewares: [] }, dataLayer: { models: [], relationships: [], migrations: [] }, projectMeta: { name: ctx.projectId, type: 'mobile', sourceStack: ctx.sourceFramework ?? '', targetStack: ctx.targetFramework ?? '', complexityScore: 50, sourceFiles: astResult.files.length, totalLines: 0, detectedFrameworks: [] }, architecture: { modules: [], layers: [], patterns: [] }, dependencyMap: { keep: [], replace: [], add: [], remove: [] }, conversionPlan: [], validation: { buildable: true, testsRequired: false, riskLevel: 'medium' } }, tokensUsed: 0 },
        { sourceFramework: ctx.sourceFramework ?? '', targetFramework: ctx.targetFramework ?? '', projectId: ctx.projectId },
      );
      // Inject spec summary into context for downstream AI calls
      const specSummary = summarizeSpecForPrompt(appSpec);
      ctx.structuralSummary = (ctx.structuralSummary ?? '') + '\n\n' + specSummary;
      console.log(`[PIPELINE] Phase 2.5: AppSpec built — ${appSpec.screens.length} screens, ${appSpec.api.endpoints.length} endpoints, baseUrl=${appSpec.api.baseUrl || '(none)'}`);
    } catch (specErr) {
      console.warn(`[PIPELINE] Phase 2.5: AppSpec build failed — ${(specErr as Error).message} (continuing without spec)`);
    }
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
      const quickScreenCount = plan.files.filter((f) => /\/(screens?|pages?|views?)\//.test(f.path)).length;
      if (quickScreenCount > 0) {
        pipelineCache.planCache.set(planCacheKey, plan);
      }
    }
    phaseEnd('planning');

    // ── LOG STRUCTURÉ: RESULT (après planning) ────────────
    const _isFlutterPlan = plan.files.some((f) => /\.dart$/.test(f.path));
    const genScreens    = plan.files.filter((f) => _isFlutterPlan
      ? /\/(screens?|pages?)\/[^/]+\.dart$/.test(f.path)
      : /\/(screens?|pages?|app)\/[^/]+\.(tsx?|jsx?)$/.test(f.path) && !/_layout|index|tabs/.test(f.path)
    ).length;
    const genComponents = plan.files.filter((f) => _isFlutterPlan
      ? /\/(widgets?)\/[^/]+\.dart$/.test(f.path)
      : /\/components\/[^/]+\.(tsx?|jsx?)$/.test(f.path)
    ).length;
    const genStores     = plan.files.filter((f) => _isFlutterPlan
      ? /\/(blocs?|providers?|cubits?)\/[^/]+\.dart$/.test(f.path)
      : /\.store\.(ts|js)$/.test(f.path)
    ).length;
    const genServices   = plan.files.filter((f) => _isFlutterPlan
      ? /\/services\/[^/]+\.dart$/.test(f.path)
      : /\.service\.(ts|js)$/.test(f.path)
    ).length;
    const genModels     = plan.files.filter((f) => _isFlutterPlan
      ? /\/models?\/[^/]+\.dart$/.test(f.path)
      : /\.types\.(ts|js)$/.test(f.path) || /\/types\//.test(f.path)
    ).length;
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

    // ── PHASE 6.5: Layer Detection (SOURCE_PRESENT par couche) ──────────────
    // Doit être exécuté avant le calcul du score pour passer layerDetection
    logger.info({ jobId: ctx.jobId }, '🔍 Phase 6.5: Source Layer Detection');
    const layerDetection = detectSourceLayers(ctx.sourceCode, astResult, archResult);
    console.log(`\n================ LAYER DETECTION ================`);
    console.log(summarizeLayerPresence(layerDetection));
    console.log(`=================================================\n`);

    // ── PHASE 7: Fidelity Score multi-axes (N/A-aware) ─────────────────────
    logger.info({ jobId: ctx.jobId, tier }, '📐 Phase 7: Fidelity Score Calculation (N/A-aware)');
    const fidelityScore = this.calculateFidelityScore(validatedIR, plan.files, layerDetection);
    logger.info({
      jobId: ctx.jobId,
      overall:        fidelityScore.overall,
      businessLogic:  fidelityScore.businessLogic,
      navigation:     fidelityScore.navigation,
      api:            fidelityScore.api,
      stores:         fidelityScore.stores,
      uiFidelity:     fidelityScore.uiFidelity,
      applicableAxes: fidelityScore.applicableAxes,
      naAxes:         fidelityScore.naAxes,
    }, `📊 Phase 7: Fidelity Score — Overall: ${fidelityScore.overall}% (${fidelityScore.applicableAxes.length} axes applicables, ${fidelityScore.naAxes.length} N/A)`);

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

    // ── PHASE 6 (NOUVEAU): Content Validation — SHELL file detection ─────────
    // RÈGLE ABSOLUE: Un fichier SHELL_401 ne compte JAMAIS comme converti.
    logger.info({ jobId: ctx.jobId }, '🔬 Phase 6-CV: Content Validation (SHELL detection)');
    const contentValidation: ContentValidationReport = validateAllFiles(
      finalFiles,
      ctx.sourceLanguage ?? 'dart',
    );
    console.log(formatContentReport(contentValidation));

    // ── PHASE 7 (NOUVEAU): Static Validation ─────────────────────────────────
    logger.info({ jobId: ctx.jobId }, '✅ Phase 7-SV: Static Validation');
    void runStaticValidationSync; // Phase 7 static validation is run in Phase 12 block below

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
    // CORRECTION SHELL-AWARE: pénaliser les axes dont les fichiers sont SHELL_401
    const comparatorBonus = fidelityComparison.scores.overall;

    // Compute shell-aware adjustments
    const shellServicesRatio = contentValidation.totalFiles > 0
      ? contentValidation.files
          .filter((f) => f.status === 'shell_401' && /service/i.test(f.path)).length /
          Math.max(1, contentValidation.files.filter((f) => /service/i.test(f.path)).length)
      : 0;
    const shellStoresRatio = contentValidation.totalFiles > 0
      ? contentValidation.files
          .filter((f) => f.status === 'shell_401' && /store/i.test(f.path)).length /
          Math.max(1, contentValidation.files.filter((f) => /store/i.test(f.path)).length)
      : 0;
    const shellModelsRatio = contentValidation.totalFiles > 0
      ? contentValidation.files
          .filter((f) => f.status === 'shell_401' && /types|model/i.test(f.path)).length /
          Math.max(1, contentValidation.files.filter((f) => /types|model/i.test(f.path)).length)
      : 0;

    const finalFidelityScore: IRFidelityScore = {
      ...autoCorrectionReport.finalScore > fidelityScore.overall
        ? { ...fidelityScore, overall: autoCorrectionReport.finalScore }
        : fidelityScore,
      // Shell-aware axis overrides: if >50% of files for an axis are SHELL_401 → 0%
      services: (fidelityScore.services !== null && shellServicesRatio > 0.5) ? 0 : (
        fidelityScore.services !== null
          ? Math.round(((fidelityScore.services ?? 0) + fidelityComparison.scores.services) / 2)
          : null
      ),
      stores: (fidelityScore.stores !== null && shellStoresRatio > 0.5) ? 0 : fidelityScore.stores,
      models: (fidelityScore.models !== null && shellModelsRatio > 0.5) ? 0 : (
        fidelityScore.models !== null
          ? Math.round(((fidelityScore.models ?? 0) + fidelityComparison.scores.models) / 2)
          : null
      ),
      // Intégrer les données du comparateur dans les axes existants (N/A-safe)
      businessLogic: fidelityScore.businessLogic !== null
        ? Math.round(((fidelityScore.businessLogic ?? 0) + fidelityComparison.scores.services) / 2)
        : null,
      api: fidelityScore.api !== null
        ? (shellServicesRatio > 0.8 ? 0 : Math.round(((fidelityScore.api ?? 0) + fidelityComparison.scores.repositories) / 2))
        : null,
      overall: Math.round((
        (autoCorrectionReport.finalScore > fidelityScore.overall ? autoCorrectionReport.finalScore : fidelityScore.overall) * 0.6
        + comparatorBonus * 0.4
      )),
    };

    // CORRECTION: Recalculate overall from shell-aware axes
    {
      const weights: Record<string, number> = { businessLogic: 2.0, navigation: 1.5, api: 1.5, repositories: 1.0, services: 1.0, stores: 1.0, components: 1.0, models: 1.0, uiFidelity: 1.0, dataLayer: 1.0, assets: 0.5, functional: 1.0 };
      let ws = 0, wt = 0;
      for (const ax of fidelityScore.applicableAxes) {
        const score = finalFidelityScore[ax as keyof IRFidelityScore] as number | null;
        if (score !== null && score !== undefined) {
          ws += score * (weights[ax] ?? 1.0);
          wt += weights[ax] ?? 1.0;
        }
      }
      if (wt > 0) finalFidelityScore.overall = Math.min(100, Math.round(ws / wt));
    }

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

    // ── PHASE 4 FINALE: UI Fidelity Extractor ───────────────────────────────
    // Extraire les tokens de design depuis les fichiers source
    // et les injecter dans les fichiers générés si thème manquant
    logger.info({ jobId: ctx.jobId }, '🎨 Phase Finale 4: UI Fidelity Extraction');
    let enhancedFiles = finalFiles;
    try {
      // Parser les fichiers source pour extraire les tokens
      const sourceFileBlocks: { path: string; content: string }[] = [];
      const filePattern = /\/\/\s*(?:=+\s*)?FILE:\s*(.+?)(?:\s*=+)?\n([\s\S]*?)(?=\/\/\s*(?:=+\s*)?FILE:|$)/g;
      let fmatch: RegExpExecArray | null;
      while ((fmatch = filePattern.exec(ctx.sourceCode)) !== null) {
        const p = (fmatch[1] ?? '').trim();
        const c = (fmatch[2] ?? '').trim();
        if (p && c) sourceFileBlocks.push({ path: p, content: c });
      }

      if (sourceFileBlocks.length > 0) {
        const designSystem = extractDesignSystem(sourceFileBlocks);
        const themeFilesGenerated = generateThemeFiles(designSystem, ctx.targetFramework ?? '');

        // Ajouter les fichiers de thème seulement s'ils ne sont pas déjà présents
        for (const tf of themeFilesGenerated) {
          const alreadyPresent = finalFiles.some((f) => f.path === tf.path);
          if (!alreadyPresent && tf.content) {
            enhancedFiles = [...enhancedFiles, tf];
            console.log(`[PIPELINE] Phase 4 UI: Added theme file → ${tf.path}`);
          }
        }
        if (themeFilesGenerated.length > 0) {
          console.log(`[PIPELINE] Phase 4 UI: Design system extracted — ${designSystem.colors.length} colors, ${designSystem.typography.length} fonts, ${themeFilesGenerated.length} theme files`);
        }
      }
    } catch (uiErr) {
      console.warn(`[PIPELINE] Phase 4 UI: Extraction skipped — ${(uiErr as Error).message}`);
    }

    // ── PHASE 5 FINALE: Compilation Dart/Flutter ─────────────────────────────
    logger.info({ jobId: ctx.jobId }, '🔨 Phase Finale 5: Dart/Flutter Compilation');
    let compilationResult: CompilationResult | undefined;
    const isFlutterTarget = enhancedFiles.some((f) => /\.dart$/.test(f.path));
    if (isFlutterTarget) {
      try {
        compilationResult = await compileDartFiles(enhancedFiles, ctx.projectId ?? 'project');
        enhancedFiles = compilationResult.fixedFiles.length > 0 ? compilationResult.fixedFiles : enhancedFiles;
        console.log(`[PIPELINE] Phase 5 Dart: success=${compilationResult.success} errors=${compilationResult.errors.length} warnings=${compilationResult.warnings.length} fixed=${compilationResult.filesFixed} dartAvail=${compilationResult.dartAvailable}`);
      } catch (compErr) {
        console.warn(`[PIPELINE] Phase 5 Dart: Compilation skipped — ${(compErr as Error).message}`);
      }
    }

    // ── PHASE 8 FINALE: ZIP Packaging ───────────────────────────────────────
    logger.info({ jobId: ctx.jobId }, '📦 Phase Finale 8: ZIP Packaging');
    let zipResult: ZipPackageResult | undefined;
    try {
      zipResult = await packageToZip(
        enhancedFiles,
        ctx.projectId ?? 'output',
        `/tmp/codemorph-${ctx.jobId}`,
      );
      console.log(`[PIPELINE] Phase 8 ZIP: success=${zipResult.success} files=${zipResult.fileCount} bytes=${zipResult.totalBytes} path=${zipResult.zipPath}`);
    } catch (zipErr) {
      console.warn(`[PIPELINE] Phase 8 ZIP: Packaging skipped — ${(zipErr as Error).message}`);
    }

    // ── PHASE 12 (NOUVEAU): Delivery Check — READY vs NEEDS_REPAIR ───────────
    logger.info({ jobId: ctx.jobId }, '🚦 Phase 12: Delivery Check (READY / NEEDS_REPAIR)');
    const finalContentValidation = validateAllFiles(enhancedFiles, ctx.sourceLanguage ?? 'dart');
    const staticVal = runStaticValidationSync(enhancedFiles, ctx.sourceLanguage ?? 'dart');
    const deliveryCheck: DeliveryCheckResult = runDeliveryCheck(
      enhancedFiles,
      finalFidelityScore,
      finalContentValidation,
      {
        tsCompilation:  { attempted: false, success: false, errors: [], warnings: [] },
        brokenImports:  staticVal.brokenImports,
        sourceImports:  staticVal.sourceImports,
        emptyFiles:     staticVal.emptyFiles,
        criticalTodos:  staticVal.criticalTodos,
        undefinedRefs:  staticVal.undefinedRefs,
        missingRoutes:  staticVal.missingRoutes,
        overallPassed:  staticVal.overallPassed,
      },
      appSpec,
    );
    console.log(formatDeliveryReport(deliveryCheck));

    // ── PHASE 9 FINALE: Conversion Report ────────────────────────────────────
    logger.info({ jobId: ctx.jobId }, '📊 Phase Finale 9: Conversion Report');
    let conversionReportData: { text: string; json: string; markdown: string; html: string } | undefined;
    try {
      const report: ConversionReport = buildConversionReport({
        fidelityScore:        finalFidelityScore,
        autoCorrectionReport,
        files:                enhancedFiles,
        ...(compilationResult !== undefined ? { compilationResult } : {}),
        projectName:          ctx.projectId ?? 'project',
        conversionType:       `${ctx.sourceFramework ?? 'unknown'} → ${ctx.targetFramework ?? 'unknown'}`,
        duration:             durationMs,
        aiTier:               tier,
      });

      const { formatConversionReportJSON, formatConversionReportMarkdown, formatConversionReportHTML } = await import('./conversion-report');
      const reportText = formatConversionReport(report);

      // Afficher le rapport dans la console (Phase 9)
      console.log(reportText);

      conversionReportData = {
        text:     reportText,
        json:     formatConversionReportJSON(report),
        markdown: formatConversionReportMarkdown(report),
        html:     formatConversionReportHTML(report),
      };
    } catch (rptErr) {
      console.warn(`[PIPELINE] Phase 9 Report: Generation skipped — ${(rptErr as Error).message}`);
    }

    // ── Phase 8 (fonctionnelle) — Génération test-results.json ───────────────
    const testResults: TestResultsReport = buildFunctionalTestResults(
      enhancedFiles,
      finalFidelityScore,
      finalContentValidation,
      appSpec,
    );
    console.log(formatTestResultsReport(testResults));

    return {
      jobId:      ctx.jobId,
      ir:         validatedIR,
      files:      enhancedFiles,
      summary:    {
        ...correctedPlan.summary,
        totalFiles:      enhancedFiles.length,
        successfulFiles: enhancedFiles.filter((f) => !f.warnings?.length).length,
        totalLines:      enhancedFiles.reduce((a, f) => a + f.content.split('\n').length, 0),
        convertedLines:  enhancedFiles.reduce((a, f) => a + f.content.split('\n').length, 0),
      },
      tokensUsed,
      durationMs,
      // FIX PHASE 20 — Inclure le tier et modèle IA pour affichage côté frontend
      aiTier:  tier,
      aiModel: new AIProvider(opts).getModel(),
      // ── PHASE 23/28: Score fidélité composite + rapport auto-correction ─────
      fidelityScore:        finalFidelityScore,
      autoCorrectionReport,
      // ── PHASE 2.5 (NOUVEAU): ApplicationSpec — source de vérité ─────────────
      ...(appSpec !== undefined ? { applicationSpec: appSpec } : {}),
      // ── PHASE 6 (NOUVEAU): Content Validation — SHELL detection ─────────────
      contentValidation: finalContentValidation,
      // ── PHASE 12 (NOUVEAU): Delivery Check — READY / NEEDS_REPAIR ───────────
      deliveryCheck,
      // ── PHASE 8 fonctionnelle (NOUVEAU): Résultats des tests fonctionnels ────
      testResults,
      // ── PHASE FINALE: Compilation, ZIP, Rapport ─────────────────────────────
      ...(compilationResult ? {
        compilationResult: {
          success:          compilationResult.success,
          errorsCount:      compilationResult.errors.length,
          warningsCount:    compilationResult.warnings.length,
          filesFixed:       compilationResult.filesFixed,
          dartAvailable:    compilationResult.dartAvailable,
          flutterAvailable: compilationResult.flutterAvailable,
          duration:         compilationResult.duration,
        },
      } : {}),
      ...(zipResult ? {
        zipResult: {
          success:    zipResult.success,
          zipPath:    zipResult.zipPath,
          fileCount:  zipResult.fileCount,
          totalBytes: zipResult.totalBytes,
          duration:   zipResult.duration,
          ...(zipResult.error !== undefined ? { error: zipResult.error } : {}),
        },
      } : {}),
      ...(conversionReportData ? { conversionReport: conversionReportData } : {}),
    };
  }

  // ── PHASE 27 (v2): Calcul du score de fidélité N/A-aware ─────────────────
  //
  // REFACTORING SESSION 2 — Corrections fondamentales :
  //   BUG-01 FIXED: safeRatio/strictRatio src=0 → 100 supprimé
  //   BUG-02 FIXED: Navigation absence → N/A (plus 80/50 fabricé)
  //   BUG-03 FIXED: API Math.max(1,...) supprimé → 0 endpoint = N/A réel
  //   BUG-04 FIXED: dataLayer src=0 → 100 supprimé → N/A
  //   BUG-05 FIXED: assets src=0 → N/A
  //   BUG-06 FIXED: Overall calculé UNIQUEMENT sur axes applicables
  //   BUG-07 FIXED: businessLogic IR=0 → N/A (pas 0%) si pas de signal source
  //
  // Nouvelles règles :
  //   1. detectSourceLayers() détermine SOURCE_PRESENT par couche
  //   2. Si SOURCE_PRESENT = false → score = null, status = 'na'
  //   3. Overall = somme_pondérée(applicables) / poids_applicables
  //   4. Pipeline trace : SOURCE→AST→IR→PLANNED→GENERATED→VALIDATED
  private calculateFidelityScore(
    ir: Awaited<ReturnType<IRValidator['validate']>>,
    files: GeneratedFile[],
    layerDetection?: LayerDetectionResult,
  ): IRFidelityScore {
    const sourceMetrics: IRSourceMetrics | undefined = ir.validation?.sourceMetrics;
    const details: IRFidelityDetail[] = [];

    // ── Détection de la présence des couches ──────────────────────────────
    // Si layerDetection est fourni (depuis run()), on l'utilise directement.
    // Sinon, on fait une détection basique à partir de l'IR.
    const presence = layerDetection?.presence ?? {
      businessLogic: (ir.uiGraph?.screens?.length ?? 0) > 0,
      navigation:    (ir.uiGraph?.navigationFlow?.length ?? 0) > 0 || (ir.uiGraph?.screens?.length ?? 0) >= 2,
      api:           (ir.backendGraph?.routes?.length ?? 0) > 0,
      repositories:  false,
      services:      (ir.backendGraph?.routes?.length ?? 0) > 0,
      stores:        (ir.uiGraph?.stateFlow?.length ?? 0) > 0,
      components:    (ir.uiGraph?.components?.length ?? 0) > 0,
      models:        (ir.dataLayer?.models?.length ?? 0) > 0,
      uiFidelity:    (ir.uiGraph?.screens?.length ?? 0) > 0,
      dataLayer:     (ir.dataLayer?.models?.length ?? 0) > 0 || (ir.dataLayer?.migrations?.length ?? 0) > 0,
      assets:        ((sourceMetrics?.assetsCount ?? 0) + (ir.assets?.images?.length ?? 0)) > 0,
      functional:    true,
    };
    const lCounts = layerDetection?.counts;

    // ── Helpers N/A-aware ────────────────────────────────────────────────────
    // RÈGLE : si la couche est absente (sourcePresent=false) → retourne null (N/A)
    // Sinon calcule un ratio réel.
    const nawareRatio = (gen: number, src: number, sourcePresent: boolean): number | null => {
      if (!sourcePresent) return null;  // N/A
      if (src === 0) return null;       // N/A (pas de source mesurable)
      if (gen === 0) return 0;          // 0% : couche présente mais rien généré
      return Math.min(100, Math.round((gen / src) * 100));
    };
    // (helper nawareQualScore supprimé — inline dans chaque axe à la place)

    // Flutter target detection
    const isFlutterTarget = files.some((f) => /\.dart$/.test(f.path));
    const screenPattern = isFlutterTarget
      ? /\/(screens?|pages?|views?)\/[^/]+\.dart$/
      : /\/(screens?|pages?|app)\/[^/]+\.tsx?$/;
    const screenExclude = isFlutterTarget
      ? /loading|error|empty|splash_screen/
      : /layout|index|\(tabs\)/;
    const generatedScreenCount = files.filter((f) =>
      screenPattern.test(f.path) && !screenExclude.test(f.path)
    ).length;

    // ── Axe 1 : Business Logic ───────────────────────────────────────────────
    // SOURCE_PRESENT : use cases / domain / significant logic exists in source
    // Si IR a 0 screens ET source has no business logic signal → N/A
    const sourceScreens    = sourceMetrics?.screensCount ?? (ir.uiGraph?.screens?.length ?? 0);
    const screensWithLogic = (ir.uiGraph?.screens ?? []).filter((s) =>
      (s as unknown as Record<string, unknown>)['businessLogic'] ||
      (s as unknown as Record<string, unknown>)['apiCalls']
    ).length;
    const bizSourcePresent = presence.businessLogic;
    const bizScore: number | null = bizSourcePresent
      ? (sourceScreens === 0
          ? 0   // IR n'a pas extrait les screens → pénalité réelle (pas N/A car source présente)
          : Math.min(100, Math.round((generatedScreenCount / Math.max(sourceScreens, 1)) * 100)))
      : null;
    const bizLosses = bizSourcePresent && sourceScreens > generatedScreenCount
      ? (ir.uiGraph?.screens ?? []).slice(generatedScreenCount).map((s) => s.name)
      : [];
    const bizNote = bizSourcePresent && sourceScreens === 0
      ? 'WARNING: 0 screens in IR — sourceCode may be truncated or token budget exceeded'
      : undefined;
    const bizDetail: IRFidelityDetail = {
      axis:          'businessLogic',
      score:         bizScore,
      sourcePresent: bizSourcePresent,
      applicable:    bizSourcePresent,
      status:        !bizSourcePresent ? 'na'
                   : bizScore === null ? 'na'
                   : bizScore === 0   ? 'missing'
                   : bizScore < 70    ? 'partial'
                   : 'applicable',
      sourceCount:    Math.max(sourceScreens, screensWithLogic),
      generatedCount: generatedScreenCount,
      losses:         bizLosses,
      pipelineTrace: {
        sourceCount:    Math.max(sourceScreens, screensWithLogic),
        astCount:       lCounts?.screenFiles ?? sourceScreens,
        irCount:        sourceScreens,
        plannedCount:   sourceScreens,
        generatedCount: generatedScreenCount,
        validatedCount: generatedScreenCount,
      },
    };
    if (bizNote) bizDetail.notes = bizNote;
    details.push(bizDetail);

    // ── Axe 2 : Navigation ──────────────────────────────────────────────────
    const sourceNavFlows   = ir.uiGraph?.navigationFlow?.length ?? 0;
    const generatedRouter  = files.filter((f) => /router|navigation|_layout|routes/.test(f.path)).length;
    const navSourcePresent = presence.navigation;
    let navScore: number | null = null;
    if (navSourcePresent) {
      if (sourceNavFlows === 0) {
        // Navigation présente mais IR n'a pas de flows → score basé sur le fichier router généré
        navScore = generatedRouter > 0 ? 70 : 30;
      } else {
        navScore = generatedRouter > 0
          ? Math.min(100, 75 + Math.min(25, Math.round((Math.min(sourceNavFlows, 10) / 10) * 25)))
          : 0;
      }
    }
    details.push({
      axis:          'navigation',
      score:         navScore,
      sourcePresent: navSourcePresent,
      applicable:    navSourcePresent,
      status:        !navSourcePresent ? 'na'
                   : navScore === null ? 'na'
                   : navScore === 0   ? 'missing'
                   : navScore < 70    ? 'partial'
                   : 'applicable',
      sourceCount:    sourceNavFlows,
      generatedCount: generatedRouter,
      losses:         navSourcePresent && generatedRouter === 0 ? ['Navigation router file missing'] : [],
      pipelineTrace: {
        sourceCount:    lCounts?.navigationFiles ?? sourceNavFlows,
        astCount:       lCounts?.navigationFiles ?? sourceNavFlows,
        irCount:        sourceNavFlows,
        plannedCount:   navSourcePresent ? 1 : 0,
        generatedCount: generatedRouter,
        validatedCount: generatedRouter,
      },
    });

    // ── Axe 3 : API Endpoints ────────────────────────────────────────────────
    // FIX CRITIQUE : Math.max(1,...) supprimé → 0 endpoints = N/A
    const sourceEndpoints  = sourceMetrics?.endpointsCount ?? (ir.backendGraph?.routes?.length ?? 0);
    const apiSourcePresent = presence.api;
    const generatedApiServices = files.filter((f) =>
      isFlutterTarget
        ? /_service\.dart$/.test(f.path) || /\/services\/[^/]+\.dart$/.test(f.path)
        : /\.service\.(ts|js)$/.test(f.path) || /\/api\/[^/]+\.(ts|js)$/.test(f.path)
    ).length;
    const apiScore: number | null = nawareRatio(
      generatedApiServices,
      sourceEndpoints > 0 ? Math.ceil(sourceEndpoints / 3) : 0,
      apiSourcePresent,
    );
    details.push({
      axis:          'api',
      score:         apiScore,
      sourcePresent: apiSourcePresent,
      applicable:    apiSourcePresent,
      status:        !apiSourcePresent ? 'na'
                   : apiScore === null  ? 'na'
                   : apiScore === 0     ? 'missing'
                   : apiScore < 70      ? 'partial'
                   : 'applicable',
      sourceCount:    sourceEndpoints,
      generatedCount: generatedApiServices,
      losses:         apiSourcePresent && generatedApiServices === 0 && sourceEndpoints > 0
                        ? ['Service layer entirely missing'] : [],
      pipelineTrace: {
        sourceCount:    lCounts?.httpCallSites ?? sourceEndpoints,
        astCount:       lCounts?.apiFiles ?? sourceEndpoints,
        irCount:        sourceEndpoints,
        plannedCount:   apiSourcePresent ? Math.ceil(sourceEndpoints / 3) : 0,
        generatedCount: generatedApiServices,
        validatedCount: generatedApiServices,
      },
    });

    // ── Axe 4 : Repositories ─────────────────────────────────────────────────
    // NOUVEL AXE explicite (était implicite dans businessLogic avant)
    const sourceRepos   = lCounts?.repositoryFiles ?? 0;
    const repoPresent   = presence.repositories;
    const generatedRepos = files.filter((f) =>
      isFlutterTarget
        ? /\/(repo(?:sitori(?:es|y))?|datasource)\/[^/]+\.dart$/.test(f.path)
        : /\/(repo(?:sitori(?:es|y))?|dao)\/[^/]+\.(ts|js)$/.test(f.path)
    ).length;
    const repoScore: number | null = nawareRatio(generatedRepos, sourceRepos, repoPresent);
    details.push({
      axis:          'repositories',
      score:         repoScore,
      sourcePresent: repoPresent,
      applicable:    repoPresent,
      status:        !repoPresent   ? 'na'
                   : repoScore === null ? 'na'
                   : repoScore === 0   ? 'missing'
                   : repoScore < 70    ? 'partial'
                   : 'applicable',
      sourceCount:    sourceRepos,
      generatedCount: generatedRepos,
      losses:         repoPresent && generatedRepos === 0 && sourceRepos > 0
                        ? ['Repository layer not generated'] : [],
      pipelineTrace: {
        sourceCount:    sourceRepos,
        astCount:       sourceRepos,
        irCount:        sourceRepos,
        plannedCount:   repoPresent ? sourceRepos : 0,
        generatedCount: generatedRepos,
        validatedCount: generatedRepos,
      },
    });

    // ── Axe 5 : Services (frontend services inclus) ──────────────────────────
    // FIX : Services frontend (auth service, storage service...) sont valides même sans API
    const sourceServicesFromCounts = lCounts?.serviceFiles ?? 0;
    const servSourcePresent        = presence.services;
    const allServiceFiles          = files.filter((f) =>
      isFlutterTarget
        ? /_service\.dart$/.test(f.path) || /\/services?\/[^/]+\.dart$/.test(f.path)
        : /\.service\.(ts|js)$/.test(f.path) || /\/services?\/[^/]+\.(ts|js)$/.test(f.path)
    ).length;
    // Pour les services, comparer généré vs source (compté par layer-detector)
    const servScore: number | null = servSourcePresent
      ? (sourceServicesFromCounts === 0
          // IR n'a pas de compte explicite → score qualitatif basé sur les fichiers générés
          ? (allServiceFiles > 0 ? Math.min(100, allServiceFiles * 20) : 0)
          : Math.min(100, Math.round((allServiceFiles / Math.max(sourceServicesFromCounts, 1)) * 100)))
      : null;
    details.push({
      axis:          'services',
      score:         servScore,
      sourcePresent: servSourcePresent,
      applicable:    servSourcePresent,
      status:        !servSourcePresent   ? 'na'
                   : servScore === null   ? 'na'
                   : servScore === 0      ? 'missing'
                   : servScore < 70       ? 'partial'
                   : 'applicable',
      sourceCount:    sourceServicesFromCounts,
      generatedCount: allServiceFiles,
      losses:         servSourcePresent && allServiceFiles === 0 ? ['No service files generated'] : [],
      pipelineTrace: {
        sourceCount:    sourceServicesFromCounts,
        astCount:       lCounts?.serviceFiles ?? sourceServicesFromCounts,
        irCount:        sourceServicesFromCounts,
        plannedCount:   servSourcePresent ? sourceServicesFromCounts : 0,
        generatedCount: allServiceFiles,
        validatedCount: allServiceFiles,
      },
    });

    // ── Axe 6 : Stores ──────────────────────────────────────────────────────
    const sourceStores      = sourceMetrics?.storesCount ?? (ir.uiGraph?.stateFlow?.length ?? 0);
    const storeSourceCount  = Math.max(sourceStores, lCounts?.storeFiles ?? 0);
    const storesSourcePres  = presence.stores;
    const generatedStores   = files.filter((f) =>
      isFlutterTarget
        ? /_bloc\.dart$|_notifier\.dart$|_provider\.dart$/.test(f.path) ||
          /\/(blocs?|providers?|cubits?)\/[^/]+\.dart$/.test(f.path)
        : /\.store\.(ts|js)$/.test(f.path) || /\/stores?\/[^/]+\.(ts|js)$/.test(f.path) ||
          /slice\.(ts|js)$/.test(f.path)
    ).length;
    const storesScore: number | null = nawareRatio(generatedStores, Math.max(storeSourceCount, 1), storesSourcePres);
    // Pour stores présents mais IR count = 0 → score qualitatif si fichiers générés
    const storesFinal: number | null = storesSourcePres && storeSourceCount === 0
      ? (generatedStores > 0 ? Math.min(100, generatedStores * 25) : 0)
      : storesScore;
    details.push({
      axis:          'stores',
      score:         storesFinal,
      sourcePresent: storesSourcePres,
      applicable:    storesSourcePres,
      status:        !storesSourcePres   ? 'na'
                   : storesFinal === null ? 'na'
                   : storesFinal === 0    ? 'missing'
                   : storesFinal < 70     ? 'partial'
                   : 'applicable',
      sourceCount:    storeSourceCount,
      generatedCount: generatedStores,
      losses:         storesSourcePres && sourceStores > generatedStores
                        ? (ir.uiGraph?.stateFlow ?? []).slice(generatedStores).map((sf) => sf.store)
                        : [],
      pipelineTrace: {
        sourceCount:    storeSourceCount,
        astCount:       lCounts?.storeFiles ?? sourceStores,
        irCount:        sourceStores,
        plannedCount:   storesSourcePres ? Math.max(storeSourceCount, 1) : 0,
        generatedCount: generatedStores,
        validatedCount: generatedStores,
      },
    });

    // ── Axe 7 : Components ──────────────────────────────────────────────────
    const sourceComponents    = Math.max(ir.uiGraph?.components?.length ?? 0, lCounts?.componentFiles ?? 0);
    const compSourcePresent   = presence.components;
    const generatedComponents = files.filter((f) =>
      isFlutterTarget
        ? /\/(widgets?|components?)\/[^/]+\.dart$/.test(f.path)
        : /\/components?\/[^/]+\.tsx?$/.test(f.path)
    ).length;
    // Components : si source count = 0 mais presence = true, score qualitatif
    const compScore: number | null = compSourcePresent
      ? (sourceComponents === 0
          ? (generatedComponents > 0 ? Math.min(100, generatedComponents * 15) : 0)
          : Math.min(100, Math.round((generatedComponents / sourceComponents) * 100)))
      : null;
    details.push({
      axis:          'components',
      score:         compScore,
      sourcePresent: compSourcePresent,
      applicable:    compSourcePresent,
      status:        !compSourcePresent ? 'na'
                   : compScore === null  ? 'na'
                   : compScore === 0     ? 'missing'
                   : compScore < 70      ? 'partial'
                   : 'applicable',
      sourceCount:    sourceComponents,
      generatedCount: generatedComponents,
      losses:         compSourcePresent && sourceComponents > 0 && generatedComponents === 0
                        ? ['No component files generated'] : [],
      pipelineTrace: {
        sourceCount:    sourceComponents,
        astCount:       lCounts?.componentFiles ?? sourceComponents,
        irCount:        ir.uiGraph?.components?.length ?? 0,
        plannedCount:   compSourcePresent ? sourceComponents : 0,
        generatedCount: generatedComponents,
        validatedCount: generatedComponents,
      },
    });

    // ── Axe 8 : Models ──────────────────────────────────────────────────────
    const sourceModels    = Math.max(sourceMetrics?.modelsCount ?? 0, ir.dataLayer?.models?.length ?? 0, lCounts?.modelFiles ?? 0);
    const modSourcePresent = presence.models;
    const generatedTypes  = files.filter((f) =>
      isFlutterTarget
        ? /\/models?\/[^/]+\.dart$/.test(f.path) || /\.model\.dart$/.test(f.path)
        : /\.types\.(ts|js)$/.test(f.path) || /\/types\//.test(f.path) || /\.entity\.(ts|js)$/.test(f.path) ||
          /\/models?\/[^/]+\.(ts|js)$/.test(f.path)
    ).length;
    const modScore: number | null = modSourcePresent
      ? (sourceModels === 0
          ? (generatedTypes > 0 ? Math.min(100, generatedTypes * 20) : 0)
          : Math.min(100, Math.round((generatedTypes / sourceModels) * 100)))
      : null;
    details.push({
      axis:          'models',
      score:         modScore,
      sourcePresent: modSourcePresent,
      applicable:    modSourcePresent,
      status:        !modSourcePresent ? 'na'
                   : modScore === null  ? 'na'
                   : modScore === 0     ? 'missing'
                   : modScore < 70      ? 'partial'
                   : 'applicable',
      sourceCount:    sourceModels,
      generatedCount: generatedTypes,
      losses:         modSourcePresent && sourceModels > 0 && generatedTypes === 0
                        ? ['No model/type files generated'] : [],
      pipelineTrace: {
        sourceCount:    sourceModels,
        astCount:       lCounts?.modelFiles ?? sourceModels,
        irCount:        ir.dataLayer?.models?.length ?? 0,
        plannedCount:   modSourcePresent ? sourceModels : 0,
        generatedCount: generatedTypes,
        validatedCount: generatedTypes,
      },
    });

    // ── Axe 9 : UI Fidelity (design tokens + visual structure) ──────────────
    const hasDesignTokens  = !!(ir as IRDocument & { designTokens?: unknown }).designTokens;
    const hasThemeFiles    = files.some((f) => /theme|colors|spacing/.test(f.path));
    const uiSourcePresent  = presence.uiFidelity;
    let uiScore: number | null = null;
    if (uiSourcePresent) {
      uiScore = hasDesignTokens && hasThemeFiles ? 90
              : hasDesignTokens || hasThemeFiles  ? 70
              : generatedScreenCount > 0          ? 50
              : 20;
    }
    details.push({
      axis:          'uiFidelity',
      score:         uiScore,
      sourcePresent: uiSourcePresent,
      applicable:    uiSourcePresent,
      status:        !uiSourcePresent ? 'na'
                   : uiScore === null  ? 'na'
                   : uiScore < 50      ? 'partial'
                   : 'applicable',
      sourceCount:    uiSourcePresent ? 1 : 0,
      generatedCount: hasThemeFiles ? 1 : 0,
      losses:         uiSourcePresent && !hasDesignTokens ? ['Design tokens not extracted from source'] : [],
      pipelineTrace: {
        sourceCount:    uiSourcePresent ? 1 : 0,
        astCount:       uiSourcePresent ? 1 : 0,
        irCount:        hasDesignTokens ? 1 : 0,
        plannedCount:   uiSourcePresent ? 1 : 0,
        generatedCount: hasThemeFiles ? 1 : 0,
        validatedCount: hasThemeFiles ? 1 : 0,
      },
    });

    // ── Axe 10 : Data Layer ──────────────────────────────────────────────────
    // FIX CRITIQUE : src=0 → N/A (plus jamais 100%)
    const sourceEntities      = (ir.dataLayer?.models?.length ?? 0);
    const sourceMigrations    = (ir.dataLayer?.migrations?.length ?? 0);
    const dataSourcePresent   = presence.dataLayer;
    const genEntities         = files.filter((f) => /\.entity\.(ts|js)$/.test(f.path)).length;
    const genMigrations       = files.filter((f) => /migration|migrate/.test(f.path)).length;
    const dataTotal           = sourceEntities + sourceMigrations;
    const dataScore: number | null = nawareRatio(genEntities + genMigrations, dataTotal, dataSourcePresent);
    details.push({
      axis:          'dataLayer',
      score:         dataScore,
      sourcePresent: dataSourcePresent,
      applicable:    dataSourcePresent,
      status:        !dataSourcePresent ? 'na'
                   : dataScore === null  ? 'na'
                   : dataScore === 0     ? 'missing'
                   : dataScore < 70      ? 'partial'
                   : 'applicable',
      sourceCount:    dataTotal,
      generatedCount: genEntities + genMigrations,
      losses:         dataSourcePresent && sourceEntities > 0 && genEntities === 0 ? ['Entity files missing'] : [],
      pipelineTrace: {
        sourceCount:    lCounts?.dataLayerFiles ?? dataTotal,
        astCount:       lCounts?.dataLayerFiles ?? dataTotal,
        irCount:        dataTotal,
        plannedCount:   dataSourcePresent ? dataTotal : 0,
        generatedCount: genEntities + genMigrations,
        validatedCount: genEntities + genMigrations,
      },
    });

    // ── Axe 11 : Assets ─────────────────────────────────────────────────────
    // FIX CRITIQUE : src=0 → N/A (plus jamais 100%)
    const sourceAssets       = (sourceMetrics?.assetsCount ?? 0) +
                               (ir.assets?.images?.length ?? 0) +
                               (ir.assets?.fonts?.length ?? 0) +
                               (ir.assets?.icons?.length ?? 0);
    const assetsSourceCount  = Math.max(sourceAssets, lCounts?.assetFiles ?? 0);
    const assetsPresent      = presence.assets;
    const genAssets          = files.filter((f) =>
      /\.(png|jpg|svg|ttf|otf|woff|woff2|gif|webp|ico)$/.test(f.path) ||
      /assets\//.test(f.path)
    ).length;
    const genAssetRefs       = files.filter((f) => /theme|colors|fonts|assets/.test(f.path)).length;
    // Score hybride : fichiers binaires + références dans les fichiers de config/theme
    let assetsScore: number | null = null;
    if (assetsPresent) {
      if (assetsSourceCount === 0) {
        assetsScore = genAssets > 0 ? 80 : (genAssetRefs > 0 ? 60 : 0);
      } else {
        const rawScore = Math.round(
          Math.max(genAssets, genAssetRefs > 0 ? assetsSourceCount * 0.5 : 0) /
          assetsSourceCount * 100
        );
        assetsScore = Math.min(100, rawScore);
      }
    }
    details.push({
      axis:          'assets',
      score:         assetsScore,
      sourcePresent: assetsPresent,
      applicable:    assetsPresent,
      status:        !assetsPresent      ? 'na'
                   : assetsScore === null ? 'na'
                   : assetsScore === 0    ? 'missing'
                   : assetsScore < 70     ? 'partial'
                   : 'applicable',
      sourceCount:    assetsSourceCount,
      generatedCount: genAssets,
      losses:         assetsPresent && assetsSourceCount > 0 && genAssets === 0
                        ? ['Assets not referenced in generated project'] : [],
      pipelineTrace: {
        sourceCount:    assetsSourceCount,
        astCount:       lCounts?.assetFiles ?? assetsSourceCount,
        irCount:        sourceAssets,
        plannedCount:   assetsPresent ? assetsSourceCount : 0,
        generatedCount: genAssets,
        validatedCount: genAssets,
      },
    });

    // ── Axe 12 : Functional (auth, forms, error handling) ───────────────────
    const hasAuthFiles     = files.some((f) => /auth|login|register|signin|signup/.test(f.path));
    const hasApiClient     = files.some((f) => /api.*client|lib.*api|service.*http/.test(f.path));
    const hasEnvConfig     = files.some((f) => /\.env|env\.example|constants/.test(f.path));
    const hasNavigation    = files.some((f) => /navigation|router|stack|tab/.test(f.path));
    const hasErrorHandling = files.some((f) => f.content?.includes('catch') || f.content?.includes('error'));
    const functionalPoints = [hasAuthFiles, hasApiClient, hasEnvConfig, hasNavigation, hasErrorHandling].filter(Boolean).length;
    const functPresent     = presence.functional;
    const srcHasAuth       = (ir.externalConnections ?? []).some((c) => c.type === 'auth') ||
                             (ir.uiGraph?.screens ?? []).some((s) => /login|auth|sign/i.test(s.name));
    // Source functional points estimés
    const srcFunctPoints   = srcHasAuth ? 5 : 3;
    const functScore: number | null = functPresent
      ? Math.min(100, Math.round((functionalPoints / srcFunctPoints) * 100))
      : null;
    details.push({
      axis:          'functional',
      score:         functScore,
      sourcePresent: functPresent,
      applicable:    functPresent,
      status:        !functPresent       ? 'na'
                   : functScore === null  ? 'na'
                   : functScore === 0     ? 'missing'
                   : functScore < 70      ? 'partial'
                   : 'applicable',
      sourceCount:    srcFunctPoints,
      generatedCount: functionalPoints,
      losses:         [
        functPresent && !hasApiClient   ? 'API client missing'          : '',
        functPresent && !hasEnvConfig   ? 'Environment config missing'  : '',
        functPresent && !hasNavigation  ? 'Navigation config missing'   : '',
        functPresent && !hasErrorHandling ? 'No error handling'         : '',
      ].filter(Boolean),
      pipelineTrace: {
        sourceCount:    srcFunctPoints,
        astCount:       srcFunctPoints,
        irCount:        srcFunctPoints,
        plannedCount:   functPresent ? srcFunctPoints : 0,
        generatedCount: functionalPoints,
        validatedCount: functionalPoints,
      },
    });

    // ── Overall : moyenne pondérée UNIQUEMENT sur axes APPLICABLES ───────────
    // FIX FONDAMENTAL : N/A axes exclus du dénominateur
    const weights: Record<string, number> = {
      businessLogic: 2.0,
      navigation:    1.5,
      api:           1.5,
      repositories:  1.0,
      services:      1.0,
      stores:        1.0,
      components:    1.0,
      models:        1.0,
      uiFidelity:    1.0,
      dataLayer:     1.0,
      assets:        0.5,
      functional:    1.0,
    };

    let weightedSum   = 0;
    let applicableW   = 0;
    const applicableAxes: string[] = [];
    const naAxes:         string[] = [];

    for (const d of details) {
      const w = weights[d.axis] ?? 1.0;
      if (d.applicable && d.score !== null) {
        weightedSum   += d.score * w;
        applicableW   += w;
        applicableAxes.push(d.axis);
      } else {
        naAxes.push(d.axis);
      }
    }

    const overall = applicableW > 0
      ? Math.min(100, Math.round(weightedSum / applicableW))
      : 0;

    // ── Logging ──────────────────────────────────────────────────────────────
    logger.info({
      axes:           details.map((d) => ({ axis: d.axis, score: d.score, applicable: d.applicable, src: d.sourceCount, gen: d.generatedCount })),
      overall,
      applicableCount: applicableAxes.length,
      naCount:         naAxes.length,
      framework:       lCounts?.detectedFramework ?? 'unknown',
    }, '📊 Phase 7 (v2 N/A-aware): Fidelity Score calculated');

    // ── Console display ───────────────────────────────────────────────────────
    const fmtScore = (s: number | null): string =>
      s === null ? '  N/A' : `${String(s).padStart(3)}%`;

    console.log(`\n================ FIDELITY SCORE ================`);
    console.log(`  Framework   : ${lCounts?.detectedFramework ?? 'unknown'}`);
    if ((lCounts?.stateManagements?.length ?? 0) > 0) {
      console.log(`  State Mgmt  : ${lCounts!.stateManagements.join(', ')}`);
    }
    console.log('');
    for (const d of details) {
      const scoreStr = fmtScore(d.score);
      const barLen   = d.score === null ? 0 : Math.round(d.score / 10);
      const bar      = d.applicable
        ? '█'.repeat(barLen) + '░'.repeat(10 - barLen)
        : '──────────';
      const warn     = d.losses.length > 0 ? ` ⚠️  ${d.losses.slice(0, 2).join(', ')}` : '';
      console.log(`  ${d.axis.padEnd(14)} [${bar}] ${scoreStr}  src=${d.sourceCount} gen=${d.generatedCount}${warn}`);
    }
    console.log('');
    console.log(`  ${'OVERALL'.padEnd(14)} [${'═'.repeat(10)}] ${String(overall).padStart(3)}%  (${applicableAxes.length} axes applicables, ${naAxes.length} N/A)`);
    console.log(`=================================================\n`);
    if (naAxes.length > 0) {
      console.log(`  Axes N/A    : ${naAxes.join(', ')}`);
      console.log(`  Score calculé sur : ${applicableAxes.join(', ')}\n`);
    }

    return {
      businessLogic: details.find((d) => d.axis === 'businessLogic')?.score ?? null,
      navigation:    details.find((d) => d.axis === 'navigation')?.score    ?? null,
      api:           details.find((d) => d.axis === 'api')?.score           ?? null,
      repositories:  details.find((d) => d.axis === 'repositories')?.score ?? null,
      services:      details.find((d) => d.axis === 'services')?.score      ?? null,
      stores:        details.find((d) => d.axis === 'stores')?.score        ?? null,
      components:    details.find((d) => d.axis === 'components')?.score    ?? null,
      models:        details.find((d) => d.axis === 'models')?.score        ?? null,
      uiFidelity:    details.find((d) => d.axis === 'uiFidelity')?.score    ?? null,
      dataLayer:     details.find((d) => d.axis === 'dataLayer')?.score     ?? null,
      assets:        details.find((d) => d.axis === 'assets')?.score        ?? null,
      functional:    details.find((d) => d.axis === 'functional')?.score    ?? null,
      overall,
      applicableAxes,
      naAxes,
      ...(lCounts ? { detectedFramework: lCounts.detectedFramework } : {}),
      ...(lCounts?.stateManagements?.length ? { stateManagements: lCounts.stateManagements } : {}),
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
          .filter((d) => d.applicable && (d.score ?? 100) < 100 && d.losses.length > 0)
          .map((d) => `[Phase8] ${d.axis} score=${d.score ?? 'N/A'}% losses=${d.losses.join(', ')}`);
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

      // Identifier les axes défaillants (applicable + score < 80%)
      const currentScoreObj = this.calculateFidelityScore(ir, currentPlan.files);
      const axesWithLosses = currentScoreObj.details.filter((d) => d.applicable && (d.score ?? 0) < 80);

      console.log(`[PHASE 8] Axes défaillants (score < 80%): ${axesWithLosses.map((a) => `${a.axis}=${a.score}%`).join(', ') || 'aucun'}`);

      if (axesWithLosses.length === 0 && currentScore >= 80) {
        logger.info({ jobId: ctx.jobId }, '✅ Phase 8: All applicable axes above 80% — stopping');
        console.log(`[PHASE 8] Tous les axes applicables ≥ 80% — arrêt`);
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
