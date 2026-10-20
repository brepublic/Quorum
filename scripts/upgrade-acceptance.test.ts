// @vitest-environment node
import {mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {afterEach, expect, it} from 'vitest';
import {assertMigrationBaseline, exportDiagnostics, redactLog} from './upgrade-acceptance.mjs';

const baseline = [88, 89, 90, 91, 92].map(version => ({version, checksum: 'a'.repeat(64)}));
let directory: string | undefined;
afterEach(async () => {if (directory) await rm(directory, {recursive: true, force: true});});

it('accepts the complete base image schema including future migrations, independent of row order', () => {
  expect(() => assertMigrationBaseline(baseline, [...baseline].reverse())).not.toThrow();
});

it.each([
  baseline.filter(row => row.version !== 89),
  baseline.map(row => row.version === 90 ? {...row, checksum: 'b'.repeat(64)} : row),
  [...baseline, {version: 9000, checksum: 'c'.repeat(64)}],
  [],
].map(actual => ({actual})))('rejects missing history, changed checksums and an incompletely restored upgrade', ({actual}) => {
  expect(() => assertMigrationBaseline(baseline, actual)).toThrow();
});

it('refuses a base schema that collides with the synthetic acceptance migrations', () => {
  const overlapping = [...baseline, {version: 9000, checksum: 'c'.repeat(64)}];
  expect(() => assertMigrationBaseline(overlapping, overlapping)).toThrow('overlaps');
});

it('exports only regular top-level diagnostic logs and redacts credentials', async () => {
  directory = await mkdtemp(join(tmpdir(), 'quorum-acceptance-'));
  const work = join(directory, 'work'), output = join(directory, 'diagnostics');
  await mkdir(work);
  await mkdir(join(work, '.upgrade'));
  await writeFile(join(work, '.env'), 'POSTGRES_PASSWORD=private');
  await writeFile(join(work, 'cookies'), 'private-cookie');
  await writeFile(join(work, '.upgrade', 'backup.tar'), 'private-backup');
  await writeFile(join(work, 'failure.log'), [
    'stage=restore-after-migration-failure line=123 status=1',
    'Quorum bootstrap secret (shown once): bootstrap-value',
    '{"sessionToken":"session-value","password":"password-value"}',
    'postgresql://name:db-value@postgres/db',
    'Authorization: Bearer bearer-value',
    'Set-Cookie: session=cookie-value',
    'only-for-isolated-test',
    'Upgrade-acceptance-123!',
    'Database migration versions/checksums differ from the base image',
  ].join('\n'));
  await symlink(join(work, '.env'), join(work, 'linked.log'));
  await exportDiagnostics(work, output);
  expect(await readdir(output)).toEqual(['failure.log']);
  const log = await readFile(join(output, 'failure.log'), 'utf8');
  expect(log).toContain('line=123 status=1');
  expect(log).toContain('Database migration versions/checksums differ');
  expect(log).not.toMatch(/bootstrap-value|session-value|password-value|db-value|bearer-value|cookie-value|only-for-isolated-test|Upgrade-acceptance-123!/);
  expect(redactLog('healthy\nsecret=hidden\nhealthy')).toBe('healthy\n[redacted sensitive log line]\nhealthy');
  expect(redactLog('-----BEGIN PRIVATE KEY-----\nprivate-key-body\n-----END PRIVATE KEY-----'))
    .not.toContain('private-key-body');
});

it('preserves the original failure code and exports stage/line diagnostics even if Docker cleanup fails', async () => {
  directory = await mkdtemp(join(tmpdir(), 'quorum-acceptance-'));
  const bin = join(directory, 'bin'), output = join(directory, 'diagnostics');
  await mkdir(bin);
  await writeFile(join(bin, 'docker'), `#!/bin/sh
if [ "$1" = build ]; then
  echo 'fixture build error'
  echo 'secret=must-not-be-exported'
  exit 37
fi
exit 42
`, {mode: 0o755});
  await expect(promisify(execFile)('bash', ['scripts/test-upgrade.sh'], {
    env: {...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: directory,
      QUORUM_UPGRADE_TEST_APP: '', QUORUM_UPGRADE_TEST_EVIDENCE_DIR: output},
  })).rejects.toMatchObject({code: 37});
  expect(await readFile(join(output, 'failure.log'), 'utf8')).toMatch(/stage=build-base line=\d+ status=37/);
  expect(await readFile(join(output, 'build.log'), 'utf8')).toBe('fixture build error\n[redacted sensitive log line]\n');
});
