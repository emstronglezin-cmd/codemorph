// ============================================================
// CodeMorph AI Engine — Code Planner
// Transforms IR into a concrete file generation plan
// AI outputs IR → backend generates actual code files
// ============================================================
import OpenAI from 'openai';
import { appConfig } from '../config/app.config';
import type { ConversionContext, IRDocument, GeneratedFile, ConversionSummary } from '../models/ir.types';

export interface CodePlan {
  files:   GeneratedFile[];
  summary: ConversionSummary;
}

export class CodePlanner {
  private readonly openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({ apiKey: appConfig.openaiApiKey });
  }

  async plan(ctx: ConversionContext, ir: IRDocument): Promise<CodePlan> {
    const planner = this.getFrameworkPlanner(ctx.targetFramework);
    return planner(ctx, ir);
  }

  private getFrameworkPlanner(target: string): (ctx: ConversionContext, ir: IRDocument) => Promise<CodePlan> {
    const planners: Record<string, (ctx: ConversionContext, ir: IRDocument) => Promise<CodePlan>> = {
      'React':         this.planReact.bind(this),
      'React Native':  this.planReactNative.bind(this),
      'NestJS':        this.planNestJS.bind(this),
    };
    return planners[target] ?? this.planGeneric.bind(this);
  }

  // ── React planner ─────────────────────────────────────
  private async planReact(ctx: ConversionContext, ir: IRDocument): Promise<CodePlan> {
    const files: GeneratedFile[] = [];

    // Project structure files
    files.push(
      this.staticFile('package.json',       this.reactPackageJson(ctx.projectId)),
      this.staticFile('tsconfig.json',      REACT_TSCONFIG),
      this.staticFile('tailwind.config.ts', TAILWIND_CONFIG),
      this.staticFile('vite.config.ts',     VITE_CONFIG),
      this.staticFile('src/main.tsx',       REACT_MAIN),
      this.staticFile('src/App.tsx',        REACT_APP),
      this.staticFile('src/styles/globals.css', GLOBALS_CSS),
      this.staticFile('src/lib/api.ts',     API_CLIENT),
    );

    // Generate screens from IR
    for (const screen of ir.uiGraph.screens) {
      const content = await this.generateScreenFile(ctx, ir, screen.name, screen.components, 'react');
      files.push({
        path:     `src/pages/${screen.name}.tsx`,
        content,
        language: 'typescript',
        fromPath: screen.path,
        warnings: [],
      });
    }

    // Generate components from IR
    for (const comp of ir.uiGraph.components.filter((c) => c.type === 'ui' || c.type === 'shared')) {
      const content = await this.generateComponentFile(ctx, comp.name, comp.props ?? [], 'react');
      files.push({
        path:     `src/components/${comp.name}.tsx`,
        content,
        language: 'typescript',
        warnings: [],
      });
    }

    // State stores from IR
    for (const sf of ir.uiGraph.stateFlow) {
      files.push({
        path:     `src/stores/${sf.store.toLowerCase()}.store.ts`,
        content:  this.generateZustandStore(sf.store, sf.actions),
        language: 'typescript',
        warnings: [],
      });
    }

    // Router
    if (ir.uiGraph.screens.length > 0) {
      files.push({
        path:    'src/router/index.tsx',
        content: this.generateReactRouter(ir.uiGraph.screens),
        language: 'typescript',
        warnings: [],
      });
    }

    return { files, summary: this.buildSummary(files, ir) };
  }

  // ── React Native planner ──────────────────────────────
  private async planReactNative(ctx: ConversionContext, ir: IRDocument): Promise<CodePlan> {
    const files: GeneratedFile[] = [];

    files.push(
      this.staticFile('package.json',          this.rnPackageJson(ctx.projectId)),
      this.staticFile('tsconfig.json',         RN_TSCONFIG),
      this.staticFile('app/(tabs)/_layout.tsx', RN_TAB_LAYOUT),
      this.staticFile('app/index.tsx',         RN_INDEX),
    );

    for (const screen of ir.uiGraph.screens) {
      const content = await this.generateScreenFile(ctx, ir, screen.name, screen.components, 'react-native');
      files.push({
        path:     `app/${screen.name.toLowerCase()}.tsx`,
        content,
        language: 'typescript',
        fromPath: screen.path,
        warnings: [],
      });
    }

    return { files, summary: this.buildSummary(files, ir) };
  }

  // ── NestJS planner ────────────────────────────────────
  private async planNestJS(ctx: ConversionContext, ir: IRDocument): Promise<CodePlan> {
    const files: GeneratedFile[] = [];

    files.push(
      this.staticFile('package.json',          this.nestPackageJson(ctx.projectId)),
      this.staticFile('tsconfig.json',         NEST_TSCONFIG),
      this.staticFile('src/main.ts',           NEST_MAIN),
      this.staticFile('src/app.module.ts',     NEST_APP_MODULE),
    );

    // Generate modules from IR architecture
    for (const mod of ir.architecture.modules.filter((m) => m.type === 'feature')) {
      const modName = mod.name.toLowerCase();
      files.push(
        { path: `src/modules/${modName}/${modName}.module.ts`,     content: this.generateNestModule(mod.name),     language: 'typescript', warnings: [] },
        { path: `src/modules/${modName}/${modName}.controller.ts`, content: this.generateNestController(mod.name, ir.backendGraph.routes.filter((r) => r.path.includes(modName))), language: 'typescript', warnings: [] },
        { path: `src/modules/${modName}/${modName}.service.ts`,    content: this.generateNestService(mod.name, ir.backendGraph.services.find((s) => s.name.toLowerCase().includes(modName))), language: 'typescript', warnings: [] },
      );
    }

    // Generate entities from IR
    for (const entity of ir.dataLayer.models) {
      files.push({
        path:     `src/entities/${entity.name.toLowerCase()}.entity.ts`,
        content:  this.generateTypeORMEntity(entity),
        language: 'typescript',
        warnings: [],
      });
    }

    // Migrations
    for (const migration of ir.dataLayer.migrations) {
      files.push({
        path:     `src/database/migrations/${String(migration.order).padStart(4, '0')}_${migration.name}.ts`,
        content:  this.generateMigration(migration),
        language: 'typescript',
        warnings: [],
      });
    }

    return { files, summary: this.buildSummary(files, ir) };
  }

  // ── Generic fallback ──────────────────────────────────
  private async planGeneric(_ctx: ConversionContext, ir: IRDocument): Promise<CodePlan> {
    const files: GeneratedFile[] = [
      this.staticFile('README.md', `# Converted Project\n\nIR-based conversion completed.\n\n## Architecture\n${ir.architecture.patterns.join(', ')}`),
    ];
    return { files, summary: this.buildSummary(files, ir) };
  }

  // ── AI-powered file generators ────────────────────────
  private async generateScreenFile(ctx: ConversionContext, _ir: IRDocument, name: string, components: string[], framework: string): Promise<string> {
    const prompt = `Generate a ${framework === 'react' ? 'React + TypeScript + TailwindCSS' : 'React Native + TypeScript'} screen component named "${name}".
Components to include: ${components.join(', ')}.
Requirements: TypeScript strict, clean code, proper imports, no placeholder comments.
Return ONLY the file content, no markdown.`;

    try {
      const res = await this.openai.chat.completions.create({
        model: appConfig.defaultModel, temperature: 0.3, max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
      });
      return res.choices[0]?.message?.content ?? this.fallbackScreen(name, framework);
    } catch {
      return this.fallbackScreen(name, framework);
    }
  }

  private async generateComponentFile(ctx: ConversionContext, name: string, props: Array<{ name: string; type: string; required: boolean }>, framework: string): Promise<string> {
    const propTypes = props.map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type}`).join('; ');
    const prompt = `Generate a ${framework === 'react' ? 'React + TypeScript + TailwindCSS' : 'React Native + TypeScript'} UI component named "${name}".
