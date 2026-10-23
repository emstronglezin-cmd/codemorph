/**
 * PHASE 50 — Régression sur la représentation intermédiaire canonique.
 *
 * Ces tests sont VOLONTAIREMENT génériques : ils n'utilisent ni `Task`, ni
 * `TaskService`, ni aucun nom propre au projet témoin. L'objectif est de
 * détecter la même famille de défauts dans N'IMPORTE QUELLE conversion.
 *
 * Chaque test correspond à un défaut réellement observé :
 *   • D1 — un type Dart brut (`bool`) écrit tel quel en TypeScript ;
 *   • D2 — la détection du champ booléen comparait au nom TS `boolean`
 *          et ratait le nom Dart `bool`, donc `toggle()` n'était pas généré ;
 *   • D3 — un chemin source (`../widgets/note_card`) recopié comme
 *          spécificateur d'import alors que le fichier généré est ailleurs ;
 *   • D4 — un import non résoluble laissé cassé au lieu d'être signalé ;
 *   • D5 — un écran appelant une méthode que le service ne définit pas.
 */
import {
  mapDartTypeToTS, isBooleanType, isStringType, isNumericType,
  relativeSpecifier, buildSymbolTable, rewriteLocalImports,
  resolveSourcePath, toPascalCase, kindFromOutputPath,
} from '../../src/core/canonical-ir';
import {
  checkServiceContract, checkUnconvertedSymbols,
} from '../../src/core/project-integrity-validator';
import type { GeneratedFile } from '../../src/models/ir.types';

const f = (path: string, content: string, fromPath?: string): GeneratedFile => ({
  path, content, language: 'typescript',
  ...(fromPath ? { fromPath } : {}),
});

describe('PHASE 50 — D1 : mapping de types canonique et idempotent', () => {
  it('traduit les types Dart primitifs', () => {
    expect(mapDartTypeToTS('bool')).toBe('boolean');
    expect(mapDartTypeToTS('String')).toBe('string');
    expect(mapDartTypeToTS('int')).toBe('number');
    expect(mapDartTypeToTS('double')).toBe('number');
    expect(mapDartTypeToTS('dynamic')).toBe('unknown');
  });

  it('est idempotent — un type déjà TypeScript n\'est pas altéré', () => {
    // C'est ce qui manquait : trois mappings divergents, donc un même type
    // pouvait être retraduit différemment selon le générateur.
    for (const t of ['boolean', 'string', 'number', 'unknown', 'Task[]', 'Note[]']) {
      expect(mapDartTypeToTS(t)).toBe(t);
    }
    expect(mapDartTypeToTS(mapDartTypeToTS('bool'))).toBe('boolean');
    expect(mapDartTypeToTS(mapDartTypeToTS('List<String>'))).toBe('string[]');
  });

  it('gère les conteneurs imbriqués et la nullabilité', () => {
    expect(mapDartTypeToTS('List<String>')).toBe('string[]');
    expect(mapDartTypeToTS('List<List<int>>')).toBe('number[][]');
    expect(mapDartTypeToTS('Map<String, int>')).toBe('Record<string, number>');
    expect(mapDartTypeToTS('Future<bool>')).toBe('Promise<boolean>');
    expect(mapDartTypeToTS('Stream<String>')).toBe('AsyncIterable<string>');
    expect(mapDartTypeToTS('String?')).toBe('(string) | null');
  });

  it('ne renvoie jamais un type Dart dans une sortie TypeScript', () => {
    // Invariant général : quel que soit l'entrée, la sortie ne contient plus
    // de mot-clé de type Dart.
    const dartInputs = ['bool', 'String', 'int', 'double', 'List<bool>', 'Map<String,bool>', 'num'];
    for (const input of dartInputs) {
      const out = mapDartTypeToTS(input);
      expect(out).not.toMatch(/\b(bool|String|int|double|num)\b/);
    }
  });
});

