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

# ---------- Stage 4: runtime (Rootless DinD — no privileged needed) ---------
# Base = docker:24-dind-rootless which provides dockerd + rootlesskit +
# slirp4netns + fuse-overlayfs and runs as non-root user (uid 1000).
# Designed specifically for environments where --privileged is unavailable
# (e.g., Easypanel, Kubernetes without privileged pod).
#
# Requirements on the host (most modern Linux kernels satisfy these):
#   - kernel.unprivileged_userns_clone = 1
#   - /dev/fuse accessible
#   - Seccomp not blocking clone(NEWUSER)
#
# If those are missing, fall back to a VM with native Docker.
FROM docker:24-dind-rootless AS runtime

# Switch to root briefly to install Node + tooling + copy app files
USER root
WORKDIR /app

RUN apk add --no-cache nodejs npm tini curl
RUN npm install -g pnpm@10.33.0 tsx@4.19.0

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY scripts ./scripts
COPY groups/monica ./groups/monica
COPY src ./src
COPY tsconfig.json ./

# Make /app writable by rootless user (uid 1000 in this image)
RUN mkdir -p /app/data && chown -R rootless:rootless /app

RUN chmod +x /app/scripts/dind-rootless-cmd.sh

VOLUME ["/app/data"]
EXPOSE 3001

ENV NODE_ENV=production
ENV NANOCLAW_PORT=3001
ENV NANOCLAW_AGENT_SRC_BAKED=true

# Drop back to rootless user (uid 1000) for runtime
USER rootless

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD curl -fsS "http://localhost:${NANOCLAW_PORT:-3001}/health" >/dev/null || exit 1

# Upstream entrypoint (dockerd-entrypoint.sh) starts dockerd-rootless in
# background and execs CMD. Our CMD wrapper waits for the socket, sets
# DOCKER_HOST, optionally pre-pulls, then runs nanoclaw.
ENTRYPOINT ["dockerd-entrypoint.sh"]
CMD ["/app/scripts/dind-rootless-cmd.sh", "node", "/app/dist/index.js"]
