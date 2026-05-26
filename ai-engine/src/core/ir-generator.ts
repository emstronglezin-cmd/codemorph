// ============================================================
// CodeMorph AI Engine — IR Generator
// AI outputs IR ONLY — never final code directly
// ============================================================
import OpenAI from 'openai';
import { appConfig } from '../config/app.config';
import type { ConversionContext, IRDocument } from '../models/ir.types';
import type { ASTResult } from './ast-analyzer';
import type { ArchResult } from './architecture-detector';

export interface IRGenerationResult {
  ir:         IRDocument;
  tokensUsed: number;
}

export class IRGenerator {
  private readonly openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({ apiKey: appConfig.openaiApiKey });
  }

  async generate(
    ctx: ConversionContext,
    ast: ASTResult,
    arch: ArchResult,
  ): Promise<IRGenerationResult> {
    const [uiGraph, backendGraph, dataLayer, depMap] = await Promise.all([
      this.generateUIGraph(ctx, ast, arch),
      this.generateBackendGraph(ctx, ast, arch),
      this.generateDataLayer(ctx, ast),
      this.generateDependencyMap(ctx, ast),
    ]);

    let totalTokens = uiGraph.tokens + backendGraph.tokens + dataLayer.tokens + depMap.tokens;

    const projectMeta = this.buildProjectMeta(ctx, ast, arch);
    const architecture = this.buildArchitecture(arch);
    const conversionPlan = this.buildConversionPlan(ctx, arch);
    const validation = this.buildValidation(ctx, ast, arch);

    const ir: IRDocument = {
      projectMeta,
      architecture,
      uiGraph:       uiGraph.data,
      backendGraph:  backendGraph.data,
      dataLayer:     dataLayer.data,
      dependencyMap: depMap.data,
      conversionPlan,
      validation,
    };

    return { ir, tokensUsed: totalTokens };
  }

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
      { step: 1, phase: 'parse',    action: 'Parse source AST',             target: 'source',         estimatedTime: '5s' },
      { step: 2, phase: 'analyze',  action: 'Detect architecture patterns',  target: 'architecture',   estimatedTime: '10s' },
      { step: 3, phase: 'analyze',  action: 'Map UI components',             target: 'uiGraph',        estimatedTime: '15s', dependencies: [2] },
      { step: 4, phase: 'map',      action: 'Map dependencies',              target: 'dependencyMap',  estimatedTime: '5s' },
      { step: 5, phase: 'generate', action: `Generate ${ctx.targetFramework} structure`, target: 'output', estimatedTime: '30s', dependencies: [3, 4] },
      { step: 6, phase: 'validate', action: 'Validate IR completeness',      target: 'ir',             estimatedTime: '5s', dependencies: [5] },
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
      : warnings.length > 3 ? 'high'
      : warnings.length > 0 ? 'medium' : 'low';

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
    score += arch.hasRouter ? 5  : 0;
    return Math.min(100, score);
  }

  // ── UI Graph generation ────────────────────────────────
  private async generateUIGraph(ctx: ConversionContext, ast: ASTResult, _arch: ArchResult): Promise<{ data: IRDocument['uiGraph']; tokens: number }> {
    const uiFiles = ast.files.filter((f) => /screen|page|view|widget|component/i.test(f.path));
    if (uiFiles.length === 0) return { data: { screens: [], components: [], navigationFlow: [], stateFlow: [] }, tokens: 0 };

    const prompt = `You are a UI architect. Analyze these ${ctx.sourceFramework} UI files and generate a JSON uiGraph with:
{
  "screens": [{"id":"","name":"","path":"","route":"","components":[],"guards":[]}],
  "components": [{"id":"","name":"","type":"page|layout|feature|ui|shared|widget","props":[],"children":[]}],
  "navigationFlow": [{"from":"","to":"","trigger":"","guard":""}],
  "stateFlow": [{"store":"","actions":[],"selectors":[],"effects":[]}]
}

UI Files:
${uiFiles.slice(0, 10).map((f) => `${f.path}:\n${f.content.slice(0, 300)}`).join('\n---\n')}

Target: ${ctx.targetFramework}. Return ONLY valid JSON.`;

    try {
      const res = await this.openai.chat.completions.create({
        model: appConfig.defaultModel, temperature: 0.2, max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      });
      const data = JSON.parse(res.choices[0]?.message?.content ?? '{}') as IRDocument['uiGraph'];
      return { data, tokens: res.usage?.total_tokens ?? 0 };
    } catch {
      return { data: { screens: [], components: [], navigationFlow: [], stateFlow: [] }, tokens: 0 };
    }
  }

  // ── Backend Graph generation ────────────────────────────
  private async generateBackendGraph(ctx: ConversionContext, ast: ASTResult, _arch: ArchResult): Promise<{ data: IRDocument['backendGraph']; tokens: number }> {
    const beFiles = ast.files.filter((f) => /service|controller|router|route|handler/i.test(f.path));
    if (beFiles.length === 0) return { data: { routes: [], services: [], entities: [], middlewares: [] }, tokens: 0 };

    const prompt = `You are a backend architect. Analyze these ${ctx.sourceFramework} files and generate JSON backendGraph:
{
  "routes": [{"method":"GET|POST|PUT|PATCH|DELETE","path":"","handler":"","guards":[],"middlewares":[]}],
  "services": [{"name":"","methods":[{"name":"","params":[],"returnType":"","async":true}],"dependencies":[]}],
  "entities": [{"name":"","table":"","fields":[{"name":"","type":"","nullable":false,"unique":false,"primary":false}],"relations":[]}],
  "middlewares": [{"name":"","scope":"global|module|route","type":"auth|logging|validation|rate-limit|cors|custom"}]
}

Backend Files:
${beFiles.slice(0, 8).map((f) => `${f.path}:\n${f.content.slice(0, 400)}`).join('\n---\n')}

Target: ${ctx.targetFramework}. Return ONLY valid JSON.`;

    try {
      const res = await this.openai.chat.completions.create({
        model: appConfig.defaultModel, temperature: 0.2, max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      });
      const data = JSON.parse(res.choices[0]?.message?.content ?? '{}') as IRDocument['backendGraph'];
      return { data, tokens: res.usage?.total_tokens ?? 0 };
    } catch {
      return { data: { routes: [], services: [], entities: [], middlewares: [] }, tokens: 0 };
    }
  }

  // ── Data Layer generation ───────────────────────────────
  private async generateDataLayer(_ctx: ConversionContext, ast: ASTResult): Promise<{ data: IRDocument['dataLayer']; tokens: number }> {
    const dataFiles = ast.files.filter((f) => /model|entity|schema|migration/i.test(f.path));
    if (dataFiles.length === 0) return { data: { models: [], relationships: [], migrations: [] }, tokens: 0 };

    const prompt = `Analyze these data model files and return JSON dataLayer:
{
  "models": [{"name":"","table":"","fields":[{"name":"","type":"","nullable":false,"unique":false,"primary":false}],"relations":[]}],
  "relationships": [{"type":"oneToOne|oneToMany|manyToMany|manyToOne","target":"","field":""}],
  "migrations": [{"name":"","description":"","order":1}]
}

Files:
${dataFiles.slice(0, 6).map((f) => `${f.path}:\n${f.content.slice(0, 400)}`).join('\n---\n')}

Return ONLY valid JSON.`;

    try {
      const res = await this.openai.chat.completions.create({
        model: appConfig.defaultModel, temperature: 0.1, max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      });
      const data = JSON.parse(res.choices[0]?.message?.content ?? '{}') as IRDocument['dataLayer'];
      return { data, tokens: res.usage?.total_tokens ?? 0 };
    } catch {
      return { data: { models: [], relationships: [], migrations: [] }, tokens: 0 };
    }
  }

  // ── Dependency Map generation ───────────────────────────
  private async generateDependencyMap(ctx: ConversionContext, ast: ASTResult): Promise<{ data: IRDocument['dependencyMap']; tokens: number }> {
    const allImports = [...new Set(ast.files.flatMap((f) => f.imports))];
    const frameworkMap = FRAMEWORK_DEP_MAPS[`${ctx.sourceFramework}->${ctx.targetFramework}`];
    if (frameworkMap) return { data: frameworkMap, tokens: 0 };

    const prompt = `You are converting from ${ctx.sourceFramework} to ${ctx.targetFramework}.
These are the current dependencies: ${allImports.slice(0, 30).join(', ')}

Return a JSON dependencyMap:
{
  "keep": ["dep1"],
  "replace": [{"from":"old-dep","to":"new-dep","reason":"why"}],
  "remove": ["dep-to-remove"],
  "add": ["new-dep-needed"]
}
Return ONLY valid JSON.`;

    try {
      const res = await this.openai.chat.completions.create({
        model: appConfig.defaultModel, temperature: 0.1, max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      });
      const data = JSON.parse(res.choices[0]?.message?.content ?? '{}') as IRDocument['dependencyMap'];
      return { data, tokens: res.usage?.total_tokens ?? 0 };
    } catch {
      return { data: { keep: [], replace: [], remove: [], add: [] }, tokens: 0 };
    }
  }
}

