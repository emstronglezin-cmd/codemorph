// ============================================================
// CodeMorph AI Engine — Round-Trip Fidelity (Phase 6)
//
// Teste la fidélité aller-retour :
//   Flutter → React Native → Flutter  (perte mesurée)
//   React Native → Flutter → RN       (perte mesurée)
//
// Score = moyenne des deux conversions
// Delta  = score original − score après round-trip (perte)
// ============================================================

import type { ConversionContext, GeneratedFile } from '../models/ir.types';
import { ConversionPipeline }                    from './pipeline';

// ── Types exportés ──────────────────────────────────────────────────────────

export interface RoundTripResult {
  /** Direction testée */
  direction:      'flutter→rn→flutter' | 'rn→flutter→rn';
  /** Score de la première conversion (source → cible) */
  firstScore:     number;
  /** Score de la deuxième conversion (cible → source) */
  secondScore:    number;
  /** Score après round-trip complet */
  afterRoundTrip: number;
  /** Score moyen des deux passes */
  averageScore:   number;
  /** Perte: firstScore − afterRoundTrip (valeur positive = régression) */
  delta:          number;
  details: {
    firstConversion:  number;
    secondConversion: number;
  };
  /** Erreurs non-bloquantes rencontrées */
  warnings: string[];
}

export interface RoundTripReport {
  flutterToRn:  RoundTripResult | null;
  rnToFlutter:  RoundTripResult | null;
  globalAverage: number;
  testedAt:      string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convertit un tableau de GeneratedFile en sourceCode "multi-fichiers"
 * utilisable par le pipeline (format "// === FILE: path ===\n<content>")
 */
function filesToSourceCode(files: GeneratedFile[]): string {
  return files
    .filter((f) => f.content && f.content.trim().length > 0)
    .map((f) => `// === FILE: ${f.path} ===\n${f.content}`)
    .join('\n\n');
}

/**
 * Calcule un score de fidélité simplifié entre deux ensembles de fichiers
 * (sans appel AI — comparaison structurelle)
 */
function quickFidelityScore(original: GeneratedFile[], roundTripped: GeneratedFile[]): number {
  if (original.length === 0) return 0;

  // Comparaison structurelle :
  // 1. Ratio de fichiers récupérés
  const fileRatio = Math.min(1, roundTripped.length / Math.max(original.length, 1));

  // 2. Ratio de lignes de code récupérées (±20% = ok)
  const origLines = original.reduce((acc, f) => acc + f.content.split('\n').length, 0);
  const rtLines   = roundTripped.reduce((acc, f) => acc + f.content.split('\n').length, 0);
  const lineRatio = origLines === 0 ? 1 : Math.min(1, rtLines / Math.max(origLines * 0.8, 1));

  // 3. Ratio de noms de fichiers conservés (sans extension)
  const origNames = new Set(original.map((f) => f.path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? ''));
  const rtNames   = new Set(roundTripped.map((f) => f.path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? ''));
  const nameMatches = [...origNames].filter((n) => rtNames.has(n)).length;
  const nameRatio = origNames.size === 0 ? 1 : nameMatches / Math.max(origNames.size, 1);

  const score = Math.round((fileRatio * 0.4 + lineRatio * 0.3 + nameRatio * 0.3) * 100);
  return Math.min(100, Math.max(0, score));
}

// ── Fonction principale ───────────────────────────────────────────────────────

/**
 * Exécute un test de fidélité aller-retour.
 *
 * @param sourceFiles   Fichiers de la source originale
 * @param sourceFramework  Framework source ('flutter' | 'react-native')
 * @param targetFramework  Framework cible ('react-native' | 'flutter')
 * @param pipelineOpts  Options AI (clé utilisateur optionnelle)
 */
export async function runRoundTripFidelity(
  sourceFiles:     GeneratedFile[],
  sourceFramework: string,
  targetFramework: string,
  pipelineOpts?:   { userOpenAIKey?: string; userAnthropicKey?: string },
): Promise<RoundTripResult> {
  const warnings: string[] = [];
  const direction = sourceFramework.toLowerCase().includes('flutter')
    ? 'flutter→rn→flutter'
    : 'rn→flutter→rn';

  const pipeline = new ConversionPipeline();

  // ── Passe 1: source → cible ──────────────────────────────────────────────
  let firstFiles: GeneratedFile[] = [];
  let firstScore = 0;

  try {
    const ctx1: ConversionContext = {
      jobId:           `rt-pass1-${Date.now()}`,
      projectId:       `rt-pass1`,
      sourceCode:      filesToSourceCode(sourceFiles),
      sourceLanguage:  sourceFramework,
      sourceFramework: sourceFramework,
      targetFramework: targetFramework,
      options: {
        preserveComments:   false,
        generateTests:      false,
        strictMode:         false,
        addTypeAnnotations: true,
      },
    };

    const result1 = await pipeline.run(ctx1, pipelineOpts);
    firstFiles = result1.files ?? [];
    firstScore = result1.fidelityScore?.overall ?? quickFidelityScore(sourceFiles, firstFiles);
  } catch (err) {
    warnings.push(`Pass 1 failed: ${(err as Error).message}`);
    firstScore = 0;
  }

  // ── Passe 2: cible → source (aller-retour) ────────────────────────────────
  let secondFiles: GeneratedFile[] = [];
  let secondScore = 0;

  try {
    if (firstFiles.length === 0) throw new Error('No files from pass 1');

    const ctx2: ConversionContext = {
      jobId:           `rt-pass2-${Date.now()}`,
      projectId:       `rt-pass2`,
      sourceCode:      filesToSourceCode(firstFiles),
      sourceLanguage:  targetFramework,
      sourceFramework: targetFramework,
      targetFramework: sourceFramework,
      options: {
        preserveComments:   false,
        generateTests:      false,
        strictMode:         false,
        addTypeAnnotations: true,
      },
    };

    const result2 = await pipeline.run(ctx2, pipelineOpts);
    secondFiles = result2.files ?? [];

    // Score retour = comparaison structurelle original vs round-tripped
    secondScore = quickFidelityScore(sourceFiles, secondFiles);
  } catch (err) {
    warnings.push(`Pass 2 failed: ${(err as Error).message}`);
    secondScore = 0;
  }

  const afterRoundTrip = secondScore;
  const averageScore   = Math.round((firstScore + afterRoundTrip) / 2);
  const delta          = firstScore - afterRoundTrip;

  return {
    direction,
    firstScore,
    secondScore,
    afterRoundTrip,
    averageScore,
    delta,
    details: {
      firstConversion:  firstScore,
      secondConversion: afterRoundTrip,
    },
    warnings,
  };
}

/**
 * Exécute les deux directions de round-trip et produit un rapport global.
 * Utilisé par les tests d'intégration (Phase 7).
 */
export async function runFullRoundTripReport(
  flutterFiles: GeneratedFile[],
  rnFiles:      GeneratedFile[],
  pipelineOpts?: { userOpenAIKey?: string; userAnthropicKey?: string },
): Promise<RoundTripReport> {
  let flutterToRn:  RoundTripResult | null = null;
  let rnToFlutter:  RoundTripResult | null = null;

  // Flutter → RN → Flutter
  if (flutterFiles.length > 0) {
    try {
      flutterToRn = await runRoundTripFidelity(
        flutterFiles, 'flutter', 'react-native', pipelineOpts,
      );
    } catch (_) {
      // skip silently
    }
  }

  // RN → Flutter → RN
  if (rnFiles.length > 0) {
    try {
      rnToFlutter = await runRoundTripFidelity(
        rnFiles, 'react-native', 'flutter', pipelineOpts,
      );
    } catch (_) {
      // skip silently
    }
  }

  const scores: number[] = [];
  if (flutterToRn) scores.push(flutterToRn.averageScore);
  if (rnToFlutter) scores.push(rnToFlutter.averageScore);
  const globalAverage = scores.length > 0
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : 0;

  return {
    flutterToRn,
    rnToFlutter,
    globalAverage,
    testedAt: new Date().toISOString(),
  };
}
