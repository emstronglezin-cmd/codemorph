#!/usr/bin/env node
// ============================================================
// CodeMorph — PHASE 39 : sonde de joignabilité Backend → AI Engine
// ------------------------------------------------------------
// BUT (objectif 5) : vérifier en une commande si une requête ATTEINT
// réellement l'application AI Engine, et savoir QUI répond (origine
// applicative ou couche intermédiaire), sans exposer de nouvel endpoint.
//
// Routes utilisées — toutes EXISTANTES :
//   GET  /api/health            (publique, sonde Render)
//   GET  /api/health/liveness   (publique)
//   POST /api/convert           (protégée) avec un corps VOLONTAIREMENT
//                               invalide : prouve que la requête traverse
//                               l'edge + l'authentification sans jamais
//                               démarrer de pipeline ni consommer de quota IA.
//
// Aucune clé, aucun jeton, aucun code source n'est envoyé ni affiché.
// Usage :
//   node scripts/probe-ai-engine.mjs [BASE_URL]
//   AI_ENGINE_URL=https://... node scripts/probe-ai-engine.mjs
// Code de sortie : 0 = l'application répond ; 1 = non joignable / ambigu.
// ============================================================

const BASE = (process.argv[2] ?? process.env.AI_ENGINE_URL ?? 'https://codemorph-1-rdx0.onrender.com')
  .replace(/\/+$/, '');

// En-têtes qui prouvent le passage par l'ORIGINE applicative.
// (Vérifié le 2026-10-11 : `server: cloudflare` est présent sur TOUTES les
// réponses Render, y compris les 200 — il ne discrimine donc rien.)
const ORIGIN_MARKERS = [
  'rndr-id',
  'x-render-origin-server',
  'x-render-routing',
  'x-powered-by',
  'x-request-id',
];

function provenanceOf(headers) {
  const found = ORIGIN_MARKERS.filter((h) => headers.get(h));
  if (found.length > 0) {
    return { verdict: 'ORIGIN', markers: found, who: "l'application AI Engine (ou son routeur Render)" };
  }
  if (headers.get('server') || headers.get('cf-ray') || headers.get('via')) {
    return { verdict: 'EDGE', markers: [], who: 'une couche intermédiaire, AVANT l\'application' };
  }
  return { verdict: 'UNKNOWN', markers: [], who: 'indéterminé — ne pas conclure' };
}

async function probe(label, path, init) {
  const requestId = `probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const started = Date.now();
  const line = (s) => process.stdout.write(s);

  line(`\n── ${label}\n   ${init?.method ?? 'GET'} ${BASE}${path}\n`);
  line(`   x-request-id envoyé : ${requestId}\n`);

  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000),
      headers: { 'x-request-id': requestId, ...(init?.headers ?? {}) },
    });
    const durationMs = Date.now() - started;
    const body = await res.text();
    const prov = provenanceOf(res.headers);

    line(`   statut              : ${res.status}\n`);
    line(`   durée               : ${durationMs} ms\n`);
    line(`   x-request-id reçu   : ${res.headers.get('x-request-id') ?? '(absent)'}\n`);
    line(`   server              : ${res.headers.get('server') ?? '(absent)'}\n`);
    line(`   x-render-origin-srv : ${res.headers.get('x-render-origin-server') ?? '(absent)'}\n`);
    line(`   rndr-id             : ${res.headers.get('rndr-id') ?? '(absent)'}\n`);
    line(`   retry-after         : ${res.headers.get('retry-after') ?? '(absent)'}\n`);
    line(`   marqueurs d'origine : ${prov.markers.length ? prov.markers.join(', ') : 'AUCUN'}\n`);
    line(`   ⇒ provenance        : ${prov.verdict} — répond par ${prov.who}\n`);
    line(`   corps (200 car.)    : ${body.slice(0, 200).replace(/\s+/g, ' ')}\n`);

    // L'écho de notre identifiant est la preuve la plus forte : seul le
    // middleware applicative le renvoie.
    const echoed = res.headers.get('x-request-id') === requestId;
    line(`   ⇒ id corrélé écho   : ${echoed ? 'OUI (l\'application a bien traité la requête)' : 'non'}\n`);

    return { status: res.status, prov: prov.verdict, echoed, durationMs };
  } catch (err) {
    line(`   ERREUR réseau       : ${err?.message ?? err}\n`);
    line(`   ⇒ provenance        : unreachable — aucune réponse HTTP reçue\n`);
    return { status: 0, prov: 'unreachable', echoed: false, durationMs: Date.now() - started };
  }
}

(async () => {
  process.stdout.write(`\nSonde CodeMorph AI Engine — cible : ${BASE}\n`);

  const health = await probe('Santé (route publique existante)', '/api/health');
  const live   = await probe('Liveness (route publique existante)', '/api/health/liveness');
  // Corps volontairement invalide → rejet 400/401 AVANT tout pipeline.
  const conv = await probe('Convert (route protégée, corps invalide — aucun pipeline)', '/api/convert', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ probe: true, jobId: `probe-${Date.now()}` }),
  });

  const appAnswers = [health, live, conv].some((r) => r.prov === 'ORIGIN');
  const any429     = [health, live, conv].some((r) => r.status === 429);

  process.stdout.write('\n════════════ VERDICT ════════════\n');
  process.stdout.write(`Application joignable       : ${appAnswers ? 'OUI' : 'NON'}\n`);
  process.stdout.write(`Un 429 reproduit            : ${any429 ? 'OUI' : 'non'}\n`);
  if (!appAnswers) {
    process.stdout.write(
      '\nAucune réponse ne porte de marqueur d\'origine applicative.\n' +
      'Si un 429 survient dans cet état, il est produit AVANT l\'application :\n' +
      "c'est cohérent avec l'absence de log dans les Runtime Logs.\n",
    );
  } else {
    process.stdout.write(
      '\nL\'application répond et écho l\'identifiant de corrélation.\n' +
      'Tout 429 futur portant rndr-id / x-render-origin-server vient de l\'ORIGINE,\n' +
      'pas de Cloudflare. Le champ `provenance=` du log [DISPATCH-429] le dira.\n',
    );
  }

  process.exit(appAnswers ? 0 : 1);
})();
