# Phase 51 — Fiabilité de livraison

Analyse demandée sur le pipeline du 30 octobre 2026 : fidélité 91 %, `TaskTile.tsx(95,1)
error TS1005`, `Delivery Check: NEEDS_REPAIR`, 1 blocker, `Ready For Production: YES`,
Round-trip 0 %, ZIP 30 fichiers vs callback 34.

---

## ⚠️ Limites à lire avant tout

**1. Je n'ai pas votre archive.** `find / -iname "*5fc44d34*"` → aucun résultat. Les causes
racines ci-dessous viennent de la **lecture du code** et de **reproductions mesurées sur le
pipeline réel**, pas de l'analyse de votre ZIP. Là où je n'ai pas pu reproduire exactement
votre exécution, je le dis.

**2. Le chemin réel (Groq) n'est pas exercé ici.** Le pipeline tourne avec un `FakeAI`. Les
défauts sont donc reproduits par des tests ciblés sur le code responsable.

**3. Aucun binaire natif, aucun appareil, aucun émulateur.**

---

## 1. Causes racines

### A. `Ready For Production: YES` malgré NEEDS_REPAIR + blocker + erreur TS

**Fichier : `src/core/conversion-report.ts`, `buildConversionReport()`.**

```ts
// AVANT
const readyForProduction =
  overallFidelity >= 80 &&
  compilStatus !== 'FAIL' &&
  (compilationResult?.errors.filter((e) => e.severity === 'error').length ?? 0) === 0;
```

Trois défauts distincts :

1. **`compilStatus !== 'FAIL'` laisse passer `SKIPPED`.** Une compilation jamais exécutée
   satisfaisait la condition.
2. **La règle ne consultait ni le delivery check, ni les blockers, ni les tests
   fonctionnels.** `buildConversionReport` ne recevait même pas ces données.
3. **`compilationResult` vient de l'étape de build**, souvent absente. Les erreurs
   TypeScript trouvées par le **validateur statique** (`staticResult.tsCompilation.errors`)
   alimentent le blocker du delivery check mais **n'étaient pas vues** par la règle de
   production. D'où la contradiction : le delivery check bloquait, le statut disait YES.

Et, ligne voisine :

```ts
// AVANT
compilation: compilStatus === 'PASS' || compilStatus === 'SKIPPED',
```

**Une compilation ignorée était comptabilisée comme réussie.**

**Reproduction mesurée** (ancienne règle réinjectée, `tsc` à 0) :

```
{"files":29,"ready":true,"compilation":true,"compilStatus":"SKIPPED","overall":90,
 "roundTrip":0,"blockers":[]}
```

C'est exactement votre contradiction.

### B. `TaskTile.tsx(95,1): error TS1005` — aucun contrôle syntaxique

Les générateurs assemblent du code par concaténation de gabarits. Deux familles de défauts
ont déjà été observées dans ce moteur :

- une **contre-oblique dans un commentaire injecté** dans un gabarit littéral ferme le
  gabarit prématurément ;
- une **liste de propriétés concaténée** produit une virgule en trop (`title,,` → TS1136).

**Aucun contrôle ne relisait un fichier généré avant l'empaquetage.** Et la compilation
complète du pipeline est souvent `SKIPPED` (dépendances du projet cible non installées),
donc l'erreur n'apparaissait que chez le destinataire.

Je n'ai **pas pu reproduire votre fichier précis** (archive absente). J'ai donc traité la
classe du défaut : un contrôle syntaxique systématique, indépendant de toute installation.

### C. Round-trip 0 %

```ts
// AVANT
const roundTripScore = roundTripResult?.averageScore ?? 0;
```

**« Jamais exécuté » et « exécuté à 0 % » étaient indistinguables.** Vérifié dans le code :
`runRoundTripFidelity()` existe dans `round-trip-fidelity.ts`, mais **le pipeline ne
l'appelle jamais** — le module n'est référencé que par `conversion-report.ts`, pour le type.
Le `0 %` affiché n'était donc **pas une mesure**.

### D. ZIP 30 fichiers vs callback 34

Le ZIP est construit **avant** l'injection des rapports internes ; ces rapports sont ensuite
ajoutés à la liste retournée au client. **Reproduit et mesuré** :

```
zipResult.fileCount = 29      res.files.length = 33
différence = _codemorph-reports/source-analysis.json
           + _codemorph-reports/conversion-report.json
           + _codemorph-reports/conversion-report.md
           + _codemorph-reports/fidelity-report.html
```

Deux nombres issus de deux étapes différentes, sans qu'aucun des deux ne le dise.

### E. Deux faux négatifs dans les tests fonctionnels (trouvés en mesurant)

En exécutant le pipeline pour obtenir les statuts réels des 12 tests :

```
PASS :: App bootstrap (entry point) :: Entry point found: src/theme/index.ts   ← FAUX
FAIL :: Screens (UI components)     :: No screen files found                   ← FAUX
```

- **Le point d'entrée détecté était `src/theme/index.ts`**, un barrel de thème. Le motif
  `/(app|index|_layout)\.(tsx?|jsx?)$/` suivi de `files.find()` matche n'importe quel
  `index.ts`. Le test **passait sur une preuve fausse**.
