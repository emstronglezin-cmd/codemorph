// ============================================================
// CodeMorph — AI Engine Client
// Typed HTTP client with retry, circuit breaker, timeout
// + Mock mode when AI_ENGINE_URL is not configured (no Docker)
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

// ── Statically supported framework pairs ────────────────────
const SUPPORTED_PAIRS: Array<{ source: string; target: string }> = [
  { source: 'flutter',     target: 'react' },
  { source: 'flutter',     target: 'react-native' },
  { source: 'flutter',     target: 'reactnative' },
  { source: 'dart',        target: 'react' },
  { source: 'dart',        target: 'react-native' },
  { source: 'react',       target: 'flutter' },
  { source: 'react',       target: 'dart' },
  { source: 'javascript',  target: 'typescript' }, // Express→NestJS / Node→NestJS
  { source: 'typescript',  target: 'typescript' },
];

@Injectable()
export class AiEngineClient {
  private readonly logger = new Logger(AiEngineClient.name);
  private readonly baseUrl: string;
  private readonly mockMode: boolean;
  private circuitOpen = false;
  private circuitOpenedAt: number | null = null;
  private readonly CIRCUIT_TIMEOUT_MS = 30_000; // 30s before retry
  private consecutiveFailures = 0;
  private readonly CIRCUIT_THRESHOLD = 5;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {
    const configured = this.config.get<string>('AI_ENGINE_URL', '');
    // Mock mode: no real AI engine URL configured (Docker-only env)
    this.mockMode = !configured || configured === 'http://ai-engine:5000';
    this.baseUrl  = configured || 'http://ai-engine:5000';

    if (this.mockMode) {
      this.logger.warn(
        'AI_ENGINE_URL not configured or points to Docker-internal host. ' +
        'Running in MOCK mode — conversions will be simulated.',
      );
    } else {
      this.logger.log(`AI Engine configured at: ${this.baseUrl}`);
    }
  }

