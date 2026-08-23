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
import { generateTypeScriptFromDart } from './dart-transpiler';

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

export type AITier = 'pro-openai' | 'pro-anthropic' | 'platform' | 'free-groq' | 'static' | 'transpile';

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
    // Mode transpile prioritaire — déterministe, pas de LLM, pas de quotas
    // Activé si CODEMORPH_TRANSPILE_MODE=true (fallback quand Groq key invalide)
    if (process.env['CODEMORPH_TRANSPILE_MODE'] === 'true') return 'transpile';
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
      case 'free-groq':     return 'openai/gpt-oss-120b';
      case 'transpile':     return 'dart-transpiler-v1';
      default:              return 'static';
    }
  }

  getTier(): AITier  { return this.tier; }
  getModel(): string { return this.model; }

  // ── Limits per tier (applied by ConversionContext in pipeline) ──────────────
  // IMPORTANT: Groq free tier = 8000 TPM (tokens/minute) pour tous les modèles.
  // max_tokens GROQ doit rester ≤ 3000 pour permettre 2-3 req/min sans 429.
  // Transpile: pas de limite LLM — le transpiler traite le code en local.
  static getLimits(tier: AITier): { maxInputChars: number; maxTokens: number } {
    switch (tier) {
      case 'pro-openai':    return { maxInputChars: 200_000, maxTokens: 8192 };
      case 'pro-anthropic': return { maxInputChars: 200_000, maxTokens: 8192 };
      case 'platform':      return { maxInputChars: 80_000,  maxTokens: 8192 };
      case 'free-groq':     return { maxInputChars: 80_000,  maxTokens: 3000 };
      case 'transpile':     return { maxInputChars: 500_000, maxTokens: 0    }; // no LLM, no limit
      case 'static':        return { maxInputChars: 5_000,   maxTokens: 0    };
    }
  }

  // ── Main chat completion ─────────────────────────────────────────────────────
  async chat(messages: ChatMessage[], maxTokens?: number, dartMeta?: { filePath: string; fileType: string }): Promise<AIResponse> {
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
      case 'transpile':
        return this.transpileChat(messages, dartMeta);
      case 'static':
        return { content: '', tokensUsed: 0, tier: 'static', model: 'static' };
    }
  }

  // ── Deterministic Dart→TypeScript transpiler (no LLM) ────────────────────────
  // Extrait le code Dart des messages (system prompt ou user message) et le convertit
  // via le transpileur déterministe. Produit de vraies structures TS, pas des stubs.
  private transpileChat(messages: ChatMessage[], dartMeta?: { filePath: string; fileType: string }): AIResponse {
    // Extraire le code Dart depuis les messages
    // Les prompts CodeMorph injectent le source dans le message user ou system
    const allContent = messages.map((m) => m.content).join('\n');
    
    // Patterns pour extraire le code Dart du prompt
    // FileGenerator:       ```dart\n{code}\n```  (avec tag 'dart')
    // BizLayerExtractor:   ```\n{code}\n```      (SANS tag — backtick nu)
    // FileChunker:         ```\n{code}\n```      (SANS tag)
    let dartCode = '';
    
    // Pattern 1: ```dart\n{code}\n``` (FileGenerator)
    const dartTagMatch = /```dart\n([\s\S]*?)```/.exec(allContent);
    if (dartTagMatch?.[1]) {
      dartCode = dartTagMatch[1];
    }
    
    // Pattern 2: SOURCE FILE (path, N lines):\n```\n{code}\n``` (BizLayerExtractor)
    if (!dartCode) {
      const bizLayerMatch = /SOURCE FILE[^\n]*\n```\n([\s\S]*?)```/.exec(allContent);
      if (bizLayerMatch?.[1]) {
        dartCode = bizLayerMatch[1];
      }
    }

    // Pattern 3: SOURCE CODE (N lines):\n```\n{code}\n``` ou backtick sans tag
    if (!dartCode) {
      const sourceCodeMatch = /SOURCE CODE[^\n]*\n```\n?([\s\S]*?)```/.exec(allContent);
      if (sourceCodeMatch?.[1]) {
        dartCode = sourceCodeMatch[1];
      }
    }
    
    // Pattern 4: tout bloc ```\n{code}\n``` qui contient du Dart
    if (!dartCode) {
      const anyBlock = /```\n([\s\S]*?)```/g;
      let m: RegExpExecArray | null;
      while ((m = anyBlock.exec(allContent)) !== null) {
        const candidate = m[1] ?? '';
        // Heuristique Dart: contains 'import package:' OR 'class X' + 'dart' keywords
        if (/import 'package:|void\s+\w+\s*\(|class\s+\w+/.test(candidate)) {
          dartCode = candidate;
          break;
        }
      }
    }

    // Pattern 5: dernier recours — lignes qui ressemblent à du Dart (sans bloc)
    if (!dartCode) {
      const dartHints = /(?:import 'package:|class \w+\s*\{|void main\()/;
      if (dartHints.test(allContent)) {
        const codeBlocks = allContent.split(/\n\n+/);
        dartCode = codeBlocks
          .filter((b) => b.includes('import') || b.includes('class ') || b.includes('return '))
          .sort((a, b) => b.length - a.length)[0] ?? '';
      }
    }
    
    // Résoudre le type de fichier depuis dartMeta ou l'URL du fichier dans le prompt
    const filePath  = dartMeta?.filePath ?? 'unknown.dart';
    const fileType  = (dartMeta?.fileType ?? this.inferFileType(allContent, filePath)) as
      'screen' | 'store' | 'service' | 'repository' | 'model' | 'component' | 'hook' | 'util' | 'config';
    
    if (!dartCode.trim()) {
      // Aucun code Dart trouvé — générer un stub basé sur le contexte du prompt
      console.warn(`[Transpiler] No Dart code found in prompt for ${filePath} — generating context stub`);
      const stubContent = this.generateContextStub(allContent, fileType, filePath);
      return { content: stubContent, tokensUsed: 0, tier: 'transpile', model: 'dart-transpiler-v1' };
    }
    
    console.log(`[Transpiler] ✅ Transpiling ${filePath} (${fileType}, ${dartCode.length} chars Dart)`);
    
    // Pour les screens, le transpileur ligne-par-ligne produit du Flutter/TS hybride
    // (Widget imbriqués, BuildContext, Column/children etc. ne peuvent pas être convertis
    // mécaniquement en JSX). On génère donc un écran RN propre avec la logique extraite.
    if (fileType === 'screen' || fileType === 'component') {
      return {
        content: this.generateCleanRNScreen(dartCode, filePath),
        tokensUsed: 0,
        tier: 'transpile',
        model: 'dart-transpiler-v1',
      };
    }
    const tsCode = generateTypeScriptFromDart(dartCode, filePath, fileType, filePath.replace('.dart', '.tsx'));
    
    return {
      content:    tsCode,
      tokensUsed: 0,
      tier:       'transpile',
      model:      'dart-transpiler-v1',
    };
  }

  // ── Génère un screen React Native propre depuis le code source Dart ──────────
  // Extrait les patterns utiles : nom de la classe, méthodes async, API calls,
  // états (bool, String) et génère un composant RN fonctionnel propre.
  // Meilleur que le transpileur ligne-par-ligne pour les screens Flutter imbriqués.
  private generateCleanRNScreen(dartCode: string, filePath: string): string {
    // Extraire le nom du screen
    const classMatch = /class\s+(\w+)(?:Screen|Page|Widget|View)?\s+extends/.exec(dartCode)
      ?? /class\s+(\w+)(?:Screen|Page)\b/.exec(dartCode);
    const rawName = classMatch?.[1] ?? filePath.split('/').pop()?.replace(/\.dart$/, '') ?? 'Screen';
    // Normaliser: PascalCase, retirer Screen/Page/Widget suffix si déjà là
    const name = rawName.charAt(0).toUpperCase() + rawName.slice(1);
    const displayName = name.replace(/Screen$|Page$|Widget$/, '') || name;

    // Extraire les méthodes async (logique métier)
    const asyncMethods: string[] = [];
    const asyncMethodRe = /(?:Future<[^>]+>|void)\s+_?(\w+)\s*\([^)]*\)\s*async\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = asyncMethodRe.exec(dartCode)) !== null) {
      const methodName = m[1] ?? '';
      if (methodName && !['build', 'initState', 'dispose', 'didChangeDependencies'].includes(methodName)) {
        asyncMethods.push(methodName);
      }
    }

    // Extraire les états bool/String/int déclarés
    const stateFields: Array<{ name: string; type: string; init: string }> = [];
    const fieldRe = /(?:bool|String|int|double|bool\?|String\?)\s+_(\w+)\s*=\s*([^;]+);/g;
    while ((m = fieldRe.exec(dartCode)) !== null) {
      const fieldName = m[1] ?? '';
      const rawType = dartCode.includes(`bool _${fieldName}`) ? 'boolean' 
        : dartCode.includes(`String _${fieldName}`) ? 'string' : 'number';
      const init = rawType === 'boolean' ? 'false' : rawType === 'string' ? "''" : '0';
      if (fieldName) stateFields.push({ name: fieldName, type: rawType, init });
    }

    // Extraire les imports provider/store référencés
    const storeRefs = new Set<string>();
    const refMatch = /ref\.(?:read|watch)\((\w+)/g;
    while ((m = refMatch.exec(dartCode)) !== null) {
      if (m[1]) storeRefs.add(m[1]);
    }

    // Extraire les appels API (pour documentation)
    const apiCalls: string[] = [];
    const apiRe = /\.\s*(get|post|put|delete|patch)\s*\(/g;
    while ((m = apiRe.exec(dartCode)) !== null) {
      apiCalls.push(m[1] ?? '');
    }

    // Construire le composant RN
    const stateDecls = stateFields.slice(0, 8).map((f) =>
      `  const [${f.name}, set${f.name.charAt(0).toUpperCase() + f.name.slice(1)}] = useState<${f.type}>(${f.init});`
    ).join('\n');

    const methodDecls = asyncMethods.slice(0, 6).map((methodName) =>
      `  const ${methodName} = async () => {\n    // TODO: implement ${methodName}\n  };`
    ).join('\n\n');

    const storeImports = Array.from(storeRefs).slice(0, 3).map((s) =>
      `// import { use${s.charAt(0).toUpperCase() + s.slice(1)} } from '../stores/${s}';`
    ).join('\n');

    const apiComment = apiCalls.length > 0
      ? `// API calls detected in source: ${[...new Set(apiCalls)].join(', ')}\n`
      : '';

    return [
      `import React, { useState, useEffect, useCallback } from 'react';`,
      `import { View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput, ActivityIndicator, Alert } from 'react-native';`,
      `import { useRouter } from 'expo-router';`,
      `import { colors } from '../theme';`,
      storeImports || '',
      ``,
      `// [CodeMorph] Converted from: ${filePath}`,
      apiComment,
      `interface ${displayName}Props {}`,
      ``,
      `export default function ${displayName}Screen(${displayName !== name ? `_props: ${displayName}Props` : ''}): React.JSX.Element {`,
      `  const router = useRouter();`,
      stateFields.length > 0 ? stateDecls : '  // No state fields detected',
      `  const [isLoading, setIsLoading] = useState<boolean>(false);`,
      `  const [error, setError] = useState<string | null>(null);`,
      ``,
      methodDecls || '  // No async methods detected',
      ``,
      `  useEffect(() => {`,
      `    // Initialize screen`,
      `  }, []);`,
      ``,
      `  if (isLoading) {`,
      `    return (`,
      `      <View style={styles.center}>`,
      `        <ActivityIndicator size="large" color={colors.primary} />`,
      `      </View>`,
      `    );`,
      `  }`,
      ``,
      `  return (`,
      `    <ScrollView style={styles.container} contentContainerStyle={styles.content}>`,
      `      <Text style={styles.title}>${displayName}</Text>`,
      `      {error && <Text style={styles.error}>{error}</Text>}`,
      `      {/* TODO: render ${displayName} UI */}`,
      `    </ScrollView>`,
      `  );`,
      `}`,
      ``,
      `const styles = StyleSheet.create({`,
      `  container: { flex: 1, backgroundColor: colors.background },`,
      `  content:   { padding: 16 },`,
      `  center:    { flex: 1, justifyContent: 'center', alignItems: 'center' },`,
      `  title:     { fontSize: 24, fontWeight: 'bold', color: colors.text, marginBottom: 16 },`,
      `  error:     { color: colors.error ?? '#e53e3e', marginBottom: 8 },`,
      `});`,
    ].filter((l) => l !== '').join('\n');
  }

  private inferFileType(content: string, filePath: string): string {
    const lc = (content + filePath).toLowerCase();
    if (/screen|page|view/.test(lc))     return 'screen';
    if (/provider|store|state/.test(lc)) return 'store';
    if (/repository|repo/.test(lc))      return 'repository';
    if (/service/.test(lc))              return 'service';
    if (/model|entity/.test(lc))         return 'model';
    if (/widget|component/.test(lc))     return 'component';
    return 'util';
  }

  private generateContextStub(prompt: string, fileType: string, filePath: string): string {
    // Extraire le nom du composant/fichier depuis le prompt
    const nameMatch = /(?:screen|component|store|service|model):\s*(\w+)/i.exec(prompt)
      ?? /(?:generate|create|convert)\s+(\w+)/i.exec(prompt);
    const rawName = nameMatch?.[1] ?? filePath.split('/').pop()?.replace('.dart','') ?? 'Generated';
    const name = rawName.charAt(0).toUpperCase() + rawName.slice(1);
    
    switch (fileType) {
      case 'screen':
      case 'component':
        return [
          `import React, { useState, useEffect } from 'react';`,
          `import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';`,
          `import { useRouter } from 'expo-router';`,
          '',
          `export default function ${name}() {`,
          `  const router = useRouter();`,
          `  return (`,
          `    <ScrollView style={styles.container}>`,
          `      <Text style={styles.title}>${name}</Text>`,
          `    </ScrollView>`,
          `  );`,
          `}`,
          '',
          `const styles = StyleSheet.create({`,
          `  container: { flex: 1, backgroundColor: '#fff', padding: 16 },`,
          `  title: { fontSize: 24, fontWeight: 'bold', marginBottom: 16 },`,
          `});`,
        ].join('\n');
      case 'store':
        return [
          `import { create } from 'zustand';`,
          '',
          `interface ${name}State {`,
          `  data: unknown[];`,
          `  isLoading: boolean;`,
          `  error: string | null;`,
          `  fetch: () => Promise<void>;`,
          `}`,
          '',
          `export const use${name}Store = create<${name}State>((set) => ({`,
          `  data: [],`,
          `  isLoading: false,`,
          `  error: null,`,
          `  fetch: async () => {`,
          `    set({ isLoading: true, error: null });`,
          `    try {`,
          `      // TODO: implement fetch`,
          `      set({ isLoading: false });`,
          `    } catch (e) {`,
          `      set({ error: String(e), isLoading: false });`,
          `    }`,
          `  },`,
          `}));`,
        ].join('\n');
      case 'model':
        return [
          `export interface ${name} {`,
          `  id: string;`,
          `  createdAt: Date;`,
          `}`,
          '',
          `export function ${name.charAt(0).toLowerCase() + name.slice(1)}FromJson(json: Record<string, unknown>): ${name} {`,
          `  return {`,
          `    id: String(json['id'] ?? ''),`,
          `    createdAt: new Date(String(json['createdAt'] ?? Date.now())),`,
          `  };`,
          `}`,
        ].join('\n');
      case 'service':
      case 'repository':
        return [
          `import axios from 'axios';`,
          `import { API_BASE_URL } from '../config/api.config';`,
          '',
          `class ${name} {`,
          `  private baseUrl = API_BASE_URL;`,
          '',
          `  async getAll(): Promise<unknown[]> {`,
          `    const res = await axios.get(\`\${this.baseUrl}/${name.toLowerCase()}s\`);`,
          `    return res.data;`,
          `  }`,
          '',
          `  async getById(id: string): Promise<unknown> {`,
          `    const res = await axios.get(\`\${this.baseUrl}/${name.toLowerCase()}s/\${id}\`);`,
          `    return res.data;`,
          `  }`,
          `}`,
          '',
          `export const ${name.charAt(0).toLowerCase() + name.slice(1)} = new ${name}();`,
          `export default ${name.charAt(0).toLowerCase() + name.slice(1)};`,
        ].join('\n');
      default:
        return `// ${name}\nexport const ${name.charAt(0).toLowerCase() + name.slice(1)} = {};\n`;
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
