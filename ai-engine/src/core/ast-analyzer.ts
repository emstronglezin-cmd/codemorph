// ============================================================
// CodeMorph AI Engine — AST Analyzer
// Analyzes source code structure using AI + static analysis
// PHASE 22: Prompt Maître V2 — extraction complète
// Détecte: Bloc/Cubit/Riverpod/GetX/MobX/Firebase/Supabase/GraphQL/WebSocket/gRPC/OAuth/JWT
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
  // ── PHASE 22: Enrichissement extraction ──────────────
  statePatterns:  string[];   // Bloc/Cubit/Riverpod/GetX/MobX/Redux/Zustand/Provider
  externalServices: string[]; // Firebase/Supabase/Appwrite/GraphQL/WebSocket/gRPC
  authPatterns:   string[];   // OAuth/JWT/SessionStorage/Biometric
  storagePatterns: string[];  // SQLite/Hive/Drift/AsyncStorage/SharedPreferences
  navigationPattern: string; // go_router/Navigator/GetX routing/expo-router/react-navigation
  apiPatterns:    string[];   // REST/GraphQL/WebSocket/gRPC detected endpoints
  assetFiles:     string[];   // images, icons, fonts detected
  envVarKeys:     string[];   // env variable keys detected in code
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

    const totalChars = sourceCode.length;
    const totalLines = sourceCode.split('\n').length;
    console.log(`[AST] analyze() START — sourceFramework=${sourceFramework} totalChars=${totalChars} totalLines=${totalLines}`);

    // Split source into virtual files (if multi-file)
    const files = this.parseVirtualFiles(sourceCode);

    const totalFilesLines = files.reduce((a, f) => a + f.lines, 0);
    console.log(`[AST] Files parsed: ${files.length} | Total lines across files: ${totalFilesLines}`);
    files.slice(0, 5).forEach((f, i) => {
      console.log(`[AST]   [${i + 1}] ${f.path} — ${f.lines} lines — ${f.language}`);
    });
    if (files.length > 5) {
      console.log(`[AST]   ... and ${files.length - 5} more files`);
    }

    // Build import graph
    const imports = this.buildImportGraph(files);

    // AI-enhanced analysis for complex patterns
    const aiAnalysis = await this.runAIAnalysis(ctx, files);

    // ── PHASE 22: Static pattern detection (no tokens wasted) ──
    const statePatterns    = this.detectStatePatterns(files);
    const externalServices = this.detectExternalServices(files);
    const authPatterns     = this.detectAuthPatterns(files);
    const storagePatterns  = this.detectStoragePatterns(files);
    const navigationPattern = this.detectNavigationPattern(files);
    const apiPatterns      = this.detectAPIPatterns(files);
    const assetFiles       = this.detectAssetFiles(files);
    const envVarKeys       = this.detectEnvVars(files);

    console.log(`[AST] Phase22 patterns — state=[${statePatterns.join(',')}] ext=[${externalServices.join(',')}] auth=[${authPatterns.join(',')}] nav=${navigationPattern}`);
    console.log(`[AST] analyze() DONE — files=${files.length} classes=${aiAnalysis.classNames.length} functions=${aiAnalysis.functions.length} tokensUsed=${aiAnalysis.tokensUsed}`);

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
      // ── PHASE 22 ──
      statePatterns,
      externalServices,
      authPatterns,
      storagePatterns,
      navigationPattern,
      apiPatterns,
      assetFiles,
      envVarKeys,
    };
  }

  private parseVirtualFiles(sourceCode: string): ASTFile[] {
    // ── FIX PHASE 21 — CRITICAL: regex mismatch ─────────────────────────────
    // ai-engine.client.ts sends: "// === FILE: path/to/file.dart ===\ncontent"
    // Old regex: /\/\/\s*FILE:\s*/ — did NOT match "// === FILE:" (=== breaks it)
    // New regex: supports BOTH formats:
    //   - "// === FILE: path ==="  (sent by ai-engine.client.ts)
    //   - "// FILE: path"          (legacy)
    //   - "// ==== FILE: path ===" (any number of =)
    //
    // Pattern breakdown:
    //   \/\/\s*        → "// " with optional spaces
    //   (?:=+\s*)?     → optional "===" prefix
    //   FILE:\s*       → "FILE:" with optional spaces
    //   (.+?)          → capture: file path (non-greedy)
    //   (?:\s*=+)?     → optional "===" suffix
    //   \n             → newline after header
    //   ([\s\S]*?)     → capture: file content
    //   (?=\/\/\s*(?:=+\s*)?FILE:|$) → lookahead: next file header OR end
    const filePattern = /\/\/\s*(?:=+\s*)?FILE:\s*(.+?)(?:\s*=+)?\n([\s\S]*?)(?=\/\/\s*(?:=+\s*)?FILE:|$)/g;
    const files: ASTFile[] = [];
    let match: RegExpExecArray | null;

    while ((match = filePattern.exec(sourceCode)) !== null) {
      const path    = (match[1] ?? '').trim();
      const content = (match[2] ?? '').trim();
      if (!path || !content) continue; // skip empty captures
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

    // ── LOG: how many files were parsed ──────────────────────────────────────
    if (files.length > 0) {
      console.log(`[AST] parseVirtualFiles: ${files.length} virtual files parsed from multi-file format`);
    } else {
      // Single file fallback — entire source treated as one file
      console.log(`[AST] parseVirtualFiles: no multi-file markers found — using single-file fallback`);
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
    // ── PHASE 22: Prompt enrichi — extraction complète Étape 1 du Prompt Maître V2 ──
    // Demande à l'IA d'identifier TOUTES les entités: classes, fonctions, exports, variables globales
    // + patterns de state management + connexions externes
    const filesSummary = files.slice(0, 4).map((f) =>
      `FILE: ${f.path}\n${f.content.slice(0, 400)}`
    ).join('\n---\n');

    const prompt = `You are a senior reverse-engineering engineer analyzing a ${ctx.sourceFramework} codebase.

MISSION: Extract ALL technical entities from these source files. Never skip anything.

Source files (${files.length} total, showing first 4):
${filesSummary}

Return a JSON object with EXACTLY these keys:
- exports: array of all exported symbol names (string[])
- classNames: array of ALL class/widget/component names (string[])
- functions: array of {name:string, params:string[], returnType:string, async:boolean, file:string}
- variables: array of global/module-level variable names (string[])

Rules:
- Include ALL classes, even inner or anonymous
- Include ALL exported functions, even arrow functions
- Return ONLY valid JSON, no markdown, no explanation`;

    try {
      const response = await this.openai.chat.completions.create({
        model:       appConfig.defaultModel,
        temperature: 0.1,
        max_tokens:  1000,
        messages:    [{ role: 'user', content: prompt }],
      });

      const content = response.choices[0]?.message?.content ?? '{}';
      let data: { exports?: string[]; classNames?: string[]; functions?: FunctionSignature[]; variables?: string[] };
      try {
        data = JSON.parse(content) as typeof data;
      } catch {
        // Fallback: extract from static analysis
        data = {};
      }

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

  // ── PHASE 22: Static pattern detectors (no AI tokens) ─────────────────────

  /** Détecte les patterns de state management dans les imports et classes */
  private detectStatePatterns(files: ASTFile[]): string[] {
    const patterns = new Set<string>();
    const allImports = files.flatMap((f) => f.imports).join(' ');
    const allContent = files.slice(0, 20).map((f) => f.content.slice(0, 500)).join('\n');

    // Flutter patterns
    if (/flutter_bloc|BlocProvider|BlocBuilder|BlocListener/.test(allContent)) patterns.add('Bloc');
    if (/Cubit|emit\(/.test(allContent)) patterns.add('Cubit');
    if (/riverpod|ProviderScope|StateNotifier|Ref\s/.test(allContent)) patterns.add('Riverpod');
    if (/GetX|GetxController|Rx[A-Z]|\.obs\b|Obx\(/.test(allContent)) patterns.add('GetX');
    if (/Provider\.of|ChangeNotifier|notifyListeners|Consumer</.test(allContent)) patterns.add('Provider');
    if (/MobX|@observable|@action|@computed/.test(allContent)) patterns.add('MobX');

    // React patterns
    if (/from ['"]zustand['"]|useStore/.test(allImports)) patterns.add('Zustand');
    if (/from ['"]redux['"]|createSlice|configureStore|useSelector/.test(allImports)) patterns.add('Redux');
    if (/from ['"]jotai['"]|atom\(/.test(allImports)) patterns.add('Jotai');
    if (/from ['"]recoil['"]|RecoilRoot/.test(allImports)) patterns.add('Recoil');
    if (/from ['"]@tanstack\/react-query['"]|useQuery|useMutation/.test(allImports)) patterns.add('ReactQuery');
    if (/useState|useReducer/.test(allContent)) patterns.add('ReactState');

    // NestJS
    if (/@Injectable|@Module|@Controller/.test(allContent)) patterns.add('NestJS-DI');

    return [...patterns];
  }

  /** Détecte les services externes (Firebase, Supabase, GraphQL, WebSocket, gRPC…) */
  private detectExternalServices(files: ASTFile[]): string[] {
    const services = new Set<string>();
    const allImports = files.flatMap((f) => f.imports).join(' ');
    const allContent = files.slice(0, 20).map((f) => f.content.slice(0, 600)).join('\n');

    // Backend-as-a-service
    if (/firebase|FirebaseApp|initializeApp|Firestore|FirebaseAuth/.test(allContent + allImports)) services.add('Firebase');
    if (/supabase|createClient.*supabase|SupabaseClient/.test(allContent + allImports)) services.add('Supabase');
    if (/appwrite|Appwrite|Client.*endpoint/.test(allContent + allImports)) services.add('Appwrite');

    // API patterns
    if (/graphql|gql`|ApolloClient|useQuery.*gql/.test(allContent + allImports)) services.add('GraphQL');
    if (/WebSocket|ws:\/\/|socket\.io|SocketChannel|StreamChannel/.test(allContent)) services.add('WebSocket');
    if (/grpc|GrpcClient|proto|@grpc\//.test(allContent + allImports)) services.add('gRPC');

    // HTTP clients
    if (/from ['"]axios['"]|import.*axios/.test(allImports)) services.add('Axios');
    if (/import.*dio|package:dio/.test(allContent)) services.add('Dio');
    if (/http\.get|http\.post|package:http/.test(allContent)) services.add('DartHttp');
    if (/fetch\(|XMLHttpRequest/.test(allContent)) services.add('FetchAPI');

    // Push notifications
    if (/fcm|firebase.*messaging|push_notification|flutter_local_notifications/.test(allContent + allImports)) services.add('PushNotifications');

    // Analytics
    if (/analytics|firebase_analytics|mixpanel|amplitude/.test(allContent + allImports)) services.add('Analytics');

    // Maps
    if (/google_maps|mapbox|flutter_map|MapView/.test(allContent + allImports)) services.add('Maps');

    return [...services];
  }

  /** Détecte les patterns d'authentification */
  private detectAuthPatterns(files: ASTFile[]): string[] {
    const auth = new Set<string>();
    const allContent = files.slice(0, 20).map((f) => f.content.slice(0, 500)).join('\n');
    const allImports = files.flatMap((f) => f.imports).join(' ');

    if (/oauth|OAuth|sign_in_with_google|GoogleSignIn|OAuthProvider/.test(allContent + allImports)) auth.add('OAuth');
    if (/jwt|JsonWebToken|jwtVerify|@nestjs\/jwt|jsonwebtoken/.test(allContent + allImports)) auth.add('JWT');
    if (/firebase.*auth|FirebaseAuth|signInWithEmail|createUserWithEmail/.test(allContent)) auth.add('FirebaseAuth');
    if (/supabase.*auth|signIn.*supabase|signUp.*supabase/.test(allContent)) auth.add('SupabaseAuth');
    if (/biometric|local_auth|BiometricPrompt|fingerprintAuth/.test(allContent + allImports)) auth.add('Biometric');
    if (/session|SessionManager|cookie.*session|express-session/.test(allContent)) auth.add('Session');
    if (/passport|PassportStrategy|@nestjs\/passport/.test(allContent + allImports)) auth.add('Passport');
    if (/apple.*sign.*in|sign_in_with_apple/.test(allContent + allImports)) auth.add('AppleSignIn');

    return [...auth];
  }

  /** Détecte les patterns de stockage local */
  private detectStoragePatterns(files: ASTFile[]): string[] {
    const storage = new Set<string>();
    const allContent = files.slice(0, 20).map((f) => f.content.slice(0, 400)).join('\n');
    const allImports = files.flatMap((f) => f.imports).join(' ');

    if (/sqflite|SqfliteDatabase|openDatabase/.test(allContent + allImports)) storage.add('SQLite');
    if (/hive|HiveBox|Hive\.open|@HiveType/.test(allContent + allImports)) storage.add('Hive');
    if (/drift|DriftDatabase|@DriftDatabase/.test(allContent + allImports)) storage.add('Drift');
    if (/shared_preferences|SharedPreferences|prefs\.set/.test(allContent + allImports)) storage.add('SharedPreferences');
    if (/AsyncStorage|@react-native-async-storage/.test(allContent + allImports)) storage.add('AsyncStorage');
    if (/localStorage|sessionStorage/.test(allContent)) storage.add('WebStorage');
    if (/IndexedDB|idb|openIDB/.test(allContent + allImports)) storage.add('IndexedDB');
    if (/typeorm|TypeORM|@Entity\b|Repository/.test(allContent + allImports)) storage.add('TypeORM');
    if (/prisma|PrismaClient/.test(allContent + allImports)) storage.add('Prisma');
    if (/mongoose|MongooseSchema|Schema\(/.test(allContent + allImports)) storage.add('Mongoose');

    return [...storage];
  }

  /** Détecte le pattern de navigation utilisé */
  private detectNavigationPattern(files: ASTFile[]): string {
    const allContent = files.slice(0, 15).map((f) => f.content.slice(0, 400)).join('\n');
    const allImports = files.flatMap((f) => f.imports).join(' ');

    if (/go_router|GoRouter|GoRoute\(/.test(allContent + allImports)) return 'go_router';
    if (/auto_route|AutoRoute|@AutoRouter/.test(allContent + allImports)) return 'auto_route';
    if (/GetX.*routing|GetPage|Get\.to\(|Get\.off\(/.test(allContent)) return 'GetX-routing';
    if (/Navigator\.push|Navigator\.pop|MaterialPageRoute/.test(allContent)) return 'Flutter-Navigator';
    if (/expo-router|expo\/router|useRouter/.test(allContent + allImports)) return 'expo-router';
    if (/@react-navigation|NavigationContainer|Stack\.Navigator/.test(allContent + allImports)) return 'react-navigation';
    if (/createBrowserRouter|BrowserRouter|Route path=/.test(allContent + allImports)) return 'react-router-dom';
    if (/next\/router|useRouter.*next|pages\/|app\/page/.test(allContent + allImports)) return 'next-router';
    if (/nuxt|useRoute.*nuxt|definePageMeta/.test(allContent + allImports)) return 'nuxt-router';

    return 'unknown';
  }

  /** Détecte les patterns d'API (REST endpoints, GraphQL queries, WebSocket channels) */
  private detectAPIPatterns(files: ASTFile[]): string[] {
    const patterns: string[] = [];
    const allContent = files.slice(0, 20).map((f) => f.content).join('\n');

    // REST endpoints
    const restEndpoints = allContent.match(/(?:get|post|put|patch|delete)\(['"]\/api\/[^'"]+['"]/gi) ?? [];
    const dartEndpoints = allContent.match(/(?:dio|http)\.(?:get|post|put|delete)\(['"][^'"]+['"]/gi) ?? [];
    const all = [...new Set([...restEndpoints, ...dartEndpoints])];
    patterns.push(...all.slice(0, 15));

    return patterns;
  }

  /** Détecte les fichiers assets (images, icônes, polices) */
  private detectAssetFiles(files: ASTFile[]): string[] {
    const assetExts = /\.(png|jpg|jpeg|gif|svg|webp|ico|ttf|otf|woff|woff2|mp3|mp4|json)$/i;
    return files
      .filter((f) => assetExts.test(f.path))
      .map((f) => f.path)
      .slice(0, 50);
  }

  /** Détecte les clés de variables d'environnement */
  private detectEnvVars(files: ASTFile[]): string[] {
    const keys = new Set<string>();
    const allContent = files.slice(0, 20).map((f) => f.content).join('\n');

    // process.env.KEY, EXPO_PUBLIC_KEY, .env patterns
    const matches = allContent.match(/process\.env(?:\.|\[['"])([A-Z_][A-Z0-9_]*)/g) ?? [];
    matches.forEach((m) => {
      const key = m.match(/[A-Z_][A-Z0-9_]+/)?.[0];
      if (key) keys.add(key);
    });

    // Dart/Flutter env
    const dartMatches = allContent.match(/const\s+String\s+\w+\s*=\s*(?:String\.fromEnvironment|Platform\.environment)\(['"]([^'"]+)['"]/g) ?? [];
    dartMatches.forEach((m) => {
      const key = m.match(/['"]([^'"]+)['"]/)?.[1];
      if (key) keys.add(key);
    });

    return [...keys].slice(0, 30);
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
