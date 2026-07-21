// ============================================================
// CodeMorph AI Engine — IR Generator
// AI outputs IR ONLY — never final code directly
// Uses AIProvider — supports Free (Groq), Platform (OpenAI), Pro (user key)
// PHASE 22: Prompt Maître V2 — system prompts enrichis, extraction métier complète
// ============================================================
import { AIProvider }  from './ai-provider';
import type { ConversionContext, IRDocument, IRSourceMetrics } from '../models/ir.types';
import type { ASTResult }  from './ast-analyzer';
import type { ArchResult } from './architecture-detector';

export interface IRGenerationResult {
  ir:         IRDocument;
  tokensUsed: number;
}

export class IRGenerator {
  private readonly ai: AIProvider;

  constructor(opts?: { userOpenAIKey?: string; userAnthropicKey?: string }) {
    this.ai = new AIProvider(opts);
  }

  async generate(
    ctx:  ConversionContext,
    ast:  ASTResult,
    arch: ArchResult,
  ): Promise<IRGenerationResult> {
    const limits = AIProvider.getLimits(this.ai.getTier());
    const tier   = this.ai.getTier();

    console.log(`[IRGenerator] generate() START — tier=${tier} maxTokens=${limits.maxTokens} maxInputChars=${limits.maxInputChars} files=${ast.files.length}`);

    // For static tier — return minimal IR immediately
    if (tier === 'static') {
      console.log(`[IRGenerator] static tier — returning minimal IR (no AI calls)`);
      return this.buildStaticIR(ctx, ast, arch);
    }

    // ── FIX PHASE 21: For Groq (free-groq) with 2048 token limit ──────────
    // The problem: with 2048 tokens, JSON responses get truncated → JSON.parse fails
    // → generateUIGraph returns { screens: [], components: [] } → only 4 files
    //
    // Fix strategy for Groq:
    // 1. Run generators SEQUENTIALLY (not in parallel) to avoid rate limits
    // 2. Use simplified prompts requesting minimal JSON to stay within 2048 tokens
    // 3. Implement partial JSON recovery (extract what was parsed before truncation)
    // 4. AST-based fallback: if AI returns empty arrays, infer from source file names
    //
    // For non-Groq tiers: keep parallel execution as before
    let uiGraph:      { data: IRDocument['uiGraph'];      tokens: number };
    let backendGraph: { data: IRDocument['backendGraph']; tokens: number };
    let dataLayer:    { data: IRDocument['dataLayer'];    tokens: number };
    let depMap:       { data: IRDocument['dependencyMap'];tokens: number };

    if (tier === 'free-groq') {
      // Sequential execution for Groq — avoid rate limits + allow recovery
      console.log(`[IRGenerator] Groq tier: sequential execution with simplified prompts`);
      uiGraph      = await this.generateUIGraph(ctx, ast, arch, limits.maxTokens);
      backendGraph = await this.generateBackendGraph(ctx, ast, arch, limits.maxTokens);
      dataLayer    = await this.generateDataLayer(ctx, ast, limits.maxTokens);
      depMap       = await this.generateDependencyMap(ctx, ast);
    } else {
      // Parallel execution for other tiers (faster)
      [uiGraph, backendGraph, dataLayer, depMap] = await Promise.all([
        this.generateUIGraph(ctx, ast, arch, limits.maxTokens),
        this.generateBackendGraph(ctx, ast, arch, limits.maxTokens),
        this.generateDataLayer(ctx, ast, limits.maxTokens),
        this.generateDependencyMap(ctx, ast),
      ]);
    }

    console.log(`[IRGenerator] IR graphs — uiGraph.screens=${uiGraph.data.screens?.length ?? 0} uiGraph.components=${uiGraph.data.components?.length ?? 0} backendGraph.routes=${backendGraph.data.routes?.length ?? 0} dataLayer.models=${dataLayer.data.models?.length ?? 0}`);

    // ── AST-based fallback for uiGraph when AI returns empty ───────────────
    // If Groq couldn't parse screens, infer from source file names
    if ((uiGraph.data.screens?.length ?? 0) === 0 && ast.files.length > 0) {
      console.log(`[IRGenerator] uiGraph.screens empty — inferring from AST file names`);
      uiGraph.data = this.inferUIGraphFromAST(ast, ctx);
      console.log(`[IRGenerator] Inferred uiGraph — screens=${uiGraph.data.screens?.length ?? 0} components=${uiGraph.data.components?.length ?? 0}`);
    }

    const totalTokens = uiGraph.tokens + backendGraph.tokens + dataLayer.tokens + depMap.tokens;
    console.log(`[IRGenerator] generate() DONE — totalTokensUsed=${totalTokens}`);

    // ── PHASE 22: Construire métriques source (pour Phase 7 auto-correction) ──
    const sourceMetrics: IRSourceMetrics = {
      screensCount:   uiGraph.data.screens?.length ?? 0,
      modelsCount:    dataLayer.data.models?.length ?? 0,
      servicesCount:  backendGraph.data.services?.length ?? 0,
      endpointsCount: backendGraph.data.routes?.length ?? 0,
      storesCount:    uiGraph.data.stateFlow?.length ?? 0,
      assetsCount:    ast.assetFiles?.length ?? 0,
      featuresDetected: [
        ...(ast.statePatterns   ?? []),
        ...(ast.externalServices ?? []),
        ...(ast.authPatterns    ?? []),
      ],
    };
    console.log(`[IRGenerator] sourceMetrics — screens=${sourceMetrics.screensCount} models=${sourceMetrics.modelsCount} services=${sourceMetrics.servicesCount} endpoints=${sourceMetrics.endpointsCount}`);

    // ── PHASE 22: Construire assets, permissions, envVars, externalConnections ──
    const irAssets = ast.assetFiles?.length > 0 ? this.buildAssets(ast) : undefined;
    const irEnvVars = ast.envVarKeys?.length > 0 ? this.buildEnvVars(ast) : undefined;
    const irExtConnections = ast.externalServices?.length > 0 ? this.buildExternalConnections(ast) : undefined;

    const ir: IRDocument = {
      projectMeta:   this.buildProjectMeta(ctx, ast, arch),
      architecture:  this.buildArchitecture(arch),
      uiGraph:       uiGraph.data,
      backendGraph:  backendGraph.data,
      dataLayer:     dataLayer.data,
      dependencyMap: depMap.data,
      conversionPlan: this.buildConversionPlan(ctx, arch),
      validation:    {
        ...this.buildValidation(ctx, ast, arch),
        sourceMetrics,
      },
      // ── PHASE 22: Spread conditionnel pour respecter exactOptionalPropertyTypes ──
      ...(irAssets        ? { assets: irAssets }                       : {}),
      ...(irEnvVars       ? { envVars: irEnvVars }                     : {}),
      ...(irExtConnections ? { externalConnections: irExtConnections } : {}),
    };

    return { ir, tokensUsed: totalTokens };
  }

