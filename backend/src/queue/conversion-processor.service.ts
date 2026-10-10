// ============================================================
// CodeMorph — ConversionProcessorService
// PHASE 26 — Logique de traitement partagée
//
// Ce service contient la logique métier de traitement d'un job
// de conversion, extraite de JobsProcessor.
// Il est utilisé par :
//   • JobsProcessor (chemin Bull/Redis)
//   • MemoryQueueProvider (chemin Memory/fallback)
//
// Un seul endroit pour la logique → cohérence garantie.
// ============================================================
import { Injectable, Logger } from '@nestjs/common';

import { JobsService }         from '../modules/jobs/jobs.service';
import { JobStatus, JobType }  from '../modules/jobs/jobs.entity';
import { GitHubApiService }    from '../modules/github/github-api.service';
import { UploadsService }      from '../modules/uploads/uploads.service';
import { QuotaService }        from '../modules/quota/quota.service';
import { SubscriptionService } from '../modules/subscription/subscription.service';
import { getPlanLimits }       from '../modules/subscription/plan-limits.config';
// FIX PHASE 35 — NonRetryableError : signale à MemoryQueue qu'un job terminal ne doit pas être retenté
import { NonRetryableError }   from './non-retryable.error';
// FIX PHASE 37 — RetryableError + stratégie de délai unique :
// une erreur transitoire (429, 5xx, timeout, réseau, quota local) ne marque
// PLUS le job FAILED — la file (Bull ou Memory) planifie la tentative suivante.
import { RetryableError, isNonRetryableError, retryAfterMsOf } from './retryable.error';
import { computeRetryDelayMs, getMaxAttempts }                  from './retry-delay';

export interface ConversionJobPayload {
  jobId: string;
  dto: {
    userId:         string;
    type:           JobType;
    sourceLanguage: string;
    targetLanguage: string;
    sourceRepo?:    string;
    sourceBranch?:  string;
    zipPath?:       string;
    goalPrompt?:    string;
  };
}

export interface ProcessAttemptInfo {
  /** Numéro de tentative (0 = première) */
  attemptsMade: number;
  /**
   * Nombre max de tentatives pour ce job.
   * FIX PHASE 37 — le processeur ne marque FAILED qu'une fois ce seuil
   * réellement atteint (ou sur erreur non-réessayable). Défaut: getMaxAttempts().
   */
  maxAttempts?: number;
}

@Injectable()
export class ConversionProcessorService {
  private readonly logger = new Logger(ConversionProcessorService.name);

  constructor(
    private readonly jobsService:      JobsService,
    private readonly githubApiService: GitHubApiService,
    private readonly uploadsService:   UploadsService,
    private readonly quotaService:     QuotaService,
    private readonly subscriptionSvc:  SubscriptionService,
  ) {}

