# Phase 44 — Durcissement de la qualité des conversions

**Cible** : Flutter → React Native (Expo Router), moteur `ai-engine`.
**Point de départ** : 30 fichiers produits pour 10 fichiers sources, avec imports manquants,
dépendances absentes du manifeste, navigation incorrecte, et **score de fidélité flatteur
malgré des défauts fonctionnels**.

> **Avertissement de périmètre** — ce document distingue strictement ce qui est **implémenté
> et testé** de ce qui est **diagnostiqué mais non implémenté**. Voir §7.

---

## 1. Audit — causes racines

Toutes les causes ci-dessous sont établies sur le code réel, puis confirmées par une
exécution du pipeline (preuve chiffrée en §2).

### RC1 — Le score est calculé AVANT la génération

`core/pipeline.ts:739` (Phase 7) :

```ts
const fidelityScore = this.calculateFidelityScore(validatedIR, plan.files, layerDetection);
```

`plan.files` est la **liste de fichiers planifiés** par `code-planner`, pas le code produit.
La génération a lieu ensuite, en Phase 8 (`pipeline.ts:753`). Le score mesure donc
l'intention, pas le résultat.

### RC2 — Les axes mesurent la présence, pas la validité

```ts
const nawareRatio = (gen: number, src: number, sourcePresent: boolean): number | null => {
  ...
  return Math.min(100, Math.round((gen / src) * 100));
};
```

Chaque axe est un **ratio de comptages** (écrans, modèles, services). La comparaison
sémantique repose sur `fuzzyMatch`, qui apparie des **noms**. Aucun terme du score ne dépend
de la résolution des imports, de la cohérence des types ni de la compilation.

### RC3 — La validation statique n'entre jamais dans le score

`staticVal` est calculé en Phase 12 (`pipeline.ts:1013`), **après** le score (lignes 822-865).
Ses résultats (`brokenImports`, `undefinedRefs`, `missingRoutes`, `emptyFiles`,
`criticalTodos`) sont transmis au delivery check mais **ne modifient jamais le score**.

### RC4 — La compilation est codée en dur comme « non tentée »

`pipeline.ts` (Phase 12) :

```ts
tsCompilation: { attempted: false, success: false, errors: [], warnings: [] },
```

Aucune compilation TypeScript n'est jamais exécutée sur le projet généré.

### RC5 — `compilationPassed = true` quand la compilation n'a pas eu lieu

`core/delivery-checker.ts:158-161` :

```ts
const compilationPassed =
  staticResult?.tsCompilation.attempted === true
    ? staticResult.tsCompilation.success
    : true; // NOT_TESTABLE → don't block READY on this
```

Combiné à RC4, un projet **jamais compilé** est systématiquement déclaré compilable.

### RC6 — La checklist READY ignore les défauts structurels

`delivery-checker.ts:165-222` construit 8 items. **Aucun** ne consulte `brokenImports`,
`emptyFiles`, `undefinedRefs`, `missingRoutes` ni `overallPassed`. Le `staticResult` n'est
lu que pour `tsCompilation` et `sourceImports`.

### RC7 — Aucun contrôle dépendances / manifeste

`grep -rn "dependencies" ai-engine/src/core` ne renvoie que des usages liés à l'IR et aux
prompts. **Rien** ne vérifie qu'un paquet importé (`from 'axios'`) figure dans le
`package.json` généré. C'est la cause directe du défaut « dépendances référencées mais
absentes ».

### Ce qui n'est PAS en cause

Contrairement à l'hypothèse la plus courante, les prompts ne sont pas la cause première :
`import-verifier.ts` et `static-validator.ts` existent, sont branchés, et **détectent**
effectivement des imports cassés. Leurs résultats sont simplement **ignorés** par le score
et par le verdict de livraison.

---

## 2. Preuve chiffrée (avant / après, même exécution du pipeline)

Test `ai-engine/tests/phase36/audit-score-gap.test.ts`, projet Flutter de 8 fichiers,
tier hors-ligne, exécution du **vrai** `ConversionPipeline` :

| Mesure | Avant correctif | Après correctif |
|---|---|---|
| fichiers générés | 28 | 28 |
| score de fidélité | 49 % | 49 % (sous le plafond) |
| `staticVal.overallPassed` | `false` | `false` |
| `brokenImports` | 1 | 1 |
| `emptyFiles` | 1 | 1 |
| `compilationResult` | absent | absent (toujours pas tentée) |
| dépendance non déclarée | 1 (`@react-native-async-storage/async-storage`) | 1 — **détectée** |
| verdict d'intégrité | *n'existait pas* | **FAIL** (2 erreurs) |
| **verdict de livraison** | **`READY`** | **`NEEDS_REPAIR`** |

Sortie réelle :

