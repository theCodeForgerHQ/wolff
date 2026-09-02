#!/usr/bin/env bash
# k6 load test of the API's read paths against a local API and Postgres.
# Needs DATABASE_URL pointing at a migrated scratch database, and Docker
# (k6 runs in the grafana/k6 image). Seeds the same fixed workspace and key
# as the Schemathesis job. Usage: DATABASE_URL=... scripts/loadtest.sh
set -euo pipefail
cd "$(dirname "$0")/.."

: "${DATABASE_URL:?DATABASE_URL must point at a migrated scratch database}"
PORT="${LOADTEST_PORT:-4200}"
KEY='qc_sk_schemathesis00000000000000000000001' # fixed test key, see schemathesis-seed.ts
K6_IMAGE="${K6_IMAGE:-grafana/k6:1.3.0}"

pnpm exec tsx scripts/schemathesis-seed.ts
INVOICE_ID="$(pnpm exec tsx -e "import { PARITY } from './src/testing/parity/seed'; console.log(PARITY.invoices.sent)")"

# Production mode, without Redis: rate limits and idempotency use memory.
NODE_ENV=production LOG_LEVEL=warn PORT="$PORT" METRICS_PORT=$((PORT + 1)) REDIS_URL= \
  WEB_ORIGIN=http://localhost:3000 APP_URL=http://localhost:3000 \
  PUBLIC_API_URL="http://127.0.0.1:$PORT" \
  pnpm exec tsx src/server.ts > "${LOADTEST_SERVER_LOG:-/tmp/loadtest-api.log}" 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$PORT/healthz" > /dev/null && break
  sleep 1
done
curl -sf "http://127.0.0.1:$PORT/healthz" > /dev/null || { echo "The API did not start" >&2; exit 1; }

docker run --rm -i --add-host=host.docker.internal:host-gateway \
  -e API_URL="http://host.docker.internal:$PORT" -e API_KEY="$KEY" -e INVOICE_ID="$INVOICE_ID" \
  -v "$PWD/load:/load:ro" "$K6_IMAGE" run "$@" /load/api-read.k6.js
