/**
 * PHASE 51 — Régressions sur la fiabilité de livraison.
 *
 * Chaque test correspond à un défaut réellement observé ou reproduit :
 *   • S1 — un fichier généré syntaxiquement invalide (TS1005) livré sans contrôle ;
 *   • S2 — `Ready For Production: YES` avec NEEDS_REPAIR, un blocker et une
 *          erreur TypeScript ;
 *   • S3 — une compilation SKIPPED comptabilisée comme réussie ;
 *   • S4 — le point d'entrée détecté était `src/theme/index.ts` ;
 *   • S5 — les écrans Expo Router (`app/*.tsx`) déclarés absents.
 */
import {
  checkSyntax, checkGeneratedSyntax, formatSyntaxIssues,
} from '../../src/core/syntax-validator';
import {
  evaluateProductionReadiness, CRITICAL_FUNCTIONAL_FEATURES, deriveRoundTripStatus,
  type ReportValidationSection, type ReportDeliverySection, type ReportFunctionalSection,
} from '../../src/core/conversion-report';
import { findEntryPoint, findScreenFiles } from '../../src/core/functional-test-runner';
import { splitDeliverableFiles, reconcileFileCounts } from '../../src/core/canonical-ir';
import type { GeneratedFile } from '../../src/models/ir.types';

const f = (path: string, content: string): GeneratedFile =>
  ({ path, content, language: 'typescript' });

// ── S1 : contrôle syntaxique ─────────────────────────────────────────────────

describe('PHASE 51 — S1 : contrôle syntaxique systématique des fichiers générés', () => {
  it('détecte une accolade manquante (la classe d\'erreur TS1005 observée)', () => {
    // Reproduction de la forme du défaut signalé sur TaskTile.tsx : un bloc
    // JSX/objet non refermé en fin de fichier.
    const broken = [
      'import React from "react";',
      'export function TaskTile(): React.JSX.Element {',
      '  return (',
      '    <View>',
      '      <Text>titre</Text>',
      '    </View>',
      '  );',
      '// accolade fermante manquante',
    ].join('\n');

    const issues = checkSyntax('src/components/TaskTile.tsx', broken);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.code === 1005 || i.code === 1128)).toBe(true);
    expect(issues[0]?.file).toBe('src/components/TaskTile.tsx');
    expect(issues[0]?.line).toBeGreaterThan(0);
  });

  it('détecte une virgule en trop dans un objet (TS1136, déjà observé)', () => {
    const broken = 'export const task = {\n  title: "x",,\n  isDone: false,\n};\n';
    const issues = checkSyntax('src/services/task.ts', broken);
    expect(issues.some((i) => i.code === 1136)).toBe(true);
  });

  it('accepte un fichier valide', () => {
    const valid = [
      'import React from "react";',
      'import { View, Text } from "react-native";',
      'export function TaskTile({ title }: { title: string }): React.JSX.Element {',
      '  return (<View><Text>{title}</Text></View>);',
      '}',
    ].join('\n');
    expect(checkSyntax('src/components/TaskTile.tsx', valid)).toEqual([]);
  });

  it('analyse tout un plan et isole les fichiers fautifs', () => {
    const files = [
      f('src/ok.ts', 'export const a = 1;\n'),
      f('src/bad.ts', 'export const b = {\n  x: 1,,\n};\n'),
      f('README.md', '# pas du TypeScript — ignoré'),
    ];
    const result = checkGeneratedSyntax(files);
    expect(result.checked).toBe(2);
    expect(result.passed).toBe(false);
    expect(new Set(result.invalid.map((i) => i.file))).toEqual(new Set(['src/bad.ts']));
    expect(formatSyntaxIssues(result)).toContain('src/bad.ts');
  });

  it('passe sur un plan entièrement valide', () => {
    const result = checkGeneratedSyntax([f('src/ok.ts', 'export const a = 1;\n')]);
    expect(result.passed).toBe(true);
    expect(result.invalid).toEqual([]);
  });
});

// ── S2/S3 : règle de production ──────────────────────────────────────────────

const validation = (over: Partial<ReportValidationSection> = {}): ReportValidationSection => ({
  fullyValidated: true, durationMs: 1, failedCritical: [], notRunCritical: [],
  checks: [], ...over,
});