Props interface: { ${propTypes} }
Requirements: TypeScript strict, accessible, reusable. Return ONLY the file content.`;

    try {
      const res = await this.openai.chat.completions.create({
        model: appConfig.defaultModel, temperature: 0.3, max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      });
      return res.choices[0]?.message?.content ?? this.fallbackComponent(name);
    } catch {
      return this.fallbackComponent(name);
    }
  }

  // ── Static generators (no AI) ─────────────────────────
  private generateZustandStore(name: string, actions: string[]): string {
    const actionsCode = actions.map((a) => `  ${a}: () => set((state) => ({ /* TODO */ })),`).join('\n');
    return `import { create } from 'zustand';

interface ${name}State {
  // TODO: define state shape from IR
  [key: string]: unknown;
  ${actions.map((a) => `${a}: () => void`).join(';\n  ')};
}

export const use${name}Store = create<${name}State>((set) => ({
${actionsCode}
}));
`;
  }

  private generateReactRouter(screens: IRDocument['uiGraph']['screens']): string {
    const routes = screens.map((s) => `  { path: '${s.route ?? `/${s.name.toLowerCase()}`}', element: <${s.name} /> },`).join('\n');
    const imports = screens.map((s) => `import { ${s.name} } from '../pages/${s.name}';`).join('\n');
    return `import { createBrowserRouter } from 'react-router-dom';
