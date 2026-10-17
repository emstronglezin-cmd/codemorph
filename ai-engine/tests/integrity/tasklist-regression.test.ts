// ============================================================
// CodeMorph — REGRESSION TEST EXIGÉ : fixture Flutter → React Native
// « petite application liste de tâches »
// PHASE 45
//
// Le test DOIT échouer (être détecté) quand :
//   • un module local référencé est absent ;
//   • TaskService et TaskTile utilisent des propriétés Task incompatibles ;
//   • l'application démarre sur AddTask au lieu de Home ;
//   • soumettre un titre n'ajoute pas de tâche ;
//   • la validation TypeScript échoue ;
//   • le rapport annonce un succès complet malgré une validation en échec.
//
// Et il DOIT passer sur une version correcte du même projet.
// ============================================================
import { validateProjectIntegrity } from '../../src/core/project-integrity-validator';
import { runStaticValidation }      from '../../src/core/static-validator';
import { runDeliveryCheck }         from '../../src/core/delivery-checker';
import type { GeneratedFile }       from '../../src/models/ir.types';
import type { IRFidelityScore, ContentValidationReport } from '../../src/models/ir.types';

const f = (path: string, content: string): GeneratedFile =>
  ({ path, content, language: 'typescript' } as GeneratedFile);

const codes = (r: { issues: { code: string }[] }): string[] => r.issues.map((i) => i.code);

// ── Le modèle CANONIQUE unique ────────────────────────────────────────────────
const TASK_MODEL = `export interface Task {
  id: string;
  title: string;
  completed: boolean;
}
`;

// ── Store partagé (état) ──────────────────────────────────────────────────────
const TASK_STORE = `import { Task } from '../models/Task';

let tasks: Task[] = [];
const listeners = new Set<() => void>();

export function getTasks(): Task[] {
  return tasks;
}

export function addTask(title: string): Task {
  const task: Task = { id: String(Date.now()), title, completed: false };
  tasks = [...tasks, task];
  listeners.forEach((l) => l());
  return task;
}

export function toggleTask(id: string): void {
  tasks = tasks.map((t) => (t.id === id ? { ...t, completed: !t.completed } : t));
  listeners.forEach((l) => l());
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
`;

const TASK_SERVICE = `import { Task } from '../models/Task';
import { addTask, getTasks, toggleTask } from '../state/taskStore';

export const TaskService = {
  list(): Task[] {
    return getTasks();
  },
  create(title: string): Task | null {
    const trimmed = title.trim();
    if (trimmed.length === 0) return null; // un titre vide ne crée pas de tâche
    return addTask(trimmed);
  },
  toggle(id: string): void {
    toggleTask(id);
  },
};
`;

const TASK_TILE = `import { Pressable, Text } from 'react-native';
import { Task } from '../models/Task';

export function TaskTile({ task, onToggle }: { task: Task; onToggle: (id: string) => void }) {
  return (
    <Pressable onPress={() => onToggle(task.id)}>
      <Text style={{ textDecorationLine: task.completed ? 'line-through' : 'none' }}>
        {task.title}
      </Text>
    </Pressable>
  );
}
`;

const HOME_SCREEN = `import { FlatList, Text } from 'react-native';
import { Link } from 'expo-router';
import { TaskService } from '../src/services/TaskService';
import { TaskTile } from '../src/components/TaskTile';

export default function Home() {
  const tasks = TaskService.list();
  const done = tasks.filter((t) => t.completed).length;
  return (
    <>
      <Text>{done}/{tasks.length} terminées</Text>
      <Link href="/add-task">Ajouter</Link>
      <FlatList
        data={tasks}
        keyExtractor={(t) => t.id}
        renderItem={({ item }) => (
          <TaskTile task={item} onToggle={(id) => TaskService.toggle(id)} />
        )}
      />
    </>
  );
}
`;

const ADD_TASK_SCREEN = `import { useState } from 'react';
import { Button, TextInput } from 'react-native';
import { router } from 'expo-router';
import { TaskService } from '../src/services/TaskService';

export default function AddTask() {
  const [title, setTitle] = useState('');

  const submit = (): void => {
    const created = TaskService.create(title);
    if (created === null) return;      // titre vide → rien n'est créé
    setTitle('');
    router.replace('/');               // retour explicite à l'accueil
  };

  return (
    <>
      <TextInput value={title} onChangeText={setTitle} placeholder="Titre" />
      <Button title="Ajouter" onPress={submit} />
    </>
  );
}
`;

const LAYOUT = `import { Stack } from 'expo-router';

export default function RootLayout() {
  return <Stack />;
}
`;

