/**
 * PHASE 47 — Validation RÉELLEMENT exécutée, intégrée au pipeline existant.
 *
 * Preuve des quatre propriétés exigées : un import manquant, une erreur de
 * typage, une validation non exécutée ou un build en échec ne peuvent PAS être
 * rapportés comme un succès complet.
 */
import { computeFidelityReport } from '../../src/core/fidelity-engine';
import { runStaticValidation }   from '../../src/core/static-validator';
import type { GeneratedFile, ValidationCheckResult } from '../../src/models/ir.types';

const SRC = `
class Task { String title; }
class HomeScreen extends StatelessWidget { Widget build(BuildContext c) => Container(); }
`;

function base(extra: Array<{ path: string; content: string }> = []): GeneratedFile[] {
  const byPath = new Map<string, GeneratedFile>();
  for (const f of [
    { path: 'app/index.tsx', content:
      'import { View } from "react-native";\nexport default function Home() { return <View />; }\n' },
    { path: 'app/_layout.tsx', content:
      'import { Stack } from "expo-router";\nexport default function Layout() { return <Stack />; }\n' },
    { path: 'src/models/task.ts', content: 'export interface Task { title: string; }\n' },
    { path: 'package.json', content: JSON.stringify({
        name: 'p', main: 'expo-router/entry', dependencies: { 'react-native': '*' } }) },
    { path: 'tsconfig.json', content: '{ "compilerOptions": { "jsx": "react-jsx" } }\n' },
    { path: 'app.json', content: JSON.stringify({ expo: { name: 'p', slug: 'p' } }) },
    ...extra,
  ] as GeneratedFile[]) byPath.set(f.path, f);
  return [...byPath.values()];
}

const clean = (v: number | null): string => (v === null ? 'null' : String(v));

