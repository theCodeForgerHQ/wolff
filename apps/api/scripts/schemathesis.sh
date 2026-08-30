#!/usr/bin/env bash
# Runs Schemathesis against a local API built from this checkout.
# Needs DATABASE_URL pointing at a migrated scratch database, and uv.
# Used by the `schemathesis` CI job; locally: pnpm --filter @wolff/api schemathesis
set -euo pipefail
cd "$(dirname "$0")/.."

: "${DATABASE_URL:?DATABASE_URL must point at a migrated scratch database}"
PORT="${SCHEMATHESIS_PORT:-4100}"
KEY='qc_sk_schemathesis00000000000000000000001' # fixed test key, see schemathesis-seed.ts

# The seed also writes the config that pins each {id} operation to a seeded
# resource (see schemathesis-seed.ts).
config_dir="$(mktemp -d)"
config="$config_dir/schemathesis.toml"
SCHEMATHESIS_CONFIG="$config" pnpm exec tsx scripts/schemathesis-seed.ts

NODE_ENV=test PORT="$PORT" METRICS_PORT=$((PORT + 1)) REDIS_URL= \
  WEB_ORIGIN=http://localhost:3000 APP_URL=http://localhost:3000 \
  PUBLIC_API_URL="http://127.0.0.1:$PORT" \
  pnpm exec tsx src/server.ts > "${SCHEMATHESIS_SERVER_LOG:-/tmp/schemathesis-api.log}" 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true; rm -rf "$config_dir"' EXIT
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$PORT/healthz" > /dev/null && break
  sleep 1
done

# Checks: no 5xx, documented status codes, content types and response
# bodies. Not run: positive_data_acceptance / negative_data_rejection (the
# routes ported from Next validate by hand and document their bodies
# loosely on purpose) and unsupported_method (Express answers 404, not
# 405, to methods a path does not have). Stateful links are not modelled;
# ids come from the seeded fixtures instead.
# A fixed seed and deterministic generation keep CI reproducible.
uvx --from 'schemathesis==4.29.3' st --config-file "$config" run "http://127.0.0.1:$PORT/openapi.json" \
  -H "Authorization: Bearer $KEY" \
  --checks not_a_server_error,status_code_conformance,content_type_conformance,response_schema_conformance \
  --phases examples,coverage,fuzzing \
  --max-examples "${SCHEMATHESIS_MAX_EXAMPLES:-50}" \
  --seed "${SCHEMATHESIS_SEED:-6}" --generation-deterministic \
  --workers 4
