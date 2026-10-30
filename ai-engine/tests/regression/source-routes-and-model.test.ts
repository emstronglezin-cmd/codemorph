/**
 * PHASE 52 — Régressions : routes source réelles, modèle unique, absence de
 * casts artificiels, et honnêteté du test « TypeScript compilation ».
 *
 * Les noms utilisés sont volontairement variés (`Note`, `NoteService`,
 * `DetailScreen`, `/settings`) : aucun correctif ne doit dépendre de `Task`.
 */
import {
  extractSourceRoutes, resolveRouteTarget, baseWidgetName,
} from '../../src/core/source-route-extractor';
import { checkGeneratedSyntax } from '../../src/core/syntax-validator';
import { CodePlanner } from '../../src/core/code-planner';
import { makeCtx, freshDirs } from '../phase36/fixtures';
import type { IRDocument } from '../../src/models/ir.types';

describe('PHASE 52 — les routes source sont lues, pas inventées', () => {
  it('extrait Navigator.push vers un écran construit', () => {
    const { routes, detected, mechanism } = extractSourceRoutes([{
      path: 'lib/screens/home_screen.dart',
      content: `
        class HomeScreen extends StatelessWidget {
          void open() {
            Navigator.push(context, MaterialPageRoute(builder: (_) => const DetailScreen()));
          }
        }`,
    }]);
    expect(detected).toBe(true);
    expect(mechanism).toBe('flutter-navigator');
    expect(routes).toContainEqual(expect.objectContaining({
      from: 'HomeScreen', to: 'DetailScreen', kind: 'push',
    }));
  });

  it('extrait Navigator.push<T> avec paramètre de type et saut de ligne', () => {
    // Forme réelle du projet témoin : sans la tolérance au générique, le
    // mécanisme était détecté mais 0 route extraite.
    const { routes, detected } = extractSourceRoutes([{
      path: 'lib/screens/home_screen.dart',
      content: `
        onPressed: () async {
          final title = await Navigator.push<String>(context,
            MaterialPageRoute(builder: (context) => const AddTaskScreen()),
          );
        },`,
    }]);
    expect(detected).toBe(true);
    expect(routes).toContainEqual(expect.objectContaining({
      from: 'HomeScreen', to: 'AddTaskScreen', kind: 'push',
    }));
  });

  it('extrait les routes nommées', () => {
    const { routes } = extractSourceRoutes([{
      path: 'lib/main.dart',
      content: `Navigator.pushNamed(context, '/settings');`,
    }]);
    expect(routes).toContainEqual(expect.objectContaining({
      to: '/settings', kind: 'named', routeName: '/settings',
    }));
  });

  it('extrait la table de routes nommées de MaterialApp', () => {
    const { routes } = extractSourceRoutes([{
      path: 'lib/main.dart',
      content: `routes: { '/home': (_) => HomeScreen(), '/detail': (_) => const DetailScreen() },`,
    }]);
    const named = routes.filter((r) => r.kind === 'named');
    expect(named.map((r) => r.routeName)).toEqual(['/home', '/detail']);
  });

  it('extrait go_router', () => {
    const { routes, mechanism } = extractSourceRoutes([{
      path: 'lib/app.dart',
      content: `context.go('/profile'); context.push('/settings');`,
    }]);
    expect(mechanism).toBe('go-router');
    expect(routes.map((r) => r.routeName)).toEqual(['/profile', '/settings']);
  });

  it('distingue pop (retour) d\'une route cible', () => {
    const { routes } = extractSourceRoutes([{
      path: 'lib/screens/detail.dart',
      content: `Navigator.pop(context);`,
    }]);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.kind).toBe('pop');
  });

  it('sans navigation dans la source, ne retourne AUCUNE route inventée', () => {
    // C'est le cœur du correctif : avant, chaque écran était déclaré reachable.
    const { routes, detected } = extractSourceRoutes([
      { path: 'lib/screens/home_screen.dart', content: 'class HomeScreen {}' },
      { path: 'lib/screens/detail_screen.dart', content: 'class DetailScreen {}' },
    ]);
    expect(detected).toBe(false);
    expect(routes).toEqual([]);
  });

  it('résout une cible vers l\'écran généré, suffixes tolérés', () => {
    const screens = [{ id: 'screen-home', name: 'HomeScreen' }, { id: 'screen-detail', name: 'Detail' }];
    expect(resolveRouteTarget('HomeScreen', screens)).toBe('screen-home');
    expect(resolveRouteTarget('DetailScreen', screens)).toBe('screen-detail');
    expect(resolveRouteTarget('Unknown', screens)).toBeNull();
  });

  it('baseWidgetName normalise les chemins Dart', () => {
    expect(baseWidgetName('lib/screens/home_screen.dart')).toBe('HomeScreen');
    expect(baseWidgetName('lib/add_task.dart')).toBe('AddTask');
  });
});

