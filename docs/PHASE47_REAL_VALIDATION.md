# PHASE 47 — Validation réellement exécutée, intégrée au pipeline

**Commit `edfff06`** (`304adad..edfff06` sur `main`, confirmé via l'API GitHub). 5 fichiers.
Aucun validateur parallèle créé : le mécanisme existant a été réparé.

---

## 1. Cause localisée (pas supposée)

`ai-engine/src/core/fidelity-engine.ts:550` :

```ts
if (overallFidelityScore >= 85) {
  verdict = 'EXCELLENT';
```

Le verdict ne dépendait **que** de `overallFidelityScore`, calculé sur la **seule couverture
des éléments source** (écrans, modèles, services présents ou manquants). Et la signature de
`computeFidelityReport` ne contenait **aucun** résultat de validation :

```ts
{ jobId, sourceCode, generatedFiles, sourceFramework, targetFramework }
```

Conséquence : imports cassés, routes fausses, dépendances manquantes, erreurs de typage et
build inexistant **n'influençaient jamais le verdict**. Une couverture de 100 % suffisait à
afficher EXCELLENT.

Le **« 0 ms »** avait une cause distincte : aucun champ de durée de validation n'était émis.
Le rapport utilisateur (`conversion-report.ts`) ne contenait pas non plus de champ de durée.

Site réellement utilisé pour le rapport affiché : `pipeline.ts:1179`, `fidelityEngineReport`.

---

## 2. Résultats par contrôle (PASS / FAIL / NOT_RUN)

`runStaticValidation()` (mécanisme existant) retourne désormais `checks[]`, en **réutilisant**
les détecteurs déjà présents et `validateProjectIntegrity()` — aucune logique dupliquée :

| Contrôle | Ce qu'il vérifie | Exécution réelle |
|---|---|---|
| `local-imports` | imports locaux résolus contre les chemins produits | oui |
| `dependencies` | dépendances importées présentes dans le manifeste | oui |
| `typescript` | `tsc --noEmit` sur les fichiers générés | oui, quand tsc est présent |
| `config-entrypoint` | manifeste, tsconfig, config Expo, point d'entrée | oui |
| `routes` | routes référencées vs écrans présents | oui |
| `source-imports` | imports du langage source résiduels | oui |
| `empty-files` | fichiers sources vides | oui |
| `tests` | tests du projet généré | **NOT_RUN** (aucun runner) |
| `build` | build / export du projet | **NOT_RUN** (dépendances non installées) |

Chaque contrôle porte `status`, `durationMs`, `errors`, `warnings`, `files` et, pour NOT_RUN,
`notRunReason`. `validationDurationMs` est la durée totale réellement mesurée.

**Une vérification non exécutée n'est jamais une réussite** : elle vaut `NOT_RUN`.

---

## 3. Score recalculé, sans 100 % automatique

`FidelityScoreBreakdown` — chaque composant est **mesuré** ou vaut **`null`** (non mesuré) :

couverture source · cohérence structurelle · préservation fonctionnelle ·
validation statique · tests exécutés · compilation.

Un composant non mesuré **n'est jamais compté comme 100**. `preservationFonctionnelle` est
`null` : aucune mesure automatisée n'existe, et rien ne la simule.

Règles de plafonnement (le score n'est **jamais augmenté** par ce mécanisme) :

- contrôle critique en **FAIL** → score borné à **59**, verdict au plus **PARTIAL**
- contrôle critique en **NOT_RUN** → score borné à **84**, verdict au plus **GOOD**
- contrôle **absent** du rapport → traité comme non exécuté
- `fullyValidated = true` **uniquement** si aucun critique n'est FAIL ni NOT_RUN
- contrôles critiques : `local-imports`, `dependencies`, `typescript`,
  `config-entrypoint`, `routes`, `tests`, `build`

Comme `tests` et `build` ne sont pas exécutés dans cet environnement, **aucune conversion ne
peut plus être déclarée entièrement validée ici** — c'est le comportement demandé, pas un bug.

---

## 4. Bug trouvé par les tests

`typeChecksApply` testait `/\.(ts|tsx)$/` sur la **concaténation** des chemins : l'ancre `$`
ne voyait que le dernier fichier, donc dès que `package.json` fermait la liste, tsc était
déclaré inapplicable et le contrôle retombait en `NOT_RUN` partout. Corrigé en test par
fichier. Vérifié : `validation statique 100%, compilation 100%` sur le projet sain.

---

## 5. Tests et résultats réels

`ai-engine/tests/phase47/real-validation.test.ts` — 6 tests. **Deux ont échoué à la première
exécution** et ont révélé deux failles réelles de mon implémentation : `build` n'était pas
critique, et l'**absence** de validation était comptée comme validée. Corrigées, puis vertes.

| Propriété prouvée | Test |
|---|---|
| import local manquant → pas EXCELLENT, pas GOOD, score ≤ 59, `fullyValidated=false` | ✅ |
| erreur de typage → tsc jamais PASS, `fullyValidated=false` | ✅ |
| validation non exécutée → jamais EXCELLENT, score ≤ 84, `testsExecuted=null` | ✅ |
| build en échec → pas EXCELLENT, `fullyValidated=false` | ✅ |
| aucune validation fournie → `fullyValidated=false`, `compilationSucceeded=null` | ✅ |
| projet sain → durée réelle mesurée (2 413 ms) | ✅ |

Commandes et sorties :

```
ai-engine  npx tsc --noEmit          → exit 0
ai-engine  npx jest --silent         → Test Suites: 14 passed, Tests: 134 passed
backend    npx tsc --noEmit          → exit 0
backend    npx jest --silent         → Test Suites: 15 passed, Tests: 147 passed
```

Rapport JSON et rapport utilisateur concordent : tous deux lisent le même
`fidelityEngineReport` produit en `pipeline.ts:1179`. Sortie réelle de l'audit :

```
[PHASE 29] Overall Fidelity Score: 0% (FAILED)
[PHASE 29] Entièrement validé : NON
[PHASE 29] ⏭️  Contrôles critiques NON EXÉCUTÉS : tests, build
[PHASE 29] Décomposition : couverture source 0%, cohérence structurelle 100%,
           préservation fonctionnelle non mesuré, validation statique 100%,
           tests exécutés non mesuré, compilation 100%
```

---

## 6. Livré / non livré

**Livré :** cause localisée et réparée ; contrôles PASS/FAIL/NOT_RUN avec durée ; score
décomposé sans défaut optimiste ; verdict borné ; `fullyValidated` distinct du verdict ;
durée de validation exposée ; tests de non-régression exécutés ; JSON et rapport utilisateur
concordants.

**Non livré (explicite) :** les tests du projet généré et le build/export ne sont **pas**
exécutés — ils restent `NOT_RUN`, ce qui interdit `fullyValidated`. Les rendre réels exige
`npm install` sur le projet généré (réseau + temps) et un runner de test dans le gabarit.
La préservation fonctionnelle n'a aucune mesure automatisée : elle est `null`, pas 100.
Les types de `react-native`/`expo` restent non vérifiables sans leurs dépendances (limite
déclarée en Phase 46).

**Rappel :** le token GitHub collé dans cette conversation doit être **révoqué et réémis**.
