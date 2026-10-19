#!/usr/bin/env bash
# Standalone Linux deployment updater. No Node/pnpm or source checkout required.
set -Eeuo pipefail
umask 077

fail() { echo "升级停止：$*" >&2; return 1; }
compose_file() {
  local env_file="$deploy/.env"
  # Saved JSON already contains escaped, resolved values. Recovery must work even
  # if the live .env was removed or the invoking shell now exports different values.
  if [[ -n ${state:-} && $1 == "$state/"* ]]; then env_file=/dev/null; fi
  docker compose -p "$project" --env-file "$env_file" -f "$1" "${@:2}"
}
phase() { printf '%s\n' "$1" > "$state/phase.new"; sync -f "$state/phase.new"; mv "$state/phase.new" "$state/phase"; sync -f "$state"; }
install_file() { cp -p "$1" "$2.new"; sync -f "$2.new"; mv "$2.new" "$2"; sync -f "$(dirname "$2")"; }
# A partially deleted journal must never be mistaken for a transaction to recover.
retire_state() {
  mv "$state" "$state.done"; sync -f "$deploy"
  rm -rf "$state.done"; sync -f "$deploy"
}
remove_isolated_network() {
  local network
  network=$(docker network ls -q --filter "name=^${project}_upgrade_isolated$")
  if [[ -n $network ]]; then docker network rm "$network" >/dev/null; fi
}
fetch() { curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 120 --retry 2 "$@"; }
# SemVer precedence: stable follows prereleases; numeric identifiers sort by
# value, before text. Length/string pairs avoid rounding large version numbers.
version_filter='
  def number_key: [length, .];
  def version_key:
    capture("^v(?<a>0|[1-9][0-9]*)\\.(?<b>0|[1-9][0-9]*)\\.(?<c>0|[1-9][0-9]*)(?:-(?<pre>[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$") |
    select([(.pre // "" | split("."))[] | select(test("^[0-9]+$")) | test("^(0|[1-9][0-9]*)$")] | all) |
    [(.a | number_key), (.b | number_key), (.c | number_key),
     (if .pre == null then 1 else 0 end),
     (if .pre == null then [] else .pre | split(".") |
       map(if test("^[0-9]+$") then [0, number_key] else [1, .] end) end)];'
version_number() { jq -en --arg v "$1" "$version_filter"' $v | version_key'; }

select_channel() {
  local answer
  printf '  1. 正式版本（默认）\n  2. 包含预发布版本（测试）\n'
  read -r -p '选择版本范围 [1]，或输入 q 退出：' answer
  case "$answer" in
    ''|1) allow_prerelease=false ;;
    2) allow_prerelease=true ;;
    q) return 2 ;;
    *) fail '无效选择。' ;;
  esac
}

validate_release() {
  version_number "$1" >/dev/null || return 1
  jq -e --arg tag "$1" --arg repo "$repository" '
    .schemaVersion == 1 and .upgradeProtocol == 1 and .deploymentSchema == 1 and
    .version == $tag and (.commit | test("^[a-f0-9]{40}$")) and .platform == "linux/amd64" and
    .postgresMajor == 16 and .minimumDatabaseMigration >= 24 and
    (.migrations | type == "object" and length > 0) and
    ([.migrations | to_entries[] | (.key | test("^[1-9][0-9]*$")) and (.value | test("^[a-f0-9]{64}$"))] | all) and
    (.images | keys == ["app","caddy","postgres"]) and
    (.images.app | test("^ghcr\\.io/" + $repo + "/quorum-app@sha256:[a-f0-9]{64}$")) and
    (.images.caddy | test("^ghcr\\.io/" + $repo + "/quorum-caddy@sha256:[a-f0-9]{64}$")) and
    (.images.postgres | test("^postgres@sha256:[a-f0-9]{64}$"))
  ' "$2" >/dev/null
}

