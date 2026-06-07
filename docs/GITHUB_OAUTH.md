# GitHub OAuth Setup Guide — CodeMorph

## Overview

CodeMorph utilise GitHub OAuth pour permettre aux utilisateurs de se connecter avec leur compte GitHub. Ce guide explique comment créer l'application OAuth et configurer les variables.

---

## Étape 1 — Créer l'application GitHub OAuth

### 1.1 Accéder aux paramètres développeur

1. Connectez-vous sur [github.com](https://github.com)
2. Cliquez sur votre **avatar** → **Settings**
3. Dans le menu de gauche, faites défiler jusqu'à **Developer settings**
4. Cliquez sur **OAuth Apps**
5. Cliquez sur **New OAuth App**

### 1.2 Remplir le formulaire

| Champ | Valeur (développement) | Valeur (production) |
|---|---|---|
| **Application name** | `CodeMorph Dev` | `CodeMorph` |
| **Homepage URL** | `http://localhost:3000` | `https://codemorph.netlify.app` |
| **Application description** | `AI-powered code conversion` | `AI-powered code conversion` |
| **Authorization callback URL** | `http://localhost:4000/api/v1/auth/github/callback` | `https://codemorph-backend.onrender.com/api/v1/auth/github/callback` |

> **Important** : Le champ **Authorization callback URL** est exact — pas de trailing slash.

### 1.3 Récupérer les clés

Après création :

1. **Client ID** : visible directement sur la page de l'app
2. **Client Secret** : cliquez sur **Generate a new client secret**

> ⚠️ Copiez le Client Secret immédiatement — il ne sera plus affiché ensuite.

---

## Étape 2 — Configurer les variables

### Local (développement)

Créez `backend/.env` (jamais commité) :

```env
GITHUB_CLIENT_ID=Ov23liXXXXXXXXXXXXXX
GITHUB_CLIENT_SECRET=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0
GITHUB_CALLBACK_URL=http://localhost:4000/api/v1/auth/github/callback
FRONTEND_URL=http://localhost:3000
```

### Production (Render)

Dans Render Dashboard → **codemorph-backend** → **Environment** :

| Variable | Valeur |
|---|---|
| `GITHUB_CLIENT_ID` | `Ov23liXXXXXXXXXXXXXX` |
| `GITHUB_CLIENT_SECRET` | `a1b2c3...` |
| `GITHUB_CALLBACK_URL` | `https://codemorph-backend.onrender.com/api/v1/auth/github/callback` |
| `FRONTEND_URL` | `https://codemorph.netlify.app` |

---

## Étape 3 — Flux d'authentification

```
User clique "Continue with GitHub"
    ↓
Frontend: window.location.href = `${API_URL}/auth/github`
    ↓
Backend: GET /api/v1/auth/github → redirect GitHub consent screen
    ↓
User autorise l'application
    ↓
GitHub: POST callback_url?code=XXXXX
    ↓
Backend: échange code → access_token → récupère profil GitHub
    ↓
Backend: crée/met à jour User en DB → génère JWT
    ↓
Backend: redirect `${FRONTEND_URL}/auth/oauth-success?token=JWT`
    ↓
Frontend: extrait token, appelle /auth/me, redirige vers /dashboard
```

---

## Étape 4 — Scopes requis

L'application demande :
- `user:email` — lecture de l'email GitHub
- `read:user` — lecture du profil public
- `repo` — accès en lecture aux dépôts (pour import de projets)

---

## Étape 5 — Tester l'intégration

```bash
# Test: initier l'OAuth (doit rediriger vers GitHub)
curl -v http://localhost:4000/api/v1/auth/github

# Attendu: HTTP 302 vers https://github.com/login/oauth/authorize?...
```

---

## Erreurs courantes

| Erreur | Cause | Solution |
|---|---|---|
| `redirect_uri_mismatch` | Callback URL incorrecte | Vérifier que `GITHUB_CALLBACK_URL` correspond exactement au champ dans GitHub |
| `bad_verification_code` | Code expiré ou déjà utilisé | Les codes OAuth expirent en 10 minutes — ne pas réutiliser |
| `401 Unauthorized` | GITHUB_CLIENT_SECRET incorrect | Régénérer le secret dans GitHub OAuth App settings |
| Redirect vers `/auth/sign-in?error=oauth_failed` | JWT non généré | Vérifier JWT_SECRET et les logs backend |

---

## Sécurité

- Ne jamais commiter `GITHUB_CLIENT_SECRET` dans git
- Utiliser des secrets distincts pour dev et production
- Révoquer et régénérer les secrets si compromis via [github.com/settings/developers](https://github.com/settings/developers)
