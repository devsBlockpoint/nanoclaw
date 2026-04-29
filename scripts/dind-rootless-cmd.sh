#!/bin/sh
# Rootless DinD CMD wrapper.
#
# Runs INSIDE the dind-rootless container after the upstream
# dockerd-entrypoint.sh has spawned dockerd-rootless in background. Waits for
# the socket to come up, exports DOCKER_HOST, optionally pre-pulls the agent
# image, then execs the real command (nanoclaw host).
set -e

UID_VAL=$(id -u)
SOCK="/run/user/${UID_VAL}/docker.sock"
TIMEOUT=60

echo "[rootless-cmd] waiting for dockerd-rootless at $SOCK (timeout=${TIMEOUT}s)..."
for i in $(seq 1 "$TIMEOUT"); do
  if [ -S "$SOCK" ] && docker -H "unix://$SOCK" info >/dev/null 2>&1; then
    echo "[rootless-cmd] dockerd ready after ${i}s"
    break
  fi
  sleep 1
done

if ! docker -H "unix://$SOCK" info >/dev/null 2>&1; then
  echo "[rootless-cmd] FATAL: dockerd-rootless not ready after ${TIMEOUT}s"
  ls -la "/run/user/${UID_VAL}/" 2>&1 || true
  exit 1
fi

export DOCKER_HOST="unix://$SOCK"
echo "[rootless-cmd] DOCKER_HOST=$DOCKER_HOST"

if [ -n "${CONTAINER_IMAGE:-}" ]; then
  echo "[rootless-cmd] pre-pulling agent image: $CONTAINER_IMAGE"
  docker pull "$CONTAINER_IMAGE" || echo "[rootless-cmd] pre-pull failed (will retry on first spawn)"
fi

echo "[rootless-cmd] handing off to: $*"
exec "$@"
