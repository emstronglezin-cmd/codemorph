// ============================================================
// CodeMorph — FIX PHASE 39 — Cache de snapshot des fichiers sources
// ------------------------------------------------------------
// PROBLÈME (vérifié dans conversion-processor.service.ts) :
//   À CHAQUE tentative d'un job, la phase 2 re-télécharge intégralement le
//   dépôt GitHub (ou re-dézippe l'archive) puis le re-tronque selon le plan.
//   Avec CONVERSION_MAX_ATTEMPTS=5, un simple 429 au dispatch provoquait donc
//   5 téléchargements complets du même dépôt — pour un projet de 50 fichiers /
//   ~195 000 caractères, c'est ~1 Mo re-téléchargé et re-analysé 5 fois, plus
//   5 × N appels à l'API GitHub (qui a sa propre limite de débit).
//
// CE QUE CE CACHE FAIT :
//   • Mémorise le snapshot des fichiers d'un jobId pour la durée de ses retries.
//   • Une reprise réutilise le snapshot au lieu de re-télécharger.
//
// COHÉRENCE (exigence explicite) :
//   • Le snapshot n'est réutilisé QUE pour attemptsMade > 0 du MÊME jobId.
//     La première tentative télécharge toujours à neuf.
//   • Le dto d'un job est figé à l'enqueue (même repo, même branche) : le
//     snapshot reste donc cohérent avec la demande.
//   • Réutiliser le snapshot est en réalité PLUS cohérent que re-télécharger :
//     si le dépôt change entre deux tentatives, un re-téléchargement ferait
//     convertir un projet différent sous le même jobId.
//   • TTL court (défaut 10 min) : couvre la fenêtre de retry réelle
//     (backoff 5s+10s+20s+40s ≈ 75s) sans jamais servir du code périmé.
//   • L'entrée est supprimée dès que le job atteint un état terminal.
//
// MÉMOIRE (contrainte Render free tier, 512 Mo) :
//   • Borne en NOMBRE d'entrées (SOURCE_CACHE_MAX_ENTRIES).
//   • Borne en CARACTÈRES totaux (SOURCE_CACHE_MAX_CHARS) — c'est la vraie
//     mesure du poids, un projet pouvant peser 200 Ko à lui seul.
//   • Éviction : la plus ancienne entrée d'abord (FIFO sur l'horodatage).
//
// SÉCURITÉ : ce module ne journalise JAMAIS le contenu des fichiers,
// uniquement des comptes (fichiers, caractères) et des identifiants.
// ============================================================

export interface SourceFile {
  path:    string;
  content: string;
}

interface CacheEntry {
  at:          number;
  files:       SourceFile[];
  totalChars:  number;
}

export interface SourceSnapshotCacheOptions {
  ttlMs?:        number;
  maxEntries?:   number;
  maxTotalChars?: number;
  now?:          () => number;
}

/** TTL par défaut : 10 minutes (fenêtre de retry réelle ≈ 75 s). */
export const SOURCE_CACHE_TTL_MS = 10 * 60 * 1_000;

/** Nombre max de jobs mis en cache simultanément. */
export const SOURCE_CACHE_MAX_ENTRIES = 20;

/** Budget total de caractères mis en cache (~20 Mo pour du code ASCII). */
export const SOURCE_CACHE_MAX_CHARS = 20_000_000;

export class SourceSnapshotCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly ttlMs:         number;
  private readonly maxEntries:    number;
  private readonly maxTotalChars: number;
  private readonly now:           () => number;
  private totalChars = 0;

  constructor(opts: SourceSnapshotCacheOptions = {}) {
    this.ttlMs         = opts.ttlMs         ?? SOURCE_CACHE_TTL_MS;
    this.maxEntries    = opts.maxEntries    ?? SOURCE_CACHE_MAX_ENTRIES;
    this.maxTotalChars = opts.maxTotalChars ?? SOURCE_CACHE_MAX_CHARS;
    this.now           = opts.now           ?? Date.now;
  }

  private charCountOf(files: SourceFile[]): number {
    return files.reduce((acc, f) => acc + (f.content?.length ?? 0), 0);
  }

  /** Stocke le snapshot d'un job. Évince si nécessaire AVANT d'insérer. */
  put(jobId: string, files: SourceFile[]): void {
    const chars = this.charCountOf(files);
    this.evictExpired();

    // Une entrée trop grosse pour le budget ne doit pas tout évincer à elle
    // seule : on la refuse plutôt que de vider le cache à chaque job.
    if (chars > this.maxTotalChars) return;

    // Remplacement d'une entrée existante : libérer d'abord son poids.
    const existing = this.entries.get(jobId);
    if (existing) {
      this.totalChars -= existing.totalChars;
      this.entries.delete(jobId);
    }

    while (
      (this.entries.size >= this.maxEntries || this.totalChars + chars > this.maxTotalChars) &&
      this.entries.size > 0
    ) {
      const oldestKey = this.oldestKey();
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (oldest) this.totalChars -= oldest.totalChars;
    }

    this.entries.set(jobId, { at: this.now(), files, totalChars: chars });
    this.totalChars += chars;
  }

  /** Récupère un snapshot valide, ou undefined (absent / expiré). */
  get(jobId: string): SourceFile[] | undefined {
    this.evictExpired();
    return this.entries.get(jobId)?.files;
  }

  /** Supprime l'entrée d'un job (appelé quand le job devient terminal). */
  delete(jobId: string): void {
    const entry = this.entries.get(jobId);
    if (entry) {
      this.totalChars -= entry.totalChars;
      this.entries.delete(jobId);
    }
  }

  /** Vide entièrement le cache (tests / arrêt propre du process). */
  clear(): void {
    this.entries.clear();
    this.totalChars = 0;
  }

  /** Nombre d'entrées actuellement conservées (pour tests / monitoring). */
  get size(): number {
    return this.entries.size;
  }

  /** Caractères actuellement conservés (pour tests / monitoring). */
  get chars(): number {
    return this.totalChars;
  }

  private oldestKey(): string | undefined {
    let key:  string | undefined;
    let best = Number.POSITIVE_INFINITY;
    for (const [k, v] of this.entries) {
      if (v.at < best) { best = v.at; key = k; }
    }
    return key;
  }

  private evictExpired(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [k, v] of this.entries) {
      if (v.at <= cutoff) {
        this.entries.delete(k);
        this.totalChars -= v.totalChars;
      }
    }
  }
}

/**
 * Instance partagée par le process backend.
 * Volontairement en mémoire : le cache ne sert qu'à éviter un re-téléchargement
 * entre deux tentatives rapprochées. S'il est perdu (redémarrage Render), le
 * comportement retombe simplement sur « re-télécharger », qui est correct.
 */
export const sourceSnapshotCache = new SourceSnapshotCache();