describe('PHASE 50 — D2 : prédicats acceptent Dart ET TypeScript', () => {
  it('isBooleanType reconnaît bool (Dart) et boolean (TS)', () => {
    // Défaut réel : `f.type === 'boolean'` ne matchait jamais un `bool` Dart,
    // donc le service était généré SANS toggle() ni compteur.
    expect(isBooleanType('bool')).toBe(true);
    expect(isBooleanType('boolean')).toBe(true);
    expect(isBooleanType('bool?')).toBe(true);
    expect(isBooleanType('String')).toBe(false);
    expect(isBooleanType('int')).toBe(false);
  });

  it('isStringType et isNumericType acceptent les deux nomenclatures', () => {
    expect(isStringType('String')).toBe(true);
    expect(isStringType('string')).toBe(true);
    expect(isNumericType('int')).toBe(true);
    expect(isNumericType('double')).toBe(true);
    expect(isNumericType('number')).toBe(true);
    expect(isStringType('bool')).toBe(false);
  });
});

describe('PHASE 50 — D3 : résolution des chemins et de la casse', () => {
  it('calcule un spécificateur relatif avec la casse exacte du fichier cible', () => {
    expect(relativeSpecifier('app/index.tsx', 'src/components/NoteCard.tsx'))
      .toBe('../src/components/NoteCard');
    expect(relativeSpecifier('src/components/NoteCard.tsx', 'src/types/note.types.ts'))
      .toBe('../types/note.types');
    expect(relativeSpecifier('app/index.tsx', 'app/settings.tsx')).toBe('./settings');
  });

  it('construit la table de symboles sur les fichiers réellement générés', () => {
    const table = buildSymbolTable([
      f('src/components/NoteCard.tsx', 'export function NoteCard() { return null; }', 'lib/widgets/note_card.dart'),
      f('src/services/noteservice.service.ts', 'export class NoteService { getAll() { return []; } }', 'lib/services/note_service.dart'),
    ]);
    expect(table.outputFiles).toContain('src/components/NoteCard.tsx');
    // Un chemin SOURCE Dart retrouve le fichier de sortie réel.
    expect(resolveSourcePath(table, '../widgets/note_card.dart')).toBe('src/components/NoteCard.tsx');
    expect(resolveSourcePath(table, 'lib/services/note_service.dart')).toBe('src/services/noteservice.service.ts');
    // Un chemin inconnu renvoie null — jamais une devinette.
    expect(resolveSourcePath(table, '../totally/unknown.dart')).toBeNull();
  });

  it('retargete un import qui visait un chemin source Dart', () => {
    const files = [
      f('src/components/NoteCard.tsx', 'export function NoteCard() { return null; }', 'lib/widgets/note_card.dart'),
      f('src/services/noteservice.service.ts', 'export const noteService = { getAll: () => [] };', 'lib/services/note_service.dart'),
      f('app/index.tsx',
        "import { NoteCard } from '../widgets/note_card';\n" +
        "import { noteService } from '../services/note_service';\n" +
        'export default function Home() { return null; }\n'),
    ];
    const table = buildSymbolTable(files);
    const screen = files[2];
    expect(screen).toBeDefined();
    const result = rewriteLocalImports(screen!, table);

    expect(result.content).toContain("'../src/components/NoteCard'");
    expect(result.content).toContain("'../src/services/noteservice.service'");
    expect(result.content).not.toContain("'../widgets/note_card'");
    expect(result.rewritten).toBe(2);
    expect(result.unresolved).toHaveLength(0);
  });

  it('corrige une casse erronée en utilisant le fichier réellement présent', () => {
    const files = [
      f('src/components/NoteCard.tsx', 'export function NoteCard() { return null; }'),
      f('app/index.tsx', "import { NoteCard } from '../src/components/notecard';\nexport default function H(){return null;}\n"),
    ];
    const result = rewriteLocalImports(files[1]!, buildSymbolTable(files));
    expect(result.content).toContain("'../src/components/NoteCard'");
  });
});

