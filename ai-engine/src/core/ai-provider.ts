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
//   qwen/qwen3.6-27b     ← FALLBACK (produit <think> tags — strippé)
//   allam-2-7b           ← EMERGENCY
// ============================================================

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { appConfig } from '../config/app.config';

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
    const GROQ_MAX_TOKENS = Math.min(maxTokens, 3000);
    const client = new OpenAI({
      apiKey:  process.env['GROQ_API_KEY']!,
      baseURL: 'https://api.groq.com/openai/v1',
    });

    // Modèles à essayer en cascade si 429
    const GROQ_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];
    let lastError: Error | null = null;

    for (const modelId of GROQ_MODELS) {
      // Retry avec backoff exponentiel (3 tentatives max)
      for (let attempt = 0; attempt < 3; attempt++) {
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
            // Extraire le délai Retry-After si présent dans le message
            const retryMatch = msg.match(/(\d+(?:\.\d+)?)s/);
            const waitSec = retryMatch?.[1] ? Math.min(parseFloat(retryMatch[1]) + 2, 45) : (attempt + 1) * 15;
            console.warn(`[AIProvider] Groq 429 on ${modelId} attempt ${attempt+1}/3 — waiting ${waitSec}s...`);
            await new Promise((r) => setTimeout(r, waitSec * 1000));
            lastError = err instanceof Error ? err : new Error(msg);
            // Après 2 tentatives sur 120b, passer au 20b
            if (attempt >= 1 && modelId === GROQ_MODELS[0]) break;
          } else {
            // Erreur non-429 — propager immédiatement
            throw err;
          }
        }
      }
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
