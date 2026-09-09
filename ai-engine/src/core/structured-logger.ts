// ============================================================
// CodeMorph AI Engine — Structured Logger
// Logs corrélés par jobId à tous les niveaux du pipeline.
//
// DESIGN:
//   • Chaque log porte: timestamp, jobId, phase, action, durée,
//     fichier, provider/model, retry, erreur, résultat
//   • Format JSON (pino) en production, pretty en dev
//   • Niveaux: trace | debug | info | warn | error | fatal
//   • Masquage automatique des clés API dans tous les champs
//   • Singleton global pour partage entre modules
// ============================================================

import pino, { type Logger } from 'pino';

// ── Types de phases du pipeline ──────────────────────────────────────────────
export type PipelinePhase =
  | 'startup'
  | 'queue_dispatch'
  | 'file_extraction'
  | 'ast_analysis'
  | 'arch_detection'
  | 'app_spec'
  | 'ir_generation'
  | 'mapping'
  | 'code_planning'
  | 'biz_layer'
  | 'file_generation'
  | 'fidelity_check'
  | 'import_verify'
  | 'content_validate'
  | 'delivery_check'
  | 'zip_package'
  | 'report_gen'
  | 'callback'
  | 'done'
  | 'failed'
  | 'ai_call'
  | 'rate_limit';

// ── Interface de log structuré ───────────────────────────────────────────────
export interface StructuredLogContext {
  jobId?:        string;
  phase?:        PipelinePhase | string;
  action?:       string;
  durationMs?:   number;
  filePath?:     string;
  fileIndex?:    number;
  filesTotal?:   number;
  provider?:     string;
  model?:        string;
  retryCount?:   number;
  tokensUsed?:   number;
  tokensBudget?: number;
  rateLimitWaitMs?: number;
  score?:        number;
  error?:        string;
  result?:       string;
  elapsedMs?:    number;
  // Progression
  phaseIndex?:   number;
  phasesTotal?:  number;
  aiCallsTotal?: number;
  // Méta
  tier?:         string;
  cacheHit?:     boolean;
  [key: string]: unknown;
}

// ── Masquage des secrets ─────────────────────────────────────────────────────
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9\-_]{20,}/g,           // OpenAI keys
  /gsk_[a-zA-Z0-9]{20,}/g,             // Groq keys
  /sk-ant-[a-zA-Z0-9\-_]{20,}/g,       // Anthropic keys
  /Bearer\s+[a-zA-Z0-9\-_\.]{20,}/g,   // Bearer tokens
  /"apiKey"\s*:\s*"[^"]{10,}"/g,       // JSON apiKey fields
  /'apiKey'\s*:\s*'[^']{10,}'/g,       // JS apiKey fields
];

function maskSecrets(obj: unknown): unknown {
  if (typeof obj === 'string') {
    let s = obj;
    for (const pat of SECRET_PATTERNS) {
      s = s.replace(pat, '[REDACTED]');
    }
    return s;
  }
  if (Array.isArray(obj)) return obj.map(maskSecrets);
  if (obj && typeof obj === 'object') {
    const masked: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      // Masquer les champs sensibles par nom
      if (/apiKey|api_key|secret|token|password|credential/i.test(k)) {
        masked[k] = '[REDACTED]';
      } else {
        masked[k] = maskSecrets(v);
      }
    }
    return masked;
  }
  return obj;
}