```
║ fichiers générés            : 28
║ SCORE DE FIDÉLITÉ annoncé   : 49%
║ compilationResult           : ABSENT (jamais tentée)
║ staticVal.overallPassed     : false
║   brokenImports             : 1
║   emptyFiles                : 1
║ intégrité verdict           : FAIL
║   par code                  : {"unresolved-local-import":1,"missing-dependency":1}
║ delivery verdict            : NEEDS_REPAIR
║ paquets NON déclarés        : 1 → @react-native-async-storage/async-storage
```

Le verdict bascule de `READY` à `NEEDS_REPAIR` **sur le même code généré**.

---

## 3. Fichiers modifiés

| Fichier | Changement |
|---|---|
| `ai-engine/src/core/project-integrity-validator.ts` | **NOUVEAU** (~560 lignes) — validateur déterministe |
| `ai-engine/src/models/ir.types.ts` | Types `IntegrityIssue`, `IntegrityIssueCode`, `IntegritySeverity`, `ProjectIntegrityReport` ; champs optionnels sur `DeliveryCheckResult` (`integrityVerdict`, `integrityErrors`, `integrityWarnings`, `compilationTested`) et `ConversionResult.integrityReport` |
| `ai-engine/src/core/delivery-checker.ts` | 6ᵉ paramètre **optionnel** `integrity` ; 4 nouveaux items de checklist ; les erreurs d'intégrité deviennent des **blockers** ; `compilationTested` distinct de `compilationPassed` ; libellé « NOT TESTED … not a pass » |
| `ai-engine/src/core/pipeline.ts` | Appel du validateur en Phase 12 ; **plafond de score** documenté ; rapport exposé sur le résultat |
| `ai-engine/tests/integrity/project-integrity-validator.test.ts` | **NOUVEAU** — 20 tests |
| `ai-engine/tests/phase36/audit-score-gap.test.ts` | **NOUVEAU** — preuve chiffrée + garde de non-régression |

Aucune fonctionnalité supprimée. Tous les nouveaux paramètres sont **optionnels** : les
appelants existants compilent et se comportent comme avant.

---

## 4. Contrôles implémentés (Phase 2)

| Contrôle | Code | Sévérité |
|---|---|---|
| Import local non résolu | `unresolved-local-import` | error (warning si `import type`) |
| Dépendance absente du manifeste | `missing-dependency` | error |
| Route référencée sans écran | `missing-route-target` | error |
| Chemin produit plusieurs fois | `duplicate-file` | error |
| Fichiers sources identiques | `conflicting-file` | warning |
| `package.json` / `tsconfig` / `app.json` absent | `missing-config` | error / warning |
| `package.json` invalide | `invalid-config-json` | error |
| Aucun point d'entrée | `missing-entrypoint` | error |
| Fichier source vide | `empty-source-file` | error |

### Garde-fous anti faux positifs (testés)

- extensions implicites `.ts .tsx .js .jsx .mjs .cjs .json` et `/index.*` ;
- extensions de plateforme `.ios` `.android` `.native` `.web` ;
- alias TypeScript `@/*` `~/*` résolus depuis `tsconfig.compilerOptions.paths` ;
- tsconfig tolérant aux commentaires ;
- modules Node natifs et préfixe `node:` exclus ;
- routes dynamiques Expo `[id]` et groupes `(tabs)` ignorés ;
- alias **utilisé mais non déclaré** ⇒ warning, jamais erreur (on ne peut pas trancher) ;
- imports side-effect, `require()`, `import()` dynamique, `export … from`.

Propriétés vérifiées par les tests : **déterministe** (deux appels ⇒ rapports égaux) et
**sans effet de bord** (les fichiers reçus ne sont pas modifiés).

---

## 5. Score honnête (Phase 6)

Le score de fidélité continue de mesurer la **couverture** de la conversion — c'est sa
sémantique, elle n'est pas changée. Un **plafond** est appliqué après génération :

| Verdict d'intégrité | Plafond du score |
|---|---|
| `FAIL` | **59 %** |
| `PASS_WITH_WARNINGS` | **89 %** |
| `PASS` | 100 % |

Le plafond n'**augmente** jamais le score. Le verdict de livraison est indépendant et
distingue `PASS` / `PASS_WITH_WARNINGS` / `FAIL`.

`compilationTested` est désormais un champ distinct de `compilationPassed` : « non testé »
n'est plus compté comme « réussi ».

---

## 6. Tests exécutés et résultats

```
ai-engine  npx tsc --noEmit   → exit 0
ai-engine  npx jest           → Test Suites: 11 passed / Tests: 104 passed
backend    npx tsc --noEmit   → exit 0
backend    npx jest           → Test Suites: 15 passed / Tests: 147 passed
```

20 tests sur le validateur, dont :

