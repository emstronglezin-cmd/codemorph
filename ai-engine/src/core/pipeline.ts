// ============================================================
// CodeMorph AI Engine — Conversion Pipeline (Orchestrator)
// RULE: AI outputs IR only — backend transforms IR → code
// Pipeline: Source → AST → Architecture → IR → Map → Plan → Validate → AutoCorrect
// Supports: Free (Groq), Platform (OpenAI), Pro (user keys)
// PHASE 22: Prompt Maître V2 — Phase 7 Auto-correction ajoutée
// ============================================================
import pino from 'pino';

import type { ConversionContext, ConversionResult, IRSourceMetrics } from '../models/ir.types';
import { AIProvider, type AITier }  from './ai-provider';
import { ASTAnalyzer }              from './ast-analyzer';
import { ArchitectureDetector }     from './architecture-detector';
import { IRGenerator }              from './ir-generator';
import { MappingEngine }            from './mapping-engine';
import { CodePlanner }              from './code-planner';
import { IRValidator }              from '../validators/ir.validator';
import type { GeneratedFile }       from '../models/ir.types';

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

    // ── PHASE 3: IR Generation ─────────────────────────────
    logger.info({ jobId: ctx.jobId, tier }, '⚙️  Phase 3: IR Generation');
    const irDocument = await irGenerator.generate(ctx, astResult, archResult);

    // ── PHASE 4: Mapping Engine ────────────────────────────
    logger.info({ jobId: ctx.jobId }, '🗺️  Phase 4: Mapping Engine');
    const mappedIR = await this.mappingEngine.map(ctx, irDocument as never);

    // ── PHASE 5: Target Code Plan ──────────────────────────
    logger.info({ jobId: ctx.jobId, tier }, '📋 Phase 5: Code Planning');
    const plan = await codePlanner.plan(ctx, mappedIR);

    // ── PHASE 6: IR Validation ─────────────────────────────
    logger.info({ jobId: ctx.jobId }, '✅ Phase 6: IR Validation');
    const validatedIR = await this.irValidator.validate(mappedIR);

    // ── PHASE 7: Auto-correction (Prompt Maître V2 — Étape 7) ─────────────
    // Compare source metrics vs generated files
    // If critical losses detected: regenerate missing parts
    logger.info({ jobId: ctx.jobId, tier }, '🔄 Phase 7: Auto-correction');
    const correctedPlan = await this.autoCorrect(ctx, validatedIR, plan, tier, codePlanner);

    const durationMs = Date.now() - startTime;
    logger.info({ jobId: ctx.jobId, durationMs, tier }, '✨ Pipeline completed');

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
    };
  }

  // ── PHASE 7: Auto-correction — Prompt Maître V2 Étape 7 ─────────────────
  // Compare source metrics (from IR validation) vs generated files
  // Detects critical losses and regenerates missing parts
  private async autoCorrect(
    ctx: ConversionContext,
    ir: ReturnType<IRValidator['validate']> extends Promise<infer T> ? T : never,
    plan: Awaited<ReturnType<CodePlanner['plan']>>,
    tier: AITier,
    codePlanner: CodePlanner,
  ): Promise<typeof plan> {
    // Skip auto-correction for static tier (no AI available)
    if (tier === 'static') {
      logger.info({ jobId: ctx.jobId }, '⏭️  Phase 7: skipped (static tier)');
      return plan;
    }

    const sourceMetrics: IRSourceMetrics | undefined = ir.validation?.sourceMetrics;
    if (!sourceMetrics) {
      logger.info({ jobId: ctx.jobId }, '⏭️  Phase 7: no sourceMetrics available — skipping');
      return plan;
    }

    const generatedFiles = plan.files;
    const losses: string[] = [];

    // ── Check for critical losses ──────────────────────────────────────────
    const generatedScreenCount = generatedFiles.filter((f) =>
      /\/(screens?|pages?|app)\/[^/]+\.tsx?$/.test(f.path) &&
      !/layout|index|\(tabs\)/.test(f.path)
    ).length;

    const generatedServiceCount = generatedFiles.filter((f) =>
      /\.service\.(ts|js)$/.test(f.path)
    ).length;

    const generatedStoreCount = generatedFiles.filter((f) =>
      /\.store\.(ts|js)$/.test(f.path)
    ).length;

    // Screens: if we generated 0 but source had screens
    if (generatedScreenCount === 0 && sourceMetrics.screensCount > 0) {
      losses.push(`screens: 0 generated / ${sourceMetrics.screensCount} in source`);
    }

    // Models: check if generated types match expected
    const generatedTypeCount = generatedFiles.filter((f) =>
      /\.types\.(ts|js)$/.test(f.path) || /\/types\//.test(f.path)
    ).length;

    if (generatedTypeCount === 0 && sourceMetrics.modelsCount > 0) {
      losses.push(`models/types: 0 generated / ${sourceMetrics.modelsCount} in source`);
    }

    logger.info({
      jobId:            ctx.jobId,
      sourceScreens:    sourceMetrics.screensCount,
      generatedScreens: generatedScreenCount,
      sourceServices:   sourceMetrics.servicesCount,
      generatedServices: generatedServiceCount,
      sourceStores:     sourceMetrics.storesCount,
      generatedStores:  generatedStoreCount,
      losses:           losses.length,
    }, `📊 Phase 7: Fidelity check`);

    if (losses.length === 0) {
      logger.info({ jobId: ctx.jobId }, '✅ Phase 7: No critical losses detected');
      return plan;
    }

    logger.warn({ jobId: ctx.jobId, losses }, `⚠️  Phase 7: ${losses.length} critical loss(es) detected — attempting regeneration`);

    // ── Regenerate missing parts ───────────────────────────────────────────
    // For Groq: skip regeneration (token budget too tight)
    if (tier === 'free-groq') {
      logger.warn({ jobId: ctx.jobId }, '⏭️  Phase 7: Groq tier — regeneration skipped (token budget). Losses noted in warnings.');
      // Add losses to validation warnings so frontend knows about them
      if (ir.validation) {
        ir.validation.warnings = [
          ...(ir.validation.warnings ?? []),
          ...losses.map((l) => `[Phase7] Critical loss: ${l}`),
        ];
      }
      return plan;
    }

    // For OpenAI/Platform tiers: attempt re-plan with enriched context
    try {
      logger.info({ jobId: ctx.jobId }, '🔄 Phase 7: Re-planning with enriched IR context');
      const replan = await codePlanner.plan(ctx, ir as never);

      // Merge: keep existing files, add new ones for gaps
      const existingPaths = new Set(plan.files.map((f) => f.path));
      const newFiles: GeneratedFile[] = replan.files.filter((f) => !existingPaths.has(f.path));

      logger.info({
        jobId:     ctx.jobId,
        original:  plan.files.length,
        new:       newFiles.length,
        total:     plan.files.length + newFiles.length,
      }, '✅ Phase 7: Auto-correction complete');

      const mergedFiles = [...plan.files, ...newFiles];
      return {
        files: mergedFiles,
        summary: {
          ...plan.summary,
          totalFiles:      mergedFiles.length,
          successfulFiles: mergedFiles.filter((f) => !f.warnings?.length).length,
          totalLines:      mergedFiles.reduce((a, f) => a + f.content.split('\n').length, 0),
          convertedLines:  mergedFiles.reduce((a, f) => a + f.content.split('\n').length, 0),
        },
      };
    } catch (err) {
      logger.error({ jobId: ctx.jobId, err: (err as Error).message }, '❌ Phase 7: Auto-correction failed — using original plan');
      return plan;
    }
  }

}

// ── Singleton export (default — reads env vars) ───────────────────────────────
export const pipeline = new ConversionPipeline();
