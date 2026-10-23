// ============================================================
// Génère le projet « liste de tâches » avec le VRAI pipeline CodeMorph et
// l'écrit sur disque, pour correction manuelle vérifiable.
// ============================================================
import { buildSourceCode, freshDirs, makeCtx, makeFile } from '../phase36/fixtures';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';

const OUT = '/home/user/generated-tasklist';

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

export const TASKLIST_SOURCES = [
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
  void _refresh() => setState(() { _tasks = _service.getAll(); });
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

describe('Génération du projet à corriger', () => {
  const dirs = freshDirs();
  beforeAll(() => setTestEnv(dirs));

  it('écrit le projet généré sur disque', async () => {
    const { ConversionPipeline } = await import('../../src/core/pipeline');
    const res = await new ConversionPipeline().run(
      makeCtx('tasklist', buildSourceCode(TASKLIST_SOURCES)));

    rmSync(OUT, { recursive: true, force: true });
    let written = 0;
    for (const f of res.files) {
      // Les rapports internes ne font pas partie de l'application à corriger.
      if (f.path.startsWith('_codemorph-reports/')) continue;
      const target = join(OUT, f.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.content, 'utf8');
      written++;
    }
    console.log(`[GEN] ${written} fichiers écrits dans ${OUT}`);
    console.log(`[GEN] fidélité ${res.fidelityValidation?.overallFidelityScore}% / ` +
      `${res.fidelityValidation?.verdict} / fullyValidated=${res.fidelityValidation?.fullyValidated}`);
    expect(written).toBeGreaterThan(10);
  }, 600_000);
});
