# 🚀 CodeMorph — Guide de Déploiement Netlify

> **Prérequis** : Repo GitHub poussé, backend Render en ligne, variables d'environnement prêtes.

---

## 1. Connecter le repo GitHub à Netlify

### Étape 1 — Créer un nouveau site

1. Aller sur **[app.netlify.com](https://app.netlify.com)**
2. Cliquer **"Add new site"** → **"Import an existing project"**
3. Choisir **"Deploy with GitHub"**
4. Autoriser Netlify à accéder à votre compte GitHub
5. Sélectionner le repo `codemorph`

### Étape 2 — Configurer le build

Netlify devrait détecter automatiquement `frontend/netlify.toml`. Vérifier ces paramètres :

| Champ | Valeur |
|---|---|
| **Base directory** | `frontend` |
| **Build command** | `npm install --legacy-peer-deps && npm run build` |
| **Publish directory** | `frontend/.next` |
| **Node.js version** | `20` |

> ✅ Le fichier `frontend/netlify.toml` contient déjà toute cette configuration.

### Étape 3 — Ajouter les variables d'environnement

Dans **Site settings > Environment variables**, ajouter :

```
NEXT_PUBLIC_API_URL          = https://codemorph-backend.onrender.com/api/v1
NEXT_PUBLIC_APP_URL          = https://YOUR-SITE.netlify.app
NEXT_PUBLIC_FEATURE_BILLING  = false
NEXT_PUBLIC_FEATURE_ANALYTICS = false
NEXT_TELEMETRY_DISABLED      = 1
```

> ⚠️ Remplacer `codemorph-backend.onrender.com` par l'URL réelle de votre service Render.  
> ⚠️ Remplacer `YOUR-SITE.netlify.app` par l'URL Netlify attribuée après le premier déploiement.

### Étape 4 — Lancer le premier déploiement

1. Cliquer **"Deploy site"**
2. Netlify lance automatiquement `npm install --legacy-peer-deps && npm run build`
3. Le déploiement prend ~3-5 minutes
4. Une URL publique est générée : `https://RANDOM-NAME.netlify.app`

---

## 2. Configurer un domaine personnalisé (optionnel)

1. **Site settings > Domain management > Add custom domain**
2. Entrer votre domaine : `codemorph.io`
3. Suivre les instructions DNS (ajouter un CNAME ou A record)
4. Netlify provisionne automatiquement un certificat SSL Let's Encrypt

---

## 3. Activer le plugin @netlify/plugin-nextjs

Le plugin est déjà déclaré dans `frontend/netlify.toml` :

```toml
[[plugins]]
  package = "@netlify/plugin-nextjs"
```

Ce plugin permet :
- **SSR** (Server-Side Rendering) via Netlify Edge Functions
- **API Routes** Next.js déployées comme fonctions serverless
- **Image Optimization** via Netlify CDN
- **ISR** (Incremental Static Regeneration)

> 💡 Netlify installe ce plugin automatiquement depuis la config `netlify.toml`. Pas d'action manuelle requise.

---

## 4. Déploiements automatiques (CI/CD)

Après la connexion GitHub, chaque `git push origin main` déclenche automatiquement :

```
GitHub Push → Netlify Webhook → npm install --legacy-peer-deps && npm run build → Deploy
```

### Déploiements de preview (Pull Requests)

Chaque Pull Request génère un **deploy preview** avec son propre URL :
```
https://deploy-preview-42--YOUR-SITE.netlify.app
```

---

## 5. Variables d'environnement complètes

### Variables publiques (exposées au navigateur, préfixe `NEXT_PUBLIC_`)

| Variable | Description | Exemple |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | URL de l'API backend | `https://codemorph-backend.onrender.com/api/v1` |
| `NEXT_PUBLIC_APP_URL` | URL du frontend | `https://codemorph.netlify.app` |
| `NEXT_PUBLIC_FEATURE_BILLING` | Activer Stripe | `false` (V1) / `true` (V2) |
| `NEXT_PUBLIC_FEATURE_ANALYTICS` | Activer analytics | `false` (V1) |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Clé publique Stripe | `pk_live_...` |

### Variables privées (build-time uniquement)

| Variable | Description |
|---|---|
| `NEXT_TELEMETRY_DISABLED` | Désactiver télémétrie Next.js |
| `HUSKY` | `0` (déjà dans netlify.toml) |

---

## 6. Résolution des erreurs courantes

### ❌ `husky: command not found`
**Cause** : Husky tente de s'installer en CI  
**Fix** : Déjà résolu — `HUSKY=0` dans `netlify.toml` + `"prepare": "husky install || true"` dans `package.json`

### ❌ `peer dep conflict` / `npm ERESOLVE`
**Cause** : Conflits de peer deps React 18  
**Fix** : Déjà résolu — `npm install --legacy-peer-deps` dans la build command

### ❌ `Module not found: Can't resolve '@/components/...'`
**Cause** : Alias TypeScript non résolu  
**Fix** : Vérifier `tsconfig.json` → `"paths": { "@/*": ["./src/*"] }` et `next.config.ts`

### ❌ `Build failed: Cannot find module '@netlify/plugin-nextjs'`
**Cause** : Plugin manquant  
**Fix** : Netlify installe les plugins déclarés dans `netlify.toml` automatiquement. Si erreur persistante, ajouter dans `frontend/package.json` devDependencies : `"@netlify/plugin-nextjs": "^5.0.0"`

### ❌ `NEXT_PUBLIC_API_URL` non défini au build
**Cause** : Variable ajoutée après le premier build  
**Fix** : **Site settings > Environment variables** → Ajouter la variable → **Trigger new deploy** (bouton dans l'interface Netlify)

### ❌ OAuth redirect vers localhost
**Cause** : `NEXTAUTH_URL` ou callbacks OAuth pointent vers localhost  
**Fix** : Mettre à jour les callbacks dans GitHub OAuth App et Google OAuth avec l'URL Netlify production. Voir `docs/GITHUB_OAUTH.md` et `docs/GOOGLE_OAUTH.md`.

---

## 7. Vérification post-déploiement

Après déploiement, tester ces URLs :

```bash
# Page d'accueil
curl -I https://YOUR-SITE.netlify.app

# Page de connexion
curl -I https://YOUR-SITE.netlify.app/auth/sign-in

# Page dashboard (doit rediriger vers /auth/sign-in si non connecté)
curl -I https://YOUR-SITE.netlify.app/dashboard
```

### Checklist post-déploiement

- [ ] Page d'accueil se charge correctement
- [ ] Bouton "Sign in with GitHub" redirige vers GitHub (pas localhost)
- [ ] Bouton "Sign in with Google" redirige vers Google (pas localhost)
- [ ] Console navigateur : aucune erreur critique
- [ ] `NEXT_PUBLIC_API_URL` correctement injecté (vérifier via DevTools Network)
- [ ] PWA : site installable (icône dans la barre d'adresse Chrome)

---

## 8. Structure du repo pour Netlify

```
codemorph/                     ← Racine du repo GitHub
├── frontend/                  ← Base directory Netlify
│   ├── netlify.toml           ← Configuration Netlify (auto-détectée)
│   ├── next.config.ts         ← Config Next.js
│   ├── package.json           ← Dépendances frontend
│   └── src/                   ← Code source Next.js
├── backend/                   ← Déployé séparément sur Render
├── ai-engine/                 ← Déployé séparément sur Render
├── docs/                      ← Documentation
└── render.yaml                ← Config Render (ignoré par Netlify)
```

---

## 9. Logs et monitoring

- **Build logs** : Netlify Dashboard → Deploys → Cliquer sur un deploy → "Deploy log"
- **Function logs** : Netlify Dashboard → Functions → Logs (pour les API routes Next.js)
- **Analytics** : Netlify Dashboard → Analytics (si activé)

---

*Guide créé le 2026-06-07 — CodeMorph V1*