${imports}

export const router = createBrowserRouter([
${routes}
]);
`;
  }

  private generateNestModule(name: string): string {
    const n = this.pascal(name);
    return `import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ${n}Controller } from './${name.toLowerCase()}.controller';
import { ${n}Service } from './${name.toLowerCase()}.service';

@Module({
  imports: [TypeOrmModule.forFeature([/* entities */])],
  controllers: [${n}Controller],
  providers: [${n}Service],
  exports: [${n}Service],
})
export class ${n}Module {}
`;
  }

  private generateNestController(name: string, routes: IRDocument['backendGraph']['routes']): string {
    const n = this.pascal(name);
    const methods = routes.map((r) => {
      const decorator = `@${this.methodDecorator(r.method)}('${r.path.replace(`/${name.toLowerCase()}`, '')}')`;
      return `  ${decorator}\n  async ${r.handler}(): Promise<unknown> {\n    return this.${name.toLowerCase()}Service.${r.handler}();\n  }`;
    }).join('\n\n');

    return `import { Controller, Get, Post, Put, Patch, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ${n}Service } from './${name.toLowerCase()}.service';

@ApiTags('${name.toLowerCase()}')
@Controller('${name.toLowerCase()}')
export class ${n}Controller {
  constructor(private readonly ${name.toLowerCase()}Service: ${n}Service) {}

${methods || `  @Get()\n  async findAll(): Promise<unknown[]> {\n    return this.${name.toLowerCase()}Service.findAll();\n  }`}
}
`;
  }

  private generateNestService(name: string, svc?: IRDocument['backendGraph']['services'][0]): string {
    const n = this.pascal(name);
    const methods = svc?.methods.map((m) => `  ${m.async ? 'async ' : ''}${m.name}(${m.params.map((p) => `${p.name}: ${p.type}`).join(', ')}): Promise<${m.returnType}> {\n    // TODO: implement\n    throw new Error('Not implemented');\n  }`).join('\n\n') ?? `  async findAll(): Promise<unknown[]> {\n    return [];\n  }`;
    return `import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

@Injectable()
export class ${n}Service {
${methods}
}
`;
  }

  private generateTypeORMEntity(entity: IRDocument['dataLayer']['models'][0]): string {
    const cols = entity.fields.map((f) => {
      const decorators: string[] = [];
      if (f.primary) decorators.push('  @PrimaryGeneratedColumn(\'uuid\')');
      else { const opts = [f.nullable ? 'nullable: true' : '', f.unique ? 'unique: true' : ''].filter(Boolean).join(', '); decorators.push(`  @Column(${opts ? `{ ${opts} }` : ''})`); }
      return `${decorators.join('\n')}\n  ${f.name}!: ${this.dartTypeToTS(f.type)};`;
    }).join('\n\n');

    return `import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('${entity.table ?? entity.name.toLowerCase()}s')
export class ${entity.name}Entity {
${cols}

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
`;
  }

  private generateMigration(migration: IRDocument['dataLayer']['migrations'][0]): string {
    return `import { MigrationInterface, QueryRunner } from 'typeorm';

export class ${this.pascal(migration.name)}${Date.now()} implements MigrationInterface {
  name = '${migration.name}-${Date.now()}';

  async up(queryRunner: QueryRunner): Promise<void> {
    // ${migration.description}
    ${migration.sql ?? '// TODO: add SQL'}
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse of: ${migration.description}
  }
}
`;
  }

  // ── Fallbacks ─────────────────────────────────────────
  private fallbackScreen(name: string, framework: string): string {
    if (framework === 'react') {
      return `import React from 'react';\n\nexport function ${name}(): React.JSX.Element {\n  return (\n    <div className="flex min-h-screen items-center justify-center">\n      <h1 className="text-2xl font-bold">${name}</h1>\n    </div>\n  );\n}\n`;
    }
    return `import React from 'react';\nimport { View, Text, StyleSheet } from 'react-native';\n\nexport function ${name}Screen(): React.JSX.Element {\n  return (\n    <View style={styles.container}>\n      <Text style={styles.title}>${name}</Text>\n    </View>\n  );\n}\n\nconst styles = StyleSheet.create({\n  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },\n  title: { fontSize: 24, fontWeight: 'bold' },\n});\n`;
  }

  private fallbackComponent(name: string): string {
    return `import React from 'react';\n\ninterface ${name}Props {\n  [key: string]: unknown;\n}\n\nexport function ${name}({ ...props }: ${name}Props): React.JSX.Element {\n  return <div className="rounded-lg border border-border p-4">{/* ${name} */}</div>;\n}\n`;
  }

  // ── Utilities ──────────────────────────────────────────
  private staticFile(path: string, content: string): GeneratedFile {
    return { path, content, language: path.endsWith('.json') ? 'json' : path.endsWith('.css') ? 'css' : 'typescript', warnings: [] };
  }

  private buildSummary(files: GeneratedFile[], _ir: IRDocument): ConversionSummary {
    return {
      totalFiles:      files.length,
      successfulFiles: files.filter((f) => !f.warnings?.length).length,
      failedFiles:     0,
      totalLines:      files.reduce((a, f) => a + f.content.split('\n').length, 0),
      convertedLines:  files.reduce((a, f) => a + f.content.split('\n').length, 0),
      skippedFiles:    [],
    };
  }

  private pascal(str: string): string { return str.charAt(0).toUpperCase() + str.slice(1); }
  private methodDecorator(m: string): string { return { GET: 'Get', POST: 'Post', PUT: 'Put', PATCH: 'Patch', DELETE: 'Delete' }[m] ?? 'Get'; }
  private dartTypeToTS(type: string): string {
    const map: Record<string, string> = { String: 'string', int: 'number', double: 'number', bool: 'boolean', dynamic: 'unknown', List: 'unknown[]', Map: 'Record<string,unknown>' };
    return map[type] ?? type;
  }

  // ── Package.json templates ─────────────────────────────
  private reactPackageJson(name: string): string { return JSON.stringify({ name, version: '0.1.0', private: true, scripts: { dev: 'vite', build: 'tsc && vite build', preview: 'vite preview' }, dependencies: { react: '^18.2.0', 'react-dom': '^18.2.0', 'react-router-dom': '^6.22.0', zustand: '^4.5.0', axios: '^1.6.0', '@tanstack/react-query': '^5.0.0' }, devDependencies: { typescript: '^5.4.0', vite: '^5.0.0', '@vitejs/plugin-react': '^4.0.0', tailwindcss: '^3.4.0', autoprefixer: '^10.4.0', postcss: '^8.4.0', '@types/react': '^18.2.0', '@types/react-dom': '^18.2.0' } }, null, 2); }
  private rnPackageJson(name: string): string { return JSON.stringify({ name, version: '0.1.0', private: true, scripts: { start: 'expo start', android: 'expo run:android', ios: 'expo run:ios' }, dependencies: { expo: '~50.0.0', 'expo-router': '^3.0.0', react: '18.2.0', 'react-native': '0.73.0', '@react-navigation/native': '^6.0.0', zustand: '^4.5.0', axios: '^1.6.0' }, devDependencies: { typescript: '^5.4.0', '@types/react': '^18.2.0', '@types/react-native': '^0.73.0' } }, null, 2); }
  private nestPackageJson(name: string): string { return JSON.stringify({ name, version: '0.0.1', private: true, scripts: { build: 'nest build', start: 'nest start', 'start:dev': 'nest start --watch', 'start:prod': 'node dist/main' }, dependencies: { '@nestjs/common': '^10.0.0', '@nestjs/core': '^10.0.0', '@nestjs/platform-express': '^10.0.0', '@nestjs/config': '^3.0.0', '@nestjs/jwt': '^10.0.0', '@nestjs/passport': '^10.0.0', '@nestjs/swagger': '^7.0.0', '@nestjs/typeorm': '^10.0.0', typeorm: '^0.3.0', pg: '^8.11.0', 'reflect-metadata': '^0.2.0', rxjs: '^7.8.0', 'class-validator': '^0.14.0', 'class-transformer': '^0.5.0' }, devDependencies: { '@nestjs/cli': '^10.0.0', '@nestjs/schematics': '^10.0.0', '@nestjs/testing': '^10.0.0', typescript: '^5.4.0' } }, null, 2); }
}

