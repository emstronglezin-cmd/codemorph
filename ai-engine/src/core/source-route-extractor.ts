/**
 * source-route-extractor.ts — PHASE 52
 *
 * Extraction des routes RÉELLES depuis le code source.
 *
 * ## Le défaut corrigé
 *
 * `ir-generator.inferUIGraphFromAST()` produisait la navigation ainsi :
 *
 * ```ts
 * navigationFlow: screens.slice(1).map((s) => ({
 *   from: screens[0]?.id ?? 'screen-home',
 *   to:   s.id,
 *   trigger: 'navigate',
 *   guard: '',
 * }))
 * ```
 *
 * Autrement dit : **chaque écran était déclaré atteignable depuis le premier,
 * par un déclencheur générique « navigate »**. Aucune ligne de la source
 * n'était lue. Les routes source n'étaient donc pas « mal détectées » — elles
 * n'étaient pas détectées du tout, elles étaient inventées à partir de l'ordre
 * des écrans.
 *
 * Conséquences en cascade : les écrans réellement navigables et ceux qui ne le
 * sont pas étaient indistinguables ; un écran orphelin apparaissait comme
 * reachable ; et la comparaison source ↔ cible portait sur des routes fictives.
 *
 * Ce module lit les appels de navigation réellement présents dans la source.
 * Il est générique : il ne connaît aucun nom d'écran particulier.
 */

export interface SourceRoute {
  /** Widget/écran d'où part la navigation (nom tel qu'il apparaît). */
  from:       string;
  /** Widget/écran ciblé, ou nom de route nommée. */
  to:         string;
  /** `push` (nouvel écran), `pop` (retour) ou `named` (route nommée). */
  kind:       'push' | 'pop' | 'named';
  /** Fichier source où l'appel a été trouvé. */
  sourceFile: string;
  /** Route nommée quand l'appel en utilise une (`'/detail'`). */
  routeName?: string;
}

export interface SourceRouteExtraction {
  routes:     SourceRoute[];
  /** Vrai si au moins un appel de navigation réel a été trouvé. */
  detected:   boolean;
  /** Mécanisme de navigation dominant dans la source. */
  mechanism:  'flutter-navigator' | 'go-router' | 'auto-route' | 'none';
}

/**
 * `Navigator.push(context, MaterialPageRoute(builder: (_) => DetailScreen()))`
 *
 * Le paramètre de type est optionnel et fréquent en Dart :
 * `Navigator.push<String>(context, ...)`. Sans `(?:<[^>]*>)?` cet appel — forme
 * réelle rencontrée dans la source du projet témoin — n'était pas reconnu : le
 * mécanisme était détecté mais 0 route extraite.
 */
const NAV_PUSH_RE =
  /Navigator\s*(?:\.of\s*\(\s*\w+\s*\))?\s*\.push(?:Replacement)?\s*(?:<[^>]*>)?\s*\(([\s\S]{0,400}?)\)\s*[,)]/g;

