/**
 * PHASE 50 — Régression bout-en-bout sur les types d'IR non normalisés.
 *
 * ## Le défaut reproduit ici
 *
 * Sur une conversion réelle (chemin où l'IR est produit par le modèle d'IA),
 * l'IR portait les types Dart tels quels : `bool`, `String`. Résultat mesuré
 * chez le destinataire :
 *
 *   • le service généré écrivait `title: bool` → **échec de compilation
 *     TypeScript** ;
 *   • la détection du champ d'état comparait `f.type === 'boolean'` (nom
 *     TypeScript) et ne matchait jamais le `bool` Dart, donc **`toggle()` et
 *     le compteur n'étaient pas générés** alors que les écrans les appelaient.
 *
 * Le chemin statique, lui, mappait déjà ses types — c'est pourquoi les
 * validations hors ligne étaient vertes pendant que les conversions réelles
 * étaient cassées. Ce test verrouille le chemin qui était cassé.
 *
 * Les noms utilisés (`Note`, `NoteService`) sont volontairement différents de
 * `Task` / `TaskService` : le correctif ne doit dépendre d'aucun nom.
 */
import { CodePlanner } from '../../src/core/code-planner';
import { normalizeIrTypes } from '../../src/core/canonical-ir';
import { makeCtx, freshDirs } from '../phase36/fixtures';
import type { IRDocument } from '../../src/models/ir.types';

function setTestEnv(dirs: { cacheDir: string; stateDir: string }): void {
  process.env['CODEMORPH_CACHE_DIR'] = dirs.cacheDir;
  process.env['CODEMORPH_STATE_DIR'] = dirs.stateDir;
  process.env['CODEMORPH_OFFLINE'] = '1';
}

/** IR volontairement typé en DART, comme le renvoie un modèle d'IA non normalisé. */
function dartTypedIr(): IRDocument {
  return {
    version: '1.0',
    projectId: 'note-app',
    sourceFramework: 'flutter',
    targetFramework: 'react-native',
    architecture: { pattern: 'clean', modules: [], layers: [] },
    uiGraph: { screens: [], components: [], navigation: [] },
    backendGraph: {
      // Signatures volontairement typées en DART elles aussi.
      services: [{
        name: 'NoteService',
        dependencies: [],
        methods: [
          { name: 'getAll', params: [], returnType: 'List<Note>' },
          { name: 'add', params: [{ name: 'title', type: 'String' }], returnType: 'Note' },
          { name: 'toggle', params: [{ name: 'id', type: 'String' }], returnType: 'void' },
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
          { name: 'priority', type: 'int', nullable: true, unique: false, primary: false },
        ],
      }],
      relationships: [],
      migrations: [],
    },
    dependencies: [],
    summary: { totalFiles: 1, convertedFiles: 1, skippedFiles: 0 },
  } as unknown as IRDocument;
}

describe('PHASE 50 — normalisation canonique des types d\'IR', () => {
  it('traduit les types Dart de l\'IR avant toute génération', () => {
    const ir = dartTypedIr();
    const result = normalizeIrTypes(ir);

    const fields = result.ir.dataLayer.models[0]?.fields ?? [];
    const byName = new Map(fields.map((f) => [f.name, f.type]));

    expect(byName.get('title')).toBe('string');
    expect(byName.get('isDone')).toBe('boolean');
    expect(byName.get('priority')).toBe('number');
    expect(result.changed).toBeGreaterThan(0);
  });

  it('est sans effet sur un IR déjà typé en TypeScript', () => {
    const ir = dartTypedIr();
    normalizeIrTypes(ir);
    const again = normalizeIrTypes(ir);
    expect(again.changed).toBe(0);
  });
});

describe('PHASE 50 — le service généré expose le contrat attendu par les écrans', () => {
  it('génère toggle() et le compteur même quand l\'IR porte le type Dart bool', async () => {
    setTestEnv(freshDirs());
    const ctx = makeCtx('note-app', 'class Note { final String id; }');
    (ctx as { targetFramework: string }).targetFramework = 'react-native';

    const planner = new CodePlanner();
    const plan = await planner.plan(ctx, dartTypedIr());

    const service = plan.files.find((f) => /services?\/.*\.ts$/.test(f.path));
    expect(service).toBeDefined();
    const code = service!.content;

    // Le contrat que les écrans appellent doit exister.
    expect(code).toMatch(/\btoggle\s*\(/);
    expect(code).toMatch(/isDoneCount/);
    expect(code).toMatch(/\badd\s*\(/);
    expect(code).toMatch(/\bgetAll\s*\(/);

    // Aucun type Dart ne doit subsister dans la sortie TypeScript.
    expect(code).not.toMatch(/:\s*bool\b/);
    expect(code).not.toMatch(/:\s*String\b/);
    expect(code).not.toMatch(/:\s*int\b/);
  }, 120_000);

  it('aucun import local du plan ne pointe vers un fichier absent', async () => {
    setTestEnv(freshDirs());
    const ctx = makeCtx('note-app', 'class Note { final String id; }');
    (ctx as { targetFramework: string }).targetFramework = 'react-native';

    const planner = new CodePlanner();
    const plan = await planner.plan(ctx, dartTypedIr());

    const present = new Set(plan.files.map((f) => f.path.toLowerCase()));
    const broken: string[] = [];

    for (const file of plan.files) {
      if (!/\.(ts|tsx)$/.test(file.path)) continue;
      const re = /from\s+['"](\.[^'"]*)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(file.content)) !== null) {
        const spec = m[1] ?? '';
        const dir = file.path.split('/').slice(0, -1);
        const stack = [...dir];
        for (const part of spec.split('/')) {
          if (part === '.' || part === '') continue;
          if (part === '..') stack.pop();
          else stack.push(part);
        }
        const target = stack.join('/').toLowerCase();
        const hit = [...present].some((p) => {
          const bare = p.replace(/\.(ts|tsx|js|jsx)$/, '');
          return bare === target || bare === `${target}/index`;
        });
        if (!hit) broken.push(`${file.path} → ${spec}`);
      }
    }

    expect(broken).toEqual([]);
  }, 120_000);
});
