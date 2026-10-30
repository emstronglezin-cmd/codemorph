# Phase 52 — Correction structurelle et validation réelle

Conversion Flutter → React Native (projet témoin TaskList). Priorité : fiabilité de
livraison, pas score.

---

## ⚠️ À lire avant tout

**Aucune archive externe n'a été fournie ni trouvée** sur ce système de fichiers. Les causes
racines ci-dessous sont établies par **lecture du code du moteur** et par **mesures
exécutées sur le pipeline réel**. Chaque affirmation est accompagnée de sa preuve.

**Ce qui n'a PAS été exécuté** (et n'est donc pas déclaré réussi) :

| Contrôle | État | Raison précise |
|---|---|---|
| Build natif Android/iOS | **NOT_RUN** | ni Android SDK ni Xcode dans l'environnement |
| Rendu sur appareil/émulateur | **NOT_RUN** | aucun appareil ni émulateur disponible |
| Contrôle `tests` du pipeline | **NOT_RUN** | aucun runner exécuté dans l'harnais du moteur |
| Contrôle `build` du pipeline | **NOT_RUN** | aucun bundler exécuté dans l'harnais du moteur |
| Round-trip | **NOT_RUN** | `runRoundTripFidelity()` existe, le pipeline ne l'appelle pas |
| Lint | **NOT_RUN** | aucun ESLint configuré dans le projet livré |

Les tests **Jest du projet livré** et les **exports Metro** ont, eux, été réellement
exécutés (preuves §5).

---

## 1. Causes racines

### A. Casts artificiels masquant des incompatibilités — `code-planner.ts`

Trois casts étaient présents dans le projet livré :

```ts
} as Task;                                              // taskservice.service.ts:22
`task-${...}` as unknown as string;                     // taskservice.service.ts:66
data={tasks as Task[]}                                  // app/index.tsx:87
```

Origine dans le générateur :

- **`code-planner.ts:787`** — le littéral de `add()` ne contenait que l'id, les champs
  d'entrée et le booléen d'état. **Tout autre champ du modèle était omis**, et `} as
  ${model.name}` faisait taire les propriétés manquantes.
- **`code-planner.ts:815`** — `nextId()` renvoyait un gabarit de **chaîne** casté en
  `as unknown as ${idType}`. Si le modèle déclare `id: number`, le service renvoyait donc
  une chaîne mentant sur son type. C'est un mensonge de type, pas un cast de commodité.
- Le troisième cast (`data={tasks as Task[]}`) était **inutile** : `FlatList.data` accepte
  `ReadonlyArray`. Retiré, `tsc` reste à 0 — preuve qu'il ne masquait rien de réel.

### B. Définition concurrente du modèle — `code-planner.ts`

`generateRNModel()` émettait systématiquement :

```ts
export interface TaskList { items: Task[]; total: number; page: number; }
```

Une **forme de pagination REST inventée**, sans équivalent dans la source Flutter (qui est
purement locale). Deux types portaient le même nom de domaine, et un écran pouvait importer
le mauvais.

### C. Routes source jamais lues — `ir-generator.ts:267`

```ts
navigationFlow: screens.slice(1).map((s) => ({
  from: screens[0]?.id ?? 'screen-home',
  to:   s.id,
  trigger: 'navigate',
  guard: '',
}))
```

**Chaque écran était déclaré atteignable depuis le premier**, avec un déclencheur générique.
Aucune ligne de la source n'était lue. Les routes n'étaient pas « mal détectées » : elles
étaient **inventées à partir de l'ordre des écrans**. Conséquence : écrans réellement
navigables et écrans orphelins étaient indistinguables, et la comparaison source ↔ cible
portait sur du fictif.

`ast-analyzer.ts:672` ne faisait que **reconnaître le mécanisme** (`'Flutter-Navigator'`),
sans extraire la moindre arête.

### D. Un test fonctionnel annonçait PASS sans rien compiler — `functional-test-runner.ts`

```ts
return {
  feature: 'TypeScript compilation (static check)',
  status: 'PASS',
  detail: `... no Dart imports, no SHELL files detected (runtime tsc not executed)`,
};
```

Le test cherchait des imports Dart et des fichiers SHELL, **puis renvoyait PASS**. Son
propre détail admettait « runtime tsc not executed ». C'est exactement « le rapport annonce
PASS alors que le projet n'est pas compilable ».

### E. Le JSON livré et le rapport n'étaient pas le même objet — `pipeline.ts`

`conversion-report.json` (celui qui part dans le ZIP) était construit **à part** du
`ConversionReport`. Il ne contenait **ni `readyForProduction` ni `productionBlockers`**. Le
ZIP pouvait donc annoncer un verdict sans le statut de production qui le contredisait.

---

## 2. Fichiers du moteur modifiés

