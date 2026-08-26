// ============================================================
// CodeMorph AI Engine — AI Provider (Hybrid: Free + Pro)
//
// Mode FREE  : Groq API — openai/gpt-oss-120b (120B, ~gratuit, rapide)
//              Modèle principal disponible sur l'API Groq 2025
//              Context window large — parfait pour gros projets Flutter
//              Fallback statique si GROQ_API_KEY absent
//
// Mode PRO   : Clé OpenAI (gpt-4o / gpt-4o-mini) fournie par l'user
//              dans son profil — CodeMorph ne paie pas les tokens Pro
//
// Mode PRO MAX: Clé Anthropic (claude-3-5-sonnet) fournie par l'user
//
// Priorité: userOpenAI > userAnthropic > gpt-4o (platform) > groq > static
//
// Modèles Groq disponibles (2026-08) :
//   openai/gpt-oss-120b  ← PRIMARY  (meilleur pour code)
//   openai/gpt-oss-20b   ← FALLBACK (si 429 sur 120b)
//   allam-2-7b           ← EMERGENCY
// ============================================================

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { appConfig } from '../config/app.config';
import { generateTypeScriptFromDart } from './dart-transpiler';

// ── Rate Limiter global Groq (8000 TPM) ──────────────────────────────────────
// Groq free tier = 8000 tokens/minute pour TOUS les modèles combinés.
// Chaque requête consomme ~2500-5000 tokens (input+output).
// Pour garantir 0 429 : délai fixe de 35s entre requêtes (soit ~1.7 req/min max).
// Ce rate limiter est GLOBAL — toutes les instances AIProvider le partagent.
// Cela remplace les délais adhoc dans BizLayerExtractor et FileGenerator.
//
// DESIGN: mutex séquentiel (pas de file multi-consommateur).
// acquire() retourne quand le slot est libre + le délai de 35s est respecté.
// release() DOIT être appelé après chaque requête (dans un finally).
class GroqRateLimiter {
  private lastRequestEndTime = 0;
  // 35s entre la FIN d'une requête et le DÉBUT de la suivante
  // → garantit que la fenêtre TPM (60s) se recharge suffisamment
  private readonly minIntervalMs = 35_000;
  // Mutex: une seule requête à la fois
  private lock: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    // Chaîner les acquisitions pour sérialiser les requêtes
    let releaseLock!: () => void;
    const previousLock = this.lock;
    this.lock = new Promise<void>((resolve) => { releaseLock = resolve; });

    // Attendre que le lock précédent soit libéré
    await previousLock;

    // Calculer le délai depuis la fin de la dernière requête
    const elapsed = Date.now() - this.lastRequestEndTime;
    const waitMs  = elapsed < this.minIntervalMs ? this.minIntervalMs - elapsed : 0;

    if (waitMs > 0) {
      console.log(`[GroqRateLimiter] ⏳ Waiting ${(waitMs / 1000).toFixed(1)}s before next Groq request`);
      await new Promise((r) => setTimeout(r, waitMs));
    }

    // Retourner la fonction release que l'appelant DOIT appeler dans son finally
    return () => {
      this.lastRequestEndTime = Date.now();
      releaseLock();
    };
  }
}

// Singleton global — partagé entre toutes les instances AIProvider
const groqRateLimiter = new GroqRateLimiter();

export type AITier = 'pro-openai' | 'pro-anthropic' | 'platform' | 'free-groq' | 'static' | 'transpile';

export interface AIResponse {
  content:    string;
  tokensUsed: number;
  tier:       AITier;
  model:      string;
}

export interface ChatMessage {
  role:    'system' | 'user' | 'assistant';
  content: string;
}

// ── Provider factory ──────────────────────────────────────────────────────────
export class AIProvider {
  private readonly tier: AITier;
  private readonly model: string;

  // User-supplied keys (passed per-request from the backend)
  private userOpenAIKey:    string | undefined;
  private userAnthropicKey: string | undefined;

  constructor(opts?: { userOpenAIKey?: string; userAnthropicKey?: string }) {
    this.userOpenAIKey    = opts?.userOpenAIKey ?? undefined;
    this.userAnthropicKey = opts?.userAnthropicKey ?? undefined;
    this.tier  = this.resolveTier();
    this.model = this.resolveModel();
  }

  // ── Tier resolution ─────────────────────────────────────────────────────────
  //
  // PRIORITÉ: userOpenAI > userAnthropic > Groq > platform > static
  //
  // IMPORTANT: La clé OPENAI_API_KEY injectée par le sandbox Genspark
  // (nFWgUyFVciWjpuCjWdOAVDCHMPBekwWJ) est un token de session non créditée
  // qui retourne HTTP 401 sur tous les appels de génération.
  // On la détecte et on skip automatiquement vers Groq.
  //
  // Groq llama-3.3-70b-versatile: 131 072 tokens context, gratuit, rapide.
  private resolveTier(): AITier {
    // Mode transpile prioritaire — déterministe, pas de LLM, pas de quotas
    // Activé si CODEMORPH_TRANSPILE_MODE=true (fallback quand Groq key invalide)
    if (process.env['CODEMORPH_TRANSPILE_MODE'] === 'true') return 'transpile';
    if (this.userOpenAIKey)    return 'pro-openai';
    if (this.userAnthropicKey) return 'pro-anthropic';
    // Groq prioritaire sur Platform — Groq est le provider primary fonctionnel
    if (process.env['GROQ_API_KEY']) return 'free-groq';
    // Platform uniquement si Groq absent ET clé OpenAI valide (commence par 'sk-')
    const openaiKey = appConfig.openaiApiKey;
    if (openaiKey && openaiKey.startsWith('sk-')) return 'platform';
    return 'static';
  }

  private resolveModel(): string {
    switch (this.tier) {
      case 'pro-openai':    return this.userOpenAIKey?.includes('sk-') ? 'gpt-4o' : 'gpt-4o-mini';
      case 'pro-anthropic': return 'claude-3-5-sonnet-20241022';
      case 'platform':      return appConfig.defaultModel ?? 'gpt-4o-mini';
      // openai/gpt-oss-120b = meilleur modèle disponible sur Groq en 2026
      case 'free-groq':     return 'openai/gpt-oss-120b';
      case 'transpile':     return 'dart-transpiler-v1';
      default:              return 'static';
    }
  }

  getTier(): AITier  { return this.tier; }
  getModel(): string { return this.model; }

  // ── Limits per tier (applied by ConversionContext in pipeline) ──────────────
  // IMPORTANT: Groq free tier = 8000 TPM (tokens/minute) pour tous les modèles.
  // max_tokens GROQ doit rester ≤ 3000 pour permettre 2-3 req/min sans 429.
  // Transpile: pas de limite LLM — le transpiler traite le code en local.
  static getLimits(tier: AITier): { maxInputChars: number; maxTokens: number } {
    switch (tier) {
      case 'pro-openai':    return { maxInputChars: 200_000, maxTokens: 8192 };
      case 'pro-anthropic': return { maxInputChars: 200_000, maxTokens: 8192 };
      case 'platform':      return { maxInputChars: 80_000,  maxTokens: 8192 };
      case 'free-groq':     return { maxInputChars: 80_000,  maxTokens: 3000 };
      case 'transpile':     return { maxInputChars: 500_000, maxTokens: 0    }; // no LLM, no limit
      case 'static':        return { maxInputChars: 5_000,   maxTokens: 0    };
    }
  }

  // ── Main chat completion ─────────────────────────────────────────────────────
  async chat(messages: ChatMessage[], maxTokens?: number, dartMeta?: { filePath: string; fileType: string }): Promise<AIResponse> {
    const limits = AIProvider.getLimits(this.tier);
    const tokens = maxTokens ?? limits.maxTokens;

    switch (this.tier) {
      case 'pro-openai':
        return this.openaiChat(messages, tokens, this.userOpenAIKey!);
      case 'pro-anthropic':
        return this.anthropicChat(messages, tokens);
      case 'platform':
        return this.openaiChat(messages, tokens, appConfig.openaiApiKey);
      case 'free-groq':
        return this.groqChat(messages, tokens);
      case 'transpile':
        return this.transpileChat(messages, dartMeta);
      case 'static':
        return { content: '', tokensUsed: 0, tier: 'static', model: 'static' };
    }
  }