  // ── Infer uiGraph from AST file names (fallback when AI returns empty) ────
  // Uses file paths as screen/component names — ensures code-planner always has data
  private inferUIGraphFromAST(ast: ASTResult, ctx: ConversionContext): IRDocument['uiGraph'] {
    const screens:    IRDocument['uiGraph']['screens']    = [];
    const components: IRDocument['uiGraph']['components'] = [];

    // Screen heuristic: files matching screen/page/view pattern
    const screenFiles = ast.files.filter((f) =>
      /screen|page|view/i.test(f.path) ||
      /\/pages?\//i.test(f.path) ||
      /\/screens?\//i.test(f.path)
    );

    // Component heuristic: files matching widget/component pattern
    const componentFiles = ast.files.filter((f) =>
      /widget|component/i.test(f.path) ||
      /\/widgets?\//i.test(f.path) ||
      /\/components?\//i.test(f.path)
    );

    // ── Build screens from file names ────────────────────────
    const seenScreens = new Set<string>();
    for (const f of screenFiles.slice(0, 15)) {
      const baseName   = f.path.split('/').pop() ?? f.path;
      const rawName    = baseName.replace(/\.(dart|tsx?|jsx?|vue)$/, '');
      // Normalize: remove "screen", "page", "view" suffixes for dedup
      const normalized = rawName.replace(/Screen$|Page$|View$/i, '');
      if (seenScreens.has(normalized.toLowerCase())) continue;
      seenScreens.add(normalized.toLowerCase());

      const toP = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
      const screenName = toP(normalized.replace(/[-_]/g, ' ').split(' ').map(toP).join(''));
      screens.push({
        id:         `screen-${screenName.toLowerCase()}`,
        name:       screenName,
        path:       f.path,
        route:      `/${screenName.toLowerCase()}`,
        components: f.classes.slice(0, 5),
        guards:     [],
      });
    }

    // If no screen files found, create basic screens from modules
    if (screens.length === 0) {
      const moduleNames = [...new Set(ast.files.map((f) => {
        const parts = f.path.split('/');
        return parts.length > 1 ? parts[0] : null;
      }).filter(Boolean))].slice(0, 6) as string[];

      for (const mod of moduleNames) {
        const toP3 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
      const name = toP3(mod.replace(/[-_]/g, ' ').split(' ').map(toP3).join(''));
        if (name.length < 2) continue;
        screens.push({
          id:         `screen-${name.toLowerCase()}`,
          name:       `${name}Screen`,
          path:       `${mod}/`,
          route:      `/${name.toLowerCase()}`,
          components: [],
          guards:     [],
        });
      }
    }

    // ── PHASE 22: Final fallback STRICTEMENT interdits: HomeScreen, ProfileScreen, SettingsScreen
    // Si aucune donnée source n'est disponible, retourner des écrans vides
    // plutôt que des noms génériques inventés
    if (screens.length === 0) {
      console.warn(`[IRGenerator] inferUIGraphFromAST: no screens could be inferred from ${ast.files.length} files — returning empty (Prompt Maître V2 prohibition)`);
      // Ne pas générer de noms génériques — le code-planner gérera le cas vide
    }

    // ── Build components from file names ────────────────────
    for (const f of componentFiles.slice(0, 20)) {
      const baseName = f.path.split('/').pop() ?? f.path;
      const rawName  = baseName.replace(/\.(dart|tsx?|jsx?|vue)$/, '');
      const toP2 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
      const compName = toP2(rawName.replace(/[-_]/g, ' ').split(' ').map(toP2).join(''));
      components.push({
        id:       `comp-${compName.toLowerCase()}`,
        name:     compName,
        type:     'ui',
        props:    f.exports.slice(0, 5).map((e) => ({ name: e, type: 'unknown', required: false })),
        children: [],
      });
    }

    console.log(`[IRGenerator] inferUIGraphFromAST — built ${screens.length} screens, ${components.length} components from ${ast.files.length} source files`);
    const targetFramework = ctx.targetFramework;
    void targetFramework; // used in prompts

    return {
      screens,
      components,
      navigationFlow: screens.slice(1).map((s) => ({
        from:    screens[0]?.id ?? 'screen-home',
        to:      s.id,
        trigger: 'navigate',
        guard:   '',
      })),
      stateFlow: [],
    };
  }

