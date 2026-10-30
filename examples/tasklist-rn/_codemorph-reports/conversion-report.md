# CodeMorph Fidelity Report

**Job**: job-tasklist
**Date**: 2026-10-30T09:06:08.406Z
**Conversion**: Flutter → React Native
**Source files**: 5 | **Target files**: 29

---

## Overall Fidelity Score: 🟡 **84%**

**Verdict**: GOOD — Source coverage 100% but critical checks NOT RUN: tests, build — cannot be reported as fully validated

## Axes Summary

| Axis | Score | Source | Target | Missing | Added |
|------|-------|--------|--------|---------|-------|
| screens | 🟢 100% | 2 | 3 | 0 | 1 |
| navigation | N/A | 0 | 0 | 0 | 0 |
| ui_components | 🟢 100% | 1 | 10 | 0 | 9 |
| business_logic | 🟢 100% | 1 | 2 | 0 | 1 |
| api_calls | N/A | 0 | 0 | 0 | 0 |
| state_mgmt | N/A | 0 | 1 | 0 | 1 |
| services | 🟢 100% | 1 | 1 | 0 | 0 |
| data_models | 🟢 100% | 1 | 10 | 0 | 9 |
| assets | N/A | 0 | 0 | 0 | 0 |
| config_env | N/A | 0 | 2 | 0 | 2 |
| dependencies | N/A | 0 | 11 | 0 | 10 |
| features | N/A | 0 | 0 | 0 | 0 |

## Totals
- **Identical**: 6
- **Transformed correctly**: 0
- **Missing** (in source, absent from target): 0
- **Added** (in target, absent from source): 33
- **N/A axes** (excluded from score): navigation, api_calls, state_mgmt, assets, config_env, dependencies, features

## Detail by Axis

### screens — 100%
**Added elements** (not in source):
  - ➕ index

### ui_components — 100%
**Added elements** (not in source):
  - ➕ Button
  - ➕ TextInput
  - ➕ Card
  - ➕ LoadingSpinner
  - ➕ ErrorMessage

### business_logic — 100%
**Added elements** (not in source):
  - ➕ auth

### services — 100%

### data_models — 100%
**Added elements** (not in source):
  - ➕ TypographyVariant
  - ➕ ButtonProps
  - ➕ InputProps
  - ➕ TaskTileProps
  - ➕ User

---
*Computed in 1ms*
## Validation réellement exécutée

**Projet entièrement validé : ❌ NON** — durée 3318 ms

| Contrôle | Statut | Durée | Erreurs |
|----------|--------|-------|---------|
| local-imports | ✅ PASS | 3 ms | 0 |
| dependencies | ✅ PASS | 3 ms | 0 |
| typescript | ✅ PASS | 3315 ms | 0 |
| config-entrypoint | ✅ PASS | 3 ms | 0 |
| routes | ✅ PASS | 3 ms | 0 |
| source-imports | ✅ PASS | 3 ms | 0 |
| empty-files | ❌ FAIL | 3 ms | 1 |
| source-entities | ✅ PASS | 3 ms | 0 |
| syntax | ✅ PASS | 12 ms | 0 |
| service-contract | ✅ PASS | 3 ms | 0 |
| tests | ⏭️ NOT_RUN | 0 ms | 0 |
| build | ⏭️ NOT_RUN | 0 ms | 0 |
**Contrôles critiques NON EXÉCUTÉS :** tests, build

> Un contrôle non exécuté n'est pas un contrôle réussi. Cette conversion ne
> peut pas être déclarée entièrement validée tant que les contrôles ci-dessus
> n'ont pas été exécutés avec succès.
