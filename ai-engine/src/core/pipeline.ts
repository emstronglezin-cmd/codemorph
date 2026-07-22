// ============================================================
// CodeMorph AI Engine — Conversion Pipeline (Orchestrator)
// RULE: AI outputs IR only — backend transforms IR → code
// Pipeline: Source → AST → Architecture → IR → Map → Plan → Validate → AutoCorrect
// Supports: Free (Groq), Platform (OpenAI), Pro (user keys)
// PHASE 22: Prompt Maître V2 — Phase 7 Auto-correction ajoutée
// PHASE 23: Prompt Architecte Ultime V3 — Score fidélité multi-axes + boucle Phase 8
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
  private enforceLimits(ctx: ConversionContext, tier: AITier): void {
    if (tier === 'static' || tier === 'free-groq') {
      const limits = AIProvider.getLimits(tier);
      if (ctx.sourceCode.length > limits.maxInputChars) {
        ctx.sourceCode = ctx.sourceCode.slice(0, limits.maxInputChars);
        logger.warn({ jobId: ctx.jobId, tier }, `⚠️  Source code truncated to ${limits.maxInputChars} chars (free tier limit)`);
      }
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

    // ── PHASE 2: Architecture Detection ───────────────────
    logger.info({ jobId: ctx.jobId, tier }, '🏗️  Phase 2: Architecture Detection');
    const archResult = await architectureDetector.detect(ctx, astResult);

    // ── PHASE 3+4: IR Generation + Knowledge Graph ────────
    logger.info({ jobId: ctx.jobId, tier }, '⚙️  Phase 3: IR Generation + Knowledge Graph');
    const irDocument = await irGenerator.generate(ctx, astResult, archResult);

    // ── PHASE 4: Mapping Engine ────────────────────────────
    logger.info({ jobId: ctx.jobId }, '🗺️  Phase 4: Mapping Engine');
    const mappedIR = await this.mappingEngine.map(ctx, irDocument as never);

    // ── PHASE 5: Target Code Plan ──────────────────────────
    logger.info({ jobId: ctx.jobId, tier }, '📋 Phase 5: Code Planning (Reconstruction + Visual Fidelity)');
    const plan = await codePlanner.plan(ctx, mappedIR);

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
    const MAX_ITERATIONS = tier === 'free-groq' || tier === 'static' ? 0 : 3;
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

}

// ── Singleton export (default — reads env vars) ───────────────────────────────
export const pipeline = new ConversionPipeline();
