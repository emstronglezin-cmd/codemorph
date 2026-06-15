# 🤖 CodeMorph — Configuration Groq API (IA Gratuite)

> **Groq** offre Llama 3.1 8B **gratuitement** : 14 400 requêtes/jour, latence <1 seconde.
> C'est l'IA utilisée pour les conversions de code en mode **Free** (utilisateurs sans clé OpenAI).

---

## Étape 1 — Créer un compte Groq (gratuit)

1. Aller sur **[console.groq.com](https://console.groq.com)**
2. Cliquer **"Sign Up"** (gratuit avec GitHub ou email)
3. Valider l'email

---

## Étape 2 — Créer une clé API

1. Dans la console Groq → menu gauche → **"API Keys"**
2. Cliquer **"Create API Key"**
3. Nommer : `codemorph-production`
4. Copier la clé : `gsk_XXXXXXXXXXXXXXXXXXXXXXXXXX`

> ⚠️ La clé ne s'affiche qu'une seule fois — la copier immédiatement

---

## Étape 3 — Ajouter la clé dans Render (AI Engine)

Dans **Render Dashboard → codemorph-ai → Environment** :

```bash
GROQ_API_KEY = gsk_XXXXXXXXXXXXXXXXXXXXXXXXXX
```

C'est tout ! L'AI Engine détecte automatiquement la clé et utilise Groq.

---

## Comment ça fonctionne dans CodeMorph

```
Utilisateur Free
    ↓
Backend NestJS → AI Engine
    ↓
ai-provider.ts
    ├── GROQ_API_KEY présent → Groq Llama 3.1 8B ✅ (gratuit)
    ├── OPENAI_API_KEY présent → GPT-4o-mini (plateforme)
    └── Rien → Mode statique (templates prédéfinis)

Utilisateur Pro (sa propre clé)
    ↓
    ├── openaiKey dans profil → GPT-4o
    └── anthropicKey dans profil → Claude 3.5 Sonnet
```

---

## Limites Groq Free

| Paramètre | Limite |
|-----------|--------|
| Requêtes/minute | 30 |
| Tokens/minute | 6 000 |
| Requêtes/jour | 14 400 |
| Tokens/jour | ~500 000 |
| Modèle | llama-3.1-8b-instant |
| Contexte max | 128K tokens |

Pour CodeMorph, chaque conversion utilise ~1 500 tokens → **~330 conversions gratuites/jour**.

---

## Variables d'environnement complètes pour Render

### Backend (`codemorph-backend`)

```bash
# ── App ──────────────────────────────────────────────────────────
NODE_ENV          = production
PORT              = 4000
LOG_LEVEL         = warn

# ── Base de données Supabase ──────────────────────────────────────
# → Depuis supabase.com → Project Settings → Database → Transaction pooler
DATABASE_URL      = postgresql://postgres.XXXXXXXXXX:PASSWORD@aws-0-eu-west-2.pooler.supabase.com:6543/postgres
DATABASE_SSL      = true

# ── Redis Upstash (optionnel) ─────────────────────────────────────
# → Depuis upstash.com → votre base → "REDIS_URL"
# → Laisser vide si pas encore configuré
REDIS_URL         = rediss://default:PASSWORD@HOST:PORT

# ── JWT — GÉNÉRER AVEC : openssl rand -base64 64 ──────────────────
JWT_SECRET            = <openssl rand -base64 64>
JWT_REFRESH_SECRET    = <openssl rand -base64 64>
JWT_EXPIRES_IN        = 15m
JWT_REFRESH_EXPIRES_IN = 7d
COOKIE_SECRET         = <openssl rand -base64 32>

# ── CORS — URL Vercel du frontend ─────────────────────────────────
# → Depuis Vercel Dashboard → votre projet → URL de déploiement
FRONTEND_URL      = https://codemorph-XXXX.vercel.app

# ── GitHub OAuth ──────────────────────────────────────────────────
# → Depuis github.com/settings/developers → OAuth Apps → codemorph
GITHUB_CLIENT_ID      = Ov23li...
GITHUB_CLIENT_SECRET  = ...
GITHUB_CALLBACK_URL   = https://codemorph-backend.onrender.com/api/v1/auth/github/callback

# ── Google OAuth ──────────────────────────────────────────────────
# → Depuis console.cloud.google.com → APIs → Credentials
GOOGLE_CLIENT_ID      = ...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET  = GOCSPX-...
GOOGLE_CALLBACK_URL   = https://codemorph-backend.onrender.com/api/v1/auth/google/callback

# ── AI Engine ─────────────────────────────────────────────────────
AI_ENGINE_URL     = https://codemorph-ai.onrender.com
AI_ENGINE_SECRET  = <openssl rand -base64 32>

# ── Features ─────────────────────────────────────────────────────
FEATURE_BILLING   = false
FEATURE_ANALYTICS = false
```

### AI Engine (`codemorph-ai`)

```bash
# ── App ──────────────────────────────────────────────────────────
NODE_ENV          = production
AI_PORT           = 5000
LOG_LEVEL         = warn

# ── Groq (GRATUIT — REQUIS pour les conversions) ──────────────────
# → Depuis console.groq.com → API Keys
GROQ_API_KEY      = gsk_XXXXXXXXXXXXXXXXXXXXXXXXXX

# ── OpenAI (optionnel — pour le mode Platform) ────────────────────
# → Laisser vide si vous ne voulez pas payer
OPENAI_API_KEY    =

# ── Sécurité ──────────────────────────────────────────────────────
AI_ENGINE_SECRET  = <même valeur que backend AI_ENGINE_SECRET>

# ── Backend URL ───────────────────────────────────────────────────
API_URL           = https://codemorph-backend.onrender.com/api/v1
```

---

## Vérification après configuration

```bash
# 1. Tester le backend
curl https://codemorph-backend.onrender.com/api/v1/health
# → {"status":"ok","database":{"status":"up"},...}

# 2. Tester l'AI Engine
curl https://codemorph-ai.onrender.com/api/health
# → {"status":"ok","ai":{"tier":"free-groq","model":"llama-3.1-8b-instant"}}

# 3. Tester l'inscription
curl -X POST https://codemorph-backend.onrender.com/api/v1/auth/sign-up \
  -H "Content-Type: application/json" \
  -d '{"name":"Test User","email":"test@example.com","password":"test1234!"}'
# → {"data":{"user":{...},"tokens":{"accessToken":"eyJ..."}}}
```

---

## GitHub OAuth — Configuration

1. Aller sur **[github.com/settings/developers](https://github.com/settings/developers)**
2. **OAuth Apps → New OAuth App**
3. Configurer :
   ```
   Application name:   CodeMorph
   Homepage URL:       https://codemorph-XXXX.vercel.app
   Callback URL:       https://codemorph-backend.onrender.com/api/v1/auth/github/callback
   ```
4. Copier `Client ID` et `Client Secret`
5. Les mettre dans Render → `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET`

## Google OAuth — Configuration

1. Aller sur **[console.cloud.google.com](https://console.cloud.google.com)**
2. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
3. Type : **Web application**
4. Ajouter dans "Authorized redirect URIs" :
   ```
   https://codemorph-backend.onrender.com/api/v1/auth/google/callback
   ```
5. Copier `Client ID` et `Client Secret`
6. Les mettre dans Render → `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`

---

*Guide créé le 2026-06-15 — CodeMorph V1*