  // ── Static IR (no AI — Free tier fallback) ────────────────────────────────
  private buildStaticIR(ctx: ConversionContext, ast: ASTResult, arch: ArchResult): IRGenerationResult {
    const frameworkMap = FRAMEWORK_DEP_MAPS[`${ctx.sourceFramework}->${ctx.targetFramework}`];
    const ir: IRDocument = {
      projectMeta:   this.buildProjectMeta(ctx, ast, arch),
      architecture:  this.buildArchitecture(arch),
      uiGraph:       { screens: [], components: [], navigationFlow: [], stateFlow: [] },
      backendGraph:  { routes: [], services: [], entities: [], middlewares: [] },
      dataLayer:     { models: [], relationships: [], migrations: [] },
      dependencyMap: frameworkMap ?? { keep: [], replace: [], remove: [], add: [] },
      conversionPlan: this.buildConversionPlan(ctx, arch),
      validation:    this.buildValidation(ctx, ast, arch),
    };
    return { ir, tokensUsed: 0 };
  }

  // ── Shared builders (no AI needed) ────────────────────────────────────────
  private buildProjectMeta(ctx: ConversionContext, ast: ASTResult, arch: ArchResult): IRDocument['projectMeta'] {
    return {
      name:               ctx.projectId,
      type:               ctx.sourceFramework.toLowerCase().includes('flutter') ? 'mobile' : 'backend',
      sourceStack:        ctx.sourceFramework,
      targetStack:        ctx.targetFramework,
      complexityScore:    this.calcComplexity(ast, arch),
      description:        ctx.userGoal ?? `Convert ${ctx.sourceFramework} to ${ctx.targetFramework}`,
      version:            '1.0.0',
      sourceFiles:        ast.files.length,
      totalLines:         ast.files.reduce((a, f) => a + f.lines, 0),
      detectedFrameworks: [ctx.sourceFramework, ...arch.patterns],
    };
  }

