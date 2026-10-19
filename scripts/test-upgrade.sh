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
cleanup() {
  result=$?
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
  for name in old new corrupt broken caddy; do docker image rm "$project-$name:local" >/dev/null 2>&1 || true; done
  if ((result == 0)); then rm -rf "$work"; fi
}
trap cleanup EXIT
if [[ -z ${QUORUM_UPGRADE_TEST_APP:-} ]]; then
  docker build --target app-runtime -f deploy/Dockerfile -t "$base_app" . > "$work/build.log" 2>&1
fi
mkdir -p "$work/deploy" "$work/assets/downloads/chair-agent/v1.1.0"
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
LABEL io.quorum.release="v1.1.0"
ENV QUORUM_BUILD_VERSION=v1.1.0
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
printf 'transport fixture EXE\n' > "$work/assets/downloads/chair-agent/v1.1.0/windows.exe"
printf 'transport fixture AppImage\n' > "$work/assets/downloads/chair-agent/v1.1.0/linux.AppImage"
node --input-type=module - "$work" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs'; import {createHash} from 'node:crypto';
const work=process.argv[2], platforms={};
for (const [platform,file] of [['windows','windows.exe'],['linux','linux.AppImage']]) {
  const bytes=readFileSync(`${work}/assets/downloads/chair-agent/v1.1.0/${file}`);
  platforms[platform]={file,url:`/downloads/chair-agent/v1.1.0/${file}`,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length};
}
writeFileSync(`${work}/assets/downloads/chair-agent/manifest.json`,JSON.stringify({schemaVersion:1,serverVersion:'v1.1.0',commit:'a'.repeat(40),platforms}));
JS
printf '<div id="root"></div>\n' > "$work/assets/index.html"
cp deploy/Caddyfile "$work/Caddyfile"
cat > "$work/caddy.Dockerfile" <<'EOF2'
FROM caddy:2.8-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY assets /srv
EOF2
docker build -q -f "$work/caddy.Dockerfile" -t "$project-caddy:local" "$work" >/dev/null
python3 - "$root" "$work" "$project" <<'PY'
from pathlib import Path
import sys,re
root,work,project=sys.argv[1:]
s=Path(root+'/deploy/compose.production.yaml').read_text()
s=s.replace('name: quorum','name: '+project)
s=re.sub(r'image: ghcr.io/brepublic/quorum-app@sha256:[a-f0-9]+','image: '+project+'-old:local',s)
s=re.sub(r'image: ghcr.io/brepublic/quorum-caddy@sha256:[a-f0-9]+','image: '+project+'-caddy:local',s)
s=re.sub(r'image: postgres@sha256:[a-f0-9]+','image: postgres:16-alpine',s)
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
  jq -n --arg app "$TEST_PROJECT-${TEST_IMAGE:-new}:local" --arg caddy "$TEST_PROJECT-caddy:local" \
    '{version:"v1.1.0",commit:("a" * 40),images:{app:$app,caddy:$caddy,postgres:"postgres:16-alpine"}}' > "$temporary/release.json"
}
pull_release() { cp "$TEST_WORK/assets/downloads/chair-agent/manifest.json" "$temporary/manifest.json"; }
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
upgrade_main
SH
export TEST_WORK="$work" TEST_PROJECT="$project"
run_driver() {
  local fault=$1 image=${2:-new} result=0
  TEST_FAULT="$fault" TEST_IMAGE="$image" bash "$work/driver.sh" > "$work/run-$fault.log" 2>&1 || result=$?
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
  test "$value" = 'Before upgrade'
  test "$("${compose[@]}" exec -T postgres psql -X -U upgrade_test -d upgrade_test -Atc 'SELECT max(version) FROM quorum_meta.schema_migrations')" = 88
  test "$("${compose[@]}" exec -T postgres psql -X -U upgrade_test -d upgrade_test -Atc "SELECT to_regclass('upgrade_probe') IS NULL")" = t
  "${compose[@]}" exec -T app sh -ec 'test "$(cat /var/lib/quorum/files/sentinel)" = "original bytes"; test "$(cat /var/lib/quorum/files/nested/keep)" = "must survive"; test "$(cat /var/lib/quorum/files/.hidden)" = hidden; test ! -e /var/lib/quorum/files/new-file'
  port=$("${compose[@]}" port caddy 443); port=${port##*:}
  curl -fsS -c "$work/cookies" -H 'Content-Type: application/json' -H 'Origin: https://localhost' \
    -d '{"email":"upgrade@example.test","password":"Upgrade-acceptance-123!"}' "https://localhost:$port/api/v1/auth/login" > "$work/login.json"
  jq -e '.data.user.displayName == "Before upgrade"' "$work/login.json" >/dev/null
  curl -fsS -b "$work/cookies" "https://localhost:$port/api/v1/committees" | jq -e '.data' >/dev/null
  local file_id; file_id=$(jq -r .fileId "$work/file.json")
  curl -fsS -b "$work/cookies" "https://localhost:$port/api/v1/files/$file_id/download" > "$work/downloaded"
  printf 'private committee file before upgrade\n' > "$work/expected"
  cmp "$work/expected" "$work/downloaded"
  test "$(curl -sS -o /dev/null -w '%{http_code}' "https://localhost:$port/api/v1/files/$file_id/download")" != 200
}
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
run_driver kill-restore
run_driver recover
assert_restored
echo 'PASS: SIGKILL after migration plus second SIGKILL during restore recovers idempotently'
run_driver kill-commit
run_driver recover
test ! -d "$work/deploy/.upgrade"
"${compose[@]}" exec -T postgres psql -X -U upgrade_test -d upgrade_test -Atc 'SELECT message FROM upgrade_probe' | grep -qx 'new schema'
port=$("${compose[@]}" port caddy 443); port=${port##*:}
curl -fsS "https://localhost:$port/api/v1/version" | jq -e '.data.version == "v1.1.0"' >/dev/null
cmp "$work/baseline.env" "$work/deploy/.env"
echo 'PASS: interruption after commit resumes new version without losing migrated data'
echo 'Real upgrade and rollback acceptance passed.'
