// ============================================================
// CodeMorph — AI Engine Client
// Typed HTTP client with retry, circuit breaker, timeout
// ============================================================
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom, timeout, retry, catchError } from 'rxjs';
import { AxiosError } from 'axios';
import { throwError } from 'rxjs';

export interface AiConvertRequest {
  jobId:          string;
  sourceLanguage: string;
  targetLanguage: string;
  files:          Array<{ path: string; content: string }>;
  goalPrompt?:    string;
  callbackUrl:    string;
  options?: {
    maxFiles?:       number;
    maxLinesOfCode?: number;
    watermark?:      boolean;
    plan?:           string;
  };
}

export interface AiConvertResponse {
  jobId:    string;
  accepted: boolean;
  message?: string;
}

export interface AiFramework {
  source:  string;
  target:  string;
  type:    string;
  status:  string;
}

export interface AiHealthResponse {
  status:   string;
  uptime:   string;
  services: Record<string, string>;
}

@Injectable()
export class AiEngineClient {
  private readonly logger = new Logger(AiEngineClient.name);
  private readonly baseUrl: string;
  private circuitOpen = false;
  private circuitOpenedAt: number | null = null;
  private readonly CIRCUIT_TIMEOUT_MS = 30_000; // 30s before retry
  private consecutiveFailures = 0;
  private readonly CIRCUIT_THRESHOLD = 5;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {
    this.baseUrl = this.config.get<string>('AI_ENGINE_URL', 'http://ai-engine:5000');
  }

  // ── Submit async conversion job ──────────────────────────
  async submitConversion(req: AiConvertRequest): Promise<AiConvertResponse> {
    this.assertCircuitClosed();

    try {
      const res = await firstValueFrom(
        this.http
          .post<AiConvertResponse>(`${this.baseUrl}/api/convert`, req, {
            headers:         { 'Content-Type': 'application/json', 'X-Source': 'codemorph-backend' },
            timeout:         30_000,
            validateStatus:  (s) => s < 500,
          })
          .pipe(
            timeout(35_000),
            retry({
              count:    3,
              delay:    (err, attempt) => {
                const wait = Math.pow(2, attempt) * 1_000; // exponential: 2s, 4s, 8s
                this.logger.warn(`AI Engine retry ${attempt}/3 after ${wait}ms: ${(err as Error).message}`);
                return new Promise((r) => setTimeout(r, wait)) as any;
              },
              resetOnSuccess: true,
            }),
            catchError((err: AxiosError) => {
              this.recordFailure();
              return throwError(() => new ServiceUnavailableException(
                `AI Engine unavailable: ${err.message}`,
              ));
            }),
          ),
      );

      this.recordSuccess();
      return res.data;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  // ── Sync conversion (small files, testing) ───────────────
  async submitSync(req: Omit<AiConvertRequest, 'callbackUrl'>): Promise<unknown> {
    this.assertCircuitClosed();

    const res = await firstValueFrom(
      this.http
        .post(`${this.baseUrl}/api/convert/sync`, req, {
          timeout:        120_000, // sync can take time
          validateStatus: (s) => s < 500,
        })
        .pipe(
          timeout(125_000),
          catchError((err: AxiosError) => {
            this.recordFailure();
            return throwError(() => new ServiceUnavailableException(
              `AI Engine sync failed: ${err.message}`,
            ));
          }),
        ),
    );

    this.recordSuccess();
    return res.data;
  }

  // ── Get supported frameworks ─────────────────────────────
  async getFrameworks(): Promise<AiFramework[]> {
    try {
      const res = await firstValueFrom(
        this.http
          .get<{ supported: AiFramework[] }>(`${this.baseUrl}/api/convert/frameworks`, {
            timeout: 5_000,
          })
          .pipe(timeout(6_000)),
      );
      return res.data.supported;
    } catch {
      // Fallback to static list if AI engine unreachable
      return [
        { source: 'Flutter',  target: 'React',        type: 'frontend', status: 'stable' },
        { source: 'Flutter',  target: 'React Native',  type: 'mobile',   status: 'stable' },
        { source: 'Express',  target: 'NestJS',        type: 'backend',  status: 'stable' },
        { source: 'Node.js',  target: 'NestJS',        type: 'backend',  status: 'stable' },
      ];
    }
  }

  // ── Health check ─────────────────────────────────────────
  async health(): Promise<AiHealthResponse | null> {
    try {
      const res = await firstValueFrom(
        this.http
          .get<AiHealthResponse>(`${this.baseUrl}/health`, { timeout: 5_000 })
          .pipe(timeout(6_000)),
      );
      return res.data;
    } catch {
      return null;
    }
  }

  // ── Circuit breaker ──────────────────────────────────────
  private assertCircuitClosed(): void {
    if (!this.circuitOpen) return;

    const elapsed = Date.now() - (this.circuitOpenedAt ?? 0);
    if (elapsed > this.CIRCUIT_TIMEOUT_MS) {
      this.logger.log('Circuit breaker: half-open, trying again');
      this.circuitOpen = false;
      this.consecutiveFailures = 0;
    } else {
      throw new ServiceUnavailableException({
        code:    'AI_ENGINE_CIRCUIT_OPEN',
        message: 'AI Engine is temporarily unavailable. Please try again in 30 seconds.',
        retryAfterMs: this.CIRCUIT_TIMEOUT_MS - elapsed,
      });
    }
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.CIRCUIT_THRESHOLD) {
      this.circuitOpen = true;
      this.circuitOpenedAt = Date.now();
      this.logger.error(
        `Circuit breaker OPENED after ${this.consecutiveFailures} failures`,
      );
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.circuitOpen) {
      this.circuitOpen = false;
      this.logger.log('Circuit breaker CLOSED after success');
    }
  }

  get isCircuitOpen(): boolean { return this.circuitOpen; }
}