select_release() {
  local page count index=0 tag url release_root asset chosen answer prerelease
  if [[ -z ${requested_version:-} && ${allow_prerelease:-false} == false ]]; then select_channel; fi
  local current_number; current_number=$(version_number "$current_version")
  : > "$temporary/candidates"
  # GitHub's latest endpoint alone can point at a release whose images are still building.
  for page in {1..20}; do
    fetch "https://api.github.com/repos/$github_repository/releases?per_page=100&page=$page" > "$temporary/releases.json"
    jq -e 'type == "array"' "$temporary/releases.json" >/dev/null
    count=$(jq length "$temporary/releases.json")
    jq -c --argjson current "$current_number" --argjson allow "${allow_prerelease:-false}" "$version_filter"'
      .[] | select(.draft == false and (.prerelease == false or ($allow and .prerelease == true))) |
      . as $r | (try ($r.tag_name | version_key) catch empty) as $key |
      select($key > $current and ($allow or $key[3] == 1)) |
      $r.assets[] | select(.name == "quorum-server-release.json") |
      {tag: $r.tag_name, url: .browser_download_url, key: $key, prerelease: ($r.prerelease or $key[3] == 0)}
    ' "$temporary/releases.json" >> "$temporary/candidates"
    ((count == 100)) || break
  done
  jq -sr 'unique_by(.tag) | sort_by(.key) | reverse | .[] | [.tag,.url,.prerelease] | @tsv' "$temporary/candidates" > "$temporary/sorted"
  : > "$temporary/choices"
  while IFS=$'\t' read -r tag url prerelease; do
    [[ -n $tag ]] || continue
    release_root=${url%"/releases/download/$tag/quorum-server-release.json"}
    [[ $release_root != "$url" && ${release_root,,} == "https://github.com/${github_repository,,}" ]] || continue
    asset="$temporary/release-$tag.json"
    fetch "$url" > "$asset"
    if ! validate_release "$tag" "$asset" || ! compatible_database "$asset"; then
      echo "跳过不兼容的版本：$tag" >&2; continue
    fi
    index=$((index + 1))
    printf '%s\t%s\n' "$index" "$tag" >> "$temporary/choices"
    if [[ $prerelease == true ]]; then printf '  %s. %s（预发布）\n' "$index" "$tag"
    else printf '  %s. %s\n' "$index" "$tag"; fi
  done < "$temporary/sorted"
  ((index > 0)) || { echo '没有可用的兼容升级版本。'; return 2; }
  if [[ -n ${requested_version:-} ]]; then
    chosen=$(awk -F '\t' -v tag="$requested_version" '$2 == tag {print $2}' "$temporary/choices")
    [[ -n $chosen ]] || fail '指定版本不在可升级列表中。'
  else
    read -r -p '选择版本，或输入 q 退出：' answer
    [[ $answer != q ]] || return 2
    [[ $answer =~ ^[0-9]+$ ]] || fail '无效选择。'
    chosen=$(awk -F '\t' -v n="$answer" '$1 == n {print $2}' "$temporary/choices")
    [[ -n $chosen ]] || fail '无效选择。'
  fi
  cp "$temporary/release-$chosen.json" "$temporary/release.json"
}