  private buildArchitecture(arch: ArchResult): IRDocument['architecture'] {
    return {
      modules: arch.modules.map((m) => ({
        name:         m.name,
        path:         m.path,
        type:         m.role as 'feature' | 'shared' | 'core' | 'infra' | 'ui',
        dependencies: [],
        exports:      [],
        complexity:   Math.floor(m.files.length * 10),
      })),
      layers:   arch.layers,
      patterns: arch.patterns,
    };
  }

  private buildConversionPlan(ctx: ConversionContext, arch: ArchResult): IRDocument['conversionPlan'] {
    const steps: IRDocument['conversionPlan'] = [
      { step: 1, phase: 'parse',    action: 'Parse source AST',              target: 'source',        estimatedTime: '5s' },
      { step: 2, phase: 'analyze',  action: 'Detect architecture patterns',  target: 'architecture',  estimatedTime: '10s' },
      { step: 3, phase: 'analyze',  action: 'Map UI components',             target: 'uiGraph',       estimatedTime: '15s', dependencies: [2] },
      { step: 4, phase: 'map',      action: 'Map dependencies',              target: 'dependencyMap', estimatedTime: '5s' },
      { step: 5, phase: 'generate', action: `Generate ${ctx.targetFramework} structure`, target: 'output', estimatedTime: '30s', dependencies: [3, 4] },
      { step: 6, phase: 'validate', action: 'Validate IR completeness',      target: 'ir',            estimatedTime: '5s', dependencies: [5] },
    ];
    if (arch.hasDB) {
      steps.splice(4, 0, {
        step: 4.5 as never, phase: 'map', action: 'Map data models & migrations', target: 'dataLayer', estimatedTime: '10s', dependencies: [3],
      });
    }
    return steps.map((s, i) => ({ ...s, step: i + 1 }));
  }

  private buildValidation(ctx: ConversionContext, ast: ASTResult, arch: ArchResult): IRDocument['validation'] {
    const warnings: string[] = [];
    const blockers:  string[] = [];

    if (ast.files.length === 0) blockers.push('No source files found');
    if (arch.pattern === 'unknown') warnings.push('Architecture pattern could not be detected — manual review recommended');
    if (ast.files.reduce((a, f) => a + f.lines, 0) > 50_000) warnings.push('Large codebase — conversion may require multiple passes');
    if (!arch.hasRouter && ctx.sourceFramework.toLowerCase().includes('flutter')) warnings.push('No router detected — navigation mapping may be incomplete');

    const riskLevel = blockers.length > 0 ? 'critical'
      : warnings.length > 3  ? 'high'
      : warnings.length > 0  ? 'medium' : 'low';

    return {
      buildable:     blockers.length === 0,
      testsRequired: true,
      riskLevel,
      warnings,
      blockers,
      coverage: Math.min(100, 60 + ast.files.length * 2),
    };
  }

  private calcComplexity(ast: ASTResult, arch: ArchResult): number {
    let score = 0;
    score += Math.min(40, ast.files.length * 2);
    score += Math.min(20, arch.modules.length * 3);
    score += arch.hasDB     ? 15 : 0;
    score += arch.hasAPI    ? 10 : 0;
    score += arch.hasState  ? 10 : 0;
    score += arch.hasRouter ?  5 : 0;
    return Math.min(100, score);
  }

  // ── Partial JSON recovery ──────────────────────────────────────────────────
  // FIX PHASE 21: Groq truncates JSON at 2048 tokens → JSON.parse fails
  private tryParseJSON<T extends object>(raw: string, fallback: T): T {
    if (!raw?.trim()) return fallback;
    let s = raw.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    // 1. Direct parse
    try { return JSON.parse(s) as T; } catch { /* continue */ }
    // 2. Scan backwards for valid JSON
    for (let i = s.length - 1; i >= 0; i--) {
      const c = s[i];
      if (c === '}' || c === ']') {
        try { return JSON.parse(s.slice(0, i + 1)) as T; } catch { /* continue */ }
      }
    }
    // 3. Extract arrays by key
    try {
      const fb = fallback as Record<string, unknown>;
      const result: Record<string, unknown> = { ...fb };
      const keys = Object.keys(fb).filter((k) => Array.isArray(fb[k]));
      for (const key of keys) {
        const m = new RegExp('"' + key + '"\\s*:\\s*(\\[[\\s\\S]*?\\])').exec(s);
        if (m?.[1]) { try { result[key] = JSON.parse(m[1]); } catch { /* keep fallback */ } }
      }
      return result as T;
    } catch { return fallback; }
  }

