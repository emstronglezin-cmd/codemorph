# Google OAuth Setup Guide — CodeMorph

## Overview

CodeMorph supporte Google OAuth via Google Cloud Console. Ce guide explique la configuration complète.

---

## Étape 1 — Créer un projet Google Cloud

1. Allez sur [console.cloud.google.com](https://console.cloud.google.com)
2. Cliquez sur le sélecteur de projet → **New Project**
3. Nom : `CodeMorph` → **Create**

---

## Étape 2 — Activer Google OAuth API

1. Dans le menu → **APIs & Services** → **Library**
2. Cherchez **Google+ API** ou **Google Identity** → **Enable**
3. Puis **APIs & Services** → **OAuth consent screen**

### 2.1 Configurer le consent screen

| Champ | Valeur |
|---|---|
| **User Type** | External |
| **App name** | CodeMorph |
| **User support email** | votre email |
| **App logo** | (optionnel) |
| **Authorized domains** | `codemorph.netlify.app`, `onrender.com` |
| **Developer contact email** | votre email |

**Scopes requis** : Cliquez **Add or Remove Scopes** → cochez :
- `openid`
- `email`
- `profile`

---

## Étape 3 — Créer les identifiants OAuth

1. **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth client ID**
2. Application type : **Web application**
3. Nom : `CodeMorph Web`

### Authorized redirect URIs

Ajoutez :

```
# Développement
http://localhost:4000/api/v1/auth/google/callback

# Production
https://codemorph-backend.onrender.com/api/v1/auth/google/callback
```

4. Cliquez **Create** → copiez **Client ID** et **Client Secret**

---

## Étape 4 — Configurer les variables

### Local (développement)

```env
GOOGLE_CLIENT_ID=123456789-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-XXXXXXXXXXXXXXXXXXXXXXXXXX
GOOGLE_CALLBACK_URL=http://localhost:4000/api/v1/auth/google/callback
```

### Production (Render)

| Variable | Valeur |
|---|---|
| `GOOGLE_CLIENT_ID` | `123456789-abc...apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | `GOCSPX-XXXXXXXX` |
| `GOOGLE_CALLBACK_URL` | `https://codemorph-backend.onrender.com/api/v1/auth/google/callback` |

---

## Étape 5 — Tester

```bash
# Test: initier l'OAuth Google
curl -v http://localhost:4000/api/v1/auth/google

# Attendu: HTTP 302 vers https://accounts.google.com/o/oauth2/v2/auth?...
```

---

## Publishing status

En développement, l'app est en mode **Testing** — seuls les test users peuvent s'authentifier.

Pour passer en **Production** :
1. **OAuth consent screen** → **Publish App**
2. Google peut demander une vérification si vous utilisez des scopes sensibles

---

## Erreurs courantes

| Erreur | Solution |
|---|---|
| `redirect_uri_mismatch` | Vérifier les URIs autorisées dans Google Console |
| `access_denied` | User non ajouté aux test users (si app en Testing) |
| `invalid_client` | GOOGLE_CLIENT_SECRET incorrect |
| Pas d'email dans le profil | Vérifier les scopes (email requis) |

---

## Note de sécurité

- Ne jamais exposer `GOOGLE_CLIENT_SECRET` côté frontend
- Les tokens OAuth Google expirent — le backend gère le refresh automatiquement
- Utilisez des credentials distincts pour dev et production
