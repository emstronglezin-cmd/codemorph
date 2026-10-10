// ============================================================
// CodeMorph — AI Engine Client
// Typed HTTP client with retry, circuit breaker, timeout
// + Mock mode when AI_ENGINE_URL is not configured (no Docker)
//
// FIX PHASE 11 — CAUSE RACINE ZOMBIE JOBS :
// En mode mock, setTimeout était utilisé pour fire le callback.
// Si Render redémarre → setTimeout perdu → callback jamais déclenché
// → job reste CONVERTING indéfiniment.
//
// Fix : le mock callback échec → marquer le job FAILED via callbackUrl
// + le watchdog dans JobsService détecte les jobs CONVERTING > 5min
// ============================================================
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom, timeout, catchError } from 'rxjs';
import { AxiosError } from 'axios';
import { throwError } from 'rxjs';
import { randomUUID } from 'crypto';

import { RetryableError }        from '../../queue/retryable.error';
import { NonRetryableError }     from '../../queue/non-retryable.error';
import { parseRetryAfterHeader } from '../../queue/retry-delay';

export interface AiConvertRequest {
  jobId:          string;
  sourceLanguage: string;
  targetLanguage: string;
  files:          Array<{ path: string; content: string }>;
  goalPrompt?:    string;
  callbackUrl:    string;
  progressUrl?:   string;  // PHASE 28: URL de progression temps-réel
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

    this.logger.log(
      `[AiEngineClient] AI_ENGINE_URL="${configured || '(not set)'}" ` +
      `baseUrl=${this.baseUrl} mockMode=${this.mockMode}`,
    );