  // ── AI-powered graph generators ────────────────────────────────────────────

  // ── PHASE 22: Prompt Maître V2 system prompt ──────────────────────────────
  // Injecté comme message SYSTEM dans tous les appels AI de génération IR
  // Force l'extraction de logique métier réelle — jamais de placeholders
  private readonly MASTER_SYSTEM_PROMPT = `You are a senior software engineer specialized in reverse engineering, software architecture, and multi-framework migration.

YOUR MISSION: Do NOT translate code line by line. Understand the application completely and extract all business knowledge.

RULES:
1. NEVER return placeholder content (HomeScreen, DetailsScreen, TODO, placeholder, example data)
2. NEVER invent functionality that doesn't exist in the source
3. NEVER remove screens or features from the source
4. ALWAYS extract real screen names, real API endpoints, real business logic
5. ALWAYS preserve navigation flows, authentication patterns, data models
6. If unsure about a value, use the actual file name / class name from source — never invent a generic name

For each screen you find, identify:
- Its exact name from the source code
- Its business purpose (what it does for the user)
- Data it displays or manipulates
- User events it handles
- API calls it makes

Return ONLY valid JSON. No markdown, no explanation, no code blocks.`;

  private async generateUIGraph(
    ctx: ConversionContext, ast: ASTResult, _arch: ArchResult, maxTokens: number,
  ): Promise<{ data: IRDocument['uiGraph']; tokens: number }> {
    const uiFiles = ast.files.filter((f) => /screen|page|view|widget|component/i.test(f.path));
    const fallback: IRDocument['uiGraph'] = { screens: [], components: [], navigationFlow: [], stateFlow: [] };

    if (uiFiles.length === 0) {
      console.log(`[IRGenerator] generateUIGraph: no UI files in ${ast.files.length} total — returning empty`);
      return { data: fallback, tokens: 0 };
    }

    // ── PHASE 22: contexte enrichi — inclure patterns détectés par AST ──────
    const stateInfo   = ast.statePatterns?.length   ? `State management: ${ast.statePatterns.join(', ')}` : '';
    const navInfo     = ast.navigationPattern && ast.navigationPattern !== 'unknown' ? `Navigation: ${ast.navigationPattern}` : '';
    const authInfo    = ast.authPatterns?.length     ? `Auth: ${ast.authPatterns.join(', ')}` : '';
    const extInfo     = ast.externalServices?.length ? `External services: ${ast.externalServices.join(', ')}` : '';
    const contextBlock = [stateInfo, navInfo, authInfo, extInfo].filter(Boolean).join(' | ');

    // Prendre plus de fichiers et plus de contenu pour une meilleure extraction
    const filesCtx = uiFiles.slice(0, 8).map((f) =>
      `FILE: ${f.path}\nCLASSES: ${f.classes.slice(0, 5).join(', ')}\nFUNCS: ${f.functions.slice(0, 5).join(', ')}\nCONTENT:\n${f.content.slice(0, 200)}`
    ).join('\n---\n');

    const prompt = `Framework: ${ctx.sourceFramework} → Target: ${ctx.targetFramework}
${contextBlock ? `Context: ${contextBlock}` : ''}

SOURCE UI FILES (${uiFiles.length} total):
${filesCtx}

Extract ALL screens and components from these files.
Use the EXACT class/widget names from the source — never invent names like "HomeScreen" unless it actually exists.

Return JSON:
{
  "screens": [{"id":"screen-login","name":"LoginScreen","path":"lib/features/auth/login_screen.dart","route":"/login","components":["EmailField","PasswordField","LoginButton"],"guards":[],"purpose":"User authentication","businessLogic":["Validate email format","Check password min 8 chars"],"apiCalls":["POST /auth/login"],"states":["loading","error","success"]}],
  "components": [{"id":"comp-emailfield","name":"EmailField","type":"ui","props":[{"name":"onChanged","type":"Function","required":true}],"children":[]}],
  "navigationFlow": [{"from":"screen-login","to":"screen-home","trigger":"onLoginSuccess","guard":""}],
  "stateFlow": []
}

RULES: Use REAL names from source. Max 15 screens, 20 components. ONLY valid JSON.`;

    try {
      const res = await this.ai.chat(
        [
          { role: 'system', content: this.MASTER_SYSTEM_PROMPT },
          { role: 'user',   content: prompt },
        ],
        Math.min(1400, maxTokens),
      );
      const data = this.tryParseJSON<IRDocument['uiGraph']>(res.content || '{}', fallback);
      data.screens = data.screens ?? []; data.components = data.components ?? [];
      data.navigationFlow = data.navigationFlow ?? []; data.stateFlow = data.stateFlow ?? [];
      console.log(`[IRGenerator] generateUIGraph: screens=${data.screens.length} components=${data.components.length} tokens=${res.tokensUsed}`);
      return { data, tokens: res.tokensUsed };
    } catch (err) {
      console.warn(`[IRGenerator] generateUIGraph FAILED: ${(err as Error).message}`);
      return { data: fallback, tokens: 0 };
    }
  }

