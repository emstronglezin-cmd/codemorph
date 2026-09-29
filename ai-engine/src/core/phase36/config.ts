// ============================================================
// CodeMorph AI Engine — PHASE 36: Configuration pipeline sémantique
//
// Toutes les limites sont configurables par variables d'environnement.
// AUCUNE limite provider n'est hardcodée ici — les valeurs par défaut
// sont calibrées pour rester dans les quotas gratuits (Groq free ~8K TPM,
// Render free), mais chaque valeur peut être surchargée.
//
// Variables supportées :
//   PHASE36_ENABLED                (default: true)   active/désactive le pipeline sémantique
//   PHASE36_THRESHOLD_CHARS        (default: 60000)  taille source déclenchant le pipeline sémantique
//   PHASE36_THRESHOLD_FILES        (default: 25)     nb de fichiers déclenchant le pipeline sémantique
//   AI_MAX_INPUT_TOKENS            (default: 4000)   budget input MAX par requête IA
//   AI_MAX_OUTPUT_TOKENS           (default: 2800)   budget output MAX par requête IA
//   AI_MAX_CONCURRENT_REQUESTS     (default: 1)      concurrence max (1 = séquentiel, priorité fiabilité)
//   AI_CHUNK_SIZE_TOKENS           (default: 2200)   budget contenu par chunk sémantique
//   AI_GLOBAL_CONTEXT_TOKENS       (default: 800)    budget du bloc contexte global
//   AI_DEP_CONTEXT_TOKENS          (default: 500)    budget des signatures de dépendances
//   AI_RETRY_DELAY_MS              (default: 2000)   délai de base du backoff progressif
//   AI_RETRY_MAX_ATTEMPTS          (default: 4)      tentatives max par requête (jamais de boucle infinie)
//   AI_RETRY_MAX_DELAY_MS          (default: 60000)  plafond d'attente d'un backoff
//   AI_RATE_LIMIT_TPM              (default: 6500)   budget tokens/minute utilisé pour le pacing local
//   AI_CACHE_ENABLED               (default: true)   cache disque des analyses de modules
//   AI_CACHE_TTL_HOURS             (default: 24)     durée de vie des entrées de cache
//   AI_CACHE_DIR                   (default: <tmp>/codemorph-phase36-cache)
//   AI_STATE_DIR                   (default: <tmp>/codemorph-phase36-state)
//   AI_PROMPT_VERSION              (default: p36.1.0) version des prompts (invalide le cache si changée)
//   AI_COHERENCE_AI_PASS           (default: false)  passe de réconciliation IA supplémentaire si incohérences
// ============================================================

import { isAbsolute, join } from 'path';
import { tmpdir } from 'os';

function intFromEnv(key: string, defaultValue: number, min: number, max: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return defaultValue;
  return Math.min(max, Math.max(min, parsed));
}

function boolFromEnv(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  return raw.trim().toLowerCase() === 'true' || raw.trim() === '1';
}

function strFromEnv(key: string, defaultValue: string): string {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  return raw.trim();
}

/** Résolvez le répertoire de stockage (absolu ou relatif à tmp). */
function resolveDir(dirOrAbsolute: string): string {
  if (isAbsolute(dirOrAbsolute)) return dirOrAbsolute;
  return join(tmpdir(), dirOrAbsolute);
}

export interface Phase36Config {
  /** Pipeline sémantique activé */
  enabled: boolean;
  /** Taille (chars) du source au-delà de laquelle le pipeline sémantique s'active */
  thresholdChars: number;
  /** Nombre de fichiers au-delà duquel le pipeline sémantique s'active */
  thresholdFiles: number;

  /** Budget tokens input par requête IA (garde-fou avant chaque appel) */
  maxInputTokens: number;
  /** Budget tokens output par requête IA */
  maxOutputTokens: number;
  /** Concurrence max des requêtes IA (1 = file séquentielle) */
  maxConcurrentRequests: number;
  /** Budget tokens du CONTENU d'un chunk sémantique */
  chunkSizeTokens: number;
  /** Budget tokens du bloc GLOBAL CONTEXT injecté dans chaque requête */
  globalContextTokens: number;
  /** Budget tokens des signatures de dépendances injectées */
  depContextTokens: number;

