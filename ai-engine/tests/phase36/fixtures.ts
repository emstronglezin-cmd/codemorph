// ============================================================
// CodeMorph — PHASE 36: Test fixtures (AST/Context/FakeAI builders)
// ============================================================
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ASTFile, ASTResult } from '../../src/core/ast-analyzer';
import type { ArchResult } from '../../src/core/architecture-detector';
import type { ConversionContext } from '../../src/models/ir.types';
import type { SemanticAIProvider } from '../../src/core/phase36/types';

export function makeFile(
  path: string,
  content: string,
  overrides: Partial<ASTFile> = {},
): ASTFile {
  return {
    path,
    content,
    language: path.endsWith('.dart') ? 'dart' : 'typescript',
    imports: extractImports(content),
    exports: extractExports(content),
    classes: extractClasses(content),
    functions: extractFunctions(content),
    lines: content.split('\n').length,
    ...overrides,
  };
}

function extractImports(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/import\s+['"]([^'"]+)['"]/g)) out.push(m[1] ?? '');
  for (const m of content.matchAll(/import\s+'([^']+)'/g)) out.push(m[1] ?? '');
  return out.filter(Boolean);
}
function extractExports(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/export\s+(?:default\s+)?(?:class|const|function|interface|type)\s+(\w+)/g)) {
    out.push(m[1] ?? '');
  }
  return out.filter(Boolean);
}
function extractClasses(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/class\s+(\w+)/g)) out.push(m[1] ?? '');
  return out.filter(Boolean);
}
function extractFunctions(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/(?:void|Future<[^>]*>|String|int|bool|async)\s+(\w+)\s*\(/g)) out.push(m[1] ?? '');
  return out.filter((x): x is string => Boolean(x));
}

/** Construit un ASTResult minimal valide. */
export function buildAst(files: ASTFile[], overrides: Partial<ASTResult> = {}): ASTResult {
  return {
    files,
    imports: { internal: {}, external: {} },
    exports: files.flatMap((f) => f.exports),
    classNames: files.flatMap((f) => f.classes),
    functions: [],
    variables: [],
    tokensUsed: 0,
    language: 'dart',
    framework: 'flutter',
    statePatterns: ['Riverpod'],
    externalServices: ['Firebase'],
    authPatterns: ['JWT'],
    storagePatterns: ['SharedPreferences'],
    navigationPattern: 'go_router',
    apiPatterns: ['REST'],
    assetFiles: [],
    envVarKeys: ['API_BASE_URL'],
    projectDocs: [],
    cicdConfigs: [],
    testFiles: [],
    configFiles: [],
    scripts: [],
    dependencies: [],
    ...overrides,
  };
}

/** ArchResult minimal (statique). */
export function buildArch(files: ASTFile[]): ArchResult {
  return {
    pattern: 'feature-sliced',
    modules: [
      { name: 'features', path: 'lib/features', role: 'ui', files: files.map((f) => f.path) },
    ],
    layers: ['presentation', 'domain', 'data'],
    patterns: ['feature-first', 'riverpod'],
    entryPoints: [],
    hasRouter: true,
    hasDB: false,
    hasAPI: true,
    hasState: true,
    tokensUsed: 0,
  };
}

/** Assemble le sourceCode au format "// === FILE: path ===". */
export function buildSourceCode(files: ASTFile[]): string {
  return files
    .map((f) => `// === FILE: ${f.path} ===\n${f.content}`)
    .join('\n');
}

export function makeCtx(projectId: string, sourceCode: string): ConversionContext {
  return {
    jobId: `job-${projectId}`,
    projectId,
    sourceCode,
    sourceLanguage: 'dart',
    sourceFramework: 'Flutter',
    targetFramework: 'React Native',
    options: {
      preserveComments: true,
      generateTests: false,
      strictMode: true,
      addTypeAnnotations: true,
    },
  };
}

/** Répertoires temporaires isolés pour cache/état. */
export function freshDirs(): { cacheDir: string; stateDir: string } {
  return {
    cacheDir: mkdtempSync(join(tmpdir(), 'p36-cache-')),
    stateDir: mkdtempSync(join(tmpdir(), 'p36-state-')),
  };
}

// ── FakeAI : provider IA déterministe pour les tests ──────────────────────────
export interface FakeCall {
  messages: Array<{ role: string; content: string }>;
  maxTokens?: number;
}

type ResponseOrError = string | Error;