  private async generateBackendGraph(
    ctx: ConversionContext, ast: ASTResult, _arch: ArchResult, maxTokens: number,
  ): Promise<{ data: IRDocument['backendGraph']; tokens: number }> {
    const beFiles = ast.files.filter((f) => /service|controller|router|route|handler|repository|repo/i.test(f.path));
    const fallback: IRDocument['backendGraph'] = { routes: [], services: [], entities: [], middlewares: [] };
    if (beFiles.length === 0) return { data: fallback, tokens: 0 };

    // ── PHASE 22: contexte enrichi ───────────────────────────────────────────
    const apiCtx  = ast.apiPatterns?.length > 0 ? `\nDetected API patterns: ${ast.apiPatterns.slice(0, 10).join(', ')}` : '';
    const authCtx = ast.authPatterns?.length > 0 ? `\nAuth patterns: ${ast.authPatterns.join(', ')}` : '';

    const filesCtx = beFiles.slice(0, 6).map((f) =>
      `FILE: ${f.path}\nCLASSES: ${f.classes.slice(0, 4).join(', ')}\nCONTENT:\n${f.content.slice(0, 200)}`
    ).join('\n---\n');

    const prompt = `Framework: ${ctx.sourceFramework} → Target: ${ctx.targetFramework}${apiCtx}${authCtx}

SOURCE BACKEND FILES (${beFiles.length} total):
${filesCtx}

Extract ALL routes, services, entities from these files.
Use REAL endpoint paths, REAL method names, REAL service names from source.
NEVER invent endpoints or service methods.

Return JSON:
{
  "routes": [{"method":"POST","path":"/api/auth/login","handler":"login","guards":["throttle"],"middlewares":["validateBody"]}],
  "services": [{"name":"AuthService","methods":[{"name":"login","params":[{"name":"dto","type":"LoginDto"}],"returnType":"AuthToken","async":true}],"dependencies":["UserRepository","JwtService"]}],
  "entities": [],
  "middlewares": []
}

Rules: Use REAL names. Max 10 routes, 8 services. ONLY valid JSON.`;

    try {
      const res = await this.ai.chat(
        [
          { role: 'system', content: this.MASTER_SYSTEM_PROMPT },
          { role: 'user',   content: prompt },
        ],
        Math.min(1200, maxTokens),
      );
      const data = this.tryParseJSON<IRDocument['backendGraph']>(res.content || '{}', fallback);
      data.routes = data.routes ?? []; data.services = data.services ?? [];
      data.entities = data.entities ?? []; data.middlewares = data.middlewares ?? [];
      console.log(`[IRGenerator] generateBackendGraph: routes=${data.routes.length} services=${data.services.length} tokens=${res.tokensUsed}`);
      return { data, tokens: res.tokensUsed };
    } catch (err) {
      console.warn(`[IRGenerator] generateBackendGraph FAILED: ${(err as Error).message}`);
      return { data: fallback, tokens: 0 };
    }
  }

