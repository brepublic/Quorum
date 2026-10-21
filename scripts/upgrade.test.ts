// @vitest-environment node
import {execFile} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
const run = promisify(execFile);
const script = resolve('deploy/upgrade.sh');
let directory: string;
const commit = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const manifest = {schemaVersion: 1, upgradeProtocol: 1, deploymentSchema: 1, version: 'v1.2.0', commit,
  platform: 'linux/amd64', postgresMajor: 16, minimumDatabaseMigration: 24, migrations: {'24': digest},
  images: {app: `ghcr.io/brepublic/quorum-app@sha256:${digest}`, caddy: `ghcr.io/brepublic/quorum-caddy@sha256:${digest}`,
    postgres: `postgres@sha256:${digest}`}};
beforeEach(async () => {directory = await mkdtemp(join(tmpdir(), 'quorum-upgrade-unit-'));});
afterEach(async () => {await rm(directory, {recursive: true, force: true});});
async function shell(code: string, env: Record<string,string> = {}) {
  return run('bash', ['-c', 'source "$UPGRADE_SCRIPT"\n' + code], {env: {...process.env, UPGRADE_SCRIPT: script, TEST_DIR: directory, ...env}});
}
it('continues without sudo when already root', async () => {
  const result = await shell('id() { echo 0; }; sudo() { exit 99; }; require_root; echo ready');
  expect(result.stdout.trim()).toBe('ready');
  expect(result.stderr).toBe('');
});
it.each([false, true])('restarts with sudo and preserves arguments (custom CA: %s)', async customCa => {
  await writeFile(join(directory, 'sudo'), '#!/bin/bash\nprintf "%s\\n" "$@" > "$TEST_DIR/sudo-args"\nexit 23\n', {mode: 0o755});
  await expect(shell(`id() { echo 1000; }; require_root --prerelease --release 'v1.3.0-rc.1'; touch "$TEST_DIR/unsafe"`,
    {PATH: `${directory}:${process.env.PATH}`, CURL_CA_BUNDLE: customCa ? '/tmp/custom ca.pem' : ''}))
    .rejects.toMatchObject({code: 23, stderr: expect.stringContaining('restarting with sudo')});
  expect((await readFile(join(directory, 'sudo-args'), 'utf8')).trim().split('\n')).toEqual([
    ...(customCa ? ['--preserve-env=CURL_CA_BUNDLE'] : []), '--', 'bash', script, '--prerelease', '--release', 'v1.3.0-rc.1']);
  await expect(readFile(join(directory, 'unsafe'))).rejects.toThrow();
});
it('explains how to proceed when sudo is unavailable', async () => {
  await expect(shell(`id() { echo 1000; }; command() { return 1; }; require_root; touch "$TEST_DIR/unsafe"`))
    .rejects.toThrow('Missing command: sudo. Run this script as root.');
  await expect(readFile(join(directory, 'unsafe'))).rejects.toThrow();
});
it('accepts only complete stable manifests with pinned images', async () => {
  await writeFile(join(directory, 'release.json'), JSON.stringify(manifest));
  await shell('repository=brepublic; validate_release v1.2.0 "$TEST_DIR/release.json"');
});
it.each([
  ['protocol', {upgradeProtocol: 2}], ['database major', {postgresMajor: 17}], ['platform', {platform: 'linux/arm64'}],
  ['commit', {commit: 'HEAD'}], ['migration checksums', {migrations: {'24': 'bad'}}], ['version', {version: 'v1.2.1'}],
  ['unpinned image', {images: {...manifest.images, app: 'ghcr.io/brepublic/quorum-app:latest'}}],
  ['foreign repository', {images: {...manifest.images, caddy: `ghcr.io/other/quorum-caddy@sha256:${digest}`}}]
])('rejects invalid %s', async (_label, patch) => {
  await writeFile(join(directory, 'release.json'), JSON.stringify({...manifest, ...patch}));
  await expect(shell('repository=brepublic; validate_release v1.2.0 "$TEST_DIR/release.json"')).rejects.toThrow();
});
it.each(['v01.2.3', 'v1.2.3-rc.01', 'v1.2.3-', 'v1.2.3-rc..1', 'v1.2.3+build', 'latest', 'v1.2', 'v1.2.3;exit'])('rejects invalid version %s', async version => {
  await expect(shell('version_number "$VERSION"', {VERSION: version})).rejects.toThrow();
});
it('orders numeric versions and prerelease identifiers before the corresponding stable release', async () => {
  const expected = ['v1.2.0-1', 'v1.2.0-alpha', 'v1.2.0-alpha.1', 'v1.2.0-beta', 'v1.2.0-rc.2',
    'v1.2.0-rc.10', 'v1.2.0', 'v1.10.0', 'v2.0.0', 'v10.2.31', 'v9007199254740992.0.0', 'v9007199254740993.0.0'];
  await writeFile(join(directory, 'versions.json'), JSON.stringify([...expected].reverse()));
  const result = await shell('jq -r "$version_filter"\' sort_by(version_key)[]\' "$TEST_DIR/versions.json"');
  expect(result.stdout.trim().split('\n')).toEqual(expected);
});
it.each([['', 'false'], ['1', 'false'], ['2', 'true']])('selects the release scope with input %j', async (input, expected) => {
  const result = await shell('select_channel <<< "$INPUT"; echo "allowed=$allow_prerelease"', {INPUT: input});
  expect(result.stdout).toContain('2. Include prereleases (testing)');
  expect(result.stdout).toContain(`allowed=${expected}`);
});
it.each(['q','bad'])('stops before discovery after scope selection %s', async input => {
  await expect(shell('select_channel <<< "$INPUT"; touch "$TEST_DIR/unsafe"', {INPUT: input})).rejects.toThrow();
  await expect(readFile(join(directory, 'unsafe'))).rejects.toThrow();
});
it('refuses historical migration checksum differences', async () => {
  await writeFile(join(directory, 'release.json'), JSON.stringify(manifest));
  const code = 'config=unused; sql() { printf \'{"24":"wrong"}\'; }; compatible_database "$TEST_DIR/release.json"';
  await expect(shell(code)).rejects.toThrow();
});
it('filters drafts, prereleases, unfinished and old releases, and sorts the compatible choices', async () => {
  const releases = ['v1.1.0','v1.2.0','v1.10.0','v1.3.0','v2.0.0','v1.20.0'].map(tag => ({tag_name:tag,
    draft: tag === 'v2.0.0', prerelease: tag === 'v1.20.0', assets:tag === 'v1.3.0' ? [] : [{name:'quorum-server-release.json',
      browser_download_url:`https://github.com/brepublic/Quorum/releases/download/${tag}/quorum-server-release.json`}]}));
  await writeFile(join(directory, 'fixture-releases.json'), JSON.stringify(releases));
  for (const tag of ['v1.2.0','v1.10.0']) await writeFile(join(directory, `fixture-release-${tag}.json`), JSON.stringify({...manifest,version:tag}));
  const result = await shell(`temporary="$TEST_DIR"; current_version=v1.1.0; repository=brepublic; github_repository=brepublic/Quorum; requested_version=v1.10.0
    compatible_database() { return 0; }
    fetch() { if [[ $1 == *api.github.com* ]]; then cat "$TEST_DIR/fixture-releases.json"; else local tag=\${1%/*}; tag=\${tag##*/}; cat "$TEST_DIR/fixture-release-$tag.json"; fi; }
    select_release`);
  expect(result.stdout.trim().split('\n')).toEqual(['1. v1.10.0','  2. v1.2.0']);
  expect(JSON.parse(await readFile(join(directory, 'release.json'), 'utf8')).version).toBe('v1.10.0');
});
it('does not continue after a discovery network failure', async () => {
  await expect(shell(`temporary="$TEST_DIR"; current_version=v1.1.0; github_repository=brepublic/Quorum; requested_version=v1.2.0
    fetch() { return 22; }; select_release; touch "$TEST_DIR/unsafe"`)).rejects.toThrow();
  await expect(readFile(join(directory, 'unsafe'))).rejects.toThrow();
});
async function discoverPrereleases(current: string, requested: string, allow: boolean, input?: string) {
  const tags = ['v1.1.0','v1.2.0-RC.1','v1.2.0-rc.1','v1.2.0-rc.2','v1.2.0-rc.10','v1.2.0','v1.3.0-beta.1','v1.4.0','v2.0.0-rc.1','v3.0.0-rc.1'];
  await writeFile(join(directory, 'fixture-releases.json'), JSON.stringify(tags.map(tag => ({tag_name:tag,
    draft: tag === 'v2.0.0-rc.1', prerelease: tag.includes('-rc.') || tag === 'v1.4.0',
    assets:tag === 'v3.0.0-rc.1' ? [] : [{name:'quorum-server-release.json',
      browser_download_url:`https://github.com/brepublic/Quorum/releases/download/${tag}/quorum-server-release.json`}]}))));
  for (const tag of tags) await writeFile(join(directory, `fixture-release-${tag}.json`), JSON.stringify({...manifest,version:tag}));
  return shell(`temporary="$TEST_DIR"; current_version="$CURRENT"; repository=brepublic; github_repository=brepublic/Quorum
    requested_version="$REQUESTED"; allow_prerelease="$ALLOW"
    compatible_database() { [[ $1 != *v1.2.0-rc.10.json ]]; }
    fetch() { if [[ $1 == *api.github.com* ]]; then cat "$TEST_DIR/fixture-releases.json"; else local tag=\${1%/*}; tag=\${tag##*/}; cat "$TEST_DIR/fixture-release-$tag.json"; fi; }
    select_release${input === undefined ? '' : ' <<< "$INPUT"'}`,
  {CURRENT:current,REQUESTED:requested,ALLOW:String(allow),INPUT:input ?? ''});
}
it('includes compatible prereleases only after choosing the testing entry', async () => {
  const result = await discoverPrereleases('v1.1.0', '', false, '2\n4');
  expect(result.stdout).toContain('1. v1.4.0 (prerelease)');
  expect(result.stdout).toContain('2. v1.3.0-beta.1 (prerelease)');
  expect(result.stdout).toContain('3. v1.2.0\n');
  expect(result.stdout).toContain('4. v1.2.0-rc.2 (prerelease)');
  expect(result.stdout).not.toMatch(/v[23]\.0\.0/);
  expect(result.stderr).toContain('Skipping incompatible release: v1.2.0-rc.10');
  expect(JSON.parse(await readFile(join(directory, 'release.json'), 'utf8')).version).toBe('v1.2.0-rc.2');
});
it('defaults to stable releases even when a prerelease tag lacks the GitHub prerelease flag', async () => {
  const result = await discoverPrereleases('v1.1.0', '', false, '\n1');
  expect(result.stdout).not.toContain(' (prerelease)');
  expect(result.stdout).toContain('1. v1.2.0');
  expect(JSON.parse(await readFile(join(directory, 'release.json'), 'utf8')).version).toBe('v1.2.0');
});
it('does not accept an explicitly requested prerelease without opting in', async () => {
  await expect(discoverPrereleases('v1.1.0', 'v1.2.0-rc.2', false)).rejects.toThrow('The requested release is not available for upgrade');
});
it('preserves case-sensitive prerelease tags in GitHub asset URLs', async () => {
  await discoverPrereleases('v1.1.0', 'v1.2.0-RC.1', true);
  expect(JSON.parse(await readFile(join(directory, 'release.json'), 'utf8')).version).toBe('v1.2.0-RC.1');
});
it('does not accept a repository URL without the exact release asset path', async () => {
  await writeFile(join(directory, 'fixture-releases.json'), JSON.stringify([{tag_name:'v1.2.0-rc.1',draft:false,prerelease:true,
    assets:[{name:'quorum-server-release.json',browser_download_url:'https://github.com/brepublic/Quorum'}]}]));
  await expect(shell(`temporary="$TEST_DIR"; current_version=v1.1.0; github_repository=brepublic/Quorum; allow_prerelease=true
    fetch() { if [[ $1 == *api.github.com* ]]; then cat "$TEST_DIR/fixture-releases.json"; else touch "$TEST_DIR/unsafe"; return 22; fi; }
    select_release`)).rejects.toMatchObject({code:2,stdout:expect.stringContaining('No compatible upgrade releases are available')});
  await expect(readFile(join(directory, 'unsafe'))).rejects.toThrow();
});
it('allows a newer prerelease after opt-in and never offers older prereleases', async () => {
  const result = await discoverPrereleases('v1.2.0-rc.1', 'v1.2.0-rc.2', true);
  expect(result.stdout).toContain('v1.2.0-rc.2 (prerelease)');
  expect(result.stdout).not.toContain('v1.2.0-rc.1');
  await expect(discoverPrereleases('v1.2.0', 'v1.2.0-rc.2', true)).rejects.toThrow('The requested release is not available for upgrade');
});
it('can leave a prerelease for its stable release without opting into more prereleases', async () => {
  const result = await discoverPrereleases('v1.2.0-rc.2', 'v1.2.0', false);
  expect(result.stdout.trim()).toBe('1. v1.2.0');
});
it('does not continue restoration after checksum validation fails, including from the EXIT handler', async () => {
  await mkdir(join(directory, 'state'));
  await writeFile(join(directory, 'state/phase'), 'verifying');
  await writeFile(join(directory, 'state/SHA256SUMS'), `${digest}  missing.tar\n`);
  await expect(shell(`state="$TEST_DIR/state"; deploy="$TEST_DIR"; temporary="$TEST_DIR/temp"; project=test
    mkdir "$temporary"
    docker() { return 0; }; stop_services() { return 0; }; compose_file() { return 0; }
    volume_io() { touch "$TEST_DIR/unsafe"; }; trap on_exit EXIT; false`)).rejects.toThrow();
  await expect(readFile(join(directory, 'unsafe'))).rejects.toThrow();
  expect(await readFile(join(directory, 'state/phase'), 'utf8')).toBe('verifying');
});
it.each(['committed','rollback-verified'])('never replays a snapshot after %s', async stage => {
  await mkdir(join(directory, 'state'));
  await writeFile(join(directory, 'state/phase'), stage);
  await shell(`state="$TEST_DIR/state"; finish_upgrade() { echo new; }; finish_rollback() { echo old; }
    restore_previous() { touch "$TEST_DIR/unsafe"; }; recover`);
  await expect(readFile(join(directory, 'unsafe'))).rejects.toThrow();
});
it('rejects missing snapshots once verification has started', async () => {
  await mkdir(join(directory, 'state')); await writeFile(join(directory, 'state/phase'), 'restoring');
  await expect(shell(`state="$TEST_DIR/state"; project=test; docker() { return 0; }; stop_services() { return 0; }; compose_file() { return 0; }
    restore_previous`)).rejects.toThrow();
});
it('fails closed on an unknown recovery stage', async () => {
  await mkdir(join(directory, 'state')); await writeFile(join(directory, 'state/phase'), 'invalid');
  await expect(shell('state="$TEST_DIR/state"; recover')).rejects.toThrow();
});
it('uses saved resolved settings without reading the live env file during recovery', async () => {
  const result = await shell(`state="$TEST_DIR/state"; deploy="$TEST_DIR"; project=test
    docker() { printf '%s\\n' "$@"; }; compose_file "$state/old.json" stop app`);
  expect(result.stdout.split('\n')).toContain('/dev/null');
  expect(result.stdout).not.toContain(`${directory}/.env`);
});
it.each(['rollback','upgrade'])('activates %s from saved settings and restores raw deployment files', async direction => {
  await mkdir(join(directory, 'state'));
  await writeFile(join(directory, 'state/original.env'), 'DB_PASSWORD=original\n');
  await writeFile(join(directory, `state/${direction === 'rollback' ? 'original' : 'target'}.yaml`), 'saved version\n');
  await writeFile(join(directory, 'config.yaml'), 'edited version\n');
  await writeFile(join(directory, '.env'), 'DB_PASSWORD=changed\n');
  const result = await shell(`state="$TEST_DIR/state"; deploy="$TEST_DIR"; config="$TEST_DIR/config.yaml"
    compose_file() { echo "$1"; }; remove_isolated_network() { :; }; retire_state() { :; }; cleanup_success() { :; }
    finish_${direction}`);
  expect(result.stdout).toContain(`${directory}/state/${direction === 'rollback' ? 'original' : 'target'}.json`);
  expect(await readFile(join(directory, 'config.yaml'), 'utf8')).toBe('saved version\n');
  expect(await readFile(join(directory, '.env'), 'utf8')).toBe('DB_PASSWORD=original\n');
});
it('treats an already removed isolated network as completed cleanup', async () => {
  await shell(`project=test; docker() { [[ $1 == network && $2 == ls ]]; }; remove_isolated_network`);
});
it('keeps cleanup retryable when Docker cannot list networks', async () => {
  await expect(shell(`project=test; docker() { return 1; }; remove_isolated_network
    touch "$TEST_DIR/unsafe"`)).rejects.toThrow();
  await expect(readFile(join(directory, 'unsafe'))).rejects.toThrow();
});
it('retires the entire journal before deleting any of its recovery records', async () => {
  await mkdir(join(directory, 'state')); await writeFile(join(directory, 'state/phase'), 'committed');
  await expect(shell(`state="$TEST_DIR/state"; deploy="$TEST_DIR"
    rm() { command rm "$state.done/phase"; return 1; }; retire_state`)).rejects.toThrow();
  await expect(readFile(join(directory, 'state/phase'))).rejects.toThrow();
  // No active transaction remains, even when deletion was interrupted halfway.
  await expect(mkdir(join(directory, 'state.done'))).rejects.toThrow();
});
it('finishes partial cleanup without reading configuration, querying releases or replaying backups', async () => {
  const localScript = join(directory, 'upgrade.sh');
  await writeFile(localScript, await readFile(script));
  await mkdir(join(directory, '.upgrade.done'));
  await writeFile(join(directory, '.upgrade.done/partial.tar'), 'partially deleted backup');
  await shell(`docker() { touch "$TEST_DIR/unsafe"; return 1; }; upgrade_main`, {UPGRADE_SCRIPT: localScript});
  await expect(readFile(join(directory, 'unsafe'))).rejects.toThrow();
  await expect(readFile(join(directory, '.upgrade.done/partial.tar'))).rejects.toThrow();
});
it('refuses insufficient backup space before stopping any service', async () => {
  await mkdir(join(directory, 'state'));
  await expect(shell(`state="$TEST_DIR/state"; volume_io() { echo 1024; }
    df() { printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\nfixture 1024 1023 1 99%% /\\n'; }
    stop_services() { touch "$TEST_DIR/unsafe"; }; run_transaction`)).rejects.toThrow();
  await expect(readFile(join(directory, 'unsafe'))).rejects.toThrow();
});
it('preserves original comments and environment substitutions while changing only release pins', async () => {
  const yaml = '# local settings\nx-quorum-release-commit: old\nservices:\n  app:\n    image: old-app\n    environment:\n      PASSWORD: ${PASSWORD}\n  caddy:\n    image: old-caddy\n  postgres:\n    image: old-db\n';
  await writeFile(join(directory, 'original.yaml'), yaml);
  await writeFile(join(directory, 'release.json'), JSON.stringify(manifest));
  await writeFile(join(directory, 'current.json'), JSON.stringify({services:{app:{image:'old'},caddy:{image:'old'},postgres:{image:'old'}}}));
  await shell(`config="$TEST_DIR/original.yaml"; temporary="$TEST_DIR"; target_commit=${commit}
    compose_file() { cat "$TEST_DIR/current.json"; }; write_target_config`);
  const written = await readFile(join(directory, 'target.yaml'), 'utf8');
  expect(written).toContain('# local settings'); expect(written).toContain('PASSWORD: ${PASSWORD}');
  expect(written).toContain(manifest.images.app); expect(written).toContain(manifest.images.caddy);
  expect(await readFile(join(directory, 'original.yaml'), 'utf8')).toBe(yaml);
});
it('publishes reproducible source migration checksums with a complete stable release', async () => {
  await writeFile(join(directory, 'images.json'), JSON.stringify(manifest.images));
  await run('node', [resolve('scripts/server-release.mjs'),join(directory,'images.json'),join(directory,'release.json')], {
    env:{...process.env,RELEASE_TAG:'v1.2.0',GITHUB_SHA:commit,GITHUB_REPOSITORY_OWNER:'brepublic'}});
  const result=JSON.parse(await readFile(join(directory,'release.json'),'utf8'));
  expect(result.migrations['89']).toMatch(/^[a-f0-9]{64}$/);
  await shell('repository=brepublic; validate_release v1.2.0 "$TEST_DIR/release.json"');
});
it('publishes the same complete upgrade metadata for a prerelease', async () => {
  await writeFile(join(directory,'images.json'),JSON.stringify(manifest.images));
  await run('node',[resolve('scripts/server-release.mjs'),join(directory,'images.json'),join(directory,'release.json')],{
    env:{...process.env,RELEASE_TAG:'v1.2.0-rc.1',GITHUB_SHA:commit,GITHUB_REPOSITORY_OWNER:'brepublic'}});
  const published=JSON.parse(await readFile(join(directory,'release.json'),'utf8'));
  expect(published.version).toBe('v1.2.0-rc.1');
  expect(published.migrations['89']).toMatch(/^[a-f0-9]{64}$/);
  await shell('repository=brepublic; validate_release v1.2.0-rc.1 "$TEST_DIR/release.json"');
});
it.each(['v1.2.0-rc.01','v1.2.0-','v1.2.0-beta..1','v01.2.0','v1.2.0+build'])('rejects malformed release metadata tag %s', async tag => {
  await writeFile(join(directory,'images.json'),JSON.stringify(manifest.images));
  await expect(run('node',[resolve('scripts/server-release.mjs'),join(directory,'images.json'),join(directory,'release.json')],{
    env:{...process.env,RELEASE_TAG:tag,GITHUB_SHA:commit,GITHUB_REPOSITORY_OWNER:'brepublic'}})).rejects.toThrow();
  await expect(readFile(join(directory,'release.json'))).rejects.toThrow();
});
