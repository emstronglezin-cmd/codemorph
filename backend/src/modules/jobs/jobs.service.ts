// ============================================================
// CodeMorph — Jobs Service
// PHASE 7 FIX:
//   - Concurrent count basé sur la DB (plus de compteur Redis/mem)
//   - Stale job auto-cleanup au démarrage et via scheduler
//   - jobRepo injecté dans QuotaService (source de vérité DB)
//   - dispatchToAiEngine: correction retour AiConvertResponse
//   - Logs détaillés à chaque étape
// PHASE 11 FIX:
//   - CONVERTING jobs watchdog séparé : seuil 5min (au lieu de 15min)
//   - Un job CONVERTING zombie depuis >5min → FAILED automatiquement
//   - Après crash Render : tous les CONVERTING → FAILED au démarrage
// PHASE 26 FIX:
//   - Redis devient OPTIONNEL : jamais de FAILED sur erreur Redis
//   - @InjectQueue remplacé par QueueAdapterService
//   - enqueueJobFireAndForget() bascule sur MemoryQueue si Redis KO
//   - Dégradation élégante : "Redis unavailable. Using Memory Queue."
// ============================================================
import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, LessThan } from 'typeorm';
import { ConfigService }     from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import { QueueAdapterService } from '../../queue/queue-adapter.service';

import { JobEntity, JobStatus, JobType } from './jobs.entity';
import { AiEngineClient }                from './ai-engine.client';
import { QuotaService, STALE_JOB_MINUTES } from '../quota/quota.service';
// FIX PHASE 12 — BUG CRITIQUE 2 : utiliser getPlanLimits() au lieu de PLAN_LIMITS[plan]
// PLAN_LIMITS[plan] retourne undefined si plan='starter' → TypeError → crash
// getPlanLimits() gère les aliases et retourne toujours une valeur valide

// FIX PHASE 27 — WATCHDOG CONVERTING ÉTENDU
// AVANT (Phase 11): CONVERTING > 5min → FAILED
//   Problème: pipeline Groq réel prend 10-30min (30+ fichiers × 2-3s/fichier via LLM)
//   → les jobs légitimes étaient tués par le watchdog
// FIX PHASE 31 — WATCHDOG ABSOLU (startedAt) :
//   PROBLÈME CRITIQUE IDENTIFIÉ : le heartbeat backend (conversion-processor.service.ts)
//   met à jour `updatedAt` toutes les 30s pendant la conversion.
//   → Un job bloqué dans l'AI Engine voit son `updatedAt` rester frais.
//   → La condition LessThan(updatedAt, 60min) n'est JAMAIS remplie pendant que le heartbeat tourne.
//   → Même si elle était remplie, aiEngineAlive=true bloquait le kill.
//   SOLUTION : double seuil :
//   1. updatedAt > 60min (heartbeat mort) + AI Engine DOWN → FAILED (comportement existant)
//   2. startedAt > 120min (timeout absolu) → FAILED même si AI Engine UP et heartbeat actif
//      Car l'AI Engine a ses propres timeouts (8min IR Phase 31, 90s/appel Groq) et ne
//      peut pas légitimement dépasser 120min sur aucun projet réel.
const CONVERTING_STALE_MINUTES     = 60;   // heartbeat-based: updatedAt > 60min
const CONVERTING_ABSOLUTE_MAX_MIN  = 120;  // absolute: startedAt > 120min → kill même si AI Engine UP
import { SubscriptionService }           from '../subscription/subscription.service';
import { getPlanLimits }                 from '../subscription/plan-limits.config';

export interface StartConversionDto {
  projectId?:     string;
  userId:         string;
  type:           JobType;
  sourceLanguage: string;
  targetLanguage: string;
  sourceRepo?:    string;
  sourceBranch?:  string;
  zipPath?:       string;
  goalPrompt?:    string;
}

// Statuts considérés comme "actifs" (bloquant le quota concurrent)
const ACTIVE_STATUSES = [JobStatus.PENDING, JobStatus.ANALYZING, JobStatus.CONVERTING];

@Injectable()
export class JobsService implements OnModuleInit {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    @InjectRepository(JobEntity)
    private readonly jobRepo: Repository<JobEntity>,

    // PHASE 26 — QueueAdapterService remplace @InjectQueue('conversion')
    // Auto-sélectionne Redis ou Memory selon disponibilité
    private readonly queueAdapter: QueueAdapterService,