describe('PHASE 51 — S2/S3 : la règle de production part des résultats réels', () => {
  const base = {
    fidelityScore: 91,
    compilationStatus: 'PASS' as const,
    typeScriptErrors: [] as string[],
  };

  it('est prête quand tout est réellement vert', () => {
    const r = evaluateProductionReadiness(base);
    expect(r.ready).toBe(true);
    expect(r.blockers).toEqual([]);
  });

  it('une erreur TypeScript bloque la livraison', () => {
    const r = evaluateProductionReadiness({
      ...base, typeScriptErrors: ["src/components/TaskTile.tsx(95,1): error TS1005: '}' expected"],
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.some((b) => b.includes('TS1005'))).toBe(true);
  });

  it('une compilation SKIPPED n\'est JAMAIS une réussite', () => {
    const r = evaluateProductionReadiness({ ...base, compilationStatus: 'SKIPPED' });
    expect(r.ready).toBe(false);
    expect(r.blockers.some((b) => b.includes('SKIPPED'))).toBe(true);
  });

  it('une compilation en échec bloque', () => {
    expect(evaluateProductionReadiness({ ...base, compilationStatus: 'FAIL' }).ready).toBe(false);
  });

  it('un delivery check NEEDS_REPAIR bloque', () => {
    const deliveryCheck: ReportDeliverySection = { status: 'NEEDS_REPAIR', blockers: [] };
    const r = evaluateProductionReadiness({ ...base, deliveryCheck });
    expect(r.ready).toBe(false);
    expect(r.blockers.some((b) => b.includes('NEEDS_REPAIR'))).toBe(true);
  });

  it('un blocker actif bloque', () => {
    const deliveryCheck: ReportDeliverySection = {
      status: 'READY', blockers: ['TypeScript compilation failed: TS1005'],
    };
    const r = evaluateProductionReadiness({ ...base, deliveryCheck });
    expect(r.ready).toBe(false);
    expect(r.blockers.some((b) => b.includes('TS1005'))).toBe(true);
  });

  it('un contrôle critique en échec bloque', () => {
    const r = evaluateProductionReadiness({
      ...base, validation: validation({ failedCritical: ['typescript'] }),
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.some((b) => b.includes('typescript'))).toBe(true);
  });

  it('un contrôle critique NON EXÉCUTÉ bloque — « non exécuté » n\'est pas « réussi »', () => {
    const r = evaluateProductionReadiness({
      ...base, validation: validation({ notRunCritical: ['build', 'tests'] }),
    });
    expect(r.ready).toBe(false);
    expect(r.blockers).toHaveLength(2);
  });

  it('un test fonctionnel critique en échec bloque', () => {
    const testResults: ReportFunctionalSection = {
      tests: [{ feature: 'Screens (UI components)', status: 'FAIL' }],
    };
    const r = evaluateProductionReadiness({ ...base, testResults });
    expect(r.ready).toBe(false);
    expect(r.blockers.some((b) => b.includes('Screens'))).toBe(true);
  });

  it('un test fonctionnel NON critique en échec ne bloque pas à lui seul', () => {
    expect(CRITICAL_FUNCTIONAL_FEATURES.has('Authentication (login / logout / session)')).toBe(false);
    const testResults: ReportFunctionalSection = {
      tests: [{ feature: 'Authentication (login / logout / session)', status: 'FAIL' }],
    };
    expect(evaluateProductionReadiness({ ...base, testResults }).ready).toBe(true);
  });

  it('NOT_TESTABLE n\'est pas compté comme un échec bloquant', () => {
    const testResults: ReportFunctionalSection = {
      tests: [{ feature: 'Screens (UI components)', status: 'NOT_TESTABLE' }],
    };
    expect(evaluateProductionReadiness({ ...base, testResults }).ready).toBe(true);
  });

  it('un score élevé ne suffit jamais seul', () => {
    const r = evaluateProductionReadiness({
      fidelityScore: 99,
      compilationStatus: 'SKIPPED',
      typeScriptErrors: ['error TS1005'],
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.length).toBeGreaterThanOrEqual(2);
  });

  it('un score < 80 bloque même si tout le reste est vert', () => {
    expect(evaluateProductionReadiness({ ...base, fidelityScore: 79 }).ready).toBe(false);
  });
});

// ── S4/S5 : détecteurs ───────────────────────────────────────────────────────

describe('PHASE 51 — S4 : le point d\'entrée n\'est pas un barrel quelconque', () => {
  it('ne prend pas src/theme/index.ts pour le point d\'entrée', () => {
    const files = [
      f('src/theme/index.ts', 'export * from "./colors";\n'),
      f('src/utils/index.ts', 'export const x = 1;\n'),
      f('app/_layout.tsx', 'export default function L() { return null; }\n'),
      f('app/index.tsx', 'export default function H() { return null; }\n'),
    ];
    // AVANT : le motif /(app|index|_layout)\.(tsx?)$/ + files.find() renvoyait
    // src/theme/index.ts — le test passait sur une preuve fausse.
    expect(findEntryPoint(files)?.path).toBe('app/_layout.tsx');
  });

  it('reconnaît App.tsx à la racine', () => {
    expect(findEntryPoint([f('src/theme/index.ts', 'x'), f('App.tsx', 'y')])?.path).toBe('App.tsx');
  });

  it('renvoie null quand il n\'y a aucun point d\'entrée réel', () => {
    expect(findEntryPoint([f('src/theme/index.ts', 'x'), f('src/utils/index.ts', 'y')])).toBeNull();
  });
});

describe('PHASE 51 — S5 : les écrans Expo Router sont reconnus', () => {
  it('app/index.tsx et app/add-task.tsx sont des écrans', () => {
    const files = [
      f('app/_layout.tsx', 'layout'),
      f('app/index.tsx', 'home'),
      f('app/add-task.tsx', 'form'),
      f('src/theme/index.ts', 'barrel'),
    ];
    const screens = findScreenFiles(files).map((s) => s.path).sort();
    expect(screens).toEqual(['app/add-task.tsx', 'app/index.tsx']);
  });

  it('exclut les fichiers de route spéciaux', () => {
    const files = [
      f('app/_layout.tsx', 'layout'),
      f('app/+not-found.tsx', 'nf'),
      f('app/index.tsx', 'home'),
    ];
    expect(findScreenFiles(files).map((s) => s.path)).toEqual(['app/index.tsx']);
  });

  it('reconnaît aussi la convention screens/', () => {
    const files = [f('src/screens/HomeScreen.tsx', 'x'), f('src/theme/index.ts', 'y')];
    expect(findScreenFiles(files).map((s) => s.path)).toEqual(['src/screens/HomeScreen.tsx']);
  });

  it('ignore les .ts non JSX', () => {
    expect(findScreenFiles([f('app/utils.ts', 'x')])).toEqual([]);
  });
});

// ── Round-trip : statut explicite ────────────────────────────────────────────

describe('PHASE 51 — le round-trip distingue les cinq états réels', () => {
  it('un round-trip jamais exécuté est NOT_RUN, pas un échec à 0 %', () => {
    // C'est le défaut : `roundTripResult?.averageScore ?? 0` affichait 0 %,
    // indiscernable d'une mesure d'échec.
    expect(deriveRoundTripStatus(undefined)).toBe('NOT_RUN');
  });

  it('une capacité absente du moteur est NOT_IMPLEMENTED', () => {
    expect(deriveRoundTripStatus(undefined, { implemented: false })).toBe('NOT_IMPLEMENTED');
  });

  it('une direction non convertible est NOT_APPLICABLE', () => {
    expect(deriveRoundTripStatus(undefined, { applicable: false })).toBe('NOT_APPLICABLE');
  });

  it('un round-trip exécuté sous le seuil est FAIL', () => {
    expect(deriveRoundTripStatus({ averageScore: 0 })).toBe('FAIL');
    expect(deriveRoundTripStatus({ averageScore: 69 })).toBe('FAIL');
  });

  it('un round-trip exécuté au-dessus du seuil est PASS', () => {
    expect(deriveRoundTripStatus({ averageScore: 70 })).toBe('PASS');
    expect(deriveRoundTripStatus({ averageScore: 95 })).toBe('PASS');
  });

  it('NOT_IMPLEMENTED prime sur NOT_APPLICABLE', () => {
    expect(deriveRoundTripStatus(undefined, { implemented: false, applicable: false }))
      .toBe('NOT_IMPLEMENTED');
  });

  it('un score de 0 exécuté n\'est jamais PASS', () => {
    expect(deriveRoundTripStatus({ averageScore: 0 })).not.toBe('PASS');
  });
});

// ── Comptage canonique des fichiers ──────────────────────────────────────────

describe('PHASE 51 — le ZIP, le rapport et le callback comptent la même chose', () => {
  const appFiles = [
    f('app/index.tsx', 'x'),
    f('src/services/task.service.ts', 'y'),
    f('package.json', '{}'),
  ];
  const reports = [
    f('_codemorph-reports/conversion-report.json', '{}'),
    f('_codemorph-reports/conversion-report.md', '# r'),
    f('_codemorph-reports/fidelity-report.html', '<html>'),
    f('_codemorph-reports/source-analysis.json', '{}'),
  ];

  it('sépare les livrables des rapports internes', () => {
    const split = splitDeliverableFiles([...appFiles, ...reports]);
    expect(split.deliverable).toHaveLength(3);
    expect(split.reports).toHaveLength(4);
  });

  it('signale une divergence ZIP ↔ livrables', () => {
    // Cas réel observé : ZIP construit avant injection des rapports.
    const r = reconcileFileCounts(7, [...appFiles, ...reports]);
    expect(r.consistent).toBe(false);
    expect(r.zip).toBe(7);
    expect(r.deliverable).toBe(3);
    expect(r.reports).toBe(4);
    expect(r.detail).toContain('INCOHÉRENCE');
  });

  it('valide des comptes cohérents', () => {
    const r = reconcileFileCounts(3, [...appFiles, ...reports]);
    expect(r.consistent).toBe(true);
    expect(r.detail).toContain('==');
  });

  it('un fichier vide n\'est compté ni dans le ZIP ni dans les livrables', () => {
    // 4 fichiers hors rapports, mais un est vide : les deux comptes restent à 3,
    // donc ils demeurent cohérents entre eux.
    const r = reconcileFileCounts(3, [...appFiles, f('src/empty.ts', ''), ...reports]);
    expect(r.deliverable).toBe(3);
    expect(r.consistent).toBe(true);
    // Et si le ZIP avait compté le fichier vide, la divergence serait signalée.
    expect(reconcileFileCounts(4, [...appFiles, f('src/empty.ts', ''), ...reports]).consistent)
      .toBe(false);
  });
});
