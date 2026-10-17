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
import { envInt, parseRetryAfterHeader } from '../../queue/retry-delay';

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
  /**
   * 'origin'          = le process Node de l'AI Engine a produit la réponse.
   * 'render-platform' = Render a traité la requête, mais RIEN ne prouve que
   *                     l'application a tourné.
   * 'hibernation'     = Render a REJETÉ la requête parce que l'instance free
   *                     tier est endormie — l'app n'a jamais vu la requête.
   * 'edge'            = rejet avant Render (CDN/proxy seul).
   */
  provenance: 'origin' | 'render-platform' | 'hibernation' | 'edge' | 'unknown';
  /** En-têtes non sensibles utiles, formatés pour les logs. */
  hints: string;
  /** Conclusion lisible par un opérateur. */
  verdict: string;
}

/**
 * Marqueurs émis par le PROCESS NODE de l'AI Engine lui-même.
 * Ce sont les seuls qui prouvent que l'application a réellement traité la
 * requête : `x-powered-by: Express` est posé par Express, `x-request-id` est
 * écho par notre middleware requestLogger.
 */
/**
 * États distincts du service AI Engine (FIX PHASE 43).
 * Un 429 ne signifie PAS automatiquement « en veille » : il faut l'en-tête
 * `x-render-routing` pour l'affirmer.
 */
export type AiServiceState =
  | 'ready'           // l'application répond et est opérationnelle
  | 'up-unavailable'  // l'application répond mais n'est pas prête (ex: clé manquante)
  | 'starting'        // Render a routé, l'application n'a pas encore répondu
  | 'asleep'          // rejet d'hibernation Render (x-render-routing)
  | 'rate-limited'    // 429 réel
  | 'server-error'    // 5xx émis par l'application
  | 'network-error'   // aucune réponse HTTP (DNS, refus, reset)
  | 'app-error';      // autre réponse applicative

export interface AiServiceProbe {
  state: AiServiceState;
  httpStatus?: number;
  uptime?: string;
  durationMs: number;
  detail: string;
  /** Qui a réellement répondu : l'app, la plateforme Render, ou personne. */
  source: 'app' | 'render-platform' | 'network' | 'unknown' | 'mock';
}

const APP_MARKERS = ['x-powered-by', 'x-request-id'] as const;

/**
 * ── FIX — CORRECTION DU CLASSIFICATEUR DE PHASE 39 ────────────────────────
 * Marqueurs de la PLATEFORME Render. Ils prouvent que Render a traité la
 * requête, PAS que l'application a tourné : Render les pose aussi sur ses
 * PROPRES réponses de rejet, y compris quand l'instance est endormie et n'a
 * jamais reçu la requête.
 *
 * Preuve en production : un 429 portant `rndr-id` ET
 * `x-render-routing: hibernate-rate-limited` avec durationMs=72 — le process
 * Node ne peut ni démarrer ni répondre en 72 ms. La phase 39 rangeait ce cas
 * en provenance=origin et orientait l'opérateur vers « la limite de débit de
 * l'application », alors que la cause réelle est le spin-down free tier
 * (documenté dans render.yaml : « web service avec sleep après 15min
 * d'inactivité »).
 */
const RENDER_PLATFORM_MARKERS = [
  'rndr-id',
  'x-render-origin-server',
  'x-render-routing',
] as const;

/**
 * Valeur de `x-render-routing` signalant un rejet lié à l'hibernation.
 * Observé en production : `hibernate-rate-limited`.
 */
const HIBERNATION_ROUTING_RE = /hibernate/i;

/** Vrai si les en-têtes montrent un rejet par la porte d'hibernation Render. */
export function isRenderHibernationRejection(
  rawHeaders: Record<string, string | undefined> | undefined,
): boolean {
  for (const [k, v] of Object.entries(rawHeaders ?? {})) {
    if (k.toLowerCase() === 'x-render-routing' && typeof v === 'string' && HIBERNATION_ROUTING_RE.test(v)) {
      return true;
    }
  }
  return false;
}