    private readonly aiEngineClient:  AiEngineClient,
    private readonly quotaService:    QuotaService,
    private readonly subscriptionSvc: SubscriptionService,
    private readonly config:          ConfigService,
  ) {}

  // ── Module init: injecter jobRepo dans QuotaService ───
  onModuleInit(): void {
    // Donne à QuotaService la capacité de compter les jobs actifs
    // directement depuis la DB — source de vérité unique
    this.quotaService.setJobRepository(this.jobRepo as any);
    this.logger.log('JobsService: QuotaService jobRepo injected ✓');

    // FIX PHASE 11 — WATCHDOG DÉMARRAGE :
    // Après un crash/restart Render, TOUS les jobs CONVERTING sont des zombies
    // (leurs setTimeout mock ont été perdus). On les marque FAILED immédiatement.
    void this.cleanupConvertingZombiesOnStartup();
    // Nettoyage classique (PENDING/ANALYZING > 15min)
    void this.cleanupStaleJobs();
  }

  // ── Startup cleanup: mark stale CONVERTING as FAILED ──
  // FIX PHASE 27 — STARTUP AMÉLIORÉ :
  // AVANT (Phase 11): Tous les CONVERTING → FAILED au démarrage (trop agressif)
  //   Problème: un job démarré 2min avant un redéploiement Render était tué immédiatement
  //   alors que l'AI Engine continuait à tourner et allait envoyer le callback.
  //
  // MAINTENANT: Seuil d'ancienneté + vérification AI Engine
  //   - Jobs CONVERTING inactifs depuis < 10min → conservés (AI Engine peut encore livrer le callback)
  //   - Jobs CONVERTING inactifs depuis > 10min ET AI Engine mort → FAILED
  //   - Jobs CONVERTING inactifs depuis > 10min ET AI Engine vivant → log warning, conservés
  private async cleanupConvertingZombiesOnStartup(): Promise<void> {
    try {
      const convertingJobs = await this.jobRepo.find({
        where: { status: JobStatus.CONVERTING },
        select: ['id', 'userId', 'status', 'updatedAt'],
      });

      if (convertingJobs.length === 0) {
        this.logger.log('[StartupCleanup] No CONVERTING jobs found after restart ✓');
        return;
      }

      this.logger.warn(
        `[StartupCleanup] Found ${convertingJobs.length} CONVERTING job(s) after restart: ` +
        convertingJobs.map(j => j.id).join(', '),
      );

      // Vérifier si l'AI Engine est joignable (peut encore envoyer des callbacks)
      const aiEngineAlive = await this.checkAiEngineAlive();
      this.logger.log(`[StartupCleanup] AI Engine reachable=${aiEngineAlive}`);

      const now = Date.now();
      const RECENT_JOB_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

      for (const job of convertingJobs) {
        const ageMs = now - job.updatedAt.getTime();
        const ageMin = Math.round(ageMs / 60000);

        if (ageMs < RECENT_JOB_THRESHOLD_MS) {
          // Job récent (< 10min) → l'AI Engine pourrait encore envoyer le callback
          this.logger.warn(
            `[StartupCleanup] Job ${job.id} CONVERTING ${ageMin}min ago — RECENT, not killing ` +
            `(AI Engine may still deliver callback). Watchdog will handle if stuck.`,
          );
          continue;
        }

        if (aiEngineAlive) {
          // AI Engine vivant → job peut encore être traité, même si vieux
          this.logger.warn(
            `[StartupCleanup] Job ${job.id} CONVERTING ${ageMin}min ago — AI Engine is UP, not killing. ` +
            `Will check at next watchdog cycle.`,
          );
          continue;
        }

        // AI Engine mort ET job vieux → zombie confirmé → FAILED
        await this.jobRepo.update(job.id, {
          status:       JobStatus.FAILED,
          errorMessage: `Job auto-failed on server restart: conversion was running ${ageMin} minutes ago ` +
                        `and the AI Engine is unreachable. Please retry your conversion.`,
          errorDetails: {
            reason:      'server_restart_zombie',
            lastStatus:  'converting',
            ageMinutes:  ageMin,
            aiAlive:     false,
            clearedAt:   new Date().toISOString(),
          },
          completedAt: new Date(),
        });
        this.logger.warn(`[StartupCleanup] Job ${job.id} (CONVERTING ${ageMin}min, AI Engine DOWN) → FAILED ✓`);
      }
    } catch (e) {
      this.logger.error(`[StartupCleanup] Error: ${(e as Error).message}`);
    }
  }

  // ── Stale job cleanup (scheduled every 5 minutes) ────
  // FIX PHASE 31 — WATCHDOG ABSOLU : deux passes indépendantes
  // Passe A — Timeout absolu (startedAt > 120min) :
  //   Tue même si AI Engine UP et heartbeat actif.
  //   Rationale: l'AI Engine a des timeouts internes (8min IR, 90s/appel Groq).
  //   Aucun pipeline réel ne dure >120min. Si c'est le cas, c'est un zombie.
  // Passe B — Heartbeat mort (updatedAt > 60min) + AI Engine DOWN :
  //   Comportement Phase 27 préservé. Kill uniquement si AI Engine injoignable.
  //   (Si AI Engine UP mais heartbeat mort, log seulement — cas rare)
  @Cron(CronExpression.EVERY_5_MINUTES)
  async cleanupStaleJobs(): Promise<void> {
    const now = Date.now();
    const convertingStaleThreshold   = new Date(now - CONVERTING_STALE_MINUTES * 60 * 1000);
    const convertingAbsoluteThreshold = new Date(now - CONVERTING_ABSOLUTE_MAX_MIN * 60 * 1000);
    const generalStaleThreshold       = new Date(now - STALE_JOB_MINUTES * 60 * 1000);

    try {
      // ── PASSE A — Timeout absolu sur startedAt (FIX PHASE 31) ──────────────────
      // Cherche les jobs CONVERTING dont startedAt > 120min.
      // Ces jobs sont tués inconditionnellement même si AI Engine UP,
      // car le pipeline AI Engine a ses propres timeouts internes.
      // Note: on filtre sur startedAt (non null) pour éviter de tuer des jobs
      // qui n'ont pas encore démarré (startedAt null = pas encore dispatché).
      const absoluteTimeoutZombies = await this.jobRepo
        .createQueryBuilder('job')
        .where('job.status = :status', { status: JobStatus.CONVERTING })
        .andWhere('job.startedAt IS NOT NULL')
        .andWhere('job.startedAt < :threshold', { threshold: convertingAbsoluteThreshold })
        .select(['job.id', 'job.userId', 'job.status', 'job.updatedAt', 'job.startedAt', 'job.type'])
        .getMany();

      if (absoluteTimeoutZombies.length > 0) {
        this.logger.warn(
          `[Watchdog-AbsoluteTimeout] Found ${absoluteTimeoutZombies.length} CONVERTING job(s) started >${CONVERTING_ABSOLUTE_MAX_MIN}min ago (hard timeout): ` +
          absoluteTimeoutZombies.map(j => `${j.id}(started ${Math.round((now - j.startedAt!.getTime()) / 60000)}min ago)`).join(', '),
        );
        for (const job of absoluteTimeoutZombies) {
          const runningMinutes = Math.round((now - job.startedAt!.getTime()) / 60000);
          await this.jobRepo.update(job.id, {
            status:       JobStatus.FAILED,
            errorMessage: `Job automatically failed: conversion has been running for ${runningMinutes} minutes ` +
                          `which exceeds the maximum allowed duration of ${CONVERTING_ABSOLUTE_MAX_MIN} minutes. ` +
                          `The AI pipeline has internal timeouts (8min IR, 90s per call) and cannot legitimately ` +
                          `exceed this limit. Please retry your conversion.`,
            errorDetails: {
              reason:              'converting_absolute_timeout',
              lastStatus:          job.status,
              runningMinutes,
              absoluteMaxMinutes:  CONVERTING_ABSOLUTE_MAX_MIN,
              startedAt:           job.startedAt!.toISOString(),
              detectedAt:          new Date().toISOString(),
            },
            completedAt: new Date(),
          });
          this.logger.warn(
            `[Watchdog-AbsoluteTimeout] Job ${job.id} (CONVERTING ${runningMinutes}min since startedAt, hard limit=${CONVERTING_ABSOLUTE_MAX_MIN}min) → FAILED ✓`,
          );
        }
      }

      // ── PASSE B — Heartbeat mort (updatedAt > 60min) ───────────────────────────
      // Comportement Phase 27 préservé.
      // Un job CONVERTING dont updatedAt > 60min = heartbeat mort (conversion-processor crashé?).
      // Si AI Engine DOWN → zombie confirmé → FAILED.
      // Si AI Engine UP → log seulement (cas peu probable si PASSE A a fait son travail).
      // Note: on exclut les jobs déjà traités par PASSE A (startedAt > 120min)
      // pour éviter les doubles logs.
      const convertingZombies = await this.jobRepo.find({
        where: {
          status:    JobStatus.CONVERTING,
          updatedAt: LessThan(convertingStaleThreshold),
        },
        select: ['id', 'userId', 'status', 'updatedAt', 'startedAt', 'type'],
      });

      // Filtrer les jobs déjà pris en charge par PASSE A
      const absoluteIds = new Set(absoluteTimeoutZombies.map(j => j.id));
      const heartbeatZombies = convertingZombies.filter(j => !absoluteIds.has(j.id));

      if (heartbeatZombies.length > 0) {
        this.logger.warn(
          `[Watchdog] Found ${heartbeatZombies.length} CONVERTING job(s) with dead heartbeat (updatedAt >${CONVERTING_STALE_MINUTES}min): ` +
          heartbeatZombies.map(j => `${j.id}(${Math.round((now - j.updatedAt.getTime())/60000)}min inactive)`).join(', '),
        );

        // Vérifier si l'AI Engine est joignable
        const aiEngineAlive = await this.checkAiEngineAlive();
        this.logger.log(`[Watchdog] AI Engine reachable=${aiEngineAlive} — ${aiEngineAlive ? 'heartbeat dead but AI Engine UP (log only)' : 'AI Engine DOWN, marking as FAILED'}`);

        for (const job of heartbeatZombies) {
          const inactiveMinutes = Math.round((now - job.updatedAt.getTime()) / 60000);

          if (aiEngineAlive) {
            // AI Engine UP mais heartbeat mort depuis >60min.
            // Cas rare: conversion-processor crashé mais pipeline AI toujours actif?
            // On log uniquement — PASSE A tuera le job au prochain cycle si startedAt > 120min.
            this.logger.warn(
              `[Watchdog] Job ${job.id} heartbeat dead ${inactiveMinutes}min but AI Engine UP — ` +
              `PASSE A (absolute timeout) will handle if startedAt > ${CONVERTING_ABSOLUTE_MAX_MIN}min.`,
            );
          } else {
            // AI Engine DOWN + heartbeat mort → zombie confirmé → FAILED
            await this.jobRepo.update(job.id, {
              status:       JobStatus.FAILED,
              errorMessage: `Job automatically failed: no heartbeat for ${inactiveMinutes} minutes ` +
                            `and the AI Engine is unreachable. ` +
                            `The conversion likely started but the AI Engine went down before completing. ` +
                            `Please retry your conversion.`,
              errorDetails: {
                reason:           'converting_zombie_ai_engine_down',
                lastStatus:       job.status,
                inactiveMinutes,
                staleThresholdMin: CONVERTING_STALE_MINUTES,
                aiEngineAlive:    false,
                detectedAt:       new Date().toISOString(),
              },
              completedAt: new Date(),
            });
            this.logger.warn(`[Watchdog] Job ${job.id} (heartbeat dead ${inactiveMinutes}min, AI Engine DOWN) → FAILED ✓`);
          }
        }
      }

      // ── 2. PENDING/ANALYZING stale cleanup (seuil standard : 15min) ──
      const staleJobs = await this.jobRepo.find({
        where: {
          status:    In([JobStatus.PENDING, JobStatus.ANALYZING]),
          updatedAt: LessThan(generalStaleThreshold),
        },
        select: ['id', 'userId', 'status', 'updatedAt', 'type'],
      });

      if (staleJobs.length === 0 && heartbeatZombies.length === 0 && absoluteTimeoutZombies.length === 0) {
        return; // Nothing to clean
      }

      if (staleJobs.length > 0) {
        this.logger.warn(
          `[StaleCleanup] Found ${staleJobs.length} stale job(s) (inactive >${STALE_JOB_MINUTES}min): ` +
          staleJobs.map(j => `${j.id}(${j.status})`).join(', '),
        );

        for (const job of staleJobs) {
          await this.jobRepo.update(job.id, {
            status:       JobStatus.FAILED,
            errorMessage: `Job automatically failed: no activity for more than ${STALE_JOB_MINUTES} minutes. ` +
                          `This typically means the AI Engine did not respond or the worker crashed. ` +
                          `Please try again.`,
            errorDetails: {
              reason:          'stale_timeout',
              lastStatus:      job.status,
              staleThreshold:  generalStaleThreshold.toISOString(),
              detectedAt:      new Date().toISOString(),
            },
            completedAt: new Date(),
          });
          this.logger.warn(`[StaleCleanup] Job ${job.id} (${job.status}) marked FAILED (stale)`);
        }
      }
    } catch (e) {
      this.logger.error(`[StaleCleanup] Error: ${(e as Error).message}`);
    }
  }

  // ── Create + Enqueue ──────────────────────────────────
  // PHASE 15 — FIRE-AND-FORGET
  // La réponse HTTP est renvoyée immédiatement après le save() en DB (étape 5).
  // L'enqueue Bull (étape 6) est lancé SANS await via enqueueJobFireAndForget().
  // Aucun appel Redis, AI Engine ou externe ne bloque la réponse HTTP.
  async createJob(dto: StartConversionDto): Promise<JobEntity> {
    const tag = `[createJob userId=${dto.userId}]`;
    this.logger.log(
      `${tag} type=${dto.type} src=${dto.sourceLanguage} tgt=${dto.targetLanguage} ` +
      `repo=${dto.sourceRepo ?? '-'} zip=${dto.zipPath ?? '-'}`,
    );

    // 1. Fetch user plan
    // FIX PHASE 12 — BUG CRITIQUE 2 : getPlanLimits() au lieu de PLAN_LIMITS[plan]
    // PLAN_LIMITS['starter'] = undefined → TypeError si plan='starter'
    // getPlanLimits() résout les aliases (starter→pro) et ne retourne jamais undefined
    this.logger.log(`${tag} Step 1/5: Fetching user plan…`);
    const plan   = await this.subscriptionSvc.getUserPlan(dto.userId);
    const limits = getPlanLimits(plan);
    this.logger.log(`${tag} Plan: ${plan} → limits.advancedFrameworks=${limits.advancedFrameworks}`);

    // 2. Enforce monthly quota
    this.logger.log(`${tag} Step 2/5: Enforcing monthly quota…`);
    await this.quotaService.enforceConversionQuota(dto.userId, plan);
    this.logger.log(`${tag} Quota: OK`);

    // 3. Enforce concurrent job limit (source de vérité = DB)
    this.logger.log(`${tag} Step 3/5: Checking concurrent jobs (DB count)…`);
    const concurrent = await this.quotaService.checkConcurrentJobs(dto.userId, plan);
    if (!concurrent.allowed) {
      this.logger.warn(
        `${tag} Concurrent limit: current=${concurrent.current} limit=${concurrent.limit}. ` +
        `Check /dashboard/history to see active jobs.`,
      );
      throw new ForbiddenException({
        code:    'CONCURRENT_LIMIT',
        message: `You already have ${concurrent.current} active job(s). ` +
                 `Your ${plan} plan allows ${limits.concurrentJobs} concurrent job(s). ` +
                 `Wait for the current job to complete or check the History page.`,
        current: concurrent.current,
        limit:   limits.concurrentJobs,
      });
    }
    this.logger.log(`${tag} Concurrent: OK (${concurrent.current}/${limits.concurrentJobs} active)`);

    // 4. Validate framework access
    this.logger.log(`${tag} Step 4/5: Validating framework access…`);
    if (!limits.advancedFrameworks) {
      const srcNorm = dto.sourceLanguage.toLowerCase().replace(/[^a-z]/g, '');
      const tgtNorm = dto.targetLanguage.toLowerCase().replace(/[^a-z]/g, '');
      const allowedSrc = ['flutter', 'dart'];
      const allowedTgt = ['react', 'reactnative'];
      if (!allowedSrc.includes(srcNorm) || !allowedTgt.includes(tgtNorm)) {
        this.logger.warn(`${tag} Framework restricted: ${dto.sourceLanguage}→${dto.targetLanguage} (plan=${plan})`);
        throw new ForbiddenException({
          code:       'FRAMEWORK_RESTRICTED',
          message:    `Free plan only supports Flutter → React / React Native. ` +
                      `Upgrade to Pro for ${dto.sourceLanguage} → ${dto.targetLanguage}.`,
          upgradeUrl: '/pricing',
        });
      }
    }
    this.logger.log(`${tag} Framework: OK`);

    // 5. Create DB record
    this.logger.log(`${tag} Step 5/5: Creating job in DB…`);
    const job = this.jobRepo.create({
      type:           dto.type,
      status:         JobStatus.PENDING,
      userId:         dto.userId,
      projectId:      dto.projectId,
      sourceLanguage: dto.sourceLanguage,
      targetLanguage: dto.targetLanguage,
      sourceRepo:     dto.sourceRepo,
      sourceBranch:   dto.sourceBranch,
      zipPath:        dto.zipPath,
      phaseLogs:      [],
    });
    const saved = await this.jobRepo.save(job);
    this.logger.log(`${tag} Step 5/5 ✅ Job created in DB: id=${saved.id} — retour HTTP immédiat`);

    // 6. FIRE-AND-FORGET — enqueue Bull SANS await
    // Le worker Bull (JobsProcessor) traitera le job en arrière-plan.
    // La réponse HTTP est déjà envoyée avant que cet appel ne complète.
    this.enqueueJobFireAndForget(saved.id, dto, limits, plan);

    // ← HTTP 200 renvoyé ICI, avant tout appel Redis/AI Engine
    this.logger.log(`[PIPELINE] Job created — jobId=${saved.id} status=pending`);
    return saved;
  }

  // ── Enqueue (fire-and-forget, jamais awaité par createJob) ──
  // PHASE 15 — cette méthode est appelée sans await.
  // PHASE 26 — Redis est OPTIONNEL :
  //   • Si Redis OK → RedisQueueProvider (Bull)
  //   • Si Redis KO → MemoryQueueProvider (fallback automatique)
  //   • Jamais de FAILED pour une erreur d'infrastructure queue
  //   • L'utilisateur ne voit aucune différence
  private enqueueJobFireAndForget(
    jobId:  string,
    dto:    StartConversionDto,
    limits: ReturnType<typeof getPlanLimits>,
    plan:   string,
  ): void {
    const tag = `[enqueue jobId=${jobId}]`;

    // setImmediate garantit que l'enqueue se lance APRÈS le return de createJob
    // (donc après que NestJS ait sérialisé et envoyé la réponse HTTP)
    setImmediate(() => {
      void (async () => {
        const provider = this.queueAdapter.providerName;
        this.logger.log(
          `${tag} Fire-and-forget: ajout à la file ` +
          `(provider=${provider}, priority=${limits.queuePriority}, plan=${plan})…`,
        );

        try {
          // PHASE 26 — QueueAdapterService bascule automatiquement Redis→Memory si besoin
          await this.queueAdapter.add(
            'run-conversion',
            { jobId, dto },
            {
              priority:         limits.queuePriority,
              attempts:         3,
              backoff:          { type: 'exponential', delay: 2_000 },
              removeOnComplete: 100,
              removeOnFail:     200,
              plan,
            },
          );

          const activeProvider = this.queueAdapter.providerName;
          this.logger.log(
            `[PIPELINE] Queue add OK — jobId=${jobId} plan=${plan} ` +
            `provider=${activeProvider}`,
          );

          // PHASE 26 — Log informatif si basculement vers Memory
          if (activeProvider === 'memory') {
            this.logger.warn(
              `[PIPELINE] Redis unavailable. Switching to Local Queue. ` +
              `Conversion continues. jobId=${jobId}`,
            );
          }

        } catch (queueErr: unknown) {
          // PHASE 26 — Seule la saturation MemoryQueue ou une erreur irrémédiable
          // atteint ce catch. QueueAdapterService a déjà tenté le fallback Memory.
          const qMsg = queueErr instanceof Error ? queueErr.message : String(queueErr);
          this.logger.error(
            `${tag} ❌ Queue totalement indisponible (Redis ET Memory): ${qMsg} — ` +
            `marquage FAILED en DB`,
          );

          // Dernière chance : marquer FAILED uniquement si aucun provider n'a fonctionné
          try {
            await this.jobRepo.update(jobId, {
              status:       JobStatus.FAILED,
              errorMessage: `Impossible d'enqueuer la conversion: ${qMsg}. ` +
                            `Redis et MemoryQueue sont tous les deux indisponibles.`,
              errorDetails: {
                cause:     qMsg,
                hint:      'MemoryQueue saturée (500 jobs max). Réessayez dans quelques minutes.',
                timestamp: new Date().toISOString(),
              },
              completedAt: new Date(),
            });
            this.logger.log(`${tag} Job marqué FAILED en DB (queue totalement indisponible)`);
          } catch (dbErr: unknown) {
            const dbMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
            this.logger.error(`${tag} Échec mise à jour DB après erreur queue: ${dbMsg}`);
          }
        }
      })();
    });
  }

  // ── Find by ID ────────────────────────────────────────
  async findById(id: string): Promise<JobEntity> {
    const job = await this.jobRepo.findOne({ where: { id } });
    if (!job) throw new NotFoundException(`Job ${id} not found`);
    return job;
  }

  // ── Find by User ──────────────────────────────────────
  async findByUser(
    userId: string,
    page  = 1,
    limit = 20,
  ): Promise<{ data: JobEntity[]; total: number }> {
    const [data, total] = await this.jobRepo.findAndCount({
      where: { userId },
      order: { createdAt: 'DESC' },
      skip:  (page - 1) * limit,
      take:  limit,
    });
    return { data, total };
  }

  // ── Find by Project ───────────────────────────────────
  async findByProject(projectId: string): Promise<JobEntity[]> {
    return this.jobRepo.find({
      where: { projectId },
      order: { createdAt: 'DESC' },
    });
  }

  // ── Update status ─────────────────────────────────────
  async updateStatus(
    id:     string,
    status: JobStatus,
    extra?: Partial<JobEntity>,
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await this.jobRepo.update(id, {
      status,
      ...(status === JobStatus.ANALYZING || status === JobStatus.CONVERTING
        ? { startedAt: new Date() } : {}),
      ...(status === JobStatus.DONE || status === JobStatus.FAILED
        ? { completedAt: new Date() } : {}),
      ...extra,
    } as any);
  }

  // ── Append phase log ──────────────────────────────────
  async appendLog(id: string, phase: string, logStatus: string, message: string): Promise<void> {
    const job  = await this.findById(id);
    const logs = job.phaseLogs ?? [];
    logs.push({ phase, status: logStatus, message, timestamp: new Date().toISOString() });
    await this.jobRepo.update(id, {
      phaseLogs:    logs,
      currentPhase: phase,
      progress:     this.calculateProgress(phase),
    });
  }

  // ── Dispatch to AI Engine ─────────────────────────────
  async dispatchToAiEngine(
    job:         JobEntity,
    files:       Array<{ path: string; content: string }>,
    goalPrompt?: string,
  ): Promise<string> {
    // FIX PHASE 9 — CAUSE RACINE BUG 1 (callback localhost):
    // Avant: config.get('API_URL', 'http://localhost:4000/api/v1')
    // Sur Render sans API_URL défini → callbackUrl = 'http://localhost:4000/...'
    // Le mock AI Engine envoyait le callback vers localhost → jamais reçu.
    // Résultat: job restait CONVERTING indéfiniment → bloque les conversions suivantes.
    //
    // Fallback hiérarchique:
    //   1. API_URL env var (défini manuellement sur Render)
    //   2. RENDER_EXTERNAL_URL (injecté auto par Render) + /api/v1
    //   3. localhost (dev local seulement)
    const apiUrlEnv  = this.config.get<string>('API_URL');
    const renderUrl  = process.env['RENDER_EXTERNAL_URL'];
    const apiUrl = apiUrlEnv
      ?? (renderUrl ? `${renderUrl}/api/v1` : 'http://localhost:4000/api/v1');
    const callbackUrl  = `${apiUrl}/jobs/${job.id}/callback`;
    // PHASE 28 PERF FIX: URL de progression temps-réel
    // L'AI Engine envoie des mises à jour toutes les 5s pendant la conversion.
    // Le backend stocke le dernier état dans le job pour le frontend.
    const progressUrl = `${apiUrl}/jobs/${job.id}/progress`;

    // FIX PHASE 20 — DIAG: log complet pour diagnostiquer les problèmes de callbackUrl en production
    // Si API_URL et RENDER_EXTERNAL_URL ne sont pas définis → callbackUrl = localhost (inaccessible depuis AI Engine)
    this.logger.log(
      `[PIPELINE] callbackUrl resolution — API_URL=${apiUrlEnv ?? '(not set)'} ` +
      `RENDER_EXTERNAL_URL=${renderUrl ?? '(not set)'} ` +
      `→ callbackUrl=${callbackUrl} progressUrl=${progressUrl}`,
    );
    if (!apiUrlEnv && !renderUrl) {
      this.logger.warn(
        `[DISPATCH-CONFIG-WARN] jobId=${job.id} — Neither API_URL nor RENDER_EXTERNAL_URL is set! ` +
        `callbackUrl="${callbackUrl}" will be localhost:4000 which is UNREACHABLE from AI Engine on Render. ` +
        `FIX: Set API_URL=https://codemorph-hp00.onrender.com/api/v1 on Render AI Engine env vars.`,
      );
    }

    // FIX PHASE 32 — DISPATCH LOG STRUCTURÉ CÔTÉ BACKEND
    const totalChars = files.reduce((acc, f) => acc + (f.content?.length ?? 0), 0);
    this.logger.log(
      `[DISPATCH-BACKEND] jobId=${job.id} ` +
      `aiEngineUrl=${this.config.get<string>('AI_ENGINE_URL', '(not set)')} ` +
      `mockMode=${this.aiEngineClient.isMockMode} ` +
      `files=${files.length} chars=${totalChars} ` +
      `${job.sourceLanguage}→${job.targetLanguage} ` +
      `callbackUrl=${callbackUrl}`,
    );

    let response: Awaited<ReturnType<typeof this.aiEngineClient.submitConversion>>;
    try {
      response = await this.aiEngineClient.submitConversion({
        jobId:          job.id,
        sourceLanguage: job.sourceLanguage,
        targetLanguage: job.targetLanguage,
        files,
        goalPrompt:     goalPrompt ?? '',
        callbackUrl,
        progressUrl,
      });
    } catch (err) {
      this.logger.error(
        `[DISPATCH-FAILED] jobId=${job.id} — AI Engine call threw: ${(err as Error)?.message ?? String(err)}`,
      );
      throw err;
    }

    const aiJobId = response.jobId ?? job.id;
    this.logger.log(
      `[DISPATCH-OK] jobId=${job.id} aiJobId=${aiJobId} accepted=${response.accepted} ` +
      `message="${response.message ?? ''}" — now waiting for callback`,
    );

    return String(aiJobId);
  }

  // ── Handle callback from AI Engine ────────────────────
  async handleCallback(
    id:      string,
    payload: {
      success:          boolean;
      result?:          Record<string, unknown>;
      irDocument?:      Record<string, unknown>;
      error?:           string;
      filesGenerated?:  number;
      linesGenerated?:  number;
    },
  ): Promise<void> {
    const job = await this.findById(id);

    // FIX PHASE 32 — CALLBACK LOG STRUCTURÉ
    // Permet de prouver que le callback a été reçu et traité par le backend.
    const resultFiles = (payload.result?.['files'] as Array<unknown> | undefined);
    this.logger.log(
      `[CALLBACK-RECEIVED] jobId=${id} success=${payload.success} ` +
      `filesGenerated=${payload.filesGenerated ?? 0} linesGenerated=${payload.linesGenerated ?? 0} ` +
      `result.files.length=${resultFiles?.length ?? 0} jobStatus=${job.status}`,
    );

    if (!payload.success) {
      this.logger.error(
        `[CALLBACK-RECEIVED] jobId=${id} FAILED — error=${payload.error ?? '(no error message in payload)'}`,
      );
    }

    // Get user plan for quota tracking
    const plan = await this.subscriptionSvc.getUserPlan(job.userId);

    if (payload.success) {
      await this.updateStatus(id, JobStatus.DONE, {
        result:         payload.result,
        irDocument:     payload.irDocument,
        filesGenerated: payload.filesGenerated,
        linesGenerated: payload.linesGenerated,
        progress:       100,
      });
      await this.appendLog(id, 'done', 'done',
        `Conversion complete: ${payload.filesGenerated ?? 0} files generated`,
      );
      await this.quotaService.incrementConversions(job.userId, plan, {
        filesProcessed: payload.filesGenerated,
        linesProcessed: payload.linesGenerated,
      });
      this.logger.log(
        `[CALLBACK-PROCESSED] jobId=${id} → DONE ` +
        `filesGenerated=${payload.filesGenerated ?? 0} linesGenerated=${payload.linesGenerated ?? 0}`,
      );
    } else {
      const errorMsg = payload.error ?? 'Unknown error from AI Engine';
      await this.updateStatus(id, JobStatus.FAILED, {
        errorMessage: errorMsg,
        progress:     0,
      });
      await this.appendLog(id, 'failed', 'failed', `AI Engine error: ${errorMsg}`);
      this.logger.error(
        `[CALLBACK-PROCESSED] jobId=${id} → FAILED error="${errorMsg}"`,
      );
    }
  }

  // ── Reset ALL active jobs for user (sans restriction de temps) ───
  // FIX PHASE 10 — CAUSE RACINE BUG 1 (reset-stale inutilisable) :
  // forceResetStaleJobsForUser() n'agit que sur les jobs updatedAt > 15min.
  // Un job bloqué depuis 2min (ex: Bull retry) n'est pas stale → reset-stale retourne 0.
  // Ce nouvel endpoint remet à FAILED TOUS les jobs actifs de l'utilisateur sans condition.
  // Utilisé par le frontend quand l'utilisateur est bloqué par CONCURRENT_LIMIT.
  async resetMyActiveJobs(userId: string): Promise<number> {
    const activeJobs = await this.jobRepo.find({
      where: {
        userId,
        status: In(ACTIVE_STATUSES),
      },
      select: ['id', 'status', 'updatedAt'],
    });

    for (const job of activeJobs) {
      await this.jobRepo.update(job.id, {
        status:       JobStatus.FAILED,
        errorMessage: 'Manually reset by user: job was blocking new conversions.',
        completedAt:  new Date(),
      });
      this.logger.warn(
        `[reset-mine] Job ${job.id} (${job.status}, updatedAt=${job.updatedAt.toISOString()}) ` +
        `force-reset to FAILED for userId=${userId}`,
      );
    }

    this.logger.log(`[reset-mine] userId=${userId}: ${activeJobs.length} job(s) reset`);
    return activeJobs.length;
  }

  // ── Manual reset stale (admin / user action) ──────────
  async forceResetStaleJobsForUser(userId: string): Promise<number> {
    const staleThreshold = new Date(Date.now() - STALE_JOB_MINUTES * 60 * 1000);
    const staleJobs = await this.jobRepo.find({
      where: {
        userId,
        status:    In(ACTIVE_STATUSES),
        updatedAt: LessThan(staleThreshold),
      },
    });

    for (const job of staleJobs) {
      await this.jobRepo.update(job.id, {
        status:       JobStatus.FAILED,
        errorMessage: 'Manually reset: job was stuck and has been cleared.',
        completedAt:  new Date(),
      });
      this.logger.warn(`[reset-stale] Job ${job.id} (${job.status}) force-reset for user ${userId}`);
    }
    return staleJobs.length;
  }

  // ── Reset ALL active jobs (admin) ─────────────────────
  // Remet TOUS les jobs actifs en FAILED sans aucun filtre utilisateur
  // Utile pour nettoyer lors d'un redéploiement ou d'une migration
  async resetAllActiveJobs(): Promise<number> {
    const allActive = await this.jobRepo.find({
      where: { status: In(ACTIVE_STATUSES) },
      select: ['id', 'userId', 'status'],
    });

    for (const job of allActive) {
      await this.jobRepo.update(job.id, {
        status:       JobStatus.FAILED,
        errorMessage: 'Admin reset: all active jobs have been cleared by an administrator.',
        completedAt:  new Date(),
      });
    }

    this.logger.warn(`[reset-all] Admin reset ${allActive.length} active job(s) to FAILED`);
    return allActive.length;
  }

  // ── Heartbeat: touch updatedAt to prevent zombie watchdog ──
  // FIX PHASE 27 — HEARTBEAT :
  // Le conversion-processor appelle cette méthode toutes les 30s pendant une conversion.
  // Le watchdog (CONVERTING_STALE_MINUTES=60min) lit updatedAt pour détecter les zombies.
  // Tant que heartbeat est appelé, updatedAt est récent → watchdog ne tue pas le job.
  async heartbeat(jobId: string): Promise<void> {
    try {
      await this.jobRepo.update(jobId, { updatedAt: new Date() } as any);
      this.logger.debug(`[Heartbeat] Job ${jobId} — updatedAt refreshed`);
    } catch (e) {
      // Heartbeat non-critique — ne pas faire échouer la conversion
      this.logger.warn(`[Heartbeat] Job ${jobId} — failed to update: ${(e as Error).message}`);
    }
  }

  // ── Check if AI Engine is reachable ──────────────────────
  // Utilisé par le watchdog pour décider si un job CONVERTING est vraiment mort.
  // Retourne true si l'AI Engine répond (200 sur /api/health ou /).
  private async checkAiEngineAlive(): Promise<boolean> {
    const aiEngineUrl = this.config.get<string>('AI_ENGINE_URL');
    if (!aiEngineUrl || aiEngineUrl === 'http://ai-engine:5000') {
      // Mode mock → pas de vrai AI Engine → on considère "down" pour tuer les zombies
      return false;
    }
    try {
      const { HttpService } = await import('@nestjs/axios');
      void HttpService; // just to avoid lint
      // On utilise fetch natif (disponible Node 18+) pour éviter les dépendances circulaires
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      const res = await fetch(`${aiEngineUrl}/api/health`, { signal: controller.signal });
      clearTimeout(timer);
      return res.ok || res.status < 500;
    } catch {
      try {
        // Fallback: tenter la route racine /
        const controller2 = new AbortController();
        const timer2 = setTimeout(() => controller2.abort(), 3_000);
        const res2 = await fetch(
          this.config.get<string>('AI_ENGINE_URL', '') + '/',
          { signal: controller2.signal }
        );
        clearTimeout(timer2);
        return res2.ok || res2.status < 500;
      } catch {
        return false;
      }
    }
  }

  // ── Cancel job ────────────────────────────────────────
  async cancel(id: string, userId: string): Promise<void> {
    const job = await this.findById(id);
    if (job.userId !== userId) throw new NotFoundException(`Job ${id} not found`);
    if ([JobStatus.DONE, JobStatus.FAILED].includes(job.status)) return;

    await this.updateStatus(id, JobStatus.FAILED, { errorMessage: 'Cancelled by user' });
    this.logger.log(`[Job ${id}] Cancelled by user ${userId}`);
  }

  // ── AI Engine probe — test HTTP Backend→AI Engine (Phase 32) ───
  // Permet de vérifier depuis le backend déployé que l'AI Engine est
  // joignable, répond, et que la configuration est correcte.
  // Retourne un rapport détaillé sans effectuer de vraie conversion.
  async probeAiEngine(): Promise<{
    aiEngineUrl:    string;
    mockMode:       boolean;
    healthOk:       boolean;
    healthStatus:   number | null;
    healthBody:     unknown;
    durationMs:     number;
    callbackUrlSample: string;
    apiUrlSource:   string;
    error:          string | null;
  }> {
    const aiEngineUrl = this.config.get<string>('AI_ENGINE_URL', '(not set)');
    const mockMode    = this.aiEngineClient.isMockMode;

    // Construire la callbackUrl de la même façon que dispatchToAiEngine
    const apiUrlEnv = this.config.get<string>('API_URL');
    const renderUrl = process.env['RENDER_EXTERNAL_URL'];
    const apiUrl    = apiUrlEnv
      ?? (renderUrl ? `${renderUrl}/api/v1` : 'http://localhost:4000/api/v1');
    const callbackUrlSample = `${apiUrl}/jobs/<jobId>/callback`;
    const apiUrlSource = apiUrlEnv
      ? 'API_URL env var'
      : (renderUrl ? 'RENDER_EXTERNAL_URL' : 'localhost fallback (MISSING in prod!)');

    this.logger.log(
      `[PROBE-START] AI Engine probe initiated — ` +
      `aiEngineUrl=${aiEngineUrl} mockMode=${mockMode} ` +
      `callbackUrl_sample=${callbackUrlSample} apiUrlSource=${apiUrlSource}`,
    );

    if (mockMode) {
      this.logger.warn(
        `[PROBE-MOCK] mockMode=true — no real HTTP call will be made. ` +
        `AI_ENGINE_URL is "${aiEngineUrl}" which triggers mock mode.`,
      );
      return {
        aiEngineUrl,
        mockMode: true,
        healthOk: false,
        healthStatus: null,
        healthBody: null,
        durationMs: 0,
        callbackUrlSample,
        apiUrlSource,
        error: `mockMode=true: AI_ENGINE_URL="${aiEngineUrl}" is unset or Docker-internal. No real AI Engine call possible.`,
      };
    }

    const start = Date.now();
    let healthStatus: number | null = null;
    let healthBody: unknown = null;
    let error: string | null = null;
    let healthOk = false;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      const probeUrl = `${aiEngineUrl}/api/health`;
      this.logger.log(`[PROBE-HTTP] GET ${probeUrl} (timeout=8s)`);
      const res = await fetch(probeUrl, { signal: controller.signal });
      clearTimeout(timer);
      healthStatus = res.status;
      try { healthBody = await res.json(); } catch { healthBody = `(non-JSON body, status=${res.status})`; }
      healthOk = res.ok;
      this.logger.log(
        `[PROBE-HTTP-OK] status=${healthStatus} durationMs=${Date.now() - start} ` +
        `body=${JSON.stringify(healthBody).slice(0, 200)}`,
      );
    } catch (e) {
      error = (e as Error).message;
      this.logger.error(
        `[PROBE-HTTP-FAILED] aiEngineUrl=${aiEngineUrl} durationMs=${Date.now() - start} error=${error}`,
      );
    }

    const durationMs = Date.now() - start;
    return { aiEngineUrl, mockMode, healthOk, healthStatus, healthBody, durationMs, callbackUrlSample, apiUrlSource, error };
  }

  // ── Helpers ───────────────────────────────────────────
  private calculateProgress(phase: string): number {
    const phases: Record<string, number> = {
      'ast-analysis':           15,
      'architecture-detection': 30,
      'ir-generation':          50,
      mapping:                  65,
      'code-planning':          80,
      validation:               90,
      done:                     100,
      failed:                   0,
    };
    return phases[phase] ?? 0;
  }
}
