// ============================================================
// CodeMorph — PHASE 49 : régression automatisée Flutter → React Native
// sur le cas « liste de tâches ».
//
// Ce test exécute le VRAI pipeline, puis vérifie quatre propriétés. Chacune
// DOIT échouer si le moteur régresse :
//   R1 imports locaux cassés
//   R2 modèles incohérents (doublon ou propriétés divergentes)
//   R3 écran initial incorrect
//   R4 ajout d'une tâche non fonctionnel
//
// R4 est vérifiée par EXÉCUTION réelle du code généré (le service est du
// TypeScript pur, sans dépendance native), pas par simple recherche de texte.
// ============================================================
import { buildSourceCode, freshDirs, makeCtx, makeFile } from '../phase36/fixtures';
import type { ASTFile } from '../../src/core/ast-analyzer';
import type { GeneratedFile } from '../../src/models/ir.types';
import { posix } from 'path';

function setTestEnv(dirs: { cacheDir: string; stateDir: string }): void {
  process.env['PHASE36_ENABLED']         = 'true';
  process.env['PHASE36_THRESHOLD_CHARS'] = '60000';
  process.env['PHASE36_THRESHOLD_FILES'] = '25';
  process.env['AI_MAX_CONCURRENT_REQUESTS'] = '1';
  process.env['AI_RETRY_DELAY_MS']       = '10';
  process.env['AI_RETRY_MAX_ATTEMPTS']   = '4';
  process.env['AI_CACHE_ENABLED']        = 'true';
  process.env['AI_CACHE_DIR']            = dirs.cacheDir;
  process.env['AI_STATE_DIR']            = dirs.stateDir;
  process.env['AI_RATE_LIMIT_TPM']       = '1000000';
  process.env['AI_MIN_INTERVAL_MS']      = '0';
  delete process.env['GROQ_API_KEY'];
  delete process.env['OPENAI_API_KEY'];
}

/** Fixture Flutter : modèle, service, composant, écran d'accueil, écran d'ajout. */
function taskListProject(): ASTFile[] {
  return [
    makeFile('lib/models/task.dart',
      'class Task {\n  final String id;\n  final String title;\n  final bool isDone;\n' +
      '  const Task({required this.id, required this.title, this.isDone = false});\n' +
      '  Task copyWith({String? id, String? title, bool? isDone}) =>\n' +
      '      Task(id: id ?? this.id, title: title ?? this.title, isDone: isDone ?? this.isDone);\n}\n'),
    makeFile('lib/services/task_service.dart',
      "import '../models/task.dart';\nclass TaskService {\n  final List<Task> _tasks = [];\n" +
      '  List<Task> getAll() => List.unmodifiable(_tasks);\n' +
      "  Task add(String title) {\n    final t = Task(id: DateTime.now().toIso8601String(), title: title);\n" +
      '    _tasks.add(t);\n    return t;\n  }\n' +
      '  void toggle(String id) {\n    final i = _tasks.indexWhere((t) => t.id == id);\n' +
      '    if (i >= 0) _tasks[i] = _tasks[i].copyWith(isDone: !_tasks[i].isDone);\n  }\n' +
      '  int get completedCount => _tasks.where((t) => t.isDone).length;\n}\n'),
    makeFile('lib/widgets/task_tile.dart',
      "import 'package:flutter/material.dart';\nimport '../models/task.dart';\n" +
      'class TaskTile extends StatelessWidget {\n  final Task task;\n  final ValueChanged<String> onToggle;\n' +
      '  const TaskTile({super.key, required this.task, required this.onToggle});\n  @override\n' +
      '  Widget build(BuildContext context) => ListTile(\n' +
      '    leading: Checkbox(value: task.isDone, onChanged: (_) => onToggle(task.id)),\n' +
      "    title: Text(task.title));\n}\n"),
    makeFile('lib/screens/home_screen.dart',
      "import 'package:flutter/material.dart';\nimport '../services/task_service.dart';\n" +
      "import '../widgets/task_tile.dart';\nimport 'add_task_screen.dart';\n" +
      'class HomeScreen extends StatefulWidget {\n  const HomeScreen({super.key});\n  @override\n' +
      '  State<HomeScreen> createState() => _HomeScreenState();\n}\n' +
      'class _HomeScreenState extends State<HomeScreen> {\n  final TaskService _service = TaskService();\n' +
      '  @override\n  Widget build(BuildContext context) => Scaffold(\n' +
      "    appBar: AppBar(title: const Text('Mes tâches')),\n" +
      '    body: Container(),\n' +
      '    floatingActionButton: FloatingActionButton(onPressed: () {}, child: const Icon(Icons.add)));\n}\n'),
    makeFile('lib/screens/add_task_screen.dart',
      "import 'package:flutter/material.dart';\nclass AddTaskScreen extends StatefulWidget {\n" +
      '  const AddTaskScreen({super.key});\n  @override\n' +
      '  State<AddTaskScreen> createState() => _AddTaskScreenState();\n}\n' +
      'class _AddTaskScreenState extends State<AddTaskScreen> {\n' +
      '  final TextEditingController _controller = TextEditingController();\n  @override\n' +
      '  Widget build(BuildContext context) => Scaffold(body: Container());\n}\n'),
  ];
}

