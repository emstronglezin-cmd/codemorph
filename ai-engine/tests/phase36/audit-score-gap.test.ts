// ============================================================
// CodeMorph — AUDIT PHASE 1 : preuve chiffrée de l'écart entre le score
// annoncé et la réalité structurelle du code généré.
//
// Ce test exécute le VRAI pipeline sur un petit projet Flutter, puis applique
// les validateurs existants au résultat. Il sert de base factuelle à l'audit :
// il montre CE QUE le moteur mesure et CE QU'IL ne mesure pas.
// ============================================================
import { buildSourceCode, freshDirs, makeCtx, makeFile } from './fixtures';
import type { ASTFile } from '../../src/core/ast-analyzer';

function setTestEnv(dirs: { cacheDir: string; stateDir: string }): void {
  process.env['PHASE36_ENABLED']          = 'true';
  process.env['PHASE36_THRESHOLD_CHARS']  = '60000';
  process.env['PHASE36_THRESHOLD_FILES']  = '25';
  process.env['AI_MAX_CONCURRENT_REQUESTS'] = '1';
  process.env['AI_RETRY_DELAY_MS']        = '10';
  process.env['AI_RETRY_MAX_ATTEMPTS']    = '4';
  process.env['AI_CACHE_ENABLED']         = 'true';
  process.env['AI_CACHE_DIR']             = dirs.cacheDir;
  process.env['AI_STATE_DIR']             = dirs.stateDir;
  process.env['AI_RATE_LIMIT_TPM']        = '1000000';
  process.env['AI_MIN_INTERVAL_MS']       = '0';
  delete process.env['GROQ_API_KEY'];
  delete process.env['OPENAI_API_KEY'];
}

function buildProject(): ASTFile[] {
  const files: ASTFile[] = [];
  for (let i = 0; i < 8; i++) {
    const kind = i % 4;
    if (kind === 0) {
      files.push(makeFile(`lib/features/home/screen_${i}.dart`,
        `import 'package:flutter/material.dart';\n` +
        `class Screen${i} extends StatefulWidget {\n  const Screen${i}({super.key});\n` +
        `  @override\n  State<Screen${i}> createState() => _Screen${i}State();\n}\n` +
        `class _Screen${i}State extends State<Screen${i}> {\n  int _c = 0;\n` +
        `  @override\n  Widget build(BuildContext context) {\n` +
        `    return Scaffold(appBar: AppBar(title: const Text('S${i}')),\n` +
        `      body: Center(child: Text('\$_c')),\n` +
        `      floatingActionButton: FloatingActionButton(onPressed: () => setState(() => _c++), child: const Icon(Icons.add)));\n  }\n}\n`));
    } else if (kind === 1) {
      files.push(makeFile(`lib/models/item_model_${i}.dart`,
        `class ItemModel${i} {\n  final String id;\n  final String label;\n` +
        `  const ItemModel${i}({required this.id, required this.label});\n}\n`));
    } else if (kind === 2) {
      files.push(makeFile(`lib/services/api_service_${i}.dart`,
        `import 'dart:convert';\nimport 'package:http/http.dart' as http;\n` +
        `class ApiService${i} {\n  Future<List<String>> fetchItems() async {\n` +
        `    final res = await http.get(Uri.parse('https://api.example.com/items'));\n` +
        `    return (jsonDecode(res.body) as List).map((e) => e['label'] as String).toList();\n  }\n}\n`));
    } else {
      files.push(makeFile(`lib/widgets/card_widget_${i}.dart`,
        `import 'package:flutter/material.dart';\n` +
        `class CardWidget${i} extends StatelessWidget {\n  final String title;\n` +
        `  const CardWidget${i}({super.key, required this.title});\n` +
        `  @override\n  Widget build(BuildContext context) => Card(child: ListTile(title: Text(title)));\n}\n`));
    }
  }
  return files;
}

