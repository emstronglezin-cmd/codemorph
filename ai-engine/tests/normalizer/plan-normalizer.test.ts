// ============================================================
// CodeMorph — TESTS de non-régression : Plan Normalizer
// PHASE 46 — correction des règles de GÉNÉRATION (pas seulement détection)
//
// Chaque test cible un défaut réellement constaté sur plusieurs conversions.
// ============================================================
import {
  normalizePlan, reconcileManifest, deduplicateServices,
  deduplicatePaths, fixEntryRoute,
} from '../../src/core/plan-normalizer';
import type { GeneratedFile } from '../../src/models/ir.types';

const f = (path: string, content: string): GeneratedFile =>
  ({ path, content, language: 'typescript' } as GeneratedFile);

const pkg = (deps: Record<string, string>): GeneratedFile =>
  f('package.json', JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: deps }, null, 2));

describe('Plan Normalizer — dépendances absentes du manifeste', () => {
  it('AJOUTE une dépendance réellement importée mais non déclarée', () => {
    // Défaut réel : src/lib/storage.ts importe AsyncStorage, jamais déclaré
    // par rnPackageJson() dont la liste est figée.
    const files = [
      pkg({ expo: '~50.0.0', react: '18.2.0', 'react-native': '0.73.0' }),
      f('src/lib/storage.ts',
        `import AsyncStorage from '@react-native-async-storage/async-storage';\nexport const s = AsyncStorage;\n`),
    ];
    const { files: out, added } = reconcileManifest(files);
    expect(added).toContain('@react-native-async-storage/async-storage');

    const manifest = JSON.parse(out.find((x) => x.path === 'package.json')!.content) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies['@react-native-async-storage/async-storage']).toBeDefined();
    // Les dépendances existantes sont préservées
    expect(manifest.dependencies['expo']).toBe('~50.0.0');
  });

  it('NE DEVINE PAS la version d\'un paquet inconnu — il le signale', () => {
    const files = [
      pkg({ react: '18.2.0' }),
      f('src/x.ts', `import whatever from 'some-unknown-package-xyz';\nexport const a = whatever;\n`),
    ];
    const { added, unknown } = reconcileManifest(files);
    expect(added).toEqual([]);
    expect(unknown).toContain('some-unknown-package-xyz');
  });

  it('n\'ajoute rien quand tout est déjà déclaré', () => {
    const files = [
      pkg({ react: '18.2.0', axios: '^1.6.0' }),
      f('src/x.ts', `import axios from 'axios';\nexport const a = axios;\n`),
    ];
    const { added, unknown } = reconcileManifest(files);
    expect(added).toEqual([]);
    expect(unknown).toEqual([]);
  });

  it('ignore les modules Node natifs et les imports relatifs', () => {
    const files = [
      pkg({ react: '18.2.0' }),
      f('src/x.ts', `import * as path from 'path';\nimport { b } from './other';\nexport const a = path;\n`),
    ];
    const { added, unknown } = reconcileManifest(files);
    expect(added).toEqual([]);
    expect(unknown).toEqual([]);
  });

  it('ne détruit pas un package.json invalide', () => {
    const files = [f('package.json', '{ pas du json'), f('src/x.ts', `import a from 'axios';\nexport const z = a;\n`)];
    const { files: out, added } = reconcileManifest(files);
    expect(added).toEqual([]);
    expect(out.find((x) => x.path === 'package.json')!.content).toBe('{ pas du json');
  });
});

