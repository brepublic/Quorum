#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if (($# > 1)) || { (($# == 1)) && [[ $1 != --check-registry ]]; }; then
  echo 'Usage: bash scripts/verify-production-compose.sh [--check-registry]' >&2
  exit 2
fi

fail() {
  echo "Production Compose check failed: $1" >&2
  exit 1
}

production_compose=deploy/compose.production.yaml
production_env=deploy/.env.production.example
temporary_directory=$(mktemp -d)
trap 'rm -rf "$temporary_directory"' EXIT

# The production template has no real credentials. Never render the server's .env here.
docker compose --env-file "$production_env" -f "$production_compose" \
  config --no-interpolate --format json > "$temporary_directory/production.json"

release_tag=$(QUORUM_VERSION= docker compose --env-file "$production_env" \
  -f "$production_compose" config --format json | jq -r '.services.app.environment.QUORUM_VERSION // empty')
[[ $release_tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || fail 'invalid release version in Compose'

template_version=$(sed -n 's/^QUORUM_VERSION=//p' "$production_env")
[[ $template_version == "$release_tag" ]] || fail 'production environment template has a different version'

release_commit=$(jq -r '."x-quorum-release-commit" // empty' "$temporary_directory/production.json")
[[ $release_commit =~ ^[0-9a-f]{40}$ ]] || fail 'invalid release source commit in Compose'

if git ls-files --error-unmatch deploy/.env >/dev/null 2>&1; then
  fail 'the server-only deploy/.env is tracked by Git'
fi

jq -e '
  .name == "quorum" and
  (.services | keys == ["app", "caddy", "postgres"]) and
  (.volumes | keys == ["caddy_config", "caddy_data", "postgres_data", "quorum_files"]) and
  ([.services[] | has("build")] | all(. == false)) and
  ([.services[].volumes[]? | .type] | all(. == "volume")) and
  (.services.app | has("ports") | not) and
  (.services.postgres | has("ports") | not) and
  ([.services.caddy.ports[] | {published, target, protocol}] | sort ==
    ([
      {published:"80", target:80, protocol:"tcp"},
      {published:"443", target:443, protocol:"tcp"},
      {published:"443", target:443, protocol:"udp"}
    ] | sort)) and
  (.services.caddy.depends_on.app.condition == "service_healthy") and
  (.services.app.depends_on.postgres.condition == "service_healthy") and
  (.services.app.healthcheck.test != null) and
  (.services.postgres.healthcheck.test != null) and
  ([.services[] | .restart] | all(. == "unless-stopped")) and
  ([.services[] | .mem_limit] | all(. != null)) and
  ([.services[] | .logging.options] | all(."max-size" == "10m" and ."max-file" == "3")) and
  (.services.app.image | test("^ghcr\\.io/brepublic/quorum-app@sha256:[0-9a-f]{64}$")) and
  (.services.caddy.image | test("^ghcr\\.io/brepublic/quorum-caddy@sha256:[0-9a-f]{64}$")) and
  (.services.postgres.image | test("^postgres@sha256:[0-9a-f]{64}$"))
' "$temporary_directory/production.json" >/dev/null || fail 'unsafe or incomplete service configuration'

# Compare to the development Compose frozen in the release tag, not today's
# development Compose. New development commits must not force a production update.
release_source_ref="refs/tags/$release_tag"
source_commit=$(git rev-parse --verify "$release_source_ref^{commit}") || fail "release source $release_source_ref is unavailable"
[[ $source_commit == "$release_commit" ]] || fail 'release tag does not match the pinned source commit'
git show "$release_source_ref:deploy/compose.yaml" > "$temporary_directory/release-compose.yaml" || fail 'release has no development Compose'
docker compose --project-directory "$PWD/deploy" --env-file "$production_env" \
  -f "$temporary_directory/release-compose.yaml" config --no-interpolate --format json \
  > "$temporary_directory/release.json"

for kind in production release; do
  jq -S 'del(."x-quorum-release-commit", .services[].build, .services[].image, .services.app.environment.QUORUM_VERSION)' \
    "$temporary_directory/$kind.json" > "$temporary_directory/$kind.runtime.json"
done
cmp -s "$temporary_directory/production.runtime.json" "$temporary_directory/release.runtime.json" || \
  fail "runtime settings differ from $release_tag's development Compose"

if [[ ${1:-} == --check-registry ]]; then
  for component in app caddy; do
    image=$(jq -r --arg component "$component" '.services[$component].image' "$temporary_directory/production.json")
    published_digest=$(docker buildx imagetools inspect "ghcr.io/brepublic/quorum-$component:$release_tag" \
      --format '{{json .Manifest}}' | jq -r '.digest // empty')
    [[ $image == "ghcr.io/brepublic/quorum-$component@$published_digest" ]] || \
      fail "$component image does not match the $release_tag release tag"
  done

  for component in app caddy postgres; do
    image=$(jq -r --arg component "$component" '.services[$component].image' "$temporary_directory/production.json")
    docker pull --platform linux/amd64 "$image" >/dev/null
    platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")
    [[ $platform == linux/amd64 ]] || fail "$component image is not linux/amd64"
  done

  postgres_image=$(jq -r '.services.postgres.image' "$temporary_directory/production.json")
  postgres_version=$(docker run --rm --network none --entrypoint postgres "$postgres_image" --version)
  [[ $postgres_version == 'postgres (PostgreSQL) 16.'* ]] || fail 'PostgreSQL image is not version 16'
fi

echo "Production Compose matches release $release_tag and passed configuration checks."
