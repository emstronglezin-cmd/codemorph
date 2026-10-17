# Phase 45 — Sortie Flutter → React Native cassée : correctifs P0

**Symptômes rapportés** : 30 fichiers pour 10 sources, 100 % de fidélité annoncée, imports
non résolus, modèles `Task` incohérents, navigation initiale incorrecte, flux d'ajout de
tâche non fonctionnel, et commentaires `TODO(import-verifier)` livrés dans le code.

---

## 1. Causes racines — chemins exacts

### RC1 — L'import non résolu était **commenté**, donc masqué
`ai-engine/src/core/import-verifier.ts:506`

```ts
const todoComment = `// TODO(import-verifier): Cannot resolve '…' — …\n// ${imp.raw}`;
lines[imp.lineNumber] = todoComment;
```

L'import était **remplacé** par un commentaire (`// ${imp.raw}`). Le module disparaissait du
fichier livré, le symbole utilisé plus bas devenait indéfini, et comme aucune compilation
n'était exécutée (RC3), rien ne le signalait. Le générateur **connaissait** le défaut —
`report.importsUnresolved` le comptait correctement (`import-verifier.ts:386`) — mais
**aucune porte** ne bloquait la livraison.

### RC2 — Deux modèles incompatibles n'étaient jamais détectés
Le code `model-property-mismatch` existait dans les types mais **aucun contrôle ne
l'émettait**. Deux `interface Task` avec `completed` vs `isDone` passaient inaperçues.

### RC3 — Aucune compilation n'était jamais tentée
`ai-engine/src/core/pipeline.ts` (Phase 12) :

```ts
const staticVal = runStaticValidationSync(...);   // variante SANS tsc
tsCompilation: { attempted: false, success: false, errors: [], warnings: [] },  // codé en dur
```

Une vraie implémentation `tsc --noEmit` **existait déjà** (`runStaticValidation` →
`attemptTsCompilation` dans `static-validator.ts`), elle n'était simplement jamais appelée.

### RC4 — « Validation duration = 0 »
`pipeline.ts:725-728` :

```ts
phaseStart('validation');
const validatedIR = await this.irValidator.validate(mappedIR);
phaseEnd('validation');
```

La seule phase nommée `validation` est la validation du **schéma IR**, exécutée **avant**
toute génération, en quelques millisecondes. La validation post-génération (statique,
contenu, intégrité, livraison) n'était **ni minutée ni rapportée**.

### RC5 — `tsc` introuvable à cause du hoisting npm
`static-validator.ts` cherchait uniquement `<workDir>/node_modules/.bin/tsc`. Dans ce
monorepo, `tsc` est **hoisté à la racine** : depuis `ai-engine/`, le chemin n'existe pas et la
fonction retournait silencieusement `attempted: false`.

### RC6 — Faux positif de navigation sur Expo Router
`delivery-checker.ts:47-49` exigeait `Stack.Screen` / `Tab.Screen` dans `_layout.tsx`.
Expo Router est un routeur **basé sur les fichiers** : `<Stack />` seul est valide. Tout
projet Expo Router correct était donc déclaré `NEEDS_REPAIR`.

### RC7 — Régression que j'avais introduite en Phase 43
`ai-engine.client.ts` — `computeWakeFloorMs` utilisait un jitter **±20 %**, pouvant ramener
le plancher de réveil à 36 s alors qu'il existe pour couvrir un spin-up Render d'environ une
minute. Détecté par `ai-engine.hibernation.spec.ts`
(`Expected: >= 45000, Received: 44522`). **C'est mon défaut, introduit au tour précédent.**

---

## 2. Modifications réelles dans CodeMorph

| Fichier | Changement |
|---|---|
| `ai-engine/src/core/import-verifier.ts` | L'import non résolu est **conservé** et le TODO placé **au-dessus** : l'erreur reste visible par `tsc` au lieu d'être masquée |
| `ai-engine/src/core/static-validator.ts` | Classification honnête des erreurs `tsc` (modules externes ⇒ « non vérifiables », le reste ⇒ échec réel) ; recherche de `tsc` remontant l'arborescence + repli `require.resolve` ; timeout 30 s → 60 s |
| `ai-engine/src/core/pipeline.ts` | Phase 12 appelle la **vraie** validation asynchrone (`runStaticValidation`), **minutée** ; plus de `tsCompilation` codé en dur ; `importsUnresolved > 0` force le verdict d'intégrité à `FAIL` |
| `ai-engine/src/core/project-integrity-validator.ts` | 3 nouveaux contrôles : `model-property-mismatch` (modèles canoniques), `wrong-entry-route`, `form-not-wired` |
| `ai-engine/src/core/delivery-checker.ts` | Faux positif Expo Router corrigé ; les 3 nouveaux codes deviennent des **blockers** ; item de checklist « Canonical models » |
| `ai-engine/src/models/ir.types.ts` | Codes `wrong-entry-route`, `form-not-wired` ; champ `unverifiableModules` |
| `backend/src/modules/jobs/ai-engine.client.ts` | Jitter de réveil rendu **strictement ascendant** (+0 à +40 %) — corrige RC7 |
| `ai-engine/tests/integrity/tasklist-regression.test.ts` | **NOUVEAU** — 10 tests, fixture liste de tâches |
| `backend/src/modules/jobs/__tests__/ai-engine.wake-budget.spec.ts` | Bornes mises à jour pour le jitter ascendant |

---

## 3. Test de régression exigé

