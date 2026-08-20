// ============================================================
// CodeMorph AI Engine — AI Provider (Hybrid: Free + Pro)
//
// Mode FREE  : Groq API — openai/gpt-oss-120b (120B, ~gratuit, rapide)
//              Modèle principal disponible sur l'API Groq 2025
//              Context window large — parfait pour gros projets Flutter
//              Fallback statique si GROQ_API_KEY absent
//
// Mode PRO   : Clé OpenAI (gpt-4o / gpt-4o-mini) fournie par l'user
//              dans son profil — CodeMorph ne paie pas les tokens Pro
//
// Mode PRO MAX: Clé Anthropic (claude-3-5-sonnet) fournie par l'user
//
// Priorité: userOpenAI > userAnthropic > gpt-4o (platform) > groq > static
//
// Modèles Groq disponibles (2026-08) :
//   openai/gpt-oss-120b  ← PRIMARY  (meilleur pour code)
//   openai/gpt-oss-20b   ← FALLBACK (si 429 sur 120b)
//   allam-2-7b           ← EMERGENCY
// ============================================================

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { appConfig } from '../config/app.config';

// ── Rate Limiter global Groq (8000 TPM) ──────────────────────────────────────
// Groq free tier = 8000 tokens/minute pour TOUS les modèles combinés.
// Chaque requête consomme ~2500-5000 tokens (input+output).
// Pour garantir 0 429 : délai fixe de 35s entre requêtes (soit ~1.7 req/min max).
// Ce rate limiter est GLOBAL — toutes les instances AIProvider le partagent.
// Cela remplace les délais adhoc dans BizLayerExtractor et FileGenerator.
//
// DESIGN: mutex séquentiel (pas de file multi-consommateur).
// acquire() retourne quand le slot est libre + le délai de 35s est respecté.
// release() DOIT être appelé après chaque requête (dans un finally).
class GroqRateLimiter {
  private lastRequestEndTime = 0;
  // 35s entre la FIN d'une requête et le DÉBUT de la suivante
  // → garantit que la fenêtre TPM (60s) se recharge suffisamment
  private readonly minIntervalMs = 35_000;
  // Mutex: une seule requête à la fois
  private lock: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    // Chaîner les acquisitions pour sérialiser les requêtes
    let releaseLock!: () => void;
    const previousLock = this.lock;
    this.lock = new Promise<void>((resolve) => { releaseLock = resolve; });

    // Attendre que le lock précédent soit libéré
    await previousLock;

    // Calculer le délai depuis la fin de la dernière requête
    const elapsed = Date.now() - this.lastRequestEndTime;
    const waitMs  = elapsed < this.minIntervalMs ? this.minIntervalMs - elapsed : 0;

    if (waitMs > 0) {
      console.log(`[GroqRateLimiter] ⏳ Waiting ${(waitMs / 1000).toFixed(1)}s before next Groq request`);
      await new Promise((r) => setTimeout(r, waitMs));
    }

    // Retourner la fonction release que l'appelant DOIT appeler dans son finally
    return () => {
      this.lastRequestEndTime = Date.now();
      releaseLock();
    };
  }
}

// Singleton global — partagé entre toutes les instances AIProvider
const groqRateLimiter = new GroqRateLimiter();

export type AITier = 'pro-openai' | 'pro-anthropic' | 'platform' | 'free-groq' | 'static';

export interface AIResponse {
  content:    string;
  tokensUsed: number;
  tier:       AITier;
  model:      string;
}

export interface ChatMessage {
  role:    'system' | 'user' | 'assistant';
  content: string;
}

// ── Provider factory ──────────────────────────────────────────────────────────
export class AIProvider {
  private readonly tier: AITier;
  private readonly model: string;

  // User-supplied keys (passed per-request from the backend)
  private userOpenAIKey:    string | undefined;
  private userAnthropicKey: string | undefined;

  constructor(opts?: { userOpenAIKey?: string; userAnthropicKey?: string }) {
    this.userOpenAIKey    = opts?.userOpenAIKey ?? undefined;
    this.userAnthropicKey = opts?.userAnthropicKey ?? undefined;
    this.tier  = this.resolveTier();
    this.model = this.resolveModel();
  }

