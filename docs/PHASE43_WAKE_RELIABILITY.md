# Phase 43 — Réveil fiable de l'AI Engine Render

**Cas étudié** : `emstronglezin-cmd/movia-controller-final` — 40 fichiers récupérés, snapshot
réutilisé, mais `AI Engine unreachable: Render free-tier instance is hibernating
(hibernate-rate-limited)` et **5 tentatives échouant en moins d'une minute**.

---

## 1. Origine exacte de l'erreur

**Réponse à la question posée** : le message est **construit par notre application**, à
partir d'une **vraie réponse HTTP de Render**.

| Élément | Origine | Preuve |
|---|---|---|
| `429` | réponse HTTP réelle | statut reçu par axios |
| `x-render-routing: hibernate-rate-limited` | en-tête réel de Render | lu dans `classifyDispatchError` |
| le texte `AI Engine unreachable: … is hibernating` | **notre code** | `ai-engine.client.ts` (branche `prov.provenance === 'hibernation'`) |
| l'échec en < 1 min | **notre file** | `memory-queue.provider.ts` → `computeBackoff()` |

Aucune classification interne ne fabrique le 429 : il vient du serveur. En revanche, le
**rythme des tentatives** est entièrement de notre fait.

---

## 2. Cause racine démontrée

### Le plancher de réveil n'était jamais lu par la file réellement câblée

La Phase 41 avait posé `minDelayMs = 45 000` sur la `RetryableError` d'hibernation. Mais :

**a) Un seul provider de file est câblé.** `backend/src/queue/queue.module.ts` :

```ts
// PHASE 26.1 — MemoryQueueProvider uniquement
providers: [MemoryQueueProvider],
```

La stratégie Bull `conversionBackoffStrategy` — la seule qui honorait `minDelayMs` — est
enregistrée dans `jobs.module.ts` mais **inatteignable** à l'exécution.

**b) `MemoryQueueProvider.computeBackoff()` ne déléguait que sur `Retry-After` :**

```ts
// AVANT
private computeBackoff(job: MemoryJob): number {
  if (retryAfterMsOf(job.lastError) !== undefined) {   // ← seule condition
    return computeRetryDelayMs(job.lastError, job.attemptsMade);
  }
  ...branche legacy exponentielle, qui IGNORE minDelayMs...
}
```

Or un rejet d'hibernation Render n'envoie **pas** de `Retry-After`. On retombait donc dans la
branche legacy : `INITIAL_BACKOFF_MS = 2 000`, soit

```
2 s → 4 s → 8 s → 16 s  =  30 s pour 5 tentatives
```

**C'est exactement le symptôme observé.** Le plancher de 45 s posé en Phase 41 n'a jamais été
lu une seule fois.

> **Ce que je dois corriger dans mes affirmations précédentes** : en Phase 41 j'ai annoncé une
> « attente de réveil de 45 s » vérifiée par des tests unitaires sur
> `computeRetryDelayMs`. Ces tests passaient, mais ils exerçaient la **politique partagée**,
> pas le **chemin réellement câblé**. Le correctif était inopérant en production. C'est
> démontré ici par un test qui échoue avant correction : `Expected: >= 45000, Received: 2000`.

### Défauts annexes découverts

1. **Aucun support d'annulation dans la file** (`grep cancel` → vide). `JobsService.cancel()`
   passait le statut en base ; la file continuait de retenter et de consommer du quota.
2. **État « en limbe »** : le `finally` du worker retire toujours le job de `activeJobs`, et
   il n'est remis en `waitingQueue` qu'à l'expiration du backoff. Entre les deux, le job
   n'était dans **aucune** collection — donc impossible à annuler précisément quand il attend
   le réveil.
3. **`id` interne ≠ `jobId` métier** : la file génère `mem-${++counter}-${Date.now()}`. Sans
   double correspondance, aucune annulation venue de l'API ne pouvait viser le bon job.
4. **`health()` renvoie `null` pour toute erreur** : impossible de distinguer une instance
   endormie d'un 5xx applicatif ou d'une panne DNS.
5. **Branche morte** : dans ma première version de la sonde, `up-unavailable` (503) était
   masquée par `server-error`. Corrigée en testant le 503 applicatif **avant** les 5xx
   génériques.

---

## 3. Fichiers modifiés

