// ============================================================
// CodeMorph — Error Tracking Service (Sentry-compatible)
// ============================================================
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from './logger.service';

export interface ErrorEvent {
  error:         Error | unknown;
  userId?:       string;
  jobId?:        string;
  requestId?:    string;
  context?:      Record<string, unknown>;
  tags?:         Record<string, string>;
  level?:        'error' | 'fatal' | 'warning';
}

export interface ErrorSummary {
  fingerprint:  string;
  message:      string;
  count:        number;
  firstSeen:    string;
  lastSeen:     string;
  level:        string;
}

@Injectable()
export class ErrorTrackingService {
  private readonly sentryDsn:   string | undefined;
  private readonly enabled:     boolean;
  private readonly environment: string;

  // In-memory error store (use Redis/DB in production)
  private readonly errorStore = new Map<string, ErrorSummary>();

  constructor(
    readonly _config: ConfigService,
    private readonly logger: LoggerService,
  ) {
    this.sentryDsn   = this._config.get<string>('SENTRY_DSN');
    this.environment = this._config.get<string>('NODE_ENV', 'development');
    this.enabled     = !!this.sentryDsn && this.environment === 'production';
  }

  // ── Capture exception ────────────────────────────────
  captureException(event: ErrorEvent): string {
    const err     = event.error instanceof Error ? event.error : new Error(String(event.error));
    const fingerprint = this.computeFingerprint(err);

    // Log structured error
    this.logger.error(err.message, err.stack, {
      correlationId: event.requestId,
      userId:        event.userId,
      jobId:         event.jobId,
      ...event.context,
    });

    // Update local error store
    const existing = this.errorStore.get(fingerprint);
    const now = new Date().toISOString();
    this.errorStore.set(fingerprint, {
      fingerprint,
      message:   err.message,
      count:     (existing?.count ?? 0) + 1,
      firstSeen: existing?.firstSeen ?? now,
      lastSeen:  now,
      level:     event.level ?? 'error',
    });

    // Forward to Sentry if configured
    if (this.enabled) {
      this.sendToSentry(err, event).catch(() => { /* silent */ });
    }

    return fingerprint;
  }

  // ── Capture message ───────────────────────────────────
  captureMessage(message: string, level: ErrorEvent['level'] = 'warning', context?: Record<string, unknown>): void {
    this.logger.warn(message, context);
    if (this.enabled) {
      this.sendMessageToSentry(message, level, context).catch(() => { /* silent */ });
    }
  }

  // ── Get error summary (for admin dashboard) ───────────
  getErrorSummary(limit = 20): ErrorSummary[] {
    return Array.from(this.errorStore.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  // ── Clear resolved errors ─────────────────────────────
  clearError(fingerprint: string): void {
    this.errorStore.delete(fingerprint);
  }

  // ── Fingerprint ───────────────────────────────────────
  private computeFingerprint(err: Error): string {
    const src = `${err.name}:${err.message.slice(0, 100)}`;
    let hash  = 0;
    for (let i = 0; i < src.length; i++) {
      hash = ((hash << 5) - hash) + src.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }

  // ── Sentry HTTP transport ─────────────────────────────
  private async sendToSentry(err: Error, event: ErrorEvent): Promise<void> {
    if (!this.sentryDsn) return;
    // Minimal Sentry envelope format — replace with @sentry/node in production
    const envelope = {
      event_id:    this.computeFingerprint(err),
      timestamp:   Date.now() / 1000,
      platform:    'node',
      environment: this.environment,
      level:       event.level ?? 'error',
      exception: {
        values: [{
          type:       err.name,
          value:      err.message,
          stacktrace: { frames: this.parseStack(err.stack) },
        }],
      },
      user:   event.userId ? { id: event.userId } : undefined,
      tags:   event.tags,
      extra:  event.context,
    };
    void envelope; // Type-safe no-op until Sentry SDK is added
  }

  private async sendMessageToSentry(
    message:  string,
    level:    ErrorEvent['level'],
    context?: Record<string, unknown>,
  ): Promise<void> {
    void message; void level; void context;
  }

  private parseStack(stack?: string): Array<{ filename: string; lineno: number; function: string }> {
    if (!stack) return [];
    return stack.split('\n').slice(1, 10).map((line) => {
      const match = line.match(/at (.+?) \((.+?):(\d+):\d+\)/);
      return {
        function: match?.[1] ?? '<anonymous>',
        filename: match?.[2] ?? '<unknown>',
        lineno:   parseInt(match?.[3] ?? '0', 10),
      };
    });
  }
}