  // ── Tier resolution ─────────────────────────────────────────────────────────
  //
  // PRIORITÉ: userOpenAI > userAnthropic > Groq > platform > static
  //
  // IMPORTANT: La clé OPENAI_API_KEY injectée par le sandbox Genspark
  // (nFWgUyFVciWjpuCjWdOAVDCHMPBekwWJ) est un token de session non créditée
  // qui retourne HTTP 401 sur tous les appels de génération.
  // On la détecte et on skip automatiquement vers Groq.
  //
  // Groq llama-3.3-70b-versatile: 131 072 tokens context, gratuit, rapide.
  private resolveTier(): AITier {
    if (this.userOpenAIKey)    return 'pro-openai';
    if (this.userAnthropicKey) return 'pro-anthropic';
    // Groq prioritaire sur Platform — Groq est le provider primary fonctionnel
    if (process.env['GROQ_API_KEY']) return 'free-groq';
    // Platform uniquement si Groq absent ET clé OpenAI valide (commence par 'sk-')
    const openaiKey = appConfig.openaiApiKey;
    if (openaiKey && openaiKey.startsWith('sk-')) return 'platform';
    return 'static';
  }

  private resolveModel(): string {
    switch (this.tier) {
      case 'pro-openai':    return this.userOpenAIKey?.includes('sk-') ? 'gpt-4o' : 'gpt-4o-mini';
      case 'pro-anthropic': return 'claude-3-5-sonnet-20241022';
      case 'platform':      return appConfig.defaultModel ?? 'gpt-4o-mini';
      // openai/gpt-oss-120b = meilleur modèle disponible sur Groq en 2026
      // llama-3.3-70b-versatile n'est plus disponible sur cette clé
      case 'free-groq':     return 'openai/gpt-oss-120b';
      default:              return 'static';
    }
  }

  getTier(): AITier  { return this.tier; }
  getModel(): string { return this.model; }

  // ── Limits per tier (applied by ConversionContext in pipeline) ──────────────
  // IMPORTANT: Groq free tier = 8000 TPM (tokens/minute) pour tous les modèles.
  // max_tokens GROQ doit rester ≤ 3000 pour permettre 2-3 req/min sans 429.
  static getLimits(tier: AITier): { maxInputChars: number; maxTokens: number } {
    switch (tier) {
      case 'pro-openai':    return { maxInputChars: 200_000, maxTokens: 8192 };
      case 'pro-anthropic': return { maxInputChars: 200_000, maxTokens: 8192 };
      case 'platform':      return { maxInputChars: 80_000,  maxTokens: 8192 };
      case 'free-groq':     return { maxInputChars: 80_000,  maxTokens: 3000 };
      case 'static':        return { maxInputChars: 5_000,   maxTokens: 0    };
    }
  }

  // ── Main chat completion ─────────────────────────────────────────────────────
  async chat(messages: ChatMessage[], maxTokens?: number): Promise<AIResponse> {
    const limits = AIProvider.getLimits(this.tier);
    const tokens = maxTokens ?? limits.maxTokens;

    switch (this.tier) {
      case 'pro-openai':
        return this.openaiChat(messages, tokens, this.userOpenAIKey!);
      case 'pro-anthropic':
        return this.anthropicChat(messages, tokens);
      case 'platform':
        return this.openaiChat(messages, tokens, appConfig.openaiApiKey);
      case 'free-groq':
        return this.groqChat(messages, tokens);
      case 'static':
        return { content: '', tokensUsed: 0, tier: 'static', model: 'static' };
    }
  }

  // ── OpenAI / Groq (same SDK — Groq is OpenAI-compatible) ────────────────────
  private async openaiChat(messages: ChatMessage[], maxTokens: number, apiKey: string): Promise<AIResponse> {
    const client = new OpenAI({ apiKey });
    const res = await client.chat.completions.create({
      model:       this.model,
      messages,
      max_tokens:  maxTokens,
      temperature: appConfig.temperature,
    });
    return {
      content:    res.choices[0]?.message?.content ?? '',
      tokensUsed: res.usage?.total_tokens ?? 0,
      tier:       this.tier,
      model:      this.model,
    };
  }