// ── Créer le logger pino ─────────────────────────────────────────────────────
function createLogger(): Logger {
  const isDev = process.env['NODE_ENV'] !== 'production';
  const level = process.env['LOG_LEVEL'] ?? (isDev ? 'debug' : 'info');

  if (isDev) {
    // Mode dev : pretty print avec timestamps lisibles
    return pino({
      level,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
          messageFormat: '[{phase}] {msg}',
        },
      },
    });
  }

  // Mode prod : JSON structuré (parseable par Render/Datadog/Logtail)
  return pino({
    level,
    formatters: {
      level: (label) => ({ level: label }),
      bindings: () => ({ service: 'codemorph-ai-engine' }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

// ── Singleton global ─────────────────────────────────────────────────────────
const _baseLogger = createLogger();

// ── Interface publique ───────────────────────────────────────────────────────

/** Logger de pipeline attaché à un jobId */
export class PipelineLogger {
  readonly jobId:   string;
  private readonly logger:  Logger;
  private readonly startMs: number;
  private phaseStartMs:     number;
  private currentPhase:     string = 'startup';
  private aiCallCount:      number = 0;
  private retryCount:       number = 0;
  private totalWaitMs:      number = 0;

  constructor(jobId: string) {
    this.jobId    = jobId;
    this.logger   = _baseLogger.child({ jobId, service: 'pipeline' });
    this.startMs  = Date.now();
    this.phaseStartMs = Date.now();
  }

  // ── Phase tracking ────────────────────────────────────────────────────────

  phaseStart(phase: string, context?: Omit<StructuredLogContext, 'jobId' | 'phase'>): void {
    this.currentPhase  = phase;
    this.phaseStartMs  = Date.now();
    const elapsedMs    = Date.now() - this.startMs;
    this.logger.info(
      maskSecrets({ ...context, phase, action: 'phase_start', elapsedMs }) as object,
      `▶ Phase started: ${phase}`,
    );
  }

  phaseEnd(phase: string, context?: Omit<StructuredLogContext, 'jobId' | 'phase'>): void {
    const durationMs = Date.now() - this.phaseStartMs;
    const elapsedMs  = Date.now() - this.startMs;
    this.logger.info(
      maskSecrets({ ...context, phase, action: 'phase_end', durationMs, elapsedMs }) as object,
      `✅ Phase done: ${phase} (${durationMs}ms)`,
    );
  }

  // ── AI call tracking ──────────────────────────────────────────────────────

  aiCallStart(context: {
    provider: string;
    model:    string;
    phase:    string;
    purpose?: string;
    inputTokensEst?: number;
  }): void {
    this.aiCallCount++;
    this.logger.debug(
      maskSecrets({
        ...context,
        action:       'ai_call_start',
        aiCallNumber: this.aiCallCount,
        elapsedMs:    Date.now() - this.startMs,
      }) as object,
      `🤖 AI call #${this.aiCallCount}: ${context.provider}/${context.model} [${context.phase}]`,
    );
  }

  aiCallEnd(context: {
    provider:   string;
    model:      string;
    phase:      string;
    durationMs: number;
    tokensUsed: number;
    success:    boolean;
    error?:     string;
  }): void {
    this.logger.info(
      maskSecrets({
        ...context,
        action:       'ai_call_end',
        aiCallNumber: this.aiCallCount,
        elapsedMs:    Date.now() - this.startMs,
      }) as object,
      `${context.success ? '✅' : '❌'} AI call #${this.aiCallCount} done: ${context.durationMs}ms, ${context.tokensUsed} tokens`,
    );
  }

  aiRateLimit(waitMs: number, reason: string): void {
    this.totalWaitMs += waitMs;
    this.logger.warn(
      {
        phase:         this.currentPhase,
        action:        'rate_limit_wait',
        waitMs,
        reason,
        totalWaitMs:   this.totalWaitMs,
        aiCallCount:   this.aiCallCount,
        elapsedMs:     Date.now() - this.startMs,
      },
      `⏳ Rate limit wait: ${(waitMs / 1000).toFixed(1)}s — ${reason}`,
    );
  }

  aiRetry(attempt: number, maxAttempts: number, reason: string, waitMs?: number): void {
    this.retryCount++;
    this.logger.warn(
      {
        phase:       this.currentPhase,
        action:      'ai_retry',
        attempt,
        maxAttempts,
        reason,
        waitMs,
        totalRetries: this.retryCount,
        elapsedMs:   Date.now() - this.startMs,
      },
      `🔄 AI retry ${attempt}/${maxAttempts}: ${reason}`,
    );
  }

  // ── File-level tracking ───────────────────────────────────────────────────

  fileStart(filePath: string, fileIndex: number, filesTotal: number): void {
    this.logger.debug(
      {
        phase:      this.currentPhase,
        action:     'file_start',
        filePath,
        fileIndex,
        filesTotal,
        elapsedMs:  Date.now() - this.startMs,
      },
      `📄 File [${fileIndex}/${filesTotal}]: ${filePath}`,
    );
  }

  fileDone(filePath: string, fileIndex: number, filesTotal: number, durationMs: number, lines: number): void {
    this.logger.debug(
      {
        phase:      this.currentPhase,
        action:     'file_done',
        filePath,
        fileIndex,
        filesTotal,
        durationMs,
        lines,
        elapsedMs:  Date.now() - this.startMs,
      },
      `✅ File [${fileIndex}/${filesTotal}]: ${filePath} (${durationMs}ms, ${lines} lines)`,
    );
  }

  // ── Error logging ─────────────────────────────────────────────────────────

  error(message: string, error: Error | unknown, context?: StructuredLogContext): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.logger.error(
      maskSecrets({
        ...context,
        phase:      this.currentPhase,
        action:     'error',
        errorType:  err.name,
        errorMsg:   err.message,
        stack:      err.stack?.split('\n').slice(0, 5).join(' | '),
        elapsedMs:  Date.now() - this.startMs,
      }) as object,
      `❌ Error: ${message}`,
    );
  }

  warn(message: string, context?: StructuredLogContext): void {
    this.logger.warn(
      maskSecrets({ ...context, phase: this.currentPhase, elapsedMs: Date.now() - this.startMs }) as object,
      `⚠️  ${message}`,
    );
  }

  info(message: string, context?: StructuredLogContext): void {
    this.logger.info(
      maskSecrets({ ...context, phase: this.currentPhase, elapsedMs: Date.now() - this.startMs }) as object,
      message,
    );
  }

  debug(message: string, context?: StructuredLogContext): void {
    this.logger.debug(
      maskSecrets({ ...context, phase: this.currentPhase, elapsedMs: Date.now() - this.startMs }) as object,
      message,
    );
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  summary(context: {
    filesGenerated: number;
    fidelityScore:  number;
    aiCallCount?:   number;
    tokensTotal?:   number;
    success:        boolean;
  }): void {
    const totalMs = Date.now() - this.startMs;
    this.logger.info(
      {
        phase:          'done',
        action:         'pipeline_summary',
        totalMs,
        aiCallCount:    context.aiCallCount ?? this.aiCallCount,
        totalRetries:   this.retryCount,
        totalWaitMs:    this.totalWaitMs,
        filesGenerated: context.filesGenerated,
        fidelityScore:  context.fidelityScore,
        tokensTotal:    context.tokensTotal,
        success:        context.success,
        waitRatio:      totalMs > 0 ? `${((this.totalWaitMs / totalMs) * 100).toFixed(0)}%` : 'N/A',
      },
      `🏁 Pipeline ${context.success ? 'DONE' : 'FAILED'} — ${(totalMs / 1000).toFixed(1)}s | files=${context.filesGenerated} | fidelity=${context.fidelityScore}% | aiCalls=${this.aiCallCount} | retries=${this.retryCount} | waitTime=${(this.totalWaitMs / 1000).toFixed(0)}s`,
    );
  }
}

// ── Registry de loggers par jobId ────────────────────────────────────────────
const _loggerRegistry = new Map<string, PipelineLogger>();

export function getJobLogger(jobId: string): PipelineLogger {
  if (!_loggerRegistry.has(jobId)) {
    _loggerRegistry.set(jobId, new PipelineLogger(jobId));
    // TTL: supprimer après 2h pour éviter les fuites mémoire
    setTimeout(() => _loggerRegistry.delete(jobId), 2 * 60 * 60 * 1000);
  }
  return _loggerRegistry.get(jobId)!;
}

// ── Logger global (hors contexte job) ────────────────────────────────────────
export const globalLogger = _baseLogger.child({ service: 'codemorph-ai-engine' });

/** Log simple hors pipeline (startup, health, etc.) */
export function logInfo(msg: string, context?: Record<string, unknown>): void {
  globalLogger.info(maskSecrets(context ?? {}) as object, msg);
}

export function logError(msg: string, error?: Error | unknown, context?: Record<string, unknown>): void {
  const err = error instanceof Error ? error : (error ? new Error(String(error)) : undefined);
  globalLogger.error(
    maskSecrets({
      ...context,
      errorMsg: err?.message,
      stack:    err?.stack?.split('\n').slice(0, 3).join(' | '),
    }) as object,
    msg,
  );
}

export function logWarn(msg: string, context?: Record<string, unknown>): void {
  globalLogger.warn(maskSecrets(context ?? {}) as object, msg);
}
