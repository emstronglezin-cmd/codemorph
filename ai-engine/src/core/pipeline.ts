// ============================================================
// CodeMorph AI Engine — Conversion Pipeline (Orchestrator)
// RULE: AI outputs IR only — backend transforms IR → code
// Pipeline: Source → AST → Architecture → IR → Map → Plan
// ============================================================
import pino from 'pino';

import type { ConversionContext, ConversionResult, IRDocument } from '../models/ir.types';
import { ASTAnalyzer }          from './ast-analyzer';
import { ArchitectureDetector } from './architecture-detector';
import { IRGenerator }          from './ir-generator';
import { MappingEngine }        from './mapping-engine';
import { CodePlanner }          from './code-planner';
import { IRValidator }          from '../validators/ir.validator';

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });

export class ConversionPipeline {
  private readonly astAnalyzer:          ASTAnalyzer;
  private readonly architectureDetector: ArchitectureDetector;
  private readonly irGenerator:          IRGenerator;
  private readonly mappingEngine:        MappingEngine;
  private readonly codePlanner:          CodePlanner;
  private readonly irValidator:          IRValidator;

  constructor() {
    this.astAnalyzer          = new ASTAnalyzer();
    this.architectureDetector = new ArchitectureDetector();
    this.irGenerator          = new IRGenerator();
    this.mappingEngine        = new MappingEngine();
    this.codePlanner          = new CodePlanner();
    this.irValidator          = new IRValidator();
  }

  // ── Main pipeline ────────────────────────────────────
  async run(ctx: ConversionContext): Promise<ConversionResult> {
    const startTime = Date.now();
    logger.info({ jobId: ctx.jobId }, '🚀 Pipeline started');

    // ── PHASE 1: AST Analysis ─────────────────────────
    logger.info({ jobId: ctx.jobId }, '📊 Phase 1: AST Analysis');
    const astResult = await this.astAnalyzer.analyze(ctx);

    // ── PHASE 2: Architecture Detection ───────────────
    logger.info({ jobId: ctx.jobId }, '🏗️  Phase 2: Architecture Detection');
    const archResult = await this.architectureDetector.detect(ctx, astResult);

    // ── PHASE 3: IR Generation ─────────────────────────
    logger.info({ jobId: ctx.jobId }, '⚙️  Phase 3: IR Generation');
    const irDocument = await this.irGenerator.generate(ctx, astResult, archResult);

    // ── PHASE 4: Mapping Engine ────────────────────────
    logger.info({ jobId: ctx.jobId }, '🗺️  Phase 4: Mapping Engine');
    const mappedIR = await this.mappingEngine.map(ctx, irDocument);

    // ── PHASE 5: Target Code Plan ──────────────────────
    logger.info({ jobId: ctx.jobId }, '📋 Phase 5: Code Planning');
    const plan = await this.codePlanner.plan(ctx, mappedIR);

    // ── PHASE 6: IR Validation ─────────────────────────
    logger.info({ jobId: ctx.jobId }, '✅ Phase 6: IR Validation');
    const validatedIR = await this.irValidator.validate(mappedIR);

    const durationMs = Date.now() - startTime;
    logger.info({ jobId: ctx.jobId, durationMs }, '✨ Pipeline completed');

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

// ── Singleton export ───────────────────────────────────
export const pipeline = new ConversionPipeline();