describe('PHASE 49 — régression Flutter → RN « liste de tâches »', () => {
  const dirs = freshDirs();
  let gen: GeneratedFile[] = [];
  let byPath = new Map<string, string>();

  beforeAll(async () => {
    setTestEnv(dirs);
    const { ConversionPipeline } = await import('../../src/core/pipeline');
    const res = await new ConversionPipeline().run(
      makeCtx('regression-tasklist', buildSourceCode(taskListProject())));
    gen = res.files.filter((f) => !f.path.startsWith('_codemorph-reports/'));
    byPath = new Map(gen.map((f) => [f.path.replace(/\\/g, '/'), f.content]));
  }, 600_000);

  // ── R1 : imports locaux ───────────────────────────────────────────────────
  it('R1 — aucun import local cassé (chemins et casse réels)', () => {
    const exts = ['.ts', '.tsx', '.js', '.jsx'];
    const broken: string[] = [];

    for (const f of gen) {
      const path = f.path.replace(/\\/g, '/');
      if (!exts.some((e) => path.endsWith(e))) continue;
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';

      for (const m of f.content.matchAll(/(?:from|require\()\s*['"](\.[^'"]+)['"]/g)) {
        const spec = m[1] ?? '';
        if (!spec) continue;
        // Résolution POSIX réelle : `./x` et `../../x` doivent être normalisés,
        // sinon le contrôle signale des imports valides comme cassés.
        const resolved = posix.normalize(`${dir}/${spec}`);
        const candidates = [
          ...exts.map((e) => resolved + e),
          ...exts.map((e) => posix.join(resolved, `index${e}`)),
          resolved,
        ];
        // Comparaison EXACTE : la casse doit correspondre au fichier réel.
        if (!candidates.some((c) => byPath.has(c))) {
          broken.push(`${path} → ${spec}`);
          continue;
        }
        // Un fichier qui se ré-exporte lui-même est un cycle stérile.
        if (candidates.some((c) => c === path) && /export\s+\*\s+from/.test(f.content)) {
          broken.push(`${path} → ${spec} (auto-référence circulaire)`);
        }
      }
    }

    if (broken.length > 0) console.log(`[R1] imports cassés :\n  ${broken.join('\n  ')}`);
    expect(broken).toEqual([]);
  });

  // ── R2 : modèle unique et cohérent ────────────────────────────────────────
  it('R2 — un seul modèle Task, propriétés cohérentes partout', () => {
    const declaring = gen.filter((f) =>
      /\b(?:export\s+)?(?:interface|type|class)\s+Task\b/.test(f.content));

    if (declaring.length !== 1) {
      console.log(`[R2] fichiers déclarant Task : ${declaring.map((f) => f.path).join(', ') || 'aucun'}`);
    }
    expect(declaring.length).toBe(1);

    const model = declaring[0];
    expect(model).toBeDefined();
    const src = model?.content ?? '';

    // Les propriétés de la source Flutter doivent toutes être présentes.
    for (const prop of ['id', 'title', 'isDone']) {
      expect(src).toMatch(new RegExp(`\\b${prop}\\b`));
    }

    // Un seul champ de complétion : pas de `completed` en plus de `isDone`.
    const hasIsDone = /\bisDone\b/.test(src);
    const hasCompleted = /\bcompleted\s*[?:]/.test(src);
    expect(hasIsDone && hasCompleted).toBe(false);

    // Aucun consommateur ne doit réinventer un Task divergent.
    const divergent = gen.filter((f) =>
      f.path !== model?.path && /(?:interface|type)\s+Task\b/.test(f.content));
    expect(divergent.map((f) => f.path)).toEqual([]);
  });

  // ── R3 : écran initial ────────────────────────────────────────────────────
  it('R3 — l\'écran d\'accueil s\'ouvre au démarrage', () => {
    const layout = byPath.get('app/_layout.tsx') ?? '';
    const entry  = byPath.get('app/index.tsx') ?? '';

    // Chaque écran déclaré dans le layout doit exister.
    const declared = [...layout.matchAll(/<(?:Stack|Tabs|Drawer)\.Screen\s+[^>]*?name="([^"]+)"/g)]
      .map((m) => m[1] ?? '');
    for (const name of declared) {
      if (name.startsWith('(') || name.includes('[')) continue;
      const ok = ['app/', ''].flatMap((p) => ['.tsx', '.ts', '.jsx', '.js'].map((e) => `${p}${name}${e}`))
        .some((c) => byPath.has(c)) ||
        [...byPath.keys()].some((p) => p.startsWith(`app/${name}/`));
      if (!ok) console.log(`[R3] écran déclaré sans fichier : ${name}`);
      expect(ok).toBe(true);
    }

    // L'entrée ne doit PAS rediriger vers un écran d'ajout / de formulaire.
    const redirect = /router\s*\.\s*replace\(\s*['"]\/([^'"]+)['"]/.exec(entry)?.[1]
      ?? /<Redirect[^>]*href=["'`]\/([^"'`]+)/.exec(entry)?.[1];

    if (redirect) {
      const isForm = /add|new|create|edit|form/i.test(redirect);
      if (isForm) console.log(`[R3] l'entrée redirige vers un formulaire : /${redirect}`);
      expect(isForm).toBe(false);
      // La cible de redirection doit exister.
      const exists = ['.tsx', '.ts'].some((e) => byPath.has(`app/${redirect}${e}`));
      expect(exists).toBe(true);
    } else {
      // Sans redirection, app/index.tsx DOIT être un écran réel, pas un stub vide.
      const isStub = /return\s+<\s*>\s*<\/\s*>/.test(entry) || entry.trim().length < 80;
      if (isStub) console.log('[R3] app/index.tsx est un stub vide sans redirection utile');
      expect(isStub).toBe(false);
    }
  });

  // ── R4 : ajout d'une tâche, par EXÉCUTION du code généré ──────────────────
  it('R4 — l\'ajout d\'une tâche fonctionne réellement', async () => {
    // Trouver le service généré contenant la logique de tâche.
    const serviceFile = gen.find((f) =>
      /service/i.test(f.path) && /\b(add|getAll|toggle)\b/.test(f.content));

    if (!serviceFile) {
      console.log('[R4] aucun service de tâches trouvé dans le projet généré');
    }
    expect(serviceFile).toBeDefined();

    const src = serviceFile?.content ?? '';

    // Le service doit exposer un ajout prenant un titre — pas seulement un GET réseau.
    const hasAdd = /(?:function|async)\s+add\s*\(|\badd\s*[:=]\s*(?:async\s*)?\(/.test(src)
      || /\badd\s*\([^)]*title/.test(src);
    if (!hasAdd) {
      console.log('[R4] le service généré n\'expose aucune méthode add(title)');
      console.log(`[R4] contenu généré :\n${src.slice(0, 400)}`);
    }
    expect(hasAdd).toBe(true);

    // Exécution réelle : on compile le service et on l'appelle.
    const ts = await import('typescript');
    const js = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;

    // Les imports réseau du gabarit ne sont pas disponibles hors application :
    // on les neutralise SANS toucher à la logique métier testée.
    const Module = require('module');
    const originalResolve = Module._resolveFilename;
    Module._resolveFilename = function (request: string, ...args: unknown[]) {
      if (request.startsWith('.')) return require.resolve('path');
      return originalResolve.call(this, request, ...args);
    };

    let added = false;
    let listed = false;
    let counted = false;
    try {
      const mod = { exports: {} as Record<string, unknown> };
      // eslint-disable-next-line no-new-func
      new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
      const exported = mod.exports as Record<string, unknown>;

      // Le service peut être exporté comme fonction nue, comme classe ou comme
      // instance partagée : on accepte les trois formes réelles.
      const findTarget = (): Record<string, unknown> | undefined => {
        for (const value of Object.values(exported)) {
          if (value && typeof value === 'object' && typeof (value as { add?: unknown }).add === 'function') {
            return value as Record<string, unknown>;
          }
        }
        for (const value of Object.values(exported)) {
          if (typeof value === 'function'
              && typeof (value as { prototype?: { add?: unknown } }).prototype?.add === 'function') {
            return new (value as new () => Record<string, unknown>)();
          }
        }
        if (typeof exported['add'] === 'function') return exported;
        return undefined;
      };

      const target = findTarget();
      if (target) {
        // Appel lié à l'instance : détacher la méthode ferait perdre `this`.
        const addFn = target['add'] as (t: string) => unknown;
        const created = await Promise.resolve(addFn.call(target, 'Tâche de régression')) as
          { title?: string; isDone?: boolean; id?: string } | undefined;
        added = Boolean(created && created.title === 'Tâche de régression');

        const all = await Promise.resolve(
          (target['getAll'] as (() => unknown) | undefined)?.call(target)) as
          | { title?: string }[] | undefined;
        listed = Array.isArray(all) && all.some((t) => t?.title === 'Tâche de régression');

        // Complétion + compteur, si le service expose un état booléen.
        const toggleFn = target['toggle'] as ((id: string) => void) | undefined;
        const id = (created as { id?: string } | undefined)?.id;
        if (toggleFn && id) {
          toggleFn.call(target, id);
          const after = await Promise.resolve(
            (target['getAll'] as () => unknown).call(target)) as
            { id?: string; isDone?: boolean }[];
          const counters = Object.entries(target).filter(
            ([k]) => /count$/i.test(k) && typeof target[k] === 'number');
          const counterValue = counters.length > 0
            ? (target[counters[0]![0]] as number)
            : after.filter((t) => t?.isDone === true).length;
          counted = after.some((t) => t?.id === id && t?.isDone === true) && counterValue === 1;
        }
      }
      if (!target) console.log('[R4] aucune cible exécutable exportée par le service');
    } catch (e) {
      console.log(`[R4] exécution échouée : ${(e as Error).message}`);
    } finally {
      Module._resolveFilename = originalResolve;
    }

    if (!added)  console.log('[R4] add() n\'a pas créé la tâche attendue');
    if (!listed) console.log('[R4] getAll() ne retourne pas la tâche ajoutée');
    if (!counted) console.log('[R4] toggle/compteur non vérifiés ou en échec');
    expect(added).toBe(true);
    expect(listed).toBe(true);
    expect(counted).toBe(true);
  });
});
