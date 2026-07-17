# ============================================================
# CodeMorph — Backend Dockerfile (NestJS)
# 3-Stage: deps → builder → production
# Target: Render.com (dynamic PORT via env, health /api/v1/health)
# Build context: repo root (docker build -f backend/Dockerfile .)
# ============================================================

# ── Stage 1: deps — install all dependencies ─────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Build tools for native modules (bcrypt, etc.)
RUN apk add --no-cache python3 make g++ dumb-init

# ── Workspace root ──────────────────────────────────────────
COPY package.json tsconfig.base.json ./

# ── Shared package ──────────────────────────────────────────
COPY shared/package.json ./shared/
COPY shared/tsconfig.json ./shared/
COPY shared/src ./shared/src/

# ── Backend package ─────────────────────────────────────────
COPY backend/package.json ./backend/
COPY backend/tsconfig.json ./backend/

# Install ALL deps (dev + prod) — workspace-aware
WORKDIR /app/backend
RUN npm install --legacy-peer-deps

# ── Stage 2: builder — compile shared + backend ──────────────
FROM deps AS builder

WORKDIR /app

# Build shared first (backend depends on @codemorph/shared)
COPY shared/src ./shared/src/
WORKDIR /app/shared
RUN npm run build 2>/dev/null || npx tsc -p tsconfig.json || true

# Build backend
COPY backend/src /app/backend/src/
WORKDIR /app/backend
RUN npm run build

# ── Stage 3: production — minimal runtime image ───────────────
FROM node:20-alpine AS production

# dumb-init: proper PID 1 signal handling (Ctrl+C, SIGTERM)
RUN apk add --no-cache dumb-init

WORKDIR /app

# Security: non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser  -S nestjs -u 1001

# ── Workspace structure (needed for module resolution) ───────
COPY package.json tsconfig.base.json ./
COPY shared/package.json ./shared/

# ── Backend prod deps only ───────────────────────────────────
COPY backend/package.json ./backend/
WORKDIR /app/backend
RUN npm install --omit=dev --legacy-peer-deps && \
    npm cache clean --force

# ── Compiled artifacts ────────────────────────────────────────
COPY --from=builder /app/backend/dist ./dist/
# Copy shared dist (nécessaire pour @codemorph/shared résolution à runtime)
COPY --from=builder /app/shared/dist /app/shared/dist/
COPY --from=builder /app/shared/package.json /app/shared/package.json

# ── Runtime ───────────────────────────────────────────────────
USER nestjs

# Render injects $PORT dynamically — default 4000
EXPOSE 4000

# Render health check — must return 200 within start-period
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-4000}/api/v1/health || exit 1

# dumb-init as PID 1 — handles SIGTERM properly for zero-downtime deploys
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/main"]
