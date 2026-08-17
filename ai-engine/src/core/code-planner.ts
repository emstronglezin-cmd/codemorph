// ============================================================
// CodeMorph AI Engine — Code Planner
// Transforms IR into a concrete file generation plan
// AI outputs IR → backend generates actual code files
// Uses AIProvider — supports Free (Groq), Platform (OpenAI), Pro (user key)
// PHASE 23: Prompt Architecte Ultime V3 — fidélité visuelle Phase 6, prompts V3
// PHASE 28: LLM Output Cleaner + File Chunker + Import Verifier intégrés
// PHASE 29: Business Layer Extractor — conversion directe des couches métier source
// ============================================================
import { AIProvider } from './ai-provider';
import type { ConversionContext, IRDocument, GeneratedFile, ConversionSummary, IRDesignTokens } from '../models/ir.types';
import { cleanLLMOutput, cleanGeneratedFiles }    from './output-cleaner';
import { convertLargeFile, needsChunking }         from './file-chunker';
import { verifyAndFixImports, detectTypeIssues, formatTypeReport } from './import-verifier';
// PHASE 29: Business Layer Extractor — conversion directe depuis le code source
import {
  extractAndConvertBusinessLayers,
  formatExtractionReport,
} from './business-layer-extractor';
// PHASE FINAL: File Generator — génération fidèle fichier par fichier
import {
  generateFileBatch,
  extractSourceBlocks,
  type FileGenerationRequest,
} from './file-generator';

export interface CodePlan {
  files:   GeneratedFile[];
  summary: ConversionSummary;
}

export class CodePlanner {
  private readonly ai: AIProvider;

  constructor(opts?: { userOpenAIKey?: string; userAnthropicKey?: string }) {
    this.ai = new AIProvider(opts);
  }

  async plan(ctx: ConversionContext, ir: IRDocument): Promise<CodePlan> {
    console.log(`[CodePlanner] plan() START — target=${ctx.targetFramework} projectId=${ctx.projectId}`);
    const planner = this.getFrameworkPlanner(ctx.targetFramework);
    const result  = await planner(ctx, ir);

    console.log(`[CodePlanner] plan() RAW — Generated files: ${result.files.length} | Total lines: ${result.summary.totalLines}`);

    // ── PHASE 28 STEP 1: Nettoyage LLM Output ────────────────────────────────
    // Supprimer les fences markdown, "Replace this...", notes explicatives
    console.log(`\n[CodePlanner] PHASE 28 — Step 1: LLM Output Cleaning...`);
    const cleanedBatch = cleanGeneratedFiles(result.files);
    result.files = cleanedBatch.files;
    if (cleanedBatch.totalModified > 0) {
      console.log(`[CodePlanner] Output Cleaner: ${cleanedBatch.totalModified} files cleaned, -${cleanedBatch.totalLinesRemoved} lines, -${cleanedBatch.totalCharsRemoved} chars`);
    }

    // ── PHASE 28 STEP 2: Import Verification ─────────────────────────────────
    // Analyser et corriger tous les imports cassés
    console.log(`[CodePlanner] PHASE 28 — Step 2: Import Verification...`);
    const importResult = verifyAndFixImports(result.files);
    result.files = importResult.files;
    const importReport = importResult.report;
    if (importReport.importsFixed > 0 || importReport.importsUnresolved > 0) {
      console.log(`[CodePlanner] Import Verifier: ${importReport.importsFixed} fixed, ${importReport.importsUnresolved} unresolved`);
    }

    // ── PHASE 28 STEP 3: Type Issue Detection ────────────────────────────────
    // Détecter les problèmes TypeScript courants sans exécuter tsc
    console.log(`[CodePlanner] PHASE 28 — Step 3: TypeScript Issue Detection...`);
    const typeIssues = detectTypeIssues(result.files);
    if (typeIssues.length > 0) {
      console.warn(`[CodePlanner] TypeScript issues detected: ${typeIssues.length}`);
      console.warn(formatTypeReport(typeIssues));
    } else {
      console.log(`[CodePlanner] TypeScript check: ✅ No issues detected`);
    }

    // ── Recalculer le résumé après nettoyage ─────────────────────────────────
    result.summary = this.buildSummary(result.files, ir);

    console.log(`[CodePlanner] plan() DONE — Files: ${result.files.length} | Lines: ${result.summary.totalLines}`);
    result.files.forEach((f, i) => {
      if (i < 8) console.log(`[CodePlanner]   [${i + 1}] ${f.path}`);
    });
    if (result.files.length > 8) console.log(`[CodePlanner]   ... and ${result.files.length - 8} more files`);
    return result;
  }

