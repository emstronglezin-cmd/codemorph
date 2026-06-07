// ============================================================
// CodeMorph AI Engine — Architecture Detector
// Detects patterns: MVC, Clean, Feature-sliced, Bloc, etc.
// Uses AIProvider — supports Free (Groq), Platform (OpenAI), Pro (user key)
// ============================================================
import { AIProvider } from './ai-provider';
import type { ConversionContext } from '../models/ir.types';
import type { ASTResult }        from './ast-analyzer';

export interface ArchResult {
  pattern:     'mvc' | 'clean' | 'feature-sliced' | 'bloc' | 'provider' | 'monolith' | 'layered' | 'unknown';
  layers:      string[];
  modules:     ArchModule[];
  patterns:    string[];
  hasRouter:   boolean;
  hasState:    boolean;
  hasAPI:      boolean;
  hasDB:       boolean;
  entryPoints: string[];
  tokensUsed:  number;
}

export interface ArchModule {
  name:   string;
  path:   string;
  role:   'ui' | 'business' | 'data' | 'infra' | 'shared';
  files:  string[];
}

export class ArchitectureDetector {
  private readonly ai: AIProvider;

  constructor(opts?: { userOpenAIKey?: string; userAnthropicKey?: string }) {
    this.ai = new AIProvider(opts);
  }

  async detect(ctx: ConversionContext, ast: ASTResult): Promise<ArchResult> {
    const staticResult = this.staticDetect(ast);
    const aiResult     = await this.aiDetect(ctx, ast);

    return {
      ...staticResult,
      ...aiResult,
      tokensUsed: aiResult.tokensUsed,
    };
  }

  private staticDetect(ast: ASTResult): Omit<ArchResult, 'pattern' | 'tokensUsed'> {
    const allPaths   = ast.files.map((f) => f.path);
    const allImports = ast.files.flatMap((f) => f.imports);

    // Detect layers by folder patterns
    const layers: string[] = [];
    if (allPaths.some((p) => /screen|page|view|widget/i.test(p)))         layers.push('ui');
    if (allPaths.some((p) => /service|usecase|interactor/i.test(p)))      layers.push('business');
    if (allPaths.some((p) => /repo|repository|datasource|store/i.test(p)))layers.push('data');
    if (allPaths.some((p) => /infra|adapter|gateway/i.test(p)))           layers.push('infra');
    if (allPaths.some((p) => /shared|common|util|helper/i.test(p)))       layers.push('shared');
    if (layers.length === 0) layers.push('monolith');

    // Detect patterns
    const patterns: string[] = [];
    if (ast.classNames.some((c) => /Bloc|Cubit/i.test(c)))                    patterns.push('BLoC');
    if (allImports.some((i) => /provider|riverpod/i.test(i)))                 patterns.push('Provider');
    if (ast.classNames.some((c) => /Controller/i.test(c)))                    patterns.push('MVC');
    if (ast.classNames.some((c) => /Repository/i.test(c)))                    patterns.push('Repository');
    if (ast.classNames.some((c) => /UseCase|Interactor/i.test(c)))            patterns.push('Clean Architecture');
    if (allImports.some((i) => /router|go_router|navigation/i.test(i)))       patterns.push('Router');
    if (allImports.some((i) => /redux|mobx|zustand/i.test(i)))                patterns.push('State Management');

    const hasRouter = allImports.some((i) => /router|navigation|go_router/i.test(i));
    const hasState  = patterns.some((p) => /bloc|provider|redux|mobx|state/i.test(p));
    const hasAPI    = allImports.some((i) => /http|dio|axios|fetch|apollo/i.test(i));
    const hasDB     = allImports.some((i) => /sqflite|hive|isar|typeorm|prisma|mongoose/i.test(i));

    const entryPoints = ast.files
      .filter((f) => /main\.|app\.|index\./i.test(f.path))
      .map((f) => f.path);

    const moduleMap = new Map<string, ArchModule>();
    for (const file of ast.files) {
      const parts  = file.path.split('/');
      const modKey = parts.length > 1 ? (parts[1] ?? parts[0] ?? 'root') : (parts[0] ?? 'root');
      if (!moduleMap.has(modKey)) {
        moduleMap.set(modKey, {
          name:  modKey,
          path:  parts.slice(0, 2).join('/'),
          role:  this.inferRole(modKey),
          files: [],
        });
      }
      moduleMap.get(modKey)!.files.push(file.path);
    }

    return { layers, modules: [...moduleMap.values()], patterns, hasRouter, hasState, hasAPI, hasDB, entryPoints };
  }

  private async aiDetect(
    ctx: ConversionContext,
    ast: ASTResult,
  ): Promise<{ pattern: ArchResult['pattern']; tokensUsed: number }> {
    // Static-only if no AI available
    if (this.ai.getTier() === 'static') {
      return { pattern: 'unknown', tokensUsed: 0 };
    }

    const limits = AIProvider.getLimits(this.ai.getTier());
    const prompt = `Analyze this ${ctx.sourceFramework} project and return JSON:\n{"pattern": "mvc|clean|feature-sliced|bloc|provider|monolith|layered|unknown"}\n\nClasses: ${ast.classNames.slice(0, 20).join(', ')}\nFiles: ${ast.files.map((f) => f.path).slice(0, 20).join(', ')}\nImports: ${[...new Set(ast.files.flatMap((f) => f.imports))].slice(0, 15).join(', ')}\n\nReturn ONLY valid JSON.`;

    try {
      const res = await this.ai.chat(
        [{ role: 'user', content: prompt }],
        Math.min(100, limits.maxTokens),
      );
      const data = JSON.parse(res.content || '{}') as { pattern?: ArchResult['pattern'] };
      return { pattern: data.pattern ?? 'unknown', tokensUsed: res.tokensUsed };
    } catch {
      return { pattern: 'unknown', tokensUsed: 0 };
    }
  }

  private inferRole(folderName: string): ArchModule['role'] {
    if (/screen|page|view|widget|component|ui/i.test(folderName)) return 'ui';
    if (/service|usecase|domain|business/i.test(folderName))      return 'business';
    if (/data|repo|store|model|entity/i.test(folderName))         return 'data';
    if (/infra|adapter|api|network/i.test(folderName))            return 'infra';
    return 'shared';
  }
}
