# CodeMorph — AI-Powered Code Conversion Platform

> **Enterprise SaaS monorepo** that converts codebases between frameworks using GPT-4o, IR (Intermediate Representation), and a 6-phase AI pipeline.

[![CI](https://github.com/YOUR_ORG/codemorph/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR_ORG/codemorph/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    CODEMORPH MONOREPO                   │
├──────────────┬──────────────┬──────────────┬────────────┤
│   frontend   │   backend    │  ai-engine   │   shared   │
│  Next.js 14  │   NestJS     │  Express +   │  Types +   │
│  React+TS    │  TypeORM     │  OpenAI GPT  │  Schemas   │
│  Tailwind    │  Bull+Redis  │  Pipeline    │  Utils     │
└──────────────┴──────────────┴──────────────┴────────────┘
         ↕ REST API          ↕ HTTP callbacks
┌──────────────┬──────────────────────────────────────────┐
│  PostgreSQL  │  Redis (Bull queues)  │  Nginx (proxy)   │
└──────────────┴──────────────────────────────────────────┘
```

### Key Architectural Decision: IR-First Approach
The AI Engine **never outputs final code directly**. Instead:
1. Source code → AST Analysis → Architecture Detection
2. Architecture → **IR (Intermediate Representation)** JSON document
3. IR → Mapping Engine → Code Planner → Generated files

This ensures reproducible, auditable, and editable conversions.

---

## 📦 Monorepo Structure

```
codemorph/
├── frontend/              # Next.js 14 App Router (port 3000)
│   ├── src/app/           # Pages (auth, dashboard, projects, jobs)
│   ├── src/components/    # UI + layout components
│   ├── src/hooks/         # TanStack Query hooks
│   ├── src/stores/        # Zustand stores
│   └── src/lib/api/       # Typed API client (axios)
│
├── backend/               # NestJS API (port 4000)
│   └── src/modules/
│       ├── auth/          # JWT + Google OAuth + GitHub OAuth
│       ├── users/         # User management
│       ├── projects/      # Project CRUD
│       ├── jobs/          # Bull queue job system
│       ├── github/        # GitHub API integration
│       ├── uploads/       # ZIP file upload (Multer)
│       ├── billing/       # Stripe integration
│       ├── analytics/     # Dashboard stats
│       ├── notifications/ # Email (SendGrid/SMTP)
│       └── organizations/ # Multi-tenant support
│
├── ai-engine/             # AI Pipeline Express server (port 5000)
│   └── src/
│       ├── core/          # 6-phase pipeline
│       │   ├── ast-analyzer.ts        # Phase 1: Parse source files
│       │   ├── architecture-detector.ts # Phase 2: Detect patterns
│       │   ├── ir-generator.ts        # Phase 3: Build IR via GPT-4o
│       │   ├── mapping-engine.ts      # Phase 4: Framework mapping
│       │   ├── code-planner.ts        # Phase 5: Plan output files
│       │   └── pipeline.ts            # Orchestrator
│       ├── validators/    # IR validation
│       └── api/           # HTTP endpoints
│
├── shared/                # @codemorph/shared package
│   └── src/
│       ├── types/         # IRDocument, UserBase, ProjectBase…
│       ├── schemas/       # Zod validation schemas
│       ├── constants/     # Routes, queue names, error codes
│       ├── utils/         # slugify, retry, formatBytes…
│       └── contracts/     # API contract interfaces
│
├── infra/
│   ├── docker/            # Dockerfiles (backend, frontend, ai-engine)
│   └── nginx/             # Reverse proxy config
│
├── .github/workflows/     # CI (lint/build) + CD (deploy)
├── docker-compose.yml     # Full stack: postgres + redis + all services
├── codemorph.ir.json      # Example IR document (Flutter→React)
└── .env.example           # All environment variables documented
```

---

## 🚀 Supported Conversions

| Source | Target | Type | Status |
|--------|--------|------|--------|
| Flutter / Dart | React + TypeScript | Frontend | ✅ Stable |
| Flutter / Dart | React Native (Expo) | Mobile | ✅ Stable |
| Express.js | NestJS | Backend | ✅ Stable |
| Node.js | NestJS | Backend | ✅ Stable |

---

## 🔄 Conversion Pipeline (6 Phases)

```
Source Files
    │
    ▼ Phase 1: AST Analysis
    │  Parse imports, exports, classes, functions
    │  Build import graph, detect language
    │
    ▼ Phase 2: Architecture Detection
    │  Detect: BLoC, Provider, MVC, Clean Architecture, Feature-sliced
    │  Hybrid: static patterns + GPT-4o analysis
    │
    ▼ Phase 3: IR Generation (GPT-4o)
    │  Build complete IR document:
    │  projectMeta + architecture + uiGraph +
    │  backendGraph + dataLayer + dependencyMap
    │
    ▼ Phase 4: Framework Mapping
    │  Flutter Widgets → React Components
    │  Flutter Navigation → React Router
    │  BLoC → Zustand stores
    │  Express routes → NestJS controllers
    │
    ▼ Phase 5: Code Planning
    │  Generate complete file manifest from IR
    │  Plan folder structure, imports, exports
    │
    ▼ Phase 6: Validation
       Validate IR completeness & consistency
       Score: 0-100, warnings/errors list
```

---

## 🛠️ Quick Start (Development)

### Prerequisites
- Node.js 20+
- Docker & Docker Compose
- OpenAI API key

### Option A: Docker Compose (recommended)

```bash
# 1. Clone & configure
git clone https://github.com/YOUR_ORG/codemorph.git
cd codemorph
cp .env.example .env
# Edit .env with your values

# 2. Start all services
docker compose up -d

# 3. Access the app
open http://localhost:3000        # Frontend
open http://localhost:4000/docs   # Swagger API docs
open http://localhost:5000/health # AI Engine health
```

### Option B: Local Development

```bash
# Install all dependencies
npm install

# Build shared package first
npm run build --workspace=shared

# Start services individually (in separate terminals):
npm run dev --workspace=backend     # NestJS on :4000
npm run dev --workspace=ai-engine   # AI Engine on :5000
npm run dev --workspace=frontend    # Next.js on :3000
```

---

## 🔐 Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | ✅ | GPT-4o API key |
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `REDIS_URL` | ✅ | Redis connection URL |
| `JWT_SECRET` | ✅ | JWT signing secret (min 32 chars) |
| `JWT_REFRESH_SECRET` | ✅ | Refresh token secret |
| `GITHUB_CLIENT_ID` | ⚠️ | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | ⚠️ | GitHub OAuth app secret |
| `GOOGLE_CLIENT_ID` | ⚠️ | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | ⚠️ | Google OAuth secret |
| `STRIPE_SECRET_KEY` | ⚠️ | Stripe API key (billing) |

---

## 📱 Frontend Pages

| Route | Page | Description |
|-------|------|-------------|
| `/` | Landing | Hero + CTA |
| `/auth/sign-in` | Sign In | OAuth (GitHub/Google) + email |
| `/auth/sign-up` | Sign Up | Registration form |
| `/dashboard` | Dashboard | Stats, recent projects, activity |
| `/dashboard/projects/new` | Import | GitHub repo / ZIP / URL + framework selector |
| `/dashboard/projects/[id]` | Project | Job history, stats |
| `/dashboard/projects/[id]/job/[jobId]` | Job Tracking | Live progress + pipeline phases + logs |
| `/dashboard/projects/[id]/result/[jobId]` | Result Studio | File tree, code viewer, diff, download ZIP, push to GitHub |

---

## 🔌 API Endpoints (Backend)

### Auth
```
POST /api/v1/auth/sign-up          Create account
POST /api/v1/auth/sign-in          Login (email/password)
POST /api/v1/auth/sign-out         Logout
POST /api/v1/auth/refresh          Refresh access token
GET  /api/v1/auth/me               Current user
GET  /api/v1/auth/google           Google OAuth redirect
GET  /api/v1/auth/github           GitHub OAuth redirect
```

### Projects
```
GET  /api/v1/projects              List projects (paginated)
POST /api/v1/projects              Create project
GET  /api/v1/projects/:id          Get project
PATCH /api/v1/projects/:id         Update project
DELETE /api/v1/projects/:id        Delete project
```

### Jobs
```
GET  /api/v1/jobs                  List jobs (paginated)
POST /api/v1/jobs/start/github     Start from GitHub repo
POST /api/v1/jobs/start/zip        Start from ZIP upload
GET  /api/v1/jobs/:id              Get job (with live status)
DELETE /api/v1/jobs/:id            Cancel job
POST /api/v1/jobs/:id/callback     AI Engine callback (internal)
```

### Uploads
```
POST /api/v1/uploads/zip           Upload ZIP file (50MB max)
```

### AI Engine
```
POST /api/convert                  Async conversion (202 + callback)
POST /api/convert/sync             Synchronous (testing)
GET  /api/convert/frameworks       List supported conversions
GET  /health                       Full health check
GET  /health/liveness              Liveness probe (K8s)
GET  /health/readiness             Readiness probe (K8s)
```

---

## 🧠 IR Document Structure

The Intermediate Representation (IR) is the core artifact of CodeMorph. See [`codemorph.ir.json`](./codemorph.ir.json) for a full example.

```typescript
interface IRDocument {
  version: string;
  projectMeta: IRProjectMeta;       // name, languages, entry point
  architecture: IRArchitecture;     // pattern (BLoC/MVC/Clean), layers
  uiGraph: IRUIGraph;               // screens, widgets, navigation, theme
  backendGraph: IRBackendGraph;     // services, state blocs, API methods
  dataLayer: IRDataLayer;           // models, local storage, migrations
  dependencyMap: IRDependencyMap;   // source deps → target deps mapping
  conversionPlan: IRConversionPlan; // output files, phases, notes
  validation: IRValidation;         // score (0-100), warnings, errors
}
```

---

## 🐳 Docker Services

| Service | Port | Description |
|---------|------|-------------|
| `frontend` | 3000 | Next.js 14 app |
| `backend` | 4000 | NestJS API |
| `ai-engine` | 5000 | AI Pipeline server |
| `postgres` | 5432 | PostgreSQL 16 |
| `redis` | 6379 | Redis 7 (Bull queues) |
| `nginx` | 80/443 | Reverse proxy + SSL |
| `pgadmin` | 5050 | DB admin (dev profile) |

---

## 🧪 Tech Stack

### Frontend
- **Next.js 14** — App Router, Server Components
- **React 18** + TypeScript
- **TailwindCSS 3** — Extended design system
- **Radix UI** — Accessible primitives
- **Zustand** — Client state
- **TanStack Query** — Server state
- **CVA** — Variant-based component styling

### Backend
- **NestJS** — Modular Node.js framework
- **TypeORM** + PostgreSQL — Database ORM
- **Bull** + Redis — Job queue system
- **Passport.js** — JWT + OAuth strategies
- **Stripe** — Billing and subscriptions
- **Swagger** — API documentation

### AI Engine
- **Express.js** + TypeScript
- **OpenAI GPT-4o** — IR generation
- **Pino** — Structured logging
- Custom 6-phase pipeline

### DevOps
- **Docker** + Docker Compose
- **GitHub Actions** — CI/CD
- **Nginx** — Reverse proxy

---

## 📄 License

MIT © 2024 CodeMorph