| Fichier | Changement |
|---|---|
| `backend/src/queue/memory-queue.provider.ts` | `computeBackoff` délègue aussi sur `minDelayMs` ; collection `pendingRetry` ; `cancelJob()` + `findJob()` + `finalizeCancelled()` ; statut `cancelled` ; `retryTimer` annulable |
| `backend/src/modules/jobs/ai-engine.client.ts` | Budget de réveil (`wakeTrack`, `wakeBudgetMs`, `wakeMaxAttempts`) ; plancher **progressif avec jitter** (`computeWakeFloorMs`) ; `NonRetryableError` explicite à l'épuisement ; `[DISPATCH-WAKE-EXHAUSTED]` / `[DISPATCH-WAKE-RECOVERED]` ; `probeServiceState()` + types `AiServiceState` / `AiServiceProbe` ; ordre des branches 503 corrigé |
| `backend/src/queue/queue-adapter.service.ts` | `cancelJob()` délégué au provider actif |
| `backend/src/queue/queue.provider.interface.ts` | `cancelJob?(jobId)` optionnel (aucun provider cassé) |
| `backend/src/modules/jobs/jobs.service.ts` | `cancel()` propage à la file **avant** de statuer en base |
| `backend/src/queue/__tests__/memory-queue.wake-retry.spec.ts` | **NOUVEAU** — 14 tests |
| `backend/src/modules/jobs/__tests__/ai-engine.wake-budget.spec.ts` | **NOUVEAU** — 12 tests |

---

## 4. Tests exécutés et résultats

### Reproduction avant correctif

```
✕ BUG : un rejet d'hibernation SANS Retry-After attend le plancher minDelayMs (pas 2 s)
    Expected: >= 45000
    Received:    2000
```

### Après correctif

```
backend    npx tsc --noEmit   → exit 0
backend    npx jest           → Test Suites: 15 passed / Tests: 147 passed
ai-engine  npx tsc --noEmit   → exit 0
ai-engine  npx jest           → Test Suites:  9 passed / Tests:  83 passed
```

### Couverture exigée par la mission

| Exigence | Test | Résultat |
|---|---|---|
| Réveil réussi après 2 tentatives | `réveil réussi après 2 tentatives : même jobId, même snapshot` | ✓ |
| Service qui reste en veille | `budget épuisé → NonRetryableError EXPLICITE` | ✓ |
| 429 avec `Retry-After` | `429 AVEC Retry-After (90 s) → le Retry-After prime` | ✓ |
| 429 sans `Retry-After` | `1er rejet … plancher ≥ 45 s`, `429 SANS Retry-After → progressif` | ✓ |
| HTTP 500 | `500 + marqueur app → server-error` | ✓ |
| Erreur réseau | `aucune réponse HTTP → network-error`, `erreur réseau … backoff legacy inchangé` | ✓ |
| Absence de retries imbriqués | `pas de retries imbriqués : 5 tentatives max, jamais plus` | ✓ |
| Conservation job ID + snapshot | `même jobId, même snapshot, aucune recréation` | ✓ |
| Annulation propre | 4 tests `Annulation propre d'un job` | ✓ |

### Les tests ont échoué d'abord, puis révélé trois défauts

1. `computeBackoff` ignorait `minDelayMs` → **le bug principal**.
2. Sémantique `>` vs `>=` : avec `wakeMaxAttempts = 3`, l'épuisement n'arrivait qu'à la
   4ᵉ tentative. Corrigé en `>=` (le nom dit « maximum »).
3. `cancelJob` retournait `false` : le job en attente de retry n'était dans aucune collection,
   et l'`id` interne ne correspondait pas au `jobId` métier. D'où `pendingRetry` + `findJob`.

---

## 5. Vérification sur l'instance réelle

Sonde de `https://codemorph-1-rdx0.onrender.com/api/health` :

```
── sonde 1 ──
http=200 temps=12.385192s
rndr-id: 978785e1-3164-4b79
x-powered-by: Express
x-render-origin-server: Render
x-request-id: 2c17141d-5512-417e-9bcc-066825e85363
{"status":"ok","uptime":"0m 6s","process":{"pid":7,"version":"v20.20.2",…}}

── sonde 2 ──
http=200 temps=0.372427s
{"status":"ok","uptime":"0m 10s",…}
```

**Ce que cela prouve** :

- **Cold start réel reproduit** : 12,385 s avec `uptime:"0m 6s"` → l'instance était bien
  endormie et a redémarré.
- À chaud : 0,372 s.
- `x-powered-by: Express` + `x-request-id` écho → **le process Node a réellement répondu**.
- `rndr-id` et `x-render-origin-server` sont présents sur **les deux** réponses : ce sont des
  en-têtes de plateforme qui ne prouvent rien (confirmation de la Phase 41).

**Ce que cela ne prouve PAS** : je n'ai **pas** reproduit le rejet `429` +
`x-render-routing: hibernate-rate-limited`. Ce chemin reste attesté par ton log de
production, pas par ma propre observation. Le chemin « réveil réussi » est en revanche
démontré ci-dessus.

**Conséquence sur le choix des valeurs** : le spin-up réel observé est de ~12 s. Un plancher
de base de **45 s** le couvre largement, et la progression (`+15 s` par tentative, plafond
`180 s`) absorbe un démarrage plus lent sans jamais dépasser le budget.

