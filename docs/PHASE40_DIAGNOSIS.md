# PHASE 40 — Diagnostic et correctifs : auth Groq, rate limit, progression

Date : 2026-10-11 · Base : `9d8246b` (phase 39) · Statut : **corrigé, testé, non déployé**

---

## Avertissement sur la méthode

**Aucun log de production n'était disponible** dans le dépôt ni dans l'environnement de
travail (pas de fichier de log, pas de répertoire `logs/`, pas de variables Render ou Groq).
Les trois causes racines ci-dessous proviennent donc de la **lecture du code**, pas de
l'analyse de logs. Elles sont toutes confirmées par un test ou une mesure exécutée.

**La clé Groq n'a PAS été vérifiée.** Aucun accès au secret n'a été possible. L'existence
d'une `401 Invalid API Key` est prise comme un fait rapporté, pas comme un fait vérifié ici.

---

## Problème A — `401 Invalid API Key` sur plusieurs chunks

### Variable d'environnement

| Élément | Valeur vérifiée |
|---|---|
| Nom de la variable | `GROQ_API_KEY` (constante `GROQ_API_KEY_ENV`, `app.config.ts:11`) |
| Client | `new OpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1', timeout: 90_000, maxRetries: 0 })` |
| Modèles | cascade `openai/gpt-oss-120b` → `openai/gpt-oss-20b` |

### Cause racine

Dans le `catch` de `groqChat()`, **seul le 429 était traité**, et par correspondance de
sous-chaîne :

```ts
const is429 = msg.includes('429') || msg.includes('rate limit') || msg.includes('Rate limit');
if (is429) { /* backoff */ } else { throw err; }
```

Un 401 tombait donc dans le `else` et était relancé tel quel, **indiscernable d'une erreur
transitoire**. Chaque chunk refaisait un appel complet avec la même clé invalide — en passant
d'abord par le rate limiter. La détection était textuelle, jamais basée sur `err.status`.

### Correctif

- `GroqAuthError` + `isGroqAuthError()` : détection **structurelle** via `err.status`
  (401/403), avec repli texte pour les erreurs re-wrappées ayant perdu `status`.
- **Verrou process** (`groqAuthFailure`) : un 401 est permanent pour le process. Vérifié
  **avant** `acquire()` et avant tout appel HTTP → les chunks suivants ne partent plus.
- `assertGroqKeyConfigured()` : pré-vol dans `groqChat()` et dans `pipeline.run()` — une clé
  absente ou vide échoue immédiatement, sans appel réseau.
- La branche auth est testée **avant** la branche 429 : un 429 reste transitoire et ne pose
  jamais le verrou.
- Log `[GROQ-AUTH-FAILED]` / `[GROQ-AUTH-SKIPPED]` — **jamais** la clé.

**Distinction auth vs débit, explicite :** le message renvoyé nomme `GROQ_API_KEY` et indique
« Ce n'est PAS une limite de débit ».

### Preuve

`ai-engine/tests/groq-auth-and-rate-limit.test.ts` — pour 5 chunks avec une clé invalide :
**1 seul appel HTTP** au lieu de 5, et **aucune cascade de modèles** (6 appels évités).

---

## Problème B — Limiteur de débit : 8 s puis ~54 s

### Cause racine — facturation de tokens fantômes

`groqChat()` passe à `acquire()` la valeur `estimatedInputTokens + GROQ_MAX_TOKENS`.
Dans `release()`, un appel échoué avait `tokensUsed === 0`, ce qui le faisait tomber dans la
branche `else` :

```ts
else recordTokens(projectedPerReq);   // ← facturé alors que le fournisseur n'a RIEN consommé
```

**Chiffre vérifié** (mesuré avec la vraie `estimatePromptTokens`) :

```
chunk de 6 120 caractères  → estimatedInputTokens = 1 653
+ GROQ_MAX_TOKENS          → 2 800
= projeté par requête      → 4 453   (limite TPM = 7 000)
```

Un **seul** appel échoué facturant 4 453 tokens, le suivant projette 8 906 > 7 000 → attente
du reset de fenêtre (`windowRemaining + 2 000` ≈ 62 s), **en plus** de `MIN_INTERVAL_MS = 8 s`.
C'est exactement le symptôme rapporté : 8 s minimum, puis ~54 s de plus.