const MANIFEST = JSON.stringify({
  name: 'tasklist',
  version: '1.0.0',
  dependencies: {
    expo: '~50.0.0', 'expo-router': '~3.4.0',
    react: '18.2.0', 'react-native': '0.73.0',
  },
}, null, 2);

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2020', module: 'ESNext', moduleResolution: 'bundler',
    jsx: 'react-native', strict: true, noEmit: true, skipLibCheck: true,
    baseUrl: '.', paths: { '@/*': ['./src/*'] },
  },
}, null, 2);

/** Version CORRECTE du projet liste de tâches. */
function taskListProject(overrides: Record<string, string> = {}): GeneratedFile[] {
  const base: GeneratedFile[] = [
    f('package.json', MANIFEST),
    f('tsconfig.json', TSCONFIG),
    f('app.json', JSON.stringify({ expo: { name: 'tasklist', slug: 'tasklist' } })),
    f('app/_layout.tsx', LAYOUT),
    f('app/index.tsx', HOME_SCREEN),
    f('app/add-task.tsx', ADD_TASK_SCREEN),
    f('src/models/Task.ts', TASK_MODEL),
    f('src/state/taskStore.ts', TASK_STORE),
    f('src/services/TaskService.ts', TASK_SERVICE),
    f('src/components/TaskTile.tsx', TASK_TILE),
  ];
  const out = [...base];
  for (const [path, content] of Object.entries(overrides)) {
    const i = out.findIndex((x) => x.path === path);
    if (i >= 0) out[i] = f(path, content);
    else out.push(f(path, content));
  }
  return out;
}

/** Score de fidélité factice « parfait », pour tester le verdict de livraison. */
const perfectScore = {
  overall: 100, businessLogic: 100, navigation: 100, api: null, repositories: null,
  services: 100, stores: 100, components: 100, models: 100, uiFidelity: 100,
  dataLayer: 100, assets: null, functional: 100,
  applicableAxes: ['businessLogic', 'navigation'], naAxes: [],
  details: [],
} as unknown as IRFidelityScore;

const emptyContent = {
  totalFiles: 10, convertedFiles: 10, scaffoldFiles: 0, incompleteFiles: 0,
  totalSourceImports: 0, totalTodos: 0, files: [],
} as unknown as ContentValidationReport;

