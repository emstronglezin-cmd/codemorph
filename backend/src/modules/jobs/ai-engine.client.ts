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

// ============================================================
// FIX PHASE 39 — PROVENANCE RÉELLE DU 429 (au lieu d'une supposition)
// ------------------------------------------------------------
// Les phases 37 et 38 ont étiqueté le 429 `provider=ai-engine-edge` en DUR,
// puis conclu « c'est l'edge Render/Cloudflare ». Or cette étiquette n'était
// pas une observation : elle était écrite dans le code avant même d'avoir lu
// la réponse. Vérifications faites le 2026-10-11 sur l'instance réelle
// https://codemorph-1-rdx0.onrender.com :
//   • `server: cloudflare` est présent sur TOUTES les réponses (200, 400, 401)
//     car Render place tous les *.onrender.com derrière Cloudflare
//     (`x-render-origin-server: Render` + `rndr-id` le confirment).
//     → `server: cloudflare` ne discrimine RIEN.
//   • 25 requêtes séquentielles puis 80 requêtes parallèles sur
//     POST /api/convert → 0 × 429. L'edge ne limite pas à ce volume.
//   • Un POST de 200 Ko / 50 fichiers traverse l'edge sans 429.
//   • Aucun chemin de code de ce dépôt n'émet de 429 (grep exhaustif).
// Donc : pour savoir QUI a répondu 429, il faut regarder les en-têtes qui
// prouvent le passage par l'ORIGINE applicative, et non `server`.
//
// Marqueurs d'origine (ajoutés par Render/Express, jamais par un CDN seul) :
//   rndr-id                  → posé par le routeur Render
//   x-render-origin-server   → posé par Render quand l'origine a répondu
//   x-render-routing         → posé par Render (ex: "no-server")
//   x-powered-by: Express    → posé par l'application Express elle-même
//   x-request-id             → écho par notre requestLogger (middleware app)
// Si AU MOINS UN est présent → la réponse vient de l'origine applicative.
// Si AUCUN n'est présent     → la réponse a été produite AVANT l'application.
// ============================================================

export interface RateLimitProvenance {
  /** Nom de fournisseur déduit (jamais une supposition codée en dur). */
  provider: string;
  /** 'origin' = réponse produite/traversée par l'app ; 'edge' = avant l'app. */
  provenance: 'origin' | 'edge' | 'unknown';
  /** En-têtes non sensibles utiles, formatés pour les logs. */
  hints: string;
  /** Conclusion lisible par un opérateur. */
  verdict: string;
}

/** Marqueurs prouvant que la réponse a atteint l'origine applicative. */
const ORIGIN_MARKERS = [
  'rndr-id',
  'x-render-origin-server',
  'x-render-routing',
  'x-powered-by',
  'x-request-id',
] as const;

