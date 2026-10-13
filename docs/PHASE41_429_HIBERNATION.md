# CodeMorph — Diagnostic du HTTP 429 entre Backend et AI Engine

Date : 2026-10-13 · Base : `b201ad4` · Statut : **corrigé et testé, non déployé**

---

## 1. Cause

### Ce qui est prouvé

Le 429 **ne vient pas de l'application**. Trois éléments indépendants le démontrent :

**a) Aucun chemin de code de l'AI Engine ne produit de 429.** Vérifié en listant toutes les
occurrences de `429` dans `ai-engine/src/` : elles concernent toutes la *gestion* des 429 de
Groq. Le service ne monte que deux middlewares (`error.middleware.ts`,
`logger.middleware.ts`) et n'a **aucune dépendance de rate limiting** — vérifié sur
`package.json` : aucune correspondance pour `rate|limit|throttl|helmet`.

**b) `durationMs=72` est incompatible avec un réveil applicatif.** Un process Node qui
démarre ne répond pas en 72 ms. Mesuré en direct sur le service réel ce jour :

```
─── sonde 1 (20:53:16) ───  HTTP 200 en 12393 ms
  rndr-id: 0080f8f9-3715-4533      x-powered-by: Express
  body: {"status":"ok","uptime":"0m 7s","process":{"pid":7,"version":"v20.20.2",…}}
─── sonde 2 (20:53:32) ───  HTTP 200 en 174 ms   uptime:"0m 10s"  (même pid 7)
─── sonde 3 (20:53:35) ───  HTTP 200 en 188 ms   uptime:"0m 13s"  (même pid 7)
```

La première requête a mis **12,4 s** et le process n'avait que **7 s d'uptime** : l'instance
était endormie, ma requête l'a réveillée. Les deux suivantes, à chaud, 174 ms et 188 ms.
C'est la seconde mesure indépendante de ce comportement (la phase 39 avait relevé
`uptime: "0m 6s"` et ~12,3 s).

**c) Le spin-down est la configuration documentée de ce déploiement.** `render.yaml`, ligne 3 :
« ✅ Plan free : 0$/mo — web service avec sleep après 15min inactivité ». Documentation
officielle Render : une instance free s'endort après 15 min sans trafic et « takes about one
minute » pour se réveiller.

**d) `x-render-routing: hibernate-rate-limited`** est la signature d'un rejet par la porte
d'hibernation de Render : l'instance endormie peut **refuser** un réveil au lieu de mettre la
requête en file. Corroboré par trois sources tierces indépendantes (PR GitHub de 2026 sur
`edmullen/credentials-demo#47`, `nonkun12/line-bot#423` et `#426`).

**Enchaînement complet :** instance endormie → Render refuse le réveil avec 429 en ~72 ms →
les 5 tentatives du backend, espacées de 5/10/20/40 s, sont toutes des tentatives de réveil
trop rapprochées → abandon. L'import GitHub (50 fichiers, 194 910 caractères) avait réussi
car il ne dépend pas de l'AI Engine ; aucun fichier de sortie puisque la conversion n'a
jamais démarré.

### Ce qui reste à vérifier

- **Le 429 lui-même n'a pas été reproduit.** Mes trois sondes ont obtenu le chemin « file
  d'attente puis réponse lente » (200 en 12,4 s), pas le rejet. La porte d'hibernation ne
  rejette pas systématiquement.
- **`x-render-routing: hibernate-rate-limited` n'est pas documenté publiquement par Render** à
  l'adresse que j'ai testée (`/docs/rate-limiting` renvoie 404). Le spin-down et la minute de
  réveil sont officiels ; la valeur exacte de cet en-tête repose sur des sources tierces.
- **Aucun log de production** n'était disponible dans le dépôt ni dans l'environnement.

### Le diagnostic précédent était faux, et pourquoi

`classifyRateLimitProvenance()` (phase 39) traitait `rndr-id`, `x-render-origin-server` et
`x-render-routing` comme des « marqueurs d'origine applicative ». Le 429 rapporté portait
`rndr-id` → classé `provenance=origin`, `provider=ai-engine-origin`, avec un verdict
orientant l'opérateur vers « la limite de débit côté application / plan Render ».

