/**
 * syntax-validator.ts — PHASE 51
 *
 * Contrôle syntaxique systématique de TOUS les fichiers TypeScript / TSX
 * générés.
 *
 * ## Pourquoi ce module existe
 *
 * Un projet livré contenait `src/components/TaskTile.tsx(95,1): error TS1005:
 * '}' expected` — un fichier généré syntaxiquement invalide. Deux problèmes :
 *
 *   1. **Le générateur peut produire du code non analysable.** Les générateurs
 *      assemblent du code par concaténation de gabarits. Deux familles de
 *      défauts ont déjà été observées dans ce moteur :
 *        • une contre-oblique (backtick) à l'intérieur d'un commentaire injecté
 *          dans un gabarit littéral ferme prématurément le gabarit ;
 *        • une liste de propriétés construite par concaténation produit une
 *          virgule en trop (`title,,` → TS1136).
 *      Aucun contrôle ne relisait le fichier produit avant l'empaquetage.
 *
 *   2. **Rien ne le signalait avant le ZIP.** La compilation TypeScript du
 *      pipeline est souvent `SKIPPED` (dépendances du projet cible non
 *      installées), donc l'erreur n'apparaissait que chez le destinataire.
 *
 * Ce contrôle est purement syntaxique : il n'a besoin **d'aucune dépendance du
 * projet cible**, donc il s'exécute toujours, y compris quand la compilation
 * complète est ignorée. Il est donc complémentaire de `tsc`, pas un substitut.
 */

import ts from 'typescript';
import type { GeneratedFile } from '../models/ir.types';

export interface SyntaxIssue {
  file:    string;
  line:    number;
  column:  number;
  code:    number;
  message: string;
}

export interface SyntaxCheckResult {
  /** Fichiers analysés. */
  checked: number;
  /** Fichiers présentant au moins une erreur de syntaxe. */
  invalid: SyntaxIssue[];
  /** Vrai si aucun fichier analysé ne présente d'erreur. */
  passed:  boolean;
  durationMs: number;
}

const TS_LIKE = /\.(ts|tsx|mts|cts)$/;

/**
 * Analyse la syntaxe d'un contenu TypeScript/TSX sans résoudre aucun import.
 *
 * `ts.createSourceFile` effectue l'analyse complète (parse) et expose les
 * diagnostics de syntaxe — exactement ceux qui produisent TS1005, TS1136, etc.
 * Les erreurs sémantiques (types inconnus, modules manquants) ne sont PAS
 * détectées ici : c'est le rôle de la compilation.
 */
export function checkSyntax(
  path: string,
  content: string,
): SyntaxIssue[] {
  const scriptKind = path.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;

  const sourceFile = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    scriptKind,
  );

  // `parseDiagnostics` n'est pas dans les types publics de TypeScript, mais
  // c'est la seule façon d'obtenir les diagnostics de syntaxe sans programme.
  const diagnostics = (sourceFile as unknown as {
    parseDiagnostics?: ts.DiagnosticWithLocation[];
  }).parseDiagnostics ?? [];

  return diagnostics.map((d) => {
    const { line, character } = ts.getLineAndCharacterOfPosition(
      sourceFile,
      d.start ?? 0,
    );
    return {
      file:    path,
      line:    line + 1,
      column:  character + 1,
      code:    d.code,
      message: ts.flattenDiagnosticMessageText(d.messageText, ' '),
    };
  });
}

/**
 * Contrôle syntaxique de tous les fichiers TS/TSX d'un plan généré.
 *
 * Ne dépend d'aucune installation du projet cible : il s'exécute donc même
 * quand la compilation complète est `SKIPPED`.
 */
export function checkGeneratedSyntax(files: GeneratedFile[]): SyntaxCheckResult {
  const started = Date.now();
  const invalid: SyntaxIssue[] = [];
  let checked = 0;

  for (const file of files) {
    if (!TS_LIKE.test(file.path)) continue;
    checked++;
    const issues = checkSyntax(file.path, file.content);
    if (issues.length > 0) invalid.push(...issues);
  }

  return {
    checked,
    invalid,
    passed: invalid.length === 0,
    durationMs: Date.now() - started,
  };
}

/** Rendu compact pour les journaux — jamais de contenu source. */
export function formatSyntaxIssues(result: SyntaxCheckResult, max = 10): string {
  if (result.passed) {
    return `✅ Syntaxe : ${result.checked} fichier(s) TS/TSX analysé(s), 0 erreur`;
  }
  const shown = result.invalid.slice(0, max);
  const lines = shown.map(
    (i) => `  ❌ ${i.file}(${i.line},${i.column}): error TS${i.code}: ${i.message}`,
  );
  const rest = result.invalid.length - shown.length;
  if (rest > 0) lines.push(`  … et ${rest} autre(s) erreur(s) de syntaxe`);
  return `❌ Syntaxe : ${result.invalid.length} erreur(s) sur ${result.checked} fichier(s)\n${lines.join('\n')}`;
}