    // ── DIAG axios interceptors ──────────────────────────────
    // Intercepte tous les appels HTTP sortants via HttpService (nestjs/axios)
    if (this.mockMode) {
      this.logger.warn('[PIPELINE] mockMode=true — AI_ENGINE_URL not set, using mock conversion');
    } else {
      this.logger.log(`[PIPELINE] AI Engine real mode — baseUrl=${this.baseUrl}`);
    }
  }

  // ── Submit async conversion job ──────────────────────────
  // FIX PHASE 16 — INCOMPATIBILITÉ PAYLOAD :
  // Le backend envoyait { files: [{path,content}], sourceLanguage, targetLanguage }
  // L'AI Engine attend   { sourceCode: string, sourceFramework, targetFramework, projectId }
  //
  // Fix:
  //   - files[] → concaténés en sourceCode string (séparés par header de fichier)
  //   - sourceLanguage → sourceFramework  (ex: "flutter" → "flutter")
  //   - targetLanguage → targetFramework  (ex: "react"   → "react")
  //   - goalPrompt     → userGoal
  //   - jobId transmis tel quel (attendu par l'AI Engine)
  async submitConversion(req: AiConvertRequest): Promise<AiConvertResponse> {
    const targetUrl = `${this.baseUrl}/api/convert`;
    const sourceCharCount = req.files.reduce((acc, f) => acc + (f.content?.length ?? 0), 0);

    // FIX PHASE 32 — DISPATCH LOG STRUCTURÉ
    // Permet de tracer exactement si l'appel HTTP part réellement vers l'AI Engine.
    this.logger.log(
      `[DISPATCH-START] jobId=${req.jobId} url=${targetUrl} ` +
      `src=${req.sourceLanguage} tgt=${req.targetLanguage} ` +
      `files=${req.files.length} chars=${sourceCharCount} ` +
      `mock=${this.mockMode} circuit=${this.circuitOpen ? 'OPEN' : 'closed'}`,
    );
    this.logger.log(
      `[DISPATCH-START] callbackUrl=${req.callbackUrl} progressUrl=${req.progressUrl ?? '(none)'}`,
    );

    if (this.mockMode) {
      this.logger.warn(
        `[DISPATCH-MOCK] jobId=${req.jobId} — AI_ENGINE_URL not set or is Docker-internal. ` +
        `Running mock conversion. Set AI_ENGINE_URL=https://<real-ai-engine>.onrender.com to use real AI.`,
      );
      return this.mockConversion(req);
    }

    this.assertCircuitClosed();

    // ── Convertir files[] → sourceCode string (format attendu par l'AI Engine) ──
    // L'AI Engine attend un seul champ `sourceCode` (string), pas un tableau de fichiers.
    // On concatène tous les fichiers avec un header indiquant le chemin.
    const sourceCode = req.files
      .map((f) => `// === FILE: ${f.path} ===\n${f.content}`)
      .join('\n\n');

    // L'AI Engine utilise sourceFramework/targetFramework (pas sourceLanguage/targetLanguage)
    const payload = {
      jobId:           req.jobId,
      projectId:       req.jobId,          // requis par l'AI Engine
      sourceCode,
      sourceLanguage:  req.sourceLanguage,
      sourceFramework: req.sourceLanguage,  // alias: language = framework pour l'AI Engine
      targetFramework: req.targetLanguage,  // alias: language = framework pour l'AI Engine
      userGoal:        req.goalPrompt ?? '',
      callbackUrl:     req.callbackUrl,
      ...(req.progressUrl ? { progressUrl: req.progressUrl } : {}),
      options:         req.options,
    };

    // FIX PHASE 5 — SEC-01 : transmettre le secret partagé AI_ENGINE_SECRET
    const aiEngineSecret = this.config.get<string>('AI_ENGINE_SECRET', '');
    const extraHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Source': 'codemorph-backend',
      // ID de corrélation end-to-end : loggé côté Backend ET côté AI Engine
      // ([AI-ENGINE-REQUEST] lit x-request-id). Jamais de secret dans ce header.
      'X-Request-Id': randomUUID(),
    };
    if (aiEngineSecret) {
      extraHeaders['X-AI-Engine-Secret'] = aiEngineSecret;
    }
    const requestId = extraHeaders['X-Request-Id'];

    const httpStart = Date.now();
    try {
      const res = await firstValueFrom(
        this.http
          .post<AiConvertResponse>(targetUrl, payload, {
            headers:         extraHeaders,
            timeout:         30_000,
            // FIX PHASE 34 — BUG #1 : seul 202 est un succès. Tout autre status
            // lève une AxiosError, classifiée ci-dessous en erreur retryable ou non.
            validateStatus:  (s) => s === 202,
          })
          .pipe(
            timeout(35_000),
            // FIX PHASE 37 — RETRY UNIQUE :
            // AVANT: retry rxjs interne (2 tentatives immédiates) + retry Bull/Memory
            //   + exception 429 transformée en échec définitif → deux mécanismes
            //   concurrents, et le job passait FAILED dès le premier 429.
            // MAINTENANT: aucun retry interne. catchError classe l'erreur
            //   (RetryableError / NonRetryableError) et c'est la FILE (Bull ou
            //   MemoryQueue) qui planifie les tentatives avec backoff + Retry-After.
            //   Un seul mécanisme de retry, aucune boucle concurrente.
            catchError((err: AxiosError) => {
              throw this.classifyDispatchError(err, req.jobId, targetUrl, requestId, httpStart);
            }),
          ),
      );

      const durationMs = Date.now() - httpStart;
      const data = res.data as any;
      const aiEngineJobId: string = data.jobId ?? req.jobId;
      this.logger.log(
        `[DISPATCH-RESPONSE] jobId=${req.jobId} requestId=${requestId} httpStatus=${res.status} ` +
        `durationMs=${durationMs} aiEngineJobId=${aiEngineJobId} accepted=${data.accepted ?? true} ` +
        `message=${data.message ?? '(none)'}`,
      );
      this.recordSuccess();

      // L'AI Engine répond { jobId, accepted: true, message }
      // validateStatus strict garantit que seul 202 atteint ce point
      return {
        jobId:    aiEngineJobId,
        accepted: true,   // garanti par validateStatus: s === 202
        message:  data.message,
      };
    } catch (err) {
      // Erreurs déjà typées par classifyDispatchError (ou circuit breaker) :
      // on les propage telles quelles — c'est la file qui décide du retry.
      if (
        err instanceof RetryableError ||
        err instanceof NonRetryableError ||
        (err as { nonRetryable?: boolean })?.nonRetryable === true ||
        (err as { retryable?: boolean })?.retryable === true
      ) {
        throw err;
      }
      // Toute autre exception (inattendue) → classifiée transitoire et bornée
      // par le nombre max de tentatives de la file (jamais de boucle infinie).
      this.logger.error(`[submitConversion] [Job ${req.jobId}] unexpected exception: ${(err as Error)?.message}`);
      this.recordFailure();
      throw new RetryableError(
        `AI Engine dispatch failed unexpectedly: ${(err as Error)?.message ?? 'unknown error'}`,
        { kind: 'unknown', requestId, provider: 'ai-engine' },
        err as Error,
      );
    }
  }

  // ── Classification des erreurs de dispatch ───────────────
  // FIX PHASE 37 — OBJECTIF 1+2 :
  //   • Préserver les infos utiles du fournisseur (message d'erreur, statut,
  //     Retry-After) au lieu d'une erreur générique.
  //   • Distinguer erreurs TRANSITOIRES (429, 5xx, timeout, réseau) →
  //     RetryableError (la file retente avec backoff + Retry-After)
  //     des erreurs PERMANENTES (401/403 secret, 400 payload) →
  //     NonRetryableError (aucun retry).
  //   • Journalisation SÉCURISÉE : jamais de clé/token/secret, jamais le
  //     contenu complet du dépôt — uniquement statut, type, Retry-After,
  //     requestId et indices d'origine (headers non-sensibles).
  private classifyDispatchError(
    err:       unknown,
    jobId:     string,
    targetUrl: string,
    requestId: string,
    httpStart: number,
  ): Error {
    const durationMs = Date.now() - httpStart;
    const axErr  = err as AxiosError;
    const status = axErr.response?.status;
    const body   = axErr.response?.data as Record<string, unknown> | undefined;
    // Extrait NON-SENSIBLE du body : uniquement les champs error/message,
    // tronqués. Jamais le body complet (peut contenir du code utilisateur).
    const bodyInfo = body && typeof body === 'object'
      ? JSON.stringify({
          error:   typeof body['error'] === 'string'   ? (body['error'] as string).slice(0, 200)   : undefined,
          message: typeof body['message'] === 'string' ? (body['message'] as string).slice(0, 200) : undefined,
        })
      : `(non-object body)`;

    // ── HTTP 429 : rate limit — erreur TRANSITOIRE, retry différé ──────────
    if (status === 429) {
      const headers = (axErr.response?.headers ?? {}) as Record<string, string | undefined>;
      const retryAfterMs = parseRetryAfterHeader(headers['retry-after']);
      // Indices d'origine du 429 (headers non-sensibles) : aucun code de ce
      // dépôt ne retourne 429 → le 429 provient d'une couche infra devant
      // l'AI Engine (edge/proxy Render). Ces champs le prouvent dans les logs.
      const originHints = [
        headers['server']      ? `server=${String(headers['server']).slice(0, 40)}`       : null,
        headers['via']         ? `via=${String(headers['via']).slice(0, 40)}`             : null,
        headers['cf-ray']      ? `cf-ray=${String(headers['cf-ray']).slice(0, 24)}`       : null,
        headers['x-request-id'] ? `upstreamRequestId=${String(headers['x-request-id']).slice(0, 64)}` : null,
      ].filter(Boolean).join(' ');

      this.logger.error(
        `[DISPATCH-429] jobId=${jobId} requestId=${requestId} url=${targetUrl} ` +
        `durationMs=${durationMs} httpStatus=429 errorType=rate-limit ` +
        `provider=ai-engine-edge retryAfterMs=${retryAfterMs ?? 'none'} ` +
        `body=${bodyInfo} originHints=[${originHints || 'none'}] ` +
        `action=RETRYABLE_VIA_QUEUE_BACKOFF ` +
        `NOTE: no code path in backend/ai-engine returns 429 — source is the ` +
        `infra layer in front of the AI Engine (Render edge/proxy rate limit ` +
        `on the free plan, or upstream proxy). Groq 429s are absorbed inside ` +
        `the AI Engine pipeline and never surface as an HTTP 429 here.`,
      );
      return new RetryableError(
        `AI Engine rate limited (429): too many requests. ` +
        `${retryAfterMs !== undefined ? `Server asked to wait ${Math.round(retryAfterMs / 1000)}s. ` : ''}` +
        `The job will be retried automatically by the queue.`,
        { kind: 'rate-limit', httpStatus: 429, retryAfterMs, requestId, provider: 'ai-engine-edge' },
        axErr instanceof Error ? axErr : undefined,
      );
    }

    // ── HTTP 401/403 : secret mismatch / unauthorized — PERMANENT ──────────
    if (status === 401 || status === 403) {
      this.logger.error(
        `[DISPATCH-FAILED] jobId=${jobId} requestId=${requestId} url=${targetUrl} ` +
        `durationMs=${durationMs} httpStatus=${status} errorType=auth-rejected ` +
        `provider=ai-engine body=${bodyInfo} action=NO_RETRY ` +
        `CAUSE: AI_ENGINE_SECRET mismatch — verify both services have the same value on Render`,
      );
      return new NonRetryableError(
        `AI Engine rejected dispatch (${status}): authentication refused. ` +
        `Check AI_ENGINE_SECRET is identical on Backend and AI Engine.`,
        axErr instanceof Error ? axErr : undefined,
      );
    }

    // ── Autres 4xx : payload refusé — PERMANENT à cette taille ─────────────
    if (status !== undefined && status >= 400 && status < 500) {
      this.logger.error(
        `[DISPATCH-FAILED] jobId=${jobId} requestId=${requestId} url=${targetUrl} ` +
        `durationMs=${durationMs} httpStatus=${status} errorType=bad-request ` +
        `provider=ai-engine body=${bodyInfo} action=NO_RETRY`,
      );
      return new NonRetryableError(
        `AI Engine rejected the request payload (${status}). Provider response preserved: ${bodyInfo}`,
        axErr instanceof Error ? axErr : undefined,
      );
    }

    // ── 5xx : serveur AI Engine en difficulté — TRANSITOIRE ────────────────
    if (status !== undefined && status >= 500) {
      this.logger.error(
        `[DISPATCH-FAILED] jobId=${jobId} requestId=${requestId} url=${targetUrl} ` +
        `durationMs=${durationMs} httpStatus=${status} errorType=server-error ` +
        `provider=ai-engine body=${bodyInfo} action=RETRYABLE_VIA_QUEUE_BACKOFF`,
      );
      this.recordFailure();
      return new RetryableError(
        `AI Engine server error (${status}). Provider response preserved: ${bodyInfo}`,
        { kind: 'server', httpStatus: status, requestId, provider: 'ai-engine' },
        axErr instanceof Error ? axErr : undefined,
      );
    }

    // ── Pas de réponse : timeout / réseau — TRANSITOIRE ────────────────────
    const code = axErr.code ?? '';
    const isTimeout = code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout/i.test(axErr.message ?? '');
    this.logger.error(
      `[DISPATCH-FAILED] jobId=${jobId} requestId=${requestId} url=${targetUrl} ` +
      `durationMs=${durationMs} httpStatus=NO_RESPONSE errorType=${isTimeout ? 'timeout' : 'network'} ` +
      `code=${code || '-'} error=${(axErr.message ?? '').slice(0, 160)} action=RETRYABLE_VIA_QUEUE_BACKOFF`,
    );
    this.recordFailure();
    return new RetryableError(
      `AI Engine unreachable (${isTimeout ? 'timeout' : 'network'}): ${(axErr.message ?? 'no response').slice(0, 160)}`,
      { kind: isTimeout ? 'timeout' : 'network', requestId, provider: 'ai-engine' },
      axErr instanceof Error ? axErr : undefined,
    );
  }

  // ── Mock conversion — fires callback after a delay ───────
  // FIX PHASE 11 — CAUSE RACINE ZOMBIE JOBS :
  // AVANT: setTimeout async sans retry, erreur silencieuse → job reste CONVERTING
  // MAINTENANT:
  //   1. Fire le callback avec retry (3 tentatives, backoff 2s)
  //   2. Si toutes les tentatives échouent → fire un callback d'ÉCHEC
  //      pour que le job passe en FAILED (pas en zombie CONVERTING)
  //   3. Le watchdog dans cleanupStaleJobs (5min pour CONVERTING) rattrape
  //      les cas où même le callback d'échec ne peut pas être envoyé
  private mockConversion(req: AiConvertRequest): AiConvertResponse {
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
    // NOTE: Sync return — le setTimeout est lancé de façon non-bloquante.
    // FIX: on ne retourne plus une Promise ici pour éviter que le processeur
    // attende. Le callback est géré de façon fire-and-forget avec récupération d'erreur.
    const delay = 3_000 + Math.random() * 2_000;
    void this.scheduleMockCallback(jobId, sourceLanguage, targetLanguage, files, callbackUrl, delay);

    return { jobId, accepted: true, message: 'Mock conversion accepted' };
  }

  // ── Schedule mock callback with retry + failure fallback ─
  private async scheduleMockCallback(
    jobId:          string,
    sourceLanguage: string,
    targetLanguage: string,
    files:          Array<{ path: string; content: string }>,
    callbackUrl:    string,
    delay:          number,
  ): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, delay));

    const MAX_ATTEMPTS = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        this.logger.log(`[Job ${jobId}] MOCK: firing SUCCESS callback (attempt ${attempt}/${MAX_ATTEMPTS}) → ${callbackUrl}`);
        await this.fireMockCallback(jobId, sourceLanguage, targetLanguage, files, callbackUrl);
        this.logger.log(`[Job ${jobId}] MOCK: ✅ callback fired successfully`);
        return; // Success — exit
      } catch (e) {
        lastError = e as Error;
        this.logger.warn(`[Job ${jobId}] MOCK: callback attempt ${attempt}/${MAX_ATTEMPTS} failed: ${lastError.message}`);
        if (attempt < MAX_ATTEMPTS) {
          // Backoff before retry
          await new Promise<void>((resolve) => setTimeout(resolve, 2_000 * attempt));
        }
      }
    }

    // All success callback attempts failed → fire FAILURE callback
    // This prevents the job from staying CONVERTING forever (zombie job)
    this.logger.error(
      `[Job ${jobId}] MOCK: ❌ ALL ${MAX_ATTEMPTS} callback attempts failed. ` +
      `Firing FAILURE callback to prevent zombie job. Last error: ${lastError?.message}`,
    );

    try {
      await this.fireMockFailureCallback(jobId, callbackUrl, lastError?.message ?? 'Mock callback failed after 3 attempts');
      this.logger.log(`[Job ${jobId}] MOCK: failure callback sent — job will be marked FAILED`);
    } catch (failErr) {
      // Even failure callback failed — the watchdog in JobsService.cleanupStaleJobs()
      // will catch this job after CONVERTING_STALE_MINUTES and mark it FAILED
      this.logger.error(
        `[Job ${jobId}] MOCK: ❌ CRITICAL — even failure callback failed: ${(failErr as Error).message}. ` +
        `Job will be cleaned up by watchdog (CONVERTING jobs > 5min → FAILED).`,
      );
    }
  }

  // ── Fire mock failure callback → job becomes FAILED ──────
  private async fireMockFailureCallback(
    jobId:      string,
    callbackUrl: string,
    reason:     string,
  ): Promise<void> {
    const payload = {
      success: false,
      jobId,
      error: `Mock conversion callback failed: ${reason}. This job was auto-failed to prevent zombie state.`,
    };

    await firstValueFrom(
      this.http.post(callbackUrl, payload, {
        headers: { 'Content-Type': 'application/json', 'X-Source': 'codemorph-ai-mock' },
        timeout: 10_000,
      }),
    );
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

    await firstValueFrom(
      this.http.post(callbackUrl, payload, {
        headers: { 'Content-Type': 'application/json', 'X-Source': 'codemorph-ai-mock' },
        timeout: 10_000,
      }),
    );

    this.logger.log(`[Job ${jobId}] MOCK: callback fired successfully`);
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
  // FIX PHASE 32: route corrigée /health → /api/health (route réelle de l'AI Engine)
  async health(): Promise<AiHealthResponse | null> {
    if (this.mockMode) {
      return {
        status:   'mock',
        uptime:   '0s',
        services: { ai_engine: 'mock', note: 'Configure AI_ENGINE_URL for real AI processing' },
      };
    }
    try {
      // CORRECTION: l'AI Engine expose /api/health (pas /health qui retourne 404)
      const res = await firstValueFrom(
        this.http
          .get<AiHealthResponse>(`${this.baseUrl}/api/health`, { timeout: 5_000 })
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
      // FIX PHASE 37 — erreur TRANSITOIRE : le circuit se referme après
      // CIRCUIT_TIMEOUT_MS. La file retentera après le délai indiqué au lieu
      // de marquer le job FAILED immédiatement.
      const remainingMs = this.CIRCUIT_TIMEOUT_MS - elapsed;
      throw new RetryableError(
        'AI Engine is temporarily unavailable (circuit breaker open). Please try again in 30 seconds.',
        { kind: 'unavailable', retryAfterMs: remainingMs, provider: 'ai-engine' },
      );
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
