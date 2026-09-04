// ============================================================
// CodeMorph AI Engine — Progress Reporter (Phase 28 PERF FIX)
//
// Envoie des mises à jour de progression en temps réel au backend
// pendant la conversion. Le backend les transmet via SSE/polling au frontend.
//
// Usage dans pipeline.ts :
//   const reporter = new ProgressReporter(ctx.progressUrl, ctx.jobId);
//   reporter.report('phase_2_arch', { filesDone: 0, filesTotal: 40, message: '...' });
// ============================================================

export interface ProgressUpdate {
  jobId:      string;
  phase:      string;
  phaseName:  string;
  filesDone:  number;
  filesTotal: number;
  aiCalls:    number;
  aiRetries:  number;
  elapsedMs:  number;
  message:    string;
  // Timestamp serveur
  timestamp:  string;
}

export class ProgressReporter {
  private readonly progressUrl: string | undefined;
  private readonly jobId:       string;
  private readonly startMs:     number;
  private aiCallsCount  = 0;
  private aiRetriesCount = 0;
  private lastReportMs  = 0;
  private readonly MIN_INTERVAL_MS = 5_000; // max 1 rapport toutes les 5s

  constructor(progressUrl: string | undefined, jobId: string) {
    this.progressUrl = progressUrl;
    this.jobId       = jobId;
    this.startMs     = Date.now();
  }

  /** Incrémenter le compteur d'appels AI (appelé par le pipeline à chaque appel Groq) */
  incrementAiCalls(retried = false): void {
    this.aiCallsCount++;
    if (retried) this.aiRetriesCount++;
  }

  /** Envoyer une mise à jour de progression (fire-and-forget, non-bloquant) */
  report(
    phase:      string,
    phaseName:  string,
    filesDone:  number,
    filesTotal: number,
    message:    string,
  ): void {
    if (!this.progressUrl) return;

    // Limiter le débit de rapports pour ne pas surcharger le backend
    const now = Date.now();
    if (now - this.lastReportMs < this.MIN_INTERVAL_MS) return;
    this.lastReportMs = now;

    const update: ProgressUpdate = {
      jobId:     this.jobId,
      phase,
      phaseName,
      filesDone,
      filesTotal,
      aiCalls:   this.aiCallsCount,
      aiRetries: this.aiRetriesCount,
      elapsedMs: now - this.startMs,
      message,
      timestamp: new Date().toISOString(),
    };

    // Fire-and-forget : ne pas attendre, ne pas bloquer le pipeline
    this.sendAsync(update).catch((err: Error) => {
      // Silencieux — la progression n'est pas critique
      console.warn(`[ProgressReporter] Failed to send progress: ${err.message}`);
    });
  }

  /** Force l'envoi d'une mise à jour (ignore le throttle) */
  async reportForce(
    phase:      string,
    phaseName:  string,
    filesDone:  number,
    filesTotal: number,
    message:    string,
  ): Promise<void> {
    if (!this.progressUrl) return;
    this.lastReportMs = Date.now();

    const update: ProgressUpdate = {
      jobId:     this.jobId,
      phase,
      phaseName,
      filesDone,
      filesTotal,
      aiCalls:   this.aiCallsCount,
      aiRetries: this.aiRetriesCount,
      elapsedMs: Date.now() - this.startMs,
      message,
      timestamp: new Date().toISOString(),
    };

    await this.sendAsync(update).catch((err: Error) => {
      console.warn(`[ProgressReporter] Force report failed: ${err.message}`);
    });
  }

  private async sendAsync(update: ProgressUpdate): Promise<void> {
    if (!this.progressUrl) return;
    try {
      // Utiliser fetch (Web API, disponible dans Node.js 18+)
      // Timeout 3s pour ne pas bloquer le pipeline
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3_000);

      const aiEngineSecret = process.env['AI_ENGINE_SECRET'] ?? '';
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (aiEngineSecret) headers['X-AI-Engine-Secret'] = aiEngineSecret;

      await fetch(this.progressUrl, {
        method:  'POST',
        headers,
        body:    JSON.stringify(update),
        signal:  ctrl.signal,
      });
      clearTimeout(timer);
    } catch {
      // Silencieux
    }
  }
}
