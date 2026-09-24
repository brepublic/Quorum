#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

project="quorum-release-smoke-${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-1}"
export QUORUM_SMOKE_APP_IMAGE="quorum-release-smoke-app:${GITHUB_SHA:-local}"
export QUORUM_SMOKE_CADDY_IMAGE="quorum-release-smoke-caddy:${GITHUB_SHA:-local}"
export QUORUM_SMOKE_DB_PASSWORD="$(openssl rand -hex 24)"
export QUORUM_SMOKE_HTTPS_PORT="${QUORUM_SMOKE_HTTPS_PORT:-18443}"
compose=(docker compose -p "$project" -f deploy/compose.release-smoke.yaml)
temporary_directory="$(mktemp -d)"

cleanup() {
  local result=$?
  if ((result != 0)); then
    "${compose[@]}" ps >&2 || true
  fi
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$temporary_directory"
}
trap cleanup EXIT

docker build --platform linux/amd64 --target app-runtime \
  -f deploy/Dockerfile -t "$QUORUM_SMOKE_APP_IMAGE" .
docker build --platform linux/amd64 --target caddy-runtime \
  -f deploy/Dockerfile -t "$QUORUM_SMOKE_CADDY_IMAGE" .
"${compose[@]}" up -d --no-build --wait --wait-timeout 180

certificate="$temporary_directory/root.crt"
for attempt in {1..30}; do
  if "${compose[@]}" exec -T caddy cat /data/caddy/pki/authorities/local/root.crt \
      > "$certificate" 2>/dev/null && test -s "$certificate"; then
    break
  fi
  sleep 1
done
test -s "$certificate"

base="https://localhost:$QUORUM_SMOKE_HTTPS_PORT"
for attempt in {1..30}; do
  if curl --silent --show-error --fail --max-time 5 --cacert "$certificate" \
      "$base/health/ready" -o "$temporary_directory/ready.json" 2>/dev/null; then
    break
  fi
  sleep 1
done

jq -e '.data.status == "ok" and .data.checks.database.status == "ok" and
  .data.checks.database.migrationVersion > 0 and .data.checks.storage.status != "error"' \
  "$temporary_directory/ready.json" >/dev/null
curl --silent --show-error --fail --cacert "$certificate" "$base/api/v1/version" \
  | jq -e '.data.version == "release-smoke" and .data.databaseMigrationVersion > 0' >/dev/null
curl --silent --show-error --fail --cacert "$certificate" "$base/api/v1/bootstrap/status" \
  | jq -e '.data.initialized == false' >/dev/null
curl --silent --show-error --fail --cacert "$certificate" "$base/" \
  | grep -q '<div id="root"></div>'
curl --silent --show-error --fail --cacert "$certificate" "$base/committees/test-route" \
  | grep -q '<div id="root"></div>'

echo 'Release image smoke check passed.'