  private getFrameworkPlanner(target: string): (ctx: ConversionContext, ir: IRDocument) => Promise<CodePlan> {
    // FIX PHASE 16 — normaliser la cible pour matcher les variations d'entrée
    // Backend envoie: "react", "react-native", "reactnative", "nestjs", "flutter"
    // PHASE 30: Ajout du planner Flutter (RN→Flutter prioritaire)
    const norm = target.toLowerCase().replace(/[\s_-]/g, '');
    if (norm === 'react')                          return this.planReact.bind(this);
    if (norm === 'reactnative' || norm === 'rn')  return this.planReactNative.bind(this);
    if (norm === 'nestjs')                         return this.planNestJS.bind(this);
    if (norm === 'flutter')                        return this.planFlutter.bind(this);
    return this.planGeneric.bind(this);
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

    // Defensive: ensure uiGraph exists
    const uiGraph = ir.uiGraph ?? { screens: [], components: [], stateFlow: [], stateSlices: [], theme: {} };

    // Generate screens from IR
    for (const screen of (uiGraph.screens ?? [])) {
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
    for (const comp of (uiGraph.components ?? []).filter((c) => c.type === 'ui' || c.type === 'shared')) {
      const content = await this.generateComponentFile(ctx, comp.name, comp.props ?? [], 'react');
      files.push({
        path:     `src/components/${comp.name}.tsx`,
        content,
        language: 'typescript',
        warnings: [],
      });
    }

    // State stores from IR
    for (const sf of (uiGraph.stateFlow ?? [])) {
      files.push({
        path:     `src/stores/${sf.store.toLowerCase()}.store.ts`,
        content:  this.generateZustandStore(sf.store, sf.actions),
        language: 'typescript',
        warnings: [],
      });
    }

    // Router
    if ((uiGraph.screens ?? []).length > 0) {
      files.push({
        path:    'src/router/index.tsx',
        content: this.generateReactRouter(uiGraph.screens ?? []),
        language: 'typescript',
        warnings: [],
      });
    }

    // ── PHASE 29: Business Layer Direct Conversion (React) ──────────────────
    if (ctx.sourceCode && ctx.sourceCode.length > 500) {
      console.log(`\n[CodePlanner] PHASE 29 — Business Layer Direct Conversion (React)...`);
      try {
        const bizResult = await extractAndConvertBusinessLayers(
          ctx.sourceCode,
          this.ai,
          ctx.targetFramework ?? 'react',
        );
        console.log(formatExtractionReport(bizResult));
        const existingPaths = new Set(files.map((f) => f.path));
        let added = 0;
        let replaced = 0;
        for (const converted of bizResult.convertedFiles) {
          if (!converted.content || converted.content.length < 50) continue;
          const genFile: GeneratedFile = {
            path:     converted.targetPath,
            content:  converted.content,
            language: 'typescript',
            fromPath: converted.sourcePath,
            warnings: converted.success ? [] : [`Conversion incomplete — ${converted.error ?? 'unknown'}`],
          };
          if (existingPaths.has(converted.targetPath)) {
            const idx = files.findIndex((f) => f.path === converted.targetPath);
            if (idx >= 0) { files[idx] = genFile; replaced++; }
          } else {
            files.push(genFile);
            existingPaths.add(converted.targetPath);
            added++;
          }
        }
        console.log(`[CodePlanner] PHASE 29 React: ${added} new + ${replaced} replaced`);
      } catch (bizErr) {
        console.warn(`[CodePlanner] PHASE 29 React business layer failed: ${(bizErr as Error).message}`);
      }
    }

    return { files, summary: this.buildSummary(files, ir) };
  }

  // ── React Native planner ──────────────────────────────
  // FIX PHASE 21: full implementation — components, stores, router
  // Previously only generated 4 static files when ir.uiGraph.screens was empty
  // (which always happened with Groq because JSON parsing failed with 2048 token limit)
  // Now: generates all files from IR + AST-based fallback when IR is empty
  private async planReactNative(ctx: ConversionContext, ir: IRDocument): Promise<CodePlan> {
    const files: GeneratedFile[] = [];
    console.log(`[CodePlanner] planReactNative START — projectId=${ctx.projectId}`);

    // ── Static project scaffolding (always generated) ──────
    files.push(
      this.staticFile('package.json',           this.rnPackageJson(ctx.projectId)),
      this.staticFile('tsconfig.json',          RN_TSCONFIG),
      this.staticFile('app.json',               this.rnAppJson(ctx.projectId)),
      this.staticFile('babel.config.js',        RN_BABEL_CONFIG),
      this.staticFile('app/(tabs)/_layout.tsx', RN_TAB_LAYOUT),
      // BUG-P27-09: index.tsx injecté plus bas avec le nom du premier écran réel
      this.staticFile('src/lib/api.ts',         RN_API_CLIENT),
      this.staticFile('src/lib/storage.ts',     RN_STORAGE),
      this.staticFile('src/hooks/useApi.ts',    RN_USE_API_HOOK),
      this.staticFile('src/theme/colors.ts',    RN_THEME_COLORS),
      this.staticFile('src/theme/spacing.ts',   RN_THEME_SPACING),
      this.staticFile('src/components/ui/Button.tsx',    RN_BUTTON_COMPONENT),
      this.staticFile('src/components/ui/TextInput.tsx', RN_TEXT_INPUT_COMPONENT),
      this.staticFile('src/components/ui/Card.tsx',      RN_CARD_COMPONENT),
      this.staticFile('src/components/ui/LoadingSpinner.tsx', RN_LOADING_SPINNER),
      this.staticFile('src/components/ui/ErrorMessage.tsx',   RN_ERROR_MESSAGE),
    );

    // ── Defensive: ensure uiGraph exists ──────────────────
    const uiGraph = ir.uiGraph ?? { screens: [], components: [], stateFlow: [], navigationFlow: [] };
    const screens   = uiGraph.screens   ?? [];
    const components = uiGraph.components ?? [];
    const stateFlow  = uiGraph.stateFlow  ?? [];

    console.log(`[CodePlanner] IR uiGraph — screens=${screens.length} components=${components.length} stateFlows=${stateFlow.length}`);

    // ── Screens from IR ────────────────────────────────────
    if (screens.length > 0) {
      let firstScreenSlug = '';
      for (const screen of screens) {
        const content = await this.generateScreenFile(ctx, ir, screen.name, screen.components ?? [], 'react-native');
        const screenSlug = screen.name.toLowerCase().replace(/screen$/i, '');
        if (!firstScreenSlug) firstScreenSlug = screenSlug;
        files.push({
          path:     `app/${screenSlug}.tsx`,
          content,
          language: 'typescript',
          fromPath: screen.path,
          warnings: [],
        });
      }
      // BUG-P27-09 FIX: index.tsx redirige vers le premier écran réel
      files.push(this.staticFile('app/index.tsx', RN_INDEX_TEMPLATE(firstScreenSlug || screens[0]!.name)));
      // Generate navigation stack with all screens
      files.push({
        path:     'app/_layout.tsx',
        content:  this.generateRNRootLayout(screens),
        language: 'typescript',
        warnings: [],
      });
    } else {
      // ── PHASE 22: Fallback — generate screens from source architecture ──────
      // JAMAIS de noms génériques interdits (HomeScreen, DetailsScreen, etc.)
      // inferScreensFromSourceFiles() retourne [] si aucune donnée source disponible
      console.log(`[CodePlanner] uiGraph.screens empty — using AST-based fallback (no generic names allowed)`);
      const fallbackScreens = this.inferScreensFromSourceFiles(ir);
      console.log(`[CodePlanner] Inferred ${fallbackScreens.length} screens from source architecture`);

      if (fallbackScreens.length > 0) {
        const firstFallbackSlug = fallbackScreens[0]!.replace(/Screen$/i, '').toLowerCase();
        for (const screenName of fallbackScreens) {
          const content = this.fallbackScreen(screenName, 'react-native');
          files.push({
            path:     `app/${screenName.replace(/Screen$/i, '').toLowerCase()}.tsx`,
            content,
            language: 'typescript',
            warnings: ['Generated from source module analysis — review recommended'],
          });
        }
        // BUG-P27-09 FIX: index.tsx avec nom du vrai écran inféré
        files.push(this.staticFile('app/index.tsx', RN_INDEX_TEMPLATE(firstFallbackSlug)));
        files.push({
          path:     'app/_layout.tsx',
          content:  this.generateRNRootLayoutFromNames(fallbackScreens),
          language: 'typescript',
          warnings: [],
        });
      } else {
        // Aucune donnée source disponible — log uniquement, aucun fichier générique
        // BUG-P27-09 FIX: même sans écrans inférés, pas d'index générique
        console.warn(`[CodePlanner] PHASE22/27: No screens could be inferred from IR. No generic screens generated. Check IR quality and Groq token budget.`);
      }
    }

    // ── Feature components from IR ─────────────────────────
    const featureComponents = components.filter((c) =>
      c.type === 'feature' || c.type === 'widget' || c.type === 'page' || c.type === 'ui' || c.type === 'shared'
    );
    for (const comp of featureComponents) {
      const content = await this.generateComponentFile(ctx, comp.name, comp.props ?? [], 'react-native');
      files.push({
        path:     `src/components/${comp.name}.tsx`,
        content,
        language: 'typescript',
        warnings: [],
      });
    }

    // ── State stores from IR (Zustand) ─────────────────────
    for (const sf of stateFlow) {
      files.push({
        path:     `src/stores/${sf.store.toLowerCase()}.store.ts`,
        content:  this.generateZustandStore(sf.store, sf.actions ?? []),
        language: 'typescript',
        warnings: [],
      });
    }
    // Always generate a base auth store
    files.push({
      path:     'src/stores/auth.store.ts',
      content:  this.generateRNAuthStore(),
      language: 'typescript',
      warnings: [],
    });

    // ── Data models from IR ────────────────────────────────
    const dataLayer = ir.dataLayer ?? { models: [], relationships: [], migrations: [] };
    for (const model of (dataLayer.models ?? [])) {
      files.push({
        path:     `src/types/${model.name.toLowerCase()}.types.ts`,
        content:  this.generateTypeInterface(model),
        language: 'typescript',
        warnings: [],
      });
    }

    // ── Services from IR backend graph (fallback if no source available) ──────
    const backendGraph = ir.backendGraph ?? { routes: [], services: [], entities: [], middlewares: [] };
    for (const svc of (backendGraph.services ?? []).slice(0, 10)) {
      files.push({
        path:     `src/services/${svc.name.toLowerCase()}.service.ts`,
        content:  this.generateRNService(svc),
        language: 'typescript',
        warnings: [],
      });
    }

    // ── PHASE FINAL: File Generator + Business Layer Extraction ──────────────
    // Stratégie unifiée: analyser le source block par block,
    // puis générer CHAQUE fichier individuellement avec le source complet injecté.
    if (ctx.sourceCode && ctx.sourceCode.length > 500) {
      console.log(`\n[CodePlanner] PHASE FINAL — Per-file faithful generation from source code...`);
      try {
        const sourceBlocks = extractSourceBlocks(ctx.sourceCode);
        console.log(`[CodePlanner] Extracted ${sourceBlocks.length} source blocks`);

        // ── ÉTAPE 1: Business Layer (services, stores, repositories, models, utils) ──
        const bizResult = await extractAndConvertBusinessLayers(
          ctx.sourceCode,
          this.ai,
          ctx.targetFramework ?? 'react-native',
        );
        console.log(formatExtractionReport(bizResult));

        const existingPaths = new Set(files.map((f) => f.path));
        let newFilesCount = 0;
        let replacedCount = 0;

        for (const converted of bizResult.convertedFiles) {
          // Accepter même les fichiers partiellement convertis (success=false mais contenu >50 chars)
          // Les stubs IR (generateZustandStore, generateTypeInterface) sont TOUJOURS remplacés
          // car BizLayerExtractor a accès au vrai code source
          if (!converted.content || converted.content.length < 50) continue;
          const genFile: GeneratedFile = {
            path:     converted.targetPath,
            content:  converted.content,
            language: 'typescript',
            fromPath: converted.sourcePath,
            warnings: converted.success ? [] : [`Conversion incomplete — ${converted.error ?? 'unknown error'}`],
          };
          if (existingPaths.has(converted.targetPath)) {
            const idx = files.findIndex((f) => f.path === converted.targetPath);
            // Remplacer TOUJOURS le stub IR par la version BizLayer (source réelle convertie)
            if (idx >= 0) { files[idx] = genFile; replacedCount++; }
          } else {
            files.push(genFile);
            existingPaths.add(converted.targetPath);
            newFilesCount++;
          }
        }
        console.log(`[CodePlanner] BizLayer: ${newFilesCount} new + ${replacedCount} replaced (${bizResult.successCount}/${bizResult.totalFiles} success)`);
        // Log des fichiers remplacés pour diagnostic
        if (replacedCount > 0) {
          console.log(`[CodePlanner] ✅ BizLayer replaced ${replacedCount} IR stubs with real converted source`);
        }

        // ── ÉTAPE 2: Screens — générer fichier par fichier avec source complet ──
        // Identifier les écrans screen/* page/* view/* qui n'ont pas encore été
        // générés ou qui sont des fallbacks (contenu < 200 chars)
        const screenBlocks = sourceBlocks.filter((b) =>
          /(?:screen|page|view)\//i.test(b.path) ||
          /(?:screen|page|view)\./i.test(b.path.split('/').pop() ?? ''),
        );

        if (screenBlocks.length > 0) {
          console.log(`\n[CodePlanner] PHASE FINAL Step 2 — Generating ${screenBlocks.length} screens file-by-file...`);

          const screenRequests: FileGenerationRequest[] = screenBlocks.map((block) => {
            const baseName = block.path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'Screen';
            const screenName = baseName
              .split(/[_\-]/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
            const slug = screenName.replace(/Screen$/i, '').toLowerCase();
            const targetPath = `app/${slug}.tsx`;

            return {
              name:            screenName,
              targetPath,
              fileType:        'screen' as const,
              sourceContent:   block.content,
              sourcePath:      block.path,
              targetFramework: ctx.targetFramework ?? 'react-native',
              ...(ctx.structuralSummary ? { context: ctx.structuralSummary.slice(0, 500) } : {}),
            };
          });

          const screenBatch = await generateFileBatch(screenRequests, this.ai);

          for (const genResult of screenBatch.files) {
            const genFile: GeneratedFile = {
              path:     genResult.path,
              content:  genResult.content,
              language: 'typescript',
              fromPath: genResult.fromPath,
              warnings: genResult.warnings,
            };
            if (existingPaths.has(genResult.path)) {
              // Remplacer TOUJOURS si FileGenerator a produit du contenu valide
              // (même si l'IR stub était non-vide — il ne contient que du scaffold générique)
              const idx = files.findIndex((f) => f.path === genResult.path);
              if (idx >= 0 && genResult.content.length > 50) {
                files[idx] = genFile;
                replacedCount++;
              }
            } else {
              files.push(genFile);
              existingPaths.add(genResult.path);
              newFilesCount++;
            }
          }
          console.log(`[CodePlanner] Screens: ${screenBatch.successCount}/${screenBatch.totalFiles} success`);
        }

        // ── ÉTAPE 3: Composants non encore générés ──────────────────────────────
        const widgetBlocks = sourceBlocks.filter((b) =>
          /(?:widget|component)\//i.test(b.path) && !existingPaths.has(b.path),
        );
        if (widgetBlocks.length > 0) {
          console.log(`\n[CodePlanner] PHASE FINAL Step 3 — Generating ${widgetBlocks.length} components...`);
          const compRequests: FileGenerationRequest[] = widgetBlocks.map((block) => {
            const baseName = block.path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'Component';
            const compName = baseName.split(/[_\-]/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
            return {
              name:            compName,
              targetPath:      `src/components/${compName}.tsx`,
              fileType:        'component' as const,
              sourceContent:   block.content,
              sourcePath:      block.path,
              targetFramework: ctx.targetFramework ?? 'react-native',
            };
          });
          const compBatch = await generateFileBatch(compRequests, this.ai);
          for (const genResult of compBatch.files) {
            if (!existingPaths.has(genResult.path)) {
              files.push({ path: genResult.path, content: genResult.content, language: 'typescript', fromPath: genResult.fromPath, warnings: genResult.warnings });
              existingPaths.add(genResult.path);
              newFilesCount++;
            }
          }
          console.log(`[CodePlanner] Components: ${compBatch.successCount}/${compBatch.totalFiles} success`);
        }

      } catch (bizErr) {
        console.warn(`[CodePlanner] PHASE FINAL failed: ${(bizErr as Error).message} — using IR-based files only`);
      }
    }

    // ── Constants & config ─────────────────────────────────
    files.push(
      this.staticFile('src/constants/index.ts', RN_CONSTANTS),
      this.staticFile('src/types/index.ts',     RN_TYPES_INDEX),
      this.staticFile('.env.example',           RN_ENV_EXAMPLE),
      this.staticFile('README.md',              this.generateRNReadme(ctx, files.length + 3)),
    );

    console.log(`[CodePlanner] planReactNative DONE — totalFiles=${files.length}`);
    return { files, summary: this.buildSummary(files, ir) };
  }

  // ── PHASE 22: Infer screen names from IR — STRICT: NEVER return generic names ──
  // Toutes les valeurs retournées doivent provenir des données source réelles
  private inferScreensFromSourceFiles(ir: IRDocument): string[] {
    // Use architecture modules to infer screens (from real source modules)
    const arch = ir.architecture ?? { modules: [], patterns: [], layers: [] };
    const moduleNames = (arch.modules ?? [])
      .filter((m) => m.type === 'feature' || m.type === 'ui')
      .map((m) => this.pascal(m.name) + 'Screen')
      .filter((n) => n.length > 7); // filter out "Screen" alone

    if (moduleNames.length > 0) {
      console.log(`[CodePlanner] inferScreensFromSourceFiles: ${moduleNames.length} screens from modules`);
      return moduleNames.slice(0, 10);
    }

    // PHASE 26.1 AUDIT — Suppression du fallback basé sur projectMeta.description.
    // Ce fallback générait des noms comme "TodoScreen" (depuis "Todo app description")
    // qui sont sémantiquement arbitraires et non basés sur la structure réelle.
    // STRICT: si les modules UI ne contiennent pas de données réelles → retourner []
    // Le caller DOIT gérer le cas vide sans générer HomeScreen/DetailsScreen.
    console.warn(`[CodePlanner] inferScreensFromSourceFiles: no source module data available — returning [] (Phase 26.1 prohibition: no description-based inference)`);
    return [];
  }

  // ── React Native root layout with navigation ────────────
  private generateRNRootLayout(screens: IRDocument['uiGraph']['screens']): string {
    const screenLines = screens
      .map((s) => `        <Stack.Screen name="${s.name.toLowerCase()}" options={{ title: '${s.name}' }} />`)
      .join('\n');
    const importLines = screens
      .map((s) => `// Screen: ${s.name} → app/${s.name.toLowerCase()}.tsx`)
      .join('\n');

    return `import React from 'react';
import { Stack } from 'expo-router';

${importLines}

export default function RootLayout(): React.JSX.Element {
  return (
    <Stack>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
${screenLines}
    </Stack>
  );
}
`;
  }

  private generateRNRootLayoutFromNames(screenNames: string[]): string {
    const screenLines = screenNames
      .map((n) => `        <Stack.Screen name="${n.toLowerCase()}" options={{ title: '${n}' }} />`)
      .join('\n');

    return `import React from 'react';
import { Stack } from 'expo-router';

export default function RootLayout(): React.JSX.Element {
  return (
    <Stack>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
${screenLines}
    </Stack>
  );
}
`;
  }

  // ── React Native Auth Store ─────────────────────────────
  private generateRNAuthStore(): string {
    return `import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface User {
  id: string;
  email: string;
  name: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  setAuth: (user: User, token: string) => Promise<void>;
  clearAuth: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user:            null,
  token:           null,
  isAuthenticated: false,

  setAuth: async (user, token) => {
    await AsyncStorage.setItem('auth_token', token);
    set({ user, token, isAuthenticated: true });
  },

  clearAuth: async () => {
    await AsyncStorage.removeItem('auth_token');
    set({ user: null, token: null, isAuthenticated: false });
  },
}));
`;
  }

  // ── React Native Service from backendGraph ──────────────
  // PHASE 22: generateRNService — vraie implémentation basée sur le nom de méthode
  private generateRNService(svc: IRDocument['backendGraph']['services'][0]): string {
    const methods = (svc.methods ?? []).slice(0, 10).map((m) => {
      const params = m.params.map((p: { name: string; type: string }) => `${p.name}: ${p.type}`).join(', ');
      const httpMethod = /^(create|add|register|login|save|post)/.test(m.name) ? 'post'
        : /^(update|edit|modify|put|patch)/.test(m.name) ? 'put'
        : /^(delete|remove|destroy)/.test(m.name) ? 'delete'
        : 'get';
      const slug = svc.name.toLowerCase().replace(/service$/, '');
      const endpointSuffix = m.name.replace(/^(get|find|fetch|load|list|all)/, '').toLowerCase() || '';
      const endpoint = endpointSuffix ? `/${slug}/${endpointSuffix}` : `/${slug}`;
      const bodyParam = ['post', 'put', 'patch'].includes(httpMethod) && m.params.length > 0
        ? `, ${m.params[0]?.name ?? 'data'}` : '';
      return `export async function ${m.name}(${params}): Promise<${m.returnType}> {
  const res = await apiClient.${httpMethod}<${m.returnType}>('${endpoint}'${bodyParam});
  return res.data;
}`;
    }).join('\n\n');

    return `// ${svc.name} — auto-generated from source IR
import { apiClient } from '../lib/api';

${methods || `export async function get${this.pascal(svc.name)}(): Promise<unknown[]> {\n  const res = await apiClient.get<unknown[]>('/${svc.name.toLowerCase().replace(/service$/, '')}');\n  return res.data;\n}`}
`;
  }

  // ── TypeScript interface from data model ─────────────────
  private generateTypeInterface(model: IRDocument['dataLayer']['models'][0]): string {
    const fields = (model.fields ?? []).map((f: { name: string; type: string; nullable?: boolean }) =>
      `  ${f.name}${f.nullable ? '?' : ''}: ${this.dartTypeToTS(f.type)};`
    ).join('\n');

    return `// ${model.name} interface — auto-generated by CodeMorph
export interface ${model.name} {
${fields || `  id: string;\n  createdAt: string;\n  updatedAt: string;`}
}

export interface ${model.name}List {
  items: ${model.name}[];
  total: number;
  page: number;
}
`;
  }

  // ── RN-specific readme ────────────────────────────────────
  private generateRNReadme(ctx: ConversionContext, fileCount: number): string {
    return `# ${ctx.projectId} — React Native App

> Auto-generated by **CodeMorph** from ${ctx.sourceFramework} → React Native

## Generated Files
This project was automatically converted and contains **${fileCount} files**.

## Tech Stack
- **React Native** + Expo Router
- **TypeScript** (strict mode)
- **Zustand** (state management)
- **Axios** (HTTP client)
- **AsyncStorage** (local persistence)

## Getting Started
\`\`\`bash
npm install
npx expo start
\`\`\`

## Project Structure
\`\`\`
app/             # Expo Router screens
src/
  components/    # Reusable UI components
  stores/        # Zustand state stores
  services/      # API service layer
  types/         # TypeScript interfaces
  lib/           # Utilities (api client, storage)
  hooks/         # Custom React hooks
  theme/         # Design tokens
\`\`\`

## Notes
- Review generated files and configure API endpoints in src/lib/api.ts
- Configure \`src/lib/api.ts\` with your backend URL
- Update \`.env\` with actual environment variables
`;
  }

  // ── NestJS planner ────────────────────────────────────
  private async planNestJS(ctx: ConversionContext, ir: IRDocument): Promise<CodePlan> {
    const files: GeneratedFile[] = [];

    // BUG-P27-10 FIX: NEST_APP_MODULE généré dynamiquement avec les vrais modules
    const architecture = ir.architecture ?? { modules: [], patterns: [], layers: [] };
    const featureModules = (architecture.modules ?? []).filter((m) => m.type === 'feature');
    const dynamicAppModule = this.generateNestAppModule(featureModules.map((m) => m.name));

    files.push(
      this.staticFile('package.json',          this.nestPackageJson(ctx.projectId)),
      this.staticFile('tsconfig.json',         NEST_TSCONFIG),
      this.staticFile('src/main.ts',           NEST_MAIN),
      this.staticFile('src/app.module.ts',     dynamicAppModule),
    );

    // Generate modules from IR architecture (defensive guards — ir.architecture may be undefined without OpenAI key)
    const backendGraph = ir.backendGraph ?? { routes: [], services: [], middlewares: [], entities: [] };
    const dataLayer = ir.dataLayer ?? { models: [], migrations: [], seeders: [] };

    for (const mod of (architecture.modules ?? []).filter((m) => m.type === 'feature')) {
      const modName = mod.name.toLowerCase();
      files.push(
        { path: `src/modules/${modName}/${modName}.module.ts`,     content: this.generateNestModule(mod.name),     language: 'typescript', warnings: [] },
        { path: `src/modules/${modName}/${modName}.controller.ts`, content: this.generateNestController(mod.name, (backendGraph.routes ?? []).filter((r) => r.path.includes(modName))), language: 'typescript', warnings: [] },
        { path: `src/modules/${modName}/${modName}.service.ts`,    content: this.generateNestService(mod.name, (backendGraph.services ?? []).find((s) => s.name.toLowerCase().includes(modName))), language: 'typescript', warnings: [] },
      );
    }

    // Generate entities from IR
    for (const entity of (dataLayer.models ?? [])) {
      files.push({
        path:     `src/entities/${entity.name.toLowerCase()}.entity.ts`,
        content:  this.generateTypeORMEntity(entity),
        language: 'typescript',
        warnings: [],
      });
    }

    // Migrations
    for (const migration of (dataLayer.migrations ?? [])) {
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
    // Defensive guards — ir.architecture may be undefined without OpenAI key
    const architecture = ir.architecture ?? { modules: [], patterns: [], layers: [] };
    const patterns = (architecture.patterns ?? []).join(', ') || 'unknown';
    const files: GeneratedFile[] = [
      this.staticFile('README.md', `# Converted Project\n\nIR-based conversion completed.\n\n## Architecture\n${patterns}`),
    ];
    return { files, summary: this.buildSummary(files, ir) };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // ── PHASE 30: Flutter Planner ─────────────────────────────────────────────
  // Convertit React Native → Flutter avec Dart, Riverpod, GoRouter, Dio
  // Architecture: lib/screens/, lib/widgets/, lib/services/, lib/providers/,
  //               lib/models/, lib/repositories/, lib/utils/, lib/config/
  // ══════════════════════════════════════════════════════════════════════════════
  private async planFlutter(ctx: ConversionContext, ir: IRDocument): Promise<CodePlan> {
    const files: GeneratedFile[] = [];
    const projectName = (ctx.projectId ?? 'app').toLowerCase().replace(/[^a-z0-9_]/g, '_');
    console.log(`[CodePlanner] planFlutter START — projectId=${ctx.projectId}`);

    // ── 1. Static scaffolding (pubspec.yaml, main.dart, config) ───────────────
    files.push(
      this.staticFile('pubspec.yaml',           this.flutterPubspec(projectName)),
      this.staticFile('analysis_options.yaml',  FLUTTER_ANALYSIS_OPTIONS),
      this.staticFile('lib/main.dart',          this.flutterMain(projectName)),
      this.staticFile('lib/config/app_config.dart',   FLUTTER_APP_CONFIG),
      this.staticFile('lib/config/router.dart',       this.generateGoRouter(ir)),
      this.staticFile('lib/config/theme.dart',        FLUTTER_THEME),
      this.staticFile('lib/core/network/dio_client.dart',    FLUTTER_DIO_CLIENT),
      this.staticFile('lib/core/network/api_endpoints.dart', FLUTTER_API_ENDPOINTS),
      this.staticFile('lib/core/error/app_exception.dart',   FLUTTER_APP_EXCEPTION),
      this.staticFile('lib/core/storage/local_storage.dart', FLUTTER_LOCAL_STORAGE),
      this.staticFile('lib/core/utils/validators.dart',      FLUTTER_VALIDATORS),
      this.staticFile('lib/core/utils/formatters.dart',      FLUTTER_FORMATTERS),
    );

    // ── 2. Defensive: ensure IR graphs exist ──────────────────────────────────
    const uiGraph    = ir.uiGraph    ?? { screens: [], components: [], stateFlow: [], navigationFlow: [] };
    const dataLayer  = ir.dataLayer  ?? { models: [], relationships: [], migrations: [] };
    const backendGraph = ir.backendGraph ?? { routes: [], services: [], entities: [], middlewares: [] };
    const screens    = uiGraph.screens    ?? [];
    const components = uiGraph.components ?? [];
    const stateFlow  = uiGraph.stateFlow  ?? [];

    console.log(`[CodePlanner] planFlutter IR — screens=${screens.length} stateFlow=${stateFlow.length} models=${dataLayer.models?.length ?? 0} services=${backendGraph.services?.length ?? 0}`);

    // ── 3. Models / Data classes from IR ──────────────────────────────────────
    for (const model of (dataLayer.models ?? [])) {
      files.push({
        path:     `lib/models/${this.toSnake(model.name)}.dart`,
        content:  this.generateFlutterModel(model),
        language: 'dart',
        warnings: [],
      });
    }

    // ── 4. Services from IR backendGraph ──────────────────────────────────────
    for (const svc of (backendGraph.services ?? []).slice(0, 15)) {
      files.push({
        path:     `lib/services/${this.toSnake(svc.name.replace(/Service$/, ''))}_service.dart`,
        content:  this.generateFlutterService(svc),
        language: 'dart',
        warnings: [],
      });
    }

    // ── 5. Repositories (one per model that has a service) ────────────────────
    const modelNames = (dataLayer.models ?? []).map((m) => m.name);
    for (const modelName of modelNames.slice(0, 10)) {
      files.push({
        path:     `lib/repositories/${this.toSnake(modelName)}_repository.dart`,
        content:  this.generateFlutterRepository(modelName),
        language: 'dart',
        warnings: [],
      });
    }

    // ── 6. Riverpod providers from stateFlow ──────────────────────────────────
    // Always add core providers
    files.push(this.staticFile('lib/providers/auth_provider.dart',    FLUTTER_AUTH_PROVIDER));
    files.push(this.staticFile('lib/providers/connectivity_provider.dart', FLUTTER_CONNECTIVITY_PROVIDER));

    for (const sf of stateFlow) {
      const providerName = this.toSnake(sf.store.replace(/Store$|Provider$/, ''));
      files.push({
        path:     `lib/providers/${providerName}_provider.dart`,
        content:  this.generateFlutterProvider(sf.store, sf.actions ?? []),
        language: 'dart',
        warnings: [],
      });
    }

    // ── 7. Screens via LLM (AI-powered) ───────────────────────────────────────
    if (screens.length > 0) {
      for (const screen of screens) {
        const content = await this.generateFlutterScreen(ctx, ir, screen.name, screen.components ?? []);
        files.push({
          path:     `lib/screens/${this.toSnake(screen.name.replace(/Screen$/, ''))}_screen.dart`,
          content,
          language: 'dart',
          fromPath: screen.path,
          warnings: [],
        });
      }
    } else {
      // Fallback: infer from architecture
      const fallbackScreens = this.inferScreensFromSourceFiles(ir);
      console.log(`[CodePlanner] planFlutter fallback — ${fallbackScreens.length} screens inferred`);
      for (const screenName of fallbackScreens) {
        files.push({
          path:     `lib/screens/${this.toSnake(screenName.replace(/Screen$/, ''))}_screen.dart`,
          content:  this.generateFlutterFallbackScreen(screenName),
          language: 'dart',
          warnings: ['Generated from IR — review and complete implementation'],
        });
      }
    }

    // ── 8. Widgets from components ────────────────────────────────────────────
    for (const comp of (components ?? []).filter((c) => c.type === 'ui' || c.type === 'shared' || c.type === 'widget')) {
      files.push({
        path:     `lib/widgets/${this.toSnake(comp.name)}_widget.dart`,
        content:  this.generateFlutterWidget(comp.name, comp.props ?? []),
        language: 'dart',
        warnings: [],
      });
    }
    // Always add base widgets
    files.push(
      this.staticFile('lib/widgets/loading_widget.dart',    FLUTTER_LOADING_WIDGET),
      this.staticFile('lib/widgets/error_widget.dart',      FLUTTER_ERROR_WIDGET_DART),
      this.staticFile('lib/widgets/empty_state_widget.dart',FLUTTER_EMPTY_STATE_WIDGET),
    );

    // ── 9. PHASE 29: Business Layer Direct Conversion (Flutter) ───────────────
    if (ctx.sourceCode && ctx.sourceCode.length > 500) {
      console.log(`\n[CodePlanner] PHASE 29+30 — Business Layer Direct Conversion (Flutter)...`);
      try {
        const bizResult = await extractAndConvertBusinessLayers(
          ctx.sourceCode,
          this.ai,
          'flutter',
        );
        console.log(formatExtractionReport(bizResult));
        const existingPaths = new Set(files.map((f) => f.path));
        let added = 0; let replaced = 0;
        for (const converted of bizResult.convertedFiles) {
          if (!converted.content || converted.content.length < 50) continue;
          const genFile: GeneratedFile = {
            path:     converted.targetPath,
            content:  converted.content,
            language: 'dart',
            fromPath: converted.sourcePath,
            warnings: converted.success ? [] : [`Conversion incomplete — ${converted.error ?? 'unknown'}`],
          };
          if (existingPaths.has(converted.targetPath)) {
            const idx = files.findIndex((f) => f.path === converted.targetPath);
            if (idx >= 0) { files[idx] = genFile; replaced++; }
          } else {
            files.push(genFile);
            existingPaths.add(converted.targetPath);
            added++;
          }
        }
        console.log(`[CodePlanner] PHASE 29+30 Flutter: ${added} new + ${replaced} replaced`);
      } catch (bizErr) {
        console.warn(`[CodePlanner] PHASE 29+30 Flutter business layer failed: ${(bizErr as Error).message}`);
      }
    }

    // ── 10. README ────────────────────────────────────────────────────────────
    files.push(this.staticFile('README.md', this.generateFlutterReadme(ctx, files.length + 1)));

    console.log(`[CodePlanner] planFlutter DONE — totalFiles=${files.length}`);
    return { files, summary: this.buildSummary(files, ir) };
  }

  // ── Flutter GoRouter generator ──────────────────────────
  private generateGoRouter(ir: IRDocument): string {
    const screens = ir.uiGraph?.screens ?? [];
    const routes  = screens.length > 0
      ? screens.map((s) => {
          const slug   = this.toSnake(s.name.replace(/Screen$/, ''));
          const wgt    = this.pascal(s.name.replace(/Screen$/, '')) + 'Screen';
          return `  GoRoute(\n    path: '/${slug}',\n    name: '${slug}',\n    builder: (context, state) => const ${wgt}(),\n  ),`;
        }).join('\n')
      : `  GoRoute(\n    path: '/home',\n    name: 'home',\n    builder: (context, state) => const Scaffold(body: Center(child: Text('Home'))),\n  ),`;

    const initialLocation = screens.length > 0
      ? `'/${this.toSnake(screens[0]!.name.replace(/Screen$/, ''))}'`
      : `'/home'`;

    return `import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

// ── Screen imports ────────────────────────────────────────
${screens.map((s) => {
  const slugImport = this.toSnake(s.name.replace(/Screen$/, ''));
  return `import '../screens/${slugImport}_screen.dart';`;
}).join('\n') || "// No screens generated"}

final routerProvider = Provider<GoRouter>((ref) {
  return GoRouter(
    initialLocation: ${initialLocation},
    routes: [
${routes}
    ],
  );
});
`;
  }

  // ── Flutter Model (Dart data class with fromJson/toJson) ─
  private generateFlutterModel(model: IRDocument['dataLayer']['models'][0]): string {
    const name   = this.pascal(model.name);
    const fields = (model.fields ?? []).map((f: { name: string; type: string; nullable?: boolean }) => {
      const dartType = this.tsToDartType(f.type);
      const nullable = f.nullable ? '?' : '';
      return { name: this.toCamel(f.name), type: `${dartType}${nullable}` };
    });

    const fieldDecls   = fields.map((f) => `  final ${f.type} ${f.name};`).join('\n');
    const ctorParams   = fields.map((f) => `    required this.${f.name},`).join('\n');
    const fromJsonBody = fields.map((f) => {
      const key = f.name;
      if (f.type === 'String' || f.type === 'String?') return `      ${key}: json['${key}'] as String${f.type.endsWith('?') ? '?' : ''},`;
      if (f.type === 'int' || f.type === 'int?')       return `      ${key}: (json['${key}'] as num?)${f.type.endsWith('?') ? '?' : ''}.toInt() ?? 0,`;
      if (f.type === 'double' || f.type === 'double?') return `      ${key}: (json['${key}'] as num?)${f.type.endsWith('?') ? '?' : ''}.toDouble() ?? 0.0,`;
      if (f.type === 'bool' || f.type === 'bool?')     return `      ${key}: json['${key}'] as bool? ?? false,`;
      if (f.type === 'DateTime' || f.type === 'DateTime?') return `      ${key}: json['${key}'] != null ? DateTime.parse(json['${key}'] as String) : ${f.type.endsWith('?') ? 'null' : 'DateTime.now()'},`;
      return `      ${key}: json['${key}'],`;
    }).join('\n');
    const toJsonBody = fields.map((f) => `      '${f.name}': ${f.name},`).join('\n');
    const copyWithParams = fields.map((f) => `    ${f.type}? ${f.name},`).join('\n');
    const copyWithBody   = fields.map((f) => `      ${f.name}: ${f.name} ?? this.${f.name},`).join('\n');

    return `import 'dart:convert';

/// ${name} — auto-generated by CodeMorph
class ${name} {
${fieldDecls || '  final String id;'}

  const ${name}({
${ctorParams || '    required this.id,'}
  });

  factory ${name}.fromJson(Map<String, dynamic> json) {
    return ${name}(
${fromJsonBody || "      id: json['id'] as String,"}
    );
  }

  Map<String, dynamic> toJson() {
    return {
${toJsonBody || "      'id': id,"}
    };
  }

  ${name} copyWith({
${copyWithParams || '    String? id,'}
  }) {
    return ${name}(
${copyWithBody || '      id: id ?? this.id,'}
    );
  }

  @override
  String toString() => '${name}(${fields.map((f) => `${f.name}: \$${f.name}`).join(', ') || 'id: \$id'})';
}
`;
  }

  // ── Flutter Service (Dio-based) ────────────────────────────
  private generateFlutterService(svc: IRDocument['backendGraph']['services'][0]): string {
    const name    = this.pascal(svc.name.replace(/Service$/, ''));
    const slug    = this.toSnake(name);
    const methods = (svc.methods ?? []).slice(0, 12).map((m) => {
      const httpMethod = /^(create|add|register|login|save|post)/.test(m.name) ? 'post'
        : /^(update|edit|modify|put|patch)/.test(m.name) ? 'put'
        : /^(delete|remove|destroy)/.test(m.name) ? 'delete'
        : 'get';
      const endpointSuffix = m.name.replace(/^(get|find|fetch|load|list|all)/, '').toLowerCase() || '';
      const endpoint = endpointSuffix ? `/${slug}/${endpointSuffix}` : `/${slug}`;
      const hasBody = ['post', 'put', 'patch'].includes(httpMethod);
      return `  Future<dynamic> ${this.toCamel(m.name)}(${hasBody ? '{required Map<String, dynamic> data}' : ''}) async {
    final response = await _client.${httpMethod}<dynamic>('${endpoint}'${hasBody ? ', data: data' : ''});
    return response.data;
  }`;
    }).join('\n\n');

    return `import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../core/network/dio_client.dart';

/// ${name}Service — auto-generated by CodeMorph Phase 30
class ${name}Service {
  final Dio _client;
  ${name}Service(this._client);

${methods || `  Future<List<dynamic>> getAll() async {
    final response = await _client.get<List<dynamic>>('/${slug}');
    return response.data ?? [];
  }`}
}

final ${this.toCamel(name)}ServiceProvider = Provider<${name}Service>((ref) {
  final dio = ref.watch(dioClientProvider);
  return ${name}Service(dio);
});
`;
  }

  // ── Flutter Repository ─────────────────────────────────────
  private generateFlutterRepository(modelName: string): string {
    const name  = this.pascal(modelName);
    const snake = this.toSnake(modelName);
    return `import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models/${snake}.dart';
import '../services/${snake}_service.dart';

/// ${name}Repository — data access layer (CodeMorph Phase 30)
class ${name}Repository {
  final ${name}Service _service;
  final List<${name}> _cache = [];

  ${name}Repository(this._service);

  Future<List<${name}>> getAll({bool forceRefresh = false}) async {
    if (_cache.isNotEmpty && !forceRefresh) return List.unmodifiable(_cache);
    try {
      final data = await _service.getAll();
      _cache
        ..clear()
        ..addAll((data as List).map((e) => ${name}.fromJson(e as Map<String, dynamic>)));
      return List.unmodifiable(_cache);
    } catch (e) {
      rethrow;
    }
  }

  Future<${name}?> getById(String id) async {
    final cached = _cache.where((e) => (e as dynamic).id == id).toList();
    if (cached.isNotEmpty) return cached.first;
    try {
      final data = await _service.getById({'id': id});
      return ${name}.fromJson(data as Map<String, dynamic>);
    } catch (e) {
      return null;
    }
  }

  Future<${name}> create(Map<String, dynamic> data) async {
    final result = await _service.create(data: data);
    final item = ${name}.fromJson(result as Map<String, dynamic>);
    _cache.add(item);
    return item;
  }

  Future<void> delete(String id) async {
    await _service.delete(data: {'id': id});
    _cache.removeWhere((e) => (e as dynamic).id == id);
  }

  void clearCache() => _cache.clear();
}

final ${this.toCamel(name)}RepositoryProvider = Provider<${name}Repository>((ref) {
  final service = ref.watch(${this.toCamel(name)}ServiceProvider);
  return ${name}Repository(service);
});
`;
  }

  // ── Flutter Riverpod Provider from stateFlow ──────────────
  private generateFlutterProvider(storeName: string, actions: string[]): string {
    const name  = this.pascal(storeName.replace(/Store$|Provider$/, ''));
    const methodImpls = actions.slice(0, 8).map((a) => {
      const isAsync = /^(fetch|load|get|refresh)/.test(a);
      return isAsync
        ? `  Future<void> ${this.toCamel(a)}() async {\n    state = const AsyncLoading();\n    try {\n      // TODO: implement ${a}\n      state = const AsyncData(null);\n    } catch (e, st) {\n      state = AsyncError(e, st);\n    }\n  }`
        : `  void ${this.toCamel(a)}() {\n    // TODO: implement ${a}\n  }`;
    }).join('\n\n');

    return `import 'package:flutter_riverpod/flutter_riverpod.dart';

/// ${name}Notifier — Riverpod state (CodeMorph Phase 30)
class ${name}Notifier extends AsyncNotifier<dynamic> {
  @override
  Future<dynamic> build() async {
    return null;
  }

${methodImpls || `  Future<void> load() async {\n    state = const AsyncLoading();\n    state = const AsyncData(null);\n  }`}
}

final ${this.toCamel(name)}Provider = AsyncNotifierProvider<${name}Notifier, dynamic>(
  ${name}Notifier.new,
);
`;
  }

  // ── Flutter AI-powered screen generator ───────────────────
  private async generateFlutterScreen(ctx: ConversionContext, ir: IRDocument, name: string, components: string[]): Promise<string> {
    if (this.ai.getTier() === 'static') return this.generateFlutterFallbackScreen(name);

    const screenData  = ir.uiGraph?.screens?.find((s) => s.name === name) as Record<string, unknown> | undefined;
    const purpose     = (screenData?.['purpose']       as string   | undefined) ?? '';
    const bizLogic    = ((screenData?.['businessLogic'] as string[] | undefined) ?? []).join(', ');
    const apiCalls    = ((screenData?.['apiCalls']      as string[] | undefined) ?? []).join(', ');
    const states      = ((screenData?.['states']        as string[] | undefined) ?? []).join(', ');
    const userEvents  = ((screenData?.['userEvents']    as string[] | undefined) ?? []).join(', ');
    const validations = ((screenData?.['validations']   as string[] | undefined) ?? []).join(', ');

    const screenSourcePath = screenData?.['path'] as string | undefined;
    let sourceFileContent = '';
    if (ctx.sourceCode) {
      if (screenSourcePath) {
        const pat = new RegExp(`//\\s*(?:=+\\s*)?FILE:\\s*${screenSourcePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:=+)?\\n([\\s\\S]*?)(?=//\\s*(?:=+\\s*)?FILE:|$)`);
        const m = ctx.sourceCode.match(pat);
        if (m?.[1]?.trim()) sourceFileContent = m[1].trim();
      }
      if (!sourceFileContent) {
        const nameSlug = name.replace(/Screen$/i, '').toLowerCase();
        const fuzzy = new RegExp(`//\\s*(?:=+\\s*)?FILE:\\s*[^\\n]*${nameSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*\\n([\\s\\S]*?)(?=//\\s*(?:=+\\s*)?FILE:|$)`, 'i');
        const fm = ctx.sourceCode.match(fuzzy);
        if (fm?.[1]?.trim()) {
          sourceFileContent = fm[1].trim();
          console.log(`[CodePlanner] PHASE 30: Found Flutter source for "${name}" via fuzzy match`);
        }
      }
    }

    const hasSource     = sourceFileContent.length > 100;
    const widgetName    = this.pascal(name.replace(/Screen$/, '')) + 'Screen';
    const srcLang       = ctx.sourceFramework ?? 'React Native';
    const tier          = this.ai.getTier();
    const maxTokens     = hasSource
      ? (tier === 'free-groq' ? 2000 : tier === 'platform' ? 4000 : 6000)
      : (tier === 'free-groq' ? 1600 : tier === 'platform' ? 2000 : 4000);

    const ctxLines = [
      purpose      ? `Screen purpose: ${purpose}`           : '',
      bizLogic     ? `Business logic: ${bizLogic}`          : '',
      apiCalls     ? `API calls: ${apiCalls}`               : '',
      states       ? `UI states (implement ALL): ${states}` : '',
      userEvents   ? `User events: ${userEvents}`           : '',
      validations  ? `Validations: ${validations}`          : '',
      components.length ? `Sub-widgets: ${components.join(', ')}` : '',
    ].filter(Boolean).join('\n');

    const systemPrompt = `You are an expert Flutter developer specializing in framework migration.

TASK: Convert ${srcLang} code to production-ready Flutter/Dart.

RULES:
- Use Flutter 3.24+ with Dart null safety
- Use Riverpod for state management (ConsumerWidget / ConsumerStatefulWidget)
- Use GoRouter for navigation
- Use Dio for HTTP calls via the dioClientProvider
- Preserve ALL business logic, ALL API calls, ALL validation rules
- Implement ALL UI states: loading (CircularProgressIndicator), error (error widget), empty, success
- Use proper Flutter naming: ${widgetName} extends ConsumerStatefulWidget
- NEVER use placeholder text, TODO comments, or simplify logic
${hasSource ? '- Source code provided: convert EVERY method/function, preserve all logic\n- If a method cannot be converted, add: // TODO(codeMorph): INCOMPLETE — <reason>' : ''}
- Return ONLY the complete Dart file — no markdown, no explanations`;

    const userPrompt = hasSource
      ? `Convert this ${srcLang} screen to Flutter.

SOURCE (${screenSourcePath ?? name}, ${sourceFileContent.split('\n').length} lines):
\`\`\`
${sourceFileContent.length > 8000 ? sourceFileContent.slice(0, 8000) + '\n// ... (truncated)' : sourceFileContent}
\`\`\`

${ctxLines ? `CONTEXT:\n${ctxLines}` : ''}

Output: Complete Flutter Dart file for widget named ${widgetName}.
File: lib/screens/${this.toSnake(name.replace(/Screen$/, ''))}_screen.dart
Return ONLY the complete file.`
      : `Generate Flutter screen "${widgetName}".

${ctxLines ? `CONTEXT:\n${ctxLines}` : ''}

Source: ${srcLang} | Target: Flutter 3.24 + Dart null safety + Riverpod + GoRouter
File: lib/screens/${this.toSnake(name.replace(/Screen$/, ''))}_screen.dart

Return ONLY the complete Dart file.`;

    console.log(`[CodePlanner] generateFlutterScreen("${name}") — hasSource=${hasSource} maxTokens=${maxTokens}`);
    try {
      const res     = await this.ai.chat([{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], maxTokens);
      const cleaned = cleanLLMOutput(res.content || '', `flutter:${name}`).content;
      if (hasSource) {
        const srcLines = sourceFileContent.split('\n').length;
        const genLines = cleaned.split('\n').length;
        if (genLines / srcLines < 0.4 && srcLines > 30) {
          console.warn(`[CodePlanner] ⚠️  Flutter compression "${name}": ${srcLines}→${genLines} lines (${((genLines/srcLines)*100).toFixed(0)}%)`);
        }
      }
      return cleaned || this.generateFlutterFallbackScreen(name);
    } catch (err) {
      console.warn(`[CodePlanner] generateFlutterScreen("${name}") FAILED: ${(err as Error).message}`);
      return this.generateFlutterFallbackScreen(name);
    }
  }

  // ── Flutter Widget generator ──────────────────────────────
  private generateFlutterWidget(name: string, props: Array<{ name: string; type: string; required: boolean }>): string {
    const widgetName = this.pascal(name);
    const fields = props.slice(0, 8).map((p) => `  final ${this.tsToDartType(p.type)} ${this.toCamel(p.name)};`).join('\n');
    const ctor   = props.slice(0, 8).map((p) => `    ${p.required ? 'required ' : ''}this.${this.toCamel(p.name)},`).join('\n');
    return `import 'package:flutter/material.dart';

/// ${widgetName} — auto-generated by CodeMorph Phase 30
class ${widgetName} extends StatelessWidget {
${fields || '  final Widget? child;'}

  const ${widgetName}({
    super.key,
${ctor || '    this.child,'}
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      child: ${props.length > 0 ? `Text('${widgetName}')` : 'child ?? const SizedBox.shrink()'},
    );
  }
}
`;
  }

  // ── Flutter fallback screen (no LLM) ────────────────────────────────────────
  private generateFlutterFallbackScreen(name: string): string {
    const widgetName = this.pascal(name.replace(/Screen$/, '')) + 'Screen';
    const title      = name.replace(/Screen$/, '').replace(/([A-Z])/g, ' $1').trim();
    return `import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// ${widgetName} — generated by CodeMorph Phase 30
/// TODO(codeMorph): Complete implementation from source file
class ${widgetName} extends ConsumerStatefulWidget {
  const ${widgetName}({super.key});

  @override
  ConsumerState<${widgetName}> createState() => _${widgetName}State();
}

class _${widgetName}State extends ConsumerState<${widgetName}> {
  bool _isLoading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadData();
  }

  Future<void> _loadData() async {
    setState(() { _isLoading = true; _error = null; });
    try {
      // TODO(codeMorph): Load data for ${title}
      await Future<void>.delayed(const Duration(milliseconds: 300));
    } catch (e) {
      setState(() { _error = e.toString(); });
    } finally {
      setState(() { _isLoading = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('${title}')),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_isLoading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(_error!, style: const TextStyle(color: Colors.red)),
            const SizedBox(height: 16),
            ElevatedButton(onPressed: _loadData, child: const Text('Retry')),
          ],
        ),
      );
    }
    return const Center(child: Text('${title} — implementation pending'));
  }
}
`;
  }

  // ── Flutter Readme ─────────────────────────────────────────
  private generateFlutterReadme(ctx: ConversionContext, fileCount: number): string {
    return `# ${ctx.projectId} — Flutter App

> Auto-generated by **CodeMorph** from ${ctx.sourceFramework ?? 'React Native'} → Flutter

## Generated Files
This project contains **${fileCount} files** auto-converted by CodeMorph.

## Tech Stack
- **Flutter 3.24+** with Dart null safety
- **Riverpod 2.x** (state management)
- **GoRouter** (navigation)
- **Dio** (HTTP client)
- **SharedPreferences** (local storage)

## Getting Started
\`\`\`bash
flutter pub get
flutter run
\`\`\`

## Project Structure
\`\`\`
lib/
  config/      # App config, router, theme
  core/        # Network, error handling, storage, utils
  models/      # Data classes with fromJson/toJson
  services/    # API service layer (Dio)
  repositories/# Data access with caching
  providers/   # Riverpod state providers
  screens/     # UI screens (ConsumerStatefulWidget)
  widgets/     # Reusable widgets
  main.dart    # App entry point
\`\`\`

## Notes
- Configure API URL in \`lib/config/app_config.dart\`
- Review generated screens and complete any TODO(codeMorph) items
- Run \`dart run build_runner build\` if using freezed/json_serializable
`;
  }

  // ── Type conversion helpers ───────────────────────────────
  private tsToDartType(tsType: string): string {
    const map: Record<string, string> = {
      'string': 'String', 'String': 'String',
      'number': 'double', 'int': 'int', 'integer': 'int',
      'boolean': 'bool', 'bool': 'bool',
      'Date': 'DateTime', 'DateTime': 'DateTime',
      'any': 'dynamic', 'unknown': 'dynamic', 'object': 'Map<String, dynamic>',
      'void': 'void', 'null': 'Null',
      'string[]': 'List<String>', 'number[]': 'List<double>', 'int[]': 'List<int>',
      'boolean[]': 'List<bool>',
    };
    return map[tsType] ?? (tsType.endsWith('[]') ? `List<${map[tsType.slice(0, -2)] ?? 'dynamic'}>` : tsType);
  }

  private toSnake(s: string): string {
    return s
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
  }

  private toCamel(s: string): string {
    return s
      .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
      .replace(/^([A-Z])/, (c: string) => c.toLowerCase());
  }

  // ── AI-powered file generators — PHASE 23: Prompt Architecte Ultime V3 ────
  // Phase 5 : Reconstruction complète avec fidélité fonctionnelle absolue
  // Phase 6 : Fidélité visuelle — design tokens injectés dans les prompts
  private async generateScreenFile(ctx: ConversionContext, ir: IRDocument, name: string, components: string[], framework: string): Promise<string> {
    if (this.ai.getTier() === 'static') return this.fallbackScreen(name, framework);

    // PHASE 22: Extraire les données métier de l'écran depuis l'IR
    const screenData  = ir.uiGraph?.screens?.find((s) => s.name === name) as Record<string, unknown> | undefined;
    const purpose     = (screenData?.['purpose']       as string   | undefined) ?? '';
    const bizLogic    = ((screenData?.['businessLogic'] as string[] | undefined) ?? []).join(', ');
    const apiCalls    = ((screenData?.['apiCalls']      as string[] | undefined) ?? []).join(', ');
    const states      = ((screenData?.['states']        as string[] | undefined) ?? []).join(', ');
    const userEvents  = ((screenData?.['userEvents']    as string[] | undefined) ?? []).join(', ');
    const validations = ((screenData?.['validations']   as string[] | undefined) ?? []).join(', ');
    const errors      = ((screenData?.['errors']        as string[] | undefined) ?? []).join(', ');
    const dataFields  = ((screenData?.['dataFields']    as string[] | undefined) ?? []).join(', ');

    // PHASE 23: Design tokens pour fidélité visuelle (Phase 6)
    const designTokens: IRDesignTokens | undefined = ir.designTokens;
    const themeBlock = designTokens ? this.buildThemeContext(designTokens) : '';

    // PHASE 23: Knowledge Graph — liens de cet écran
    const kgNodes = ir.knowledgeGraph?.nodes ?? [];
    const kgEdges = ir.knowledgeGraph?.edges ?? [];
    const screenNodeId = `screen-${name.toLowerCase()}`;
    const relatedStores = kgEdges
      .filter((e) => e.from === screenNodeId && e.relation === 'uses-store')
      .map((e) => kgNodes.find((n) => n.id === e.to)?.name ?? e.to);
    const relatedApis = kgEdges
      .filter((e) => e.from === screenNodeId && e.relation === 'calls-api')
      .map((e) => kgNodes.find((n) => n.id === e.to)?.name ?? e.to);
    const relatedRules = kgEdges
      .filter((e) => e.from === screenNodeId && e.relation === 'enforces-rule')
      .map((e) => kgNodes.find((n) => n.id === e.to)?.name ?? e.to);

    const ctxLines = [
      purpose      ? `Screen purpose: ${purpose}`                                      : '',
      bizLogic     ? `Business logic: ${bizLogic}`                                     : '',
      dataFields   ? `Data to display: ${dataFields}`                                  : '',
      apiCalls     ? `API calls: ${apiCalls}`                                          : '',
      states       ? `UI states (implement ALL): ${states}`                            : '',
      userEvents   ? `User events (handle ALL): ${userEvents}`                        : '',
      validations  ? `Validations to enforce: ${validations}`                          : '',
      errors       ? `Error cases to handle: ${errors}`                                : '',
      components.length    ? `Sub-components: ${components.join(', ')}`               : '',
      relatedStores.length ? `State stores used: ${relatedStores.join(', ')}`         : '',
      relatedApis.length   ? `API endpoints (Knowledge Graph): ${relatedApis.join(', ')}` : '',
      relatedRules.length  ? `Business rules (enforce them): ${relatedRules.join(', ')}` : '',
      themeBlock           ? `Visual design tokens:\n${themeBlock}`                   : '',
    ].filter(Boolean).join('\n');

    // FIX PHASE 24 — BUG #6 (vérification IR injecté) + BUG #10 (logs)
    // Vérifier que des données IR réelles sont présentes dans le prompt
    const hasRealIRData = !!(purpose || bizLogic || apiCalls || states || relatedStores.length || relatedApis.length);
    if (!hasRealIRData) {
      console.warn(`[CodePlanner] ⚠️  BUG#6 WARNING: generateScreenFile("${name}") has NO real IR data (purpose/bizLogic/apiCalls/states/stores/apis all empty). Prompt will be generic.`);
    }

    // ── PHASE 29: Injecter le contenu source COMPLET dans le prompt ─────────────
    // Si le fichier source de l'écran est disponible → l'injecter directement
    // Le LLM reçoit le code original et doit le convertir fidèlement
    const screenSourcePath = screenData?.['path'] as string | undefined;
    let sourceFileContent = '';
    if (ctx.sourceCode) {
      // Tentative 1: via le chemin exact depuis l'IR
      if (screenSourcePath) {
        const fileMarkerPattern = new RegExp(
          `//\\s*(?:=+\\s*)?FILE:\\s*${screenSourcePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:=+)?\\n([\\s\\S]*?)(?=//\\s*(?:=+\\s*)?FILE:|$)`,
        );
        const fileMatch = ctx.sourceCode.match(fileMarkerPattern);
        if (fileMatch?.[1]?.trim()) {
          sourceFileContent = fileMatch[1].trim();
        }
      }
      // Tentative 2: recherche par nom d'écran dans les marqueurs FILE:
      if (!sourceFileContent) {
        const nameSlug = name.replace(/Screen$/i, '').toLowerCase();
        const fuzzyPattern = new RegExp(
          `//\\s*(?:=+\\s*)?FILE:\\s*[^\\n]*${nameSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*\\n([\\s\\S]*?)(?=//\\s*(?:=+\\s*)?FILE:|$)`,
          'i',
        );
        const fuzzyMatch = ctx.sourceCode.match(fuzzyPattern);
        if (fuzzyMatch?.[1]?.trim()) {
          sourceFileContent = fuzzyMatch[1].trim();
          console.log(`[CodePlanner] PHASE 29: Found source file for "${name}" via fuzzy name match`);
        }
      }
    }

    // ── PHASE 28/29: Si gros fichier source → chunking ─────────────────────────
    if (sourceFileContent && needsChunking(sourceFileContent, this.ai.getTier())) {
      const chunkedResult = await this.generateSourceFileWithChunking(
        ctx, sourceFileContent, ctx.sourceLanguage ?? 'dart',
        name, framework, ctxLines || '',
      );
      if (chunkedResult) {
        console.log(`[CodePlanner] generateScreenFile("${name}") DONE via chunking — ${chunkedResult.length} chars`);
        return chunkedResult;
      }
    }

    // ── PHASE 29: Prompt enrichi avec le code source complet ────────────────────
    // Si source disponible: prompt direct source→target (MEILLEURE FIDÉLITÉ)
    // Si source non disponible: prompt basé sur métadonnées IR (fallback)
    const hasSourceCode = sourceFileContent.length > 100;
    const targetLabel = framework === 'react' ? 'React + TypeScript + TailwindCSS' : 'React Native (Expo Router) + TypeScript';

    // PHASE 29: System Prompt amélioré avec règle de fidélité source
    const systemPrompt = `You are an AI Software Architect specialized in software reconstruction and multi-framework migration.

PHASE 5 — COMPLETE RECONSTRUCTION:
Generate production-ready ${targetLabel} code.
Reproduce IDENTICAL behavior from the source application.

PHASE 6 — VISUAL FIDELITY:
If design tokens are provided, USE THEM EXACTLY:
- Apply the exact color values for primary/background/text tokens
- Apply typography tokens (font sizes, font families, weights)
- Apply spacing tokens for padding/margin consistency
- The visual result must be immediately recognizable as the same screen

ABSOLUTE RULES:
- NEVER use placeholders (HomeScreen, DetailsScreen, TODO, Lorem Ipsum, placeholder text)
- NEVER invent functionality not in the context
- ALWAYS implement ALL stated UI states (loading, error, empty, success)
- ALWAYS implement ALL user events and validations
- ALWAYS implement ALL business logic rules and error cases
${hasSourceCode ? '- The source code is provided — EVERY function/method must be converted, NO logic may be lost\n- If a function cannot be converted, add: // TODO(codeMorph): CONVERSION INCOMPLETE — <reason>\n- Output line count must be at least 60% of source line count' : ''}
- Return ONLY the complete TypeScript file content — no markdown fences`;

    // PHASE 29: User Prompt avec injection du code source
    const userPrompt = hasSourceCode
      ? `Convert this ${ctx.sourceFramework ?? 'Flutter'} screen to ${targetLabel}.

SOURCE FILE (${screenSourcePath ?? name}, ${sourceFileContent.split('\n').length} lines):
\`\`\`
${sourceFileContent.length > 8000 ? sourceFileContent.slice(0, 8000) + '\n// ... (truncated for token limit — all methods must still be converted)' : sourceFileContent}
\`\`\`

${ctxLines ? `ADDITIONAL CONTEXT (from IR analysis):\n${ctxLines}` : ''}

Output: A complete ${targetLabel} screen named "${name}".
Requirements: TypeScript strict, all UI states, API calls via apiClient, proper error handling.
Return ONLY the complete file content.`
      : `Generate a complete ${targetLabel} screen named "${name}".

${ctxLines ? `CONTEXT (from source application analysis):\n${ctxLines}` : ''}

Source: ${ctx.sourceFramework} | Target: ${ctx.targetFramework}

Requirements: TypeScript strict, all UI states, real API calls via apiClient from '${framework === 'react' ? '../lib/api' : '../src/lib/api'}', proper error handling, no TODO, no placeholder.

Return ONLY the complete file content.`;

    // FIX PHASE 24 — BUG #10: Log structuré PROMPT pour generateScreenFile
    const promptChars = systemPrompt.length + userPrompt.length;
    console.log(`\n================ PROMPT (generateScreenFile: ${name}) ================`);
    console.log(`Characters        : ${promptChars}`);
    console.log(`Est. tokens       : ~${Math.ceil(promptChars / 4)}`);
    // Budget tokens selon le tier et la présence de code source
    // PHASE 29: Si source disponible, allouer plus de tokens pour la conversion complète
    const tier = this.ai.getTier();
    const maxResponseTokens = hasSourceCode
      ? (tier === 'free-groq' ? 1800 : tier === 'platform' ? 3500 : 6000)
      : (tier === 'free-groq' ? 1600 : tier === 'platform' ? 2000 : 4000);

    console.log(`\n================ PROMPT (generateScreenFile: ${name}) ================`);
    console.log(`Characters        : ${systemPrompt.length + userPrompt.length}`);
    console.log(`Est. tokens       : ~${Math.ceil((systemPrompt.length + userPrompt.length) / 4)}`);
    console.log(`Max response tok  : ${maxResponseTokens}`);
    console.log(`Has source code   : ${hasSourceCode ? `✓ YES (${sourceFileContent.split('\n').length} lines)` : '✗ NO (IR-based only)'}`);
    console.log(`Has real IR data  : ${hasRealIRData ? '✓ YES' : '✗ NO (generic risk!)'}`);
    console.log(`Contains:`);
    console.log(`  ${hasSourceCode ? '✓' : '✗'} Source code (PHASE 29)`);
    console.log(`  ${purpose      ? '✓' : '✗'} Screen purpose`);
    console.log(`  ${bizLogic     ? '✓' : '✗'} Business logic`);
    console.log(`  ${apiCalls     ? '✓' : '✗'} API calls`);
    console.log(`  ${states       ? '✓' : '✗'} UI states`);
    console.log(`  ${components.length ? '✓' : '✗'} Sub-components (${components.length})`);
    console.log(`  ${relatedStores.length ? '✓' : '✗'} Related stores (${relatedStores.length})`);
    console.log(`  ${relatedApis.length   ? '✓' : '✗'} KG API endpoints (${relatedApis.length})`);
    console.log(`  ${relatedRules.length  ? '✓' : '✗'} Business rules (${relatedRules.length})`);
    console.log(`  ${themeBlock    ? '✓' : '✗'} Design tokens`);
    console.log(`==============================\n`);

    try {
      const res = await this.ai.chat(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        maxResponseTokens,
      );
      const generated = res.content || '';

      // PHASE 28: Nettoyage immédiat de la sortie LLM avant TOUT contrôle
      const cleanResult = cleanLLMOutput(generated, `screen:${name}`);
      const cleanedGenerated = cleanResult.content;
      if (cleanResult.wasModified) {
        console.log(`[CodePlanner] Output cleaned for "${name}": ${cleanResult.linesRemoved} lines removed (${cleanResult.operations.length} ops)`);
      }

      // FIX PHASE 24 — BUG #7 RENFORCÉ: Détecter et interdire toute génération générique
      // PHASE 28: Appliquer APRÈS nettoyage (le LLM peut injecter ces patterns dans le préambule)
      const FORBIDDEN_GENERIC_PATTERNS = [
        /\bCodeMorph\s+App\b/i,               // template CodeMorph générique
        /\bPlaceholder\s+Screen\b/i,           // placeholder explicite
        /\bSkeleton\s+Screen\b/i,              // skeleton template
        /\bMock\s+Data\b/i,                    // données fictives
        /Lorem ipsum/i,                        // texte fictif
        /\bExample\s+Component\b/i,            // composant exemple
        /\bDemo\s+Screen\b/i,                  // démo
        /\bTemplate\s+Screen\b/i,              // template
        /\bSample\s+Screen\b/i,                // sample
        /\bHomeScreen\b.*\bPlaceholder\b/i,    // HomeScreen + Placeholder ensemble
        /\bDetailsScreen\b.*\bPlaceholder\b/i, // DetailsScreen + Placeholder ensemble
        // Contenu générique: fonctions/commentaires 100% inventés
        /\/\/\s*TODO:\s*implement/i,           // TODO implement sans contenu
        /\/\/\s*Add\s+your\s+content\s+here/i, // placeholder content
        /\/\/\s*Your\s+content\s+here/i,       // placeholder content variant
        /This is a\s+\w+\s+screen/i,          // description générique "This is a X screen"
        /Replace\s+this\s+with\s+your/i,      // instruction placeholder
        /\bcoming\s+soon\b/i,                  // coming soon placeholder
      ];

      // Rejeter si le contenu correspond à un pattern générique strict
      const isForbidden = FORBIDDEN_GENERIC_PATTERNS.some((p) => p.test(cleanedGenerated));
      if (isForbidden) {
        console.warn(`[CodePlanner] ⚠️  BUG#7: Forbidden generic content detected for screen "${name}" — using structured fallback`);
        return this.fallbackScreen(name, framework);
      }

      // PHASE 29: Vérifier la compression si source disponible
      if (hasSourceCode) {
        const srcLines = sourceFileContent.split('\n').length;
        const genLines = cleanedGenerated.split('\n').length;
        const ratio    = genLines / srcLines;
        if (ratio < 0.4 && srcLines > 30) {
          console.warn(`[CodePlanner] ⚠️  PHASE 29 Compression for "${name}": ${srcLines} → ${genLines} lines (${(ratio * 100).toFixed(0)}%)`);
        }
        console.log(`[CodePlanner] generateScreenFile("${name}") DONE — ${cleanedGenerated.length} chars | source=${srcLines}→${genLines} lines | tokens=${res.tokensUsed}`);
      } else {
        console.log(`[CodePlanner] generateScreenFile("${name}") DONE — ${cleanedGenerated.length} chars, tokens=${res.tokensUsed}`);
      }
      return cleanedGenerated || this.fallbackScreen(name, framework);
    } catch (err) {
      console.warn(`[CodePlanner] generateScreenFile("${name}") FAILED: ${(err as Error).message} — using fallback`);
      return this.fallbackScreen(name, framework);
    }
  }

  // ── PHASE 23: Construire le bloc de contexte design tokens pour les prompts ─
  private buildThemeContext(tokens: IRDesignTokens): string {
    const lines: string[] = [];
    if (tokens.colors?.length) {
      lines.push(`Colors: ${tokens.colors.slice(0, 8).map((c) => `${c.name}=${c.value}`).join(', ')}`);
    }
    if (tokens.palette && Object.keys(tokens.palette).length > 0) {
      lines.push(`Palette: ${Object.entries(tokens.palette).slice(0, 8).map(([k, v]) => `${k}:${v}`).join(', ')}`);
    }
    if (tokens.typography?.length) {
      lines.push(`Typography: ${tokens.typography.slice(0, 5).map((t) => {
        const parts = [t.fontFamily, t.fontSize ? `${t.fontSize}px` : '', t.fontWeight ? `w=${t.fontWeight}` : ''].filter(Boolean).join('/');
        return `${t.name}=${parts}`;
      }).join(', ')}`);
    }
    if (tokens.spacing?.length) {
      lines.push(`Spacing: ${tokens.spacing.slice(0, 6).map((s) => `${s.name}=${s.value}px`).join(', ')}`);
    }
    return lines.join('\n');
  }

  private async generateComponentFile(_ctx: ConversionContext, name: string, props: Array<{ name: string; type: string; required: boolean }>, framework: string): Promise<string> {
    if (this.ai.getTier() === 'static') return this.fallbackComponent(name);
    const propTypes = props.map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type}`).join('; ');
    // PHASE 23: Prompt V3 pour les composants — vraies props + events depuis l'IR
    const systemPrompt = `You are an AI Software Architect. Generate production-ready ${framework === 'react' ? 'React + TypeScript + TailwindCSS' : 'React Native + TypeScript'} UI components. NEVER use placeholders or TODOs. Return ONLY the complete file content — no markdown, no explanations.`;
    const prompt = `Generate a ${framework === 'react' ? 'React + TypeScript + TailwindCSS' : 'React Native + TypeScript'} UI component named "${name}".
Props interface: { ${propTypes || 'children?: React.ReactNode'} }
Requirements: TypeScript strict, accessible, no TODO, no placeholder.
Return ONLY the complete file content.`;
    try {
      const res = await this.ai.chat([{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }], 900);
      // PHASE 28: Nettoyage obligatoire de la sortie LLM
      const cleaned = cleanLLMOutput(res.content || '', `component:${name}`).content;
      return cleaned || this.fallbackComponent(name);
    } catch {
      return this.fallbackComponent(name);
    }
  }

  // ── Static generators (no AI) — PHASE 22: Prompt Maître V2 ───────────────
  // Jamais de "// TODO: define state shape from IR" ou "/* TODO */"
  private generateZustandStore(storeName: string, actions: string[]): string {
    const pascal = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    const storeNameP = pascal(storeName);
    const slug = storeName.toLowerCase().replace(/store$/, '');

    const actionDefs = actions.length > 0
      ? actions.map((a) => `  ${a}: () => void`).join(';\n  ') + ';'
      : `  load: () => void;\n  reset: () => void;`;

    const actionImpls = actions.length > 0
      ? actions.map((a) => {
          const isAsync = /^(fetch|load|get|refresh)/.test(a);
          return isAsync
            ? `  ${a}: async () => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(\`/api/${slug}\`);
      const data = await res.json() as unknown;
      set({ data, loading: false });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },`
            : `  ${a}: () => set({}),`;
        }).join('\n')
      : `  load: async () => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(\`/api/${slug}\`);
      const data = await res.json() as unknown;
      set({ data, loading: false });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },
  reset: () => set({ data: null, loading: false, error: null }),`;

    return `import { create } from 'zustand';

interface ${storeNameP}State {
  data: unknown;
  loading: boolean;
  error: string | null;
  ${actionDefs}
}

export const use${storeNameP}Store = create<${storeNameP}State>((set) => ({
  data:    null,
  loading: false,
  error:   null,
${actionImpls}
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

  // BUG-P27-10 FIX: AppModule dynamique avec vrais modules injectés
  private generateNestAppModule(moduleNames: string[]): string {
    const importLines = moduleNames.map((n) => {
      const pascal = this.pascal(n);
      return `import { ${pascal}Module } from './modules/${n.toLowerCase()}/${n.toLowerCase()}.module';`;
    }).join('\n');
    const moduleList = moduleNames.map((n) => `    ${this.pascal(n)}Module,`).join('\n');
    return `import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
${importLines}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env['DATABASE_URL'],
      autoLoadEntities: true,
      synchronize: process.env['NODE_ENV'] !== 'production',
    }),
${moduleList}
  ],
})
export class AppModule {}
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
        // PHASE 22: Générer une vraie implémentation — jamais de TODO/throw
    const methods = svc?.methods.map((m) => {
      const httpMethod = /^(create|add|save)/.test(m.name) ? 'post'
        : /^(update|edit)/.test(m.name) ? 'put'
        : /^(delete|remove)/.test(m.name) ? 'delete'
        : 'get';
      const hasBody = ['post', 'put', 'patch'].includes(httpMethod);
      const paramStr = m.params.map((p) => `${p.name}: ${p.type}`).join(', ');
      const bodyArg  = hasBody && m.params.length > 0 ? (m.params[0]?.name ?? '') : '';
      return `  ${m.async ? 'async ' : ''}${m.name}(${paramStr}): Promise<${m.returnType}> {
    return this.repository.${httpMethod === 'get' ? 'find' : m.name}(${bodyArg});
  }`;
    }).join('\n\n') ?? `  async findAll(): Promise<unknown[]> {\n    return this.repository.find();\n  }`;
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
    ${migration.sql ?? '// Migration SQL — configure your table creation logic here'}
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse of: ${migration.description}
  }
}
`;
  }

  // ── PHASE 28: Conversion d'un fichier source avec chunking automatique ──────
  // Si le fichier source dépasse la limite du modèle → découpage automatique
  // Si conversion directe suffit → utilisation normale
  // RÈGLE: jamais produire une version résumée — TODOs si nécessaire
  private async generateSourceFileWithChunking(
    ctx:             ConversionContext,
    sourceContent:   string,
    sourceLanguage:  string,
    targetName:      string,
    framework:       string,
    irContext?:      string,
  ): Promise<string> {
    const tier = this.ai.getTier();
    const requiresChunking = needsChunking(sourceContent, tier);

    if (!requiresChunking) {
      // Fichier dans les limites — conversion directe
      return ''; // signal pour le caller d'utiliser generateScreenFile
    }

    // ── Gros fichier → conversion par chunks ────────────────
    console.log(`[CodePlanner] PHASE 28: Large file detected for "${targetName}" (${sourceContent.length} chars) — activating file chunker`);

    const assemblyResult = await convertLargeFile(
      sourceContent,
      sourceLanguage,
      framework,
      ctx.sourceFramework,
      this.ai,
      `${targetName} (${framework} screen/component)`,
      irContext,
    );

    if (assemblyResult.content) {
      // Nettoyer le résultat assemblé
      const cleaned = cleanLLMOutput(assemblyResult.content, `chunked:${targetName}`).content;

      console.log(`[CodePlanner] Chunked conversion complete for "${targetName}": ${assemblyResult.totalChunks} chunks, ${assemblyResult.successfulChunks} ok, ${assemblyResult.todosInserted} TODOs`);
      console.log(`[CodePlanner] Lines: ${assemblyResult.sourceLines} source → ${assemblyResult.generatedLines} generated (${Math.round(assemblyResult.preservationRatio * 100)}% preserved)`);

      if (assemblyResult.todosInserted > 0) {
        console.warn(`[CodePlanner] ⚠️  ${assemblyResult.todosInserted} function(s) could not be auto-converted — marked with TODO(codeMorph) for manual review`);
      }

      return cleaned;
    }

    return ''; // Fallback vers la méthode normale si chunking n'a rien produit
  }

  // ── PHASE 28: fallbackScreen() — squelette fonctionnel basé sur l'IR ────
  // BUG-P27-11 FIX: l'endpoint API n'est plus inventé génériquement
  // Il est tiré du nom de l'écran + patterns du projet source
  private fallbackScreen(name: string, framework: string, irContext?: IRDocument): string {
    // Utiliser le vrai nom de l'écran avec un layout professionnel
    const cleanName = name.replace(/Screen$/i, '');
    // BUG-P27-11 FIX: chercher un endpoint réel dans l'IR
    const screenRoutes = irContext?.backendGraph?.routes?.filter((r) =>
      r.path.toLowerCase().includes(cleanName.toLowerCase())
    ) ?? [];
    const apiEndpoint = screenRoutes.length > 0
      ? screenRoutes[0]!.path
      : `/${cleanName.toLowerCase()}`;
    if (framework === 'react') {
      return `import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../lib/api';