export function classifyRateLimitProvenance(
  rawHeaders: Record<string, string | undefined> | undefined,
): RateLimitProvenance {
  // Les en-têtes axios/AxiosHeaders peuvent être en casse mixte → on normalise.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHeaders ?? {})) {
    if (v !== undefined && v !== null) headers[k.toLowerCase()] = String(v);
  }

  const markersFound = ORIGIN_MARKERS.filter((m) => headers[m]);
  const originReached = markersFound.length > 0;

  const hints = [
    headers['server']               ? `server=${headers['server'].slice(0, 40)}`                        : null,
    headers['via']                  ? `via=${headers['via'].slice(0, 60)}`                              : null,
    headers['cf-ray']               ? `cfRay=${headers['cf-ray'].slice(0, 24)}`                         : null,
    headers['rndr-id']              ? `rndrId=${headers['rndr-id'].slice(0, 32)}`                       : null,
    headers['x-render-origin-server'] ? `renderOrigin=${headers['x-render-origin-server'].slice(0, 32)}` : null,
    headers['x-render-routing']     ? `renderRouting=${headers['x-render-routing'].slice(0, 32)}`       : null,
    headers['x-powered-by']         ? `poweredBy=${headers['x-powered-by'].slice(0, 32)}`               : null,
    headers['x-request-id']         ? `upstreamRequestId=${headers['x-request-id'].slice(0, 64)}`       : null,
    headers['content-type']         ? `contentType=${headers['content-type'].slice(0, 48)}`             : null,
    headers['content-length']       ? `contentLength=${headers['content-length'].slice(0, 16)}`         : null,
    markersFound.length             ? `originMarkers=${markersFound.join(',')}`                         : `originMarkers=none`,
  ].filter(Boolean).join(' ');

  if (originReached) {
    return {
      provider:   'ai-engine-origin',
      provenance: 'origin',
      hints,
      verdict:
        'La réponse 429 porte au moins un marqueur d\'origine applicative ' +
        `(${markersFound.join(', ')}). Elle a donc atteint le process Node de l'AI Engine ` +
        '(ou son routeur Render), et NON un simple CDN. Chercher la limite de débit côté ' +
        'application / plan Render, pas côté Cloudflare.',
    };
  }

  if (headers['server'] || headers['cf-ray'] || headers['via']) {
    return {
      provider:   'edge-or-proxy',
      provenance: 'edge',
      hints,
      verdict:
        'La réponse 429 ne porte AUCUN marqueur d\'origine applicative ' +
        "(ni rndr-id, ni x-render-origin-server, ni x-powered-by, ni x-request-id) " +
        'alors qu\'un en-tête d\'intermédiaire est présent. La requête a été rejetée ' +
        "AVANT d'atteindre le process Node — d'où l'absence de log Runtime. " +
        'C\'est la seule configuration qui prouve un rejet par la couche intermédiaire.',
    };
  }

  return {
    provider:   'unknown',
    provenance: 'unknown',
    hints,
    verdict:
      'Aucun marqueur d\'origine et aucun marqueur d\'intermédiaire : provenance indéterminée. ' +
      'Ne pas conclure. Capturer la réponse brute avant de modifier quoi que ce soit.',
  };
}

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

  // ── FIX PHASE 38 — Dispatch concurrency limiter ──────────────────────
  // Empêche de saturer le endpoint AI Engine sur Render (free tier rate-limit).
  // Maximum MAX_DISPATCH_CONCURRENT requêtes HTTP simultanées vers l'AI Engine.
  // Les requêtes supplémentaires attendent qu'un slot se libère.
  // Ceci ne remplace PAS le rate-limiter Groq côté AI Engine — il protège
  // uniquement la couche edge/proxy Render devant l'AI Engine.
  private dispatchInFlight = 0;
  private dispatchWaitQueue: Array<() => void> = [];
  private readonly MAX_DISPATCH_CONCURRENT = 2; // conservatif pour Render free tier

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

  // ── Dispatch concurrency semaphore ──────────────────────────────────
  // FIX PHASE 38 : Limite le nombre de dispatch HTTP simultanés vers l'AI Engine
  // pour éviter les 429 de l'edge Render. Les dispatch supplémentaires attendent.
  // FIX PHASE 39 — RACE DE SUR-ADMISSION CORRIGÉE.
  // AVANT :
  //   acquire : si plein → await (file d'attente) ; à la reprise → inFlight++
  //   release : inFlight-- PUIS résolution du suivant (microtâche)
  //   Séquence fautive avec MAX=2 et 2 en vol + C en attente :
  //     release()  → inFlight=1, C résolu (microtâche en suspens)
  //     nouvel appel D arrive SYNCHRONE : 1 < 2 → inFlight=2, D admis
  //     microtâche de C : inFlight=3  ← 3 requêtes simultanées pour MAX=2
  //   La limite de concurrence était donc violable précisément quand on en a
  //   besoin, c'est-à-dire sous charge — le cas que ce sémaphore doit protéger.
  // APRÈS : le slot est TRANSFÉRÉ au suivant sans jamais être décrémenté, donc
  //   aucune fenêtre où un nouvel appel pourrait passer devant. Le compteur ne
  //   baisse que lorsqu'il n'y a plus personne en attente.
  private async acquireDispatchSlot(): Promise<() => void> {
    if (this.dispatchInFlight < this.MAX_DISPATCH_CONCURRENT) {
      this.dispatchInFlight++;
      return () => this.releaseDispatchSlot();
    }
    // Pas de slot libre : on attend un TRANSFERT de slot. Le compteur n'est pas
    // touché ici — il l'a déjà été par l'appelant initial.
    await new Promise<void>((resolve) => this.dispatchWaitQueue.push(resolve));
    return () => this.releaseDispatchSlot();
  }

  private releaseDispatchSlot(): void {
    const next = this.dispatchWaitQueue.shift();
    if (next) {
      // Transfert direct : le slot passe au suivant, inFlight reste inchangé.
      next();
      return;
    }
    this.dispatchInFlight = Math.max(0, this.dispatchInFlight - 1);
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

    // FIX PHASE 38/39 — Concurrency limiter : attendre un slot avant d'envoyer.
    // FIX PHASE 39 : l'acquisition est placée IMMÉDIATEMENT avant le try/finally
    // qui libère le slot. Auparavant, ~20 lignes (construction du payload, des
    // en-têtes) s'exécutaient entre l'acquisition et le try : toute exception y
    // levant aurait fait fuir le slot définitivement (capacité réduite à vie).
    // Le slot est aussi tenu moins longtemps, ce qui améliore le débit utile.
    const releaseSlot = await this.acquireDispatchSlot();
    this.logger.log(
      `[DISPATCH-SLOT] jobId=${req.jobId} acquired — inFlight=${this.dispatchInFlight}/${this.MAX_DISPATCH_CONCURRENT}`,
    );

    const httpStart = Date.now();
    try {
      const res = await firstValueFrom(
        this.http
          .post<AiConvertResponse>(targetUrl, payload, {
            headers:         extraHeaders,
            timeout:         30_000,
            // FIX PHASE 39 — BUG DE CLASSIFICATION (avait survécu à la phase 34) :
            // AVANT : `validateStatus: (s) => s === 202`. Si l'AI Engine répondait
            //   200 (ou tout autre 2xx), axios levait une AxiosError que
            //   classifyDispatchError ne rangeait dans AUCUNE branche 4xx/5xx →
            //   elle retombait sur la branche « pas de réponse » et produisait
            //   RetryableError kind=network, httpStatus=undefined, + recordFailure()
            //   qui ouvrait le circuit breaker. Un SUCCÈS était donc traité comme
            //   une panne réseau : retries inutiles + circuit ouvert à tort.
            // APRÈS : tout 2xx est un succès ; `accepted` est déduit du corps,
            //   avec repli sur le statut. Le comportement nominal (202 + accepted)
            //   est strictement préservé.
            validateStatus:  (s) => s >= 200 && s < 300,
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
      // FIX PHASE 39 — `accepted` déduit du corps, repli sur le statut 2xx.
      const accepted: boolean =
        typeof data.accepted === 'boolean' ? data.accepted : res.status >= 200 && res.status < 300;
      this.logger.log(
        `[DISPATCH-RESPONSE] jobId=${req.jobId} requestId=${requestId} httpStatus=${res.status} ` +
        `durationMs=${durationMs} aiEngineJobId=${aiEngineJobId} accepted=${accepted} ` +
        `message=${data.message ?? '(none)'}`,
      );
      this.recordSuccess();

      // L'AI Engine répond { jobId, accepted: true, message } avec 202.
      // Tout autre 2xx est accepté : `accepted` vient alors du corps ou du statut.
      return {
        jobId:    aiEngineJobId,
        accepted,
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
    } finally {
      // FIX PHASE 38 — Toujours libérer le slot de concurrence, même en cas d'erreur
      releaseSlot();
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
      const prov = classifyRateLimitProvenance(headers);

      this.logger.error(
        `[DISPATCH-429] jobId=${jobId} requestId=${requestId} url=${targetUrl} ` +
        `durationMs=${durationMs} httpStatus=429 errorType=rate-limit ` +
        `provider=${prov.provider} provenance=${prov.provenance} ` +
        `retryAfterMs=${retryAfterMs ?? 'none'} ` +
        `retryAfterHeader=${headers['retry-after'] ?? '(absent)'} ` +
        `body=${bodyInfo} originHints=[${prov.hints || 'none'}] ` +
        `verdict="${prov.verdict}" action=RETRYABLE_VIA_QUEUE_BACKOFF`,
      );
      return new RetryableError(
        `AI Engine rate limited (429): too many requests. ` +
        `${retryAfterMs !== undefined ? `Server asked to wait ${Math.round(retryAfterMs / 1000)}s. ` : ''}` +
        `The job will be retried automatically by the queue.`,
        { kind: 'rate-limit', httpStatus: 429, retryAfterMs, requestId, provider: prov.provider },
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

    // ── FIX PHASE 39 — Garde-fou : 2xx/3xx inattendu ────────────────────────
    // Ne peut normalement plus arriver (validateStatus accepte tout 2xx), mais
    // si un 3xx dépasse maxRedirects, axios lève avec une réponse. Sans cette
    // branche, on retomberait sur « pas de réponse » et on étiquetterait à tort
    // errorType=network + recordFailure() (circuit breaker).
    if (status !== undefined && status >= 200 && status < 400) {
      this.logger.error(
        `[DISPATCH-FAILED] jobId=${jobId} requestId=${requestId} url=${targetUrl} ` +
        `durationMs=${durationMs} httpStatus=${status} errorType=unexpected-status ` +
        `provider=ai-engine body=${bodyInfo} action=RETRYABLE_VIA_QUEUE_BACKOFF`,
      );
      return new RetryableError(
        `AI Engine returned an unexpected status (${status}) for a dispatch. Provider response preserved: ${bodyInfo}`,
        { kind: 'unknown', httpStatus: status, requestId, provider: 'ai-engine' },
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