| Fichier | Changement |
|---|---|
| **`src/core/source-route-extractor.ts`** | **NOUVEAU.** `extractSourceRoutes()` lit `Navigator.push`, `Navigator.push<T>`, `pushNamed`, `Navigator.pop`, `context.go/push` (go_router), `context.router.push` (auto_route) et la table `routes:` de `MaterialPageRoute`. `resolveRouteTarget()` rapproche une cible source d'un écran généré (suffixes `Screen`/`Page`/`View` tolérés). |
| `src/core/ir-generator.ts` | Utilise l'extracteur. **Sans navigation dans la source, plus aucune route inventée.** Une cible introuvable devient `unresolved:<nom>` au lieu d'être fabriquée. |
| `src/core/code-planner.ts` | Littéral de `add()` complet (tous les champs, défauts typés sûrs) ; un champ complexe sans défaut sûr devient **paramètre** de `add()` au lieu d'être omis ; `nextId()` au type réel (compteur pour `number`) ; **`} as Model` supprimé** ; `NoteList`/`TaskList` **supprimé du générateur**. |
| `src/core/functional-test-runner.ts` | T09 analyse réellement la syntaxe via le parseur TypeScript ; ne renvoie plus PASS sans vérification. |
| `src/core/pipeline.ts` | `ConversionReport` hoisté ; le JSON livré reprend le **même objet** et emporte un bloc `delivery` complet (statut de production, blockers, round-trip, comptages). |
| `tests/regression/source-routes-and-model.test.ts` | **NOUVEAU.** 12 tests. |
| `examples/tasklist-rn/scripts/verify-delivered.mjs` | **NOUVEAU.** Vérification indépendante du projet livré, sans faire confiance au moteur. |

**Aucune exception propre à Task** : l'extracteur de routes ne connaît aucun nom d'écran, et
les tests utilisent `Note`/`NoteService`/`DetailScreen`/`/settings`.

---

## 3. Ce qui est corrigé dans le projet livré

| Exigence | État | Preuve |
|---|---|---|
| Définition canonique unique de `Task` | **FAIT** | 1 seule `interface Task` ; `TaskList` supprimé |
| Un seul champ de complétion | **FAIT** | `isDone` uniquement — 0 occurrence de `completed`/`done`/`finished` |
| Casts artificiels supprimés | **FAIT** | 0 `as Task`, 0 `as unknown as`, 0 `as any` |
| Contrat du service complet | **FAIT** | `getAll`, `add`, `toggle`, `remove`, `subscribe`, `isDoneCount`, `totalCount`, `reset` |
| Instance partagée unique | **FAIT** | singleton exporté ; **0** `new *Service()` dans les écrans |
| Pas d'API REST inventée | **FAIT** | service local en mémoire, aucun endpoint |
| Accueil en `app/index.tsx` | **FAIT** | routes déclarées `[add-task, index]` == fichiers présents |
| Aucune fonction en paramètre de route | **FAIT** | `router.back()` sans argument ; 0 callback |
| Ajout → retour → affichage | **FAIT** | test de flux vert |
| Complétion + compteur exacts | **FAIT** | test de flux vert |
| Suppression | **FAIT** | `remove()` présent et testé |
| Aucun `NEEDS MANUAL REVIEW` | **FAIT** | 0 placeholder |

---

## 4. Vérification indépendante (script, pas le moteur)

`node scripts/verify-delivered.mjs` relit les fichiers sur disque :

```
✅ PASS  1. Imports locaux résolvent (chemin + casse exacte)
        16 imports locaux, 0 cassé(s)
✅ PASS  2. Toute dépendance importée est déclarée
        23 dépendances déclarées, 0 import non déclaré
✅ PASS  3. Un seul modèle Task, un seul champ de complétion
        déclarations Task* : [TaskTileProps, TaskServiceListener, Task] ; champs : [isDone]
✅ PASS  4. Routes déclarées == fichiers présents, accueil en app/index.tsx
        déclarées [add-task, index] ; fichiers [add-task, index]
✅ PASS  5. Aucune fonction transmise par la navigation
        0 callback dans les paramètres de route
✅ PASS  6. Contrat du service complet + instance partagée unique
        méthodes manquantes [] ; singleton exporté : true ; instances dans les écrans : []
✅ PASS  7. Aucun placeholder NEEDS MANUAL REVIEW
        0 placeholder

Résultat : 7/7 contrôles PASS   (exit 0)
```

---

## 5. Commandes réellement exécutées

```
# Moteur
$ cd ai-engine && npx tsc --noEmit                 → AI_TSC=0
$ npx jest tests/regression                        → 73 passed / 73
$ npx jest --silent                                → 21 suites / 209 tests passed
$ cd ../backend && npx tsc --noEmit ; echo $?      → BE_TSC_EXIT=0
$ npx jest --silent                                → 15 suites / 147 tests passed

# Projet livré (après npm install + npx expo install)
$ npx tsc --noEmit                                 → 0 erreur
$ npx jest                                         → 3 suites / 20 tests passed
$ npx expo export --platform android               → exit 0
$ npx expo export --platform ios                   → exit 0
$ npx expo export --platform web                   → exit 0
    → index.html, add-task.html, _sitemap.html, +not-found.html

$ node scripts/verify-delivered.mjs .              → 7/7 PASS, exit 0
```

