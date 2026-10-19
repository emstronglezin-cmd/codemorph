// ============================================================
// CodeMorph — QA PHASE 48 : test de conversion bout-en-bout sur la fixture
// « liste de tâches » (écran principal, écran d'ajout, modèle Task, service de
// tâches, composant d'affichage).
//
// Ce test exécute le VRAI pipeline et OBSERVE le code réellement généré.
// Il ne fait aucune assertion complaisante : chaque contrôle imprime ce qu'il
// a trouvé, puis statue PASS / FAIL.
// ============================================================
import { buildSourceCode, freshDirs, makeCtx, makeFile } from '../phase36/fixtures';
import type { ASTFile } from '../../src/core/ast-analyzer';
import type { GeneratedFile } from '../../src/models/ir.types';

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

// ── FIXTURE : application Flutter « liste de tâches » ─────────────────────────
// Modèle Task, service de tâches, écran principal (liste + compteur + toggle),
// écran d'ajout (formulaire), composant d'affichage d'une tâche.
function buildTaskListProject(): ASTFile[] {
  return [
    makeFile('lib/models/task.dart',
`class Task {
  final String id;
  final String title;
  final bool isDone;
  const Task({required this.id, required this.title, this.isDone = false});
  Task copyWith({String? id, String? title, bool? isDone}) =>
      Task(id: id ?? this.id, title: title ?? this.title, isDone: isDone ?? this.isDone);
}
`),
    makeFile('lib/services/task_service.dart',
`import '../models/task.dart';
class TaskService {
  final List<Task> _tasks = [];
  List<Task> getAll() => List.unmodifiable(_tasks);
  Task add(String title) {
    final t = Task(id: DateTime.now().toIso8601String(), title: title);
    _tasks.add(t);
    return t;
  }
  void toggle(String id) {
    final i = _tasks.indexWhere((t) => t.id == id);
    if (i >= 0) _tasks[i] = _tasks[i].copyWith(isDone: !_tasks[i].isDone);
  }
  void remove(String id) => _tasks.removeWhere((t) => t.id == id);
  int get completedCount => _tasks.where((t) => t.isDone).length;
}
`),
    makeFile('lib/widgets/task_tile.dart',
`import 'package:flutter/material.dart';
import '../models/task.dart';
class TaskTile extends StatelessWidget {
  final Task task;
  final ValueChanged<String> onToggle;
  const TaskTile({super.key, required this.task, required this.onToggle});
  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: Checkbox(value: task.isDone, onChanged: (_) => onToggle(task.id)),
      title: Text(task.title,
          style: TextStyle(decoration: task.isDone ? TextDecoration.lineThrough : null)),
    );
  }
}
`),
    makeFile('lib/screens/home_screen.dart',
`import 'package:flutter/material.dart';
import '../models/task.dart';
import '../services/task_service.dart';
import '../widgets/task_tile.dart';
import 'add_task_screen.dart';
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}
class _HomeScreenState extends State<HomeScreen> {
  final TaskService _service = TaskService();
  List<Task> _tasks = [];
  void _refresh() => setState(() {
        _tasks = _service.getAll();
      });
  @override
  Widget build(BuildContext context) {
    final done = _service.completedCount;
    return Scaffold(
      appBar: AppBar(title: const Text('Mes tâches')),
      body: Column(children: [
        Padding(padding: const EdgeInsets.all(8), child: Text('\$done / \${_tasks.length} terminées')),
        Expanded(child: ListView.builder(
            itemCount: _tasks.length,
            itemBuilder: (_, i) => TaskTile(
                task: _tasks[i], onToggle: (id) { _service.toggle(id); _refresh(); }))),
      ]),
      floatingActionButton: FloatingActionButton(
          onPressed: () async {
            final title = await Navigator.push<String>(context,
                MaterialPageRoute(builder: (_) => const AddTaskScreen()));
            if (title != null && title.isNotEmpty) { _service.add(title); _refresh(); }
          },
          child: const Icon(Icons.add)),
    );
  }
}
`),
    makeFile('lib/screens/add_task_screen.dart',
`import 'package:flutter/material.dart';
class AddTaskScreen extends StatefulWidget {
  const AddTaskScreen({super.key});
  @override
  State<AddTaskScreen> createState() => _AddTaskScreenState();
}
class _AddTaskScreenState extends State<AddTaskScreen> {
  final TextEditingController _controller = TextEditingController();
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Nouvelle tâche')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(children: [
          TextField(controller: _controller, decoration: const InputDecoration(labelText: 'Titre')),
          ElevatedButton(
              onPressed: () => Navigator.pop(context, _controller.text),
              child: const Text('Ajouter')),
        ]),
      ),
    );
  }
}
`),
  ];
}