  private async generateDataLayer(
    _ctx: ConversionContext, ast: ASTResult, maxTokens: number,
  ): Promise<{ data: IRDocument['dataLayer']; tokens: number }> {
    const dataFiles = ast.files.filter((f) => /model|entity|schema|migration/i.test(f.path));
    const fallback: IRDocument['dataLayer'] = { models: [], relationships: [], migrations: [] };
    if (dataFiles.length === 0) return { data: fallback, tokens: 0 };

    const filesCtx = dataFiles.slice(0, 4).map((f) => `${f.path}:${f.content.slice(0, 150)}`).join('\n---\n');
    const prompt = `Analyze data files → JSON dataLayer:\n{"models":[{"name":"User","table":"users","fields":[{"name":"id","type":"String","nullable":false,"unique":true,"primary":true}],"relations":[]}],"relationships":[],"migrations":[]}\n\nFiles:\n${filesCtx}\n\nMax 5 models. ONLY valid JSON.`;

    try {
      const res = await this.ai.chat([{ role: 'user', content: prompt }], Math.min(800, maxTokens));
      const data = this.tryParseJSON<IRDocument['dataLayer']>(res.content || '{}', fallback);
      data.models = data.models ?? []; data.relationships = data.relationships ?? []; data.migrations = data.migrations ?? [];
      console.log(`[IRGenerator] generateDataLayer: models=${data.models.length} tokens=${res.tokensUsed}`);
      return { data, tokens: res.tokensUsed };
    } catch (err) {
      console.warn(`[IRGenerator] generateDataLayer FAILED: ${(err as Error).message}`);
      return { data: fallback, tokens: 0 };
    }
  }

  private async generateDependencyMap(
    ctx: ConversionContext, ast: ASTResult,
  ): Promise<{ data: IRDocument['dependencyMap']; tokens: number }> {
    // Always use static map first — saves tokens
    const frameworkMap = FRAMEWORK_DEP_MAPS[`${ctx.sourceFramework}->${ctx.targetFramework}`];
    if (frameworkMap) return { data: frameworkMap, tokens: 0 };

    if (this.ai.getTier() === 'static') {
      return { data: { keep: [], replace: [], remove: [], add: [] }, tokens: 0 };
    }

    const allImports = [...new Set(ast.files.flatMap((f) => f.imports))];
    const prompt = `Converting ${ctx.sourceFramework} → ${ctx.targetFramework}.
Current deps: ${allImports.slice(0, 25).join(', ')}

Return JSON dependencyMap:
{"keep":[],"replace":[{"from":"","to":"","reason":""}],"remove":[],"add":[]}
Return ONLY valid JSON.`;

    try {
      const res = await this.ai.chat([{ role: 'user', content: prompt }], 600);
      const data = JSON.parse(res.content || '{}') as IRDocument['dependencyMap'];
      return { data, tokens: res.tokensUsed };
    } catch {
      return { data: { keep: [], replace: [], remove: [], add: [] }, tokens: 0 };
    }
  }
  // ── PHASE 22: Builders pour assets, envVars, externalConnections ─────────

  private buildAssets(ast: ASTResult): IRDocument['assets'] {
    const images  = ast.assetFiles.filter((p) => /\.(png|jpg|jpeg|gif|webp|svg|ico)$/i.test(p));
    const fonts   = ast.assetFiles.filter((p) => /\.(ttf|otf|woff|woff2)$/i.test(p));
    const icons   = ast.assetFiles.filter((p) => /icon|ic_/i.test(p));
    const other   = ast.assetFiles.filter((p) => !/\.(png|jpg|jpeg|gif|webp|svg|ico|ttf|otf|woff|woff2)$/i.test(p));

    return {
      images: images.map((p) => ({ name: p.split('/').pop() ?? p, path: p, type: 'image' })),
      fonts:  fonts.map((p)  => ({ name: p.split('/').pop() ?? p, path: p, type: 'font'  })),
      icons:  icons.map((p)  => ({ name: p.split('/').pop() ?? p, path: p, type: 'icon'  })),
      other:  other.map((p)  => ({ name: p.split('/').pop() ?? p, path: p, type: 'asset' })),
    };
  }

