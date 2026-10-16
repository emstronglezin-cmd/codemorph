# Phase 42 — Cause racine du pipeline IA : throttling auto-infligé

**Périmètre** : `ai-engine` (limiteur Groq, scheduler phase 36), `backend` (watchdog, annulation).
**Cas étudié** : `emstronglezin-cmd/permisconnect` — 50 fichiers / ~195 KB, 33 chunks,
modèle `openai/gpt-oss-120b`, échec après **121 minutes** avec `filesGenerated=0`.

> **Statut honnête** : les causes racines sont démontrées dans le code et couvertes par des
> tests. La conversion réelle de bout en bout sur Render **n'a pas été exécutée** — elle
> nécessite la clé Groq et une instance Render éveillée, auxquelles cet environnement n'a pas
> accès. Voir « Ce qui reste à vérifier ».

---

## 1. Causes racines démontrées

### A. Le 7 000 TPM était une valeur locale codée en dur, pas la limite réelle

```ts
// ai-engine/src/core/ai-provider.ts (AVANT)
const TPM_LIMIT = envInt('AI_RATE_LIMIT_TPM', 7_000, 100, 2_000_000);
```

La limite réelle de Groq pour `openai/gpt-oss-120b` en plan Free est **8 000 TPM**
(documentation Groq, corroborée par ~10 sources 2026). Le pipeline s'auto-imposait donc
**12,5 % de quota en moins**, sans jamais interroger la clé ni le modèle.

### B. Le délai de reset de fenêtre était faux — cause principale

Le TPM de Groq est une **fenêtre glissante de 60 s** (« the total token count… processed
within any rolling 60-second window »). L'ancien limiteur utilisait une **fenêtre fixe** :

```ts
// AVANT
const windowRemaining = WINDOW_MS - (now - this.windowStart);
const tpmWaitMs = windowRemaining + BUFFER_MS;   // + 2 000 ms
```

Il attendait **la totalité de la fenêtre restante** quel que soit le volume à expirer.
Un appel ayant consommé 3 000 tokens sur 7 000 bloquait le suivant ~60 s, alors que la
fenêtre glissante aurait libéré la place bien plus tôt. C'est ce qui produit les attentes
**55-59 s** observées dans les logs.

### C. Double comptage : deux portes TPM en série

Deux limiteurs indépendants lisaient la **même** variable d'environnement et s'appliquaient
**en série** sur chaque appel :

| Porte | Seuil | Fenêtre |
|---|---|---|
| `GroqRateLimiter` (`ai-provider.ts`) | `AI_RATE_LIMIT_TPM` → 7 000 | fixe 60 s |
| `waitForTokenBudget` (`phase36/scheduler.ts`) | `getPhase36Config().rateLimitTpm` → 6 500 | fixe 60 s |

Chaque appel IA passait donc **deux fois** par une porte TPM à fenêtre fixe.

### D. Projection de tokens systématiquement surévaluée

```ts
// AVANT
const projectedPerReq = Math.max(estimatedInputTokens, TOKENS_PER_REQ /* 3 500 */) + GROQ_MAX_TOKENS /* 2 800 */;
```

Deux défauts cumulés :

1. **Plancher de 3 500** : une estimation réelle inférieure était écrasée. Pour un chunk de
   ~5 900 caractères (~1 595 tokens), la projection devenait 3 500 et non 1 595.
2. **Sortie toujours au maximum** : `+ GROQ_MAX_TOKENS` (2 800) alors que la sortie réelle
   moyenne est bien inférieure. Elle n'était **jamais observée**.

**Arithmétique du blocage** : projection = `max(1 595, 3 500) + 2 800` = **6 300 tokens**.
Avec un plafond de 7 000 : `⌊7 000 / 6 300⌋` = **1 seul appel par fenêtre de 60 s**.
33 chunks ⇒ **≥ 33 minutes** de plancher incompressible, avant tout retry.

### E. RPM jamais géré ; intervalle minimal auto-limitant

Aucun compteur RPM n'existait. À la place :

```ts
const MIN_INTERVAL_MS = envInt('AI_MIN_INTERVAL_MS', 8_000, ...);
```

8 s d'écart minimum ⇒ **7,5 req/min**, contre **30 RPM** réels : auto-throttle ×4.
Et `AI_MAX_CONCURRENT_REQUESTS` par défaut à **1** rendait le pipeline séquentiel.

### F. Les en-têtes `x-ratelimit-*` n'étaient jamais lus

`grep -rn "x-ratelimit" ai-engine/src backend/src` → **aucun résultat**. Groq renvoie
`x-ratelimit-remaining-tokens` et `x-ratelimit-reset-tokens` (ex. `7.66s`) ; le pipeline
les ignorait et recalculait tout localement, donc divergeait de l'état réel du serveur.

### G. Le watchdog : le heartbeat comptait comme preuve de progrès

