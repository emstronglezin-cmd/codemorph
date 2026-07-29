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

    this.logger.log(
      `[PIPELINE] Worker started — jobId=${jobId} type=${dto.type} ` +
      `attempt=${attemptInfo.attemptsMade + 1}`,
    );
    this.logger.log(`${tag} src=${dto.sourceLanguage} tgt=${dto.targetLanguage} userId=${dto.userId}`);

    // Récupérer le plan utilisateur
    const plan   = await this.subscriptionSvc.getUserPlan(dto.userId);
    const limits = getPlanLimits(plan);
    this.logger.log(`${tag} plan=${plan} maxFiles=${limits.maxFilesPerProject}`);

    try {
      // ── Phase 1: Mise à jour statut → ANALYZING ────────────
      if (attemptInfo.attemptsMade === 0) {
        await this.jobsService.updateStatus(jobId, JobStatus.ANALYZING);
      } else {
        const currentJob = await this.jobsService.findById(jobId);
        if (
          currentJob.status === JobStatus.FAILED ||
          currentJob.status === JobStatus.DONE
        ) {
          this.logger.warn(
            `${tag} Retry ${attemptInfo.attemptsMade + 1}: job déjà terminal ` +
            `(${currentJob.status}). Abandon.`,
          );
          throw new Error(
            `Job ${jobId} est déjà en statut terminal (${currentJob.status}). Retry abandonné.`,
          );
        }
        await this.jobsService.updateStatus(jobId, JobStatus.ANALYZING);
      }

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
      if (!aiRateOk.allowed) {
        const msg =
          `Rate limit AI atteint. Votre plan autorise ${limits.aiRequestsPerHour} req AI/heure. ` +
          `Reset dans ${aiRateOk.resetInSeconds}s.`;
        await this.jobsService.appendLog(jobId, 'ir-generation', 'waiting', msg);
        throw new Error(`AI_RATE_LIMIT:${aiRateOk.resetInSeconds}`);
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

      // Comptabiliser l'utilisation AI
      await this.quotaService.incrementConversions(dto.userId, plan);

    } catch (err) {
      const error   = err as Error;
      const message = error.message ?? 'Erreur de traitement inconnue';
      this.logger.error(`[PIPELINE] FAILED jobId=${jobId}: ${message}`, error.stack);

      try {
        await this.quotaService.decrementConcurrentJobs(dto.userId, plan);
      } catch { /* ignorer */ }

      await this.jobsService.updateStatus(jobId, JobStatus.FAILED, {
        errorMessage: message,
        errorDetails: {
          stack:     error.stack,
          type:      dto.type,
          attempt:   attemptInfo.attemptsMade + 1,
          timestamp: new Date().toISOString(),
        },
      });
      await this.jobsService.appendLog(jobId, 'failed', 'failed', `Job échoué: ${message}`);

      // Relancer pour que Bull/MemoryQueue gère le retry
      throw err;
    }
  }
}