describe('QA PHASE 48 — conversion Flutter → RN de la liste de tâches', () => {
  const dirs = freshDirs();
  beforeAll(() => setTestEnv(dirs), 60_000);

  it('produit un projet réellement cohérent (observation)', async () => {
    const { ConversionPipeline } = await import('../../src/core/pipeline');
    const { runStaticValidation }   = await import('../../src/core/static-validator');
    const { validateProjectIntegrity } = await import('../../src/core/project-integrity-validator');

    const files = buildTaskListProject();
    const ctx   = makeCtx('qa-tasklist', buildSourceCode(files));
    const res   = await new ConversionPipeline().run(ctx);
    const gen: GeneratedFile[] = res.files ?? [];

    const byPath = new Map(gen.map((f) => [f.path, f.content]));
    const read   = (p: string): string => byPath.get(p) ?? '';
    const has    = (p: string): boolean => byPath.has(p);
    const all    = (): string => gen.map((f) => `// ${f.path}\n${f.content}`).join('\n\n');

    console.log(`\n[QA] fichiers générés (${gen.length}) :`);
    for (const f of gen.map((x) => x.path).sort()) console.log(`[QA]   ${f}`);

    // ── 1. STRUCTURE ────────────────────────────────────────────────────────
    const expected = ['app/index.tsx', 'app/_layout.tsx', 'package.json',
                      'app.json', 'tsconfig.json', 'src/models/task.ts',
                      'src/services/task.service.ts', 'src/components/task-tile.tsx'];
    const missing = expected.filter((p) => !has(p));
    console.log(`[QA1] structure attendue manquante : ${missing.length ? missing.join(', ') : 'aucune'}`);

    // ── 2. IMPORTS LOCAUX ───────────────────────────────────────────────────
    const { analyzeSource } = await import('../../src/core/fidelity-engine');
    const sa = analyzeSource('qa', buildSourceCode(files), 'Flutter');
    const val = await runStaticValidation(gen, process.cwd(), 'dart', {
      models: sa.models, services: [...sa.services, ...sa.repositories],
      screens: sa.screens, widgets: sa.widgets,
    });
    console.log(`[QA2] imports locaux cassés : ${val.brokenImports.length ? val.brokenImports.join(' | ') : 'aucun'}`);
    console.log(`[QA2] dépendances manquantes : ${(val.checks?.find(c=>c.id==='dependencies')?.errors ?? []).join(' | ') || 'aucune'}`);

    // ── 3. COMPATIBILITÉ DES TYPES Task ─────────────────────────────────────
    const modelSrc = read('src/models/task.ts');
    const svcSrc   = read('src/services/task.service.ts');
    const tileSrc  = read('src/components/task-tile.tsx');
    const homeSrc  = read('app/index.tsx');
    console.log(`[QA3] modèle Task présent : ${modelSrc ? 'oui' : 'NON'}`);
    console.log(`[QA3] propriétés du modèle : ${
      (modelSrc.match(/^\s*(readonly\s+)?(\w+)\s*[?:]/gm) ?? []).map(s=>s.trim()).join(', ') || 'aucune détectée'}`);
    console.log(`[QA3] service importe le modèle : ${/from ['"].*models\/task['"]/.test(svcSrc) ? 'oui' : 'NON'}`);
    console.log(`[QA3] composant importe le modèle : ${/from ['"].*models\/task['"]/.test(tileSrc) ? 'oui' : 'NON'}`);
    // Détection d'un modèle dupliqué/divergent
    const dupModel = gen.filter((f) => /interface Task\b/.test(f.content)).map((f) => f.path);
    console.log(`[QA3] fichiers déclarant "interface Task" : ${dupModel.join(', ') || 'aucun'}`);

    // ── 4. ÉCRAN OUVERT AU LANCEMENT ────────────────────────────────────────
    const layout = read('app/_layout.tsx');
    console.log(`[QA4] app/index.tsx = écran principal (liste) : ${
      /Mes tâches|TaskTile|ListView|FlatList/.test(homeSrc) ? 'oui' : 'NON — ' + homeSrc.slice(0, 120).replace(/\n/g, ' ')}`);
    console.log(`[QA4] _layout référence : ${
      (layout.match(/name=["'{][^"'}]+/g) ?? []).join(', ') || 'aucune'}`);
    const addRoute = has('app/add-task.tsx') || has('app/add_task.tsx') || has('app/add.tsx');
    console.log(`[QA4] route d'ajout présente : ${addRoute ? 'oui' : 'NON'}`);

    // ── 5. FORMULAIRE → AJOUT → AFFICHAGE ───────────────────────────────────
    const addSrc = read('app/add-task.tsx') || read('app/add_task.tsx') || read('app/add.tsx');
    console.log(`[QA5] le formulaire transmet le titre : ${
      /router\.(back|push|replace)\(\{[^}]*title|params[^)]*title|title:/.test(addSrc) ? 'oui' : 'NON'}`);
    console.log(`[QA5] l'écran principal lit le paramètre : ${
      /useLocalSearchParams|useRoute|params/.test(homeSrc) ? 'oui' : 'NON'}`);
    console.log(`[QA5] l'écran principal appelle add() : ${/\.add\(/.test(homeSrc) ? 'oui' : 'NON'}`);
    console.log(`[QA5] la liste est rendue depuis l'état : ${
      /(\.map\(|FlatList|data=\{)/.test(homeSrc) ? 'oui' : 'NON'}`);

    // ── 6. TOGGLE → AFFICHAGE + COMPTEUR ────────────────────────────────────
    console.log(`[QA6] toggle présent dans le service : ${/toggle/.test(svcSrc) ? 'oui' : 'NON'}`);
    console.log(`[QA6] compteur dans le service : ${/completedCount|completed|done/.test(svcSrc) ? 'oui' : 'NON'}`);
    console.log(`[QA6] écran appelle toggle : ${/toggle/.test(homeSrc) ? 'oui' : 'NON'}`);
    console.log(`[QA6] écran affiche le compteur : ${/terminées|completedCount|completed|done/i.test(homeSrc) ? 'oui' : 'NON'}`);
    console.log(`[QA6] état mis à jour (setState/useState) : ${/useState|setTasks|setState/.test(homeSrc) ? 'oui' : 'NON'}`);
    console.log(`[QA6] style barré selon isDone : ${/lineThrough|line-through/.test(tileSrc) ? 'oui' : 'NON'}`);

    // ── 7. CONTRÔLES RÉELLEMENT EXÉCUTÉS ────────────────────────────────────
    console.log(`[QA7] contrôles du PIPELINE (durée ${res.validationDurationMs}ms) :`);
    for (const c of res.validationChecks ?? []) {
      console.log(`[QA7]   ${c.id}: ${c.status} [${c.durationMs}ms]` +
        (c.status === 'NOT_RUN' ? ` — ${c.notRunReason}` : c.errors.length ? ` — ${c.errors[0]}` : ''));
    }

    // ── 8. COHÉRENCE DU RAPPORT ─────────────────────────────────────────────
    const integ = validateProjectIntegrity(gen);
    console.log(`[QA8] intégrité : ${integ.passed ? 'PASS' : 'FAIL'} — erreurs ${integ.errorCount}, warnings ${integ.warningCount}`);
    for (const i of integ.issues.filter((x) => x.severity === 'error').slice(0, 12)) {
      console.log(`[QA8]   ✗ ${i.code} — ${i.message}`);
    }
    console.log(`[QA8] fidelityScore (ConversionResult) : ${res.fidelityScore?.overall ?? 'n/a'}%`);
    const anyRes = res as unknown as Record<string, unknown>;
    const fv = res.fidelityValidation;
    console.log(`[QA8] rapport fidélité exposé : ${fv ? 'OUI' : 'NON — champ absent'}`);
    if (fv) {
      console.log(`[QA8] verdict : ${fv.verdict} — ${fv.verdictReason}`);
      console.log(`[QA8] fullyValidated : ${fv.fullyValidated}`);
      console.log(`[QA8] critiques en échec : ${fv.failedCritical?.join(', ') || 'aucun'}`);
      console.log(`[QA8] critiques non exécutés : ${fv.notRunCritical?.join(', ') || 'aucun'}`);
      const b = fv.scoreBreakdown;
      if (b) {
        const f2 = (v: number | null): string => (v === null ? 'non mesuré' : `${v}%`);
        console.log(`[QA8] décomposition : source ${f2(b.sourceCoverage)}, structure ${f2(b.structuralCoherence)}, ` +
          `fonctionnel ${f2(b.functionalPreservation)}, statique ${f2(b.staticValidation)}, ` +
          `tests ${f2(b.testsExecuted)}, compilation ${f2(b.compilationSucceeded)}`);
      }
    }
    console.log(`[QA8] contrôles exposés sur ConversionResult : ${'validationChecks' in res ? 'OUI' : 'NON — champ absent'}`);
    console.log(`[QA8] durée de validation exposée : ${'validationDurationMs' in res ? anyRes['validationDurationMs'] : 'NON — champ absent'}`);

    // ── DUMP pour diagnostic ────────────────────────────────────────────────
    require('fs').writeFileSync('/tmp/qa-tasklist-dump.ts', all());
    console.log(`[QA] dump écrit : /tmp/qa-tasklist-dump.ts`);

    // ═══════════════════════════════════════════════════════════════════════
    // ASSERTIONS DE NON-RÉGRESSION
    // Chacune correspond à un défaut réellement observé avant correction.
    // ═══════════════════════════════════════════════════════════════════════

    // D1 — l'IR statique vidait dataLayer : le modèle Task disparaissait.
    const taskModel = gen.find((f) => /\b(?:interface|type|class)\s+Task\b/.test(f.content));
    expect(taskModel).toBeDefined();
    // D2 — les champs étaient codés en dur à `id` seul.
    expect(taskModel?.content).toMatch(/title/);
    expect(taskModel?.content).toMatch(/isDone/);

    // D1 — le service de tâches doit survivre.
    expect(gen.some((f) => /taskservice|task\.service|TaskService/i.test(f.path + f.content))).toBe(true);
    // D1 — le composant d'affichage doit survivre.
    expect(gen.some((f) => /tasktile/i.test(f.path))).toBe(true);
    // Les écrans source doivent exister en tant que routes.
    expect(has('app/home.tsx')).toBe(true);
    expect(has('app/addtask.tsx')).toBe(true);

    // D3 — un layout ne doit plus déclarer d'écran sans fichier correspondant.
    expect(integ.issues.filter((i) => i.code === 'missing-layout-screen')).toHaveLength(0);

    // D3 — aucun groupe de routes vide ne subsiste.
    const tabLayouts = gen.filter((f) => /app\/\([^)]+\)\/_layout\.tsx$/.test(f.path));
    for (const tl of tabLayouts) {
      const dir = tl.path.slice(0, tl.path.lastIndexOf('/'));
      const peers = gen.filter((f) => f.path.startsWith(`${dir}/`) && f.path !== tl.path);
      expect(peers.length).toBeGreaterThan(0);
    }

    // D4 — la validation réellement exécutée est exposée au client.
    expect(res.validationChecks).toBeDefined();
    expect((res.validationChecks ?? []).length).toBeGreaterThan(0);
    expect(res.validationDurationMs).toBeGreaterThan(0);
    expect(res.fidelityValidation).toBeDefined();
    expect(res.fidelityValidation?.fullyValidated).toBe(false);

    // D5 — tant que les tests et le build ne sont pas exécutés, jamais EXCELLENT.
    const notRun = (res.validationChecks ?? []).filter((c) => c.status === 'NOT_RUN').map((c) => c.id);
    expect(notRun).toContain('tests');
    expect(notRun).toContain('build');
    expect(res.fidelityValidation?.verdict).not.toBe('EXCELLENT');

    // D6 — un contrôle non exécuté n'est jamais compté comme réussi.
    for (const c of res.validationChecks ?? []) {
      if (c.status === 'NOT_RUN') expect(c.durationMs).toBe(0);
    }
    // Le score ne dépasse pas le plafond imposé par les contrôles non exécutés.
    expect(res.fidelityValidation?.overallFidelityScore ?? 0).toBeLessThanOrEqual(84);

    // Les composants non mesurés restent null, jamais 100.
    expect(res.fidelityValidation?.scoreBreakdown?.functionalPreservation).toBeNull();
    expect(res.fidelityValidation?.scoreBreakdown?.testsExecuted).toBeNull();

    // ── 8. CONCORDANCE DES RAPPORTS FINAUX ──────────────────────────────────
    const mdRaw   = read('_codemorph-reports/conversion-report.md');
    const jsonRaw = read('_codemorph-reports/conversion-report.json');
    console.log(`[QA8] rapport MD contient la section validation : ${
      /Validation réellement exécutée/.test(mdRaw) ? 'OUI' : 'NON'}`);

    expect(mdRaw).toMatch(/Validation réellement exécutée/);
    // Le rapport ne peut pas annoncer une validation complète.
    expect(mdRaw).toMatch(/entièrement validé\s*:\s*❌ NON/i);
    expect(mdRaw).toMatch(/NOT_RUN/);
    // Chaque contrôle présent dans ConversionResult apparaît dans le Markdown.
    for (const c of res.validationChecks ?? []) {
      expect(mdRaw).toContain(c.id);
    }
    // Le JSON embarque les mêmes contrôles que le résultat du pipeline.
    if (jsonRaw) {
      const parsed = JSON.parse(jsonRaw) as {
        validation?: { checks?: Array<{ id: string; status: string; durationMs: number }> };
      };
      const jsonIds = (parsed.validation?.checks ?? []).map((c) => c.id).sort();
      const resIds  = (res.validationChecks ?? []).map((c) => c.id).sort();
      console.log(`[QA8] contrôles dans le JSON : ${jsonIds.length} | dans le résultat : ${resIds.length}`);
      expect(jsonIds).toEqual(resIds);
      expect(parsed.validation?.checks?.every((c) => c.status !== 'PASS' || c.durationMs >= 0)).toBe(true);
    }
    // La durée annoncée dans le rapport est la durée réellement mesurée.
    expect(mdRaw).toContain(`${res.validationDurationMs} ms`);
  }, 600_000);
});