`ai-engine/tests/integrity/tasklist-regression.test.ts` — fixture Flutter → React Native
« liste de tâches » (Home, AddTask, modèle `Task` canonique, `TaskService`, `TaskTile`,
store partagé), en version **correcte** puis en variantes défectueuses.

| Exigence | Test | Résultat |
|---|---|---|
| Projet valide doit passer | `le projet liste de tâches correct obtient PASS` | ✅ |
| Module local référencé absent | `TaskService importé depuis un chemin inexistant` | ✅ |
| TaskService/TaskTile incompatibles | `deux interfaces Task incompatibles (completed vs isDone)` | ✅ |
| Lancement sur AddTask | `lancement sur AddTask au lieu de Home (redirect)` + `écran de lancement nommé AddTask` | ✅ |
| Soumettre n'ajoute pas de tâche | `écran de saisie qui ne transmet aucune donnée` | ✅ |
| Validation TypeScript échoue | `tsc échoue sur une erreur de type réelle` — **réellement exécuté, 473 ms** | ✅ |
| Rapport annonçant un succès à tort | `score 100 % mais validation en échec → jamais READY` | ✅ |
| (ajout) Compilation non tentée | `une compilation NON tentée est déclarée comme telle` | ✅ |
| (ajout) Dépendance manquante | `dépendance importée mais absente de package.json` | ✅ |

---

## 4. Commandes exécutées et résultats réels

```
ai-engine  npx tsc --noEmit   → exit 0
ai-engine  npx jest           → Test Suites: 12 passed / Tests: 114 passed
backend    npx tsc --noEmit   → exit 0
backend    npx jest           → Test Suites: 15 passed / Tests: 147 passed
backend    5 × (hibernation + wake-budget) → 28 passed à chaque exécution
```

Le premier passage complet a révélé **1 échec backend** (`Expected: >= 45000,
Received: 44522`) : c'est la régression RC7. Corrigée, puis rejouée 5 fois pour confirmer
la stabilité (le défaut était aléatoire à cause du jitter).

---

## 5. Avant / après

| Mesure | Avant | Après |
|---|---|---|
| Import non résolu | commenté, invisible | conservé, visible par `tsc` |
| Compilation TS du projet généré | jamais tentée (`attempted: false` en dur) | **réellement exécutée** (473 ms sur le fixture) |
| « Validation time » | ~0 ms (validation du schéma IR seulement) | durée de la validation **post-génération** journalisée |
| Deux modèles `Task` incompatibles | non détectés | erreur `model-property-mismatch`, blocker |
| Lancement sur AddTask | non détecté | erreur `wrong-entry-route`, blocker |
| Formulaire sans transmission | non détecté | erreur `form-not-wired`, blocker |
| `importsUnresolved > 0` | livré quand même | verdict d'intégrité forcé à `FAIL` |
| Projet Expo Router correct | `NEEDS_REPAIR` (faux positif) | `READY` |
| Erreurs « Cannot find module 'react-native' » | n'existaient pas (pas de tsc) | classées **non vérifiables**, pas comptées comme échec |
| Plancher de réveil | 36-54 s (pouvait être trop court) | 45-63 s, jamais sous le délai de base |

---

## 6. Défauts restants

1. **Priority 4 (boucle de réparation) : NON IMPLÉMENTÉE.** Aucune réparation ciblée
   automatique après échec de validation. Le cycle existant (Phase 8) est inchangé.
2. **`npm install` sur le projet généré : NON EXÉCUTÉ.** Les dépendances externes restent
   « non vérifiables ». Sans installation, `tsc` ne peut pas valider les types venant de
   `react-native`/`expo`. C'est la limite principale de la validation actuelle.
3. **Export Expo : NON EXÉCUTÉ.** Aucun `expo export` ni build.
4. **Tests unitaires du projet généré : NON EXÉCUTÉS.** Aucun test n'est généré ni lancé.
5. **Le flux « ajouter une tâche » est vérifié statiquement, pas exécuté.** `form-not-wired`
   contrôle le *câblage* (mutation d'état ou navigation avec paramètres), pas le comportement
   réel. L'application n'est pas lancée.
6. **`undeclared-symbol` reste non implémenté** (code réservé).
7. **Modèle canonique : détection seulement.** Le validateur **signale** deux `Task`
   incompatibles ; il ne **réécrit pas** le projet pour n'en garder qu'un. La correction
   reste à faire côté génération (prompt/planificateur), ce qui demande un appel modèle —
   hors périmètre de ce correctif déterministe.

---

## 7. Déploiement

**Nouvelle variable d'environnement (optionnelle)** :

| Variable | Défaut | Effet |
|---|---|---|
| `AI_RUN_TSC_VALIDATION` | `true` (absente = activée) | `false` désactive `tsc` sur le projet généré ; le rapport l'indique alors explicitement |

Aucune clé API, secret, URL de production ou configuration Render modifié.

**Prérequis** : le binaire `tsc` doit être résolvable depuis l'AI Engine. Il l'est déjà
(`typescript` est une dépendance du workspace). La recherche remonte jusqu'à 8 niveaux et
replie sur `require.resolve('typescript')`.

**Effet attendu** : davantage de conversions en `NEEDS_REPAIR`. C'est l'objectif — cela rend
visibles des défauts jusqu'ici livrés silencieusement. Le budget de temps augmente de la
durée d'un `tsc --noEmit` (mesurée à 473 ms sur un projet de 10 fichiers, timeout 60 s).