`backend/src/modules/jobs/jobs.service.ts` :

```ts
const CONVERTING_STALE_MINUTES   = 60;    // PASSE B — basée sur updatedAt (heartbeat)
const CONVERTING_ABSOLUTE_MAX_MIN = 120;  // PASSE A — basée sur startedAt
```

La **PASSE A** tue inconditionnellement tout job dont `startedAt` dépasse 120 min. C'est elle
qui a tiré à 121 min. La PASSE B était neutralisée par le heartbeat : un job qui bat mais ne
progresse pas n'est jamais détecté. **Le heartbeat prouve la vivacité, pas le progrès.**

### H. Annulation inefficace

`cancel(id, userId)` met le job en `FAILED` en base **sans jamais notifier l'AI Engine**.
Le pipeline continue de tourner et de consommer du quota Groq après annulation.

### I. Les 429 `x-render-routing=hibernate-rate-limited` sont un problème distinct

Déjà traité en Phase 41 (`ab33388`) : hibernation Render Free, rejet du réveil en 72 ms,
sans `Retry-After`. **À ne pas confondre** avec les attentes TPM de Groq : origines, délais
et remèdes différents. Aucune régression introduite ici.

---

## 2. Fichiers modifiés

| Fichier | Changement |
|---|---|
| `ai-engine/src/core/ai-provider.ts` | `GroqRateLimiter` réécrit : fenêtre **glissante** 60 s à expiration par événement, `reserveFor()`, compteur **RPM** séparé, `observeRateLimitHeaders()`, `noteOutputTokens()`, `noteRetry()`, `telemetry()` |
| `ai-engine/src/core/phase36/config.ts` | `rateLimitTpm` → `AI_PHASE36_PACING_TPM`, **défaut 0** (porte duplicate désactivée, réactivable) |
| `ai-engine/src/core/phase36/scheduler.ts` | Pacing conditionné à `tpm > 0` |
| `ai-engine/tests/groq-limiter-sliding-window.test.ts` | **NOUVEAU** — 18 tests |
| `ai-engine/tests/phase36/conversion-proof.test.ts` | **NOUVEAU** — preuve de conversion persistée |
| `ai-engine/tests/groq-auth-and-rate-limit.test.ts` | 4 assertions déplacées du champ privé supprimé vers `telemetry()['tpmUsed']` *(modification délibérée d'un test existant, disclosed)* |

Total : **6 fichiers, +856 / −116**.

---

## 3. Tests exécutés — résultats

```
backend    npx tsc --noEmit   → exit 0
backend    npx jest           → Test Suites: 13 passed / Tests: 121 passed
ai-engine  npx tsc --noEmit   → exit 0
ai-engine  npx jest           → Test Suites:  9 passed / Tests:  83 passed
```

Suites ai-engine collectées : `groq-auth-and-rate-limit`, `groq-limiter-sliding-window`,
`health-readiness`, `phase36/conversion-proof`, `phase36/phase36-pipeline`,
`phase36/resilience`, `phase36/scheduler-progress`, `progress-delivery`,
`request-correlation`.

**Deux bugs trouvés par les nouveaux tests, puis corrigés** (les tests ont échoué d'abord) :

1. `TOKENS_PER_REQ = 3 500` appliqué comme **plancher** (`Math.max(estimated, 3 500)`)
   annulait silencieusement toute la correction de projection : `reserveFor(1600)` renvoyait
   3 500 au lieu de 2 800. Corrigé en **repli utilisé uniquement en l'absence d'estimation
   réelle**.
2. `phantomTokensAvoided` absent de `telemetry()`.

**Un test existant encodait un comportement faux** et a été corrigé volontairement.

---

## 4. Valeurs de quota retenues et justification

| Paramètre | Avant | Après | Justification |
|---|---|---|---|
| `TPM_LIMIT` | 7 000 | **7 200** | Réel 8 000 ; marge de 10 % pour la variance d'estimation. Jamais au-dessus du réel. |
| `RPM_LIMIT` | *(absent)* | **24** (`AI_RATE_LIMIT_RPM`) | Réel 30 ; marge 20 %. |
| `MIN_INTERVAL_MS` | 8 000 | **2 000** | 8 s ⇒ 7,5 req/min, 4× sous le plafond réel. 2 s reste prudent. |
| `OUTPUT_RESERVE` | 2 800 (max) | **1 200** (`AI_OUTPUT_TOKEN_RESERVE`) | Sortie réelle moyenne observée sur les chunks ; le max n'est plus supposé. |
| `TOKENS_PER_REQ` | plancher 3 500 | **repli** uniquement | Ne doit jamais écraser une estimation réelle. |
| `MAX_CONCURRENT` | 3 | **3 (inchangé)** | Aucune augmentation arbitraire. |
| Pacing phase 36 | 6 500 (double porte) | **0 = désactivé** | Fonctionnalité **préservée** et réactivable via `AI_PHASE36_PACING_TPM`. |
| Jitter | — | **750 ms** | Évite la synchronisation des retries. |

Les limites **apprises** depuis les en-têtes sont bornées par `Math.min(configurée, apprise)` :
une valeur apprise ne peut **jamais** dépasser la configuration.

**Gain attendu, honnêtement** : `⌊7 000/6 300⌋ = 1` appel/fenêtre → `⌊7 200/2 795⌋ = 2`,
**plus** la suppression de la seconde porte en série ⇒ roughly **2-4×** de débit.
**Une attente de ~60 s reste possible** quand une seule grosse consommation doit expirer :
c'est le comportement correct, pas un bug. Aucun test ne prétend le contraire.

---

## 5. Preuve qu'une petite conversion se termine et génère des fichiers valides

`ai-engine/tests/phase36/conversion-proof.test.ts` exécute le **vrai** `ConversionPipeline`
sur 8 fichiers Flutter, écrit les résultats sur disque, puis **relit depuis le disque** :

```
[PREUVE-CONVERSION] projet=proof-small-project fichiersSources=8
                    fichiersGeneres=28 lignes=835 octets=24361 dureeMs=257
  • package.json                — 24 lignes,  527 o
  • tsconfig.json               —  1 ligne,    94 o
  • app.json                    — 19 lignes,  386 o
  • babel.config.js             —  8 lignes,  143 o
  • app/(tabs)/_layout.tsx      —  4 lignes,  200 o
  • src/lib/api.ts              — 22 lignes,  608 o
  • src/lib/storage.ts          — 17 lignes,  508 o
  • src/hooks/useApi.ts         — 25 lignes,  752 o
  • src/components/ui/Button.tsx— 40 lignes, 1 681 o
  …
✓ le pipeline réel termine et écrit sur disque des fichiers non vides (679 ms)
```

Vérifications : chaque fichier existe sur disque, son contenu relu est **identique** à celui
produit, aucun fichier source n'est creux (`< 40 o` ou `< 3 lignes`), les `.json` sont
parseables, au moins un `.tsx` est produit.

> **Premier échec instructif** : la première version du test signalait 7 fichiers « creux ».
> Investigation : le seul concerné était `tsconfig.json`, 94 octets de JSON **minifié sur une
> ligne**. C'était mon critère qui était faux, pas le pipeline. Le test distingue désormais
> fichiers sources et fichiers de configuration.

**Limite assumée** : aucun appel Groq réel (pas de clé dans cet environnement) ; le pipeline
tourne sur son tier hors-ligne. Ce test prouve la **génération et la persistance**, pas la
qualité des sorties produites par le modèle.

---

## 6. Ce qui reste — configuration Render ou Groq requise

Ces points **ne peuvent pas** être corrigés par du code dans ce dépôt :

1. **Hibernation Render Free** — l'instance s'endort après 15 min sans trafic et le réveil
   peut être rejeté en 429. Remède : instance payante, ou keep-awake externe. **Décision
   utilisateur.** La doc Render est explicite : « Paid compute plans do not spin down. »
2. **Plafonds Groq plan Free** — 30 RPM / 1 000 RPD / 8 000 TPM / 200 000 TPD, appliqués
   **au niveau de l'organisation** (plusieurs clés ne multiplient pas le quota). Une
   conversion de 33 chunks reste proche du plancher ; le plan Developer (1 000 RPM /
   250-300 K TPM) lève la contrainte.
3. **Clé Groq non vérifiée** — aucun accès au secret depuis cet environnement. Le plan réel
   de la clé (Free vs Developer) **n'est pas confirmé** ; les valeurs ci-dessus supposent Free.
4. **Étape 3 non implémentée** — les correctifs watchdog/annulation (`CONVERTING_ABSOLUTE_MAX_MIN`,
   `cancel()` qui ne notifie pas l'AI Engine) sont **diagnostiqués mais pas encore corrigés**.
   Le timeout global de 120 min **n'a pas été augmenté**, conformément à la consigne.
5. **Aucune conversion réelle de bout en bout** n'a été exécutée.

---

## Contraintes respectées

- Aucune fonctionnalité supprimée ; le pacing phase 36 est **désactivé par défaut mais
  réactivable**, pas supprimé.
- Aucune protection de quota désactivée : les seuils restent **sous** les limites réelles.
- Rien n'a été remplacé par une simulation.
- Pas seulement des délais modifiés : la fenêtre fixe → glissante, le double comptage, le
  plancher de projection et l'absence de RPM sont des corrections structurelles.
- Contrats d'API et callbacks préservés (`release(tokensUsed, outcome)` garde sa signature,
  le 3ᵉ argument est optionnel).
- Concurrence **non** augmentée ; timeout global **non** augmenté.
