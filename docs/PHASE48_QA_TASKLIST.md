# PHASE 48 — QA bout-en-bout sur la fixture « liste de tâches »

**Commit `b0763ca`** (message d'origine erroné, corrigé par amend). 9 fichiers, +951/−35.

Méthode : conversion exécutée avec le **vrai** `ConversionPipeline().run()` sur une fixture
Flutter réelle (écran principal, écran d'ajout, modèle `Task`, `TaskService`, `TaskTile`),
puis inspection du code **effectivement produit** — pas du rapport.

---

## 1. Défauts détectés avant correction

Le projet généré comptait 32 fichiers et **aucune entité de la source** :

| Attendu | Observé |
|---|---|
| modèle `Task` | absent — aucun `interface Task` |
| `TaskService` | absent |
| composant `TaskTile` | absent |
| écrans `home` / `addtask` | remplacés par `app/screens.tsx`, `app/widgets.tsx` |

Et pourtant **tous** les contrôles passaient :

```
local-imports: PASS   dependencies: PASS   typescript: PASS [2942ms]
config-entrypoint: PASS   routes: PASS   empty-files: PASS
intégrité : PASS — erreurs 0
```

Autres défauts observés :

- `app/(tabs)/_layout.tsx` déclarait `<Screen name="widgetsscreen" />` et
  `<Screen name="screensscreen" />` — **aucun fichier correspondant**.
- `app/index.tsx` était une simple redirection, pas l'écran principal.
- Aucune trace de validation dans le rapport : fidélité 58 %, verdict non exposé.

---

## 2. Causes racines (4 distinctes)

**R1 — GÉNÉRATION.** `ir-generator.ts:347`, `buildStaticIR` renvoyait
`uiGraph`, `backendGraph` et `dataLayer` **vidés en dur**. Hors palier transpile, toute la
structure métier de la source était jetée ; le planificateur n'avait plus qu'à émettre un
gabarit générique.

**R2 — GÉNÉRATION.** Les champs d'un modèle étaient codés en dur :
`fields: [{ name: 'id', ... }]`. Cause directe des « modèles incompatibles entre services et
composants » — chaque consommateur réinventait les propriétés manquantes.

**R3 — ANALYSE.** `fidelity-engine` ne reconnaissait un modèle que si son nom finissait par
`Model|Dto|Entity|Response`, et un composant que par `Widget|Card`. `class Task` et
`class TaskTile extends StatelessWidget` — le nommage Flutter ordinaire — étaient invisibles.
La liste d'entités source était donc **vide**, et tout contrôle s'y appuyant passait à tort.

**R4 — VALIDATEUR.** Aucun contrôle ne vérifiait la survie des entités source. Et
`checkRoutes` ne couvrait que `router.push('/x')` : les `<Stack.Screen name="…">` d'un
`_layout` n'étaient jamais confrontés aux fichiers existants.

---

## 3. Fichiers du moteur modifiés

| Fichier | Correctif |
|---|---|
| `ir-generator.ts` | extracteurs déterministes factorisés dans `buildDeterministicGraphs`, réutilisés par `buildStaticIR` ; champs Dart réellement analysés (`final`/typés, `List<>`/`Map<>`, nullabilité) et mappés en TS |
| `fidelity-engine.ts` | détection **structurelle** des composants (`extends Stateless/StatefulWidget`) et des modèles (champs, absence de `build()`), indépendante du nom ; `summarizeValidation` = règle unique de qualification |
| `static-validator.ts` | nouveau contrôle critique `source-entities` ; une liste d'entités vide vaut **NOT_RUN**, jamais PASS |
| `project-integrity-validator.ts` | `checkLayoutScreens` : chaque `<Stack.Screen name="X">` doit correspondre à un fichier du même répertoire |
| `plan-normalizer.ts` | `pruneEmptyRouteGroups` (groupe sans écran supprimé) + `reconcileRootLayout` (écrans sans cible retirés du layout racine) |
| `pipeline.ts` | verdict plafonné, contrôles et durée réelle exposés ; section validation dans le JSON du ZIP et le Markdown |
| `conversion-report.ts` | `ReportValidationSection` + `formatValidationSection` |
| `models/ir.types.ts` | `ValidationCheckId` `source-entities`, `SourceEntities`, `FidelityValidationSummary`, code `missing-layout-screen` |

---

## 4. Bugs trouvés par les tests pendant le travail

- `_(tabs\/)?_layout` **exigeait `__layout`** : groupe optionnel mal placé, le motif ne
  matchait jamais `_layout` seul → le prune restait inopérant (2 occurrences).
- `typeChecksApply` testait `/\.(ts|tsx)$/` sur la **concaténation** des chemins : l'ancre ne
  voyait que le dernier fichier, tsc était déclaré inapplicable.
- Deux assertions ont échoué avant que `build` devienne critique et que l'**absence** de
  validation cesse d'être comptée comme une réussite.

---

## 5. Commandes exécutées

```
ai-engine  npx tsc --noEmit                    → exit 0
ai-engine  npx jest --silent                  → Test Suites: 15 passed, Tests: 135 passed
backend    npx tsc --noEmit                    → exit 0
backend    npx jest --silent                  → Test Suites: 15 passed, Tests: 147 passed
ai-engine  npx jest tests/qa/tasklist-e2e     → 1 passed
```

---

## 6. Résultats avant / après

| Mesure | Avant | Après |
|---|---|---|
| `ir.dataLayer.models` | `[]` | `Task{id:string, title:string, isDone:boolean}` |
| `ir.backendGraph.services` | `[]` | `["TaskService"]` |
| `interface Task` généré | non | `src/types/task.types.ts` |
| service de tâches | non | `src/services/taskservice.service.ts` |
| composant d'affichage | non | `src/components/TaskTile.tsx` |
| écrans source | `screens.tsx`, `widgets.tsx` | `app/home.tsx`, `app/addtask.tsx` |
| erreurs d'intégrité | 3 (`missing-layout-screen`) | 0 |
| `source-entities` | inexistant | PASS (réellement comparé) |
| fidélité / verdict | 58 %, verdict non exposé | 83 %, **PARTIAL** |
| `fullyValidated` | champ absent | **false** |
| durée de validation | « 0 ms » | **2 820 ms** mesurés |
| contrôles dans le JSON du ZIP | 0 | 10 |
| contrôles dans le Markdown | 0 | 10 (mêmes identifiants) |

Sortie réelle après correction :

```
[QA7]   local-imports: PASS   dependencies: PASS   typescript: PASS [2799ms]
[QA7]   config-entrypoint: PASS   routes: PASS   source-imports: PASS
[QA7]   empty-files: PASS   source-entities: PASS
[QA7]   tests: NOT_RUN — aucun test n'est généré pour le projet cible
[QA7]   build: NOT_RUN — ni build ni export Expo exécuté
[QA8] intégrité : PASS — erreurs 0
[QA8] verdict : PARTIAL   fullyValidated : false
[QA8] critiques non exécutés : tests, build
[QA8] décomposition : source 58%, structure 100%, fonctionnel non mesuré,
        statique 100%, tests non mesuré, compilation 100%
```

---

## 7. Échecs restants — bloquants documentés, non masqués

**Les contrôles 5, 6 et 7 de la demande n'ont pas pu être exécutés intégralement.**

- **Tests du projet généré : NOT_RUN.** Aucun runner ni test n'est généré pour le projet
  cible. Les exécuter exige `npm install` dans le projet généré (réseau + temps).
- **Build / export Expo : NOT_RUN.** Même dépendance. `expo export` n'a pas été lancé.
- **Comportement fonctionnel (points 5 et 6) : vérifié statiquement uniquement.** Le
  formulaire qui transmet le titre, l'apparition de la tâche sur l'écran principal, le toggle
  et le compteur **n'ont pas été observés en exécution** : aucun appareil ni simulateur n'est
  disponible dans cet environnement. Hors appel modèle, le générateur déterministe ne
  synthétise pas cette logique — les écrans restent des squelettes. Ce n'est pas contourné
  par des mocks.
- **Préservation fonctionnelle : `null`.** Aucune mesure automatisée n'existe ; elle n'est
  jamais comptée comme 100.
- **Types `react-native` / `expo` : non vérifiables** sans leurs dépendances (limite déjà
  déclarée en Phase 46).

Conséquence volontaire : `fullyValidated` reste **false** pour toute conversion tant que
`tests` et `build` ne sont pas exécutés. Aucun verdict EXCELLENT n'est possible dans cet
environnement.

**Rappel :** le token GitHub collé dans cette conversation doit être **révoqué et réémis**.