  private buildEnvVars(ast: ASTResult): IRDocument['envVars'] {
    return (ast.envVarKeys ?? []).map((key) => ({
      key,
      description: `Environment variable: ${key}`,
      required: true,
      example: key.toLowerCase().includes('url')
        ? 'https://api.example.com'
        : key.toLowerCase().includes('key') || key.toLowerCase().includes('secret')
          ? 'your-secret-key'
          : 'value',
    }));
  }

  private buildExternalConnections(ast: ASTResult): IRDocument['externalConnections'] {
    return (ast.externalServices ?? []).map((svc) => {
      const typeMap: Record<string, import('../models/ir.types').IRExternalConnection['type']> = {
        Firebase: 'firebase', Supabase: 'supabase', Appwrite: 'appwrite',
        GraphQL: 'graphql', WebSocket: 'websocket', gRPC: 'grpc',
        Axios: 'rest-api', Dio: 'rest-api', DartHttp: 'rest-api', FetchAPI: 'rest-api',
        PushNotifications: 'push-notification', Analytics: 'analytics',
        Maps: 'other',
      };
      return {
        name:     svc,
        type:     typeMap[svc] ?? 'other',
        authType: ['Firebase', 'Supabase', 'Appwrite'].includes(svc) ? 'api-key' : 'bearer',
      };
    });
  }
}
const FRAMEWORK_DEP_MAPS: Record<string, IRDocument['dependencyMap']> = {
  'Flutter->React': {
    keep:    [],
    replace: [
      { from: 'flutter',             to: 'react',               reason: 'Core UI framework' },
      { from: 'provider',            to: 'zustand',             reason: 'State management' },
      { from: 'go_router',           to: 'react-router-dom',    reason: 'Routing' },
      { from: 'dio',                 to: 'axios',               reason: 'HTTP client' },
      { from: 'shared_preferences',  to: 'localStorage',        reason: 'Local storage' },
    ],
    remove:  ['flutter_bloc', 'riverpod', 'get_it', 'hive', 'sqflite'],
    add:     ['react', 'react-dom', 'typescript', 'tailwindcss', 'react-router-dom', 'zustand', 'axios', '@tanstack/react-query'],
  },
  'Flutter->React Native': {
    keep:    [],
    replace: [
      { from: 'flutter',            to: 'react-native',                                  reason: 'Core UI framework' },
      { from: 'provider',           to: 'zustand',                                       reason: 'State management' },
      { from: 'go_router',          to: '@react-navigation/native',                      reason: 'Navigation' },
      { from: 'dio',                to: 'axios',                                         reason: 'HTTP client' },
      { from: 'shared_preferences', to: '@react-native-async-storage/async-storage',     reason: 'Local storage' },
    ],
    remove:  ['flutter_bloc', 'riverpod', 'get_it', 'hive'],
    add:     ['react-native', 'typescript', '@react-navigation/native', '@react-navigation/stack', 'zustand', 'axios', '@tanstack/react-query'],
  },
  'Express->NestJS': {
    keep:    ['pg', 'redis', 'bcryptjs', 'jsonwebtoken', 'zod', 'uuid'],
    replace: [
      { from: 'express',           to: '@nestjs/core,@nestjs/common,@nestjs/platform-express', reason: 'NestJS replaces Express' },
      { from: 'express-jwt',       to: '@nestjs/jwt,@nestjs/passport',                        reason: 'NestJS JWT auth' },
      { from: 'express-validator', to: 'class-validator,class-transformer',                   reason: 'NestJS validation' },
    ],
    remove:  ['express', 'express-jwt', 'express-validator', 'morgan'],
    add:     ['@nestjs/core', '@nestjs/common', '@nestjs/platform-express', '@nestjs/config', '@nestjs/swagger', '@nestjs/jwt', '@nestjs/passport', 'class-validator', 'class-transformer', 'reflect-metadata'],
  },
  'Node.js->NestJS': {
    keep:    ['pg', 'redis', 'bcryptjs', 'uuid', 'zod'],
    replace: [
      { from: 'node:http',      to: '@nestjs/platform-express', reason: 'NestJS HTTP adapter' },
      { from: 'jsonwebtoken',   to: '@nestjs/jwt',              reason: 'NestJS JWT module' },
    ],
    remove:  ['http', 'https', 'url'],
    add:     ['@nestjs/core', '@nestjs/common', '@nestjs/platform-express', '@nestjs/config', '@nestjs/swagger', 'class-validator', 'class-transformer', 'reflect-metadata'],
  },
};
