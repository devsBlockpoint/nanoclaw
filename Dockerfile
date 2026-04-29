# syntax=docker/dockerfile:1.7
# ============================================================================
# nanoclaw HOST — Easypanel-targeted image
# ============================================================================
# Runs the host process inside a container. Talks to the host's Docker daemon
# via a mounted /var/run/docker.sock to spawn per-session nanoclaw-agent
# containers.
#
# Persistent data MUST live in a volume mounted at /app/data (SQLite DBs,
# logs, group filesystem state).
# ============================================================================

# ---------- Stage 1: install all deps (build + runtime) ---------------------
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++ \
  && corepack enable \
  && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --ignore-scripts \
  && pnpm rebuild better-sqlite3

# ---------- Stage 2: compile TS to dist/ ------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++ \
  && corepack enable \
  && corepack prepare pnpm@10.33.0 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json ./
COPY src ./src
RUN pnpm exec tsc

# ---------- Stage 3: production deps only -----------------------------------
FROM node:20-alpine AS prod-deps
WORKDIR /app
RUN apk add --no-cache python3 make g++ \
  && corepack enable \
  && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts \
  && pnpm rebuild better-sqlite3

# ---------- Stage 4: runtime ------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app

# docker-cli to talk to the mounted host daemon, plus tini for proper signal
# handling, plus curl for healthcheck (more reliable than busybox wget).
RUN apk add --no-cache docker-cli tini curl

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY scripts ./scripts
COPY groups/monica ./groups/monica
COPY src ./src
COPY tsconfig.json ./

VOLUME ["/app/data"]
EXPOSE 3001

ENV NODE_ENV=production
ENV NANOCLAW_PORT=3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS "http://localhost:${NANOCLAW_PORT:-3001}/health" >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