/**
 * ${name} — Auto-generated from source analysis
 * Source: ${name}
 */
export function ${name}(): React.JSX.Element {
  const [data, setData] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        // API endpoint derived from source analysis
        const res = await apiClient.get('${apiEndpoint}');
        setData(res.data);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, []);

  if (loading) return <div className="flex min-h-screen items-center justify-center"><div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" /></div>;
  if (error) return <div className="flex min-h-screen items-center justify-center"><p className="text-destructive">{error}</p></div>;

  return (
    <main className="container mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">${cleanName}</h1>
      <div className="space-y-4">
        {Array.isArray(data) ? data.map((item, i) => (
          <div key={i} className="rounded-lg border p-4 shadow-sm">
            <pre className="text-sm">{JSON.stringify(item, null, 2)}</pre>
          </div>
        )) : null}
      </div>
    </main>
  );
}
`;
    }
    // React Native
    return `import React, { useState, useEffect } from 'react';
import { View, Text, FlatList, ActivityIndicator, StyleSheet, type ListRenderItem } from 'react-native';
import { apiClient } from '../src/lib/api';
import { colors, spacing } from '../src/theme';

/**
 * ${name} — Auto-generated from source analysis
 */
export default function ${cleanName}(): React.JSX.Element {
  const [data, setData] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await apiClient.get<unknown[]>('${apiEndpoint}');
        setData(res.data);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const renderItem: ListRenderItem<unknown> = ({ item }) => (
    <View style={s.item}>
      <Text style={s.itemText}>{JSON.stringify(item)}</Text>
    </View>
  );

  if (loading) return <View style={s.center}><ActivityIndicator size="large" color={colors.primary} /></View>;
  if (error)   return <View style={s.center}><Text style={s.errorText}>{error}</Text></View>;

  return (
    <View style={s.container}>
      <Text style={s.title}>${cleanName}</Text>
      <FlatList
        data={data}
        renderItem={renderItem}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={s.list}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, padding: spacing.md },
  center:    { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title:     { fontSize: 22, fontWeight: '700', color: colors.text, marginBottom: spacing.md },
  list:      { paddingBottom: spacing.xl },
  item:      { backgroundColor: colors.surface, borderRadius: 8, padding: spacing.md, marginBottom: spacing.sm, borderWidth: 1, borderColor: colors.border },
  itemText:  { color: colors.textMuted, fontSize: 12 },
  errorText: { color: colors.error, textAlign: 'center' },
});
`;
  }

  private fallbackComponent(name: string): string {
    // PHASE 22: Composant fonctionnel minimal — jamais un composant vide avec juste un commentaire
    return `import React from 'react';