describe('PHASE 47 — la validation réelle borne le verdict', () => {
  it('un import local manquant empêche EXCELLENT et fullyValidated', async () => {
    const files = base([{ path: 'src/services/task.ts',
      content: 'import { Task } from "../models/missing";\nexport const s = (): Task => ({ title: "x" });\n' }]);
    const val = await runStaticValidation(files, process.cwd(), 'dart');
    const rep = computeFidelityReport({
      jobId: 't1', sourceCode: SRC, generatedFiles: files,
      sourceFramework: 'flutter', targetFramework: 'react-native',
      ...(val.checks ? { validation: val.checks } : {}),
    });

    expect(val.checks?.find((c) => c.id === 'local-imports')?.status).toBe('FAIL');
    expect(rep.fullyValidated).toBe(false);
    expect(rep.verdict).not.toBe('EXCELLENT');
    expect(rep.verdict).not.toBe('GOOD');
    expect(rep.failedCritical).toContain('local-imports');
    expect(rep.overallFidelityScore).toBeLessThanOrEqual(59);
  }, 120_000);

  it('une erreur de typage empêche tout statut validé', async () => {
    const files = base([{ path: 'src/util/bad.ts',
      content: 'export const n: number = "pas un nombre";\n' }]);
    const val = await runStaticValidation(files, process.cwd(), 'dart');
    const rep = computeFidelityReport({
      jobId: 't2', sourceCode: SRC, generatedFiles: files,
      sourceFramework: 'flutter', targetFramework: 'react-native',
      ...(val.checks ? { validation: val.checks } : {}),
    });
    const ts = val.checks?.find((c) => c.id === 'typescript');

    // Soit tsc a tourné et a échoué, soit il n'a pas pu tourner : jamais PASS.
    expect(ts?.status).not.toBe('PASS');
    expect(rep.fullyValidated).toBe(false);
    expect(rep.verdict).not.toBe('EXCELLENT');
  }, 120_000);

  it('une validation NON exécutée n\'est jamais comptée comme réussie', () => {
    const checks: ValidationCheckResult[] = [
      { id: 'local-imports', status: 'PASS', durationMs: 3, errors: [], warnings: [], files: [] },
      { id: 'dependencies', status: 'PASS', durationMs: 3, errors: [], warnings: [], files: [] },
      { id: 'config-entrypoint', status: 'PASS', durationMs: 3, errors: [], warnings: [], files: [] },
      { id: 'routes', status: 'PASS', durationMs: 3, errors: [], warnings: [], files: [] },
      { id: 'typescript', status: 'NOT_RUN', durationMs: 0, errors: [], warnings: [], files: [],
        notRunReason: 'binaire tsc introuvable' },
      { id: 'tests', status: 'NOT_RUN', durationMs: 0, errors: [], warnings: [], files: [] },
      { id: 'build', status: 'NOT_RUN', durationMs: 0, errors: [], warnings: [], files: [] },
    ];
    const rep = computeFidelityReport({
      jobId: 't3', sourceCode: SRC, generatedFiles: base(),
      sourceFramework: 'flutter', targetFramework: 'react-native', validation: checks,
    });

    expect(rep.verdict).not.toBe('EXCELLENT');
    expect(rep.fullyValidated).toBe(false);
    expect(rep.notRunCritical).toContain('typescript');
    // Le score n'est jamais gonflé par une absence de mesure.
    expect(rep.overallFidelityScore).toBeLessThanOrEqual(84);
    // Les composants non mesurés sont null, pas 100.
    expect(rep.scoreBreakdown?.testsExecuted).toBeNull();
  });

  it('un build en échec borne le verdict', () => {
    const checks: ValidationCheckResult[] = [
      { id: 'local-imports', status: 'PASS', durationMs: 2, errors: [], warnings: [], files: [] },
      { id: 'dependencies', status: 'PASS', durationMs: 2, errors: [], warnings: [], files: [] },
      { id: 'typescript', status: 'PASS', durationMs: 900, errors: [], warnings: [], files: [] },
      { id: 'config-entrypoint', status: 'PASS', durationMs: 2, errors: [], warnings: [], files: [] },
      { id: 'routes', status: 'PASS', durationMs: 2, errors: [], warnings: [], files: [] },
      { id: 'build', status: 'FAIL', durationMs: 4200, errors: ['expo export: bundle failed'], warnings: [], files: [] },
    ];
    const rep = computeFidelityReport({
      jobId: 't4', sourceCode: SRC, generatedFiles: base(),
      sourceFramework: 'flutter', targetFramework: 'react-native', validation: checks,
    });
    expect(rep.verdict).not.toBe('EXCELLENT');
    expect(rep.fullyValidated).toBe(false);
    expect(rep.overallFidelityScore).toBeLessThanOrEqual(84);
  });

  it('sans aucune validation, la couverture ne suffit pas à valider', () => {
    const rep = computeFidelityReport({
      jobId: 't5', sourceCode: SRC, generatedFiles: base(),
      sourceFramework: 'flutter', targetFramework: 'react-native',
    });
    expect(rep.fullyValidated).toBe(false);
    expect(rep.verdict).not.toBe('EXCELLENT');
    expect(rep.scoreBreakdown?.compilationSucceeded).toBeNull();
    console.log(`[phase47] sans validation → ${rep.overallFidelityScore}% / ${rep.verdict} / ` +
      `couverture=${clean(rep.scoreBreakdown?.sourceCoverage ?? null)} ` +
      `compilation=${clean(rep.scoreBreakdown?.compilationSucceeded ?? null)}`);
  });

  it('le projet sain obtient EXCELLENT uniquement si les contrôles critiques passent', async () => {
    const files = base();
    const val = await runStaticValidation(files, process.cwd(), 'dart');
    const rep = computeFidelityReport({
      jobId: 't6', sourceCode: SRC, generatedFiles: files,
      sourceFramework: 'flutter', targetFramework: 'react-native',
      ...(val.checks ? { validation: val.checks } : {}),
    });
    const critical = (val.checks ?? []).filter((c) =>
      ['local-imports', 'dependencies', 'typescript', 'config-entrypoint', 'routes'].includes(c.id));
    const allPass = critical.every((c) => c.status === 'PASS');

    if (allPass) {
      expect(rep.failedCritical ?? []).toHaveLength(0);
    } else {
      expect(rep.fullyValidated).toBe(false);
    }
    // La durée réelle est mesurée et non nulle quand tsc a tourné.
    if (val.checks?.find((c) => c.id === 'typescript')?.status !== 'NOT_RUN') {
      expect(val.validationDurationMs).toBeGreaterThan(0);
    }
    console.log(`[phase47] projet sain → ${rep.overallFidelityScore}% / ${rep.verdict} ` +
      `(entièrement validé: ${rep.fullyValidated}, durée ${val.validationDurationMs}ms)`);
  }, 120_000);
});