/** Cible d'un builder : `=> XScreen(` ou `=> const XScreen(` */
const BUILDER_TARGET_RE = /=>\s*(?:const\s+)?([A-Z][A-Za-z0-9_]*)\s*\(/;

/** `Navigator.pushNamed(context, '/detail')` */
const NAV_NAMED_RE =
  /Navigator\s*(?:\.of\s*\(\s*\w+\s*\))?\s*\.pushNamed(?:AndRemoveUntil)?\s*(?:<[^>]*>)?\s*\(\s*[\w.]+\s*,\s*['"]([^'"]+)['"]/g;

/** `Navigator.pop(context)` / `Navigator.maybePop(context)` */
const NAV_POP_RE = /Navigator\s*(?:\.of\s*\(\s*\w+\s*\))?\s*\.(?:pop|maybePop)\s*\(/g;

/** go_router : `context.go('/x')`, `context.push('/x')`, `context.goNamed('x')` */
const GO_ROUTER_RE =
  /\bcontext\s*\.\s*(?:go|push|pushReplacement|goNamed|pushNamed)\s*\(\s*['"]([^'"]+)['"]/g;

/** auto_route : `context.router.push(const XRoute())` */
const AUTO_ROUTE_RE = /\bcontext\s*\.\s*router\s*\.\s*(?:push|replace)\s*\(\s*(?:const\s+)?([A-Z][A-Za-z0-9_]*)/g;

/** `routes: { '/x': (_) => YScreen() }` dans MaterialApp */
const NAMED_ROUTES_TABLE_RE = /['"](\/[^'"]*)['"]\s*:\s*\([^)]*\)\s*=>\s*(?:const\s+)?([A-Z][A-Za-z0-9_]*)/g;

/**
 * Extrait les routes réelles d'un ensemble de fichiers sources.
 *
 * @param sources paires `{ path, content }` — le chemin sert à rattacher
 *                l'appel à son fichier d'origine.
 */
export function extractSourceRoutes(
  sources: Array<{ path: string; content: string }>,
): SourceRouteExtraction {
  const routes: SourceRoute[] = [];
  let sawNavigator = false;
  let sawGoRouter = false;
  let sawAutoRoute = false;

  for (const src of sources) {
    const content = src.content;
    const origin = baseWidgetName(src.path);

    if (/Navigator\s*(?:\.of\s*\(\s*\w+\s*\))?\s*\./.test(content)) sawNavigator = true;
    if (/\bcontext\s*\.\s*(?:go|push|pushReplacement|goNamed|pushNamed)\s*\(/.test(content)) sawGoRouter = true;
    if (/\bcontext\s*\.\s*router\s*\./.test(content)) sawAutoRoute = true;

    // Navigator.push(..., MaterialPageRoute(builder: (_) => XScreen()))
    let m: RegExpExecArray | null;
    NAV_PUSH_RE.lastIndex = 0;
    while ((m = NAV_PUSH_RE.exec(content)) !== null) {
      const body = m[1] ?? '';
      const target = BUILDER_TARGET_RE.exec(body)?.[1];
      if (!target) continue;
      routes.push({ from: origin, to: target, kind: 'push', sourceFile: src.path });
    }

    // Navigator.pushNamed(context, '/route')
    NAV_NAMED_RE.lastIndex = 0;
    while ((m = NAV_NAMED_RE.exec(content)) !== null) {
      const name = m[1] ?? '';
      routes.push({ from: origin, to: name, kind: 'named', sourceFile: src.path, routeName: name });
    }

    // Navigator.pop(context) — retour, sans cible explicite
    NAV_POP_RE.lastIndex = 0;
    while (NAV_POP_RE.exec(content) !== null) {
      routes.push({ from: origin, to: origin, kind: 'pop', sourceFile: src.path });
    }

    // go_router
    GO_ROUTER_RE.lastIndex = 0;
    while ((m = GO_ROUTER_RE.exec(content)) !== null) {
      const name = m[1] ?? '';
      routes.push({ from: origin, to: name, kind: 'named', sourceFile: src.path, routeName: name });
    }

    // auto_route
    AUTO_ROUTE_RE.lastIndex = 0;
    while ((m = AUTO_ROUTE_RE.exec(content)) !== null) {
      const target = m[1] ?? '';
      routes.push({ from: origin, to: target, kind: 'push', sourceFile: src.path });
    }

    // Table de routes nommées de MaterialApp
    NAMED_ROUTES_TABLE_RE.lastIndex = 0;
    while ((m = NAMED_ROUTES_TABLE_RE.exec(content)) !== null) {
      routes.push({
        from: origin,
        to: m[2] ?? '',
        kind: 'named',
        sourceFile: src.path,
        ...(m[1] ? { routeName: m[1] } : {}),
      });
    }
  }

  const mechanism: SourceRouteExtraction['mechanism'] =
    sawAutoRoute ? 'auto-route'
      : sawGoRouter ? 'go-router'
        : sawNavigator ? 'flutter-navigator'
          : 'none';

  return { routes, detected: routes.length > 0, mechanism };
}

/** Nom de widget déduit du chemin : `lib/screens/home_screen.dart` → `HomeScreen`. */
export function baseWidgetName(path: string): string {
  const last = path.split('/').pop() ?? path;
  const stem = last.replace(/\.(dart|ts|tsx|js|jsx)$/, '');
  return stem
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

/**
 * Résout une route source vers l'identifiant d'un écran généré.
 *
 * La correspondance est insensible à la casse et tolère les suffixes usuels
 * (`Screen`, `Page`, `View`) : `HomeScreen` dans la source correspond à l'écran
 * `home` généré.
 */
export function resolveRouteTarget(
  target: string,
  screens: Array<{ id: string; name?: string }>,
): string | null {
  const normalize = (s: string): string =>
    s.toLowerCase().replace(/(screen|page|view)$/g, '').replace(/[^a-z0-9]/g, '');

  const wanted = normalize(target);
  if (wanted.length === 0) return null;

  for (const s of screens) {
    if (normalize(s.name ?? '') === wanted) return s.id;
    if (normalize(s.id) === wanted) return s.id;
  }
  return null;
}