| Exigence de la mission | Test | État |
|---|---|---|
| import local manquant | `import local manquant → FAIL` | ✅ |
| dépendance absente | `dépendance absente de package.json → FAIL` | ✅ |
| navigation incorrecte | `route référencée sans écran → FAIL` | ✅ |
| génération partielle | `fichier source vide`, `package.json absent`, `aucun point d'entrée` | ✅ |
| rapport annonçant à tort un score parfait | `audit-score-gap` : score ≤ plafond, et `NEEDS_REPAIR` si erreurs | ✅ |
| cas Flutter → RN valide qui doit passer | `un projet Expo Router cohérent obtient PASS sans erreur` | ✅ |
| type ou propriété incohérente | — | ❌ **non couvert** |
| formulaire qui ne transmet pas ses données | — | ❌ **non couvert** |
| compilation échouée | — | ❌ **non couvert** |
| fonctionnalité non prise en charge | — | ❌ **non couvert** |

**Trois tests ont échoué à la première exécution**, ce qui a révélé un défaut de mon propre
harnais : `validProject()` contenait déjà `app/index.tsx`, et mes ajouts créaient un doublon
légitimement détecté. Corrigé par fusion par chemin — ce qui valide au passage la détection
de doublons.

---

## 7. Ce qui n'est PAS fait — déclaré explicitement

### Phase 3 — Préservation du comportement : NON IMPLÉMENTÉE

Aucune représentation explicite des écrans/actions/états/modèles/services et de leurs
relations n'a été construite. Aucune association source→cible par fonctionnalité.
**Aucun test** ne vérifie qu'un formulaire transmet ses données.

### Phase 4 — Réparation automatique : NON IMPLÉMENTÉE (choix assumé)

Aucune correction automatique n'a été ajoutée. La consigne demande d'éviter les corrections
automatiques risquées ; ajouter une dépendance manquante au manifeste suppose de deviner une
version, et réécrire un import suppose de deviner une cible. J'ai préféré un **constat
fiable** à une réparation speculative. Le cycle de correction existant (Phase 8) est inchangé.

### Phase 5 — Build et tests du projet généré : NON EXÉCUTÉS

- **Aucune** installation de dépendances du projet généré.
- **Aucune** compilation TypeScript du projet généré (`tsCompilation.attempted` reste `false`).
- **Aucun** lint, **aucun** test unitaire, **aucun** export Expo.

Ces étapes sont **non exécutées**, et non « réussies ». Le changement de cette phase se
limite à rendre le **rapport honnête** à leur sujet (`compilationTested`, libellé
« NOT TESTED »).

### Codes réservés mais non implémentés

`undeclared-symbol` et `model-property-mismatch` sont **déclarés** dans
`IntegrityIssueCode` mais **aucun contrôle ne les émet**. Ils sont réservés pour la suite et
ne doivent pas être interprétés comme une couverture existante.

### Non vérifié

Aucune conversion réelle avec appels Groq. Les exécutions ci-dessus tournent sur le tier
hors-ligne du pipeline : elles prouvent la génération, l'assemblage et la validation, pas la
qualité des sorties produites par le modèle.

---

## 8. Déploiement et variables d'environnement

**Aucune nouvelle variable d'environnement.** Aucune configuration Render, clé API, secret
ou URL de production modifié.

Le validateur s'exécute automatiquement en Phase 12 sur toutes les conversions, sans
condition d'activation. Le rapport est exposé sur `ConversionResult.integrityReport` et
dans `deliveryCheck` (`integrityVerdict`, `integrityErrors`, `integrityWarnings`).

Déploiement habituel :

```bash
npm install
npm run build --workspace=shared
npm run build --workspace=ai-engine
```

### Effet attendu en production

Des conversions auparavant annoncées `READY` passeront en `NEEDS_REPAIR` dès qu'un import ne
résout pas, qu'une dépendance manque au manifeste ou qu'une route est cassée. **C'est
l'objectif** : ce n'est pas une régression, c'est la révélation de défauts préexistants.
Si le volume de `NEEDS_REPAIR` augmente fortement après déploiement, cela mesure l'écart
réel, pas une dégradation du moteur.

---

## 9. Suite recommandée, par ordre de valeur

1. **Phase 5** — exécuter réellement `npm install` + `tsc --noEmit` sur le projet généré dans
   un répertoire temporaire, et alimenter `tsCompilation`. C'est le seul moyen de remplacer
   « NOT TESTED » par un vrai verdict.
2. **Implémenter `missing-dependency` en réparation sûre** : ajouter le paquet **sans
   version figée** (`"*"` ou la version déjà présente ailleurs dans le projet) reste un
   choix à valider — à trancher explicitement.
3. **Phase 3** — représentation des fonctionnalités sources et traçabilité source→cible.
4. **Implémenter `model-property-mismatch`** : comparer les propriétés déclarées d'un modèle
   aux propriétés accédées dans les composants.
