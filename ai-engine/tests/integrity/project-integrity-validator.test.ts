// ============================================================
// CodeMorph — TESTS de non-régression : Project Integrity Validator
// PHASE 44
//
// Couvre les défauts observés en production + les garde-fous anti faux positifs.
// ============================================================
import {
  validateProjectIntegrity, formatIntegrityReport, type IntegrityIssueCode,
} from '../../src/core/project-integrity-validator';
import type { GeneratedFile } from '../../src/models/ir.types';

const f = (path: string, content: string): GeneratedFile =>
  ({ path, content, language: 'typescript' } as GeneratedFile);

const codes = (issues: { code: IntegrityIssueCode }[]): IntegrityIssueCode[] =>
  issues.map((i) => i.code);

/** Socle minimal valide : Expo Router + manifeste + tsconfig.
 *  Les fichiers passés en `extra` REMPLACENT ceux du socle ayant le même chemin
 *  (sinon on créerait un doublon, ce qui est un défaut légitimement détecté). */
function validProject(extra: GeneratedFile[] = []): GeneratedFile[] {
  const base = [
    f('package.json', JSON.stringify({
      name: 'demo', version: '1.0.0',
      dependencies: { expo: '~50.0.0', react: '18.2.0', 'react-native': '0.73.0', 'expo-router': '~3.4.0' },
    }, null, 2)),
    f('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } })),
    f('app.json', JSON.stringify({ expo: { name: 'demo', slug: 'demo' } })),
    f('app/_layout.tsx', `import { Stack } from 'expo-router';\nexport default function RootLayout() {\n  return <Stack />;\n}\n`),
    f('app/index.tsx', `import { Text } from 'react-native';\nexport default function Home() {\n  return <Text>Home</Text>;\n}\n`),
  ];
  const extraPaths = new Set(extra.map((x) => x.path));
  return [...base.filter((b) => !extraPaths.has(b.path)), ...extra];
}

describe('Project Integrity Validator — projet valide', () => {
  it('un projet Expo Router cohérent obtient PASS sans erreur', () => {
    const r = validateProjectIntegrity(validProject());
    expect(r.errorCount).toBe(0);
    expect(r.verdict).toBe('PASS');
    expect(r.passed).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('les imports relatifs avec extension implicite sont résolus', () => {
    const r = validateProjectIntegrity(validProject([
      f('src/components/Button.tsx', `import { Text } from 'react-native';\nexport function Button() { return <Text>ok</Text>; }\n`),
      f('app/index.tsx', `import { Button } from '../src/components/Button';\nexport default function Home() { return <Button />; }\n`),
    ]));
    expect(codes(r.issues)).not.toContain('unresolved-local-import');
  });

  it('les extensions de plateforme (.ios/.android/.native) ne sont pas des faux positifs', () => {
    const r = validateProjectIntegrity(validProject([
      f('src/haptics.ios.ts', `export const buzz = (): void => undefined;\n`),
      f('src/haptics.android.ts', `export const buzz = (): void => undefined;\n`),
      f('app/index.tsx', `import { buzz } from '../src/haptics';\nexport default function Home() { buzz(); return null; }\n`),
    ]));
    expect(r.errorCount).toBe(0);
  });

  it('les alias tsconfig déclarés sont résolus', () => {
    const r = validateProjectIntegrity(validProject([
      f('src/lib/api.ts', `export const ping = (): string => 'pong';\n`),
      f('app/index.tsx', `import { ping } from '@/lib/api';\nexport default function Home() { return ping(); }\n`),
    ]));
    expect(r.errorCount).toBe(0);
  });

  it('un index.ts est résolvable par son dossier', () => {
    const r = validateProjectIntegrity(validProject([
      f('src/theme/index.ts', `export const colors = { primary: '#000' };\n`),
      f('app/index.tsx', `import { colors } from '../src/theme';\nexport default function Home() { return colors.primary; }\n`),
    ]));
    expect(r.errorCount).toBe(0);
  });

  it('les routes dynamiques [id] ne produisent pas de faux positif', () => {
    const r = validateProjectIntegrity(validProject([
      f('app/details/[id].tsx', `export default function Details() { return null; }\n`),
      f('app/index.tsx', `import { router } from 'expo-router';\nexport default function Home() { router.push('/details/42'); return null; }\n`),
    ]));
    expect(codes(r.issues)).not.toContain('missing-route-target');
  });

  it('les modules Node natifs ne sont pas signalés comme dépendances manquantes', () => {
    const r = validateProjectIntegrity(validProject([
      f('src/util.ts', `import * as path from 'path';\nimport { Buffer } from 'node:buffer';\nexport const x = path.join('a', 'b') + Buffer.byteLength('a');\n`),
    ]));
    expect(codes(r.issues)).not.toContain('missing-dependency');
  });
});

describe('Project Integrity Validator — défauts détectés', () => {
  it('import local manquant → FAIL', () => {
    const r = validateProjectIntegrity(validProject([
      f('app/index.tsx', `import { Missing } from '../src/components/DoesNotExist';\nexport default function Home() { return <Missing />; }\n`),
    ]));
    expect(codes(r.issues)).toContain('unresolved-local-import');
    expect(r.verdict).toBe('FAIL');
    expect(r.passed).toBe(false);
  });

  it('dépendance absente de package.json → FAIL', () => {
    const r = validateProjectIntegrity(validProject([
      f('src/store.ts', `import AsyncStorage from '@react-native-async-storage/async-storage';\nexport const s = AsyncStorage;\n`),
    ]));
    expect(codes(r.issues)).toContain('missing-dependency');
    expect(r.verdict).toBe('FAIL');
    const issue = r.issues.find((i) => i.code === 'missing-dependency');
    expect(issue?.detail).toBe('@react-native-async-storage/async-storage');
  });

  it('navigation incorrecte : route référencée sans écran → FAIL', () => {
    const r = validateProjectIntegrity(validProject([
      f('app/index.tsx', `import { router } from 'expo-router';\nexport default function Home() { router.push('/settings/profile'); return null; }\n`),
    ]));
    expect(codes(r.issues)).toContain('missing-route-target');
    expect(r.verdict).toBe('FAIL');
  });

  it('fichier dupliqué → FAIL', () => {
    const dup = f('src/dup.ts', `export const a = 1;\nexport const b = 2;\nexport const c = 3;\n`);
    const r = validateProjectIntegrity(validProject([dup, { ...dup }]));
    expect(codes(r.issues)).toContain('duplicate-file');
    expect(r.verdict).toBe('FAIL');
  });

  it('génération partielle : fichier source vide → FAIL', () => {
    const r = validateProjectIntegrity(validProject([
      f('src/empty.ts', '// généré mais vide\n'),
    ]));
    expect(codes(r.issues)).toContain('empty-source-file');
    expect(r.verdict).toBe('FAIL');
  });

  it('package.json absent → FAIL (missing-config)', () => {
    const files = validProject().filter((x) => x.path !== 'package.json');
    const r = validateProjectIntegrity(files);
    expect(codes(r.issues)).toContain('missing-config');
    expect(r.verdict).toBe('FAIL');
  });

  it('package.json invalide → FAIL (invalid-config-json)', () => {
    const files = validProject().map((x) =>
      x.path === 'package.json' ? f('package.json', '{ pas du json ') : x);
    const r = validateProjectIntegrity(files);
    expect(codes(r.issues)).toContain('invalid-config-json');
  });

  it('aucun point d\'entrée → FAIL (missing-entrypoint)', () => {
    const files = validProject().filter((x) => !x.path.startsWith('app/'));
    const r = validateProjectIntegrity(files);
    expect(codes(r.issues)).toContain('missing-entrypoint');
  });

  it('tsconfig absent → PASS_WITH_WARNINGS (pas une erreur bloquante)', () => {
    const files = validProject().filter((x) => x.path !== 'tsconfig.json');
    const r = validateProjectIntegrity(files);
    expect(r.errorCount).toBe(0);
    expect(r.warningCount).toBeGreaterThan(0);
    expect(r.verdict).toBe('PASS_WITH_WARNINGS');
  });

  it('alias utilisé mais non déclaré → WARNING, jamais erreur', () => {
    const files = validProject([
      f('app/index.tsx', `import { x } from '@/lib/unknown';\nexport default function Home() { return x; }\n`),
    ]).filter((x) => x.path !== 'tsconfig.json');
    const r = validateProjectIntegrity(files);
    const aliasIssues = r.issues.filter((i) => i.detail?.startsWith('@/'));
    expect(aliasIssues.length).toBeGreaterThan(0);
    for (const i of aliasIssues) expect(i.severity).toBe('warning');
  });
});

describe('Project Integrity Validator — rapport et déterminisme', () => {
  it('le rendu texte ne contient jamais de contenu source', () => {
    const secret = 'CONTENU_SOURCE_SECRET_12345';
    const r = validateProjectIntegrity(validProject([
      f('app/index.tsx', `import { X } from '../missing';\nconst s = '${secret}';\nexport default function Home() { return s; }\n`),
    ]));
    const text = formatIntegrityReport(r);
    expect(text).not.toContain(secret);
    expect(text).toContain('verdict=FAIL');
  });

  it('déterministe : deux appels donnent exactement le même rapport', () => {
    const files = validProject([
      f('app/index.tsx', `import { A } from '../nope';\nimport axios from 'axios';\nexport default function H() { return axios; }\n`),
    ]);
    const a = validateProjectIntegrity(files);
    const b = validateProjectIntegrity(files);
    expect(a).toEqual(b);
  });

  it('ne modifie pas les fichiers reçus', () => {
    const files = validProject([f('src/x.ts', `export const v = 1;\n`)]);
    const before = JSON.stringify(files);
    validateProjectIntegrity(files);
    expect(JSON.stringify(files)).toBe(before);
  });
});
