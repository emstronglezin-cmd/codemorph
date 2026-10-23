# Phase 50 — Représentation intermédiaire canonique

Analyse demandée sur `codemorph-result-5fc44d34.zip` (59 %, `local-imports` /
`typescript` / `routes` / `source-entities` en échec).

---

## ⚠️ Trois limites à lire avant tout

**1. Le ZIP `codemorph-result-5fc44d34.zip` est absent de ce système de fichiers.**

```
$ find / -iname "*5fc44d34*"
(aucun résultat)
$ find / -iname "codemorph-result*"
(aucun résultat)
```

Je n'ai donc **pas pu lire votre rapport ni comparer ma sortie à la vôtre**. Les causes
racines ci-dessous sont établies par **lecture du code du moteur**, pas par analyse de
votre archive. Chaque défaut cité est localisé par fichier et ligne, et reproduit par un
test — mais je ne peux pas affirmer que ce sont *exactement* ceux qui ont produit votre
ZIP.

**2. Aucun build natif, aucun appareil, aucun émulateur.** Les exports Metro ont été
exécutés (résultats ci-dessous). Aucun binaire natif, aucun rendu sur appareil.

**3. Le chemin hors ligne ne reproduit pas le chemin réel.** Le pipeline utilise ici un
`FakeAI`. Les défauts du chemin IA sont donc reproduits par des tests ciblés sur le code
responsable, pas par une conversion réelle via Groq.

---

## 1. Causes racines par famille d'erreurs

### Famille A — imports vers des fichiers inexistants

**Fichier : `ai-engine/src/core/dart-transpiler.ts`, `transpileImport()` (l. ~275-285).**

```ts
// AVANT
if (pkg.startsWith('../') || pkg.startsWith('./')) {
  const tsPath = pkg.replace('.dart', '');
  return `import * as ${toCamelCase(...)} from '${tsPath}';`;
}
```

Le **chemin Dart source est recopié tel quel** comme spécificateur d'import. Pour
`lib/screens/home_screen.dart` contenant `import '../widgets/task_tile.dart';`, le moteur
émettait `from '../widgets/task_tile'` — alors que le fichier généré vit à
`src/components/TaskTile.tsx`. **Aucune table de correspondance source → sortie n'existait
nulle part dans le moteur.** D'où les imports vers `widgets/task_tile`,
`services/task_service`, `models/task` que vous décrivez.

Le même bloc émettait `// TODO: verify import` et un `import * as` (namespace) alors que les
fichiers générés exportent des noms.

### Famille B — `bool` en sortie TypeScript

Le moteur contenait **trois mappings Dart→TypeScript indépendants** :

| Fichier | Symbole |
|---|---|
| `dart-transpiler.ts` | `TYPE_MAP` + `mapType()` |
| `code-planner.ts` | `dartTypeToTS()` (7 entrées, `List` → `unknown[]`) |
| `ir-generator.ts` | `mapDartType()` + `IRGenerator.DART_TO_TS` |

Et surtout : **aucune normalisation sur le chemin où l'IR est produit par le modèle d'IA.**
Le chemin statique (`buildStaticIR`) mappait ses types ; le chemin IA laissait passer
`bool`, `String`, `List<Task>` tels quels jusqu'aux générateurs.

**C'est l'explication du fossé jamais expliqué jusqu'ici** : les validations hors ligne
étaient vertes pendant que les conversions réelles étaient cassées — elles n'exercent pas le
même chemin.

Conséquence directe dans `code-planner.ts` :

```ts
// AVANT, generateLocalService()
const params = inputFields.map((f) => `${f.name}: ${f.type}`).join(', ');
```

`f.type` brut → `add(title: bool)` → **`typescript` FAIL**.

### Famille C — service qui n'expose pas le contrat appelé

**Fichier : `code-planner.ts:707`.**

```ts
// AVANT
const boolField = fields.find((f) => f.type === 'boolean' && f.name !== idName);
```

Comparaison au **nom TypeScript** `boolean`, alors que l'IR peut porter le **nom Dart**
`bool`. Quand l'IR venait du modèle d'IA, la comparaison ne matchait **jamais** :
`toggle()` et le compteur `isDoneCount` n'étaient **pas générés**, alors que les écrans les
appelaient. Le service n'exposait que `getAll()` et `add()` — exactement votre symptôme.

Note honnête : `code-planner.ts:1189` compare, lui, à `f.type === 'bool'` (nom Dart) dans le
générateur inverse. **Le même champ d'IR était donc comparé aux deux nomenclatures selon
l'endroit du fichier.**

### Famille D — rien ne signalait les trous

Un import non résoluble restait tel quel dans la sortie. Aucune vérification ne confrontait
les méthodes **appelées** par les écrans aux méthodes **définies** par les services. Un
projet pouvait donc être livré avec des imports cassés et des appels à des méthodes
inexistantes, sans qu'aucun contrôle ne le dise.

---

## 2. Fichiers du moteur modifiés

