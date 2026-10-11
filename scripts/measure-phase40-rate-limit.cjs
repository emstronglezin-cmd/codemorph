// ============================================================
// CodeMorph — MESURE PHASE 40 (problème B) : limiteur de débit, avant/après
// ------------------------------------------------------------
// Ce script exécute le VRAI GroqRateLimiter des deux versions du code :
//   • OLD = worktree git sur le commit 9d8246b (phase 39, avant correctifs),
//           avec pour seule modification l'ajout du mot-clé `export` sur la
//           classe — aucune logique altérée.
//   • NEW = arbre de travail courant (phase 40).
//
// Aucun appel Groq n'est fait : on mesure uniquement le temps passé à ATTENDRE
// dans acquire(), qui est exactement le temps perdu rapporté dans les logs.
// Paramètres de production : TPM_LIMIT = 7 000. MIN_INTERVAL_MS est mis à 0
// pour isoler l'effet de la comptabilité TPM (le délai minimal de 8 s est
// inchangé par le correctif).
// ============================================================
const OLD_PATH = '/tmp/cm-old/ai-engine/dist/core/ai-provider.js';
const NEW_PATH = '/home/user/codemorph/ai-engine/dist/core/ai-provider.js';

process.env['AI_MIN_INTERVAL_MS'] = '0';
process.env['AI_RATE_LIMIT_TPM']  = '7000';
process.env['GROQ_API_KEY']       = 'gsk_MEASUREMENT_ONLY';

// Le constructeur lit l'environnement : il faut le poser avant le require.
const { GroqRateLimiter: OldLimiter } = require(OLD_PATH);
const { GroqRateLimiter: NewLimiter } = require(NEW_PATH);

// Un chunk « petit projet » : ~6 100 caractères de source Dart. On utilise la
// VRAIE fonction d'estimation, et on reproduit exactement ce que groqChat()
// passe à acquire() : `estimatedInputTokens + GROQ_MAX_TOKENS` (2 800).
const GROQ_MAX_TOKENS = 2800;
const CHUNK_SOURCE = 'class PassagerListScreen extends ConsumerStatefulWidget { @override Widget build(BuildContext context) { final passagers = ref.watch(passagersProvider); return Scaffold(appBar: AppBar(title: const Text("Passagers")), body: ListView.builder(itemCount: passagers.length, itemBuilder: (ctx, i) => ListTile(title: Text(passagers[i].nom)))); } }'.repeat(18);
const EST_INPUT_TOKENS = NewLimiter.estimatePromptTokens([{ role: 'user', content: CHUNK_SOURCE }]);
const PROJECTED_PER_REQ = EST_INPUT_TOKENS + GROQ_MAX_TOKENS;
// Usage réellement retourné par l'API sur un succès (input + output).
const REAL_USAGE_ON_SUCCESS = 4200;
const CHUNKS = 6;

console.log(`  chunk mesuré          : ${CHUNK_SOURCE.length} caractères`);
console.log(`  estimatedInputTokens  : ${EST_INPUT_TOKENS} (via estimatePromptTokens)`);
console.log(`  + GROQ_MAX_TOKENS     : ${GROQ_MAX_TOKENS}`);
console.log(`  = projeté par requête : ${PROJECTED_PER_REQ}  (limite TPM = 7000)`);

async function measure(Limiter, outcome, label) {
  const limiter = new Limiter();
  const t0 = Date.now();
  const perChunk = [];

  for (let i = 0; i < CHUNKS; i++) {
    const start = Date.now();
    const release = await limiter.acquire(PROJECTED_PER_REQ);
    const waitedMs = Date.now() - start;
    perChunk.push(waitedMs);
    // L'ancienne signature ignore le 2e argument : elle retombe donc dans son
    // comportement d'origine (facturation de la projection).
    release(outcome === 'failed' ? 0 : REAL_USAGE_ON_SUCCESS, outcome);
  }

  const total = Date.now() - t0;
  console.log(
    `\n[${label}] ${CHUNKS} chunks, issue="${outcome}", TPM=7000\n` +
    `  attente par chunk : ${perChunk.map((ms) => `${(ms / 1000).toFixed(1)}s`).join('  ')}\n` +
    `  TOTAL ATTENDU     : ${(total / 1000).toFixed(1)}s`,
  );
  return total;
}

(async () => {
  console.log('═'.repeat(70));
  console.log('PROBLÈME B — scénario rapporté : appels en ÉCHEC (401 / refus réseau)');
  console.log('═'.repeat(70));

  const oldFail = await measure(OldLimiter, 'failed', 'AVANT (phase 39)');
  const newFail = await measure(NewLimiter, 'failed', 'APRÈS (phase 40)');

  console.log('\n' + '─'.repeat(70));
  console.log(
    `ÉCART sur appels en échec : ${(oldFail / 1000).toFixed(1)}s → ${(newFail / 1000).toFixed(1)}s ` +
    `(${oldFail > 0 ? `${(100 - (newFail / oldFail) * 100).toFixed(0)} % de moins` : 'n/a'})`,
  );

  console.log('\n\n' + '═'.repeat(70));
  console.log('CONTRÔLE — scénario nominal : appels RÉUSSIS (aucune régression attendue)');
  console.log('═'.repeat(70));

  const oldOk = await measure(OldLimiter, 'success', 'AVANT (phase 39)');
  const newOk = await measure(NewLimiter, 'success', 'APRÈS (phase 40)');

  console.log('\n' + '─'.repeat(70));
  console.log(
    `ÉCART sur appels réussis : ${(oldOk / 1000).toFixed(1)}s → ${(newOk / 1000).toFixed(1)}s ` +
    `— le correctif ne doit PAS accélérer ce cas (limite TPM inchangée).`,
  );

  const limiter = new NewLimiter();
  console.log('\n\n' + '═'.repeat(70));
  console.log('COMPTEURS DE DIAGNOSTIC (nouveau code)');
  console.log('═'.repeat(70));
  const rel = await limiter.acquire(PROJECTED_PER_REQ);
  rel(0, 'failed');
  console.log(`  totalFailedRequests   : ${limiter.totalFailedRequests}`);
  console.log(`  phantomTokensAvoided  : ${limiter.phantomTokensAvoided} tokens fantômes non facturés`);
})();
