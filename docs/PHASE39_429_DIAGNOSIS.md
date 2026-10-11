# Phase 39 — Diagnostic du blocage HTTP 429 Backend ↔ AI Engine

Date des mesures : **2026-10-11**
Cible mesurée : `https://codemorph-1-rdx0.onrender.com` (instance réelle, pas un mock)

---

## 1. Ce qui est DÉMONTRÉ (mesures réelles)

### 1.1 Aucun code de ce dépôt n'émet de 429

Grep exhaustif sur `backend/src` et `ai-engine/src` : aucune occurrence de
`res.status(429)`, `TooManyRequestsException`, ni middleware de type
`express-rate-limit`. `express-rate-limit` n'est même pas dans les dépendances
de `ai-engine/package.json`. La constante `appConfig.rateLimit`
(`ai-engine/src/config/app.config.ts:29`) est **déclarée mais jamais utilisée** :
aucun middleware ne la consomme.

Le champ `errorType=rate-limit` du log provient bien d'un vrai statut 429 reçu
par axios — mais ce statut n'est produit **ni par le Backend ni par l'AI Engine**.

### 1.2 `server: cloudflare` ne prouve RIEN — c'est l'erreur des phases 37/38

Mesure directe sur l'instance réelle :

| Requête | Statut | `server` | `x-render-origin-server` | `rndr-id` | `x-request-id` |
|---|---|---|---|---|---|
| `GET /api/health` | **200** | cloudflare | Render | présent | présent |
| `GET /` | **200** | cloudflare | Render | présent | présent |
| `POST /api/convert` (corps `{}`) | **401** | cloudflare | Render | présent | présent |
| `POST /api/convert` (corps illisible) | **400** | cloudflare | Render | présent | **absent** |

Render place **tous** les `*.onrender.com` derrière Cloudflare. L'en-tête
`server: cloudflare` est donc présent sur les 200 comme sur les 401.
En déduire « c'est l'edge Cloudflare » est invalide — c'est précisément ce
qu'ont fait les phases 37 et 38, qui ont toutes deux échoué.

### 1.3 L'edge ne limite pas le débit à ce volume

