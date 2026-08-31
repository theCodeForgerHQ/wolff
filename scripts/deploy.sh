#!/usr/bin/env bash
# Deploy web, api and ai to Vercel production, smoke-test, roll back on failure.
#
#   scripts/deploy.sh [git ref, default HEAD] [api,ai,web]
#
# Deploys from a `git archive` of the ref, never from the working tree: the
# Vercel CLI uploads untracked and gitignored files such as .env.
# Needs the variables listed in apps/api/scripts/deploy.ts (docs/runbook.md).
set -euo pipefail

ref="${1:-HEAD}"
only="${2:-api,ai,web}"
root="$(git rev-parse --show-toplevel)"
sha="$(git -C "$root" rev-parse --short "$ref")"
work="$(mktemp -d "${TMPDIR:-/tmp}/wolff-deploy-$sha.XXXXXX")"
trap 'rm -rf "$work"' EXIT

git -C "$root" archive "$ref" | tar -x -C "$work"
echo "deploying $ref ($sha) from $work: $only"
cd "$root/apps/api"
node --import tsx scripts/deploy.ts "$work" "$only"