// ── Static template strings ────────────────────────────────
const REACT_TSCONFIG = `{"compilerOptions":{"target":"ES2020","useDefineForClassFields":true,"lib":["ES2020","DOM","DOM.Iterable"],"module":"ESNext","skipLibCheck":true,"moduleResolution":"bundler","allowImportingTsExtensions":true,"resolveJsonModule":true,"isolatedModules":true,"noEmit":true,"jsx":"react-jsx","strict":true,"noUnusedLocals":true,"noUnusedParameters":true},"include":["src"],"references":[{"path":"./tsconfig.node.json"}]}`;
const TAILWIND_CONFIG = `import type { Config } from 'tailwindcss';\nexport default { content: ['./index.html','./src/**/*.{js,ts,jsx,tsx}'], theme: { extend: {} }, plugins: [] } satisfies Config;\n`;
const VITE_CONFIG = `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()], server: { port: 3000 } });\n`;
const REACT_MAIN = `import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport { RouterProvider } from 'react-router-dom';\nimport { QueryClientProvider, QueryClient } from '@tanstack/react-query';\nimport { router } from './router';\nimport './styles/globals.css';\n\nconst queryClient = new QueryClient();\n\nReactDOM.createRoot(document.getElementById('root')!).render(\n  <React.StrictMode>\n    <QueryClientProvider client={queryClient}>\n      <RouterProvider router={router} />\n    </QueryClientProvider>\n  </React.StrictMode>\n);\n`;
const REACT_APP = `import React from 'react';\nimport { Outlet } from 'react-router-dom';\nexport default function App(): React.JSX.Element { return <Outlet />; }\n`;
const GLOBALS_CSS = `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n:root { --font-sans: 'Inter', system-ui, sans-serif; }\nbody { font-family: var(--font-sans); -webkit-font-smoothing: antialiased; }\n`;
const API_CLIENT = `import axios from 'axios';\nexport const apiClient = axios.create({ baseURL: import.meta.env['VITE_API_URL'] ?? 'http://localhost:4000/api/v1', headers: { 'Content-Type': 'application/json' } });\napiClient.interceptors.request.use((config) => { const token = localStorage.getItem('cm_token'); if (token) config.headers.Authorization = \`Bearer \${token}\`; return config; });\n`;
const RN_TSCONFIG = `{"extends":"expo/tsconfig.base","compilerOptions":{"strict":true,"paths":{"@/*":["./src/*"]}}}`;
const RN_TAB_LAYOUT = `import { Tabs } from 'expo-router';\nimport React from 'react';\nexport default function TabLayout(): React.JSX.Element { return <Tabs><Tabs.Screen name="index" options={{ title: 'Home' }} /></Tabs>; }\n`;
const RN_INDEX = `import React from 'react';\nimport { View, Text, StyleSheet } from 'react-native';\nexport default function Home(): React.JSX.Element { return <View style={s.c}><Text style={s.t}>Home</Text></View>; }\nconst s = StyleSheet.create({ c: { flex: 1, alignItems: 'center', justifyContent: 'center' }, t: { fontSize: 24, fontWeight: 'bold' } });\n`;
const NEST_TSCONFIG = `{"compilerOptions":{"module":"CommonJS","declaration":true,"removeComments":true,"emitDecoratorMetadata":true,"experimentalDecorators":true,"allowSyntheticDefaultImports":true,"target":"ES2021","sourceMap":true,"outDir":"./dist","baseUrl":"./","strict":true,"skipLibCheck":true,"forceConsistentCasingInFileNames":true}}`;
const NEST_MAIN = `import { NestFactory } from '@nestjs/core';\nimport { ValidationPipe } from '@nestjs/common';\nimport { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';\nimport { AppModule } from './app.module';\nasync function bootstrap(): Promise<void> {\n  const app = await NestFactory.create(AppModule);\n  app.setGlobalPrefix('api/v1');\n  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));\n  const config = new DocumentBuilder().setTitle('API').setVersion('1.0').addBearerAuth().build();\n  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));\n  await app.listen(4000);\n  console.log('🚀 NestJS running on http://localhost:4000');\n}\nboostrap();\n`;
const NEST_APP_MODULE = `import { Module } from '@nestjs/common';\nimport { ConfigModule } from '@nestjs/config';\n\n@Module({\n  imports: [\n    ConfigModule.forRoot({ isGlobal: true }),\n    // TODO: add generated modules\n  ],\n})\nexport class AppModule {}\n`;