describe('Plan Normalizer — services dupliqués', () => {
  it('DÉDUPLIQUE deux conventions pour le même service, en gardant la plus complète', () => {
    // Défaut réel : code-planner écrit <nom>.service.ts, l'extracteur écrit <camel>.ts
    const pauvre = f('src/services/taskService.ts',
      `export const TaskService = { list: () => [] };\n`);
    const riche = f('src/services/taskservice.service.ts',
      `import { Task } from '../models/Task';\n\nexport const TaskService = {\n` +
      `  list(): Task[] { return []; },\n  create(t: string): Task | null { return null; },\n` +
      `  toggle(id: string): void { /* maj */ },\n};\n`);
    const { files, deduplicated } = deduplicateServices([pauvre, riche]);

    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe('src/services/taskservice.service.ts');
    expect(deduplicated).toHaveLength(1);
    expect(deduplicated[0]!.service).toBe('taskservice');
    expect(deduplicated[0]!.dropped).toBe('src/services/taskService.ts');
  });

  it('ne touche PAS à deux services réellement différents', () => {
    const a = f('src/services/taskService.ts', `export const TaskService = {};\n`);
    const b = f('src/services/userService.ts', `export const UserService = {};\n`);
    const { files, deduplicated } = deduplicateServices([a, b]);
    expect(files).toHaveLength(2);
    expect(deduplicated).toEqual([]);
  });

  it('n\'écarte aucune implémentation quand il n\'y a qu\'un seul fichier par service', () => {
    const only = f('src/services/taskService.ts', `export const TaskService = {};\n`);
    const { files } = deduplicateServices([only]);
    expect(files).toHaveLength(1);
  });
});

describe('Plan Normalizer — chemins en double', () => {
  it('conserve la version la plus complète et journalise', () => {
    const court = f('app/home.tsx', `export default function Home() { return null; }\n`);
    const long  = f('app/home.tsx',
      `import { Text } from 'react-native';\nexport default function Home() { return <Text>Home</Text>; }\n`);
    const { files, duplicates } = deduplicatePaths([court, long]);
    expect(files).toHaveLength(1);
    expect(files[0]!.content.length).toBe(long.content.length);
    expect(duplicates).toEqual([{ path: 'app/home.tsx', kept: 'richest' }]);
  });
});

describe('Plan Normalizer — route d\'entrée', () => {
  it('RECIBLE la redirection quand l\'écran ciblé n\'existe pas', () => {
    const files = [
      f('app/index.tsx',
        `import { useRouter } from 'expo-router';\nexport default function Index() {\n` +
        `  const router = useRouter();\n  router.replace('/homescreen');\n  return null;\n}\n`),
      f('app/home.tsx', `export default function Home() { return null; }\n`),
    ];
    const { files: out, fixed } = fixEntryRoute(files);
    expect(fixed).toBe(true);
    expect(out[0]!.content).toContain("router.replace('/home')");
  });

  it('ne change rien quand la cible existe', () => {
    const files = [
      f('app/index.tsx',
        `import { useRouter } from 'expo-router';\nexport default function Index() {\n` +
        `  const router = useRouter();\n  router.replace('/home');\n  return null;\n}\n`),
      f('app/home.tsx', `export default function Home() { return null; }\n`),
    ];
    const { files: out, fixed } = fixEntryRoute(files);
    expect(fixed).toBe(false);
    expect(out[0]!.content).toContain("router.replace('/home')");
  });

  it('ne change rien sans app/index.tsx (autres cibles de conversion)', () => {
    const files = [f('src/App.tsx', `export default function App() { return null; }\n`)];
    const { fixed } = fixEntryRoute(files);
    expect(fixed).toBe(false);
  });
});

describe('Plan Normalizer — point d\'entrée global', () => {
  it('est déterministe et sans effet de bord', () => {
    const files = [
      pkg({ react: '18.2.0' }),
      f('src/lib/storage.ts',
        `import AsyncStorage from '@react-native-async-storage/async-storage';\nexport const s = AsyncStorage;\n`),
      f('src/services/taskService.ts', `export const TaskService = {};\n`),
      f('src/services/taskservice.service.ts',
        `export const TaskService = { list: () => [], create: (t: string) => null };\n`),
    ];
    const snapshot = JSON.stringify(files);
    const a = normalizePlan(files);
    const b = normalizePlan(files);
    expect(a.report).toEqual(b.report);
    expect(JSON.stringify(files)).toBe(snapshot);
  });

  it('produit un plan où chaque import nu est déclaré ou explicitement signalé', () => {
    const files = [
      pkg({ react: '18.2.0', 'react-native': '0.73.0', expo: '~50.0.0' }),
      f('src/lib/storage.ts',
        `import AsyncStorage from '@react-native-async-storage/async-storage';\nexport const s = AsyncStorage;\n`),
    ];
    const { files: out, report } = normalizePlan(files);
    const manifest = JSON.parse(out.find((x) => x.path === 'package.json')!.content) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies)).toContain('@react-native-async-storage/async-storage');
    expect(report.unknownDependencies).toEqual([]);
  });
});
