# 🗄️ CodeMorph — Supabase PostgreSQL Setup

> **Pourquoi Supabase ?**  
> Render PostgreSQL Free expire après **90 jours** et supprime toutes les données.  
> Supabase offre PostgreSQL gratuit **sans expiration** (pause après 7 jours d'inactivité, pas de suppression).

---

## ✅ Plan gratuit Supabase

| Ressource | Limite gratuite |
|-----------|----------------|
| Projets   | 2 projets       |
| Stockage DB | 500 MB        |
| Bande passante | 5 GB/mois  |
| Expiration | ❌ Aucune (pause après 7j inactivité) |
| SSL       | ✅ Obligatoire  |

---

## Étape 1 — Créer un projet Supabase

1. Aller sur **[supabase.com](https://supabase.com)** → **Sign up** (gratuit avec GitHub)
2. Cliquer **"New project"**
3. Configurer :
   ```
   Organization:    (votre org ou personal)
   Project name:    codemorph
   Database Password: <choisir un mot de passe fort — le noter>
   Region:          EU West 2 (London)  ← le plus proche de Render EU
   Plan:            Free
   ```
4. Cliquer **"Create new project"** → attendre ~2 minutes

---

## Étape 2 — Récupérer la Connection String

1. Dans le dashboard Supabase → **Project Settings** (icône engrenage)
2. Aller dans **"Database"** → section **"Connection string"**
3. Choisir l'onglet **"Transaction pooler"** (recommandé pour NestJS/TypeORM)
4. Copier la connection string — format :
   ```
   postgresql://postgres.XXXXXXXXXX:YOUR-PASSWORD@aws-0-eu-west-2.pooler.supabase.com:6543/postgres
   ```
   > ⚠️ Remplacer `[YOUR-PASSWORD]` par le mot de passe choisi à l'étape 1

### Types de connections disponibles

| Mode | Port | Usage recommandé |
|------|------|-----------------|
| **Transaction pooler** | 6543 | ✅ **API/Backend** — une connexion par requête |
| **Session pooler** | 5432 | Applications longue durée |
| **Direct connection** | 5432 | Migrations (depuis machine locale) |

---

## Étape 3 — Configurer Render (variables d'environnement)

Dans **Render Dashboard → codemorph-backend → Environment** :

### Modifier / Ajouter ces variables :

```bash
# ── Base de données Supabase ──────────────────────────────────
DATABASE_URL = postgresql://postgres.XXXXXXXXXX:YOUR-PASSWORD@aws-0-eu-west-2.pooler.supabase.com:6543/postgres
DATABASE_SSL = true

# ── Supprimer ou laisser vides (plus utilisées avec DATABASE_URL) ──
# DATABASE_HOST  (laisser vide)
# DATABASE_PORT  (laisser vide)
# DATABASE_USER  (laisser vide)
# DATABASE_PASSWORD (laisser vide)
# DATABASE_NAME  (laisser vide)
```

> ✅ `DATABASE_SSL=true` active `{ rejectUnauthorized: false }` dans TypeORM  
> ✅ Le code détecte aussi automatiquement Supabase si l'URL contient `supabase.com`

---

## Étape 4 — Appliquer les migrations TypeORM

Les migrations créent les tables dans Supabase.

### Option A — Via Render Shell (recommandé)

1. Dashboard Render → `codemorph-backend` → onglet **Shell**
2. Exécuter :
   ```bash
   cd /app/backend
   DATABASE_URL="postgresql://postgres.XXX:PWD@aws-0-eu-west-2.pooler.supabase.com:6543/postgres" \
   DATABASE_SSL=true \
   npx typeorm migration:run -d dist/database/data-source.js
   ```

### Option B — En local avec la Direct Connection URL

Depuis **Project Settings → Database → Direct connection** (port 5432) :

```bash
cd codemorph/backend
DATABASE_URL="postgresql://postgres.XXX:PWD@db.XXXXXXXXXX.supabase.co:5432/postgres" \
DATABASE_SSL=true \
npx typeorm migration:run -d dist/database/data-source.js
```

> 💡 La **Direct Connection** (port 5432) est préférable pour les migrations car elle évite les limites du pooler de transactions.

### Option C — TypeORM synchronize (dev uniquement)

Si `NODE_ENV !== 'production'`, TypeORM crée les tables automatiquement au démarrage.  
⚠️ **Ne jamais utiliser `synchronize: true` en production** — risque de perte de données.

---

## Étape 5 — Vérifier la connexion

### Depuis Render Shell :
```bash
# Health check backend
curl https://codemorph-backend.onrender.com/api/v1/health
# → {"status":"ok","database":{"status":"up"},...}
```

### Depuis Supabase Dashboard :
1. **Table Editor** → vérifier que les tables sont créées
2. **SQL Editor** → tester :
   ```sql
   SELECT COUNT(*) FROM users;
   ```

---

## 🔄 Gestion de la pause Supabase (inactivité 7 jours)

Supabase **pause** les projets Free après 7 jours sans requête.  
Le projet se **réactive automatiquement** à la première connexion (~30 secondes).

### Pour éviter la pause automatique :
- Configurer un **cron job** qui ping la DB toutes les 24h
- Ou upgrader vers le plan Pro ($25/mois) pour désactiver la pause

### Réactiver manuellement un projet pausé :
1. Dashboard Supabase → votre projet → bouton **"Restore project"**
2. Attendre ~2 minutes

---

## 🆚 Comparaison Render vs Supabase

| Critère | Render PostgreSQL | Supabase |
|---------|-------------------|---------|
| **Durée** | ⚠️ Expire 90 jours | ✅ Permanent |
| **Pause** | ✗ | ✅ Pause après 7j inactivité (pas de suppression) |
| **SSL** | Requis en production | ✅ Toujours requis |
| **Migrations** | Via Render Shell | Via Supabase Shell ou local |
| **Interface** | Basique | ✅ Table Editor, SQL Editor, Auth, Storage |
| **Prix** | Gratuit 90j | ✅ Gratuit sans limite de temps |

---

## Variables d'environnement complètes (production)

```bash
# ── Base de données Supabase ──────────────────────────────────
DATABASE_URL=postgresql://postgres.XXXXXXXXXX:YOUR-PASSWORD@aws-0-eu-west-2.pooler.supabase.com:6543/postgres
DATABASE_SSL=true

# ── App ──────────────────────────────────────────────────────
NODE_ENV=production
PORT=4000
LOG_LEVEL=warn

# ── Redis Upstash (optionnel) ─────────────────────────────────
REDIS_URL=rediss://default:PASSWORD@HOST:PORT

# ── JWT ───────────────────────────────────────────────────────
JWT_SECRET=<openssl rand -base64 64>
JWT_REFRESH_SECRET=<openssl rand -base64 64>
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
COOKIE_SECRET=<openssl rand -base64 32>

# ── CORS ─────────────────────────────────────────────────────
FRONTEND_URL=https://YOUR-PROJECT.vercel.app

# ── OAuth ────────────────────────────────────────────────────
GITHUB_CLIENT_ID=<depuis GitHub OAuth App>
GITHUB_CLIENT_SECRET=<depuis GitHub OAuth App>
GITHUB_CALLBACK_URL=https://codemorph-backend.onrender.com/api/v1/auth/github/callback

GOOGLE_CLIENT_ID=<depuis Google Cloud Console>
GOOGLE_CLIENT_SECRET=<depuis Google Cloud Console>
GOOGLE_CALLBACK_URL=https://codemorph-backend.onrender.com/api/v1/auth/google/callback

# ── AI Engine ─────────────────────────────────────────────────
AI_ENGINE_URL=https://codemorph-ai.onrender.com
AI_ENGINE_SECRET=<openssl rand -base64 32>

# ── Features ─────────────────────────────────────────────────
FEATURE_BILLING=false
FEATURE_ANALYTICS=false
```

---

*Guide créé le 2026-06-12 — Migration Render PostgreSQL → Supabase*