  /**
   * Traite un job de conversion.
   * Appelé par JobsProcessor (Bull) ET par MemoryQueueProvider.
   *
   * @throws Relance l'erreur pour que le caller (Bull/MemoryQueue) gère retry/FAILED
   */
  async processConversionJob(
    payload:     ConversionJobPayload,
    attemptInfo: ProcessAttemptInfo,
  ): Promise<void> {
    const { jobId, dto } = payload;
    const tag = `[Job ${jobId}]`;
    // FIX PHASE 37 — true dès que checkAiRateLimit a incrémenté le compteur.
    // Permet de restituer le quota si la tentative échoue AVANT toute requête AI.
    let aiRateLimitIncremented = false;

    this.logger.log(
      `[PIPELINE] Worker started — jobId=${jobId} type=${dto.type} ` +
      `attempt=${attemptInfo.attemptsMade + 1}`,
    );
    this.logger.log(`${tag} src=${dto.sourceLanguage} tgt=${dto.targetLanguage} userId=${dto.userId}`);

    // Récupérer le plan utilisateur
    const plan   = await this.subscriptionSvc.getUserPlan(dto.userId);
    const limits = getPlanLimits(plan);
    this.logger.log(`${tag} plan=${plan} maxFiles=${limits.maxFilesPerProject}`);

    // ── Phase 1: Mise à jour statut → ANALYZING ────────────────────────────
    // FIX PHASE 37 — Ce bloc est VOLONTAIREMENT HORS du try/catch :
    // un NonRetryableError levé ici (job déjà DONE/FAILED en base) doit être
    // propagé tel quel à la file SANS repasser par le marquage FAILED du catch
    // (on ne ré-écrit jamais un job terminé — son résultat est préservé).
    if (attemptInfo.attemptsMade === 0) {
      await this.jobsService.updateStatus(jobId, JobStatus.ANALYZING);
    } else {
      const currentJob = await this.jobsService.findById(jobId);
      if (currentJob.status === JobStatus.DONE) {
        // Un job TERMINÉ n'est jamais exécuté une seconde fois.
        this.logger.warn(
          `${tag} [NON-RETRYABLE] Attempt ${attemptInfo.attemptsMade + 1}: job déjà DONE — ` +
          `résultat préservé, aucune ré-exécution.`,
        );
        throw new NonRetryableError(
          `Job ${jobId} est déjà terminé (DONE). Ré-exécution refusée, résultat préservé.`,
        );
      }
      if (currentJob.status === JobStatus.FAILED) {
        // FIX PHASE 35/37 — job déjà terminal en base : abandon immédiat.
        // (Avec le fix Phase 37, un job n'atteint FAILED qu'à épuisement des
        // tentatives ou sur erreur permanente — ce cas ne doit plus arriver
        // lors d'un retry légitime, mais le garde-fou reste.)
        this.logger.warn(
          `${tag} [NON-RETRYABLE] Attempt ${attemptInfo.attemptsMade + 1}: job déjà terminal ` +
          `(status=${currentJob.status}) — abandon immédiat, pas de retry.`,
        );
        throw new NonRetryableError(
          `Job ${jobId} est déjà en statut terminal (${currentJob.status}). Retry abandonné.`,
        );
      }
      await this.jobsService.updateStatus(jobId, JobStatus.ANALYZING);
    }

    try {
      await this.jobsService.appendLog(
        jobId, 'ast-analysis', 'running',
        `Récupération des fichiers sources… (tentative ${attemptInfo.attemptsMade + 1})`,
      );

      // ── Phase 2: Récupération des fichiers sources ─────────
      let files: Array<{ path: string; content: string }> = [];

      if (dto.type === JobType.GITHUB_IMPORT) {
        if (!dto.sourceRepo) throw new Error('GITHUB_IMPORT: sourceRepo requis.');
        this.logger.log(
          `[PIPELINE] Fetching GitHub repo: ${dto.sourceRepo}@${dto.sourceBranch ?? 'main'}`,
        );
        await this.jobsService.appendLog(
          jobId, 'ast-analysis', 'running',
          `Récupération depuis GitHub: ${dto.sourceRepo}@${dto.sourceBranch ?? 'main'}…`,
        );
        files = await this.githubApiService.fetchRepoFiles(
          dto.sourceRepo, dto.sourceBranch ?? 'main', dto.userId,
        );
        this.logger.log(`[PIPELINE] GitHub files fetched: ${files.length} fichiers`);

      } else if (
        dto.type === JobType.ZIP_IMPORT ||
        dto.type === JobType.URL_IMPORT
      ) {
        if (!dto.zipPath) throw new Error(`${dto.type}: zipPath requis.`);
        const label = dto.type === JobType.URL_IMPORT ? 'URL download' : 'ZIP upload';
        this.logger.log(`[PIPELINE] ZIP extrait — path=${dto.zipPath} type=${label}`);
        await this.jobsService.appendLog(
          jobId, 'ast-analysis', 'running',
          `Extraction des fichiers depuis ${label}…`,
        );
        files = await this.uploadsService.extractZipFiles(dto.zipPath);
        this.logger.log(`[PIPELINE] ${files.length} fichiers extraits depuis ${label}`);

      } else {
        throw new Error(`Type de job non supporté: ${dto.type}.`);
      }

      // Appliquer la limite de fichiers du plan
      if (limits.maxFilesPerProject > 0 && files.length > limits.maxFilesPerProject) {
        this.logger.warn(`${tag} Troncature à ${limits.maxFilesPerProject} fichiers (limite plan)`);
        files = files.slice(0, limits.maxFilesPerProject);
      }

      await this.jobsService.appendLog(
        jobId, 'ast-analysis', 'done',
        `${files.length} fichiers sources chargés`,
      );

      if (files.length === 0) {
        throw new Error(
          'Aucun fichier source trouvé après import. ' +
          'GitHub: vérifier l\'accès au repo et qu\'il contient des fichiers de code. ' +
          'ZIP: vérifier que l\'archive contient des .ts/.js/.dart hors node_modules/.',
        );
      }

      // ── Phase 3: Vérification rate limit AI ───────────────
      const aiRateOk = await this.quotaService.checkAiRateLimit(dto.userId, plan);
      if (aiRateOk.allowed) {
        // Le compteur de requêtes AI vient d'être incrémenté par checkAiRateLimit.
        aiRateLimitIncremented = true;
      }
      if (!aiRateOk.allowed) {
        const msg =
          `Rate limit AI atteint. Votre plan autorise ${limits.aiRequestsPerHour} req AI/heure. ` +
          `Reset dans ${aiRateOk.resetInSeconds}s.`;
        await this.jobsService.appendLog(jobId, 'ir-generation', 'waiting', msg);
        // FIX PHASE 37 — Le compteur vient d'être incrémenté par checkAiRateLimit
        // alors qu'aucune requête AI ne part : on le restitue immédiatement.
        try { await this.quotaService.rollbackAiRateLimit(dto.userId); } catch { /* non-bloquant */ }
        // FIX PHASE 37 — Erreur TRANSITOIRE avec délai connu (reset de fenêtre) :
        // la file retentera après le reset au lieu de marquer le job FAILED.
        // Si les tentatives s'épuisent, le job passera FAILED avec ce message explicite.
        throw new RetryableError(
          `AI_RATE_LIMIT: plan ${plan} allows ${limits.aiRequestsPerHour} AI requests/hour — window resets in ${aiRateOk.resetInSeconds}s`,
          { kind: 'quota-window', retryAfterMs: aiRateOk.resetInSeconds * 1000 },
        );
      }

      // ── Phase 4: Envoi à l'AI Engine ──────────────────────
      // PHASE 27 — BUG-P27-12 FIX: Observabilité renforcée à chaque étape
      const totalChars = files.reduce((acc, f) => acc + (f.content?.length ?? 0), 0);
      const screenFiles = files.filter((f) => /screen|page|view/i.test(f.path)).length;
      const serviceFiles = files.filter((f) => /service|repository/i.test(f.path)).length;
      const modelFiles = files.filter((f) => /model|entity|dto/i.test(f.path)).length;
      const storeFiles = files.filter((f) => /bloc|cubit|store|provider|getx/i.test(f.path)).length;

      this.logger.log(
        `[PIPELINE] ═══════════════════════════════════════════════`,
      );
      this.logger.log(
        `[PIPELINE] DISPATCH TO AI ENGINE — jobId=${jobId}`,
      );
      this.logger.log(
        `[PIPELINE] Source: ${dto.sourceLanguage} → Target: ${dto.targetLanguage}`,
      );
      this.logger.log(
        `[PIPELINE] Files: total=${files.length} screens=${screenFiles} services=${serviceFiles} models=${modelFiles} stores=${storeFiles}`,
      );
      this.logger.log(
        `[PIPELINE] Source code: ${totalChars.toLocaleString()} chars (${Math.round(totalChars / 1000)}K)`,
      );
      this.logger.log(
        `[PIPELINE] Plan: ${plan} | Goal: ${dto.goalPrompt ? dto.goalPrompt.slice(0, 80) + '…' : '(none)'}`,
      );

      await this.jobsService.updateStatus(jobId, JobStatus.CONVERTING);
      await this.jobsService.appendLog(
        jobId, 'ir-generation', 'running',
        `[Phase 27] Envoi de ${files.length} fichiers (${Math.round(totalChars/1000)}K chars) à l'AI Engine ` +
        `(${dto.sourceLanguage}→${dto.targetLanguage}, plan=${plan}) — screens=${screenFiles} services=${serviceFiles}…`,
      );

      const dbJob   = await this.jobsService.findById(jobId);
      const aiJobId = await this.jobsService.dispatchToAiEngine(dbJob, files, dto.goalPrompt);

      await this.jobsService.updateStatus(jobId, JobStatus.CONVERTING, {
        aiEngineJobId: aiJobId,
      });
      await this.jobsService.appendLog(
        jobId, 'ir-generation', 'running',
        `AI Engine job ${aiJobId} démarré — en attente du callback (Phase 27: pipeline 10-axes actif)…`,
      );

      this.logger.log(`[PIPELINE] ✅ AI dispatch OK — aiJobId=${aiJobId}, en attente du callback Phase 27`);
      this.logger.log(`[PIPELINE] ═══════════════════════════════════════════════`);

      // FIX PHASE 27 — HEARTBEAT : toucher updatedAt toutes les 30s pendant l'attente du callback
      // Le watchdog (CONVERTING_STALE_MINUTES=60min) lit updatedAt.
      // Sans heartbeat, un job CONVERTING depuis >60min serait tué même si l'AI Engine tourne encore.
      // On lance le heartbeat en fire-and-forget — il s'arrête tout seul quand le job change de statut.
      void this.runHeartbeat(jobId, 30_000);

      // Comptabiliser l'utilisation AI
      await this.quotaService.incrementConversions(dto.userId, plan);

    } catch (err) {
      const error   = err as Error;
      const message = error.message ?? 'Erreur de traitement inconnue';

      // ── FIX PHASE 37 — CAUSE RACINE DU BUG 429/RETRY ─────────────────────
      // AVANT : TOUTE erreur marquait immédiatement le job FAILED, puis Bull
      //   relançait les tentatives 2 et 3 qui étaient rejetées car le job
      //   était déjà terminal → échec définitif dès le PREMIER 429.
      // MAINTENANT :
      //   • erreur réessayable ET tentatives restantes → le job reste ACTIF
      //     (statut ANALYZING, jamais FAILED), la file planifie la suite avec
      //     backoff (Retry-After respecté) — UN SEUL mécanisme de retry ;
      //   • tentatives épuisées OU erreur permanente (NonRetryableError,
      //     ex: 401 secret mismatch) → FAILED seulement ici, une seule fois ;
      //   • le cas "job déjà DONE/FAILED en base" est géré AVANT ce try :
      //     jamais on ne ré-écrit un job terminé.
      const maxAttempts  = Math.max(1, attemptInfo.maxAttempts ?? getMaxAttempts());
      const attemptsUsed = attemptInfo.attemptsMade + 1;
      const nonRetryable = isNonRetryableError(err);
      const attemptsLeft = !nonRetryable && attemptsUsed < maxAttempts;

      if (attemptsLeft) {
        const retryAfterMs = retryAfterMsOf(err);
        const nextDelayMs  = computeRetryDelayMs(err, attemptsUsed);
        this.logger.warn(
          `[PIPELINE-RETRY] jobId=${jobId} attempt=${attemptsUsed}/${maxAttempts} ` +
          `erreur récupérable: ${message} — statut conservé ACTIF, prochaine tentative ` +
          `planifiée par la file dans ~${Math.round(nextDelayMs / 1000)}s ` +
          `${retryAfterMs !== undefined ? `(Retry-After=${Math.round(retryAfterMs / 1000)}s respecté) ` : ''}(pas de FAILED prématuré)`,
        );
        // Aucune requête AI n'a réellement eu lieu pendant cette tentative :
        // on restitue le quota incrémenté par checkAiRateLimit.
        if (aiRateLimitIncremented) {
          try { await this.quotaService.rollbackAiRateLimit(dto.userId); } catch { /* non-bloquant */ }
        }
        try {
          await this.jobsService.appendLog(
            jobId, 'ir-generation', 'waiting',
            `Erreur récupérable (tentative ${attemptsUsed}/${maxAttempts}): ${message} — ` +
            `nouvelle tentative automatique dans ~${Math.round(nextDelayMs / 1000)}s.`,
          );
          // Statut actif NON-terminal : le job n'est PAS FAILED, il attend son retry.
          await this.jobsService.updateStatus(jobId, JobStatus.ANALYZING);
        } catch (logErr) {
          this.logger.warn(`${tag} appendLog/updateStatus après erreur récupérable a échoué: ${(logErr as Error).message}`);
        }
        // Propager une erreur typée réessayable (préserve retryAfterMs pour le backoff).
        throw err instanceof RetryableError || (err as { retryable?: boolean })?.retryable === true
          ? err
          : new RetryableError(message, { kind: 'unknown' }, error);
      }

      // ── Tentatives réellement épuisées → FAILED seulement maintenant ─────
      this.logger.error(
        `[PIPELINE] FAILED jobId=${jobId} après ${attemptsUsed}/${maxAttempts} tentative(s): ${message}`,
        error.stack,
      );

      if (aiRateLimitIncremented) {
        try { await this.quotaService.rollbackAiRateLimit(dto.userId); } catch { /* non-bloquant */ }
      }
      try {
        await this.quotaService.decrementConcurrentJobs(dto.userId, plan);
      } catch { /* ignorer */ }

      await this.jobsService.updateStatus(jobId, JobStatus.FAILED, {
        errorMessage: message,
        errorDetails: {
          stack:     error.stack,
          type:      dto.type,
          attempt:   attemptsUsed,
          maxAttempts,
          retryable: (err as { retryable?: boolean })?.retryable === true,
          timestamp: new Date().toISOString(),
        },
      });
      await this.jobsService.appendLog(jobId, 'failed', 'failed', `Job échoué après ${attemptsUsed} tentative(s): ${message}`);

      // Relancer pour que Bull/MemoryQueue finalise l'échec (leurs compteurs
      // de tentatives sont eux aussi épuisés → aucun retry supplémentaire).
      throw err;
    }
  }

