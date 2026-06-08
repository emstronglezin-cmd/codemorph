# 🚀 CodeMorph — Déploiement Render 100% Gratuit

> **Important** : Le "Blueprint" Render (render.yaml) est réservé aux plans payants.  
> Ce guide utilise le **déploiement manuel** sur le **Free Tier** de Render.

---

## ⚠️ Limites du Free Tier Render

| Service | Plan Free | Contrainte |
|---|---|---|
| **Web Service** | ✅ Gratuit | Sleep après 15min d'inactivité (premier appel ~30s) |
| **PostgreSQL** | ✅ Gratuit 90 jours | Expire après 90 jours — à renouveler |
| **Redis** | ❌ Pas de free tier | → Utiliser **Upstash** (gratuit) |

---

## Étape 0 — Upstash Redis (gratuit, avant Render)

Render n'a pas de Redis gratuit. On utilise **Upstash** :

1. Aller sur **[upstash.com](https://upstash.com)** → **Sign up** (gratuit)
2. **Create Database** :
   - Name: `codemorph-redis`
   - Type: `Regional` | Region: `EU-West-1` (Frankfurt)
   - Plan: **Free** (10 000 req/jour, 256MB)
3. Copier la **REST URL** ou **REDIS_URL** (format `rediss://default:PASSWORD@HOST:PORT`)
4. Garder cette URL pour l'étape 2

> 💡 En V1, Redis est optionnel — il sert uniquement au rate limiting et au cache job.  
> Si vous ne voulez pas Upstash, laissez `REDIS_URL` vide et le backend fonctionnera sans.

---

## Étape 1 — PostgreSQL (gratuit 90 jours)

1. Aller sur **[dashboard.render.com](https://dashboard.render.com)**
2. **New → PostgreSQL**
3. Configurer :
   ```
   Name:     codemorph-postgres
   Region:   Frankfurt (EU Central)
   Plan:     Free ← IMPORTANT : sélectionner Free
   ```
4. Cliquer **Create Database**
5. Attendre ~2 minutes que la DB soit prête
6. Dans la page de la DB, copier **"Internal Database URL"** :
   ```
   postgresql://codemorph:PASSWORD@dpg-XXXXX-a/codemorph
   ```
   > ⚠️ "Internal URL" = uniquement accessible depuis Render (réseau interne)  
   > ⚠️ "External URL" = accessible depuis l'extérieur (pour migrations locales)

---

## Étape 2 — Backend (Web Service gratuit)

### Créer le service

1. **New → Web Service**
2. **Connect a repository** → autoriser GitHub → sélectionner `codemorph`
3. Configurer :
   ```
   Name:              codemorph-backend
   Region:            Frankfurt (EU Central)
   Branch:            main
   Runtime:           Docker
   Dockerfile Path:   ./backend/Dockerfile
   Docker Context:    .    ← racine du repo (IMPORTANT)
   Plan:              Free ← IMPORTANT
   ```
4. **Ne pas encore cliquer Deploy** — ajouter d'abord les variables

### Variables d'environnement (Environment tab)

Cliquer **"Add Environment Variable"** pour chacune :

```bash
# App
NODE_ENV          = production
PORT              = 4000
LOG_LEVEL         = warn

# Database (depuis Étape 1)
DATABASE_URL      = <Internal Database URL depuis Render PostgreSQL>
DATABASE_SSL      = true

# Redis (depuis Étape 0 — laisser vide si pas Upstash)
REDIS_URL         = <URL Upstash ou laisser vide>

# JWT (générer avec : openssl rand -base64 64)
JWT_SECRET        = <générer>
JWT_REFRESH_SECRET = <générer>
JWT_EXPIRES_IN    = 15m
JWT_REFRESH_EXPIRES_IN = 7d
COOKIE_SECRET     = <openssl rand -base64 32>

# CORS
FRONTEND_URL      = https://YOUR-SITE.netlify.app

# GitHub OAuth (depuis docs/GITHUB_OAUTH.md)
GITHUB_CLIENT_ID      = <depuis GitHub OAuth App>
GITHUB_CLIENT_SECRET  = <depuis GitHub OAuth App>
GITHUB_CALLBACK_URL   = https://codemorph-backend.onrender.com/auth/github/callback

# Google OAuth (depuis docs/GOOGLE_OAUTH.md)
GOOGLE_CLIENT_ID      = <depuis Google Cloud Console>
GOOGLE_CLIENT_SECRET  = <depuis Google Cloud Console>
GOOGLE_CALLBACK_URL   = https://codemorph-backend.onrender.com/auth/google/callback

# AI Engine
AI_ENGINE_URL     = https://codemorph-ai.onrender.com
AI_ENGINE_SECRET  = <openssl rand -base64 32>

# Features
FEATURE_BILLING   = false
FEATURE_ANALYTICS = false
```

5. Cliquer **Save → Deploy** (premier build ~5-10 minutes avec Docker)

### URL du backend

Après déploiement : `https://codemorph-backend.onrender.com`

> ⚠️ **Sleep mode** : après 15min sans requête, le service se "dort". Le premier appel prend ~30 secondes pour réveiller le service. C'est normal sur le Free Tier.

---

## Étape 3 — AI Engine (Web Service gratuit)

### Créer le service

1. **New → Web Service**
2. **Connect a repository** → `codemorph`
3. Configurer :
   ```
   Name:              codemorph-ai
   Region:            Frankfurt (EU Central)
   Branch:            main
   Runtime:           Docker
   Dockerfile Path:   ./ai-engine/Dockerfile.render
   Docker Context:    .    ← racine du repo
   Plan:              Free
   ```

### Variables d'environnement

```bash
NODE_ENV          = production
AI_PORT           = 5000
LOG_LEVEL         = warn

# IA — Groq gratuit (RECOMMANDÉ)
GROQ_API_KEY      = <depuis console.groq.com — GRATUIT>

# IA — OpenAI (optionnel — platform tier)
OPENAI_API_KEY    = 

# Sécurité
AI_ENGINE_SECRET  = <même valeur que backend>

# Backend URL
API_URL           = https://codemorph-backend.onrender.com/api/v1
```

4. Cliquer **Save → Deploy**

---

## Étape 4 — Migrations de base de données

Après le premier déploiement du backend, appliquer les migrations :

### Option A : Via Render Shell (recommandé)

1. Dashboard → `codemorph-backend` → **Shell**
2. Dans le terminal :
   ```bash
   cd /app/backend
   npx typeorm migration:run -d dist/database/data-source.js
   ```

### Option B : En local avec l'External URL

```bash
# Depuis votre machine locale
cd codemorph/backend
DATABASE_URL="<External Database URL depuis Render>" npx typeorm migration:run -d dist/database/data-source.js
```

---

## Étape 5 — Configurer Netlify avec l'URL Render

Dans **Netlify Dashboard → Site settings → Environment variables** :

```
NEXT_PUBLIC_API_URL = https://codemorph-backend.onrender.com/api/v1
```

Puis **Trigger deploy** pour que Next.js prenne en compte la nouvelle URL.

---

## Étape 6 — Vérification

```bash
# Backend health check
curl https://codemorph-backend.onrender.com/api/v1/health
# → {"status":"ok",...}

# AI Engine health check
curl https://codemorph-ai.onrender.com/api/health
# → {"status":"ok",...}

# Test conversion
curl -X POST https://codemorph-backend.onrender.com/api/v1/convert/quick \
  -H "Content-Type: application/json" \
  -d '{"source":"flutter","target":"react","code":"void main() {}"}'
```

---

## 🔄 Renouvellement PostgreSQL Free (après 90 jours)

Le PostgreSQL gratuit Render expire après 90 jours. Pour renouveler :

1. Dashboard → `codemorph-postgres` → **Delete**
2. Recréer une nouvelle base PostgreSQL gratuite
3. Mettre à jour `DATABASE_URL` dans le backend
4. Réappliquer les migrations

> 💡 **Alternativement** : Utiliser **Supabase** (PostgreSQL gratuit sans expiration).  
> Voir ci-dessous.

---

## 🎁 Alternative : Supabase (PostgreSQL gratuit permanent)

Si les 90 jours Render sont trop contraignants :

1. **[supabase.com](https://supabase.com)** → New Project
2. Récupérer la **Connection String** (mode `Transaction pooler`)
3. Format : `postgresql://postgres.XXX:PASSWORD@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`
4. Remplacer `DATABASE_URL` dans Render par cette URL
5. Ajouter `DATABASE_SSL=true`

> ✅ Supabase Free : 500MB, 2 projets, pas d'expiration (pause après 1 semaine d'inactivité)

---

## Résumé des URLs de production

| Service | URL |
|---|---|
| **Frontend** | `https://YOUR-SITE.netlify.app` |
| **Backend API** | `https://codemorph-backend.onrender.com` |
| **AI Engine** | `https://codemorph-ai.onrender.com` |
| **PostgreSQL** | Interne Render (pas exposé publiquement) |
| **Redis** | Upstash (accessible via URL) |

---

## Commandes utiles pour générer les secrets

```bash
# JWT_SECRET et JWT_REFRESH_SECRET (64 chars)
openssl rand -base64 64

# COOKIE_SECRET et AI_ENGINE_SECRET (32 chars)
openssl rand -base64 32
```

---

*Guide créé le 2026-06-07 — CodeMorph V1 Free Tier*