### Second défaut — le paceur ne pacait pas

`lastRequestEndTime` n'était écrit qu'au `release()`, et l'attente se faisait **après** la
prise du slot de sémaphore. N acquéreurs simultanés lisaient la même valeur et repartaient
ensemble : le limiteur était à la fois trop lent et sans espacement réel.

### Correctif

- `release(tokensUsed, outcome)` : `outcome: 'failed'` → **rien n'est facturé**.
- `lastRequestEndTime` remplacé par `nextSlotAt`, **réservé atomiquement** à l'acquisition.
- Le slot de sémaphore est **transféré** au waiter suivant, jamais décrémenté puis recréé
  (même race de sur-admission que celle corrigée côté backend en phase 39).
- Compteurs de diagnostic : `totalFailedRequests`, `phantomTokensAvoided`.
- **Aucune protection désactivée** : `TPM_LIMIT`, `MIN_INTERVAL_MS`, `MAX_CONCURRENT`,
  `GROQ_MAX_TOKENS` inchangés.

### Mesure avant/après — code réel des deux côtés

`scripts/measure-phase40-rate-limit.cjs` exécute le **vrai** `GroqRateLimiter` compilé des
deux versions (l'« avant » est un worktree git sur `9d8246b`, avec pour seule modification
l'ajout du mot-clé `export` sur la classe). Aucun appel Groq : on mesure le temps passé à
attendre dans `acquire()`.

| Scénario (6 chunks, TPM 7 000, `MIN_INTERVAL_MS=0`) | Avant | Après |
|---|---|---|
| **Appels en échec** (401 / refus réseau) | **310,2 s** | **0,0 s** |
| **Appels réussis** (contrôle) | 310,3 s | 310,3 s |

Lecture : avant le correctif, dès le 2ᵉ chunk en échec chaque requête attendait 62 s.
Le cas nominal est **strictement identique** — la limite TPM continue d'être respectée, il
n'y a pas d'accélération indue.

> `MIN_INTERVAL_MS` était mis à 0 dans cette mesure pour **isoler** la comptabilité TPM.
> Le délai minimal de 8 s entre requêtes est inchangé par le correctif et s'applique toujours.

---

## Problème C — Progression bloquée à 50 %

### Cause racine principale — la route n'existait pas

`jobs.service.ts:614` construit et transmet à l'AI Engine :

```ts
progressUrl = `${apiUrl}/jobs/${id}/progress`
```

**Aucune route de ce nom n'était déclarée dans `jobs.controller.ts`.** Chaque POST de
progression recevait un **404**. Et `ProgressReporter.sendAsync()` ne regardait jamais
`res.ok`, avec l'erreur avalée par un `catch {}` — l'échec était **totalement invisible**.

### Le « 50 % »

`calculateProgress()` est une table statique phase → pourcentage, où `'ir-generation': 50`.
`appendLog()` l'écrivait sans condition (la progression pouvait donc aussi **reculer**).
Pendant toute l'analyse sémantique, la base restait à 50, `filesGenerated` à 0 (les fichiers
n'existent qu'après la phase 5) et le statut à `converting`.

### Le « 15/33 chunks analyzed »

`runScheduled()` incrémentait `completed` et appelait `onProgress` **même quand
`task.run()` rejetait**, et `semantic-pipeline.ts` faisait `doneCount++` à chaque callback.
Un chunk dont l'appel IA avait échoué était compté comme analysé.

### Succès sans fichier

`handleCallback()` passait le job en `DONE` avec `progress: 100` et incrémentait le quota
dès que `payload.success` était vrai — **sans vérifier** qu'un fichier valide existait.

### Correctifs

