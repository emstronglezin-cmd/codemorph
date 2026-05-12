# ============================================================
# CodeMorph — Backend Dockerfile (NestJS)
# Multi-stage build: builder → production
# Target: Render.com (dynamic PORT, health check at /api/v1/health)
# ============================================================

# ── Stage 1: Builder ─────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install build tools for native modules
RUN apk add --no-cache python3 make g++

# Copy workspace root files
COPY package.json ./
COPY tsconfig.base.json ./

# Copy shared package (dependency)
COPY shared/package.json ./shared/
COPY shared/src ./shared/src/

# Copy backend package files
COPY backend/package.json ./backend/
COPY backend/tsconfig.json ./backend/

# Install ALL dependencies (including devDeps for build)
WORKDIR /app/backend
RUN npm install --legacy-peer-deps

# Copy backend source
COPY backend/src ./src/

# Build NestJS
RUN npm run build

# ── Stage 2: Production ──────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

# Security: run as non-root
RUN addgroup -g 1001 -S nodejs && \
    adduser  -S nestjs -u 1001

# Copy workspace structure
COPY package.json ./
COPY tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY shared/src ./shared/src/

# Copy backend package.json
COPY backend/package.json ./backend/

# Install production dependencies only
WORKDIR /app/backend
RUN npm install --omit=dev --legacy-peer-deps && \
    npm cache clean --force

# Copy compiled output from builder
COPY --from=builder /app/backend/dist ./dist/

# Switch to non-root user
USER nestjs

# Expose dynamic port (Render sets $PORT)
EXPOSE 4000

# Health check (Render uses this)
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-4000}/api/v1/health || exit 1

# Start production server
# PORT is injected by Render at runtime
CMD ["node", "dist/main"]