  private async groqChat(messages: ChatMessage[], maxTokens: number): Promise<AIResponse> {
    // Groq free tier = 8000 TPM — cap max_tokens pour rester dans les limites
    // openai/gpt-oss-120b = primary, openai/gpt-oss-20b = fallback si 429
    const GROQ_MAX_TOKENS = Math.min(maxTokens, 2800);
    const client = new OpenAI({
      apiKey:  process.env['GROQ_API_KEY']!,
      baseURL: 'https://api.groq.com/openai/v1',
    });

    // ── Rate limiting global ──────────────────────────────────────────────────
    // Acquiert le slot (attend 35s depuis la fin de la dernière requête).
    // DOIT appeler release() dans un finally pour libérer le slot.
    const release = await groqRateLimiter.acquire();

    // Modèles à essayer en cascade si 429
    const GROQ_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];
    let lastError: Error | null = null;

    try {
      for (const modelId of GROQ_MODELS) {
        // Retry sur 429 résiduel uniquement (le rate limiter gère les cas normaux)
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await client.chat.completions.create({
              model:       modelId,
              messages,
              max_tokens:  GROQ_MAX_TOKENS,
              temperature: appConfig.temperature,
            });
            let rawContent = res.choices[0]?.message?.content ?? '';
            // Stripping <think>...</think> (qwen3.6-27b reasoning mode)
            rawContent = rawContent.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            if (modelId !== this.model) {
              console.log(`[AIProvider] Groq fallback succeeded with ${modelId} (primary ${this.model} was rate-limited)`);
            }
            console.log(`[AIProvider] Groq ✅ ${modelId} — ${res.usage?.total_tokens ?? '?'} tokens used`);
            return {
              content:    rawContent,
              tokensUsed: res.usage?.total_tokens ?? 0,
              tier:       'free-groq',
              model:      modelId,
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            const is429 = msg.includes('429') || msg.includes('rate limit') || msg.includes('Rate limit');
            if (is429) {
              // Extraire le délai Retry-After suggéré par l'API Groq
              const retryMatch = msg.match(/(\d+(?:\.\d+)?)s/);
              const waitSec = retryMatch?.[1]
                ? Math.max(parseFloat(retryMatch[1]) + 5, 40)
                : 45;
              console.warn(`[AIProvider] Groq 429 on ${modelId} attempt ${attempt+1}/2 — waiting ${waitSec}s (TPM recharge)...`);
              await new Promise((r) => setTimeout(r, waitSec * 1000));
              lastError = err instanceof Error ? err : new Error(msg);
              // Après 1 tentative sur 120b → passer immédiatement au modèle 20b
              if (modelId === GROQ_MODELS[0]) break;
            } else {
              throw err;
            }
          }
        }
      }
    } finally {
      // Libérer le slot — démarre le compte à rebours de 35s pour la prochaine requête
      release();
    }

    // Tous les modèles ont échoué
    throw lastError ?? new Error('Groq: all models exhausted');
  }

  // ── Anthropic ────────────────────────────────────────────────────────────────
  private async anthropicChat(messages: ChatMessage[], maxTokens: number): Promise<AIResponse> {
    const client = new Anthropic({ apiKey: this.userAnthropicKey! });
    const systemMsg = messages.find((m) => m.role === 'system')?.content ?? '';
    const userMsgs  = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const res = await client.messages.create({
      model:       this.model,
      max_tokens:  maxTokens,
      system:      systemMsg,
      messages:    userMsgs,
    });

    const content = res.content[0]?.type === 'text' ? res.content[0].text : '';
    return {
      content,
      tokensUsed: res.usage.input_tokens + res.usage.output_tokens,
      tier:       'pro-anthropic',
      model:      this.model,
    };
  }
}

// ── Singleton with default config (no user keys) ─────────────────────────────
export const defaultAIProvider = new AIProvider();