  /** Backoff progressif : délai de base (ms) */
  retryDelayMs: number;
  /** Backoff progressif : tentatives max (retry 1..N puis abandon) */
  retryMaxAttempts: number;
  /** Backoff progressif : plafond d'attente (ms) */
  retryMaxDelayMs: number;
  /** Pacing local : budget tokens/minute (doit rester SOUS la limite provider gratuite) */
  rateLimitTpm: number;

  /** Cache disque des analyses de modules */
  cacheEnabled: boolean;
  cacheTtlHours: number;
  cacheDir: string;
  /** État de reprise (checkpoints par chunk) */
  stateDir: string;

  /** Version des prompts — fait partie des clés de cache */
  promptVersion: string;
  /** Passe de réconciliation IA si incohérences critiques détectées */
  coherenceAiPass: boolean;
}

let cachedConfig: Phase36Config | null = null;

/** Lit la configuration Phase 36 depuis l'environnement (les tests peuvent reset via resetPhase36Config). */
export function getPhase36Config(): Phase36Config {
  if (cachedConfig) return cachedConfig;
  cachedConfig = {
    enabled:               boolFromEnv('PHASE36_ENABLED', true),
    thresholdChars:        intFromEnv('PHASE36_THRESHOLD_CHARS', 60_000, 5_000, 5_000_000),
    thresholdFiles:        intFromEnv('PHASE36_THRESHOLD_FILES', 25, 3, 10_000),

    maxInputTokens:        intFromEnv('AI_MAX_INPUT_TOKENS', 4_000, 1_000, 120_000),
    maxOutputTokens:       intFromEnv('AI_MAX_OUTPUT_TOKENS', 2_800, 500, 32_000),
    maxConcurrentRequests: intFromEnv('AI_MAX_CONCURRENT_REQUESTS', 1, 1, 8),
    chunkSizeTokens:       intFromEnv('AI_CHUNK_SIZE_TOKENS', 2_200, 500, 100_000),
    globalContextTokens:   intFromEnv('AI_GLOBAL_CONTEXT_TOKENS', 800, 100, 20_000),
    depContextTokens:      intFromEnv('AI_DEP_CONTEXT_TOKENS', 500, 0, 20_000),

    retryDelayMs:          intFromEnv('AI_RETRY_DELAY_MS', 2_000, 0, 120_000),
    retryMaxAttempts:      intFromEnv('AI_RETRY_MAX_ATTEMPTS', 4, 1, 10),
    retryMaxDelayMs:       intFromEnv('AI_RETRY_MAX_DELAY_MS', 60_000, 1_000, 600_000),
    rateLimitTpm:          intFromEnv('AI_RATE_LIMIT_TPM', 6_500, 500, 1_000_000),

    cacheEnabled:          boolFromEnv('AI_CACHE_ENABLED', true),
    cacheTtlHours:         intFromEnv('AI_CACHE_TTL_HOURS', 24, 1, 24 * 30),
    cacheDir:              resolveDir(strFromEnv('AI_CACHE_DIR', 'codemorph-phase36-cache')),
    stateDir:              resolveDir(strFromEnv('AI_STATE_DIR', 'codemorph-phase36-state')),

    promptVersion:         strFromEnv('AI_PROMPT_VERSION', 'p36.1.0'),
    coherenceAiPass:       boolFromEnv('AI_COHERENCE_AI_PASS', false),
  };
  return cachedConfig;
}

/** Test-only : force une relecture de l'environnement. */
export function resetPhase36Config(): void {
  cachedConfig = null;
}

// ── Estimation de tokens ──────────────────────────────────────────────────────
// Estimation conservatrice : ~4 caractères par token pour du code source.
// Légèrement majorée (+8%) pour ne jamais sous-estimer un prompt.
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil((text.length / 4) * 1.08);
}