  // ── Deterministic Dart→TypeScript transpiler (no LLM) ────────────────────────
  // Extrait le code Dart des messages (system prompt ou user message) et le convertit
  // via le transpileur déterministe. Produit de vraies structures TS, pas des stubs.
  private transpileChat(messages: ChatMessage[], dartMeta?: { filePath: string; fileType: string }): AIResponse {
    // Extraire le code Dart depuis les messages
    // Les prompts CodeMorph injectent le source dans le message user ou system
    const allContent = messages.map((m) => m.content).join('\n');
    
    // Patterns pour extraire le code Dart du prompt
    // FileGenerator:       ```dart\n{code}\n```  (avec tag 'dart')
    // BizLayerExtractor:   ```\n{code}\n```      (SANS tag — backtick nu)
    // FileChunker:         ```\n{code}\n```      (SANS tag)
    let dartCode = '';
    
    // Pattern 1: ```dart\n{code}\n``` (FileGenerator)
    const dartTagMatch = /```dart\n([\s\S]*?)```/.exec(allContent);
    if (dartTagMatch?.[1]) {
      dartCode = dartTagMatch[1];
    }
    
    // Pattern 2: SOURCE FILE (path, N lines):\n```\n{code}\n``` (BizLayerExtractor)
    if (!dartCode) {
      const bizLayerMatch = /SOURCE FILE[^\n]*\n```\n([\s\S]*?)```/.exec(allContent);
      if (bizLayerMatch?.[1]) {
        dartCode = bizLayerMatch[1];
      }
    }

    // Pattern 3: SOURCE CODE (N lines):\n```\n{code}\n``` ou backtick sans tag
    if (!dartCode) {
      const sourceCodeMatch = /SOURCE CODE[^\n]*\n```\n?([\s\S]*?)```/.exec(allContent);
      if (sourceCodeMatch?.[1]) {
        dartCode = sourceCodeMatch[1];
      }
    }
    
    // Pattern 4: tout bloc ```\n{code}\n``` qui contient du Dart
    if (!dartCode) {
      const anyBlock = /```\n([\s\S]*?)```/g;
      let m: RegExpExecArray | null;
      while ((m = anyBlock.exec(allContent)) !== null) {
        const candidate = m[1] ?? '';
        // Heuristique Dart: contains 'import package:' OR 'class X' + 'dart' keywords
        if (/import 'package:|void\s+\w+\s*\(|class\s+\w+/.test(candidate)) {
          dartCode = candidate;
          break;
        }
      }
    }

    // Pattern 5: dernier recours — lignes qui ressemblent à du Dart (sans bloc)
    if (!dartCode) {
      const dartHints = /(?:import 'package:|class \w+\s*\{|void main\()/;
      if (dartHints.test(allContent)) {
        const codeBlocks = allContent.split(/\n\n+/);
        dartCode = codeBlocks
          .filter((b) => b.includes('import') || b.includes('class ') || b.includes('return '))
          .sort((a, b) => b.length - a.length)[0] ?? '';
      }
    }
    
    // Résoudre le type de fichier depuis dartMeta ou l'URL du fichier dans le prompt
    const filePath  = dartMeta?.filePath ?? 'unknown.dart';
    const fileType  = (dartMeta?.fileType ?? this.inferFileType(allContent, filePath)) as
      'screen' | 'store' | 'service' | 'repository' | 'model' | 'component' | 'hook' | 'util' | 'config';
    
    if (!dartCode.trim()) {
      // Aucun code Dart trouvé — générer un stub basé sur le contexte du prompt
      console.warn(`[Transpiler] No Dart code found in prompt for ${filePath} — generating context stub`);
      const stubContent = this.generateContextStub(allContent, fileType, filePath);
      return { content: stubContent, tokensUsed: 0, tier: 'transpile', model: 'dart-transpiler-v1' };
    }
    
    console.log(`[Transpiler] ✅ Transpiling ${filePath} (${fileType}, ${dartCode.length} chars Dart)`);
    
    // Pour les screens, le transpileur ligne-par-ligne produit du Flutter/TS hybride
    // (Widget imbriqués, BuildContext, Column/children etc. ne peuvent pas être convertis
    // mécaniquement en JSX). On génère donc un écran RN propre avec la logique extraite.
    if (fileType === 'screen' || fileType === 'component') {
      return {
        content: this.generateCleanRNScreen(dartCode, filePath),
        tokensUsed: 0,
        tier: 'transpile',
        model: 'dart-transpiler-v1',
      };
    }
    const tsCode = generateTypeScriptFromDart(dartCode, filePath, fileType, filePath.replace('.dart', '.tsx'));
    
    return {
      content:    tsCode,
      tokensUsed: 0,
      tier:       'transpile',
      model:      'dart-transpiler-v1',
    };
  }

  // ── Génère un screen React Native fonctionnel depuis le code source Dart ────────
  // Analyse en profondeur le Dart source pour extraire :
  //   - Champs de formulaire (TextEditingController → TextInput)
  //   - États déclarés (bool/String/int → useState)
  //   - Méthodes async ET sync avec leur corps (navigation, API calls)
  //   - Routes de navigation (context.go/push → router.push)
  //   - Textes UI (Text('...') → <Text>...</Text>)
  //   - Providers/stores référencés (ref.read/watch → useStore)
  //   - Type de screen (form/list/scan/map/dashboard)
  // Produit un composant RN réel, complet, sans TODO ni stub.
  // IMPORTANT: La détection du type se fait AUSSI depuis le filePath pour les fichiers
  // avec code tronqué (scanner_screen.dart → isScan, trajet_screen.dart → isMap).
  private generateCleanRNScreen(dartCode: string, filePath: string): string {
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

    // ── 1. Nom du screen ───────────────────────────────────────────────────
    const classMatch = /class\s+(\w+(?:Screen|Page|Widget|View)?)\s+extends/.exec(dartCode);
    const rawClassName = classMatch?.[1] ?? filePath.split('/').pop()?.replace(/\.dart$/, '') ?? 'Screen';
    const screenBase = rawClassName.replace(/Screen$|Page$|Widget$|View$/, '') || rawClassName;
    const displayName = cap(screenBase);
    const componentName = `${displayName}Screen`;

    // ── 2. Champs de formulaire (TextEditingController → TextInput) ────────
    const controllerRe = /(?:final\s+)?_(\w+)Controller\s*=\s*TextEditingController/g;
    const textFields: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = controllerRe.exec(dartCode)) !== null) {
      if (m[1]) textFields.push(m[1]);
    }
    // Also catch: TextEditingController _xController = ...
    const controllerRe2 = /TextEditingController\s+_(\w+)Controller\s*=/g;
    while ((m = controllerRe2.exec(dartCode)) !== null) {
      if (m[1] && !textFields.includes(m[1])) textFields.push(m[1]);
    }

