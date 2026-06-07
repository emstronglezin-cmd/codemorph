// ============================================================
// CodeMorph AI Engine — Configuration
// ============================================================
export const appConfig = {
  port:           parseInt(process.env['AI_PORT'] ?? '5000', 10),
  nodeEnv:        process.env['NODE_ENV'] ?? 'development',

  // ── Platform AI keys (owned by CodeMorph) ──────────────
  openaiApiKey:   process.env['OPENAI_API_KEY'] ?? '',
  anthropicKey:   process.env['ANTHROPIC_API_KEY'] ?? '',
  groqApiKey:     process.env['GROQ_API_KEY'] ?? '',

  // ── Default model (platform mode) ──────────────────────
  defaultModel:   process.env['AI_MODEL_DEFAULT'] ?? 'gpt-4o-mini',
  maxTokens:      parseInt(process.env['AI_MAX_TOKENS'] ?? '4096', 10),
  temperature:    parseFloat(process.env['AI_TEMPERATURE'] ?? '0.2'),

  // ── Free tier limits ────────────────────────────────────
  freeTier: {
    maxProjectSizeChars: 15_000,    // ~300 lines of code max
    maxConversionsPerDay: 5,         // per IP / unauth user
    maxFilesGenerated:   10,
  },

  // ── URLs ────────────────────────────────────────────────
  backendUrl:     process.env['API_URL'] ?? 'http://localhost:4000',
  secret:         process.env['AI_ENGINE_SECRET'] ?? 'ai-engine-secret',

  rateLimit: {
    windowMs: 60_000,
    max:      20,
  },
} as const;