| Fichier | Changement |
|---|---|
| **`src/core/canonical-ir.ts`** | **NOUVEAU.** Représentation canonique : `mapDartTypeToTS` (seul mapping, idempotent), prédicats `isBooleanType`/`isStringType`/`isNumericType`, `buildSymbolTable` construit sur les fichiers **réellement générés**, `relativeSpecifier`, `resolveRelativeTarget` (casse exacte + repli `/index`), `rewriteLocalImports`, `normalizeIrTypes`. |
| `src/core/code-planner.ts` | `normalizeIrTypes(ir)` à l'entrée de `plan()` ; `isBooleanType(f.type)` au lieu de `=== 'boolean'` ; types de paramètres mappés ; `dartTypeToTS` délègue au canonique. |
| `src/core/plan-normalizer.ts` | Nouvelle étape `resolveCanonicalImports()` : tout import local est résolu contre la table de symboles ; `rewrittenImports` et `unresolvedImports` dans le rapport. |
| `src/core/dart-transpiler.ts` | `mapType` délègue au canonique ; imports relatifs en import nommé ; plus de `// TODO: verify import`. Tables locales mortes supprimées (`mapType`, `toCamelCase`, `findComma`). |
| `src/core/ir-generator.ts` | `mapDartType` délègue au canonique ; `DART_TO_TS` local supprimé. |
| `src/core/project-integrity-validator.ts` | Deux contrôles nouveaux : `checkServiceContract()` et `checkUnconvertedSymbols()`. |
| `src/core/static-validator.ts` | Nouveau contrôle **critique** `service-contract`. |
| `src/core/fidelity-engine.ts` | `service-contract` ajouté à `CRITICAL_CHECKS`. |
| `src/models/ir.types.ts` | Codes `missing-service-method`, `service-arity-mismatch`, `unconverted-symbol` ; id de contrôle `service-contract`. |

**Aucune exception propre à Task.** Tout passe par la table de symboles construite sur la
sortie réelle ; les tests génériques utilisent `Note`/`NoteService` pour le prouver.

---

## 3. Validations bloquantes

Le contrôle `service-contract` est déclaré **critique**. Un échec critique empêche
`fullyValidated`, ce qui est vérifié dans la sortie réelle du pipeline :

```
DIAG50_FAILED_CRITICAL=["service-contract"]
DIAG50_REASON="Critical checks FAILED: service-contract — conversion not fully validated"
DIAG50_SCORE=59 PARTIAL fullyValidated=false
```

Cette mesure a été prise **pendant** le développement, quand le nouveau contrôle détectait
un défaut réel (voir §5). Après correction de ce défaut :

```
DIAG50_FAILED_CRITICAL=(aucun)
DIAG50_NOTRUN_CRITICAL=["tests","build"]
DIAG50_SCORE=84 GOOD fullyValidated=false
```

`fullyValidated` reste `false` — honnêtement, parce que `tests` et `build` ne sont pas
exécutés dans l'harnais.

### Couverture des 8 validations demandées

| # | Validation demandée | État |
|---|---|---|
| 1 | Résoudre les imports locaux + casse | **FAIT** — `rewriteLocalImports` + `resolveRelativeTarget` |
| 2 | Chaque méthode appelée existe, signature compatible | **PARTIEL** — existence vérifiée (`checkServiceContract`) ; **l'arité et les types de paramètres ne sont pas encore comparés** |
| 3 | Cohérence des types entre modèles, composants, services | **PARTIEL** — garanti en amont par `normalizeIrTypes` + mapping unique ; **pas de contrôle a posteriori** qui confronterait les propriétés |
| 4 | Toutes les routes ciblées existent | **DÉJÀ PRÉSENT** — `checkRoutes`, `checkLayoutScreens`, `checkEntryRoute` |
| 5 | Entités source préservées ou signalées | **FAIT** — `checkUnconvertedSymbols` + `NOT_CONVERTED` explicite |
| 6 | Exécuter TypeScript | **FAIT** dans le projet livré ; **NOT_RUN** dans l'harnais du pipeline |
| 7 | Installer les dépendances + build/export Expo | **FAIT à la main** sur le livrable ; **NOT_RUN** dans le pipeline |
| 8 | Tests automatisés + régression | **FAIT** — 21 tests ajoutés |

Les points 2 et 3 sont **incomplets** et je ne les présente pas comme terminés.

---

## 4. Tests de régression ajoutés

### `tests/regression/canonical-ir.test.ts` — 17 tests, **génériques**

Aucun nom `Task` ni `TaskService` : les fixtures utilisent `Note`, `NoteService`,
`note_card`. Couvre D1 (mapping), D2 (prédicats), D3 (chemins et casse), D4 (import non
résoluble signalé), D5 (contrat service↔écran).

### `tests/regression/ir-type-normalization.test.ts` — 4 tests, **bout en bout**

Construit un IR **volontairement typé en Dart** (`bool`, `String`, `int`, `List<Note>`) —
le cas du chemin IA — et vérifie que le service généré expose `getAll`, `add`, `toggle`,
`isDoneCount`, et qu'aucun `: bool` / `: String` / `: int` ne subsiste.

### Preuve que ces tests ne sont pas vacuous