describe('AUDIT — écart score annoncé / réalité structurelle', () => {
  const dirs = freshDirs();
  beforeAll(() => setTestEnv(dirs));

  it('mesure ce que le moteur valide réellement', async () => {
    const { ConversionPipeline } = await import('../../src/core/pipeline');
    const { runStaticValidationSync } = await import('../../src/core/static-validator');
    const { validateAllFiles } = await import('../../src/core/content-validator');

    const result = await new ConversionPipeline().run(
      makeCtx('audit-project', buildSourceCode(buildProject())),
    );

    const files = result.files;
    // On relit les valeurs que le PIPELINE lui-même a produites (pas un recalcul) :
    // c'est la preuve la plus directe de ce qui est réellement mesuré.
    const staticVal = runStaticValidationSync(files, 'dart');
    const score     = result.fidelityScore?.overall;
    const finalScore = score ?? 0;
    const delivery  = result.deliveryCheck;
    const compilation = result.compilationResult;
    void validateAllFiles;

    // ── Contrôle des dépendances : n'existe nulle part dans le moteur ──────
    const pkgFile = files.find((f) => f.path === 'package.json');
    const declared = new Set<string>();
    if (pkgFile) {
      try {
        const pkg = JSON.parse(pkgFile.content) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        for (const k of Object.keys(pkg.dependencies ?? {})) declared.add(k);
        for (const k of Object.keys(pkg.devDependencies ?? {})) declared.add(k);
      } catch { /* ignore */ }
    }
    // Imports "nus" (ni relatifs, ni node:) réellement utilisés
    const usedBare = new Set<string>();
    for (const f of files) {
      const re = /from\s+['"]([^.'"][^'"]*)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(f.content)) !== null) {
        const spec = m[1] ?? '';
        if (!spec || spec.startsWith('node:')) continue;
        // nom du paquet (gère les @scope/name)
        usedBare.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0] as string);
      }
    }
    const undeclared = [...usedBare].filter((p) => !declared.has(p));

    // eslint-disable-next-line no-console
    console.log(`
╔════════════════ AUDIT — PREUVE CHIFFRÉE ════════════════
║ fichiers générés            : ${files.length}
║ SCORE DE FIDÉLITÉ annoncé   : ${score}%
║ compilationResult           : ${compilation ? `attempted, success=${compilation.success}` : 'ABSENT (jamais tentée)'}
║ staticVal.overallPassed     : ${staticVal.overallPassed}
║   brokenImports             : ${staticVal.brokenImports.length}
║   undefinedRefs             : ${staticVal.undefinedRefs.length}
║   missingRoutes             : ${staticVal.missingRoutes.length}
║   emptyFiles                : ${staticVal.emptyFiles.length}
║   criticalTodos             : ${staticVal.criticalTodos.length}
║   sourceImports             : ${staticVal.sourceImports.length}
║ intégrité verdict           : ${result.integrityReport?.verdict ?? 'ABSENT'}
║   erreurs                   : ${result.integrityReport?.errorCount ?? '?'}
║   avertissements            : ${result.integrityReport?.warningCount ?? '?'}
║   par code                  : ${JSON.stringify(result.integrityReport?.byCode ?? {})}
║   détails                   : ${(result.integrityReport?.issues ?? []).map(i => `[${i.code}] ${i.file ?? ''} ${i.detail ?? ''}`).join(' | ')}
║ fichiers vides (staticVal)  : ${staticVal.emptyFiles.join(', ') || '(aucun)'}
║ blockers delivery           : ${((delivery as unknown as { blockers?: string[] })?.blockers ?? []).join(' | ') || '(aucun)'}
║ delivery verdict            : ${(delivery as { status?: string } | undefined)?.status ?? 'ABSENT'}
║ delivery.ready              : ${String((delivery as { ready?: boolean } | undefined)?.ready)}
║ dépendances déclarées       : ${declared.size}
║ paquets importés            : ${usedBare.size}
║ paquets NON déclarés        : ${undeclared.length} ${undeclared.length ? '→ ' + undeclared.join(', ') : ''}
╚═════════════════════════════════════════════════════════`);

    expect(files.length).toBeGreaterThan(0);

    // ── NON-RÉGRESSION : le score annoncé ne peut JAMAIS dépasser le plafond
    // imposé par l'intégrité structurelle. C'est la garantie qu'un projet dont
    // les imports ne résolvent pas n'est plus présenté comme pleinement validé.
    const integrity = result.integrityReport;
    expect(integrity).toBeDefined();
    const cap =
      integrity?.verdict === 'FAIL' ? 59
      : integrity?.verdict === 'PASS_WITH_WARNINGS' ? 89
      : 100;
    expect(finalScore).toBeLessThanOrEqual(cap);

    // Et le verdict de livraison doit refléter les erreurs d'intégrité :
    // un verdict READY avec des erreurs d'intégrité est le bug d'origine.
    if ((integrity?.errorCount ?? 0) > 0) {
      expect((delivery as { status?: string } | undefined)?.status).toBe('NEEDS_REPAIR');
    }
  }, 120_000);
});
