#!/usr/bin/env bash
# Runs the visual suite with Linux Chromium, the platform CI compares against.
#
# Baselines are per platform (e2e/visual/__screenshots__/{darwin,linux}). The
# linux set is recorded and checked in the official Playwright image for the
# pinned version, the same Ubuntu 24.04 and browser build CI installs.
#
# The container runs on the host's architecture. On Apple silicon that is
# linux/arm64, while GitHub's ubuntu-latest is x86_64; Chromium crashes under
# amd64 emulation, so that combination can't be recorded locally. Set
# VISUAL_DOCKER_PLATFORM=linux/amd64 on an x86_64 host to pin it.
#
# Only the browser and the test runner run in the container. The app is the
# production build served from the host (next start on :3100), and the
# container forwards its own localhost:3100 to it so URLs, cookies and
# NEXTAUTH_URL are the same as in a local run.
#
# Usage, from apps/web, after `pnpm build` and with the visual database
# migrated and seeded:
#   DATABASE_URL=postgresql://…/wolff_visual e2e/visual/run-in-linux.sh
#   DATABASE_URL=… e2e/visual/run-in-linux.sh --update-snapshots=all
set -euo pipefail

cd "$(dirname "$0")/../.."
REPO_ROOT="$(cd ../.. && pwd)"
PORT="${VISUAL_PORT:-3100}"
BASE_URL="http://localhost:${PORT}"

: "${DATABASE_URL:?Set DATABASE_URL to the migrated and seeded visual database}"

PLAYWRIGHT_VERSION="$(node -p "require('@playwright/test/package.json').version")"
IMAGE="mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble"

server_pid=""
cleanup() {
  if [ -n "$server_pid" ]; then kill "$server_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT

if ! curl -sf -o /dev/null "${BASE_URL}/login"; then
  echo "Starting next start on :${PORT}"
  NEXTAUTH_URL="$BASE_URL" AUTH_URL="$BASE_URL" NEXT_PUBLIC_APP_URL="$BASE_URL" \
    NEXTAUTH_SECRET="${NEXTAUTH_SECRET:-wolff-visual-secret}" \
    TRUST_HOST=true AUTH_TRUST_HOST=true TZ=UTC \
    node node_modules/next/dist/bin/next start -p "$PORT" >/dev/null 2>&1 &
  server_pid=$!
  for _ in $(seq 1 60); do
    curl -sf -o /dev/null "${BASE_URL}/login" && break
    sleep 1
  done
  curl -sf -o /dev/null "${BASE_URL}/login" || { echo "The app did not start" >&2; exit 1; }
fi

# Inside the container, the host's loopback is host.docker.internal.
CONTAINER_DATABASE_URL="${DATABASE_URL//localhost/host.docker.internal}"
CONTAINER_DATABASE_URL="${CONTAINER_DATABASE_URL//127.0.0.1/host.docker.internal}"

FORWARD="require('net').createServer((c) => {
  const u = require('net').connect(${PORT}, 'host.docker.internal');
  c.pipe(u).pipe(c);
  c.on('error', () => u.destroy());
  u.on('error', () => c.destroy());
}).listen(${PORT}, '127.0.0.1');"

docker run --rm ${VISUAL_DOCKER_PLATFORM:+--platform "$VISUAL_DOCKER_PLATFORM"} --ipc=host \
  --add-host=host.docker.internal:host-gateway \
  -v "${REPO_ROOT}:/work" -w /work/apps/web \
  -e DATABASE_URL="$CONTAINER_DATABASE_URL" \
  -e VISUAL_PORT="$PORT" \
  "$IMAGE" bash -c "
    node -e \"${FORWARD}\" &
    node node_modules/@playwright/test/cli.js test -c playwright.visual.config.ts $*
  "
