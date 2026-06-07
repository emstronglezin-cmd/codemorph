// ============================================================
// CodeMorph AI Engine — Conversion Pipeline (Orchestrator)
// RULE: AI outputs IR only — backend transforms IR → code
// Pipeline: Source → AST → Architecture → IR → Map → Plan
// Supports: Free (Groq), Platform (OpenAI), Pro (user keys)
// ============================================================
import pino from 'pino';

import type { ConversionContext, ConversionResult } from '../models/ir.types';
import { AIProvider, type AITier }  from './ai-provider';
import { ASTAnalyzer }              from './ast-analyzer';
import { ArchitectureDetector }     from './architecture-detector';
import { IRGenerator }              from './ir-generator';
import { MappingEngine }            from './mapping-engine';
import { CodePlanner }              from './code-planner';
import { IRValidator }              from '../validators/ir.validator';

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

    const durationMs = Date.now() - startTime;
    logger.info({ jobId: ctx.jobId, durationMs, tier }, '✨ Pipeline completed');

    return {
      jobId:      ctx.jobId,
      ir:         validatedIR,
      files:      plan.files,
      summary:    plan.summary,
      tokensUsed: astResult.tokensUsed + archResult.tokensUsed + irDocument.tokensUsed,
      durationMs,
    };
  }
}

// ── Singleton export (default — reads env vars) ───────────────────────────────
export const pipeline = new ConversionPipeline();
