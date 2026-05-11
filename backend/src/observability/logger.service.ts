// ============================================================
// CodeMorph — Structured Logger Service
// Correlation IDs, log levels, structured JSON output
// ============================================================
import { Injectable, LoggerService as NestLoggerService, Scope } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as os from 'os';

export interface LogContext {
  correlationId?: string;
  userId?:        string;
  jobId?:         string;
  requestId?:     string;
  plan?:          string;
  [key: string]:  unknown;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

interface LogEntry {
  timestamp:     string;
  level:         LogLevel;
  message:       string;
  service:       string;
  environment:   string;
  host:          string;
  pid:           number;
  context?:      LogContext;
  error?:        { message: string; stack?: string; code?: string };
  duration_ms?:  number;
  [key: string]: unknown;
}

@Injectable({ scope: Scope.DEFAULT })
export class LoggerService implements NestLoggerService {
  private readonly env:     string;
  private readonly service: string;
  private readonly isDev:   boolean;
  private readonly host:    string;

  constructor(private readonly config: ConfigService) {
    this.env     = config.get<string>('NODE_ENV', 'development');
    this.service = config.get<string>('SERVICE_NAME', 'codemorph-backend');
    this.isDev   = this.env === 'development';
    this.host    = os.hostname();
  }

  // ── NestJS LoggerService interface ───────────────────
  log(message: string, context?: string | LogContext): void {
    this.write('info', message, this.parseContext(context));
  }
  debug(message: string, context?: string | LogContext): void {
    if (this.isDev) this.write('debug', message, this.parseContext(context));
  }
  warn(message: string, context?: string | LogContext): void {
    this.write('warn', message, this.parseContext(context));
  }
  error(message: string, trace?: string, context?: string | LogContext): void {
    this.write('error', message, this.parseContext(context), undefined, trace);
  }
  verbose(message: string, context?: string | LogContext): void {
    if (this.isDev) this.write('debug', message, this.parseContext(context));
  }
  fatal(message: string, context?: LogContext): void {
    this.write('fatal', message, context);
  }

  // ── Structured logging helpers ───────────────────────
  info(message: string, context?: LogContext): void {
    this.write('info', message, context);
  }

  logRequest(method: string, path: string, statusCode: number, durationMs: number, ctx?: LogContext): void {
    this.write('info', `${method} ${path} ${statusCode}`, ctx, durationMs);
  }

  logJobEvent(
    event: 'created' | 'started' | 'completed' | 'failed' | 'cancelled',
    jobId: string,
    extra?: LogContext,
  ): void {
    this.write('info', `Job ${event}`, { jobId, event, ...extra });
  }

  logAiUsage(userId: string, plan: string, tokens: number, durationMs: number): void {
    this.write('info', 'AI Engine call completed', {
      userId, plan, ai_tokens: tokens, ai_duration_ms: durationMs,
    });
  }

  logSecurityEvent(event: string, userId?: string, ip?: string, extra?: LogContext): void {
    this.write('warn', `Security event: ${event}`, {
      security_event: event, userId, ip, ...extra,
    });
  }

  logBillingEvent(event: string, userId: string, plan: string, extra?: LogContext): void {
    this.write('info', `Billing event: ${event}`, {
      billing_event: event, userId, plan, ...extra,
    });
  }

  // ── Core writer ───────────────────────────────────────
  private write(
    level:       LogLevel,
    message:     string,
    context?:    LogContext,
    durationMs?: number,
    trace?:      string,
  ): void {
    const entry: LogEntry = {
      timestamp:   new Date().toISOString(),
      level,
      message,
      service:     this.service,
      environment: this.env,
      host:        this.host,
      pid:         process.pid,
      ...(context     ? { context }               : {}),
      ...(durationMs  ? { duration_ms: durationMs } : {}),
      ...(trace       ? { error: { message, stack: trace } } : {}),
    };

    const output = this.isDev
      ? this.formatDev(entry)
      : JSON.stringify(entry);

    if (level === 'error' || level === 'fatal') {
      process.stderr.write(output + '\n');
    } else {
      process.stdout.write(output + '\n');
    }
  }

  private formatDev(entry: LogEntry): string {
    const COLORS: Record<LogLevel, string> = {
      debug: '\x1b[36m', info: '\x1b[32m', warn: '\x1b[33m',
      error: '\x1b[31m', fatal: '\x1b[35m',
    };
    const reset = '\x1b[0m';
    const color = COLORS[entry.level] ?? '';
    const ts    = new Date(entry.timestamp).toLocaleTimeString();
    const ctx   = entry.context ? ` ${JSON.stringify(entry.context)}` : '';
    return `${color}[${ts}] ${entry.level.toUpperCase().padEnd(5)} ${reset}${entry.message}${ctx}`;
  }

  private parseContext(context?: string | LogContext): LogContext | undefined {
    if (!context) return undefined;
    if (typeof context === 'string') return { component: context };
    return context;
  }
}