  // ── Submit async conversion job ──────────────────────────
  async submitConversion(req: AiConvertRequest): Promise<AiConvertResponse> {
    this.logger.log(
      `[Job ${req.jobId}] submitConversion: ${req.sourceLanguage} → ${req.targetLanguage}, ` +
      `${req.files.length} files, mock=${this.mockMode}`,
    );

    if (this.mockMode) {
      return this.mockConversion(req);
    }

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
                const wait = Math.pow(2, attempt) * 1_000;
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

  // ── Mock conversion — fires callback after a delay ───────
  private async mockConversion(req: AiConvertRequest): Promise<AiConvertResponse> {
    const { jobId, sourceLanguage, targetLanguage, files, callbackUrl } = req;

    this.logger.log(`[Job ${jobId}] MOCK: simulating ${sourceLanguage}→${targetLanguage} conversion`);

    // Validate pair
    const srcNorm = sourceLanguage.toLowerCase().replace(/[^a-z]/g, '');
    const tgtNorm = targetLanguage.toLowerCase().replace(/[^a-z]/g, '');
    const supported = SUPPORTED_PAIRS.some(
      (p) => p.source === srcNorm && (p.target === tgtNorm || p.target.replace('-', '') === tgtNorm),
    );

    if (!supported) {
      this.logger.warn(`[Job ${jobId}] MOCK: unsupported pair ${sourceLanguage}→${targetLanguage}`);
    }

    // Simulate async conversion (fires callback after 3-5s)
    const delay = 3_000 + Math.random() * 2_000;
    setTimeout(async () => {
      try {
        await this.fireMockCallback(jobId, sourceLanguage, targetLanguage, files, callbackUrl);
      } catch (e) {
        this.logger.error(`[Job ${jobId}] MOCK callback failed: ${(e as Error).message}`);
      }
    }, delay);

    return { jobId, accepted: true, message: 'Mock conversion accepted' };
  }

  // ── Fire mock callback with realistic result ─────────────
  private async fireMockCallback(
    jobId:          string,
    sourceLanguage: string,
    targetLanguage: string,
    files:          Array<{ path: string; content: string }>,
    callbackUrl:    string,
  ): Promise<void> {
    this.logger.log(`[Job ${jobId}] MOCK: firing callback to ${callbackUrl}`);

    // Generate mock converted files
    const convertedFiles = this.generateMockFiles(sourceLanguage, targetLanguage, files);

    const payload = {
      success:        true,
      jobId,
      filesGenerated: convertedFiles.length,
      linesGenerated: convertedFiles.reduce((acc, f) => acc + f.content.split('\n').length, 0),
      result: {
        files:           convertedFiles,
        sourceLanguage,
        targetLanguage,
        conversionType:  'mock',
        mockMode:        true,
        warning:         'AI_ENGINE_URL not configured — this is a mock conversion. Configure AI_ENGINE_URL for real conversions.',
        generatedAt:     new Date().toISOString(),
        summary: {
          filesProcessed: files.length,
          filesGenerated: convertedFiles.length,
          framework:      `${sourceLanguage} → ${targetLanguage}`,
        },
      },
      irDocument: {
        version:        '1.0',
        mock:           true,
        sourceLanguage,
        targetLanguage,
        modules:        files.slice(0, 5).map((f) => ({ path: f.path, linesOfCode: f.content.split('\n').length })),
      },
    };

    try {
      await firstValueFrom(
        this.http.post(callbackUrl, payload, {
          headers: { 'Content-Type': 'application/json', 'X-Source': 'codemorph-ai-mock' },
          timeout: 10_000,
        }),
      );
      this.logger.log(`[Job ${jobId}] MOCK: callback fired successfully`);
    } catch (e) {
      this.logger.error(`[Job ${jobId}] MOCK: callback error: ${(e as Error).message}`);
      // Don't rethrow — mock callback failure shouldn't crash the process
    }
  }

  // ── Generate mock converted files ────────────────────────
  private generateMockFiles(
    sourceLanguage: string,
    targetLanguage: string,
    sourceFiles: Array<{ path: string; content: string }>,
  ): Array<{ path: string; content: string }> {
    const tgt = targetLanguage.toLowerCase();

    // Map source extension → target extension
    const extMap: Record<string, string> = {
      'react':         '.tsx',
      'react-native':  '.tsx',
      'reactnative':   '.tsx',
      'flutter':       '.dart',
      'dart':          '.dart',
      'typescript':    '.ts',
      'javascript':    '.ts',
    };
    const newExt = extMap[tgt] ?? '.ts';

    return sourceFiles.slice(0, Math.min(sourceFiles.length, 10)).map((f) => {
      const baseName = f.path.replace(/\.[^.]+$/, '');
      const newPath  = `converted/${baseName}${newExt}`;

      const content = [
        `// ============================================================`,
        `// CodeMorph MOCK Conversion`,
        `// Source: ${f.path} (${sourceLanguage})`,
        `// Target: ${newPath} (${targetLanguage})`,
        `// WARNING: This is a mock conversion — AI_ENGINE_URL not configured`,
        `// ============================================================`,
        ``,
        `// Original source (${f.content.split('\n').length} lines):`,
        `// ${f.content.split('\n').slice(0, 3).join('\n// ')}`,
        ``,
        `// TODO: Configure AI_ENGINE_URL environment variable to enable real conversions`,
        `// Example: AI_ENGINE_URL=https://your-ai-engine.onrender.com`,
        ``,
        this.mockTargetBoilerplate(targetLanguage, baseName.split('/').pop() ?? 'Component'),
      ].join('\n');

      return { path: newPath, content };
    });
  }

  // ── Target-specific boilerplate ──────────────────────────
  private mockTargetBoilerplate(target: string, name: string): string {
    const tgt = target.toLowerCase();
    const PascalName = name.charAt(0).toUpperCase() + name.slice(1).replace(/[-_](.)/g, (_, c: string) => c.toUpperCase());

    if (tgt === 'react' || tgt === 'react-native' || tgt === 'reactnative') {
      return [
        `import React from 'react';`,
        ``,
        `// Auto-generated by CodeMorph (MOCK)`,
        `export const ${PascalName}: React.FC = () => {`,
        `  return (`,
        `    <div className="container">`,
        `      <h1>${PascalName}</h1>`,
        `      <p>Converted from Flutter/Dart (mock mode)</p>`,
        `    </div>`,
        `  );`,
        `};`,
        ``,
        `export default ${PascalName};`,
      ].join('\n');
    }

    if (tgt === 'flutter' || tgt === 'dart') {
      return [
        `import 'package:flutter/material.dart';`,
        ``,
        `// Auto-generated by CodeMorph (MOCK)`,
        `class ${PascalName} extends StatelessWidget {`,
        `  const ${PascalName}({super.key});`,
        ``,
        `  @override`,
        `  Widget build(BuildContext context) {`,
        `    return Scaffold(`,
        `      appBar: AppBar(title: const Text('${PascalName}')),`,
        `      body: const Center(child: Text('Converted from React (mock mode)')),`,
        `    );`,
        `  }`,
        `}`,
      ].join('\n');
    }

    if (tgt === 'typescript') {
      return [
        `import { Injectable } from '@nestjs/common';`,
        ``,
        `// Auto-generated by CodeMorph (MOCK)`,
        `@Injectable()`,
        `export class ${PascalName}Service {`,
        `  // Converted from Express/Node.js (mock mode)`,
        `  async execute(): Promise<void> {`,
        `    // TODO: implement`,
        `  }`,
        `}`,
      ].join('\n');
    }

    return `// Auto-generated by CodeMorph (MOCK)\n// Target: ${target}\nexport {};`;
  }

  // ── Sync conversion (small files, testing) ───────────────
  async submitSync(req: Omit<AiConvertRequest, 'callbackUrl'>): Promise<unknown> {
    if (this.mockMode) {
      return {
        mock:           true,
        message:        'AI_ENGINE_URL not configured — mock sync result',
        sourceLanguage: req.sourceLanguage,
        targetLanguage: req.targetLanguage,
        filesInput:     req.files.length,
      };
    }

    this.assertCircuitClosed();

    const res = await firstValueFrom(
      this.http
        .post(`${this.baseUrl}/api/convert/sync`, req, {
          timeout:        120_000,
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
    if (this.mockMode) {
      return [
        { source: 'Flutter',    target: 'React',        type: 'frontend', status: 'stable' },
        { source: 'Flutter',    target: 'React Native',  type: 'mobile',   status: 'stable' },
        { source: 'React',      target: 'Flutter',       type: 'frontend', status: 'stable' },
        { source: 'Express.js', target: 'NestJS',        type: 'backend',  status: 'stable' },
        { source: 'Node.js',    target: 'NestJS',        type: 'backend',  status: 'stable' },
      ];
    }
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
      return [
        { source: 'Flutter',    target: 'React',        type: 'frontend', status: 'stable' },
        { source: 'Flutter',    target: 'React Native',  type: 'mobile',   status: 'stable' },
        { source: 'Express.js', target: 'NestJS',        type: 'backend',  status: 'stable' },
        { source: 'Node.js',    target: 'NestJS',        type: 'backend',  status: 'stable' },
      ];
    }
  }

  // ── Health check ─────────────────────────────────────────
  async health(): Promise<AiHealthResponse | null> {
    if (this.mockMode) {
      return {
        status:   'mock',
        uptime:   '0s',
        services: { ai_engine: 'mock', note: 'Configure AI_ENGINE_URL for real AI processing' },
      };
    }
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
  get isMockMode(): boolean    { return this.mockMode; }
}