Ces en-têtes sont posés par la **couche de routage de Render**, y compris sur ses propres
réponses de rejet. Seuls `x-powered-by: Express` (posé par Express) et `x-request-id` (écho
par notre `requestLogger`) prouvent que le process Node a tourné.

---

## 2. Fichiers modifiés

| Fichier | Nature |
|---|---|
| `backend/src/modules/jobs/ai-engine.client.ts` | Correction du classificateur + branche hibernation |
| `backend/src/queue/retryable.error.ts` | Nouveau champ `minDelayMs` + accesseur |
| `backend/src/queue/retry-delay.ts` | Application du plancher (plancher, jamais plafond) |
| `backend/src/queue/source-snapshot-cache.ts` | Commentaire TTL mis à jour (fenêtre de retry réelle) |
| `ai-engine/src/api/health.router.ts` | `readiness` accepte `GROQ_API_KEY` |
| `backend/src/modules/jobs/__tests__/ai-engine.provenance.spec.ts` | 4 assertions corrigées |
| `backend/src/modules/jobs/__tests__/ai-engine.hibernation.spec.ts` | **Nouveau** — 16 tests |
| `backend/src/modules/jobs/__tests__/ai-engine.availability.spec.ts` | **Nouveau** — 6 tests |
| `ai-engine/tests/health-readiness.test.ts` | **Nouveau** — 7 tests |

---

## 3. Corrections

**a) Séparation des marqueurs.** `APP_MARKERS = ['x-powered-by','x-request-id']` contre
`RENDER_PLATFORM_MARKERS = ['rndr-id','x-render-origin-server','x-render-routing']`.
Nouvelles provenances `hibernation` et `render-platform`.

**b) Détection explicite de l'hibernation.** `isRenderHibernationRejection()` teste
`x-render-routing` sur `/hibernate/i`. Évaluée **en premier**, avant les marqueurs
applicatifs : si Render refuse à l'éveil, l'app n'a pas répondu.

**c) Log nommant la couche responsable.** Nouvelle ligne `[DISPATCH-429-HIBERNATION]` avec
`errorType=hibernation`, `layer=render-routing`, `durationMs`, `nextAttemptFloorMs`,
`action=WAIT_FOR_SPIN_UP_VIA_QUEUE_BACKOFF`. La ligne `[DISPATCH-429]` ordinaire gagne un
champ `layer=`.

**d) Plancher d'attente aligné sur le réveil réel.** `minDelayMs` porté par l'erreur
(`AI_ENGINE_HIBERNATION_WAIT_MS`, défaut 45 s, borné 5 s–10 min), appliqué par
`computeRetryDelayMs` via `Math.max` **en dernier**. Il ne peut qu'allonger l'attente —
aucune limite contournée, aucune protection désactivée. Sur 5 tentatives, l'attente cumulée
dépasse 180 s contre 75 s avant, ce qui couvre la minute de réveil documentée.

**e) Le circuit breaker n'est pas touché par un 429.** Déjà le cas depuis la phase 37
(`recordFailure()` n'est appelé que sur 5xx / absence de réponse) — verrouillé par un test.

**f) `readiness` acceptait uniquement `OPENAI_API_KEY`** alors que le tier par défaut tourne
sur `GROQ_API_KEY`. Un déploiement Render avec la seule clé Groq — le cas documenté — était
déclaré `not-ready` (503). Corrigé pour accepter l'une ou l'autre.

**g) Non corrigé car déjà correct** (vérifié, pas supposé) :
- **Pas de double retry** : aucun `retry` rxjs interne dans le pipe ; `catchError` classe, la
  file planifie. Un seul mécanisme.
- **Pas de FAILED prématuré** : le job reste `ANALYZING` tant qu'il reste des tentatives ;
  `FAILED` n'est écrit qu'à épuisement.
- **L'import GitHub n'est pas rejoué** : `sourceSnapshotCache` (TTL 10 min) couvre 7 tests,
  dont « reprise après 429 → NE re-télécharge PAS GitHub ».
- **`Retry-After` respecté** lorsqu'il est réellement fourni, +1 s de marge, plafonné.

