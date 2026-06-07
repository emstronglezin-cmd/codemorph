// ============================================================
// CodeMorph AI Engine — AI Provider (Hybrid: Free + Pro)
//
// Mode FREE  : Groq API (Llama 3.1 8B Instant) — gratuit jusqu'à
//              14 400 req/jour, latence <1s, API OpenAI-compatible
//              Fallback statique si GROQ_API_KEY absent
//
// Mode PRO   : Clé OpenAI (gpt-4o / gpt-4o-mini) fournie par l'user
//              dans son profil — CodeMorph ne paie pas les tokens Pro
//
// Mode PRO MAX: Clé Anthropic (claude-3-5-sonnet) fournie par l'user
//
// Priorité: userOpenAI > userAnthropic > gpt-4o (platform) > groq > static
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
  private resolveTier(): AITier {
    if (this.userOpenAIKey)                      return 'pro-openai';
    if (this.userAnthropicKey)                   return 'pro-anthropic';
    if (appConfig.openaiApiKey)                  return 'platform';
    if (process.env['GROQ_API_KEY'])             return 'free-groq';
    return 'static';
  }

  private resolveModel(): string {
    switch (this.tier) {
      case 'pro-openai':    return this.userOpenAIKey?.includes('sk-') ? 'gpt-4o' : 'gpt-4o-mini';
      case 'pro-anthropic': return 'claude-3-5-sonnet-20241022';
      case 'platform':      return appConfig.defaultModel ?? 'gpt-4o-mini';
      case 'free-groq':     return 'llama-3.1-8b-instant';
      default:              return 'static';
    }
  }

  getTier(): AITier  { return this.tier; }
  getModel(): string { return this.model; }

  // ── Limits per tier (applied by ConversionContext in pipeline) ──────────────
  static getLimits(tier: AITier): { maxInputChars: number; maxTokens: number } {
    switch (tier) {
      case 'pro-openai':    return { maxInputChars: 200_000, maxTokens: 8192 };
      case 'pro-anthropic': return { maxInputChars: 200_000, maxTokens: 8192 };
      case 'platform':      return { maxInputChars: 50_000,  maxTokens: 4096 };
      case 'free-groq':     return { maxInputChars: 15_000,  maxTokens: 2048 };
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
    // Groq is fully OpenAI-compatible — use OpenAI SDK with custom baseURL
    const client = new OpenAI({
      apiKey:  process.env['GROQ_API_KEY']!,
      baseURL: 'https://api.groq.com/openai/v1',
    });
    const res = await client.chat.completions.create({
      model:       this.model,
      messages,
      max_tokens:  maxTokens,
      temperature: appConfig.temperature,
    });
    return {
      content:    res.choices[0]?.message?.content ?? '',
      tokensUsed: res.usage?.total_tokens ?? 0,
      tier:       'free-groq',
      model:      this.model,
    };
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