export function classifyRateLimitProvenance(
  rawHeaders: Record<string, string | undefined> | undefined,
): RateLimitProvenance {
  // Les en-têtes axios/AxiosHeaders peuvent être en casse mixte → on normalise.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHeaders ?? {})) {
    if (v !== undefined && v !== null) headers[k.toLowerCase()] = String(v);
  }

  const appMarkersFound      = APP_MARKERS.filter((m) => headers[m]);
  const platformMarkersFound = RENDER_PLATFORM_MARKERS.filter((m) => headers[m]);
  const appReached           = appMarkersFound.length > 0;
  const hibernation          = HIBERNATION_ROUTING_RE.test(headers['x-render-routing'] ?? '');

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
    appMarkersFound.length          ? `appMarkers=${appMarkersFound.join(',')}`                         : `appMarkers=none`,
    platformMarkersFound.length     ? `platformMarkers=${platformMarkersFound.join(',')}`               : `platformMarkers=none`,
  ].filter(Boolean).join(' ');

  // ── 1. HIBERNATION — l'instance free tier est endormie ────────────────────
  // Testé EN PREMIER : c'est le seul cas où Render renvoie un 429 avec ses
  // propres marqueurs de plateforme alors que l'application n'a pas tourné.
  if (hibernation) {
    return {
      provider:   'render-hibernation',
      provenance: 'hibernation',
      hints,
      verdict:
        'Render a REJETÉ la requête à l\'éveil de l\'instance ' +
        `(${headers['x-render-routing']}). L'AI Engine est sur le plan free et s'est ` +
        'endormi après 15 min sans trafic ; le réveil prend environ une minute ' +
        '(documentation Render). Ce n\'est NI une limite de débit applicative, NI un ' +
        'blocage Cloudflare : l\'application n\'a jamais reçu la requête. ' +
        'Corriger en attendant le réveil (retry espacé), pas en augmentant la cadence.',
    };
  }

  // ── 2. ORIGINE APPLICATIVE — le process Node a vraiment répondu ───────────
  if (appReached) {
    return {
      provider:   'ai-engine-origin',
      provenance: 'origin',
      hints,
      verdict:
        'La réponse 429 porte un marqueur émis par l\'application elle-même ' +
        `(${appMarkersFound.join(', ')}). Elle a donc atteint le process Node de l'AI ` +
        'Engine. Chercher la limite de débit côté application, pas côté Cloudflare.',
    };
  }

  // ── 3. PLATEFORME RENDER — traitée par Render, pas par l'app ──────────────
  if (platformMarkersFound.length > 0) {
    return {
      provider:   'render-platform',
      provenance: 'render-platform',
      hints,
      verdict:
        'La réponse 429 porte uniquement des marqueurs de la plateforme Render ' +
        `(${platformMarkersFound.join(', ')}), aucun marqueur applicatif ` +
        '(ni x-powered-by, ni x-request-id). Render a traité la requête mais rien ne ' +
        "prouve que le process Node a tourné. Vérifier l'état de l'instance " +
        '(endormie / en cours de démarrage / suspendue) avant de suspecter le code.',
    };
  }

  if (headers['server'] || headers['cf-ray'] || headers['via']) {
    return {
      provider:   'edge-or-proxy',
      provenance: 'edge',
      hints,
      verdict:
        'La réponse 429 ne porte AUCUN marqueur applicatif ni Render ' +
        "(ni x-powered-by, ni x-request-id, ni rndr-id, ni x-render-origin-server) " +
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
      'Aucun marqueur applicatif, Render ou intermédiaire : provenance indéterminée. ' +
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

  // ── FIX PHASE 43 — Budget de RÉVEIL, distinct du temps de traitement IA ──
  // Une instance Render free tier endormie met ~1 min à redémarrer (doc Render).
  // Ce budget borne le temps passé à ATTENDRE le réveil, sans toucher au timeout
  // global de conversion (inchangé). Suivi par jobId : le job et son snapshot
  // sont conservés d'une tentative à l'autre, rien n'est recréé.
  /** Horodatage de la dernière sonde par job (anti-boucle de réveil). */
  private readonly lastProbeAt = new Map<string, number>();
  private readonly lastProbeResult = new Map<string, AiServiceProbe>();

  private readonly wakeTrack = new Map<string, {
    firstAt: number; attempts: number; totalWaitMs: number;
  }>();
  /** Durée totale max consacrée au réveil d'un job (env: AI_ENGINE_WAKE_BUDGET_MS). */
  private get wakeBudgetMs(): number {
    return envInt('AI_ENGINE_WAKE_BUDGET_MS', 240_000, 30_000, 1_800_000);
  }
  /** Nombre max de tentatives de réveil pour un même job. */
  private get wakeMaxAttempts(): number {
    return envInt('AI_ENGINE_WAKE_MAX_ATTEMPTS', 6, 1, 20);
  }
  /** Délai de base avant une tentative de réveil (env: AI_ENGINE_HIBERNATION_WAIT_MS). */
  private get hibernationBaseWaitMs(): number {
    return envInt('AI_ENGINE_HIBERNATION_WAIT_MS', 45_000, 5_000, 600_000);
  }

  /**
   * Backoff PROGRESSIF avec jitter pour le réveil d'une instance endormie.
   * Progressif : chaque tentative attend un peu plus longtemps, car un spin-up
   * Render peut dépasser la minute. Jitter ±20 % pour désynchroniser les jobs.
   * Ce n'est qu'un PLANCHER : `computeRetryDelayMs` prend le max avec le backoff
   * standard, il ne peut donc jamais raccourcir une attente existante.
   */
  private computeWakeFloorMs(attempt: number): number {
    const base   = this.hibernationBaseWaitMs;
    const capped = Math.min(base + (attempt - 1) * 15_000, 180_000);
    // FIX PHASE 45 — le jitter ne doit JAMAIS descendre sous le délai de base.
    //
    // La Phase 43 utilisait un jitter de ±20 %, ce qui pouvait ramener le
    // plancher à 36 s pour un spin-up Render documenté à ~1 minute : le plancher
    // ne couvrait alors plus le cas qu'il est censé couvrir. Un test existant
    // (`ai-engine.hibernation.spec.ts`) l'a détecté.
    //
    // Le jitter sert à désynchroniser les jobs concurrents, pas à raccourcir
    // l'attente physique : il est donc strictement ASCENDANT (+0 à +40 %).
    const jitter = 1.0 + Math.random() * 0.4;
    return Math.round(capped * jitter);
  }

  /** Oublie le suivi de réveil d'un job (succès ou abandon terminal). */
  private clearWakeTrack(jobId: string): void {
    this.wakeTrack.delete(jobId);
  }

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
      // FIX PHASE 43 — l'instance a répondu : le réveil a réussi. On oublie le
      // suivi de budget pour ce job (évite toute fuite de la Map).
      if (this.wakeTrack.has(req.jobId)) {
        const t = this.wakeTrack.get(req.jobId);
        this.logger.log(
          `[DISPATCH-WAKE-RECOVERED] jobId=${req.jobId} requestId=${requestId} ` +
          `wakeAttempts=${t?.attempts ?? 0} wakeElapsedMs=${Date.now() - (t?.firstAt ?? Date.now())} ` +
          `serviceState=awake action=RESUME_NORMAL_DISPATCH`,
        );
        this.clearWakeTrack(req.jobId);
      }

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

      // ── CAS PARTICULIER : rejet à l'éveil d'une instance free tier ────────
      // `x-render-routing: hibernate-rate-limited` + durée de quelques dizaines
      // de ms = Render a refusé de réveiller l'instance. L'application n'a pas
      // tourné. Augmenter la cadence des tentatives aggrave le cas : il faut au
      // contraire laisser le temps du spin-up (~1 minute, doc Render).
      if (prov.provenance === 'hibernation') {
        // ── Budget de réveil : distinct du temps de traitement IA ────────────
        const now = Date.now();
        const track = this.wakeTrack.get(jobId) ?? { firstAt: now, attempts: 0, totalWaitMs: 0 };
        track.attempts += 1;
        const floorMs = this.computeWakeFloorMs(track.attempts);
        track.totalWaitMs += floorMs;
        this.wakeTrack.set(jobId, track);

        const elapsedMs  = now - track.firstAt;
        const budgetMs   = this.wakeBudgetMs;
        // `>=` et non `>` : `wakeMaxAttempts` est le nombre MAX de tentatives de
        // réveil. À la dernière tentative autorisée on abandonne au lieu de
        // planifier un retry qui ne sera jamais exécuté.
        const exhausted  = track.attempts >= this.wakeMaxAttempts
          || elapsedMs + floorMs > budgetMs;

        // ── Budget épuisé → erreur EXPLICITE et exploitable, pas un échec générique
        if (exhausted) {
          this.clearWakeTrack(jobId);
          this.logger.error(
            `[DISPATCH-WAKE-EXHAUSTED] jobId=${jobId} requestId=${requestId} url=${targetUrl} ` +
            `httpStatus=429 errorType=hibernation wakeAttempts=${track.attempts} ` +
            `wakeElapsedMs=${elapsedMs} wakeBudgetMs=${budgetMs} ` +
            `wakeMaxAttempts=${this.wakeMaxAttempts} ` +
            `renderRouting=${(headers['x-render-routing'] ?? '').slice(0, 40)} ` +
            `serviceState=asleep-did-not-wake action=FAIL_EXPLICIT_NO_MORE_RETRIES ` +
            `hint="Render free-tier instance did not wake up within the wake budget. ` +
            `Fix: use a paid Render instance (paid plans do not spin down) or an external ` +
            `keep-awake ping; then retry the same job — its source snapshot is preserved."`,
          );
          return new NonRetryableError(
            `AI Engine did not wake up: the Render instance stayed hibernating ` +
            `(x-render-routing: ${headers['x-render-routing'] ?? 'hibernate-rate-limited'}) ` +
            `after ${track.attempts} attempts over ${Math.round(elapsedMs / 1000)}s ` +
            `(wake budget ${Math.round(budgetMs / 1000)}s). ` +
            `The AI Engine code was never reached — this is a platform wake-up failure, ` +
            `not a conversion error. ` +
            `Fix: switch the AI Engine to a paid Render instance (paid plans do not spin ` +
            `down) or add an external keep-awake ping, then retry the same job — ` +
            `its source snapshot is preserved, nothing needs re-uploading.`,
          );
        }

        this.logger.warn(
          `[DISPATCH-429-HIBERNATION] jobId=${jobId} requestId=${requestId} url=${targetUrl} ` +
          `durationMs=${durationMs} httpStatus=429 errorType=hibernation serviceState=asleep ` +
          `layer=render-routing renderRouting=${(headers['x-render-routing'] ?? '').slice(0, 40)} ` +
          `provider=${prov.provider} provenance=hibernation ` +
          `retryAfterHeader=${headers['retry-after'] ?? '(absent)'} ` +
          `wakeAttempt=${track.attempts}/${this.wakeMaxAttempts} ` +
          `wakeElapsedMs=${elapsedMs}/${budgetMs} nextAttemptFloorMs=${floorMs} ` +
          `body=${bodyInfo} hints=[${prov.hints || 'none'}] ` +
          `verdict="${prov.verdict}" action=WAIT_FOR_SPIN_UP_VIA_QUEUE_BACKOFF`,
        );
        return new RetryableError(
          `AI Engine unreachable: Render free-tier instance is hibernating ` +
          `(${headers['x-render-routing']}). The service spins back up in about a minute; ` +
          `the job will be retried automatically (attempt ${track.attempts}/${this.wakeMaxAttempts}) ` +
          `with a wait floor of ${Math.round(floorMs / 1000)}s.`,
          {
            kind: 'rate-limit', httpStatus: 429, retryAfterMs,
            // Plancher PROGRESSIF avec jitter. `computeRetryDelayMs` l'applique via
            // Math.max : il allonge l'attente, ne la raccourcit jamais.
            minDelayMs: floorMs, requestId, provider: prov.provider,
          },
          axErr instanceof Error ? axErr : undefined,
        );
      }

      this.logger.error(
        `[DISPATCH-429] jobId=${jobId} requestId=${requestId} url=${targetUrl} ` +
        `durationMs=${durationMs} httpStatus=429 errorType=rate-limit ` +
        `layer=${prov.provenance === 'origin' ? 'ai-engine-app' : prov.provenance === 'render-platform' ? 'render-platform' : prov.provenance} ` +
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
  // ── FIX PHASE 43 — Sonde d'état RÉEL du service ────────────────────────────
  //
  // `health()` historique retourne `null` pour TOUTE erreur : il est impossible
  // de distinguer une instance endormie d'un 5xx applicatif ou d'une panne DNS.
  // Cette sonde classe explicitement les états, en s'appuyant sur les marqueurs
  // d'origine déjà établis : seuls `x-powered-by` / un `x-request-id` écho prouvent
  // que le process Node a répondu. Les en-têtes Render (`rndr-id`,
  // `x-render-origin-server`, `server: cloudflare`) sont présents sur TOUTES les
  // réponses et ne prouvent rien.
  //
  // Un 429 n'est PAS supposé signifier « en veille » : il faut l'en-tête
  // `x-render-routing` pour l'affirmer.
  /**
   * Sonde l'état réel de l'AI Engine. Ne lève jamais d'exception.
   * Cadencée : au plus une sonde par `AI_ENGINE_PROBE_MIN_INTERVAL_MS` (20 s)
   * pour un même jobId, afin de ne jamais créer de boucle de réveil.
   */
  async probeServiceState(jobId?: string): Promise<AiServiceProbe> {
    if (this.mockMode) {
      return { state: 'ready', durationMs: 0, detail: 'mock mode', source: 'mock' };
    }
    // Anti-boucle : une seule sonde par intervalle pour un job donné.
    if (jobId) {
      const last = this.lastProbeAt.get(jobId);
      const minInterval = envInt('AI_ENGINE_PROBE_MIN_INTERVAL_MS', 20_000, 1_000, 300_000);
      if (last !== undefined && Date.now() - last < minInterval) {
        const cached = this.lastProbeResult.get(jobId);
        if (cached) return { ...cached, detail: `${cached.detail} (cached, throttled)` };
      }
      this.lastProbeAt.set(jobId, Date.now());
    }

    const url = `${this.baseUrl}/api/health`;
    const start = Date.now();
    try {
      const res = await firstValueFrom(
        this.http
          .get<Record<string, unknown>>(url, { timeout: 8_000 })
          .pipe(timeout(9_000)),
      );
      const durationMs = Date.now() - start;
      const status = (res.data['status'] as string | undefined) ?? 'unknown';
      const uptime = res.data['uptime'] as string | undefined;
      const probe: AiServiceProbe = {
        state: 'ready',
        httpStatus: res.status,
        uptime,
        durationMs,
        detail: `health responded status=${status}`,
        source: 'app',
      };
      if (jobId) this.lastProbeResult.set(jobId, probe);
      return probe;
    } catch (err) {
      const durationMs = Date.now() - start;
      const axErr = err as AxiosError;
      const status = axErr.response?.status;
      const headers = (axErr.response?.headers ?? {}) as Record<string, string | undefined>;
      const appAnswered = APP_MARKERS.some((m) => headers[m] !== undefined);

      let probe: AiServiceProbe;
      if (status === 429 && isRenderHibernationRejection(headers)) {
        probe = {
          state: 'asleep', httpStatus: 429, durationMs, source: 'render-platform',
          detail: `Render refused to wake the instance (x-render-routing: ${headers['x-render-routing']})`,
        };
      } else if (status === 429) {
        probe = {
          state: 'rate-limited', httpStatus: 429, durationMs,
          source: appAnswered ? 'app' : 'render-platform',
          detail: appAnswered
            ? 'genuine 429 from the application (app markers present)'
            : '429 without hibernation marker and without app markers — platform, not app',
        };
      } else if (status === 503 && appAnswered) {
        // L'ORDRE COMPTE : 503 avec marqueur applicatif = l'app tourne mais n'est
        // pas prête (ex: clé API manquante → /readiness renvoie 503). Ce cas doit
        // être testé AVANT les branches 5xx génériques, sinon il est masqué.
        probe = {
          state: 'up-unavailable', httpStatus: 503, durationMs, source: 'app',
          detail: 'app answered 503 — running but not ready (e.g. missing API key)',
        };
      } else if (status !== undefined && status >= 500 && status <= 599 && !appAnswered) {
        // 5xx SANS marqueur applicatif : le routing Render a répondu, l'app pas encore.
        probe = {
          state: 'starting', httpStatus: status, durationMs, source: 'render-platform',
          detail: `${status} from Render routing with no app markers — service is starting up`,
        };
      } else if (status !== undefined && status >= 500) {
        probe = {
          state: 'server-error', httpStatus: status, durationMs, source: 'app',
          detail: `${status} returned by the application itself`,
        };
      } else if (axErr.response === undefined) {
        probe = {
          state: 'network-error', durationMs, source: 'network',
          detail: `no HTTP response at all: ${(axErr.code ?? axErr.message ?? 'unknown').slice(0, 80)}`,
        };
      } else {
        probe = {
          state: 'app-error', httpStatus: status, durationMs,
          source: appAnswered ? 'app' : 'unknown',
          detail: `unexpected status ${status} (appAnswered=${appAnswered})`,
        };
      }
      if (jobId) this.lastProbeResult.set(jobId, probe);
      return probe;
    }
  }

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
