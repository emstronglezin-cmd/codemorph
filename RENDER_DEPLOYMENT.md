# CodeMorph — Render Deployment Guide

Deploy the CodeMorph backend (NestJS) to **Render.com** in under 15 minutes using the Blueprint `render.yaml` at the repository root.

---

## Architecture on Render

```
GitHub (main branch)
  └── Render Blueprint (render.yaml)
        ├── codemorph-backend   Web Service (Docker, NestJS API)
        ├── codemorph-redis     Redis (Bull queues)
        └── codemorph-postgres  PostgreSQL (user data, conversions)
```

**Estimated cost**: ~$24/mo (starter plan for all three services).

---

## Step 1 — Connect Repository

1. Log in at [dashboard.render.com](https://dashboard.render.com)
2. **New → Blueprint**
3. Connect your GitHub account → select **`codemorph`** repository
4. Render detects `render.yaml` automatically → click **Apply Blueprint**

---

## Step 2 — Set Required Secrets

After the Blueprint is applied, open **codemorph-backend → Environment** and fill in every variable marked `sync: false`:

| Variable | Description | Example / How to get it |
|---|---|---|
| `JWT_SECRET` | Access token signing key | `openssl rand -base64 64` |
| `JWT_REFRESH_SECRET` | Refresh token signing key | `openssl rand -base64 64` |
| `COOKIE_SECRET` | Session cookie encryption | `openssl rand -base64 32` |
| `FRONTEND_URL` | Your Netlify URL (CORS) | `https://codemorph.netlify.app` |
| `GOOGLE_CLIENT_ID` | Google OAuth App ID | [console.cloud.google.com](https://console.cloud.google.com) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth secret | Same console |
| `GOOGLE_CALLBACK_URL` | OAuth redirect URI | `https://codemorph-backend.onrender.com/api/v1/auth/google/callback` |
| `GITHUB_CLIENT_ID` | GitHub OAuth App ID | [github.com/settings/developers](https://github.com/settings/developers) |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth secret | Same page |
| `GITHUB_CALLBACK_URL` | OAuth redirect URI | `https://codemorph-backend.onrender.com/api/v1/auth/github/callback` |
| `AI_ENGINE_URL` | AI engine endpoint (if separate) | `https://codemorph-ai.onrender.com` |
| `STRIPE_SECRET_KEY` | Stripe server-side key | [dashboard.stripe.com/apikeys](https://dashboard.stripe.com/apikeys) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signature | See Step 4 |

### Generate secrets quickly

```bash
# JWT_SECRET
openssl rand -base64 64

# JWT_REFRESH_SECRET
openssl rand -base64 64

# COOKIE_SECRET
openssl rand -base64 32
```

---

## Step 3 — Auto-injected Variables

These are **automatically wired** by `render.yaml` — do **not** set them manually:

| Variable | Source |
|---|---|
| `DATABASE_URL` | Injected from `codemorph-postgres` service |
| `REDIS_URL` | Injected from `codemorph-redis` service |
| `PORT` | Injected by Render at runtime |
| `NODE_ENV` | Set to `production` in `render.yaml` |

---

## Step 4 — Stripe Webhook

1. [dashboard.stripe.com → Developers → Webhooks](https://dashboard.stripe.com/webhooks) → **Add endpoint**
2. URL: `https://codemorph-backend.onrender.com/api/v1/billing/webhook`
3. Events to listen: `checkout.session.completed`, `invoice.payment_succeeded`, `customer.subscription.deleted`
4. Copy **Signing secret** → paste as `STRIPE_WEBHOOK_SECRET` in Render dashboard

---

## Step 5 — OAuth Callback URLs

### Google

1. [console.cloud.google.com → APIs → Credentials](https://console.cloud.google.com/apis/credentials)
2. Edit your OAuth 2.0 client → **Authorized redirect URIs** → add:
   ```
   https://codemorph-backend.onrender.com/api/v1/auth/google/callback
   ```

### GitHub

1. [github.com/settings/developers → OAuth Apps](https://github.com/settings/developers)
2. Edit your app → **Authorization callback URL**:
   ```
   https://codemorph-backend.onrender.com/api/v1/auth/github/callback
   ```

---

## Step 6 — Frontend (.env.local / Netlify)

Set these in **Netlify → Site configuration → Environment variables**:

```env
NEXT_PUBLIC_API_URL=https://codemorph-backend.onrender.com/api/v1
NEXT_PUBLIC_APP_URL=https://codemorph.netlify.app
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_...
NEXT_PUBLIC_FEATURE_BILLING=true
NEXT_PUBLIC_FEATURE_ANALYTICS=true
```

---

## Step 7 — First Deploy Verification

Once Render finishes the build (~5 min), verify:

```bash
# Health check
curl https://codemorph-backend.onrender.com/api/v1/health

# Expected response:
# {"status":"ok","timestamp":"...","version":"1.0.0"}
```

---

## Deployment Checklist

- [ ] Blueprint applied in Render dashboard
- [ ] `JWT_SECRET` set (64-byte random)
- [ ] `JWT_REFRESH_SECRET` set (64-byte random)
- [ ] `COOKIE_SECRET` set (32-byte random)
- [ ] `FRONTEND_URL` set to Netlify URL
- [ ] Google OAuth credentials configured + callback URL added
- [ ] GitHub OAuth credentials configured + callback URL added
- [ ] Stripe secret key + webhook secret configured
- [ ] `AI_ENGINE_URL` set (if AI engine deployed separately)
- [ ] Health check returns `200 OK`
- [ ] Frontend `NEXT_PUBLIC_API_URL` points to Render backend

---

## Costs (Frankfurt region, Starter plans)

| Service | Plan | Cost/mo |
|---|---|---|
| `codemorph-backend` | Starter (512 MB RAM) | $7 |
| `codemorph-redis` | Starter (25 MB) | $10 |
| `codemorph-postgres` | Starter (1 GB) | $7 |
| **Total** | | **$24/mo** |

> Upgrade `codemorph-backend` to **Standard** ($25/mo, 2 GB RAM) when handling production traffic.

---

## Troubleshooting

**Build fails with "Cannot find module '@codemorph/shared'"**  
→ The Dockerfile builds `shared/` before `backend/`. Verify `backend/package.json` has `"@codemorph/shared": "file:../shared"`.

**`DATABASE_URL` is undefined at startup**  
→ Wait for `codemorph-postgres` to finish provisioning (can take 2–3 min before the web service starts).

**Health check fails → service marked unhealthy**  
→ Check logs in Render dashboard. Common cause: missing `JWT_SECRET` or `DATABASE_URL` not yet injected. Re-deploy after setting all secrets.

**Stripe webhook returns 400**  
→ Verify `STRIPE_WEBHOOK_SECRET` matches the **Signing secret** shown in Stripe dashboard (not the API key).