sql() { compose_file "$1" exec -T postgres sh -eu -c 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' <<< "$2"; }
compatible_database() {
  local applied
  applied=$(sql "$config" 'SELECT coalesce(json_object_agg(version,checksum), '\''{}'\'') FROM quorum_meta.schema_migrations;')
  jq -en --argjson applied "$applied" --slurpfile release "$1" '
    ($applied | keys | map(tonumber) | max) >= $release[0].minimumDatabaseMigration and
    ([$applied | to_entries[] | . as $m | $release[0].migrations[$m.key] == $m.value] | all)' >/dev/null
}

pull_release() {
  local service image
  for service in app caddy postgres; do
    image=$(jq -r --arg s "$service" '.images[$s]' "$temporary/release.json")
    docker pull --platform linux/amd64 "$image"
    docker image inspect "$image" > "$temporary/image-$service.json"
    jq -e '.[0].Os == "linux" and .[0].Architecture == "amd64"' "$temporary/image-$service.json" >/dev/null
    if [[ $service != postgres ]]; then
      jq -e --arg tag "$target_version" --arg commit "$target_commit" '
        .[0].Config.Labels | .["io.quorum.release"] == $tag and .["org.opencontainers.image.revision"] == $commit
      ' "$temporary/image-$service.json" >/dev/null
    fi
  done
  jq -e '.[0].Config.Labels["io.quorum.upgrade-protocol"] == "1"' "$temporary/image-app.json" >/dev/null
  jq -e '.[0].Config.Env | index("PG_MAJOR=16") != null' "$temporary/image-postgres.json" >/dev/null
  local caddy; caddy=$(jq -r .images.caddy "$temporary/release.json")
  docker run --rm --network none --entrypoint cat "$caddy" /srv/downloads/chair-agent/manifest.json > "$temporary/manifest.json"
  jq -e --arg tag "$target_version" --arg commit "$target_commit" '
    .schemaVersion == 1 and .serverVersion == $tag and .commit == $commit and
    (.platforms | keys == ["linux","windows"]) and
    ([.platforms[] | (.sha256 | test("^[a-f0-9]{64}$")) and (.size > 0) and
      (.file | test("^[A-Za-z0-9_.-]+$")) and (.url == ("/downloads/chair-agent/" + $tag + "/" + .file))] | all)
  ' "$temporary/manifest.json" >/dev/null
  docker run --rm --network none --entrypoint sh "$caddy" -ec 'cd /srv/downloads/chair-agent; sha256sum -c SHA256SUMS'
}

# Change only version pins in the original YAML; keep substitutions, comments and local settings.
write_target_config() {
  local app caddy postgres
  app=$(jq -r .images.app "$temporary/release.json"); caddy=$(jq -r .images.caddy "$temporary/release.json")
  postgres=$(jq -r .images.postgres "$temporary/release.json")
  awk -v app="$app" -v caddy="$caddy" -v postgres="$postgres" -v commit="$target_commit" '
    /^x-quorum-release-commit:/ {$0="x-quorum-release-commit: " commit; commits++}
    /^  [a-z_]+:$/ {service=$1; sub(/:$/, "", service)}
    /^    image:/ && (service=="app" || service=="caddy" || service=="postgres") {
      $0="    image: " (service=="app" ? app : (service=="caddy" ? caddy : postgres)); images++
    }
    {print}
    END {if (images != 3 || commits != 1) exit 1}
  ' "$config" > "$temporary/target.yaml"
  compose_file "$temporary/target.yaml" config --format json > "$temporary/target.json"
  # Refuse unexpected YAML layouts/anchors or configuration changes rather than silently losing them.
  jq -S 'del(."x-quorum-release-commit") | .services |= with_entries(.value |= del(.image))' "$temporary/current.json" > "$temporary/old-settings"
  jq -S 'del(."x-quorum-release-commit") | .services |= with_entries(.value |= del(.image))' "$temporary/target.json" > "$temporary/new-settings"
  cmp "$temporary/old-settings" "$temporary/new-settings"
}

# These are full cold-volume archives, including dotfiles, ownership and staging files.
volume_io() {
  local key=$1 action=$2 volume helper
  volume=$(jq -r --arg k "$key" '.volumes[$k].name' "$state/old.json")
  helper=$(jq -r '.services.app.image' "$state/old.json")
  # The helper may outlive a killed shell. Do not let its Docker client retain
  # our lock; recovery first removes this named helper before touching any volume.
  docker run --name "$project-upgrade-io" --rm --network none --user 0 --entrypoint sh \
    --mount "type=volume,src=$volume,dst=/volume" --mount "type=bind,src=$state,dst=/backup" \
    "$helper" -eu -c '
      case "$1" in
        size) du -sk --apparent-size /volume | cut -f1 ;;
        backup) tar -cpf "/backup/$2.tar" -C /volume .; tar -df "/backup/$2.tar" -C /volume ;;
        compare) tar -df "/backup/$2.tar" -C /volume ;;
        restore) find /volume -mindepth 1 -delete; tar -xpf "/backup/$2.tar" -C /volume; sync -f /volume; tar -df "/backup/$2.tar" -C /volume ;;
      esac' sh "$action" "$key" 9>&-
}