---

## 4. Tests

```
backend     tsc --noEmit ......... exit 0
ai-engine   tsc --noEmit ......... exit 0
backend     jest ................. 13 suites, 121 tests — 0 échec
ai-engine   jest .................  7 suites,  64 tests — 0 échec
```

### Couverture de la liste obligatoire

| Exigence | Statut | Où |
|---|---|---|
| Réponse normale 200 | ✅ | `ai-engine.client.spec.ts`, `provenance.spec.ts`, `availability.spec.ts` |
| 429 avec `Retry-After` | ✅ | `ai-engine.client.spec.ts` TEST 1, `hibernation.spec.ts` |
| 429 sans `Retry-After` | ✅ | `ai-engine.client.spec.ts` TEST 2, `provenance.spec.ts` |
| 401 non réessayée indéfiniment | ✅ | `ai-engine.client.spec.ts` TEST 4/9 → `NonRetryableError` |
| Timeout et indisponibilité | ✅ **ajouté** | `availability.spec.ts` — ECONNABORTED et ECONNREFUSED |
| Reprise sans re-import GitHub | ✅ | `conversion-processor.snapshot.spec.ts` (7 tests) |

### 4 tests existants modifiés

`ai-engine.provenance.spec.ts`. Deux étaient des renommages d'assertion
(`originMarkers=` → `appMarkers=`). Deux **encodaient l'hypothèse fausse** : « chaque
marqueur d'origine suffit isolément à prouver l'origine », dont `x-render-routing`, et un cas
de casse mixte n'envoyant que `X-Render-Origin-Server` en attendant `origin`. Ces deux tests
verrouillaient précisément le diagnostic erroné du 429 de production. Ils sont remplacés par
un test par catégorie : marqueur **applicatif** seul → `origin` ; marqueur de **plateforme**
seul → `render-platform`.

### Non testé

- Le comportement réel de la porte d'hibernation Render (non reproductible à la demande).
- Le lint : non exécutable — `npx eslint src` installe ESLint 10 (config plate) alors que le
  dépôt est en ESLint 8 config legacy, sans `.eslintrc` par workspace.
- Aucun test d'intégration de bout en bout backend → AI Engine réel.

---

## 5. Actions manuelles dans Render

Le correctif améliore le diagnostic et l'attente, **il ne supprime pas le spin-down** : c'est
une propriété du plan free, pas un bug du code.

1. **Vérifier la sonde de santé.** Dashboard → AI Engine → Settings → *Health Check Path*.
   Si elle pointe sur `/api/health/readiness`, la correction (f) est nécessaire au prochain
   déploiement. `/api/health/liveness` est plus sûr : il répond 200 quelle que soit la
   configuration de clés.
2. **Choisir la variable d'attente.** Par défaut 45 s. `AI_ENGINE_HIBERNATION_WAIT_MS=60000`
   si les réveils échouent encore. Ne pas descendre sous 30 s.
3. **Décider du plan.** La seule suppression définitive du 429 d'hibernation est le passage
   au plan Starter (~7 $/mois) : « Paid compute plans do *not* spin down ». Un ping externe
   toutes les 14 min est une alternative, mais consomme les 750 h gratuites du workspace.
4. **Confirmer `AI_ENGINE_URL`** côté backend : valeur réelle
   `https://codemorph-1-rdx0.onrender.com`, et non le nom `codemorph-ai` documenté.
5. **Vérifier après déploiement** qu'un log `[DISPATCH-429-HIBERNATION]` apparaît avec
   `layer=render-routing` lors du prochain cold start, et plus `provenance=origin`.

---

## 6. Dette

- Le spin-down free tier reste la cause première ; aucune correction logicielle ne l'élimine.
- `AI_ENGINE_HIBERNATION_WAIT_MS` est un réglage empirique : 45 s par défaut, non mesuré sur
  un échec réel puisque je n'ai pas pu reproduire le 429.
- Le backend n'a pas de « pré-réveil » : un `GET /api/health/liveness` envoyé avant le
  dispatch absorberait le cold start hors du chemin critique. Non implémenté — c'est un
  changement d'architecture, hors périmètre de cette tâche.
