// ============================================================
// CodeMorph AI Engine — IR Generator
// AI outputs IR ONLY — never final code directly
// Uses AIProvider — supports Free (Groq), Platform (OpenAI), Pro (user key)
// ============================================================
import { AIProvider }  from './ai-provider';
import type { ConversionContext, IRDocument } from '../models/ir.types';
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

    const ir: IRDocument = {
      projectMeta:   this.buildProjectMeta(ctx, ast, arch),
      architecture:  this.buildArchitecture(arch),
      uiGraph:       uiGraph.data,
      backendGraph:  backendGraph.data,
      dataLayer:     dataLayer.data,
      dependencyMap: depMap.data,
      conversionPlan: this.buildConversionPlan(ctx, arch),
      validation:    this.buildValidation(ctx, ast, arch),
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

    // Final fallback
    if (screens.length === 0) {
      screens.push(
        { id: 'screen-home',     name: 'HomeScreen',     path: '',  route: '/',        components: [], guards: [] },
        { id: 'screen-profile',  name: 'ProfileScreen',  path: '',  route: '/profile', components: [], guards: [] },
      );
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
  private async generateUIGraph(
    ctx: ConversionContext, ast: ASTResult, _arch: ArchResult, maxTokens: number,
  ): Promise<{ data: IRDocument['uiGraph']; tokens: number }> {
    const uiFiles = ast.files.filter((f) => /screen|page|view|widget|component/i.test(f.path));
    const fallback: IRDocument['uiGraph'] = { screens: [], components: [], navigationFlow: [], stateFlow: [] };

    if (uiFiles.length === 0) {
      console.log(`[IRGenerator] generateUIGraph: no UI files in ${ast.files.length} total — returning empty`);
      return { data: fallback, tokens: 0 };
    }

    const filesCtx = uiFiles.slice(0, 6).map((f) => `${f.path}:${f.content.slice(0, 150)}`).join('\n---\n');
    const prompt = `Analyze ${ctx.sourceFramework} UI files. Return JSON only:\n{"screens":[{"id":"s1","name":"HomeScreen","path":"lib/home.dart","route":"/","components":[],"guards":[]}],"components":[{"id":"c1","name":"Btn","type":"ui","props":[],"children":[]}],"navigationFlow":[],"stateFlow":[]}\n\nFiles:\n${filesCtx}\n\nTarget: ${ctx.targetFramework}. Max 8 items per array. ONLY valid JSON.`;

    try {
      const res = await this.ai.chat([{ role: 'user', content: prompt }], Math.min(1200, maxTokens));
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
    const beFiles = ast.files.filter((f) => /service|controller|router|route|handler/i.test(f.path));
    const fallback: IRDocument['backendGraph'] = { routes: [], services: [], entities: [], middlewares: [] };
    if (beFiles.length === 0) return { data: fallback, tokens: 0 };

    const filesCtx = beFiles.slice(0, 5).map((f) => `${f.path}:${f.content.slice(0, 150)}`).join('\n---\n');
    const prompt = `Analyze ${ctx.sourceFramework} backend files → JSON backendGraph:\n{"routes":[{"method":"GET","path":"/users","handler":"getUsers","guards":[],"middlewares":[]}],"services":[{"name":"UserSvc","methods":[{"name":"findAll","params":[],"returnType":"User[]","async":true}],"dependencies":[]}],"entities":[],"middlewares":[]}\n\nFiles:\n${filesCtx}\n\nTarget: ${ctx.targetFramework}. Max 6 items. ONLY valid JSON.`;

    try {
      const res = await this.ai.chat([{ role: 'user', content: prompt }], Math.min(1200, maxTokens));
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
}

// ── Static dependency maps for known conversions ─────────────────────────────
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