// ── Static dependency maps for known conversions ─────────
const FRAMEWORK_DEP_MAPS: Record<string, IRDocument['dependencyMap']> = {
  'Flutter->React': {
    keep:    [],
    replace: [
      { from: 'flutter', to: 'react', reason: 'Core UI framework' },
      { from: 'provider', to: 'zustand', reason: 'State management' },
      { from: 'go_router', to: 'react-router-dom', reason: 'Routing' },
      { from: 'dio', to: 'axios', reason: 'HTTP client' },
      { from: 'shared_preferences', to: 'localStorage', reason: 'Local storage' },
    ],
    remove:  ['flutter_bloc', 'riverpod', 'get_it', 'hive', 'sqflite'],
    add:     ['react', 'react-dom', 'typescript', 'tailwindcss', 'react-router-dom', 'zustand', 'axios', '@tanstack/react-query'],
  },
  'Flutter->React Native': {
    keep:    [],
    replace: [
      { from: 'flutter', to: 'react-native', reason: 'Core UI framework' },
      { from: 'provider', to: 'zustand', reason: 'State management' },
      { from: 'go_router', to: '@react-navigation/native', reason: 'Navigation' },
      { from: 'dio', to: 'axios', reason: 'HTTP client' },
      { from: 'shared_preferences', to: '@react-native-async-storage/async-storage', reason: 'Local storage' },
    ],
    remove:  ['flutter_bloc', 'riverpod', 'get_it', 'hive'],
    add:     ['react-native', 'typescript', '@react-navigation/native', '@react-navigation/stack', 'zustand', 'axios', 'react-query'],
  },
  'Express->NestJS': {
    keep:    ['pg', 'redis', 'bcryptjs', 'jsonwebtoken', 'zod', 'uuid'],
    replace: [
      { from: 'express', to: '@nestjs/core,@nestjs/common,@nestjs/platform-express', reason: 'NestJS replaces Express' },
      { from: 'express-jwt', to: '@nestjs/jwt,@nestjs/passport', reason: 'NestJS JWT auth' },
      { from: 'express-validator', to: 'class-validator,class-transformer', reason: 'NestJS validation' },
    ],
    remove:  ['express', 'express-jwt', 'express-validator', 'morgan'],
    add:     ['@nestjs/core', '@nestjs/common', '@nestjs/platform-express', '@nestjs/config', '@nestjs/swagger', '@nestjs/jwt', '@nestjs/passport', 'class-validator', 'class-transformer', 'reflect-metadata'],
  },
  'Node.js->NestJS': {
    keep:    ['pg', 'redis', 'bcryptjs', 'uuid', 'zod'],
    replace: [
      { from: 'node:http', to: '@nestjs/platform-express', reason: 'NestJS HTTP adapter' },
      { from: 'jsonwebtoken', to: '@nestjs/jwt', reason: 'NestJS JWT module' },
    ],
    remove:  ['http', 'https', 'url'],
    add:     ['@nestjs/core', '@nestjs/common', '@nestjs/platform-express', '@nestjs/config', '@nestjs/swagger', 'class-validator', 'class-transformer', 'reflect-metadata'],
  },
};