describe('PHASE 50 — D4 : un import non résoluble est signalé, jamais laissé cassé', () => {
  it('commente NOT_CONVERTED et rapporte l\'import', () => {
    const files = [
      f('app/index.tsx',
        "import { Chart } from '../widgets/fancy_chart';\nexport default function H(){return null;}\n"),
    ];
    const result = rewriteLocalImports(files[0]!, buildSymbolTable(files));

    expect(result.content).toContain('NOT_CONVERTED');
    expect(result.content).toContain('../widgets/fancy_chart');
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.specifier).toBe('../widgets/fancy_chart');

    // Et le validateur le remonte comme erreur bloquante.
    const issues = checkUnconvertedSymbols([{ ...files[0]!, content: result.content }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('unconverted-symbol');
    expect(issues[0]?.severity).toBe('error');
  });

  it('ne touche pas aux imports de paquets externes', () => {
    const files = [
      f('app/index.tsx',
        "import React from 'react';\nimport { View } from 'react-native';\nexport default function H(){return null;}\n"),
    ];
    const result = rewriteLocalImports(files[0]!, buildSymbolTable(files));
    expect(result.content).toContain("from 'react'");
    expect(result.content).toContain("from 'react-native'");
    expect(result.unresolved).toHaveLength(0);
  });
});

describe('PHASE 50 — D5 : contrat service ↔ écran', () => {
  const serviceWithoutToggle =
    'export class NoteService {\n  getAll(): Note[] { return []; }\n  add(title: string): Note { return {} as Note; }\n}\n' +
    'export const noteService = new NoteService();\n';
  const serviceWithToggle =
    'export class NoteService {\n  getAll(): Note[] { return []; }\n  add(title: string): Note { return {} as Note; }\n' +
    '  toggle(id: string): void {}\n}\nexport const noteService = new NoteService();\n';

  const screen = [
    "import { noteService } from '../src/services/noteservice.service';",
    'export default function Home() {',
    '  const items = noteService.getAll();',
    "  noteService.add('x');",
    "  noteService.toggle('1');",
    '  return null;',
    '}',
  ].join('\n');

  it('détecte qu\'un écran appelle une méthode absente du service', () => {
    const files = [
      f('src/services/noteservice.service.ts', serviceWithoutToggle),
      f('app/index.tsx', screen),
    ];
    const issues = checkServiceContract(files);
    expect(issues.some((i) => i.code === 'missing-service-method')).toBe(true);
    const hit = issues.find((i) => i.code === 'missing-service-method');
    expect(hit?.detail).toBe('noteService.toggle');
    expect(hit?.severity).toBe('error');
  });

  it('ne signale rien quand le service expose bien la méthode', () => {
    const files = [
      f('src/services/noteservice.service.ts', serviceWithToggle),
      f('app/index.tsx', screen),
    ];
    expect(checkServiceContract(files)).toHaveLength(0);
  });

  it('ignore les appels sur des objets qui ne sont pas des services générés', () => {
    const files = [
      f('src/services/noteservice.service.ts', serviceWithoutToggle),
      f('app/index.tsx',
        "import { noteService } from '../src/services/noteservice.service';\n" +
        'export default function H() { const s = "abc"; s.toUpperCase(); noteService.getAll(); return null; }'),
    ];
    // `s.toUpperCase()` ne doit pas être pris pour un appel de service.
    expect(checkServiceContract(files)).toHaveLength(0);
  });
});

describe('PHASE 50 — helpers canoniques', () => {
  it('toPascalCase normalise snake_case et camelCase', () => {
    expect(toPascalCase('note_card')).toBe('NoteCard');
    expect(toPascalCase('noteService')).toBe('NoteService');
    expect(toPascalCase('task')).toBe('Task');
  });

  it('kindFromOutputPath classe par chemin de sortie', () => {
    expect(kindFromOutputPath('src/types/note.types.ts')).toBe('model');
    expect(kindFromOutputPath('src/services/noteservice.service.ts')).toBe('service');
    expect(kindFromOutputPath('src/components/NoteCard.tsx')).toBe('component');
    expect(kindFromOutputPath('app/index.tsx')).toBe('screen');
    expect(kindFromOutputPath('src/stores/auth.store.ts')).toBe('store');
  });
});