isolate_config() {
  jq --arg project "$project" '
    .networks = {upgrade_isolated: {name: ($project + "_upgrade_isolated"), internal: true}} |
    .services |= with_entries(.value.restart = "no" | .value.networks = {upgrade_isolated: null}) |
    .services.app.environment.QUORUM_UPGRADE_VERIFY_ONLY = "1" |
    .services.caddy.ports = []
  ' "$1" > "$2"
}

prepare_state() {
  mkdir "$state.new"
  cp -p "$config" "$state.new/original.yaml"
  cp -p "$deploy/.env" "$state.new/original.env"
  cp "$temporary/target.yaml" "$state.new/target.yaml"
  cp "$temporary/current.json" "$state.new/old.json"
  cp "$temporary/current.json" "$state.new/original.json"
  cp "$temporary/target.json" "$state.new/target.json"
  cp "$temporary/release.json" "$state.new/release.json"
  cp "$temporary/manifest.json" "$state.new/manifest.json"
  # Pin both activation paths, including rollback, to immutable images and resolved settings.
  local service container image reference key volume ids expected_hash actual_hash
  local allowed_containers=' '
  for service in app caddy postgres; do
    container=$(compose_file "$config" ps -q "$service")
    [[ -n $container ]] || fail "服务 $service 未运行。"
    docker inspect "$container" > "$temporary/container-$service.json"
    expected_hash=$(compose_file "$config" config --hash "$service" | awk '{print $2}')
    actual_hash=$(jq -r '.[0].Config.Labels["com.docker.compose.config-hash"]' "$temporary/container-$service.json")
    [[ $actual_hash == "$expected_hash" ]] || fail "服务 $service 的配置与运行状态不同，请先核对本机配置。"
    # Compose's service hash omits top-level volume names. Compare actual mounts
    # as well, or a renamed volume could make us back up an unrelated database.
    jq -e --arg s "$service" --slurpfile actual "$temporary/container-$service.json" '
      . as $config |
      ([.services[$s].volumes[] | {type: .type, name: $config.volumes[.source].name,
        target: .target, readonly: (.read_only // false)}] | sort_by(.target)) ==
      ([$actual[0][0].Mounts[] | {type: .Type, name: .Name, target: .Destination,
        readonly: (.RW | not)}] | sort_by(.target))
    ' "$state.new/original.json" >/dev/null || fail "服务 $service 的实际数据卷与配置不同。"
    image=$(jq -r '.[0].Image' "$temporary/container-$service.json")
    reference=$(jq -r --arg s "$service" '.services[$s].image' "$state.new/original.json")
    [[ $reference =~ ^([^[:space:]]+@)?sha256:[a-f0-9]{64}$ ]] || fail "服务 $service 必须使用镜像内容哈希，不能使用可变标签。"
    [[ $(docker image inspect --format '{{.Id}}' "$reference") == "$image" ]] || fail "服务 $service 的镜像与运行版本不同。"
    allowed_containers+="$container "
    jq --arg s "$service" --arg image "$image" '.services[$s].image = $image' "$state.new/old.json" > "$state.new/old.next"
    mv "$state.new/old.next" "$state.new/old.json"
  done
  # Only the supported standalone layout; reject unbacked mounts/extra services.
  jq -e '
    (.services | keys == ["app","caddy","postgres"]) and
    (.volumes | keys == ["caddy_config","caddy_data","postgres_data","quorum_files"]) and
    ([.services[].volumes[] | .type == "volume"] | all) and
    (.services.app.volumes | length == 1) and .services.app.volumes[0].source == "quorum_files" and
    .services.app.volumes[0].target == "/var/lib/quorum/files" and
    (.services.postgres.volumes | length == 1) and .services.postgres.volumes[0].source == "postgres_data" and
    .services.postgres.volumes[0].target == "/var/lib/postgresql/data" and
    (.services.caddy.volumes | length == 2) and
    ([.services.app,.services.postgres] | all((.ports // []) | length == 0)) and
    (.services.app.command == null) and (.services.app.entrypoint == null)
  ' "$state.new/old.json" >/dev/null || fail '部署结构不受支持；没有修改运行服务。'
  for key in caddy_config caddy_data postgres_data quorum_files; do
    volume=$(jq -r --arg k "$key" '.volumes[$k].name' "$state.new/old.json")
    [[ $volume =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]+$ ]] || fail '无效数据卷名称。'
    docker volume inspect "$volume" >/dev/null
    ids=$(docker ps -aq --no-trunc --filter "volume=$volume")
    for container in $ids; do
      [[ $allowed_containers == *" $container "* ]] || fail "数据卷被部署服务之外的容器使用：$volume"
    done
  done
  [[ $(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$(jq -r '.services.postgres.image' "$state.new/old.json")") == *'PG_MAJOR=16'* ]] || fail '仅支持 PostgreSQL 16。'
  local old_family new_family
  old_family=$(docker run --rm --network none --entrypoint sh "$(jq -r '.services.postgres.image' "$state.new/old.json")" -ec '. /etc/os-release; printf "%s" "$ID"')
  new_family=$(docker run --rm --network none --entrypoint sh "$(jq -r '.services.postgres.image' "$state.new/target.json")" -ec '. /etc/os-release; printf "%s" "$ID"')
  [[ $old_family == "$new_family" ]] || fail 'PostgreSQL 镜像系统类型不同，需要单独迁移。'
  printf '%s\n' "$current_version" > "$state.new/old-version"
  isolate_config "$state.new/target.json" "$state.new/verify.json"
  isolate_config "$state.new/old.json" "$state.new/restore-verify.json"
  printf 'prepared\n' > "$state.new/phase"
  sync -f "$state.new"
  mv "$state.new" "$state"; sync -f "$deploy"
}

stop_services() {
  # Disable restart *before* stopping: power loss must not reopen an unverified application.
  local ids id
  ids=$(docker ps -aq --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.oneoff=False')
  for id in $ids; do docker update --restart=no "$id" >/dev/null; done
  compose_file "$state/old.json" stop -t 45 caddy app
}

assert_quiescent() {
  # Read after the old app has stopped: no new claims can race the check. Do not treat expiry as completion.
  local pending
  pending=$(sql "$state/old.json" "SELECT
    (SELECT count(*) FROM storage_agent_tasks WHERE status = 'IN_PROGRESS') +
    (SELECT count(*) FROM file_blob_delete_jobs WHERE status = 'IN_PROGRESS') +
    (SELECT count(*) FROM storage_migration_items WHERE status = 'IN_PROGRESS') +
    (SELECT count(*) FROM committee_deletion_jobs WHERE status = 'IN_PROGRESS') +
    (SELECT count(*) FROM file_uploads WHERE status = 'RECEIVING');")
  [[ $pending == 0 ]] || fail '仍有未完成的文件或 Agent 任务；已停止本次升级，请任务完成后重试。'
  [[ $(compose_file "$state/old.json" ps -aq app | xargs docker inspect --format '{{.State.ExitCode}}') == 0 ]] || fail '旧应用未正常停止，不能建立恢复点。'
}

verify_http() {
  local file=$1 expected=$2 downloads=$3 address host site base
  site=$(jq -r '.services.caddy.environment.QUORUM_SITE_ADDRESS' "$file")
  [[ $site =~ ^(https://)?[a-zA-Z0-9.-]+(:[0-9]+)?$ ]] || fail '需要单一 HTTPS 域名。'
  host=${site#https://}; host=${host%:*}; base="https://$host"
  address=$(docker inspect "$(compose_file "$file" ps -q caddy)" | jq -er --arg network "${project}_upgrade_isolated" '.[0].NetworkSettings.Networks[$network].IPAddress | select(length > 0)')
  local curl_args=(--noproxy '*' --fail --silent --show-error --connect-timeout 5 --max-time 30 --retry 3 --retry-delay 1 --connect-to "$host:443:$address:443")
  curl "${curl_args[@]}" "$base/health/ready" | jq -e '.data.status == "ok"' >/dev/null
  curl "${curl_args[@]}" "$base/api/v1/version" | jq -e --arg v "$expected" '.data.version == $v' >/dev/null
  curl "${curl_args[@]}" "$base/" | grep -q '<div id="root"></div>'
  if [[ $downloads == yes ]]; then
    curl "${curl_args[@]}" "$base/downloads/chair-agent/manifest.json" > "$state/served.json"
    cmp "$state/manifest.json" "$state/served.json"
    local platform url expected_hash actual
    for platform in linux windows; do
      url=$(jq -r --arg p "$platform" '.platforms[$p].url' "$state/manifest.json")
      expected_hash=$(jq -r --arg p "$platform" '.platforms[$p].sha256' "$state/manifest.json")
      actual=$(curl "${curl_args[@]}" --max-time 600 "$base$url" | sha256sum | cut -d ' ' -f1)
      [[ $actual == "$expected_hash" ]] || fail "$platform 安装包下载校验失败。"
    done
    [[ $(curl --noproxy '*' --silent --show-error --connect-to "$host:443:$address:443" --max-time 10 -o /dev/null -w '%{http_code}' "$base/api/v1/bootstrap/status") == 503 ]] || fail '维护限制未生效。'
  fi
}

restore_previous() {
  echo '正在恢复升级前的数据库、文件和部署配置……'
  docker rm -f "$project-upgrade-io" >/dev/null 2>&1 || true
  stop_services
  compose_file "$state/old.json" stop -t 45 postgres
  local previous_phase; previous_phase=$(cat "$state/phase")
  if [[ $previous_phase == verifying || $previous_phase == restoring || $previous_phase == restored ]]; then
    [[ -f $state/SHA256SUMS ]] || fail '完整恢复点缺失；保留维护状态。'
  fi
  if [[ -f $state/SHA256SUMS ]]; then
    (cd "$state"; sha256sum -c SHA256SUMS)
    # Idempotent: every retry restores *all* volumes from the same immutable snapshot.
    phase restoring
    local key
    for key in postgres_data quorum_files caddy_data caddy_config; do volume_io "$key" restore; done
  fi
  install_file "$state/original.env" "$deploy/.env"
  install_file "$state/original.yaml" "$config"
  if [[ -f $state/SHA256SUMS ]]; then phase restored; fi
  compose_file "$state/restore-verify.json" up -d --no-build --pull never --wait --wait-timeout 180
  verify_http "$state/restore-verify.json" "$(cat "$state/old-version")" no
  # Baseline has been restored and checked. After this point never replay the snapshot.
  phase rollback-verified
  finish_rollback
}
finish_rollback() {
  install_file "$state/original.env" "$deploy/.env"
  install_file "$state/original.yaml" "$config"
  compose_file "$state/original.json" up -d --no-build --pull never --wait --wait-timeout 180
  remove_isolated_network
  retire_state
  echo '旧版本已恢复，部署配置、数据库和文件已回滚。'
}

cleanup_success() {
  local service old current reference owned
  for service in app caddy postgres; do
    old=$(jq -r --arg s "$service" '.services[$s].image' "$state/old.json")
    current=$(compose_file "$state/target.json" ps -q "$service" | xargs docker inspect --format '{{.Image}}')
    [[ $old != "$current" ]] || continue
    docker image inspect "$old" > "$state/cleanup-image.json" 2>/dev/null || continue
    [[ -z $(docker ps -aq --filter "ancestor=$old") ]] || continue
    # PostgreSQL images may be shared by unrelated installations. Never remove their tags here.
    [[ $service != postgres ]] || continue
    owned=true
    mapfile -t references < <(jq -r '.[0] | (.RepoTags // []) + (.RepoDigests // []) | .[]' "$state/cleanup-image.json")
    for reference in "${references[@]}"; do
      [[ $reference == "ghcr.io/$repository/quorum-$service:"* || $reference == "ghcr.io/$repository/quorum-$service@"* ]] || owned=false
    done
    [[ $owned == true ]] || continue
    for reference in "${references[@]}"; do
      if docker image inspect "$reference" >/dev/null 2>&1; then docker image rm "$reference"; fi
    done
    if docker image inspect "$old" >/dev/null 2>&1; then docker image rm "$old"; fi
  done
  remove_isolated_network
  retire_state
  echo '升级完成；临时恢复点已清理。'
}
finish_upgrade() {
  # Committed is written BEFORE enabling any user/worker writes. Failures here resume activation, never restore old data.
  install_file "$state/target.yaml" "$config"
  install_file "$state/original.env" "$deploy/.env"
  compose_file "$state/target.json" up -d --no-build --pull never --wait --wait-timeout 180
  cleanup_success
}

run_transaction() {
  local key total=0 size free
  for key in postgres_data quorum_files caddy_data caddy_config; do
    size=$(volume_io "$key" size); total=$((total + size))
  done
  free=$(df -Pk "$state" | awk 'NR==2 {print $4}')
  ((free > total + total / 10 + 262144)) || fail '空间不足，无法保存完整恢复点。'
  docker run --rm --network none --user 0 --entrypoint sh \
    --mount "type=volume,src=$(jq -r '.volumes.postgres_data.name' "$state/old.json"),dst=/volume,readonly" \
    "$(jq -r '.services.app.image' "$state/old.json")" -ec 'test -z "$(find /volume -type l -print -quit)"' \
    || fail '外置数据库表空间不支持自动快照。'
  echo '进入维护阶段，暂停访问并备份数据。'
  phase quiescing
  stop_services
  assert_quiescent
  compose_file "$state/old.json" stop -t 60 postgres
  phase backing-up
  for key in postgres_data quorum_files caddy_data caddy_config; do volume_io "$key" backup; done
  (cd "$state"; sha256sum postgres_data.tar quorum_files.tar caddy_data.tar caddy_config.tar original.yaml original.env original.json old.json old-version verify.json restore-verify.json target.yaml target.json release.json manifest.json > SHA256SUMS.new)
  sync -f "$state"; mv "$state/SHA256SUMS.new" "$state/SHA256SUMS"; sync -f "$state"
  phase verifying
  compose_file "$state/verify.json" up -d --no-build --pull never --wait --wait-timeout 180
  [[ $(sql "$state/verify.json" "SELECT bool_and(datcollversion IS NOT DISTINCT FROM pg_database_collation_actual_version(oid)) FROM pg_database WHERE datallowconn;") == t ]] || fail '数据库排序规则版本发生变化，需要单独迁移。'
  verify_http "$state/verify.json" "$target_version" yes
  # Protocol 1 does not migrate file bytes. Detect deletions or altered content before opening writes.
  volume_io quorum_files compare
  phase committed
  finish_upgrade
}

recover() {
  local stage; stage=$(cat "$state/phase")
  case "$stage" in
    committed) echo '上次升级已验收，继续开放服务及清理；不会恢复旧数据。'; finish_upgrade ;;
    rollback-verified) finish_rollback ;;
    prepared) docker rm -f "$project-upgrade-io" >/dev/null 2>&1 || true; retire_state; echo '已取消尚未开始的升级。' ;;
    quiescing|backing-up|verifying|restoring|restored) restore_previous ;;
    *) fail "无法识别的升级阶段：$stage；保留恢复材料。" ;;
  esac
}
on_exit() {
  local result=$?
  trap - EXIT INT TERM
  if ((result != 0)) && [[ -f $state/phase ]]; then
    # Run recovery as an ordinary command under errexit, NOT an if/|| function call (which disables errexit in Bash).
    echo "升级未完成；恢复材料：$state" >&2
    set +e
    (set -Eeuo pipefail; recover)
    local recovery_result=$?
    set -e
    if ((recovery_result != 0)); then echo '自动恢复未完成。保持当前状态，修复错误后再次运行同一脚本继续恢复。' >&2; fi
  fi
  rm -rf "$temporary"
  exit "$result"
}

upgrade_main() {
  for command in docker jq curl sha256sum flock sync awk; do command -v "$command" >/dev/null || fail "缺少命令：$command"; done
  deploy=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  config="$deploy/compose.production.yaml"; state="$deploy/.upgrade"
  exec 9>"$deploy/.upgrade.lock"; flock -n 9 || fail '另一个升级正在运行。'
  temporary=$(mktemp -d)
  trap on_exit EXIT; trap 'exit 130' INT; trap 'exit 143' TERM
  # The durable rename is the end of recovery. Only deletion may remain after a crash.
  if [[ -d $state.done ]]; then
    [[ ! -e $state ]] || fail '发现冲突的升级记录；保留恢复材料。'
    rm -rf "$state.done"; sync -f "$deploy"
    echo '上次升级事务的清理已完成。'; return
  fi
  if [[ -d $state ]]; then
    project=$(jq -er .name "$state/old.json")
  else
    project=$(docker compose --env-file "$deploy/.env" -f "$config" config --format json | jq -er .name)
  fi
  [[ $project =~ ^[a-z0-9][a-z0-9_-]+$ ]] || fail '无效部署名称。'
  repository=brepublic; github_repository=BREPUBLIC/Quorum
  if [[ -d $state ]]; then recover; return; fi
  rm -rf "$state.new"
  requested_version=''; allow_prerelease=false
  while (($# > 0)); do
    case "$1" in
      --prerelease) allow_prerelease=true; shift ;;
      --release) [[ $# -ge 2 && -z $requested_version ]] || fail '用法：upgrade.sh [--prerelease] [--release vX.Y.Z[-rc.N]]'; requested_version=$2; shift 2 ;;
      *) fail '用法：upgrade.sh [--prerelease] [--release vX.Y.Z[-rc.N]]' ;;
    esac
  done
  compose_file "$config" config --format json > "$temporary/current.json"
  local container image
  container=$(compose_file "$config" ps -q app)
  [[ -n $container ]] || fail '未找到正在运行的 Quorum；首次部署请使用部署手册。'
  image=$(docker inspect --format '{{.Image}}' "$container")
  current_version=$(docker image inspect --format '{{index .Config.Labels "io.quorum.release"}}' "$image")
  if ! version_number "$current_version" >/dev/null 2>&1; then
    current_version=$(compose_file "$config" exec -T app node -e "fetch('http://127.0.0.1:3000/api/v1/version').then(r=>r.json()).then(v=>process.stdout.write(v.data.version))")
  fi
  version_number "$current_version" >/dev/null || fail '当前版本号无法识别。'
  echo "当前版本：$current_version"
  # Do not wrap select_release in a conditional: network/check failures must stop immediately.
  select_release
  target_version=$(jq -r .version "$temporary/release.json"); target_commit=$(jq -r .commit "$temporary/release.json")
  echo "准备升级至 $target_version。"
  pull_release
  write_target_config
  prepare_state
  run_transaction
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then upgrade_main "$@"; fi