  // ── Heartbeat fire-and-forget ──────────────────────────
  // FIX PHASE 27 — Tant qu'un job est CONVERTING, on touche updatedAt
  // toutes les `intervalMs` millisecondes pour signaler "je suis vivant".
  // Le watchdog (CONVERTING_STALE_MINUTES=60min basé sur updatedAt) ne tuera
  // pas ce job tant que le heartbeat tourne.
  // S'arrête automatiquement quand le job passe en DONE, FAILED ou après 2h max.
  private async runHeartbeat(jobId: string, intervalMs: number): Promise<void> {
    const MAX_DURATION_MS = 2 * 60 * 60 * 1000; // 2h max
    const startedAt = Date.now();
    let iterations = 0;

    while (Date.now() - startedAt < MAX_DURATION_MS) {
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
      iterations++;

      try {
        const job = await this.jobsService.findById(jobId);
        if (job.status !== JobStatus.CONVERTING) {
          this.logger.debug(
            `[Heartbeat] Job ${jobId} — status=${job.status} (not CONVERTING) → stopping heartbeat after ${iterations} iterations`,
          );
          return;
        }
        // Mettre à jour updatedAt pour signaler activité
        await this.jobsService.heartbeat(jobId);
        this.logger.debug(`[Heartbeat] Job ${jobId} — alive (iteration=${iterations})`);
      } catch (e) {
        // Job supprimé ou erreur DB → arrêter le heartbeat
        this.logger.warn(`[Heartbeat] Job ${jobId} — error, stopping: ${(e as Error).message}`);
        return;
      }
    }

    this.logger.warn(`[Heartbeat] Job ${jobId} — max duration (2h) reached, stopping`);
  }
}
