#!/bin/sh
# DinD entrypoint for nanoclaw-host on Easypanel (privileged container).
#
# Starts an internal dockerd, waits for it to be ready, optionally pre-pulls
# the agent image, then execs the main command. nanoclaw-host then talks to
# this internal dockerd via /var/run/docker.sock — bind mounts and named
# volumes work normally because everything lives inside this container.
set -e

DIND_LOG=/tmp/dockerd.log
DIND_TIMEOUT=30

echo "[dind-entrypoint] starting dockerd..."
dockerd \
  --host=unix:///var/run/docker.sock \
  --storage-driver="${DOCKER_STORAGE_DRIVER:-overlay2}" \
  >"$DIND_LOG" 2>&1 &
DOCKERD_PID=$!

# Cleanup on exit
trap 'kill $DOCKERD_PID 2>/dev/null || true' EXIT INT TERM

# Wait for daemon ready
echo "[dind-entrypoint] waiting for dockerd (timeout=${DIND_TIMEOUT}s)..."
for i in $(seq 1 "$DIND_TIMEOUT"); do
  if docker info >/dev/null 2>&1; then
    echo "[dind-entrypoint] dockerd ready after ${i}s"
    break
  fi
  if ! kill -0 "$DOCKERD_PID" 2>/dev/null; then
    echo "[dind-entrypoint] FATAL: dockerd died. Logs:"
    cat "$DIND_LOG"
    exit 1
  fi
  sleep 1
done

if ! docker info >/dev/null 2>&1; then
  echo "[dind-entrypoint] FATAL: dockerd not ready after ${DIND_TIMEOUT}s. Logs:"
  cat "$DIND_LOG"
  exit 1
fi

# Pre-pull the agent image so first message latency stays small.
# If CONTAINER_IMAGE is unset we skip (will pull lazily on first spawn).
if [ -n "${CONTAINER_IMAGE:-}" ]; then
  echo "[dind-entrypoint] pre-pulling agent image: $CONTAINER_IMAGE"
  if docker pull "$CONTAINER_IMAGE"; then
    echo "[dind-entrypoint] pre-pull OK"
  else
    echo "[dind-entrypoint] pre-pull failed (will retry on first spawn)"
  fi
fi

echo "[dind-entrypoint] handing off to: $*"
exec "$@"
