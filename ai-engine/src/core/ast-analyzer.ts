// ============================================================
// CodeMorph AI Engine — AST Analyzer
// Analyzes source code structure using AI + static analysis
// ============================================================
import OpenAI from 'openai';
import { appConfig } from '../config/app.config';
import type { ConversionContext } from '../models/ir.types';

export interface ASTResult {
  files:        ASTFile[];
  imports:      ImportGraph;
  exports:      string[];
  classNames:   string[];
  functions:    FunctionSignature[];
  variables:    string[];
  tokensUsed:   number;
  language:     string;
  framework:    string;
}

export interface ASTFile {
  path:      string;
  content:   string;
  language:  string;
  imports:   string[];
  exports:   string[];
  classes:   string[];
  functions: string[];
  lines:     number;
}

export interface ImportGraph {
  internal: Record<string, string[]>;
  external: Record<string, string[]>;
}

export interface FunctionSignature {
  name:       string;
  params:     string[];
  returnType: string;
  async:      boolean;
  file:       string;
}

export class ASTAnalyzer {
  private readonly openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({ apiKey: appConfig.openaiApiKey });
  }

  async analyze(ctx: ConversionContext): Promise<ASTResult> {
    const { sourceCode, sourceFramework } = ctx;

    // Split source into virtual files (if multi-file)
    const files = this.parseVirtualFiles(sourceCode);

    // Build import graph
    const imports = this.buildImportGraph(files);

    // AI-enhanced analysis for complex patterns
    const aiAnalysis = await this.runAIAnalysis(ctx, files);

    return {
      files,
      imports,
      exports:     aiAnalysis.exports,
      classNames:  aiAnalysis.classNames,
      functions:   aiAnalysis.functions,
      variables:   aiAnalysis.variables,
      tokensUsed:  aiAnalysis.tokensUsed,
      language:    this.detectLanguage(sourceCode, sourceFramework),
      framework:   sourceFramework,
    };
  }

  private parseVirtualFiles(sourceCode: string): ASTFile[] {
    // Handle multi-file format: "// FILE: path/to/file.dart\n<content>"
    const filePattern = /\/\/\s*FILE:\s*(.+?)\n([\s\S]*?)(?=\/\/\s*FILE:|$)/g;
    const files: ASTFile[] = [];
    let match: RegExpExecArray | null;

    while ((match = filePattern.exec(sourceCode)) !== null) {
      const path    = (match[1] ?? '').trim();
      const content = (match[2] ?? '').trim();
      const lang    = this.langFromPath(path);

      files.push({
        path,
        content,
        language:  lang,
        imports:   this.extractImports(content, lang),
        exports:   this.extractExports(content, lang),
        classes:   this.extractClasses(content),
        functions: this.extractFunctions(content),
        lines:     content.split('\n').length,
      });
    }

    // Single file fallback
    if (files.length === 0) {
      const lang = this.detectLanguage(sourceCode, '');
      files.push({
        path:      `main.${lang}`,
        content:   sourceCode,
        language:  lang,
        imports:   this.extractImports(sourceCode, lang),
        exports:   this.extractExports(sourceCode, lang),
        classes:   this.extractClasses(sourceCode),
        functions: this.extractFunctions(sourceCode),
        lines:     sourceCode.split('\n').length,
      });
    }

    return files;
  }

  private buildImportGraph(files: ASTFile[]): ImportGraph {
    const internal: Record<string, string[]> = {};
    const external: Record<string, string[]> = {};

    for (const file of files) {
      const filePaths = files.map((f) => f.path);
      internal[file.path] = file.imports.filter((imp) =>
        filePaths.some((p) => p.includes(imp.replace('./', '').replace('../', '')))
      );
      external[file.path] = file.imports.filter((imp) => !imp.startsWith('.'));
    }

    return { internal, external };
  }

  private async runAIAnalysis(
    ctx: ConversionContext,
    files: ASTFile[],
  ): Promise<{
    exports:    string[];
    classNames: string[];
    functions:  FunctionSignature[];
    variables:  string[];
    tokensUsed: number;
  }> {
    const prompt = `You are a senior code analyzer. Analyze this ${ctx.sourceFramework} codebase and return a JSON object with:
- exports: array of exported symbol names
- classNames: array of all class names
- functions: array of {name, params[], returnType, async, file}
- variables: array of global/module-level variable names

Source code summary (${files.length} files, ${files.reduce((a, f) => a + f.lines, 0)} lines):
${files.slice(0, 3).map((f) => `FILE: ${f.path}\n${f.content.slice(0, 500)}`).join('\n---\n')}

Return ONLY valid JSON, no markdown.`;

    try {
      const response = await this.openai.chat.completions.create({
        model:       appConfig.defaultModel,
        temperature: 0.1,
        max_tokens:  1000,
        messages:    [{ role: 'user', content: prompt }],
      });

      const content = response.choices[0]?.message?.content ?? '{}';
      const data    = JSON.parse(content) as {
        exports?: string[];
        classNames?: string[];
        functions?: FunctionSignature[];
        variables?: string[];
      };

      return {
        exports:    data.exports    ?? [],
        classNames: data.classNames ?? [],
        functions:  data.functions  ?? [],
        variables:  data.variables  ?? [],
        tokensUsed: response.usage?.total_tokens ?? 0,
      };
    } catch {
      return { exports: [], classNames: [], functions: [], variables: [], tokensUsed: 0 };
    }
  }

  private detectLanguage(code: string, framework: string): string {
    if (framework.toLowerCase().includes('flutter') || code.includes('import \'package:flutter')) return 'dart';
    if (code.includes('import express') || code.includes('require(\'express\')')) return 'javascript';
    if (code.includes('@Module') || code.includes('@Controller')) return 'typescript';
    if (code.includes('import React') || code.includes('from \'react\'')) return 'typescript';
    return 'typescript';
  }

  private langFromPath(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = { dart: 'dart', ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript' };
    return map[ext] ?? 'typescript';
  }

  private extractImports(code: string, lang: string): string[] {
    const patterns: string[] = [];
    if (lang === 'dart') {
      const m = code.match(/import\s+'(.+?)'/g) ?? [];
      patterns.push(...m.map((s) => s.replace(/import\s+'|'/g, '')));
    } else {
      const m1 = code.match(/import\s+.*?from\s+['"](.+?)['"]/g) ?? [];
      const m2 = code.match(/require\(['"](.+?)['"]\)/g) ?? [];
      patterns.push(...m1.map((s) => s.match(/['"](.+?)['"]/)?.[1] ?? ''));
      patterns.push(...m2.map((s) => s.match(/['"](.+?)['"]/)?.[1] ?? ''));
    }
    return [...new Set(patterns.filter(Boolean))];
  }

  private extractExports(code: string, _lang: string): string[] {
    const m = code.match(/export\s+(?:default\s+)?(?:class|function|const|let|var)\s+(\w+)/g) ?? [];
    return m.map((s) => s.match(/\s(\w+)$/)?.[1] ?? '').filter(Boolean);
  }

  private extractClasses(code: string): string[] {
    const m = code.match(/class\s+(\w+)/g) ?? [];
    return m.map((s) => s.replace('class ', ''));
  }

  private extractFunctions(code: string): string[] {
    const m = code.match(/(?:function\s+(\w+)|(?:async\s+)?(\w+)\s*[:=]\s*(?:async\s*)?\()/g) ?? [];
    return m.map((s) => s.trim()).filter(Boolean);
  }
}