describe('PHASE 52 — un seul modèle, aucun cast artificiel', () => {
  function setEnv(): void {
    const d = freshDirs();
    process.env['CODEMORPH_CACHE_DIR'] = d.cacheDir;
    process.env['CODEMORPH_STATE_DIR'] = d.stateDir;
    process.env['CODEMORPH_OFFLINE'] = '1';
  }

  function ir(): IRDocument {
    return {
      version: '1.0', projectId: 'note-app', sourceFramework: 'flutter', targetFramework: 'react-native',
      architecture: { pattern: 'clean', modules: [], layers: [] },
      uiGraph: { screens: [], components: [], navigation: [] },
      backendGraph: {
        services: [{
          name: 'NoteService', dependencies: [],
          methods: [
            { name: 'getAll', params: [], returnType: 'List<Note>' },
            { name: 'add', params: [{ name: 'title', type: 'String' }], returnType: 'Note' },
            { name: 'toggle', params: [{ name: 'id', type: 'String' }], returnType: 'void' },
            { name: 'remove', params: [{ name: 'id', type: 'String' }], returnType: 'void' },
          ],
        }],
        controllers: [], routes: [], middlewares: [],
      },
      dataLayer: {
        models: [{
          name: 'Note',
          fields: [
            { name: 'id', type: 'String', nullable: false, unique: true, primary: true },
            { name: 'title', type: 'String', nullable: false, unique: false, primary: false },
            { name: 'isDone', type: 'bool', nullable: false, unique: false, primary: false },
          ],
        }],
        relationships: [], migrations: [],
      },
      dependencies: [], summary: { totalFiles: 1, convertedFiles: 1, skippedFiles: 0 },
    } as unknown as IRDocument;
  }

  it('n\'émet plus de définition concurrente `NoteList`', async () => {
    setEnv();
    const ctx = makeCtx('note-app', 'class Note { final String id; }');
    (ctx as { targetFramework: string }).targetFramework = 'react-native';
    const plan = await new CodePlanner().plan(ctx, ir());

    const modelFile = plan.files.find((f) => /types\/.*\.types\.ts$/.test(f.path));
    expect(modelFile).toBeDefined();
    // AVANT : `export interface NoteList { items; total; page }` était émis
    // systématiquement — une pagination REST inventée, définition concurrente.
    expect(modelFile!.content).not.toMatch(/interface\s+NoteList/);
    expect(modelFile!.content).toMatch(/interface\s+Note\b/);

    // Un seul type du domaine dans tout le plan.
    const modelDecls = plan.files
      .filter((f) => /\.(ts|tsx)$/.test(f.path))
      .flatMap((f) => [...f.content.matchAll(/export\s+interface\s+(Note\w*)\b/g)].map((m) => m[1]));
    expect([...new Set(modelDecls)]).toEqual(['Note']);
  }, 120_000);

  it('le service généré ne contient aucun cast artificiel', async () => {
    setEnv();
    const ctx = makeCtx('note-app', 'class Note { final String id; }');
    (ctx as { targetFramework: string }).targetFramework = 'react-native';
    const plan = await new CodePlanner().plan(ctx, ir());

    const service = plan.files.find((f) => /services?\/.*\.ts$/.test(f.path));
    expect(service).toBeDefined();
    const code = service!.content;

    // AVANT : `} as Note;` et `` `...` as unknown as string ``.
    expect(code).not.toMatch(/\}\s*as\s+Note\b/);
    expect(code).not.toMatch(/as\s+unknown\s+as/);
    expect(code).not.toMatch(/\bas\s+any\b/);

    // Le contrat complet attendu par les écrans.
    expect(code).toMatch(/\bgetAll\s*\(/);
    expect(code).toMatch(/\badd\s*\(/);
    expect(code).toMatch(/\btoggle\s*\(/);
    expect(code).toMatch(/\bremove\s*\(/);
    expect(code).toMatch(/\bsubscribe\s*\(/);

    // Et le fichier est syntaxiquement valide.
    expect(checkGeneratedSyntax([service!]).passed).toBe(true);
  }, 120_000);

  it('tout le plan généré est syntaxiquement valide', async () => {
    setEnv();
    const ctx = makeCtx('note-app', 'class Note { final String id; }');
    (ctx as { targetFramework: string }).targetFramework = 'react-native';
    const plan = await new CodePlanner().plan(ctx, ir());
    const result = checkGeneratedSyntax(plan.files);
    expect(result.invalid).toEqual([]);
    expect(result.passed).toBe(true);
  }, 120_000);
});
