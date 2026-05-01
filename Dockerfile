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

# ---------- Stage 4: runtime (Rootful DinD — requires privileged) -----------
# Base = docker:24-dind which provides dockerd + docker CLI + alpine OS.
# We install Node 20 + pnpm + tsx on top.
#
# This image runs an internal Docker daemon (via dind-entrypoint.sh) so that
# bind mounts the nanoclaw host process performs (workspace/, group folders,
# session DBs in /app/data) all reference paths INSIDE this container — they
# work because dockerd lives in the same filesystem namespace.
#
# Requires the container to be started with --privileged. On Easypanel, set
# the service to run with `privileged: true` in the Compose YAML.
FROM docker:24-dind AS runtime
WORKDIR /app

# Node 20 + tini + curl + sqlite (sqlite for ops/debugging — central + session DBs).
# docker:24-dind already brings docker CLI + dockerd.
RUN apk add --no-cache nodejs npm tini curl sqlite

# pnpm + tsx (needed for running scripts/*.ts inside the container).
# docker:24-dind's apk-installed nodejs doesn't ship corepack, so we install
# pnpm via npm directly.
RUN npm install -g pnpm@10.33.0 tsx@4.19.0

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY scripts ./scripts
COPY groups/monica ./groups/monica
COPY src ./src
COPY tsconfig.json ./

# DinD entrypoint that starts dockerd, waits, optionally pre-pulls, then execs CMD
RUN chmod +x /app/scripts/dind-entrypoint.sh

VOLUME ["/app/data"]
EXPOSE 3001

ENV NODE_ENV=production
ENV NANOCLAW_PORT=3001
# Tells container-runner to skip dev-time bind mounts of /app/src and /app/skills
ENV NANOCLAW_AGENT_SRC_BAKED=true

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS "http://localhost:${NANOCLAW_PORT:-3001}/health" >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/app/scripts/dind-entrypoint.sh"]
CMD ["node", "dist/index.js"]