interface ${name}Props {
  className?: string;
  children?: React.ReactNode;
  [key: string]: unknown;
}

/**
 * ${name} — Auto-generated from source analysis
 */
export function ${name}({ className, children, ...props }: ${name}Props): React.JSX.Element {
  return (
    <div
      className={['rounded-lg border border-border bg-card p-4 shadow-sm', className].filter(Boolean).join(' ')}
      {...props}
    >
      {children}
    </div>
  );
}
`;
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
  private rnAppJson(name: string): string { return JSON.stringify({ expo: { name, slug: name.toLowerCase().replace(/\s+/g, '-'), version: '1.0.0', orientation: 'portrait', icon: './assets/icon.png', splash: { image: './assets/splash.png', resizeMode: 'contain', backgroundColor: '#0f172a' }, platforms: ['ios', 'android'], sdkVersion: '50.0.0' } }, null, 2); }
  private nestPackageJson(name: string): string { return JSON.stringify({ name, version: '0.0.1', private: true, scripts: { build: 'nest build', start: 'nest start', 'start:dev': 'nest start --watch', 'start:prod': 'node dist/main' }, dependencies: { '@nestjs/common': '^10.0.0', '@nestjs/core': '^10.0.0', '@nestjs/platform-express': '^10.0.0', '@nestjs/config': '^3.0.0', '@nestjs/jwt': '^10.0.0', '@nestjs/passport': '^10.0.0', '@nestjs/swagger': '^7.0.0', '@nestjs/typeorm': '^10.0.0', typeorm: '^0.3.0', pg: '^8.11.0', 'reflect-metadata': '^0.2.0', rxjs: '^7.8.0', 'class-validator': '^0.14.0', 'class-transformer': '^0.5.0' }, devDependencies: { '@nestjs/cli': '^10.0.0', '@nestjs/schematics': '^10.0.0', '@nestjs/testing': '^10.0.0', typescript: '^5.4.0' } }, null, 2); }

  // PHASE 30: Flutter helpers (delegates to module-level functions for clean strings)
  private flutterPubspec(name: string): string { return flutterPubspecTemplate(name); }
  private flutterMain(name: string): string    { return flutterMainTemplate(name); }
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
const RN_BABEL_CONFIG = `module.exports = function(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['expo-router/babel'],
  };
};
`;
const RN_API_CLIENT = `import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';