describe('REGRESSION — fixture Flutter → React Native « liste de tâches »', () => {
  // ── 0. La version correcte doit PASSER ───────────────────────────────────
  it('le projet liste de tâches correct obtient PASS sans aucune erreur', () => {
    const r = validateProjectIntegrity(taskListProject());
    expect(r.issues).toEqual([]);
    expect(r.verdict).toBe('PASS');

    const delivery = runDeliveryCheck(taskListProject(), perfectScore, emptyContent, {
      tsCompilation: { attempted: true, success: true, errors: [], warnings: [] },
      brokenImports: [], sourceImports: [], emptyFiles: [],
      criticalTodos: [], undefinedRefs: [], missingRoutes: [], overallPassed: true,
    }, undefined, r);
    expect(delivery.status).toBe('READY');
  });

  // ── 1. Module local référencé mais absent ────────────────────────────────
  it('DÉTECTÉ : TaskService importé depuis un chemin inexistant', () => {
    const files = taskListProject({
      'app/index.tsx': HOME_SCREEN.replace(
        "'../src/services/TaskService'", "'../src/services/TaskServiceV2'"),
    });
    const r = validateProjectIntegrity(files);
    expect(codes(r)).toContain('unresolved-local-import');
    expect(r.verdict).toBe('FAIL');
  });

  // ── 2. TaskService et TaskTile utilisent des Task incompatibles ──────────
  it('DÉTECTÉ : deux interfaces Task incompatibles (completed vs isDone)', () => {
    const files = taskListProject({
      // Un SECOND modèle Task, incompatible, utilisé par TaskTile
      'src/components/TaskTypes.ts': `export interface Task {
  id: string;
  title: string;
  isDone: boolean;
}
`,
      'src/components/TaskTile.tsx': TASK_TILE.replace(
        "'../models/Task'", "'./TaskTypes'"),
    });
    const r = validateProjectIntegrity(files);
    expect(codes(r)).toContain('model-property-mismatch');
    expect(r.verdict).toBe('FAIL');
  });

  // ── 3. L'application démarre sur AddTask ─────────────────────────────────
  it('DÉTECTÉ : lancement sur AddTask au lieu de Home (redirect)', () => {
    const files = taskListProject({
      'app/index.tsx': `import { Redirect } from 'expo-router';

export default function Index() {
  return <Redirect href="/add-task" />;
}
`,
    });
    const r = validateProjectIntegrity(files);
    expect(codes(r)).toContain('wrong-entry-route');
    expect(r.verdict).toBe('FAIL');
  });

  it('DÉTECTÉ : écran de lancement nommé AddTask', () => {
    const files = taskListProject({
      'app/index.tsx': `import { Text } from 'react-native';

export default function AddTaskScreen() {
  return <Text>add</Text>;
}
`,
    });
    const r = validateProjectIntegrity(files);
    expect(codes(r)).toContain('wrong-entry-route');
  });

  // ── 4. Soumettre un titre n'ajoute pas de tâche ──────────────────────────
  it('DÉTECTÉ : écran de saisie qui ne transmet aucune donnée', () => {
    const files = taskListProject({
      // TextInput présent, mais AUCUNE mutation d'état ni navigation
      'app/add-task.tsx': `import { useState } from 'react';
import { Button, TextInput } from 'react-native';

export default function AddTask() {
  const [title, setTitle] = useState('');
  return (
    <>
      <TextInput value={title} onChangeText={setTitle} placeholder="Titre" />
      <Button title="Ajouter" onPress={() => undefined} />
    </>
  );
}
`,
    });
    const r = validateProjectIntegrity(files);
    expect(codes(r)).toContain('form-not-wired');
    expect(r.verdict).toBe('FAIL');
  });

  // ── 5. La validation TypeScript doit réellement échouer ──────────────────
  it('EXÉCUTÉ : tsc échoue sur une erreur de type réelle', async () => {
    const files = taskListProject({
      // Erreur de type volontaire : `completed` attend un boolean, reçoit un number
      'src/state/taskStore.ts': TASK_STORE.replace(
        'completed: false', 'completed: 42 as unknown as boolean;\n  const broken: number = "pas un nombre" as unknown as number'),
      'src/models/Task.ts': TASK_MODEL + `\nexport const brokenConst: number = 'texte';\n`,
    });
    const result = await runStaticValidation(files, process.cwd(), 'dart');

    expect(result.tsCompilation.attempted).toBe(true);
    expect(result.tsCompilation.success).toBe(false);
    expect(result.tsCompilation.errors.length).toBeGreaterThan(0);
  }, 180_000);

  // ── 6. Le rapport ne doit PAS annoncer un succès complet ─────────────────
  it('DÉTECTÉ : score 100 % mais validation en échec → jamais READY', () => {
    const files = taskListProject({
      'app/index.tsx': HOME_SCREEN.replace(
        "'../src/services/TaskService'", "'../src/services/DoesNotExist'"),
    });
    const r = validateProjectIntegrity(files);

    const delivery = runDeliveryCheck(files, perfectScore, emptyContent, {
      tsCompilation: { attempted: true, success: true, errors: [], warnings: [] },
      brokenImports: [], sourceImports: [], emptyFiles: [],
      criticalTodos: [], undefinedRefs: [], missingRoutes: [], overallPassed: true,
    }, undefined, r);

    // Le score de fidélité reste à 100, mais le verdict de livraison doit
    // refléter la réalité : PAS de READY avec des erreurs d'intégrité.
    expect(delivery.score).toBe(100);
    expect(delivery.status).toBe('NEEDS_REPAIR');
    expect(delivery.integrityVerdict).toBe('FAIL');
    expect(delivery.blockers.length).toBeGreaterThan(0);
  });

  // ── 7. Une compilation non tentée n'est pas une réussite ─────────────────
  it('une compilation NON tentée est déclarée comme telle, pas comme réussie', () => {
    const r = validateProjectIntegrity(taskListProject());
    const delivery = runDeliveryCheck(taskListProject(), perfectScore, emptyContent, {
      tsCompilation: { attempted: false, success: false, errors: [], warnings: [] },
      brokenImports: [], sourceImports: [], emptyFiles: [],
      criticalTodos: [], undefinedRefs: [], missingRoutes: [], overallPassed: true,
    }, undefined, r);

    expect(delivery.compilationTested).toBe(false);
    const item = delivery.readyChecklist.find((c) => c.item === 'TypeScript compilation');
    expect(item?.detail).toMatch(/NOT TESTED/);
    expect(item?.detail).toMatch(/not a pass/);
  });

  // ── 8. Dépendance manquante ──────────────────────────────────────────────
  it('DÉTECTÉ : dépendance importée mais absente de package.json', () => {
    const files = taskListProject({
      'src/state/taskStore.ts':
        `import AsyncStorage from '@react-native-async-storage/async-storage';\n` + TASK_STORE +
        `\nexport const storage = AsyncStorage;\n`,
    });
    const r = validateProjectIntegrity(files);
    expect(codes(r)).toContain('missing-dependency');
    expect(r.verdict).toBe('FAIL');
  });
});
