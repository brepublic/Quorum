#!/usr/bin/env bash
# Run from the standalone deployment directory; no source checkout or Node required.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
for command in docker jq curl sha256sum flock; do
  command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done
exec 9>deploy/.upgrade.lock
flock -n 9 || { echo 'Another Quorum upgrade is running.' >&2; exit 1; }
compose=(docker compose -p quorum --env-file deploy/.env -f deploy/compose.production.yaml)
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
fail() { echo "Quorum upgrade stopped: $*" >&2; exit 1; }
"${compose[@]}" config --format json > "$temporary/config.json"
commit=$(jq -er '."x-quorum-release-commit"' "$temporary/config.json")
[[ $commit =~ ^[a-f0-9]{40}$ ]] || fail 'invalid release commit'
site=$(jq -er '.services.caddy.environment.QUORUM_SITE_ADDRESS' "$temporary/config.json")
[[ $site =~ ^(https://)?[a-zA-Z0-9.-]+(:[0-9]+)?$ ]] || fail 'expected one HTTPS site address'
base="https://${site#https://}"
declare -A images old_ids repositories
for service in app caddy; do
  image=$(jq -er --arg service "$service" '.services[$service].image' "$temporary/config.json")
  [[ $image =~ ^ghcr\.io/[a-z0-9_.-]+/quorum-$service@sha256:[a-f0-9]{64}$ ]] || fail "un-pinned $service image"
  images[$service]=$image
  repositories[$service]=${image%@*}
  container=$("${compose[@]}" ps -q "$service")
  if [[ -n $container ]]; then
    old_ids[$service]=$(docker inspect --format '{{.Image}}' "$container")
  fi
done
# A failed pull (including insufficient disk space) must not replace the running containers.
"${compose[@]}" pull
for service in app caddy; do
  docker image inspect "${images[$service]}" > "$temporary/$service.json"
  actual_commit=$(jq -r '.[0].Config.Labels["org.opencontainers.image.revision"]' "$temporary/$service.json")
  [[ $actual_commit == "$commit" ]] || fail "$service does not match the release commit"
done
tag=$(jq -r '.[0].Config.Labels["io.quorum.release"]' "$temporary/caddy.json")
[[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || fail 'invalid release tag'
[[ $(jq -r '.[0].Config.Labels["io.quorum.release"]' "$temporary/app.json") == "$tag" ]] || fail 'application and website versions differ'
# Verify the new website packages before switching containers.
docker run --rm --network none --entrypoint cat "${images[caddy]}" /srv/downloads/chair-agent/manifest.json > "$temporary/manifest.json"
jq -e --arg tag "$tag" --arg commit "$commit" '
  .schemaVersion == 1 and .serverVersion == $tag and .commit == $commit and
  (.platforms | keys == ["linux", "windows"]) and
  ([.platforms[] | (.sha256 | test("^[a-f0-9]{64}$")) and (.size > 0) and
    (.file | test("^[A-Za-z0-9_.-]+$")) and (.url == ("/downloads/chair-agent/" + $tag + "/" + .file))] | all)
' "$temporary/manifest.json" >/dev/null || fail 'invalid installer manifest'
docker run --rm --network none --entrypoint sh "${images[caddy]}" -c 'cd /srv/downloads/chair-agent && sha256sum -c SHA256SUMS'
# Keep pending cleanup identities across interrupted verification or cleanup retries.
pending=deploy/.upgrade-images
if [[ -f $pending ]]; then cat "$pending" > "$temporary/pending"; else : > "$temporary/pending"; fi
for service in app caddy; do
  old=${old_ids[$service]:-}
  current=$(jq -r '.[0].Id' "$temporary/$service.json")
  if [[ -n $old && $old != "$current" ]]; then
    printf '%s\t%s\t%s\n' "$service" "$old" "${repositories[$service]}" >> "$temporary/pending"
  fi
done
sort -u "$temporary/pending" > "$pending.new"
mv "$pending.new" "$pending"
"${compose[@]}" up -d --no-build --wait --wait-timeout 180
# CURL_CA_BUNDLE can specify the deployment CA; never disable TLS verification.
curl --fail --silent --show-error --retry 5 --retry-delay 2 --retry-connrefused --max-time 20 "$base/health/ready" \
  | jq -e '.data.status == "ok"' >/dev/null
curl --fail --silent --show-error --max-time 20 "$base/api/v1/version" \
  | jq -e --arg tag "$tag" '.data.version == $tag' >/dev/null
curl --fail --silent --show-error --max-time 20 "$base/downloads/chair-agent/manifest.json" > "$temporary/served.json"
cmp "$temporary/manifest.json" "$temporary/served.json" || fail 'served installers do not match the new image'
for platform in windows linux; do
  url=$(jq -r --arg platform "$platform" '.platforms[$platform].url' "$temporary/manifest.json")
  expected=$(jq -r --arg platform "$platform" '.platforms[$platform].sha256' "$temporary/manifest.json")
  # Stream the package through the checksum tool without storing another copy on disk.
  actual=$(curl --fail --silent --show-error --max-time 600 "$base$url" | sha256sum | cut -d ' ' -f1)
  [[ $actual == "$expected" ]] || fail "$platform download checksum mismatch"
done
# Only images replaced by this invocation are candidates. Never prune Docker globally.
cleanup_pending=false
while IFS=$'\t' read -r service old repository_name; do
  [[ -n $service ]] || continue
  [[ $service == app || $service == caddy ]] || fail 'invalid pending cleanup service'
  [[ $old =~ ^sha256:[a-f0-9]{64}$ && $repository_name == "${repositories[$service]}" ]] || fail 'invalid pending cleanup image'
  current=$(jq -r '.[0].Id' "$temporary/$service.json")
  [[ $old != "$current" ]] || continue
  if ! docker image inspect "$old" > "$temporary/old.json" 2>/dev/null; then continue; fi
  if [[ -n $(docker ps -aq --filter "ancestor=$old") ]]; then
    echo "Keeping $service image used by another container: $old" >&2
    cleanup_pending=true
    continue
  fi
  # Avoid removing any reference belonging to another repository.
  mapfile -t references < <(jq -r '.[0] | (.RepoTags // []) + (.RepoDigests // []) | .[]' "$temporary/old.json")
  owned=true
  for reference in "${references[@]}"; do
    [[ $reference == "${repositories[$service]}:"* || $reference == "${repositories[$service]}@"* ]] || owned=false
  done
  if [[ $owned == false ]]; then
    echo "Keeping $service image with unrelated repository references: $old" >&2
    cleanup_pending=true
    continue
  fi
  for reference in "${references[@]}"; do
    # Removing a tag may also remove its digest. Skip only references already gone.
    if docker image inspect "$reference" >/dev/null 2>&1; then
      docker image rm "$reference" || cleanup_pending=true
    fi
  done
  if docker image inspect "$old" >/dev/null 2>&1; then
    docker image rm "$old" || cleanup_pending=true
  fi
done < "$pending"
if [[ $cleanup_pending == true ]]; then
  echo "Quorum $tag is running; some old images could not be cleaned. See messages above." >&2
  exit 1
fi
rm "$pending"
echo "Quorum $tag is running; replaced images and their old installers have been removed."