const BASE_URL = process.env['EXPO_PUBLIC_API_URL'] ?? 'http://localhost:4000/api/v1';

export const apiClient = axios.create({
  baseURL: BASE_URL,
  timeout: 10_000,
  headers: { 'Content-Type': 'application/json' },
});

apiClient.interceptors.request.use(async (config) => {
  const token = await AsyncStorage.getItem('auth_token');
  if (token) config.headers.Authorization = \`Bearer \${token}\`;
  return config;
});

apiClient.interceptors.response.use(
  (res) => res,
  (err) => Promise.reject(err),
);
`;
const RN_STORAGE = `import AsyncStorage from '@react-native-async-storage/async-storage';

export async function getItem<T>(key: string): Promise<T | null> {
  try {
    const val = await AsyncStorage.getItem(key);
    return val ? JSON.parse(val) as T : null;
  } catch { return null; }
}

export async function setItem<T>(key: string, value: T): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(value));
}

export async function removeItem(key: string): Promise<void> {
  await AsyncStorage.removeItem(key);
}
`;
const RN_USE_API_HOOK = `import { useState, useCallback } from 'react';

export function useApi<T, A extends unknown[]>(
  fn: (...args: A) => Promise<T>
): { data: T | null; loading: boolean; error: string | null; execute: (...args: A) => Promise<void> } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const execute = useCallback(async (...args: A) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fn(...args);
      setData(result);
    } catch (err) {
      setError((err as Error).message ?? 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [fn]);

  return { data, loading, error, execute };
}
`;
const RN_THEME_COLORS = `export const colors = {
  primary:    '#6366f1',
  secondary:  '#8b5cf6',
  background: '#0f172a',
  surface:    '#1e293b',
  border:     '#334155',
  text:       '#f1f5f9',
  textMuted:  '#94a3b8',
  success:    '#22c55e',
  warning:    '#f59e0b',
  error:      '#ef4444',
  white:      '#ffffff',
};
`;
const RN_THEME_SPACING = `export const spacing = {
  xs:  4,
  sm:  8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

export const borderRadius = {
  sm:  4,
  md:  8,
  lg: 12,
  xl: 16,
  full: 9999,
};
`;
const RN_BUTTON_COMPONENT = `import React from 'react';
import { TouchableOpacity, Text, ActivityIndicator, StyleSheet, type TouchableOpacityProps } from 'react-native';
import { colors, spacing, borderRadius } from '../../theme';

interface ButtonProps extends TouchableOpacityProps {
  title: string;
  variant?: 'primary' | 'secondary' | 'outline';
  loading?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

export function Button({ title, variant = 'primary', loading = false, size = 'md', disabled, ...props }: ButtonProps): React.JSX.Element {
  return (
    <TouchableOpacity
      {...props}
      disabled={disabled || loading}
      style={[s.base, s[variant], s[\`size_\${size}\`], (disabled || loading) && s.disabled]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'outline' ? colors.primary : colors.white} size="small" />
      ) : (
        <Text style={[s.text, variant === 'outline' && s.textOutline]}>{title}</Text>
      )}
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  base:       { borderRadius: borderRadius.md, alignItems: 'center', justifyContent: 'center' },
  primary:    { backgroundColor: colors.primary },
  secondary:  { backgroundColor: colors.secondary },
  outline:    { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.primary },
  size_sm:    { paddingVertical: spacing.xs,  paddingHorizontal: spacing.sm },
  size_md:    { paddingVertical: spacing.sm,  paddingHorizontal: spacing.md },
  size_lg:    { paddingVertical: spacing.md,  paddingHorizontal: spacing.lg },
  disabled:   { opacity: 0.5 },
  text:       { color: colors.white,   fontWeight: '600' },
  textOutline:{ color: colors.primary, fontWeight: '600' },
});
`;
const RN_TEXT_INPUT_COMPONENT = `import React from 'react';
import { TextInput as RNTextInput, View, Text, StyleSheet, type TextInputProps } from 'react-native';
import { colors, spacing, borderRadius } from '../../theme';

interface InputProps extends TextInputProps {
  label?: string;
  error?: string;
}

export function TextInput({ label, error, style, ...props }: InputProps): React.JSX.Element {
  return (
    <View style={s.container}>
      {label ? <Text style={s.label}>{label}</Text> : null}
      <RNTextInput
        {...props}
        style={[s.input, error ? s.inputError : null, style]}
        placeholderTextColor={colors.textMuted}
      />
      {error ? <Text style={s.error}>{error}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  container: { marginBottom: spacing.sm },
  label:     { color: colors.text, fontWeight: '500', marginBottom: spacing.xs },
  input:     { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: borderRadius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, color: colors.text },
  inputError:{ borderColor: colors.error },
  error:     { color: colors.error, fontSize: 12, marginTop: spacing.xs },
});
`;
const RN_CARD_COMPONENT = `import React from 'react';
import { View, StyleSheet, type ViewProps } from 'react-native';
import { colors, spacing, borderRadius } from '../../theme';

export function Card({ children, style, ...props }: ViewProps): React.JSX.Element {
  return (
    <View {...props} style={[s.card, style]}>
      {children}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius:    borderRadius.lg,
    padding:         spacing.md,
    borderWidth:     1,
    borderColor:     colors.border,
  },
});
`;
const RN_LOADING_SPINNER = `import React from 'react';
import { ActivityIndicator, View, StyleSheet } from 'react-native';
import { colors } from '../../theme';

export function LoadingSpinner({ size = 'large' }: { size?: 'small' | 'large' }): React.JSX.Element {
  return (
    <View style={s.container}>
      <ActivityIndicator size={size} color={colors.primary} />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
`;
const RN_ERROR_MESSAGE = `import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, spacing, borderRadius } from '../../theme';

export function ErrorMessage({ message }: { message: string }): React.JSX.Element {
  return (
    <View style={s.container}>
      <Text style={s.text}>⚠️ {message}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  container: { backgroundColor: colors.error + '20', borderRadius: borderRadius.md, padding: spacing.md, borderWidth: 1, borderColor: colors.error },
  text:      { color: colors.error, fontWeight: '500' },
});
`;
const RN_CONSTANTS = `export const APP_NAME   = process.env['EXPO_PUBLIC_APP_NAME'] ?? 'My App';
export const API_URL    = process.env['EXPO_PUBLIC_API_URL'] ?? 'http://localhost:4000/api/v1';
export const TOKEN_KEY  = 'auth_token';
export const USER_KEY   = 'auth_user';
`;
const RN_TYPES_INDEX = `// Central type exports
export * from './index';

export interface ApiResponse<T> {
  data:    T;
  message: string;
  success: boolean;
}

export interface PaginatedResponse<T> {
  items:   T[];
  total:   number;
  page:    number;
  perPage: number;
}
`;
const RN_ENV_EXAMPLE = `EXPO_PUBLIC_API_URL=http://localhost:4000/api/v1
EXPO_PUBLIC_APP_NAME=MyApp
`;

const RN_TAB_LAYOUT = `import { Tabs } from 'expo-router';\nimport React from 'react';\nexport default function TabLayout(): React.JSX.Element { return <Tabs><Tabs.Screen name="index" options={{ title: 'Home' }} /></Tabs>; }\n`;
// BUG-P27-09 FIX: RN_INDEX ne doit PAS être un écran générique "Home" vide.
// Il sert de point d'entrée qui redirige vers le premier écran réel de l'appli.
// Le nom de l'écran initial est injecté dynamiquement par generateRNRootLayoutFromNames().
const RN_INDEX_TEMPLATE = (firstScreen: string): string =>
  `import React, { useEffect } from 'react';\nimport { useRouter } from 'expo-router';\n\n/**\n * Entry point — redirects to the first app screen after initialization\n */\nexport default function Index(): React.JSX.Element {\n  const router = useRouter();\n  useEffect(() => {\n    // Redirect to main screen immediately\n    router.replace('/${firstScreen.toLowerCase().replace(/screen$/i, '')}');\n  }, [router]);\n  return <></>;\n}\n`;
const NEST_TSCONFIG = `{"compilerOptions":{"module":"CommonJS","declaration":true,"removeComments":true,"emitDecoratorMetadata":true,"experimentalDecorators":true,"allowSyntheticDefaultImports":true,"target":"ES2021","sourceMap":true,"outDir":"./dist","baseUrl":"./","strict":true,"skipLibCheck":true,"forceConsistentCasingInFileNames":true}}`;
const NEST_MAIN = `import { NestFactory } from '@nestjs/core';\nimport { ValidationPipe } from '@nestjs/common';\nimport { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';\nimport { AppModule } from './app.module';\nasync function bootstrap(): Promise<void> {\n  const app = await NestFactory.create(AppModule);\n  app.setGlobalPrefix('api/v1');\n  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));\n  const config = new DocumentBuilder().setTitle('API').setVersion('1.0').addBearerAuth().build();\n  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));\n  await app.listen(4000);\n  console.log('🚀 NestJS running on http://localhost:4000');\n}\nboostrap();\n`;
// BUG-P27-10 FIX: NEST_APP_MODULE remplacé par CodePlanner.generateNestAppModule() dynamique
// (constante statique supprimée — utiliser la méthode de classe qui injecte les vrais modules)

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 30: Flutter Static Templates
// ══════════════════════════════════════════════════════════════════════════════

function flutterPubspecTemplate(projectName: string): string {
  return `name: ${projectName}
description: Flutter app generated by CodeMorph Phase 30
publish_to: 'none'
version: 1.0.0+1

environment:
  sdk: '>=3.0.0 <4.0.0'
  flutter: '>=3.24.0'

dependencies:
  flutter:
    sdk: flutter
  flutter_riverpod: ^2.5.1
  go_router: ^14.2.0
  dio: ^5.4.3
  shared_preferences: ^2.2.3
  connectivity_plus: ^6.0.3
  intl: ^0.19.0
  logger: ^2.4.0
  flutter_secure_storage: ^9.2.2
  cached_network_image: ^3.3.1
  equatable: ^2.0.5

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^4.0.0

flutter:
  uses-material-design: true
  assets:
    - assets/images/
    - assets/icons/
`;
}

function flutterMainTemplate(projectName: string): string {
  const appName = projectName.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return `import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'config/router.dart';
import 'config/theme.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(
    const ProviderScope(
      child: ${appName.replace(/\s/g, '')}App(),
    ),
  );
}

class ${appName.replace(/\s/g, '')}App extends ConsumerWidget {
  const ${appName.replace(/\s/g, '')}App({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(routerProvider);
    return MaterialApp.router(
      title: '${appName}',
      theme: AppTheme.lightTheme,
      darkTheme: AppTheme.darkTheme,
      routerConfig: router,
      debugShowCheckedModeBanner: false,
    );
  }
}
`;
}

const FLUTTER_ANALYSIS_OPTIONS = `include: package:flutter_lints/flutter.yaml

analyzer:
  strong-mode:
    implicit-casts: false
    implicit-dynamic: false
  errors:
    missing_required_param: error
    missing_return: error

linter:
  rules:
    - always_declare_return_types
    - avoid_print
    - prefer_const_constructors
    - prefer_final_fields
    - use_key_in_widget_constructors
`;

const FLUTTER_APP_CONFIG = `/// Application configuration — CodeMorph Phase 30
class AppConfig {
  static const String apiBaseUrl    = String.fromEnvironment('API_URL', defaultValue: 'http://localhost:4000/api/v1');
  static const String appName       = String.fromEnvironment('APP_NAME', defaultValue: 'App');
  static const Duration apiTimeout  = Duration(seconds: 30);
  static const int maxRetries       = 3;
  static const String tokenKey      = 'auth_token';
  static const String refreshKey    = 'refresh_token';
  static const String userKey       = 'current_user';
}
`;

const FLUTTER_THEME = `import 'package:flutter/material.dart';

/// AppTheme — CodeMorph Phase 30
class AppTheme {
  static const Color primary     = Color(0xFF2563EB);
  static const Color secondary   = Color(0xFF10B981);
  static const Color error       = Color(0xFFEF4444);
  static const Color background  = Color(0xFFF9FAFB);
  static const Color surface     = Colors.white;
  static const Color textPrimary = Color(0xFF111827);
  static const Color textSecondary = Color(0xFF6B7280);

  static ThemeData get lightTheme => ThemeData(
    useMaterial3: true,
    colorScheme: ColorScheme.fromSeed(seedColor: primary),
    scaffoldBackgroundColor: background,
    appBarTheme: const AppBarTheme(
      backgroundColor: Colors.white,
      foregroundColor: textPrimary,
      elevation: 0,
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: primary,
        foregroundColor: Colors.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
    ),
  );

  static ThemeData get darkTheme => ThemeData.dark(useMaterial3: true).copyWith(
    colorScheme: ColorScheme.fromSeed(seedColor: primary, brightness: Brightness.dark),
  );
}
`;

const FLUTTER_DIO_CLIENT = `import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../config/app_config.dart' show AppConfig;

/// DioClient — HTTP client with auth interceptor (CodeMorph Phase 30)
class DioClient {
  late final Dio _dio;

  DioClient() {
    _dio = Dio(BaseOptions(
      baseUrl: AppConfig.apiBaseUrl,
      connectTimeout: AppConfig.apiTimeout,
      receiveTimeout: AppConfig.apiTimeout,
      headers: {'Content-Type': 'application/json'},
    ));
    _dio.interceptors.addAll([_AuthInterceptor(), LogInterceptor(requestBody: false, responseBody: false)]);
  }

  Dio get dio => _dio;
}

class _AuthInterceptor extends Interceptor {
  @override
  Future<void> onRequest(RequestOptions options, RequestInterceptorHandler handler) async {
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString(AppConfig.tokenKey);
    if (token != null) {
      options.headers['Authorization'] = 'Bearer \$token';
    }
    handler.next(options);
  }

  @override
  void onError(DioException err, ErrorInterceptorHandler handler) {
    if (err.response?.statusCode == 401) {
      // Token expired — clear and redirect to login
    }
    handler.next(err);
  }
}

final dioClientProvider = Provider<Dio>((ref) {
  return DioClient().dio;
});
`;

const FLUTTER_API_ENDPOINTS = `/// API Endpoints — CodeMorph Phase 30
class ApiEndpoints {
  static const String auth    = '/auth';
  static const String login   = '/auth/login';
  static const String register = '/auth/register';
  static const String refresh = '/auth/refresh';
  static const String profile = '/auth/profile';
  static const String logout  = '/auth/logout';
}
`;

const FLUTTER_APP_EXCEPTION = `/// AppException — unified error handling (CodeMorph Phase 30)
class AppException implements Exception {
  final String message;
  final int? statusCode;
  final String? code;

  const AppException({
    required this.message,
    this.statusCode,
    this.code,
  });

  factory AppException.fromDioError(dynamic error) {
    if (error.response != null) {
      final status = error.response.statusCode as int;
      final data = error.response.data;
      final msg = data is Map ? (data['message'] ?? data['error'] ?? 'Server error') as String : 'Server error';
      return AppException(message: msg, statusCode: status, code: 'HTTP_\$status');
    }
    if (error.type.toString().contains('connectTimeout') || error.type.toString().contains('receiveTimeout')) {
      return const AppException(message: 'Connection timeout. Check your internet.', code: 'TIMEOUT');
    }
    return AppException(message: error.message?.toString() ?? 'Network error', code: 'NETWORK');
  }

  bool get isUnauthorized => statusCode == 401;
  bool get isNotFound     => statusCode == 404;
  bool get isServerError  => (statusCode ?? 0) >= 500;

  @override
  String toString() => 'AppException(message: \$message, status: \$statusCode)';
}
`;

const FLUTTER_LOCAL_STORAGE = `import 'dart:convert';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// LocalStorage — wrapper around SharedPreferences (CodeMorph Phase 30)
class LocalStorage {
  static SharedPreferences? _prefs;

  static Future<void> init() async {
    _prefs ??= await SharedPreferences.getInstance();
  }

  static SharedPreferences get prefs {
    if (_prefs == null) throw StateError('LocalStorage not initialized. Call LocalStorage.init() first.');
    return _prefs!;
  }

  static Future<void> setString(String key, String value) async => prefs.setString(key, value);
  static String? getString(String key) => prefs.getString(key);

  static Future<void> setObject<T>(String key, T value) async {
    final json = jsonEncode(value);
    await prefs.setString(key, json);
  }

  static T? getObject<T>(String key, T Function(Map<String, dynamic>) fromJson) {
    final json = prefs.getString(key);
    if (json == null) return null;
    try {
      return fromJson(jsonDecode(json) as Map<String, dynamic>);
    } catch (_) { return null; }
  }

  static Future<void> remove(String key) async => prefs.remove(key);
  static Future<void> clear() async => prefs.clear();
  static bool hasKey(String key) => prefs.containsKey(key);
}

final localStorageProvider = Provider<LocalStorage>((_) => LocalStorage());
`;

const FLUTTER_VALIDATORS = `/// Validators — CodeMorph Phase 30
class Validators {
  static final _emailRegex = RegExp(r'^[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}\$');
  static final _phoneRegex = RegExp(r'^[\\+]?[(]?[0-9]{3}[)]?[\\-\\s\\.]?[0-9]{3}[\\-\\s\\.]?[0-9]{4,6}\$');

  static String? required(String? value, [String? fieldName]) {
    if (value == null || value.trim().isEmpty) return '\${fieldName ?? 'Field'} is required';
    return null;
  }

  static String? email(String? value) {
    if (value == null || value.trim().isEmpty) return 'Email is required';
    if (!_emailRegex.hasMatch(value.trim())) return 'Invalid email address';
    return null;
  }

  static String? password(String? value) {
    if (value == null || value.isEmpty) return 'Password is required';
    if (value.length < 8) return 'Password must be at least 8 characters';
    if (!RegExp(r'[A-Z]').hasMatch(value)) return 'Must contain uppercase letter';
    if (!RegExp(r'[0-9]').hasMatch(value)) return 'Must contain a number';
    return null;
  }

  static String? minLength(String? value, int min, [String? fieldName]) {
    if (value == null || value.length < min) return '\${fieldName ?? 'Field'} must be at least \$min characters';
    return null;
  }

  static String? maxLength(String? value, int max, [String? fieldName]) {
    if (value != null && value.length > max) return '\${fieldName ?? 'Field'} must be at most \$max characters';
    return null;
  }

  static String? phone(String? value) {
    if (value == null || value.trim().isEmpty) return 'Phone is required';
    if (!_phoneRegex.hasMatch(value.trim())) return 'Invalid phone number';
    return null;
  }

  static String? Function(String?) compose(List<String? Function(String?)> validators) {
    return (value) {
      for (final v in validators) {
        final err = v(value);
        if (err != null) return err;
      }
      return null;
    };
  }
}
`;

const FLUTTER_FORMATTERS = `import 'package:intl/intl.dart';

/// Formatters — CodeMorph Phase 30
class Formatters {
  static final _currencyFmt = NumberFormat.currency(locale: 'en_US', symbol: '\$');
  static final _numberFmt   = NumberFormat('#,##0.##');
  static final _dateFmt     = DateFormat('MMM d, yyyy');
  static final _timeFmt     = DateFormat('h:mm a');
  static final _dateTimeFmt = DateFormat('MMM d, yyyy h:mm a');

  static String currency(num value)   => _currencyFmt.format(value);
  static String number(num value)     => _numberFmt.format(value);
  static String date(DateTime dt)     => _dateFmt.format(dt);
  static String time(DateTime dt)     => _timeFmt.format(dt);
  static String dateTime(DateTime dt) => _dateTimeFmt.format(dt);

  static String relativeTime(DateTime dt) {
    final diff = DateTime.now().difference(dt);
    if (diff.inSeconds < 60)  return 'just now';
    if (diff.inMinutes < 60)  return '\${diff.inMinutes}m ago';
    if (diff.inHours < 24)    return '\${diff.inHours}h ago';
    if (diff.inDays < 30)     return '\${diff.inDays}d ago';
    return _dateFmt.format(dt);
  }

  static String fileSize(int bytes) {
    if (bytes < 1024)       return '\$bytes B';
    if (bytes < 1048576)    return '\${(bytes / 1024).toStringAsFixed(1)} KB';
    if (bytes < 1073741824) return '\${(bytes / 1048576).toStringAsFixed(1)} MB';
    return '\${(bytes / 1073741824).toStringAsFixed(1)} GB';
  }

  static String initials(String name) {
    return name.trim().split(RegExp(r'\\s+')).where((w) => w.isNotEmpty).take(2).map((w) => w[0].toUpperCase()).join();
  }
}
`;

const FLUTTER_AUTH_PROVIDER = `import 'dart:convert';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../core/network/dio_client.dart';
import '../core/network/api_endpoints.dart';
import '../core/error/app_exception.dart';

/// AuthState — CodeMorph Phase 30
class AuthState {
  final Map<String, dynamic>? user;
  final String? token;
  final bool isAuthenticated;
  final bool isLoading;
  final String? error;

  const AuthState({
    this.user,
    this.token,
    this.isAuthenticated = false,
    this.isLoading = false,
    this.error,
  });

  AuthState copyWith({Map<String, dynamic>? user, String? token, bool? isAuthenticated, bool? isLoading, String? error}) {
    return AuthState(
      user: user ?? this.user,
      token: token ?? this.token,
      isAuthenticated: isAuthenticated ?? this.isAuthenticated,
      isLoading: isLoading ?? this.isLoading,
      error: error,
    );
  }
}

/// AuthNotifier — Riverpod auth state (CodeMorph Phase 30)
class AuthNotifier extends StateNotifier<AuthState> {
  final Ref _ref;

  AuthNotifier(this._ref) : super(const AuthState()) {
    _loadStoredAuth();
  }

  Future<void> _loadStoredAuth() async {
    final prefs = await SharedPreferences.getInstance();
    final token  = prefs.getString('auth_token');
    final userStr = prefs.getString('current_user');
    if (token != null && userStr != null) {
      final user = jsonDecode(userStr) as Map<String, dynamic>;
      state = AuthState(user: user, token: token, isAuthenticated: true);
    }
  }

  Future<bool> login(String email, String password) async {
    state = state.copyWith(isLoading: true, error: null);
    try {
      final dio = _ref.read(dioClientProvider);
      final response = await dio.post<Map<String, dynamic>>(
        ApiEndpoints.login,
        data: {'email': email, 'password': password},
      );
      final data  = response.data!;
      final token = data['token'] as String? ?? data['accessToken'] as String? ?? '';
      final user  = data['user'] as Map<String, dynamic>? ?? {};
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('auth_token', token);
      await prefs.setString('current_user', jsonEncode(user));
      state = AuthState(user: user, token: token, isAuthenticated: true);
      return true;
    } catch (e) {
      final err = e is Exception ? AppException.fromDioError(e).message : e.toString();
      state = state.copyWith(isLoading: false, error: err);
      return false;
    }
  }

  Future<void> logout() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('auth_token');
    await prefs.remove('current_user');
    state = const AuthState();
  }
}

final authProvider = StateNotifierProvider<AuthNotifier, AuthState>(
  (ref) => AuthNotifier(ref),
);
`;

const FLUTTER_CONNECTIVITY_PROVIDER = `import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Connectivity provider — offline detection (CodeMorph Phase 30)
final connectivityProvider = StreamProvider<ConnectivityResult>((ref) {
  return Connectivity().onConnectivityChanged.map((results) => results.isNotEmpty ? results.first : ConnectivityResult.none);
});

final isOnlineProvider = Provider<bool>((ref) {
  return ref.watch(connectivityProvider).when(
    data: (result) => result != ConnectivityResult.none,
    loading: () => true,
    error: (_, __) => true,
  );
});
`;

const FLUTTER_LOADING_WIDGET = `import 'package:flutter/material.dart';

/// LoadingWidget — CodeMorph Phase 30
class LoadingWidget extends StatelessWidget {
  final String? message;
  const LoadingWidget({super.key, this.message});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const CircularProgressIndicator(),
          if (message != null) ...[
            const SizedBox(height: 16),
            Text(message!, style: Theme.of(context).textTheme.bodyMedium),
          ],
        ],
      ),
    );
  }
}
`;

const FLUTTER_ERROR_WIDGET_DART = `import 'package:flutter/material.dart';

/// AppErrorWidget — CodeMorph Phase 30
class AppErrorWidget extends StatelessWidget {
  final String message;
  final VoidCallback? onRetry;

  const AppErrorWidget({super.key, required this.message, this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.error_outline, color: Colors.red, size: 48),
            const SizedBox(height: 16),
            Text(message, textAlign: TextAlign.center, style: const TextStyle(color: Colors.red)),
            if (onRetry != null) ...[
              const SizedBox(height: 16),
              ElevatedButton.icon(
                onPressed: onRetry,
                icon: const Icon(Icons.refresh),
                label: const Text('Retry'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
`;

const FLUTTER_EMPTY_STATE_WIDGET = `import 'package:flutter/material.dart';

/// EmptyStateWidget — CodeMorph Phase 30
class EmptyStateWidget extends StatelessWidget {
  final String title;
  final String? subtitle;
  final IconData icon;
  final VoidCallback? onAction;
  final String? actionLabel;

  const EmptyStateWidget({
    super.key,
    required this.title,
    this.subtitle,
    this.icon = Icons.inbox_outlined,
    this.onAction,
    this.actionLabel,
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, size: 64, color: Colors.grey[400]),
            const SizedBox(height: 16),
            Text(title, style: Theme.of(context).textTheme.titleMedium, textAlign: TextAlign.center),
            if (subtitle != null) ...[
              const SizedBox(height: 8),
              Text(subtitle!, style: Theme.of(context).textTheme.bodySmall, textAlign: TextAlign.center),
            ],
            if (onAction != null) ...[
              const SizedBox(height: 24),
              ElevatedButton(onPressed: onAction, child: Text(actionLabel ?? 'Add')),
            ],
          ],
        ),
      ),
    );
  }
}
`;

