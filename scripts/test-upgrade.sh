#!/usr/bin/env bash
# Real Docker/PostgreSQL/filesystem/HTTPS acceptance; GitHub discovery is covered separately.
# All resources belong to an isolated disposable Compose project, never quorum/quorum-dev.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source scripts/wsl-env.sh
root=$PWD
work=$(mktemp -d)
project="quorum-upgrade-test-$$"
base_app="${QUORUM_UPGRADE_TEST_APP:-quorum-upgrade-test-base:local}"
interrupted_driver_group=''
cleanup() {
  result=$?
  if [[ -n $interrupted_driver_group ]]; then
    kill -KILL -- "-$interrupted_driver_group" 2>/dev/null || true
    wait "$interrupted_driver_group" 2>/dev/null || true
  fi
  if ((result != 0)); then
    echo "Upgrade acceptance failed; evidence in $work" >&2
    for service in app postgres caddy; do
      id=$(docker ps -aq --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$service")
      if [[ -n $id ]]; then docker logs "$id" > "$work/failure-$service.log" 2>&1; fi
    done
  fi
  docker rm -f "$project-upgrade-io" >/dev/null 2>&1 || true
  docker ps -aq --filter "label=com.docker.compose.project=$project" | xargs -r docker rm -f >/dev/null
  docker volume ls -q --filter "label=com.docker.compose.project=$project" | xargs -r docker volume rm >/dev/null
  docker network ls -q --filter "label=com.docker.compose.project=$project" | xargs -r docker network rm >/dev/null
  for name in old new corrupt broken caddy caddy-old; do docker image rm "$project-$name:local" >/dev/null 2>&1 || true; done
  if ((result == 0)); then rm -rf "$work"; fi
}
trap cleanup EXIT
if [[ -z ${QUORUM_UPGRADE_TEST_APP:-} ]]; then
  docker build --target app-runtime -f deploy/Dockerfile -t "$base_app" . > "$work/build.log" 2>&1
fi
mkdir -p "$work/deploy" "$work/assets/downloads/chair-agent/v1.1.0-rc.1"
cp deploy/upgrade.sh "$work/deploy/upgrade.sh"
cat > "$work/old.Dockerfile" <<EOF2
FROM $base_app
USER root
RUN rm /app/server/migrations/0089_*.sql
LABEL io.quorum.release="v1.0.0"
ENV QUORUM_BUILD_VERSION=v1.0.0
USER node
EOF2
docker build -q -f "$work/old.Dockerfile" -t "$project-old:local" "$work" >/dev/null
cat > "$work/9000_upgrade_acceptance.sql" <<'SQL'
CREATE TABLE upgrade_probe (id integer PRIMARY KEY, message text NOT NULL);
INSERT INTO upgrade_probe VALUES (1, 'new schema');
UPDATE users SET display_name='Changed by upgrade' WHERE email='upgrade@example.test';
SQL
cat > "$work/start-new.sh" <<'SH'
#!/bin/sh
set -eu
printf 'changed by new version\n' > /var/lib/quorum/files/sentinel
rm -f /var/lib/quorum/files/nested/keep
printf 'new file\n' > /var/lib/quorum/files/new-file
find /var/lib/quorum/files/server-volume -type f -exec sh -c 'printf corrupted > "$1"' sh {} \;
exec node --enable-source-maps server/dist/index.js
SH
cat > "$work/new.Dockerfile" <<EOF2
FROM $base_app
COPY 9000_upgrade_acceptance.sql /app/server/migrations/
LABEL io.quorum.release="v1.1.0-rc.1"
ENV QUORUM_BUILD_VERSION=v1.1.0-rc.1
EOF2
docker build -q -f "$work/new.Dockerfile" -t "$project-new:local" "$work" >/dev/null
cat > "$work/corrupt.Dockerfile" <<EOF2
FROM $project-new:local
COPY start-new.sh /app/start-new.sh
CMD ["sh", "/app/start-new.sh"]
EOF2
docker build -q -f "$work/corrupt.Dockerfile" -t "$project-corrupt:local" "$work" >/dev/null
printf 'SELECT 1/0;\n' > "$work/9001_broken.sql"
cat > "$work/broken.Dockerfile" <<EOF2
FROM $project-corrupt:local
COPY 9001_broken.sql /app/server/migrations/
EOF2
docker build -q -f "$work/broken.Dockerfile" -t "$project-broken:local" "$work" >/dev/null
printf 'transport fixture EXE\n' > "$work/assets/downloads/chair-agent/v1.1.0-rc.1/windows.exe"
printf 'transport fixture AppImage\n' > "$work/assets/downloads/chair-agent/v1.1.0-rc.1/linux.AppImage"
node --input-type=module - "$work" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs'; import {createHash} from 'node:crypto';
const work=process.argv[2], platforms={};
for (const [platform,file] of [['windows','windows.exe'],['linux','linux.AppImage']]) {
  const bytes=readFileSync(`${work}/assets/downloads/chair-agent/v1.1.0-rc.1/${file}`);
  platforms[platform]={file,url:`/downloads/chair-agent/v1.1.0-rc.1/${file}`,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length};
}
writeFileSync(`${work}/assets/downloads/chair-agent/manifest.json`,JSON.stringify({schemaVersion:1,serverVersion:'v1.1.0-rc.1',commit:'a'.repeat(40),platforms}));
JS
printf '<div id="root"></div><!-- new website -->\n' > "$work/assets/index.html"
cp deploy/Caddyfile "$work/Caddyfile"
cat > "$work/caddy.Dockerfile" <<'EOF2'
FROM caddy:2.8-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY assets /srv
EOF2
docker build -q -f "$work/caddy.Dockerfile" -t "$project-caddy:local" "$work" >/dev/null
cp -r "$work/assets" "$work/old-assets"
printf '<div id="root"></div><!-- old website -->\n' > "$work/old-assets/index.html"
mv "$work/old-assets/downloads/chair-agent/v1.1.0-rc.1" "$work/old-assets/downloads/chair-agent/v1.0.0"
sed -i 's/v1.1.0-rc.1/v1.0.0/g' "$work/old-assets/downloads/chair-agent/manifest.json"
cat > "$work/caddy-old.Dockerfile" <<EOF2
FROM $project-caddy:local
RUN rm -rf /srv/downloads
COPY old-assets /srv
EOF2
docker build -q -f "$work/caddy-old.Dockerfile" -t "$project-caddy-old:local" "$work" >/dev/null
old_image=$(docker image inspect --format '{{.Id}}' "$project-old:local")
caddy_image=$(docker image inspect --format '{{.Id}}' "$project-caddy-old:local")
postgres_image=$(docker image inspect --format '{{.Id}}' postgres:16-alpine)
python3 - "$root" "$work" "$project" "$old_image" "$caddy_image" "$postgres_image" <<'PY'
from pathlib import Path
import sys,re
root,work,project,app,caddy,postgres=sys.argv[1:]
s=Path(root+'/deploy/compose.production.yaml').read_text()
s=s.replace('name: quorum','name: '+project)
s=re.sub(r'image: ghcr.io/brepublic/quorum-app@sha256:[a-f0-9]+','image: '+app,s)
s=re.sub(r'image: ghcr.io/brepublic/quorum-caddy@sha256:[a-f0-9]+','image: '+caddy,s)
s=re.sub(r'image: postgres@sha256:[a-f0-9]+','image: '+postgres,s)
s=s.replace('"80:80"','"127.0.0.1::80"').replace('"443:443"','"127.0.0.1::443"').replace('      - "443:443/udp"\n','')
s=s.replace('interval: 10s','interval: 1s').replace('interval: 5s','interval: 1s').replace('retries: 6','retries: 10').replace('start_period: 15s','start_period: 5s')
Path(work+'/deploy/compose.production.yaml').write_text(s)
Path(work+'/deploy/.env').write_text('POSTGRES_USER=upgrade_test\nPOSTGRES_PASSWORD=only-for-isolated-test\nPOSTGRES_DB=upgrade_test\nQUORUM_SITE_ADDRESS=localhost\nQUORUM_ALLOWED_ORIGINS=https://localhost\nQUORUM_STORAGE_HARD_MIN_FREE_BYTES=1\n')
PY
compose=(docker compose -p "$project" --env-file "$work/deploy/.env" -f "$work/deploy/compose.production.yaml")
"${compose[@]}" up -d --wait --wait-timeout 180 > "$work/start.log" 2>&1
"${compose[@]}" exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > "$work/root.crt"
export CURL_CA_BUNDLE="$work/root.crt"
port=$("${compose[@]}" port caddy 443); port=${port##*:}
base="https://localhost:$port"
secret=$("${compose[@]}" logs app | sed -n 's/.*Quorum bootstrap secret (shown once): //p' | head -1)
curl -fsS --retry 5 --retry-connrefused -H 'Origin: https://localhost' -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg secret "$secret" '{secret:$secret,email:"admin@example.test",displayName:"Test administrator",password:"Upgrade-acceptance-123!"}')" \
  "$base/api/v1/bootstrap/admin" > "$work/admin.json"
jq -e '.data.user.email == "admin@example.test"' "$work/admin.json" >/dev/null
"${compose[@]}" exec -T app sh -ec 'mkdir -p /var/lib/quorum/files/nested; printf "original bytes\n" > /var/lib/quorum/files/sentinel; printf "must survive\n" > /var/lib/quorum/files/nested/keep; printf "hidden\n" > /var/lib/quorum/files/.hidden'
# Seed a real private committee and committed file through the application's services.
"${compose[@]}" exec -T app node --input-type=module > "$work/file.json" <<'JS'
import pg from './server/node_modules/pg/lib/index.js'; import {createHash} from 'node:crypto';
import {loadConfig} from './server/dist/config.js';
import {IdentityService} from './server/dist/modules/identity/service.js';
import {PostgresIdentityStore} from './server/dist/modules/identity/postgres.js';
import {Stage3Service} from './server/dist/modules/stage3/service.js';
import {Stage4Service} from './server/dist/modules/stage4/service.js';
import {Stage6StorageService} from './server/dist/modules/storage/service.js';
import {Stage6UploadService} from './server/dist/modules/storage/upload-service.js';
import {Stage6ServerVolumeService} from './server/dist/modules/storage/server-volume-service.js';
import {ServerVolumeStore} from './server/dist/modules/storage/server-volume.js';
import {DurableStagingStore} from './server/dist/modules/storage/staging.js';
const config=loadConfig(), pool=new pg.Pool({connectionString:config.databaseUrl});
try {
 const ctx={requestId:'upgrade-seed',sourceIp:'127.0.0.1',userAgent:'Upgrade acceptance'};
 const identity=new IdentityService(new PostgresIdentityStore(pool));
 const adminLogin=await identity.login({email:'admin@example.test',password:'Upgrade-acceptance-123!'},ctx);
 const admin=await identity.authenticate(adminLogin.sessionToken);
 const created=await identity.createUser(admin,{email:'upgrade@example.test',displayName:'Before upgrade'},ctx);
 const firstLogin=await identity.login({email:created.user.email,password:created.temporaryPassword},ctx);
 const changed=await identity.changePassword(await identity.authenticate(firstLogin.sessionToken),{
  currentPassword:created.temporaryPassword,newPassword:'Upgrade-acceptance-123!'},ctx);
 const auth=await identity.authenticate(changed.sessionToken);
 const stage3=new Stage3Service(pool),stage4=new Stage4Service(pool);
 const rule=(await stage3.listRulePackages()).find(r=>r.key==='builtin:beijing-academic');
 const countries=(await stage4.listCountryTemplates(auth)).find(c=>c.key==='builtin:default');
 const committee=await stage4.createCommittee(auth,{name:'Upgrade acceptance',visibility:'PRIVATE',committeeLanguage:'en',
  activeRulePackageVersionId:rule.versions.at(-1).id,countryTemplateKey:countries.key,countryTemplateRevision:countries.revision},'upgrade-committee',ctx);
 const storage=new Stage6StorageService(pool);
 await storage.createServerVolumeBinding(auth,committee.id,{baseRevision:committee.revision},'upgrade-binding',ctx);
 const staging=new DurableStagingStore(config.storagePath+'/staging',config.maxFileBytes,config.maxUploadRequestBytes);
 const volume=new ServerVolumeStore(config.storagePath+'/server-volume',config.maxFileBytes);
 const uploads=new Stage6UploadService(pool,staging);
 const bytes=Buffer.from('private committee file before upgrade\n');
 const upload=await uploads.createUpload(auth,committee.id,{logicalName:'Upgrade proof',originalName:'proof.pdf',mediaType:'application/pdf',
  fileType:'WORKING_PAPER',expectedSizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},'upgrade-file',ctx);
 await uploads.receiveContent(auth,upload.id,(async function*(){yield bytes;})(),'upgrade-bytes',bytes.length,ctx);
 const file=await new Stage6ServerVolumeService(pool,storage,staging,volume).commitUpload(auth,upload.id,{},'upgrade-commit',ctx);
 const pending=await uploads.createUpload(auth,committee.id,{logicalName:'Pending upload',originalName:'pending.pdf',mediaType:'application/pdf',
  fileType:'WORKING_PAPER',expectedSizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},'pending-upload',ctx);
 console.log(JSON.stringify({fileId:file.id,committeeId:committee.id,pendingUploadId:pending.id}));
} finally {await pool.end();}
JS
cp -p "$work/deploy/compose.production.yaml" "$work/baseline.yaml"
cp -p "$work/deploy/.env" "$work/baseline.env"
cat > "$work/driver.sh" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
source "$TEST_WORK/deploy/upgrade.sh"
# Only GitHub/registry discovery is substituted. All switching, backup, restore,
# migrations, data writes, TLS downloads and Docker restart policies are real.
select_release() {
  if [[ ${TEST_FAULT:-} == inspect-prerelease ]]; then
    [[ $current_version == v1.1.0-rc.1 && $allow_prerelease == true ]]
    echo "TEST reached inspect-prerelease"; return 2
  fi
  jq -n --arg app "$(docker image inspect --format '{{.Id}}' "$TEST_PROJECT-${TEST_IMAGE:-new}:local")" \
    --arg caddy "$(docker image inspect --format '{{.Id}}' "$TEST_PROJECT-caddy:local")" \
    --arg postgres "$(docker image inspect --format '{{.Id}}' postgres:16-alpine)" \
    '{version:"v1.1.0-rc.1",commit:("a" * 40),images:{app:$app,caddy:$caddy,postgres:$postgres}}' > "$temporary/release.json"
}
pull_release() { cp "$TEST_WORK/assets/downloads/chair-agent/manifest.json" "$temporary/manifest.json"; }
# Pause the real restore container after erasing the file volume, before extraction.
# The outer test kills the upgrade shell while its Docker client is still waiting.
docker() {
  local args=("$@") i
  if [[ ${TEST_FAULT:-} == kill-restore-during && ${args[*]} == *'sh restore quorum_files'* ]]; then
    for i in "${!args[@]}"; do
      if [[ ${args[$i]} == *'find /volume -mindepth 1 -delete;'* ]]; then
        args[$i]=${args[$i]/'find /volume -mindepth 1 -delete;'/'find /volume -mindepth 1 -delete; echo "TEST reached kill-restore-during"; touch /backup/restore-cleared; while :; do sleep 1; done;'}
      fi
    done
  fi
  if [[ ${TEST_FAULT:-} == restore-sync-failure && ${args[*]} == *'sh restore quorum_files'* ]]; then
    for i in "${!args[@]}"; do
      args[$i]=${args[$i]/'sync -f /volume'/'echo "TEST reached restore-sync-failure"; false'}
    done
  fi
  command docker "${args[@]}"
}
eval "$(declare -f verify_http | sed '1s/verify_http/real_verify_http/')"
verify_http() {
  real_verify_http "$@"
  if [[ $1 == "$state/verify.json" ]]; then
    test "$(sql "$state/verify.json" 'SELECT message FROM upgrade_probe WHERE id=1')" = 'new schema'
    if [[ ${TEST_IMAGE:-} == corrupt ]]; then [[ $(compose_file "$state/verify.json" exec -T app cat /var/lib/quorum/files/sentinel) == 'changed by new version' ]]; fi
    # No public binding, no external network and no automatic restart before commit.
    test "$(docker network inspect "${project}_upgrade_isolated" --format '{{.Internal}}')" = true
    test "$(compose_file "$state/verify.json" ps -q app | xargs docker inspect --format '{{.HostConfig.RestartPolicy.Name}}')" = no
    case "${TEST_FAULT:-}" in
      kill-verified) echo "TEST reached $TEST_FAULT"; kill -KILL $$ ;;
    esac
  fi
}
eval "$(declare -f restore_previous | sed '1s/restore_previous/real_restore_previous/')"
restore_previous() {
  if [[ ${TEST_FAULT:-} == migration-failure || ${TEST_FAULT:-} == validation ]]; then
    test "$(sql "$state/verify.json" 'SELECT max(version) FROM quorum_meta.schema_migrations')" = 9000
    [[ $(compose_file "$state/verify.json" exec -T postgres sh -c 'printf ready') == ready ]]
    echo "TEST reached $TEST_FAULT after real migration"
  fi
  real_restore_previous
}
eval "$(declare -f assert_quiescent | sed '1s/assert_quiescent/real_assert_quiescent/')"
assert_quiescent() {
  if [[ ${TEST_FAULT:-} == active-upload ]]; then
    test "$(sql "$state/old.json" "SELECT count(*) FROM file_uploads WHERE status='RECEIVING'")" = 1
    echo "TEST reached $TEST_FAULT"
  fi
  real_assert_quiescent
}
eval "$(declare -f volume_io | sed '1s/volume_io/real_volume_io/')"
volume_io() {
  real_volume_io "$@"
  if [[ ${TEST_FAULT:-} == backup-failure && $1 == postgres_data && $2 == backup ]]; then echo "TEST reached $TEST_FAULT"; return 1; fi
  if [[ ${TEST_FAULT:-} == kill-backup && $1 == postgres_data && $2 == backup ]]; then echo "TEST reached $TEST_FAULT"; kill -KILL $$; fi
  if [[ ${TEST_FAULT:-} == kill-restore && $1 == quorum_files && $2 == restore ]]; then echo "TEST reached $TEST_FAULT"; kill -KILL $$; fi
}
eval "$(declare -f phase | sed '1s/phase/real_phase/')"
phase() {
  real_phase "$@"
  if [[ ${TEST_FAULT:-} == kill-commit && $1 == committed ]]; then echo "TEST reached $TEST_FAULT"; kill -KILL $$; fi
}
eval "$(declare -f remove_isolated_network | sed '1s/remove_isolated_network/real_remove_isolated_network/')"
remove_isolated_network() {
  real_remove_isolated_network
  if [[ ${TEST_FAULT:-} == kill-rollback-active || ${TEST_FAULT:-} == kill-upgrade-active ]]; then
    echo "TEST reached $TEST_FAULT"; kill -KILL "$BASHPID"
  fi
}
# Interrupt deletion after the durable rename, with an intentionally incomplete directory.
rm() {
  if [[ ${TEST_FAULT:-} == kill-cleanup && $* == "-rf $state.done" ]]; then
    command rm -f "$state.done/phase" "$state.done/old.json"
    echo "TEST reached $TEST_FAULT"; kill -KILL "$BASHPID"
  fi
  command rm "$@"
}
upgrade_main --prerelease
SH
export TEST_WORK="$work" TEST_PROJECT="$project"
run_driver() {
  local fault=$1 image=${2:-new} result=0 pid attempt
  if [[ $fault == kill-restore-during ]]; then
    TEST_FAULT="$fault" TEST_IMAGE="$image" setsid bash "$work/driver.sh" > "$work/run-$fault.log" 2>&1 &
    pid=$!
    interrupted_driver_group=$pid
    for attempt in {1..600}; do
      [[ ! -f $work/deploy/.upgrade/restore-cleared ]] || break
      if ! kill -0 "$pid" 2>/dev/null; then cat "$work/run-$fault.log"; return 1; fi
      sleep 0.1
    done
    if [[ ! -f $work/deploy/.upgrade/restore-cleared ]]; then kill -KILL "$pid"; wait "$pid" || true; return 1; fi
    docker exec "$project-upgrade-io" sh -ec 'test -z "$(ls -A /volume)"'
    kill -KILL "$pid"; wait "$pid" || result=$?
  else
    TEST_FAULT="$fault" TEST_IMAGE="$image" bash "$work/driver.sh" > "$work/run-$fault.log" 2>&1 || result=$?
  fi
  if [[ $fault == recover || $fault == success ]]; then
    if ((result != 0)); then cat "$work/run-$fault.log"; return "$result"; fi
  else
    ((result != 0)) || { echo "Expected failure: $fault"; return 1; }
    if ! grep -q "TEST reached $fault" "$work/run-$fault.log"; then cat "$work/run-$fault.log"; return 1; fi
  fi
}
assert_restored() {
  cmp "$work/baseline.yaml" "$work/deploy/compose.production.yaml"
  cmp "$work/baseline.env" "$work/deploy/.env"
  test ! -d "$work/deploy/.upgrade"
  local value
  value=$("${compose[@]}" exec -T postgres psql -X -U upgrade_test -d upgrade_test -Atc "SELECT display_name FROM users WHERE email='upgrade@example.test'")
  test "$value" = "${1:-Before upgrade}"
  test "$("${compose[@]}" exec -T postgres psql -X -U upgrade_test -d upgrade_test -Atc 'SELECT max(version) FROM quorum_meta.schema_migrations')" = 88
  test "$("${compose[@]}" exec -T postgres psql -X -U upgrade_test -d upgrade_test -Atc "SELECT to_regclass('upgrade_probe') IS NULL")" = t
  "${compose[@]}" exec -T app sh -ec 'test "$(cat /var/lib/quorum/files/sentinel)" = "original bytes"; test "$(cat /var/lib/quorum/files/nested/keep)" = "must survive"; test "$(cat /var/lib/quorum/files/.hidden)" = hidden; test ! -e /var/lib/quorum/files/new-file'
  port=$("${compose[@]}" port caddy 443); port=${port##*:}
  curl -fsS -c "$work/cookies" -H 'Content-Type: application/json' -H 'Origin: https://localhost' \
    -d '{"email":"upgrade@example.test","password":"Upgrade-acceptance-123!"}' "https://localhost:$port/api/v1/auth/login" > "$work/login.json"
  jq -e --arg expected "${1:-Before upgrade}" '.data.user.displayName == $expected' "$work/login.json" >/dev/null
  curl -fsS -b "$work/cookies" "https://localhost:$port/api/v1/committees" | jq -e '.data' >/dev/null
  local file_id; file_id=$(jq -r .fileId "$work/file.json")
  curl -fsS -b "$work/cookies" "https://localhost:$port/api/v1/files/$file_id/download" > "$work/downloaded"
  printf 'private committee file before upgrade\n' > "$work/expected"
  cmp "$work/expected" "$work/downloaded"
  test "$(curl -sS -o /dev/null -w '%{http_code}' "https://localhost:$port/api/v1/files/$file_id/download")" != 200
  test "$("${compose[@]}" ps -q app | xargs docker inspect --format '{{.Image}}')" = "$old_image"
  test "$("${compose[@]}" ps -q caddy | xargs docker inspect --format '{{.Image}}')" = "$caddy_image"
  test "$("${compose[@]}" ps -q postgres | xargs docker inspect --format '{{.Image}}')" = "$postgres_image"
  curl -fsS "https://localhost:$port/" | grep -q 'old website'
  curl -fsS "https://localhost:$port/downloads/chair-agent/manifest.json" | jq -e '.serverVersion == "v1.0.0"' >/dev/null
  test "$(curl -sS -o /dev/null -w '%{http_code}' "https://localhost:$port/downloads/chair-agent/v1.1.0-rc.1/windows.exe")" = 404
}
# These checks must fail before any service is stopped or recovery point activated.
reject_preflight() {
  local fault=$1 message=$2 result=0 before after
  before=$("${compose[@]}" ps -q app)
  TEST_FAULT="$fault" bash "$work/driver.sh" > "$work/run-$fault.log" 2>&1 || result=$?
  ((result != 0)) && grep -q "$message" "$work/run-$fault.log" || { cat "$work/run-$fault.log"; return 1; }
  after=$("${compose[@]}" ps -q app); test "$before" = "$after"
  test ! -d "$work/deploy/.upgrade"
}
sed -i "s|image: $old_image|image: $project-old:local|" "$work/deploy/compose.production.yaml"
"${compose[@]}" up -d --wait --wait-timeout 180 > "$work/mutable-tag.log" 2>&1
docker tag "$project-new:local" "$project-old:local"
reject_preflight mutable-tag '必须使用镜像内容哈希'
docker tag "$old_image" "$project-old:local"
cp -p "$work/baseline.yaml" "$work/deploy/compose.production.yaml"
"${compose[@]}" up -d --wait --wait-timeout 180 >> "$work/mutable-tag.log" 2>&1
assert_restored
echo 'PASS: moved image tag is refused before stopping the actual old version'
docker run -d --name "$project-extra" --label "com.docker.compose.project=$project" \
  --label com.docker.compose.oneoff=True --mount "type=volume,src=${project}_quorum_files,dst=/data" \
  --entrypoint sh "$old_image" -c 'sleep 600' >/dev/null
reject_preflight extra-writer '数据卷被部署服务之外的容器使用'
docker rm -f "$project-extra" >/dev/null
assert_restored
echo 'PASS: an extra same-project container cannot keep writing into a cold snapshot'
docker volume create --label "com.docker.compose.project=$project" "${project}_wrong_files" >/dev/null
sed -i "/^  quorum_files:$/a\    name: ${project}_wrong_files" "$work/deploy/compose.production.yaml"
reject_preflight wrong-volume '实际数据卷与配置不同'
cp -p "$work/baseline.yaml" "$work/deploy/compose.production.yaml"
assert_restored
echo 'PASS: a changed volume name is rejected even when the Compose service hash is unchanged'
pending_upload=$(jq -r .pendingUploadId "$work/file.json")
"${compose[@]}" exec -T postgres psql -X -U upgrade_test -d upgrade_test -c "UPDATE file_uploads SET status='RECEIVING',receiving_started_at=now() WHERE id='$pending_upload'" >/dev/null
run_driver active-upload
assert_restored
"${compose[@]}" exec -T postgres psql -X -U upgrade_test -d upgrade_test -c "UPDATE file_uploads SET status='CREATED',receiving_started_at=NULL WHERE id='$pending_upload'" >/dev/null
echo 'PASS: in-flight upload blocks upgrade before snapshot or migration'
run_driver backup-failure
assert_restored
echo 'PASS: incomplete backup failure resumes original data without restoring partial archives'
run_driver migration-failure broken
assert_restored
echo 'PASS: failed migration restores schema, account, files, config and login'
run_driver validation corrupt
assert_restored
echo 'PASS: failure after successful migration and file mutation restores all state'
run_driver kill-backup
run_driver recover
assert_restored
echo 'PASS: SIGKILL during incomplete backup resumes old version without partial restore'
run_driver kill-verified corrupt
test -d "$work/deploy/.upgrade"
rm "$work/deploy/.env"
printf 'invalid live configuration: [\n' > "$work/deploy/compose.production.yaml"
run_driver kill-restore-during
run_driver kill-restore
run_driver restore-sync-failure
test "$(cat "$work/deploy/.upgrade/phase")" = restoring
test -z "$(docker ps -q --filter "label=com.docker.compose.project=$project")"
POSTGRES_DB=wrong_recovery_database QUORUM_STORAGE_PATH=/wrong-path run_driver recover
assert_restored
echo 'PASS: repeated SIGKILL restores exact old version despite missing env, edited config and different shell variables'
run_driver kill-verified corrupt
run_driver kill-rollback-active
test "$(cat "$work/deploy/.upgrade/phase")" = rollback-verified
"${compose[@]}" exec -T postgres psql -X -U upgrade_test -d upgrade_test -c "UPDATE users SET display_name='Written after rollback' WHERE email='upgrade@example.test'" >/dev/null
"${compose[@]}" exec -T app sh -ec 'printf "after rollback\n" > /var/lib/quorum/files/post-rollback'
run_driver recover
assert_restored 'Written after rollback'
"${compose[@]}" exec -T app sh -ec 'test "$(cat /var/lib/quorum/files/post-rollback)" = "after rollback"'
"${compose[@]}" exec -T postgres psql -X -U upgrade_test -d upgrade_test -c "UPDATE users SET display_name='Before upgrade' WHERE email='upgrade@example.test'" >/dev/null
echo 'PASS: rollback activation interruption preserves subsequent database and file writes with network already removed'
run_driver kill-commit
run_driver kill-upgrade-active
test "$(cat "$work/deploy/.upgrade/phase")" = committed
"${compose[@]}" exec -T postgres psql -X -U upgrade_test -d upgrade_test -c "INSERT INTO upgrade_probe VALUES (2,'written after activation')" >/dev/null
"${compose[@]}" exec -T app sh -ec 'printf "after activation\n" > /var/lib/quorum/files/post-activation'
run_driver kill-cleanup
test ! -d "$work/deploy/.upgrade"
test -d "$work/deploy/.upgrade.done"
run_driver recover
test ! -d "$work/deploy/.upgrade"
test ! -d "$work/deploy/.upgrade.done"
"${compose[@]}" exec -T postgres psql -X -U upgrade_test -d upgrade_test -Atc 'SELECT message FROM upgrade_probe WHERE id=1' | grep -qx 'new schema'
"${compose[@]}" exec -T postgres psql -X -U upgrade_test -d upgrade_test -Atc 'SELECT message FROM upgrade_probe WHERE id=2' | grep -qx 'written after activation'
"${compose[@]}" exec -T app sh -ec 'test "$(cat /var/lib/quorum/files/post-activation)" = "after activation"'
test "$("${compose[@]}" ps -q app | xargs docker inspect --format '{{.Image}}')" = "$(docker image inspect --format '{{.Id}}' "$project-new:local")"
test "$("${compose[@]}" ps -q caddy | xargs docker inspect --format '{{.Image}}')" = "$(docker image inspect --format '{{.Id}}' "$project-caddy:local")"
port=$("${compose[@]}" port caddy 443); port=${port##*:}
curl -fsS "https://localhost:$port/api/v1/version" | jq -e '.data.version == "v1.1.0-rc.1"' >/dev/null
curl -fsS "https://localhost:$port/" | grep -q 'new website'
curl -fsS "https://localhost:$port/downloads/chair-agent/manifest.json" | jq -e '.serverVersion == "v1.1.0-rc.1"' >/dev/null
cmp "$work/baseline.env" "$work/deploy/.env"
echo 'PASS: interruptions after commit, public activation and partial cleanup retain the new version and all new writes'
run_driver inspect-prerelease
test ! -d "$work/deploy/.upgrade"
echo 'PASS: the running prerelease is recognized on a later upgrade invocation'
echo 'Real upgrade and rollback acceptance passed.'