- 25 requêtes **séquentielles** sur `POST /api/convert` → 25 × 401, **0 × 429**.
- 80 requêtes **parallèles** sur `POST /api/convert` → 80 × 401, **0 × 429**,
  et les 80 réponses portent le `x-request-id` écho (donc l'app a répondu).

### 1.4 La taille du payload n'est pas en cause

Payload reconstruit aux dimensions réelles du bug (**50 fichiers,
196 888 caractères, 200 420 octets JSON**) → **401 en 211 ms**. Le corps
traverse Cloudflare + Render sans rejection. (401 et non 202 parce que
`AI_ENGINE_SECRET` est bien configuré côté AI Engine — voir §1.6.)

### 1.5 « 79 ms » ne prouve pas non plus un rejet par l'edge

Depuis ce poste (SEA), l'application répond en 110–200 ms. Backend et AI Engine
sont tous deux sur Render (région Frankfurt d'après `render.yaml`) : un
aller-retour origine y est de l'ordre de 10–30 ms. **79 ms est donc pleinement
compatible avec une réponse produite par l'application elle-même.**
L'inférence « 79 ms = trop rapide = edge » n'est pas fondée.

### 1.6 `AI_ENGINE_SECRET` est bien configuré sur l'AI Engine déployé

`POST /api/convert` sans le header renvoie
`401 {"error":"Unauthorized — invalid or missing X-AI-Engine-Secret"}`.
Un désaccord de secret produirait donc un **401**, pas un 429 : cette piste est
écartée pour le 429 (elle reste une cause distincte et permanente, déjà traitée
par `NonRetryableError`).

### 1.7 Le service free-tier se rendort réellement

Deux mesures distinctes, à ~24 min d'intervalle, ont chacune renvoyé
`uptime: "0m 6s"` avec un premier appel à **12,3 s**. Le spin-down Render est
donc actif et se reproduit. C'est un fait d'exploitation avéré, à distinguer du
429.

### 1.8 La cause de « aucun log correspondant dans les Runtime Logs »

**Cause démontrée dans le code** (`ai-engine/src/index.ts`, avant correction) :

```ts
app.use(json({ limit: '50mb' }));                        // ← AVANT
app.use((req, res, next) => requestLogger(req, res, next));
```

`json()` tournait **avant** `requestLogger`. Quand le corps est illisible ou
dépasse la limite, body-parser lève **avant** que le logger n'ait attaché
`req.id` ni posé l'en-tête `x-request-id`. Résultat mesuré (tableau §1.2,
dernière ligne) : réponse 400 **sans** `x-request-id`, alors que le Backend
avait bien envoyé le sien → la requête devient **incorrélable**, ce qui se lit
exactement comme « aucun log correspondant ».

Un contre-test automatisé rejoue l'ancien ordre et confirme la perte
(`ai-engine/tests/request-correlation.test.ts`).

---

## 2. Ce qui N'EST PAS démontré — et l'observation manquante

**La source exacte de ce 429 précis n'est pas établie**, et les logs rapportés
ne permettent pas de l'établir. Le dire autrement serait inventer une cause.

Pourquoi les logs disponibles ne suffisent pas :

1. `provider=ai-engine-edge` n'était **pas une observation** : c'était une
   chaîne littérale écrite dans `ai-engine.client.ts:347` avant même la lecture
   de la réponse.
2. Les seuls champs réellement informatifs de la ligne `[DISPATCH-429]`
   (`originHints=[...]` et `body=...`) ne figurent pas dans le rapport.
3. `originHints` ne capturait **ni `rndr-id` ni `x-render-origin-server`** —
   c'est-à-dire précisément les deux en-têtes qui discriminent origine vs edge.
   Le diagnostic était donc structurellement incapable de trancher.

### Observation manquante (exacte)

Sur le prochain 429, il faut la réponse brute et ces champs :

- présence/absence de `rndr-id`
- présence/absence de `x-render-origin-server`
- présence/absence de `x-powered-by`
- `x-request-id` renvoyé (et s'il vaut celui envoyé par le Backend)
- `retry-after` (valeur brute, même non parsable)
- `content-type` + `content-length` de la réponse
- les ~200 premiers octets du corps (une page HTML Cloudflare ≠ un JSON Express)

C'est exactement ce que la correction journalise désormais (§3.2). Tant que
cette ligne n'a pas été observée une fois en production, toute attribution à
Render, Cloudflare ou Groq reste une hypothèse.

### Hypothèses encore ouvertes (non tranchées)

- Rejet par une règle de débit côté Cloudflare/Render sur un motif non reproduit
  ici (les tests §1.3 n'ont pas déclenché de 429).
- Fenêtre de spin-down du free tier : la requête arrive pendant un redémarrage.
  À noter : 5 tentatives étalées sur ~75 s (backoff 5+10+20+40) qui échouent
  **toutes** cadrent mal avec une fenêtre de débit courte — ce qui affaiblit
  l'hypothèse « rate limit edge classique ».
- 429 émis par un intermédiaire hors de ce dépôt (proxy, worker).

---

## 3. Corrections appliquées

### 3.1 AI Engine — corrélation restaurée

`ai-engine/src/index.ts` : `requestLogger` monté **avant** `json()`.
Toute requête entrante est désormais journalisée et son identifiant écho,
**même si le parsing du corps échoue**.

`ai-engine/src/api/middleware/error.middleware.ts` : les rejets de body-parser
sont identifiés explicitement (`entity.parse.failed`, `entity.too.large`,
`request.aborted`, …) et journalisés au niveau `warn` — donc visibles avec le
`LOG_LEVEL=warn` documenté dans `render.yaml`. Aucun extrait du corps n'est
journalisé : uniquement le type, la taille déclarée et le `requestId`.

### 3.2 Backend — provenance réelle au lieu d'une supposition

`backend/src/modules/jobs/ai-engine.client.ts` : nouvelle fonction exportée
`classifyRateLimitProvenance(headers)` qui déduit la provenance des en-têtes :

- au moins un marqueur d'origine (`rndr-id`, `x-render-origin-server`,
  `x-render-routing`, `x-powered-by`, `x-request-id`) → `provider=ai-engine-origin`,
  `provenance=origin`
- aucun marqueur d'origine mais un marqueur d'intermédiaire → `provider=edge-or-proxy`,
  `provenance=edge`
- sinon → `provenance=unknown`, et le log dit explicitement de ne pas conclure

La ligne `[DISPATCH-429]` porte désormais `provenance=`, `retryAfterHeader=`
(valeur brute, même non parsable), `content-type`, `content-length` et un
`verdict` lisible. Aucun secret n'y figure (test dédié).

### 3.3 Backend — bug de classification des 2xx non-202

`validateStatus: (s) => s === 202` faisait qu'un **200** levait une AxiosError
qu'aucune branche 4xx/5xx ne capturait : elle retombait sur « pas de réponse »
et produisait `RetryableError kind=network` **plus** `recordFailure()`, qui
alimente le circuit breaker. Un succès était donc traité comme une panne réseau.
Corrigé : tout 2xx est un succès, `accepted` est déduit du corps avec repli sur
le statut, et une branche garde-fou empêche tout statut inattendu d'être
étiqueté `network`.

### 3.4 Backend — race de sur-admission du sémaphore

`MAX_DISPATCH_CONCURRENT` était violable sous charge. Avec MAX=2, 2 requêtes en
vol et 1 en attente, `release()` décrémentait **puis** réveillait l'attendu
(microtâche) : un appel arrivant synchrone dans cette fenêtre était admis, puis
l'attendu incrémentait à son tour → **3 requêtes simultanées**.
Le test dédié échoue sur l'ancien code avec `Received: 3`.
Corrigé par transfert direct du slot (le compteur n'est jamais décrémenté
pendant un transfert). L'acquisition est aussi déplacée immédiatement avant le
`try/finally`, supprimant la fenêtre de fuite de slot.

### 3.5 Backend — snapshot des sources entre tentatives (objectif 8)

Nouveau `backend/src/queue/source-snapshot-cache.ts`, câblé dans
`conversion-processor.service.ts`. Auparavant, chaque tentative re-téléchargeait
le dépôt GitHub (ou re-dézippait) : avec 5 tentatives, un projet de 50 fichiers
/ ~195 000 caractères était re-téléchargé et re-analysé **5 fois**, plus
5 × N appels à l'API GitHub.

Cohérence préservée :
- la tentative 0 télécharge toujours à neuf ; seule une reprise (`attemptsMade > 0`)
  réutilise le snapshot du **même** `jobId` ;
- le `dto` d'un job est figé à l'enqueue (même repo, même branche) ;
- un snapshot figé évite en réalité de convertir un dépôt modifié en cours de
  retry sous le même `jobId` ;
- TTL 10 min (la fenêtre de retry réelle est ~75 s) ;
- purgé dès que le job atteint un état terminal ;
- borné en nombre d'entrées (20) **et** en caractères (20 Mo) pour le free tier.

Le cache conserve le jeu **après** troncature selon le plan : une reprise renvoie
un payload strictement identique (test dédié).

### 3.6 Ce qui n'a PAS été touché (objectif 6 et 10)

- Aucune protection de débit contournée, aucune limite augmentée.
- `CONVERSION_MAX_ATTEMPTS` inchangé (5), backoff inchangé
  (`retry-delay.ts` : exponentiel + jitter ±25 %, `Retry-After` respecté et plafonné).
- Un seul mécanisme de retry : la file. Aucun retry rxjs interne.
- Limites des offres (`plan-limits.config.ts`), quotas, `AI_ENGINE_SECRET`,
  validation SSRF, idempotence par `jobId` côté AI Engine : inchangés.
- `GET /api/convert/frameworks`, `/api/health*`, mock mode : inchangés.

---

## 4. Fichiers modifiés / ajoutés

Modifiés :
- `ai-engine/src/index.ts`
- `ai-engine/src/api/middleware/error.middleware.ts`
- `backend/src/modules/jobs/ai-engine.client.ts`
- `backend/src/queue/conversion-processor.service.ts`

Ajoutés :
- `backend/src/queue/source-snapshot-cache.ts`
- `backend/src/modules/jobs/__tests__/ai-engine.provenance.spec.ts`
- `backend/src/queue/__tests__/source-snapshot-cache.spec.ts`
- `backend/src/queue/__tests__/conversion-processor.snapshot.spec.ts`
- `ai-engine/tests/request-correlation.test.ts`
- `scripts/probe-ai-engine.mjs`

---

## 5. Tests exécutés et résultats

Avant (baseline, mesurée sur `main` = `3f769fa`) :

```
backend   : 5 suites, 32 tests, tous verts
ai-engine : 2 suites, 24 tests, tous verts
```

Après :

```
backend   : 8 suites, 73 tests, tous verts
ai-engine : 3 suites, 31 tests, tous verts
type-check backend   (tsc --noEmit) : OK
type-check ai-engine (tsc --noEmit) : OK
build backend   (nest build) : OK
build ai-engine (tsc)        : OK
```

Couverture ajoutée : succès 202 et 200, 429 avec/sans `Retry-After`, 429
origine vs edge, erreurs transitoires (5xx, réseau, timeout), erreurs
définitives (401, 400), non-fuite du secret, borne de concurrence, absence de
fuite de slot, TTL/éviction/budget du cache, non-re-téléchargement GitHub,
corrélation `x-request-id` sur corps rejeté.

Deux tests ont été validés comme **discriminants** (ils échouent réellement sur
l'ancien code) :
- race du sémaphore → `Expected: <= 2, Received: 3`
- perte du `x-request-id` avec l'ancien ordre de middlewares

### Lint — état préexistant, non corrigé

`npm run lint` échoue **sur le repo tel quel**, indépendamment de ces
modifications : il n'existe aucun `.eslintrc` dans `backend/` ni `ai-engine/`,
seulement un `.eslintrc.base.js` à la racine qui n'est raccordé à aucun
workspace. Aucun fichier de configuration n'a été touché ici (`git status`
le confirme). Corriger la configuration ESLint est hors du périmètre de ce
diagnostic.

---

## 6. Procédure de validation sur Render

### Étape 0 — Avant de déployer : capturer la preuve manquante

Le 429 n'étant pas reproduit, **ne pas considérer la cause comme close**.
La version déployée produira la preuve au prochain 429.

### Étape 1 — Déployer

1. Pousser cette branche, déployer `codemorph-ai` (AI Engine) **et**
   `codemorph-backend` sur Render. Les deux sont nécessaires : le fix de
   corrélation est côté AI Engine, le fix de provenance côté Backend.
2. Vérifier dans Render → Service → Logs que chaque service a redémarré.

### Étape 2 — Vérifier la joignabilité (2 min)

```bash
node scripts/probe-ai-engine.mjs https://codemorph-1-rdx0.onrender.com
```

Attendu : `Application joignable : OUI`, les trois sondes en `provenance : ORIGIN`
et `id corrélé écho : OUI`. Code de sortie 0.
La première sonde peut prendre ~12 s si le service était endormi — c'est normal.

### Étape 3 — Vérifier la corrélation dans les Runtime Logs de l'AI Engine

Envoyer un corps invalide puis chercher le `x-request-id` dans les logs :

```bash
curl -i -X POST https://codemorph-1-rdx0.onrender.com/api/convert \
  -H 'content-type: application/json' -H 'x-request-id: corr-manuel-001' \
  -d '{,,}'
```

Attendu : `400`, en-tête `x-request-id: corr-manuel-001` **présent dans la
réponse**, et dans les Runtime Logs une ligne `Client error` portant
`"requestId":"corr-manuel-001"`. Avant le fix, cet identifiant était absent.

### Étape 4 — Vérifier le secret (cause distincte, permanente)

```bash
curl -i -X POST https://codemorph-1-rdx0.onrender.com/api/convert \
  -H 'content-type: application/json' -d '{}'
```

Attendu : `401`. Si le Backend reçoit aussi 401 en production, `AI_ENGINE_SECRET`
diffère entre les deux services : l'aligner dans Render → Environment des deux
services, puis redémarrer. Ce cas ne doit **pas** être retenté
(`NonRetryableError`).

### Étape 5 — Lancer une conversion réelle et lire les logs

Lancer une conversion Flutter → React Native, puis dans les logs du Backend :

```bash
# côté Backend
grep -E '\[DISPATCH-(START|SLOT|RESPONSE|429)\]' <logs>
```

- Cas nominal : `[DISPATCH-RESPONSE] ... httpStatus=202` **et** côté AI Engine
  `[AI-ENGINE-REQUEST]` puis `[AI-ENGINE-ACCEPTED]` avec le **même** `jobId`.
- En cas de reprise : `[PIPELINE] Snapshot sources réutilisé` et
  `[MemoryQueue] ⚠️ ... retry dans Nms`. Vérifier qu'un seul
  `Fetching GitHub repo` apparaît pour tout le job.

### Étape 6 — Si un 429 réapparaît : lire le verdict, ne pas deviner

```bash
grep '\[DISPATCH-429\]' <logs backend>
```

La ligne donne maintenant `provenance=` et `verdict="..."` :

- `provenance=origin` → la limite vient de l'application ou du plan Render.
  Chercher côté AI Engine / configuration Render, **pas** côté Cloudflare.
- `provenance=edge` → aucun marqueur d'origine : rejet avant l'application.
  C'est la seule configuration qui autorise à incriminer la couche
  intermédiaire. Croiser avec le `cf-ray` pour ouvrir un ticket.
- `provenance=unknown` → ne rien conclure ; capturer la réponse brute.

Corréler ensuite le `requestId=` du Backend avec le `x-request-id` des Runtime
Logs de l'AI Engine : s'il est présent des deux côtés, la requête a atteint
l'application ; s'il manque côté AI Engine, elle a été rejetée avant.

### Étape 7 — Réduire l'effet du spin-down (recommandé, hors code)

Le free tier s'endort après ~15 min d'inactivité (mesuré : `uptime 0m 6s`,
premier appel 12,3 s, deux fois en 25 min). Options, par ordre de coût :
- sonde externe sur `GET /api/health/liveness` toutes les 10 min ;
- passer l'AI Engine sur un plan payant (supprime le spin-down).

Une sonde ne corrige pas un 429 ; elle supprime en revanche les échecs liés aux
redémarrages à froid, qui peuvent se présenter de façon trompeuse.