J'ai réinjecté le bug (comparaison `=== 'boolean'`, type brut non mappé, normalisation
désactivée) **en gardant `tsc` à 0** pour que le signal soit valide :

```
TSC=0
✕ génère toggle() et le compteur même quand l'IR porte le type Dart bool
Tests: 1 failed, 24 passed, 25 total
```

Puis restauration :

```
TSC=0
Tests: 25 passed, 25 total
```

**Observation importante** : avec le bug réinjecté, les 4 tests de la régression Phase 49
(R1–R4) **passaient quand même** — leur fixture est déjà typé en TypeScript. Le nouveau
test couvre donc un cas que l'ancien ne voyait pas.

### Un faux positif de mon propre résolveur, trouvé et corrigé

`src/components/ui/*.tsx` importent `'../../theme'`. Mon résolveur ne testait pas le repli
vers `index`, donc il déclarait ces imports non résolus et faisait échouer le contrôle
critique (score 59 %). C'était **mon** bug, pas un défaut du projet. Corrigé : repli
`${candidate}/index` ajouté, mesure repassée à 84 % sans échec critique.

---

## 5. Commandes réellement exécutées et résultats

### Moteur

```
$ cd ai-engine && npx tsc --noEmit
AI_TSC=0                                    → PASS

$ npx jest tests/regression
Tests: 25 passed, 25 total                  → PASS

$ npx jest --silent
Test Suites: 19 passed, 19 total
Tests:       161 passed, 161 total            → PASS   (17 suites / 140 avant Phase 50)

$ cd ../backend && npx tsc --noEmit && npx jest --silent
BE_TSC=0
Test Suites: 15 passed, 15 total
Tests:       147 passed, 147 total            → PASS
```

Les deux suites ont été **relancées après le dernier correctif** (repli `/index` du
résolveur), pas sur un état intermédiaire.

### Projet livré (`examples/tasklist-rn`)

```
$ npx tsc --noEmit
TSC=0                                       → PASS

$ npx jest
Test Suites: 3 passed, 3 total
Tests:       20 passed, 20 total            → PASS

$ npx expo export --platform android
Android Bundled 17358ms ... (902 modules)   → exit 0  PASS
$ npx expo export --platform ios
iOS Bundled 16933ms ... (905 modules)       → exit 0  PASS
$ npx expo export --platform web
λ Bundled 31286ms ... (668 modules)         → exit 0  PASS
   → index.html, add-task.html, _sitemap.html, +not-found.html
```

### Tableau PASS / FAIL / NOT_RUN

| Contrôle | Résultat |
|---|---|
| `tsc --noEmit` (moteur) | **PASS** — exit 0 |
| `tsc --noEmit` (projet livré) | **PASS** — exit 0 |
| Tests moteur (`tests/regression`) | **PASS** — 25/25 |
| Tests projet livré (Jest) | **PASS** — 3 suites / 20 tests |
| Export Metro Android | **PASS** — exit 0, 902 modules |
| Export Metro iOS | **PASS** — exit 0, 905 modules |
| Export Metro Web | **PASS** — exit 0, 668 modules |
| Résolution des imports locaux | **PASS** — 0 `NOT_CONVERTED` |
| Contrat service ↔ écran | **PASS** — `failedCritical` vide |
| Contrôle `tests` du pipeline | **NOT_RUN** — pas de runner dans l'harnais |
| Contrôle `build` du pipeline | **NOT_RUN** — pas de bundler dans l'harnais |
| **Binaire natif** | **NOT_RUN** — pas d'Android SDK ni Xcode |
| **Rendu sur appareil / émulateur** | **NOT_RUN** — aucun appareil |
| Lint | **NOT_RUN** — aucun ESLint configuré |

---

## 6. Limites restantes

1. **La génération des écrans échoue toujours hors ligne.** Sortie réelle du pipeline sur le
   projet témoin :
   ```
   [FileGenerator] ❌ All 4 attempts failed for "HomeScreen" — using fallback
   [FileGenerator] ❌ All 4 attempts failed for "AddTaskScreen" — using fallback
   [COHERENCE] ❌ CRITICAL: IR has 2 screens but 0 were generated.
   ```
   **Les écrans du livrable sont écrits par moi, pas générés par le moteur.** C'est le
   dernier maillon qui impose du travail manuel.

2. **`service-contract` vérifie l'existence des méthodes, pas leur signature.** Le code
   `service-arity-mismatch` est déclaré mais **aucun contrôle ne l'émet encore**.

3. **Pas de contrôle a posteriori de cohérence des propriétés** entre modèles, composants et
   services. La cohérence est garantie en amont par le mapping unique, pas vérifiée en aval.

4. **`RN_INDEX_TEMPLATE` émet toujours une redirection** plutôt qu'un écran complet
   (hérité de la Phase 49, non corrigé à la racine).

5. **Aucun test sur appareil.** Le fonctionnement réel de l'application n'est pas démontré.

6. **Votre ZIP n'a pas pu être comparé.** Si vous pouvez me fournir l'archive, je vérifierai
   que les défauts observés correspondent bien aux causes corrigées ici.