const pascal = (s: string): string =>
  s.split(/[^a-zA-Z0-9]+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');

/**
 * FakeAI extrait les chemins "SOURCE FILE: <path>" du prompt et produit une
 * ModuleIR JSON crédible : 1 écran par fichier screen, 1 modèle par fichier
 * model, 1 service par fichier service, relations screen→service.
 */
export class FakeAI implements SemanticAIProvider {
  calls: FakeCall[] = [];
  private queue: ResponseOrError[] = [];
  onChat?: (call: FakeCall) => string;

  enqueue(...responses: ResponseOrError[]): void {
    this.queue.push(...responses);
  }

  get callCount(): number {
    return this.calls.length;
  }

  async chat(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    maxTokens?: number,
  ): Promise<{ content: string; tokensUsed: number }> {
    this.calls.push({ messages, maxTokens });
    const next = this.queue.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'string') return { content: next, tokensUsed: 150 };
    if (this.onChat) return { content: this.onChat({ messages, maxTokens }), tokensUsed: 150 };
    return { content: FakeAI.defaultResponse(messages[messages.length - 1]?.content ?? ''), tokensUsed: 150 };
  }

  getModel(): string {
    return 'fake-model-p36';
  }

  /** Réponse par défaut : analyse plausible du contenu du prompt. */
  static defaultResponse(prompt: string): string {
    // Imports réels présents dans le code du prompt → relations réalistes
    const importedServices = [...prompt.matchAll(/import 'package:demo\/(services\/[^']+\.dart)';/g)].map((m) => m[1] ?? '');
    const importedModels   = [...prompt.matchAll(/import 'package:demo\/(models\/[^']+\.dart)';/g)].map((m) => m[1] ?? '');
    const paths = [...prompt.matchAll(/===== SOURCE FILE: (.+?)(?: \(part .*\))? =====/g)].map((m) => m[1] ?? '');
    const screens: unknown[] = [];
    const models: unknown[] = [];
    const services: unknown[] = [];
    const relations: unknown[] = [];
    const components: unknown[] = [];
    const stateFlow: unknown[] = [];

    for (const path of paths) {
      const base = (path.split('/').pop() ?? 'file').replace(/\.(dart|tsx?|jsx?)$/, '');
      if (/screen|page|view/i.test(path)) {
        const name = `${pascal(base)}`;
        screens.push({
          id: `screen-${base}`,
          name,
          path,
          route: `/${base.replace(/screen$|page$|view$/i, '')}`,
          components: ['AppBar', 'ListView'],
          purpose: `${name} purpose`,
          businessLogic: ['validate input'],
          apiCalls: ['POST /api/auth/login'],
          states: ['loading', 'error'],
        });
        for (const svc of importedServices) {
          const svcBase = (svc.split('/').pop() ?? '').replace(/\.dart$/, '');
          if (svcBase) relations.push({ from: name, to: pascal(svcBase), kind: 'uses' });
        }
        for (const mdl of importedModels) {
          const mdlBase = (mdl.split('/').pop() ?? '').replace(/\.dart$/, '');
          if (mdlBase) relations.push({ from: name, to: pascal(mdlBase), kind: 'uses' });
        }
      } else if (/model|entity/i.test(path)) {
        models.push({
          name: pascal(base),
          path,
          table: `${base.toLowerCase()}s`,
          fields: [
            { name: 'id', type: 'String', nullable: false, unique: true, primary: true },
            { name: 'name', type: 'String', nullable: false, unique: false, primary: false },
          ],
          relations: [],
        });
      } else if (/service|repository/i.test(path)) {
        services.push({
          name: `${pascal(base)}`,
          path,
          methods: [{ name: 'login', params: ['credentials'], returnType: 'AuthToken', async: true }],
          dependencies: [],
        });
      } else if (/bloc|store|provider|notifier/i.test(path)) {
        stateFlow.push({
          store: `${pascal(base)}`,
          path,
          type: 'riverpod',
          stateShape: '{ items: [] }',
          actions: ['fetch'],
        });
      } else if (/widget|component/i.test(path)) {
        components.push({
          id: `comp-${base}`,
          name: pascal(base),
          type: 'ui',
          path,
          props: [{ name: 'onTap', type: 'Function', required: false }],
          children: [],
        });
      }
    }

    return JSON.stringify({
      screens, components, navigationFlow: [], stateFlow, routes: [],
      services, models, apiCalls: [], envVars: [], relations,
      notes: [`analyzed ${paths.length} files`],
    });
  }
}