### Dans le pipeline réel

```
[IRGenerator] PHASE 52 — 1 route(s) extraite(s) de la source (mécanisme : flutter-navigator)
✅ Syntaxe : 23 fichier(s) TS/TSX analysé(s), 0 erreur
[PIPELINE] PHASE 51 — Réconciliation fichiers : ZIP 29 fichier(s) == livrables 29
[GEN] 29 fichiers écrits | fidélité 84% / GOOD / fullyValidated=false
```

Avant le correctif, la même source produisait **0 route extraite** (mécanisme détecté mais
regex incapable de lire `Navigator.push<String>(...)`) — et avant la Phase 52, des routes
inventées.

### Tests fonctionnels du pipeline (12)

**6 PASS, 5 PARTIAL, 0 FAIL, 1 NOT_TESTABLE.**

Les 5 PARTIAL sont des **limites réelles du projet généré**, pas des défauts de détection :
navigation 78 %, auth 2/3 mécanismes, URL API non détectée, state score N/A, 1 placeholder de
configuration. Je ne les ai pas maquillées.

---

## 6. Rapport JSON — bloc `delivery` (extrait réel)

```json
{
  "filesDelivered": 29,
  "zipFileCount": 29,
  "compilationStatus": "SKIPPED",
  "compilationPassed": false,
  "roundTrip": 0,
  "roundTripStatus": "NOT_RUN",
  "readyForProduction": false,
  "productionBlockers": [
    "Compilation non exécutée (SKIPPED) — une compilation ignorée ne peut pas être comptée comme réussie",
    "Contrôle critique non exécuté : tests",
    "Contrôle critique non exécuté : build"
  ],
  "deliveryCheckStatus": "READY",
  "deliveryBlockers": []
}
```

Le JSON du ZIP, le Markdown, le HTML et le callback sortent désormais du **même objet**
`ConversionReport`.

---

## 7. Statut de production

| | |
|---|---|
| Fidélité | 84 % / GOOD — **non modifiée** |
| `fullyValidated` | **false** |
| **READY FOR PRODUCTION** | **NO** |
| Motifs | Compilation SKIPPED ; contrôles critiques `tests` et `build` non exécutés |

Règle appliquée : une erreur TS, une route essentielle en échec, une fonctionnalité
essentielle défaillante, un contrôle critique non exécuté, ou un build en échec → **NO**.
Ici c'est le quatrième cas. **Le score n'a pas été gonflé** : les axes non mesurés restent
`na`/`NOT_RUN` et continuent de bloquer.

---

## 8. Livrables

| Livrable | Emplacement |
|---|---|
| ZIP corrigé | `/home/user/codemorph-tasklist-fixed-p52.zip` |
| Rapport JSON complet | `examples/tasklist-rn/_codemorph-reports/conversion-report.json` |
| Résultat brut du pipeline | `examples/tasklist-rn/_codemorph-reports/pipeline-result.json` |
| Rapport Markdown | `examples/tasklist-rn/_codemorph-reports/conversion-report.md` |
| Rapport HTML | `examples/tasklist-rn/_codemorph-reports/fidelity-report.html` |
| Analyse source | `examples/tasklist-rn/_codemorph-reports/source-analysis.json` |
| Script de vérification | `examples/tasklist-rn/scripts/verify-delivered.mjs` |
| Ce rapport | `docs/PHASE52_STRUCTURAL_FIX.md` |

---

## 9. Problèmes restant à résoudre

1. **La génération des écrans échoue toujours hors ligne.** Sortie réelle du pipeline :
   `[FileGenerator] ❌ All 4 attempts failed for "HomeScreen" — using fallback`,
   `[COHERENCE] ❌ CRITICAL: IR has 2 screens but 0 were generated`. **Les écrans du
   livrable sont écrits par moi, pas générés par le moteur.** C'est le dernier maillon qui
   impose du travail manuel.
2. **Le round-trip n'est pas câblé.** Le statut est honnête (`NOT_RUN`), la mesure n'existe
   toujours pas.
3. **`tests` et `build` restent `NOT_RUN` dans le pipeline.** Conséquence assumée : **tant
   qu'ils ne seront pas exécutés, aucune conversion ne pourra être déclarée prête pour la
   production.** Le YES est actuellement inatteignable par construction.
4. **`service-arity-mismatch` est déclaré mais aucun contrôle ne l'émet** : l'existence des
   méthodes est vérifiée, pas leur signature.
5. **Le contrôle syntaxique est purement syntaxique.** Il ne remplace pas `tsc` : types et
   modules externes restent hors de sa portée.
6. **5 PARTIAL fonctionnels subsistent** (navigation 78 %, auth partielle, URL API, state,
   configuration).
7. **Aucun test sur appareil.** Le fonctionnement réel de l'application n'est pas démontré.