- **Les écrans Expo Router étaient déclarés absents** : seuls `screens/` et `pages/` étaient
  reconnus, et le motif d'exclusion `_layout|index\.(tsx?|jsx?)$` écartait explicitement
  `index.tsx` — donc aussi l'écran d'accueil. Tout projet Expo Router échouait à tort.

---

## 2. Fichiers du moteur modifiés

| Fichier | Changement |
|---|---|
| **`src/core/syntax-validator.ts`** | **NOUVEAU.** `checkSyntax()` / `checkGeneratedSyntax()` via le parseur TypeScript. Ne résout aucun import → s'exécute même quand `tsc` est `SKIPPED`. |
| `src/core/conversion-report.ts` | `evaluateProductionReadiness()` (règle stricte + raisons explicites) ; `productionBlockers` ; `compilation` n'est plus vrai si SKIPPED ; `RoundTripStatus` + `deriveRoundTripStatus()` ; `filesGenerated` = livrables, `reportFiles` séparé. |
| `src/core/pipeline.ts` | Tests fonctionnels calculés **avant** le rapport ; `deliveryCheck` et `testResults` passés au rapport ; journal de réconciliation des comptages. |
| `src/core/static-validator.ts` | Nouveau contrôle **critique** `syntax`. |
| `src/core/fidelity-engine.ts` | `syntax` ajouté à `CRITICAL_CHECKS`. |
| `src/core/functional-test-runner.ts` | `findEntryPoint()` (candidats classés par spécificité) et `findScreenFiles()` (Expo Router + `screens/`) exportés ; `hasFile` devenu mort supprimé. |
| `src/core/canonical-ir.ts` | `splitDeliverableFiles()`, `reconcileFileCounts()`, `INTERNAL_REPORT_PREFIX`. |
| `src/models/ir.types.ts` | Id de contrôle `syntax`. |

---

## 3. Règle de production implémentée

`evaluateProductionReadiness()` bloque si **une seule** de ces conditions est vraie :

| Règle demandée | Implémentation | Test |
|---|---|---|
| Erreur TypeScript | erreurs du build **+** du contrôle statique | ✓ |
| Blocker actif | `deliveryCheck.blockers` | ✓ |
| Build échoué | `compilationStatus === 'FAIL'` | ✓ |
| Test fonctionnel critique échoué | `CRITICAL_FUNCTIONAL_FEATURES` (7 features) | ✓ |
| SKIPPED ≠ réussi | `compilationStatus === 'SKIPPED'` bloque | ✓ |
| N/A ≠ PASS | critique `NOT_RUN` bloque ; `NOT_TESTABLE` ne bloque pas | ✓ |

Le score ≥ 80 reste une condition **nécessaire, jamais suffisante**.

**Mesure après correctif** (même pipeline, mêmes données) :

```
ready = false   compilation = false   compilStatus = SKIPPED
  BLOCKER: Compilation non exécutée (SKIPPED) — une compilation ignorée ne peut
           pas être comptée comme réussie
  BLOCKER: Contrôle critique non exécuté : tests
  BLOCKER: Contrôle critique non exécuté : build
```

---

## 4. Tests fonctionnels — les 12, mesurés

**Avant correctif** (exécution réelle du pipeline) : 5 PASS, 5 PARTIAL, **1 FAIL**, 1 NOT_TESTABLE.

**Après correctif** : **6 PASS, 5 PARTIAL, 0 FAIL, 1 NOT_TESTABLE.**

| # | Feature | Avant | Après |
|---|---|---|---|
| 1 | App bootstrap | PASS *(preuve fausse : `src/theme/index.ts`)* | **PASS** (`app/_layout.tsx`) |
| 2 | Navigation | PARTIAL — nav score 78 % | PARTIAL |
| 3 | Authentication | PARTIAL — 2/3 mécanismes (`logout=false`) | PARTIAL |
| 4 | API / Network layer | PARTIAL — URL réelle non détectée | PARTIAL |
| 5 | Data models | PASS — 3/3, 100 % | PASS |
| 6 | State management | PARTIAL — score N/A | PARTIAL |
| 7 | Services | PASS — 1/1, 100 % | PASS |
| 8 | **Screens** | **FAIL — « No screen files found »** | **PASS — 3/3 écrans** |
| 9 | TypeScript compilation | PASS *(statique, `tsc` non exécuté)* | PASS |
| 10 | Configuration | PARTIAL — 1 placeholder, URL non préservée | PARTIAL |
| 11 | External services | NOT_TESTABLE | NOT_TESTABLE |
| 12 | No source residuals | PASS | PASS |

**Les 5 PARTIAL restants sont des limites réelles du projet généré, pas des défauts de
détection.** Je ne les ai pas « corrigés » pour améliorer le comptage.

---

## 5. Round-trip — les cinq états

`deriveRoundTripStatus()` distingue : `NOT_IMPLEMENTED`, `NOT_APPLICABLE`, `NOT_RUN`,
`FAIL`, `PASS` (seuil 70).