---

## 6. Valeurs retenues et justification

| Paramètre | Valeur | Justification |
|---|---|---|
| `AI_ENGINE_HIBERNATION_WAIT_MS` | 45 000 (inchangé) | Spin-up réel mesuré à 12 s ; ~3,7× de marge. Doc Render : ~1 min. |
| progression par tentative | +15 000, plafond 180 000 | Un démarrage peut dépasser la minute ; progression sans emballement. |
| jitter | ±20 % | Désynchronise les jobs concurrents, évite l'effet troupeau. |
| `AI_ENGINE_WAKE_BUDGET_MS` | 240 000 | Budget de **réveil** distinct du traitement IA, inclus dans la limite globale. |
| `AI_ENGINE_WAKE_MAX_ATTEMPTS` | 6 | Borne le nombre de tentatives indépendamment du temps. |
| `AI_ENGINE_PROBE_MIN_INTERVAL_MS` | 20 000 | **Anti-boucle** : au plus une sonde par 20 s et par job. |
| `CONVERSION_MAX_ATTEMPTS` | 5 (inchangé) | Aucune augmentation du nombre de tentatives. |
| Timeout global de conversion | **inchangé** | Conformément à la consigne. |
| `MAX_DISPATCH_CONCURRENT` | 2 (inchangé) | Aucune augmentation de concurrence. |

**Le budget de réveil est distinct du temps de traitement IA** : il ne compte que le temps
passé à attendre que l'instance réponde, et s'arrête net (`NonRetryableError`) dès qu'il est
épuisé. Le timeout global de conversion n'a pas été touché.

### Erreur retournée à l'épuisement

```
AI Engine did not wake up: the Render instance stayed hibernating
(x-render-routing: hibernate-rate-limited) after 6 attempts over 240s
(wake budget 240s). The AI Engine code was never reached — this is a platform
wake-up failure, not a conversion error. Fix: switch the AI Engine to a paid
Render instance (paid plans do not spin down) or add an external keep-awake
ping, then retry the same job — its source snapshot is preserved, nothing
needs re-uploading.
```

Elle dit **quoi faire** et précise que le code applicatif n'a jamais été atteint.

---

## 7. Distinction des états (mission 3)

`probeServiceState()` classe, et **ne suppose jamais qu'un 429 signifie « en veille »** :

| État | Critère | Qui a répondu |
|---|---|---|
| `ready` | `/api/health` → 200 | l'app |
| `asleep` | 429 **et** `x-render-routing` d'hibernation | Render |
| `rate-limited` | 429 **sans** en-tête d'hibernation | app ou Render selon marqueurs |
| `up-unavailable` | 503 **avec** marqueur applicatif | l'app (ex: clé API manquante) |
| `starting` | 5xx **sans** marqueur applicatif | Render (l'app pas encore là) |
| `server-error` | 5xx **avec** marqueur applicatif | l'app |
| `network-error` | aucune réponse HTTP | personne |
| `app-error` | tout autre cas | à qualifier |

Seuls `x-powered-by` / un `x-request-id` écho prouvent que le process Node a répondu. Les
en-têtes Render sont présents sur toutes les réponses.

---

## 8. Contraintes respectées

- Aucune limite de sécurité désactivée : `computeRetryDelayMs` applique le plancher via
  `Math.max`, il ne peut qu'**allonger** une attente.
- Aucun réveil simulé : le test de succès fait réellement répondre le mock, et la sonde live
  ci-dessus est une vraie requête HTTP.
- Aucune boucle de réveil : la sonde est cadencée (20 s/job), les tentatives sont bornées
  (`wakeMaxAttempts` + `wakeBudgetMs`), et l'annulation supprime le timer de retry.
- Pas de retries imbriqués : un seul mécanisme (la file). Aucun retry rxjs interne.
- `jobId` et snapshot conservés : la file retente le **même** objet `MemoryJob`, rien n'est
  recréé ni re-téléchargé.
- Contrats d'API préservés : `cancelJob?` est **optionnel** dans `IQueueProvider`, aucun
  provider existant n'est cassé.
- Timeout global de conversion et concurrence **inchangés**.

---

## 9. Ce qui reste hors de portée du code

1. **Hibernation Render Free** — la cause physique. Remède : instance payante (« Paid compute
   plans do not spin down », doc Render) ou keep-awake externe. **Décision utilisateur.**
   Le correctif rend le réveil *fiable*, il ne supprime pas l'endormissement.
2. **Logs runtime `Awaiting logs...`** — je n'ai pas accès aux logs Render. La preuve que la
   requête atteint le code applicatif repose sur les en-têtes `x-powered-by` + `x-request-id`
   écho observés sur la sonde live, pas sur les logs.
3. **Le rejet 429 `hibernate-rate-limited` n'a pas été reproduit en direct** par moi.