| Fichier | Correctif |
|---|---|
| `jobs.controller.ts` | **Nouvelle route** `POST /jobs/:id/progress` — `@Public()` + `@SkipThrottle()` + contrôle `X-AI-Engine-Secret` (même protection que `/callback`) |
| `jobs.service.ts` | `handleProgress()` : interpolation réelle dans la bande de la phase, **monotone**, **plafonnée à 99** (100 réservé au callback de succès), jobs terminés ignorés |
| `jobs.service.ts` | `appendLog()` monotone ; `handleCallback()` refuse un succès sans fichier valide → `FAILED` explicite, **quota non incrémenté** |
| `progress-reporter.ts` | `res.ok` inspecté ; échec journalisé une fois par code d'erreur, avec pistes 404/401/403/réseau — **jamais** le secret |
| `scheduler.ts` | `onProgress` expose `{ succeeded, failed }` distincts de `completed` |
| `semantic-pipeline.ts` | `analyzed = doneFromCache + info.succeeded` — un échec n'est plus compté |

**Bandes de progression** (noms de phase vérifiés dans le code de l'AI Engine) :
`phase_1_ast` 15–30 · `phase_2_arch` 30–50 · `phase_3_ir` 50–65 · `mapping` 65–80 ·
`phase_5_planning` 80–90 · `validation` 90–99.

Aucune variable, route ou événement inventé : `progressUrl`, `handleCallback`, `currentPhase`,
`phaseLogs` et `filesGenerated` existaient déjà.

---

## Vérifications exécutées

```
backend     tsc --noEmit ......... exit 0
ai-engine   tsc --noEmit ......... exit 0
backend     jest ................. 11 suites, 98 tests — tous verts
ai-engine   jest .................  6 suites, 57 tests — tous verts
```

### Tests ajoutés

| Fichier | Tests | Couvre |
|---|---|---|
| `ai-engine/tests/groq-auth-and-rate-limit.test.ts` | 16 | A + B |
| `ai-engine/tests/phase36/scheduler-progress.test.ts` | 4 | C (comptage chunks) |
| `ai-engine/tests/progress-delivery.test.ts` | 6 | C (livraison silencieuse) |
| `backend/.../jobs.service.progress.spec.ts` | 8 | C (monotonie, plafond 99) |
| `backend/.../jobs.controller.progress.spec.ts` | 7 | C (route, secret) |
| `backend/.../jobs.controller.progress-http.spec.ts` | 7 | C (route réellement joignable en HTTP) |
| `backend/.../jobs.service.callback.spec.ts` | +4 | succès sans fichier |

Le test HTTP monte la **vraie** application Nest (préfixe `api/v1`, `JwtAuthGuard` et
`ThrottlerGuard` globaux, vraie `JwtStrategy`) et tape la route : 200 au lieu du 404. Un
contre-test vérifie qu'une route voisine renvoie bien 401 sans JWT — sans lui, le test
`@Public()` ne prouverait rien.

### Test existant modifié

`jobs.service.callback.spec.ts` — « callback SUCCÈS tardif sur un job FAILED ».
Son payload déclarait `filesGenerated: 12` tout en livrant `result.files: []` : exactement
l'état contradictoire que le nouveau garde-fou doit refuser. Le test portait sur la
**transition** FAILED → DONE d'une livraison tardive ; il reçoit désormais de vrais fichiers
et teste toujours la même chose. Le comportement qu'il encodait auparavant était le bug.

---

## Ce qui n'a PAS été vérifié

1. **La clé Groq.** Aucun accès au secret. Impossible de confirmer que la 401 vient bien de
   la clé et non d'une révocation, d'un quota épuisé ou d'une mauvaise variable côté Render.
2. **Exécution de bout en bout sur un vrai dépôt.** Nécessite un appel Groq réel. La
   validation « petit projet puis dépôt plus large » demandée reste à faire en environnement
   avec la clé.
3. **Lint.** Non exécutable : `npx eslint src` installe ESLint 10 (config plate uniquement)
   alors que le dépôt est en ESLint 8 avec config legacy, et aucun `.eslintrc` n'est câblé
   par workspace.
4. **La source exacte des 429** constatés en phase 39 reste non établie.

### À faire avant production

- [ ] Vérifier `GROQ_API_KEY` sur Render (valeur, portée, expiration) — **nécessite le secret**.
- [ ] Conversion d'un petit projet en environnement réel, en observant `[PROGRESS-RECEIVED]`,
      `[GROQ-AUTH-FAILED]` et `phantomTokensAvoided` dans les logs.
- [ ] Puis un dépôt plus large.
- [ ] Confirmer que la barre frontend avance réellement (elle lit `job.progress`, déjà câblé).