**État réel du moteur : `NOT_RUN`** — `runRoundTripFidelity()` existe mais le pipeline ne
l'appelle pas. Un score de 0 exécuté est `FAIL`, jamais `PASS`.

---

## 6. Réconciliation des comptages

```
[PIPELINE] PHASE 51 — Réconciliation fichiers :
  ZIP 29 fichier(s) == livrables 29 (+4 rapport(s) interne(s))
```

`reconcileFileCounts()` compare le compte du ZIP au compte des livrables et **journalise
explicitement toute divergence**. Rapport, ZIP et callback dérivent désormais de
`splitDeliverableFiles()`.

---

## 7. Commandes réellement exécutées

```
$ cd ai-engine && npx tsc --noEmit
TSC=0                                                    → PASS

$ npx jest tests/regression
Tests: 61 passed, 61 total                               → PASS

$ npx jest --silent
Test Suites: 20 passed, 20 total
Tests:       197 passed, 197 total                       → PASS   (19/161 avant)

$ cd ../shared && npm run build
BUILD_EXIT=0                                             → PASS

$ cd ../backend && npx tsc --noEmit ; echo $?
BE_TSC_EXIT=0                                            → PASS
$ npx jest --silent
Test Suites: 15 passed, 15 total
Tests:       147 passed, 147 total                       → PASS

# Projet livré (examples/tasklist-rn)
$ npx tsc --noEmit                → TSC=0                → PASS
$ npx jest                        → 3 suites / 20 tests  → PASS
$ npx expo export --platform android → 0                 → PASS
$ npx expo export --platform ios     → 0                 → PASS
$ npx expo export --platform web     → 0                 → PASS
```

### Contrôle syntaxique dans le pipeline réel

```
✅ Syntaxe : 23 fichier(s) TS/TSX analysé(s), 0 erreur
```

### Tableau PASS / FAIL / NOT_RUN

| Contrôle | Résultat |
|---|---|
| Syntaxe des fichiers générés | **PASS** — 23 fichiers, 0 erreur |
| TypeScript (moteur) | **PASS** — exit 0 |
| TypeScript (projet livré) | **PASS** — exit 0 |
| Tests moteur | **PASS** — 20 suites / 197 |
| Tests backend | **PASS** — 15 suites / 147 |
| Tests projet livré | **PASS** — 3 suites / 20 |
| Export Metro android/ios/web | **PASS** — exit 0 ×3 |
| Réconciliation des comptages | **PASS** — 29 == 29 (+4 rapports) |
| Delivery check | **PASS** — READY, 0 blocker |
| Contrôle `tests` du pipeline | **NOT_RUN** — pas de runner dans l'harnais |
| Contrôle `build` du pipeline | **NOT_RUN** — pas de bundler dans l'harnais |
| **Round-trip** | **NOT_RUN** — implémenté, jamais appelé par le pipeline |
| **Binaire natif** | **NOT_RUN** — pas d'Android SDK ni Xcode |
| **Appareil / émulateur** | **NOT_RUN** — aucun appareil |
| Lint | **NOT_RUN** — aucun ESLint configuré |

### Non-vacuité vérifiée

Ancienne règle de production réinjectée **avec `tsc` à 0** :

```
ready=true  compilation=true  compilStatus=SKIPPED  blockers=[]
```

Restaurée :

```
ready=false compilation=false blockers=[3 raisons]
```

Un test d'attente erroné de ma part (fichier vide) a aussi été détecté et corrigé — le code
était juste, mon attente non.

---

## 8. Statut de production recalculé

| | Valeur |
|---|---|
| Fidélité | 84 % / GOOD *(non modifiée artificiellement)* |
| Compilation | **SKIPPED** — comptée comme **non réussie** |
| `fullyValidated` | **false** |
| **Ready For Production** | **NO** |
| Blockers | Compilation SKIPPED ; contrôles critiques `tests` et `build` non exécutés |

**Le score n'a pas été touché.** Le statut est passé de YES à NO parce que les résultats
réels ne le justifiaient pas.

---

## 9. Limites restantes

1. **La génération des écrans échoue toujours hors ligne** : `[FileGenerator] ❌ All 4
   attempts failed for "HomeScreen" — using fallback`, `[COHERENCE] ❌ CRITICAL: IR has 2
   screens but 0 were generated`. Les écrans du livrable sont écrits par moi.
2. **`service-arity-mismatch` est déclaré mais aucun contrôle ne l'émet** : l'existence des
   méthodes est vérifiée, pas leur signature.
3. **Le round-trip n'est pas câblé.** Le statut est honnête (`NOT_RUN`), mais la mesure
   n'existe toujours pas.
4. **Le contrôle syntaxique est purement syntaxique.** Il ne remplace pas `tsc` : erreurs de
   types et modules manquants restent hors de sa portée.
5. **`tests` et `build` restent `NOT_RUN` dans le pipeline.** Tant qu'ils ne seront pas
   exécutés, aucune conversion ne pourra être déclarée prête pour la production — c'est
   voulu, mais cela signifie que **le pipeline ne peut actuellement jamais livrer un YES**.
6. **Votre archive n'a pas pu être comparée.**