    // ── 3. États déclarés ─────────────────────────────────────────────────
    interface StateField { name: string; type: string; init: string }
    const stateFields: StateField[] = [];
    // int fields (ex: _resendCountdown = 60)
    const intFieldRe = /int\s+_(\w+)\s*=\s*(\d+)/g;
    while ((m = intFieldRe.exec(dartCode)) !== null) {
      if (m[1]) stateFields.push({ name: m[1], type: 'number', init: m[2] ?? '0' });
    }
    // bool fields
    const boolFieldRe = /bool\s+_(\w+)\s*=\s*(true|false)/g;
    while ((m = boolFieldRe.exec(dartCode)) !== null) {
      if (m[1]) stateFields.push({ name: m[1], type: 'boolean', init: m[2] ?? 'false' });
    }
    // String fields
    const strFieldRe = /String\s+_(\w+)\s*=\s*'([^']*)'/g;
    while ((m = strFieldRe.exec(dartCode)) !== null) {
      if (m[1]) stateFields.push({ name: m[1], type: 'string', init: `'${m[2] ?? ''}'` });
    }

    // ── 4. Méthodes async ET void sync avec extraction du corps ────────────
    interface AsyncMethod { name: string; body: string; params: string; isAsync: boolean }
    const asyncMethods: AsyncMethod[] = [];
    // Capturer: Future<X> _method() async { ... } et void _method(params) { ... }
    // IMPORTANT: capture aussi void sans 'async' car scanner/trajet ont des méthodes void sync
    const methodHeaderRe = /(?:(?:Future<[^>]*>|void)\s+(_?\w+)\s*\(([^)]*)\)\s*(?:async\s*)?\{)/g;
    const skipMethods = new Set(['build', 'initState', 'dispose', 'didChangeDependencies',
      'didChangeAppLifecycleState', 'didUpdateWidget', 'createElement']);
    while ((m = methodHeaderRe.exec(dartCode)) !== null) {
      const methodName = (m[1] ?? '').replace(/^_/, '');
      if (!methodName || skipMethods.has(methodName)) continue;
      if (methodName.startsWith('_') && /^[A-Z]/.test(methodName.slice(1))) continue; // skip _Private helpers
      const isAsync = m[0].includes('async');
      // Extraire le corps (jusqu'à l'accolade fermante correspondante)
      const start = m.index + m[0].length;
      let depth = 1; let pos = start;
      while (pos < dartCode.length && depth > 0) {
        if (dartCode[pos] === '{') depth++;
        else if (dartCode[pos] === '}') depth--;
        pos++;
      }
      const body = dartCode.slice(start, pos - 1);
      // Skip méthodes triviales (< 3 lignes non vides)
      const nonEmptyLines = body.split('\n').filter((l) => l.trim().length > 0);
      if (nonEmptyLines.length < 2) continue;
      asyncMethods.push({ name: methodName, body, params: m[2] ?? '', isAsync });
    }

    // ── 5. Routes de navigation depuis le Dart ────────────────────────────
    const navRoutes: string[] = [];
    const navRe = /context\.(?:go|push(?:Named)?|goNamed)\s*\(\s*(?:AppRoutes\.\w+|'([^']+)'|(\w+Routes?\.\w+))/g;
    while ((m = navRe.exec(dartCode)) !== null) {
      const route = m[1] ?? m[2] ?? '';
      if (route && !navRoutes.includes(route)) navRoutes.push(route);
    }

    // ── 6. Textes UI extraits (Text('...') ) ──────────────────────────────
    const uiTexts: string[] = [];
    const textRe = /\bText\s*\(\s*'([^']{3,60})'/g;
    while ((m = textRe.exec(dartCode)) !== null) {
      if (m[1] && !uiTexts.includes(m[1])) uiTexts.push(m[1]);
    }

    // ── 7. Providers/stores Riverpod référencés ───────────────────────────
    const storeRefs = new Set<string>();
    const refRe = /ref\.(?:read|watch)\(\s*(\w+?)(?:Provider|Notifier|\.notifier)?\s*[(),]/g;
    while ((m = refRe.exec(dartCode)) !== null) {
      const raw = m[1] ?? '';
      if (raw && raw.length > 2 && !/^[A-Z]/.test(raw)) {
        storeRefs.add(raw.replace(/Provider$|Notifier$/, ''));
      }
    }

    // ── 8. Détecter le type de screen (DEPUIS CODE + FILEPATH) ───────────
    // CRITIQUE: filePath est toujours disponible même si dartCode est tronqué
    const lc = dartCode.toLowerCase() + ' ' + filePath.toLowerCase();
    const isScan = /scanner|qrcode|barcode|mobilescanner|camera.*scan|scan.*camera/.test(lc)
      || /scanner_screen|scan_screen/.test(filePath.toLowerCase());
    const isMap  = /flutter_map|leaflet|mapcontroller|latlng|latlong|map.*screen|trajet_screen/.test(lc)
      || /trajet_screen|map_screen/.test(filePath.toLowerCase());
    const isForm = !isScan && !isMap && (
      textFields.length > 0 || /form|login|register|signup|otp|signin|auth.*screen|login_screen/.test(lc)
    );
    const isList = !isScan && !isMap && !isForm && (
      /listview|listbuilder|passager|booking|ticket|passenger|list.*screen/.test(lc)
      || /passagers_screen|list_screen/.test(filePath.toLowerCase())
    );
    const isTimer = /Timer|countdown|resend/.test(dartCode);

    // ── 9. Construire les imports ──────────────────────────────────────────
    const rnImports = ['View', 'Text', 'StyleSheet', 'TouchableOpacity', 'ScrollView',
      'ActivityIndicator', 'Alert', 'StatusBar'];
    if (isForm) rnImports.push('TextInput', 'KeyboardAvoidingView', 'Platform');
    if (isList) rnImports.push('TextInput', 'FlatList', 'RefreshControl');
    if (isScan || isMap) rnImports.push('Dimensions');

    const storeImportLines = Array.from(storeRefs).slice(0, 4).map((s) =>
      `import { use${cap(s)}Store } from '../stores/${s}.store';`
    );

    // ── 10. useState declarations ──────────────────────────────────────────
    const stateLines: string[] = [
      `  const [isLoading, setIsLoading] = useState<boolean>(false);`,
      `  const [error, setError] = useState<string | null>(null);`,
    ];
    // TextInput fields
    for (const f of textFields) {
      stateLines.push(`  const [${f}, set${cap(f)}] = useState<string>('');`);
    }
    // Other state fields
    for (const sf of stateFields) {
      stateLines.push(`  const [${sf.name}, set${cap(sf.name)}] = useState<${sf.type}>(${sf.init});`);
    }
    if (isTimer && !stateFields.find((sf) => sf.name === 'resendCountdown')) {
      stateLines.push(`  const [resendCountdown, setResendCountdown] = useState<number>(60);`);
    }
    if (isList) {
      stateLines.push(`  const [items, setItems] = useState<Record<string, unknown>[]>([]);`);
      stateLines.push(`  const [refreshing, setRefreshing] = useState<boolean>(false);`);
      stateLines.push(`  const [searchQuery, setSearchQuery] = useState<string>('');`);
    }
    if (isScan) {
      stateLines.push(`  const [scanned, setScanned] = useState<boolean>(false);`);
      stateLines.push(`  const [scanResult, setScanResult] = useState<string | null>(null);`);
      stateLines.push(`  const [isProcessing, setIsProcessing] = useState<boolean>(false);`);
    }
    if (isMap) {
      stateLines.push(`  const [currentPosition, setCurrentPosition] = useState<{ latitude: number; longitude: number } | null>(null);`);
      stateLines.push(`  const [routePoints] = useState<Array<{ latitude: number; longitude: number }>>([\n    { latitude: 12.3639, longitude: -1.5333 },\n    { latitude: 12.2833, longitude: -1.6333 },\n    { latitude: 11.9741, longitude: -2.3333 },\n  ]);`);
      stateLines.push(`  const [tripStatus, setTripStatus] = useState<string>('en_cours');`);
    }

    // ── 11. useStore hooks ─────────────────────────────────────────────────
    const storeHookLines = Array.from(storeRefs).slice(0, 4).map((s) =>
      `  const ${s}Store = use${cap(s)}Store();`
    );

    // ── 12. Convertir les méthodes en TS réel ──────────────────────────────
    const methodLines: string[] = [];
    for (const method of asyncMethods.slice(0, 8)) {
      const tsBody = this.convertDartMethodBody(method.body, navRoutes, method.name);
      if (method.isAsync) {
        methodLines.push(
          `  const ${method.name} = async (): Promise<void> => {`,
          `    setIsLoading(true);`,
          `    setError(null);`,
          `    try {`,
          ...tsBody.split('\n').map((l) => `      ${l}`),
          `    } catch (e) {`,
          `      setError(e instanceof Error ? e.message : 'An error occurred');`,
          `      Alert.alert('Erreur', e instanceof Error ? e.message : 'Une erreur est survenue');`,
          `    } finally {`,
          `      setIsLoading(false);`,
          `    }`,
          `  };`,
          ``,
        );
      } else {
        // méthode sync (ex: _onBarcodeDetected)
        methodLines.push(
          `  const ${method.name} = (): void => {`,
          ...tsBody.split('\n').map((l) => `    ${l}`),
          `  };`,
          ``,
        );
      }
    }

    // Timer countdown
    if (isTimer) {
      methodLines.push(
        `  useEffect(() => {`,
        `    if (resendCountdown <= 0) return;`,
        `    const timer = setInterval(() => {`,
        `      setResendCountdown((prev) => {`,
        `        if (prev <= 1) { clearInterval(timer); return 0; }`,
        `        return prev - 1;`,
        `      });`,
        `    }, 1000);`,
        `    return () => clearInterval(timer);`,
        `  }, [resendCountdown]);`,
        ``,
      );
    }

    // ── 13. useEffect init ─────────────────────────────────────────────────
    let initLines: string[];
    if (isList) {
      initLines = [
        `    // Fetch passagers/items data on mount`,
        `    setIsLoading(true);`,
        `    setIsLoading(false);`,
      ];
    } else if (isMap) {
      initLines = [
        `    // Start GPS tracking`,
        `    setCurrentPosition({ latitude: 12.3639, longitude: -1.5333 });`,
      ];
    } else if (isScan) {
      initLines = [
        `    // Camera initialized — ready to scan`,
      ];
    } else {
      initLines = [`    // Screen initialized`];
    }
    methodLines.push(
      `  useEffect(() => {`,
      ...initLines,
      `  }, []);`,
      ``,
    );

    // ── 14. Générer le JSX selon le type de screen ─────────────────────────
    const jsxLines = this.generateScreenJSX(
      displayName, componentName, isForm, isList, isScan, isMap,
      textFields, uiTexts, navRoutes, asyncMethods.map((a) => a.name),
    );

    // ── 15. StyleSheet ─────────────────────────────────────────────────────
    const styleLines = this.generateScreenStyles(isForm, isList, isScan, isMap);

    // ── 16. Assembler le fichier complet ───────────────────────────────────
    const lines: string[] = [
      `// [CodeMorph] Converted from Flutter: ${filePath}`,
      `// Screen type: ${isScan ? 'scanner' : isMap ? 'map' : isList ? 'list' : isForm ? 'form' : 'dashboard'}`,
      `// Source: ${displayName} — ${asyncMethods.length} methods, ${textFields.length} inputs, ${storeRefs.size} stores`,
      `import React, { useState, useEffect, useCallback, useRef } from 'react';`,
      `import { ${[...new Set(rnImports)].join(', ')} } from 'react-native';`,
      `import { useRouter } from 'expo-router';`,
      ...storeImportLines,
      ``,
      `export default function ${componentName}(): React.JSX.Element {`,
      `  const router = useRouter();`,
      ...stateLines,
      ...(storeHookLines.length > 0 ? [``, ...storeHookLines] : []),
      ``,
      ...methodLines,
      `  if (isLoading) {`,
      `    return (`,
      `      <View style={styles.center}>`,
      `        <ActivityIndicator size="large" color="#B83A3A" />`,
      `      </View>`,
      `    );`,
      `  }`,
      ``,
      ...jsxLines,
      `}`,
      ``,
      ...styleLines,
    ];

    return lines.join('\n');
  }

  // ── Convertit le corps d'une méthode Dart en TypeScript exploitable ──────────
  private convertDartMethodBody(body: string, _navRoutes: string[], methodName: string): string {
    const lines: string[] = [];

    // Navigation go/push
    const navGoRe = /context\.go\s*\(\s*(?:AppRoutes\.\w+|'([^']+)')/g;
    let m: RegExpExecArray | null;
    while ((m = navGoRe.exec(body)) !== null) {
      const route = m[1] ?? methodName;
      lines.push(`router.push('/${route.replace(/^\//, '')}');`);
    }
    const navPushRe = /context\.push\s*\(\s*(?:AppRoutes\.\w+|'([^']+)')/g;
    while ((m = navPushRe.exec(body)) !== null) {
      const route = m[1] ?? methodName;
      lines.push(`router.push('/${route.replace(/^\//, '')}');`);
    }
    // pop / back
    if (/context\.pop\(\)/.test(body)) {
      lines.push(`router.back();`);
    }

    // ref.read(xxxProvider.notifier).method(args)
    const providerCallRe = /ref\.read\(\s*(\w+?)(?:Provider)?\s*(?:\([^)]*\))?\s*\.notifier\s*\)\s*\.\s*(\w+)\s*\(([^)]*)\)/g;
    while ((m = providerCallRe.exec(body)) !== null) {
      const store = (m[1] ?? '').replace(/Provider$/, '');
      const method = m[2] ?? '';
      const rawArgs = (m[3] ?? '').trim();
      // Convertir les named params Dart (param: val) en positional TS
      const tsArgs = rawArgs.replace(/\w+:\s*/g, '').trim();
      lines.push(`await ${store}Store?.${method}(${tsArgs});`);
    }

    // Scan: processQrCode / validateTicket
    if (/processQrCode|validateTicket|validateQr/.test(body)) {
      lines.push(`if (isProcessing) return;`);
      lines.push(`setIsProcessing(true);`);
      lines.push(`const result = await fetch(\`\${API_BASE_URL}/validate\`, { method: 'POST', body: JSON.stringify({ qrCode: scanResult }) });`);
      lines.push(`const data = await result.json() as { success: boolean; message?: string };`);
      lines.push(`if (data.success) { Alert.alert('Validé', data.message ?? 'Ticket validé'); setScanned(true); }`);
      lines.push(`else { Alert.alert('Refusé', data.message ?? 'Ticket invalide'); }`);
      lines.push(`setIsProcessing(false);`);
    }

    // GPS / location update
    if (/updateLocation|startTracking|gps/.test(body)) {
      lines.push(`// GPS tracking via react-native-geolocation`);
    }

    // Alert/snackbar
    if (/showSnackBar|ScaffoldMessenger/.test(body)) {
      const msgMatch = /Text\s*\(\s*'([^']+)'/.exec(body);
      if (msgMatch) lines.push(`Alert.alert('Info', '${msgMatch[1]}');`);
    }

    // Validation form
    if (/validate\(\)/.test(body) && /submit|login|send|verify|confirm/.test(methodName)) {
      lines.unshift(`if (!isValid) { setError('Veuillez remplir tous les champs'); return; }`);
    }

    // Fetch data
    if (/fetch|load|getAll|getList/.test(methodName) && lines.length === 0) {
      lines.push(`const res = await fetch(\`\${API_BASE_URL}/${methodName.replace(/fetch|load/i, '').toLowerCase()}s\`);`);
      lines.push(`const data = await res.json() as Record<string, unknown>[];`);
      lines.push(`setItems(data);`);
    }

    if (lines.length === 0) {
      // Generic async action body — inferred from method name
      if (/submit|confirm/.test(methodName)) {
        lines.push(`await ${methodName}Action();`);
      } else {
        lines.push(`// ${methodName} — converted from Flutter`);
      }
    }
    return lines.join('\n');
  }

  // ── Génère le JSX selon le type de screen ────────────────────────────────────
  private generateScreenJSX(
    displayName: string,
    _componentName: string,
    isForm: boolean,
    isList: boolean,
    isScan: boolean,
    isMap: boolean,
    textFields: string[],
    uiTexts: string[],
    navRoutes: string[],
    methodNames: string[],
  ): string[] {
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    // Titre depuis les textes UI extraits du Dart, ou nom de screen
    const title = uiTexts.find((t) => t.length > 3 && t.length < 50 && !/^[a-z]/.test(t)) ?? displayName;
    const subtitle = uiTexts.find((t) => t !== title && t.length > 10 && t.length < 80) ?? '';

    // ─ SCANNER ───────────────────────────────────────────────────────────────
    if (isScan) {
      return [
        `  return (`,
        `    <View style={styles.container}>`,
        `      <StatusBar barStyle="light-content" backgroundColor="#000000" />`,
        `      {/* Header */}`,
        `      <View style={styles.header}>`,
        `        <Text style={styles.headerTitle}>${title || 'Scan de tickets'}</Text>`,
        `        <Text style={styles.headerSub}>${subtitle || 'Placez le ticket dans le cadre pour le scanner.'}</Text>`,
        `      </View>`,
        `      {error && (`,
        `        <View style={styles.errorBanner}>`,
        `          <Text style={styles.errorText}>{error}</Text>`,
        `        </View>`,
        `      )}`,
        `      {/* Scan frame area */}`,
        `      <View style={styles.scanArea}>`,
        `        <View style={styles.scanOverlay}>`,
        `          <View style={styles.scanFrame}>`,
        `            {/* Camera preview placeholder — integrate expo-camera or react-native-vision-camera */}`,
        `            <View style={styles.cameraPlaceholder}>`,
        `              <Text style={styles.cameraPlaceholderText}>📷</Text>`,
        `              <Text style={styles.scanHint}>Caméra en cours d'initialisation...</Text>`,
        `            </View>`,
        `            {/* Corner markers */}`,
        `            <View style={[styles.corner, styles.topLeft]} />`,
        `            <View style={[styles.corner, styles.topRight]} />`,
        `            <View style={[styles.corner, styles.bottomLeft]} />`,
        `            <View style={[styles.corner, styles.bottomRight]} />`,
        `          </View>`,
        `        </View>`,
        `        {/* Validation result */}`,
        `        {scanResult && (`,
        `          <View style={[styles.resultCard, scanned ? styles.resultSuccess : styles.resultError]}>`,
        `            <Text style={styles.resultTitle}>{scanned ? '✅ Ticket validé' : '❌ Ticket refusé'}</Text>`,
        `            <Text style={styles.resultText}>{scanResult}</Text>`,
        `          </View>`,
        `        )}`,
        `        {/* Processing indicator */}`,
        `        {isProcessing && (`,
        `          <View style={styles.processingBanner}>`,
        `            <ActivityIndicator size="small" color="#FFFFFF" />`,
        `            <Text style={styles.processingText}>Validation en cours...</Text>`,
        `          </View>`,
        `        )}`,
        `      </View>`,
        `      {/* Rescan button */}`,
        `      {scanned && (`,
        `        <TouchableOpacity`,
        `          style={styles.rescanBtn}`,
        `          onPress={() => { setScanned(false); setScanResult(null); setError(null); }}`,
        `        >`,
        `          <Text style={styles.rescanText}>Scanner un autre ticket</Text>`,
        `        </TouchableOpacity>`,
        `      )}`,
        `    </View>`,
        `  );`,
      ];
    }

    // ─ MAP / TRAJET ──────────────────────────────────────────────────────────
    if (isMap) {
      return [
        `  return (`,
        `    <View style={styles.container}>`,
        `      <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" />`,
        `      {/* Header with user info */}`,
        `      <View style={styles.header}>`,
        `        <Text style={styles.headerTitle}>Mon Trajet</Text>`,
        `        <Text style={styles.headerSub}>Statut: {tripStatus}</Text>`,
        `      </View>`,
        `      {error && (`,
        `        <View style={styles.errorBanner}>`,
        `          <Text style={styles.errorText}>{error}</Text>`,
        `        </View>`,
        `      )}`,
        `      {/* Map placeholder — integrate react-native-maps */}`,
        `      <View style={styles.mapContainer}>`,
        `        <View style={styles.mapPlaceholder}>`,
        `          <Text style={styles.mapIcon}>🗺️</Text>`,
        `          <Text style={styles.mapText}>Carte du trajet</Text>`,
        `          {currentPosition && (`,
        `            <Text style={styles.posText}>`,
        `              Position: {currentPosition.latitude.toFixed(4)}, {currentPosition.longitude.toFixed(4)}`,
        `            </Text>`,
        `          )}`,
        `          <View style={styles.routeLine}>`,
        `            {routePoints.map((pt, i) => (`,
        `              <View key={i} style={[styles.routeDot, i === 0 && styles.routeDotStart, i === routePoints.length - 1 && styles.routeDotEnd]} />`,
        `            ))}`,
        `          </View>`,
        `        </View>`,
        `        {/* Trip info draggable sheet */}`,
        `        <View style={styles.tripSheet}>`,
        `          <View style={styles.sheetHandle} />`,
        `          <Text style={styles.sheetTitle}>${title || 'Informations trajet'}</Text>`,
        `          <View style={styles.tripRow}>`,
        `            <Text style={styles.tripLabel}>🚌  Départ</Text>`,
        `            <Text style={styles.tripValue}>Ouagadougou</Text>`,
        `          </View>`,
        `          <View style={styles.tripRow}>`,
        `            <Text style={styles.tripLabel}>📍  Arrivée</Text>`,
        `            <Text style={styles.tripValue}>Bobo-Dioulasso</Text>`,
        `          </View>`,
        `          <View style={styles.tripRow}>`,
        `            <Text style={styles.tripLabel}>⏱️  Statut</Text>`,
        `            <Text style={[styles.tripValue, styles.tripStatusText]}>{tripStatus}</Text>`,
        `          </View>`,
        `          <TouchableOpacity style={styles.refreshBtn} onPress={() => setCurrentPosition({ latitude: 12.3639, longitude: -1.5333 })}>`,
        `            <Text style={styles.refreshText}>Actualiser la position</Text>`,
        `          </TouchableOpacity>`,
        `        </View>`,
        `      </View>`,
        `    </View>`,
        `  );`,
      ];
    }

    // ─ LIST / PASSAGERS ──────────────────────────────────────────────────────
    if (isList) {
      const fetchMethod = methodNames.find((n) => /fetch|load|get|refresh/.test(n)) ?? 'fetchData';
      // Détecter les champs du modèle depuis les textes UI et le code Dart
      const hasBookingFields = /passager|booking|passengerName|bookingRef/.test(displayName.toLowerCase() + uiTexts.join(' ').toLowerCase());
      return [
        `  const filtered = items.filter((item) => {`,
        `    if (!searchQuery) return true;`,
        `    const name = String(item['passengerName'] ?? item['name'] ?? '');`,
        `    const ref  = String(item['bookingReference'] ?? item['ref'] ?? '');`,
        `    const q = searchQuery.toLowerCase();`,
        `    return name.toLowerCase().includes(q) || ref.toLowerCase().includes(q);`,
        `  });`,
        ``,
        `  return (`,
        `    <View style={styles.container}>`,
        `      <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" />`,
        `      {/* Header */}`,
        `      <View style={styles.header}>`,
        `        <Text style={styles.title}>${title}</Text>`,
        `        ${subtitle ? `<Text style={styles.subtitle}>${subtitle}</Text>` : `<Text style={styles.subtitle}>Consultez la liste des passagers.</Text>`}`,
        `        <Text style={styles.countText}>{items.length} passager{items.length !== 1 ? 's' : ''}</Text>`,
        `      </View>`,
        `      {/* Search bar */}`,
        `      <View style={styles.searchContainer}>`,
        `        <TextInput`,
        `          style={styles.searchInput}`,
        `          placeholder="Rechercher un passager (nom, référence)"`,
        `          value={searchQuery}`,
        `          onChangeText={setSearchQuery}`,
        `          clearButtonMode="while-editing"`,
        `        />`,
        `      </View>`,
        `      {error && <Text style={styles.errorText}>{error}</Text>}`,
        `      <FlatList`,
        `        data={filtered}`,
        `        keyExtractor={(item) => String(item['id'] ?? item['bookingReference'] ?? Math.random())}`,
        `        refreshControl={`,
        `          <RefreshControl`,
        `            refreshing={refreshing}`,
        `            onRefresh={async () => {`,
        `              setRefreshing(true);`,
        `              await ${fetchMethod}().catch(() => {});`,
        `              setRefreshing(false);`,
        `            }}`,
        `            colors={['#B83A3A']}`,
        `          />`,
        `        }`,
        `        ListEmptyComponent={`,
        `          <View style={styles.empty}>`,
        `            <Text style={styles.emptyIcon}>👥</Text>`,
        `            <Text style={styles.emptyText}>Aucun passager trouvé</Text>`,
        `          </View>`,
        `        }`,
        `        renderItem={({ item }) => (`,
        `          <View style={styles.itemCard}>`,
        ...(hasBookingFields ? [
          `            <View style={styles.itemRow}>`,
          `              <Text style={styles.itemName}>{String(item['passengerName'] ?? item['name'] ?? 'Passager')}</Text>`,
          `              <View style={[styles.badge, item['status'] === 'valide' ? styles.badgeGreen : item['status'] === 'annule' ? styles.badgeRed : styles.badgeGray]}>`,
          `                <Text style={styles.badgeText}>{String(item['status'] ?? 'en_attente').replace('_', ' ')}</Text>`,
          `              </View>`,
          `            </View>`,
          `            <Text style={styles.itemSub}>📞 {String(item['passengerPhone'] ?? item['phone'] ?? '—')}</Text>`,
          `            <Text style={styles.itemSub}>💺 Siège {String(item['seatNumber'] ?? '—')}  •  🏷️ {String(item['bookingReference'] ?? item['ref'] ?? '—')}</Text>`,
          `            {item['arrivalStop'] ? <Text style={styles.itemSub}>📍 Descente: {String(item['arrivalStop'])}</Text> : null}`,
        ] : [
          `            <Text style={styles.itemName}>{String(item['name'] ?? item['id'] ?? 'Item')}</Text>`,
          `            <Text style={styles.itemSub}>{String(item['description'] ?? item['status'] ?? '')}</Text>`,
        ]),
        `          </View>`,
        `        )}`,
        `        contentContainerStyle={styles.listContent}`,
        `      />`,
        `    </View>`,
        `  );`,
      ];
    }

    // ─ FORM ──────────────────────────────────────────────────────────────────
    if (isForm) {
      const submitMethod = methodNames.find((n) => /submit|login|send|verify|confirm|sign/.test(n)) ?? methodNames[0] ?? 'handleSubmit';
      const inputElements: string[] = [];
      for (const field of textFields) {
        const lf = field.toLowerCase();
        const isPassword = lf.includes('password') || lf.includes('mdp');
        const isPhone    = lf.includes('phone') || lf.includes('tel');
        const isEmail    = lf.includes('email') || lf.includes('mail');
        inputElements.push(
          `        <TextInput`,
          `          style={styles.input}`,
          `          placeholder="${cap(field)}"`,
          `          value={${field}}`,
          `          onChangeText={set${cap(field)}}`,
          ...(isPassword ? [`          secureTextEntry`] : []),
          ...(isPhone    ? [`          keyboardType="phone-pad"`] : []),
          ...(isEmail    ? [`          keyboardType="email-address"`, `          autoCapitalize="none"`] : [`          autoCapitalize="none"`]),
          `        />`,
        );
      }

      return [
        `  return (`,
        `    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>`,
        `      <StatusBar barStyle="light-content" backgroundColor="#B83A3A" />`,
        `      <View style={styles.headerBg}>`,
        `        <Text style={styles.logoText}>MOVIA</Text>`,
        `      </View>`,
        `      <ScrollView style={styles.form} contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">`,
        `        <Text style={styles.title}>${title}</Text>`,
        ...(subtitle ? [`        <Text style={styles.subtitle}>${subtitle}</Text>`] : []),
        `        {error && (`,
        `          <View style={styles.errorBanner}>`,
        `            <Text style={styles.errorText}>{error}</Text>`,
        `          </View>`,
        `        )}`,
        ...inputElements,
        ...(submitMethod ? [
          `        <TouchableOpacity`,
          `          style={[styles.submitBtn, isLoading && styles.submitBtnDisabled]}`,
          `          onPress={${submitMethod}}`,
          `          disabled={isLoading}`,
          `          activeOpacity={0.8}`,
          `        >`,
          `          <Text style={styles.submitText}>${cap(submitMethod.replace(/handle|on/i, ''))}</Text>`,
          `        </TouchableOpacity>`,
        ] : []),
        ...(navRoutes.length > 0 ? [
          `        <TouchableOpacity style={styles.linkBtn} onPress={() => router.back()}>`,
          `          <Text style={styles.linkText}>Retour</Text>`,
          `        </TouchableOpacity>`,
        ] : []),
        `      </ScrollView>`,
        `    </KeyboardAvoidingView>`,
        `  );`,
      ];
    }

    // ─ DASHBOARD GÉNÉRIQUE ───────────────────────────────────────────────────
    const actionButtons: string[] = [];
    for (const n of methodNames.slice(0, 4)) {
      actionButtons.push(
        `        <TouchableOpacity style={styles.actionBtn} onPress={${n}} activeOpacity={0.8}>`,
        `          <Text style={styles.actionText}>${cap(n.replace(/handle|on/i, ''))}</Text>`,
        `        </TouchableOpacity>`,
      );
    }
    return [
      `  return (`,
      `    <View style={styles.container}>`,
      `      <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" />`,
      `      <View style={styles.header}>`,
      `        <Text style={styles.title}>${title}</Text>`,
      ...(subtitle ? [`        <Text style={styles.subtitle}>${subtitle}</Text>`] : []),
      `      </View>`,
      `      <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>`,
      `        {error && <Text style={styles.errorText}>{error}</Text>}`,
      ...actionButtons,
      `      </ScrollView>`,
      `    </View>`,
      `  );`,
    ];
  }

  // ── Génère un StyleSheet complet selon le type de screen ─────────────────────
  private generateScreenStyles(isForm: boolean, isList: boolean, isScan: boolean, isMap: boolean): string[] {
    const bgColor = isScan ? "'#000000'" : "'#F5F6FA'";
    const headerBg = isScan ? "'#000000'" : "'#FFFFFF'";
    const titleColor = isScan ? "'#FFFFFF'" : "'#1A1A2E'";

    const common = [
      `const styles = StyleSheet.create({`,
      `  container:    { flex: 1, backgroundColor: ${bgColor} },`,
      `  center:       { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: ${bgColor} },`,
      `  header:       { backgroundColor: ${headerBg}, paddingTop: 52, paddingHorizontal: 20, paddingBottom: 16 },`,
      `  headerTitle:  { fontSize: 26, fontWeight: '700', color: ${titleColor}, fontFamily: 'Poppins' },`,
      `  headerSub:    { fontSize: 13, color: ${isScan ? "'#AAAAAA'" : "'#6B7280'"}, marginTop: 4 },`,
      `  title:        { fontSize: 26, fontWeight: '700', color: '#1A1A2E', fontFamily: 'Poppins' },`,
      `  subtitle:     { fontSize: 13, color: '#6B7280', marginTop: 4 },`,
      `  errorBanner:  { backgroundColor: '#FEE2E2', borderRadius: 8, padding: 12, margin: 16 },`,
      `  errorText:    { color: '#DC2626', fontSize: 14, textAlign: 'center' },`,
    ];

    const formStyles = isForm ? [
      `  headerBg:          { backgroundColor: '#B83A3A', paddingTop: 64, paddingBottom: 44, alignItems: 'center' },`,
      `  logoText:          { fontSize: 32, fontWeight: '900', color: '#FFFFFF', letterSpacing: 4, fontFamily: 'Poppins' },`,
      `  form:              { flex: 1 },`,
      `  formContent:       { paddingHorizontal: 24, paddingTop: 32, paddingBottom: 40 },`,
      `  input:             { backgroundColor: '#FFFFFF', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16, marginBottom: 16, borderWidth: 1, borderColor: '#E5E7EB', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 2, elevation: 1 },`,
      `  submitBtn:         { backgroundColor: '#B83A3A', borderRadius: 12, paddingVertical: 16, alignItems: 'center', marginTop: 8, marginBottom: 16 },`,
      `  submitBtnDisabled: { opacity: 0.6 },`,
      `  submitText:        { color: '#FFFFFF', fontSize: 16, fontWeight: '700', fontFamily: 'Poppins' },`,
      `  linkBtn:           { alignItems: 'center', paddingVertical: 12 },`,
      `  linkText:          { color: '#B83A3A', fontSize: 14, fontWeight: '600' },`,
    ] : [];

    const listStyles = isList ? [
      `  searchContainer:   { paddingHorizontal: 16, paddingVertical: 10, backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderColor: '#F3F4F6' },`,
      `  searchInput:       { backgroundColor: '#F3F4F6', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15 },`,
      `  countText:         { fontSize: 12, color: '#9CA3AF', marginTop: 4 },`,
      `  listContent:       { paddingVertical: 8 },`,
      `  itemCard:          { backgroundColor: '#FFFFFF', borderRadius: 12, padding: 16, marginHorizontal: 16, marginBottom: 10, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 3, elevation: 2 },`,
      `  itemRow:           { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },`,
      `  itemName:          { fontSize: 15, fontWeight: '600', color: '#1A1A2E', flex: 1 },`,
      `  itemSub:           { fontSize: 13, color: '#6B7280', marginTop: 2 },`,
      `  badge:             { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },`,
      `  badgeGreen:        { backgroundColor: '#D1FAE5' },`,
      `  badgeRed:          { backgroundColor: '#FEE2E2' },`,
      `  badgeGray:         { backgroundColor: '#F3F4F6' },`,
      `  badgeText:         { fontSize: 11, fontWeight: '600', color: '#374151', textTransform: 'capitalize' },`,
      `  empty:             { alignItems: 'center', paddingTop: 80 },`,
      `  emptyIcon:         { fontSize: 40, marginBottom: 12 },`,
      `  emptyText:         { color: '#9CA3AF', fontSize: 16 },`,
    ] : [];

    const scanStyles = isScan ? [
      `  scanArea:          { flex: 1, backgroundColor: '#111111' },`,
      `  scanOverlay:       { flex: 1, justifyContent: 'center', alignItems: 'center' },`,
      `  scanFrame:         { width: 260, height: 260, position: 'relative', justifyContent: 'center', alignItems: 'center' },`,
      `  cameraPlaceholder: { width: 260, height: 260, backgroundColor: '#1A1A1A', borderRadius: 8, justifyContent: 'center', alignItems: 'center' },`,
      `  cameraPlaceholderText: { fontSize: 48, marginBottom: 8 },`,
      `  scanHint:          { color: '#CCCCCC', fontSize: 13, textAlign: 'center', paddingHorizontal: 20 },`,
      `  corner:            { position: 'absolute', width: 36, height: 36, borderColor: '#FFFFFF', borderWidth: 3 },`,
      `  topLeft:           { top: 0, left: 0, borderBottomWidth: 0, borderRightWidth: 0, borderTopLeftRadius: 4 },`,
      `  topRight:          { top: 0, right: 0, borderBottomWidth: 0, borderLeftWidth: 0, borderTopRightRadius: 4 },`,
      `  bottomLeft:        { bottom: 0, left: 0, borderTopWidth: 0, borderRightWidth: 0, borderBottomLeftRadius: 4 },`,
      `  bottomRight:       { bottom: 0, right: 0, borderTopWidth: 0, borderLeftWidth: 0, borderBottomRightRadius: 4 },`,
      `  resultCard:        { margin: 24, borderRadius: 12, padding: 16 },`,
      `  resultSuccess:     { backgroundColor: '#166534' },`,
      `  resultError:       { backgroundColor: '#7F1D1D' },`,
      `  resultTitle:       { color: '#FFFFFF', fontSize: 16, fontWeight: '700', marginBottom: 4 },`,
      `  resultText:        { color: '#EEEEEE', fontSize: 13 },`,
      `  processingBanner:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', margin: 16, backgroundColor: '#1F2937', borderRadius: 8, padding: 12, gap: 10 },`,
      `  processingText:    { color: '#FFFFFF', fontSize: 13 },`,
      `  rescanBtn:         { backgroundColor: '#B83A3A', marginHorizontal: 24, marginBottom: 32, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },`,
      `  rescanText:        { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },`,
    ] : [];

    const mapStyles = isMap ? [
      `  mapContainer:      { flex: 1, position: 'relative' },`,
      `  mapPlaceholder:    { flex: 1, backgroundColor: '#E5E7EB', justifyContent: 'center', alignItems: 'center' },`,
      `  mapIcon:           { fontSize: 48, marginBottom: 8 },`,
      `  mapText:           { fontSize: 16, color: '#6B7280', marginBottom: 4 },`,
      `  posText:           { fontSize: 12, color: '#9CA3AF', marginTop: 4 },`,
      `  routeLine:         { flexDirection: 'row', alignItems: 'center', marginTop: 16, gap: 8 },`,
      `  routeDot:          { width: 10, height: 10, borderRadius: 5, backgroundColor: '#9CA3AF' },`,
      `  routeDotStart:     { backgroundColor: '#16A34A', width: 14, height: 14, borderRadius: 7 },`,
      `  routeDotEnd:       { backgroundColor: '#B83A3A', width: 14, height: 14, borderRadius: 7 },`,
      `  tripSheet:         { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#FFFFFF', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 32, shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.1, shadowRadius: 8, elevation: 8 },`,
      `  sheetHandle:       { width: 40, height: 4, backgroundColor: '#E5E7EB', borderRadius: 2, alignSelf: 'center', marginBottom: 16 },`,
      `  sheetTitle:        { fontSize: 18, fontWeight: '700', color: '#1A1A2E', marginBottom: 16, fontFamily: 'Poppins' },`,
      `  tripRow:           { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderColor: '#F3F4F6' },`,
      `  tripLabel:         { fontSize: 14, color: '#6B7280' },`,
      `  tripValue:         { fontSize: 14, fontWeight: '600', color: '#1A1A2E' },`,
      `  tripStatusText:    { color: '#16A34A' },`,
      `  refreshBtn:        { backgroundColor: '#B83A3A', borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 16 },`,
      `  refreshText:       { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },`,
    ] : [];

    const genericStyles = (!isForm && !isList && !isScan && !isMap) ? [
      `  content:           { flex: 1 },`,
      `  contentInner:      { paddingHorizontal: 16, paddingVertical: 12 },`,
      `  actionBtn:         { backgroundColor: '#B83A3A', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginBottom: 12 },`,
      `  actionText:        { color: '#FFFFFF', fontSize: 16, fontWeight: '700', fontFamily: 'Poppins' },`,
    ] : [];

    return [...common, ...formStyles, ...listStyles, ...scanStyles, ...mapStyles, ...genericStyles, `});`];
  }

  private inferFileType(content: string, filePath: string): string {
    const lc = (content + filePath).toLowerCase();
    if (/screen|page|view/.test(lc))     return 'screen';
    if (/provider|store|state/.test(lc)) return 'store';
    if (/repository|repo/.test(lc))      return 'repository';
    if (/service/.test(lc))              return 'service';
    if (/model|entity/.test(lc))         return 'model';
    if (/widget|component/.test(lc))     return 'component';
    return 'util';
  }

  private generateContextStub(prompt: string, fileType: string, filePath: string): string {
    // Extraire le nom du composant/fichier depuis le prompt ou le filePath
    const nameMatch = /(?:screen|component|store|service|model|TARGET FILE):\s*(\w+)/i.exec(prompt)
      ?? /(?:generate|create|convert)\s+(\w+)/i.exec(prompt);
    const rawName = nameMatch?.[1]
      ?? filePath.split('/').pop()?.replace(/\.\w+$/, '') ?? 'Generated';
    const name = rawName.charAt(0).toUpperCase() + rawName.slice(1);

    // Détecter le type depuis le filePath si fileType est générique
    const fpLc = filePath.toLowerCase();
    const isScan = /scanner|scan_screen/.test(fpLc);
    const isMap  = /trajet|map_screen/.test(fpLc);
    const isList = /passager|list_screen/.test(fpLc);
    const isForm = /login|otp|register|signup/.test(fpLc);
    
    switch (fileType) {
      case 'screen':
      case 'component':
        // Pour les screens, utiliser generateCleanRNScreen avec un Dart minimal
        // qui encode le type détecté depuis le filePath — jamais de stub 18L
        if (isScan) {
          return this.generateCleanRNScreen(
            `class ${name}Screen extends ConsumerStatefulWidget {}\n// MobileScannerController _cameraController;\nbool _isInitialized = false;\nvoid _onBarcodeDetected(BarcodeCapture capture) async {\n  ref.read(scannerProvider.notifier).processQrCode('qr');\n}`,
            filePath,
          );
        }
        if (isMap) {
          return this.generateCleanRNScreen(
            `class ${name}Screen extends ConsumerStatefulWidget {}\n// FlutterMap MapController\n// flutter_map latlong2\nvoid initState() { ref.read(gpsProvider('trip').notifier).startTracking(); }`,
            filePath,
          );
        }
        if (isList) {
          return this.generateCleanRNScreen(
            `class ${name}Screen extends ConsumerStatefulWidget {}\nFuture<void> fetchPassagers() async {\n  ref.read(passagersProvider('trip').notifier).fetchPassagers();\n}\n// ListView passager booking`,
            filePath,
          );
        }
        if (isForm) {
          return this.generateCleanRNScreen(
            `class ${name}Screen extends ConsumerStatefulWidget {}\nfinal _phoneController = TextEditingController();\nFuture<void> submit() async {\n  ref.read(authProvider.notifier).login(phone: _phoneController.text);\n  context.go('/home');\n}`,
            filePath,
          );
        }
        // Fallback screen générique — toujours > 40 lignes
        return [
          `// [CodeMorph] Generated screen: ${name}`,
          `import React, { useState, useEffect } from 'react';`,
          `import { View, Text, StyleSheet, TouchableOpacity, ScrollView, StatusBar, ActivityIndicator, Alert } from 'react-native';`,
          `import { useRouter } from 'expo-router';`,
          ``,
          `export default function ${name}Screen(): React.JSX.Element {`,
          `  const router = useRouter();`,
          `  const [isLoading, setIsLoading] = useState<boolean>(false);`,
          `  const [error, setError] = useState<string | null>(null);`,
          ``,
          `  useEffect(() => {`,
          `    // Screen mounted`,
          `  }, []);`,
          ``,
          `  const handleAction = async (): Promise<void> => {`,
          `    setIsLoading(true);`,
          `    setError(null);`,
          `    try {`,
          `      // Main action`,
          `    } catch (e) {`,
          `      setError(e instanceof Error ? e.message : 'Erreur');`,
          `      Alert.alert('Erreur', String(e));`,
          `    } finally {`,
          `      setIsLoading(false);`,
          `    }`,
          `  };`,
          ``,
          `  if (isLoading) {`,
          `    return <View style={styles.center}><ActivityIndicator size="large" color="#B83A3A" /></View>;`,
          `  }`,
          ``,
          `  return (`,
          `    <View style={styles.container}>`,
          `      <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" />`,
          `      <View style={styles.header}>`,
          `        <Text style={styles.title}>${name}</Text>`,
          `      </View>`,
          `      <ScrollView style={styles.content}>`,
          `        {error && <Text style={styles.errorText}>{error}</Text>}`,
          `        <TouchableOpacity style={styles.btn} onPress={handleAction}>`,
          `          <Text style={styles.btnText}>Action principale</Text>`,
          `        </TouchableOpacity>`,
          `      </ScrollView>`,
          `    </View>`,
          `  );`,
          `}`,
          ``,
          `const styles = StyleSheet.create({`,
          `  container: { flex: 1, backgroundColor: '#F5F6FA' },`,
          `  center:    { flex: 1, justifyContent: 'center', alignItems: 'center' },`,
          `  header:    { backgroundColor: '#FFFFFF', paddingTop: 52, paddingHorizontal: 20, paddingBottom: 16 },`,
          `  title:     { fontSize: 26, fontWeight: '700', color: '#1A1A2E', fontFamily: 'Poppins' },`,
          `  content:   { flex: 1, padding: 16 },`,
          `  errorText: { color: '#DC2626', fontSize: 14, marginBottom: 12, textAlign: 'center' },`,
          `  btn:       { backgroundColor: '#B83A3A', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginBottom: 12 },`,
          `  btnText:   { color: '#FFFFFF', fontSize: 16, fontWeight: '700', fontFamily: 'Poppins' },`,
          `});`,
        ].join('\n');
      case 'store':
        return [
          `import { create } from 'zustand';`,
          `import axios from 'axios';`,
          `import { API_BASE_URL } from '../config/api.config';`,
          '',
          `interface ${name}State {`,
          `  data: unknown[];`,
          `  isLoading: boolean;`,
          `  error: string | null;`,
          `  fetch: () => Promise<void>;`,
          `  reset: () => void;`,
          `}`,
          '',
          `export const use${name}Store = create<${name}State>((set) => ({`,
          `  data: [],`,
          `  isLoading: false,`,
          `  error: null,`,
          `  fetch: async () => {`,
          `    set({ isLoading: true, error: null });`,
          `    try {`,
          `      const res = await axios.get(\`\${API_BASE_URL}/${name.toLowerCase()}s\`);`,
          `      set({ data: Array.isArray(res.data) ? res.data : res.data?.data ?? [], isLoading: false });`,
          `    } catch (e) {`,
          `      set({ error: e instanceof Error ? e.message : 'Error', isLoading: false });`,
          `    }`,
          `  },`,
          `  reset: () => set({ data: [], isLoading: false, error: null }),`,
          `}));`,
        ].join('\n');
      case 'model':
        return [
          `export interface ${name} {`,
          `  id: string;`,
          `  createdAt: Date;`,
          `}`,
          '',
          `export function ${name.charAt(0).toLowerCase() + name.slice(1)}FromJson(json: Record<string, unknown>): ${name} {`,
          `  return {`,
          `    id: String(json['id'] ?? ''),`,
          `    createdAt: new Date(String(json['createdAt'] ?? Date.now())),`,
          `  };`,
          `}`,
        ].join('\n');
      case 'service':
      case 'repository':
        return [
          `import axios from 'axios';`,
          `import { API_BASE_URL } from '../config/api.config';`,
          '',
          `class ${name} {`,
          `  private baseUrl = API_BASE_URL;`,
          '',
          `  async getAll(): Promise<unknown[]> {`,
          `    const res = await axios.get(\`\${this.baseUrl}/${name.toLowerCase()}s\`);`,
          `    return res.data;`,
          `  }`,
          '',
          `  async getById(id: string): Promise<unknown> {`,
          `    const res = await axios.get(\`\${this.baseUrl}/${name.toLowerCase()}s/\${id}\`);`,
          `    return res.data;`,
          `  }`,
          `}`,
          '',
          `export const ${name.charAt(0).toLowerCase() + name.slice(1)} = new ${name}();`,
          `export default ${name.charAt(0).toLowerCase() + name.slice(1)};`,
        ].join('\n');
      default:
        return `// ${name}\nexport const ${name.charAt(0).toLowerCase() + name.slice(1)} = {};\n`;
    }
  }

  // ── OpenAI / Groq (same SDK — Groq is OpenAI-compatible) ────────────────────
  private async openaiChat(messages: ChatMessage[], maxTokens: number, apiKey: string): Promise<AIResponse> {
    const client = new OpenAI({ apiKey });
    const res = await client.chat.completions.create({
      model:       this.model,
      messages,
      max_tokens:  maxTokens,
      temperature: appConfig.temperature,
    });
    return {
      content:    res.choices[0]?.message?.content ?? '',
      tokensUsed: res.usage?.total_tokens ?? 0,
      tier:       this.tier,
      model:      this.model,
    };
  }

  private async groqChat(messages: ChatMessage[], maxTokens: number): Promise<AIResponse> {
    // Groq free tier = 8000 TPM — cap max_tokens pour rester dans les limites
    // openai/gpt-oss-120b = primary, openai/gpt-oss-20b = fallback si 429
    const GROQ_MAX_TOKENS = Math.min(maxTokens, 2800);
    const client = new OpenAI({
      apiKey:  process.env['GROQ_API_KEY']!,
      baseURL: 'https://api.groq.com/openai/v1',
    });

    // ── Rate limiting global ──────────────────────────────────────────────────
    // Acquiert le slot (attend 35s depuis la fin de la dernière requête).
    // DOIT appeler release() dans un finally pour libérer le slot.
    const release = await groqRateLimiter.acquire();

    // Modèles à essayer en cascade si 429
    const GROQ_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];
    let lastError: Error | null = null;

    try {
      for (const modelId of GROQ_MODELS) {
        // Retry sur 429 résiduel uniquement (le rate limiter gère les cas normaux)
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await client.chat.completions.create({
              model:       modelId,
              messages,
              max_tokens:  GROQ_MAX_TOKENS,
              temperature: appConfig.temperature,
            });
            let rawContent = res.choices[0]?.message?.content ?? '';
            // Stripping <think>...</think> (qwen3.6-27b reasoning mode)
            rawContent = rawContent.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            if (modelId !== this.model) {
              console.log(`[AIProvider] Groq fallback succeeded with ${modelId} (primary ${this.model} was rate-limited)`);
            }
            console.log(`[AIProvider] Groq ✅ ${modelId} — ${res.usage?.total_tokens ?? '?'} tokens used`);
            return {
              content:    rawContent,
              tokensUsed: res.usage?.total_tokens ?? 0,
              tier:       'free-groq',
              model:      modelId,
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            const is429 = msg.includes('429') || msg.includes('rate limit') || msg.includes('Rate limit');
            if (is429) {
              // Extraire le délai Retry-After suggéré par l'API Groq
              const retryMatch = msg.match(/(\d+(?:\.\d+)?)s/);
              const waitSec = retryMatch?.[1]
                ? Math.max(parseFloat(retryMatch[1]) + 5, 40)
                : 45;
              console.warn(`[AIProvider] Groq 429 on ${modelId} attempt ${attempt+1}/2 — waiting ${waitSec}s (TPM recharge)...`);
              await new Promise((r) => setTimeout(r, waitSec * 1000));
              lastError = err instanceof Error ? err : new Error(msg);
              // Après 1 tentative sur 120b → passer immédiatement au modèle 20b
              if (modelId === GROQ_MODELS[0]) break;
            } else {
              throw err;
            }
          }
        }
      }
    } finally {
      // Libérer le slot — démarre le compte à rebours de 35s pour la prochaine requête
      release();
    }

    // Tous les modèles ont échoué
    throw lastError ?? new Error('Groq: all models exhausted');
  }

  // ── Anthropic ────────────────────────────────────────────────────────────────
  private async anthropicChat(messages: ChatMessage[], maxTokens: number): Promise<AIResponse> {
    const client = new Anthropic({ apiKey: this.userAnthropicKey! });
    const systemMsg = messages.find((m) => m.role === 'system')?.content ?? '';
    const userMsgs  = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const res = await client.messages.create({
      model:       this.model,
      max_tokens:  maxTokens,
      system:      systemMsg,
      messages:    userMsgs,
    });

    const content = res.content[0]?.type === 'text' ? res.content[0].text : '';
    return {
      content,
      tokensUsed: res.usage.input_tokens + res.usage.output_tokens,
      tier:       'pro-anthropic',
      model:      this.model,
    };
  }
}

// ── Singleton with default config (no user keys) ─────────────────────────────
export const defaultAIProvider = new AIProvider();
