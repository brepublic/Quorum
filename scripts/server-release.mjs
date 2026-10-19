import {createHash} from 'node:crypto';
import {readFile, readdir, writeFile} from 'node:fs/promises';

// Published only after the tested app, website and PostgreSQL pins are available.
const {RELEASE_TAG: version, GITHUB_SHA: commit, GITHUB_REPOSITORY_OWNER: owner} = process.env;
if (!/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version ?? '')) {
  throw new Error('Automatic upgrades require a stable release tag.');
}
if (!/^[a-f0-9]{40}$/.test(commit ?? '') || !/^[A-Za-z0-9-]+$/.test(owner ?? '')) throw new Error('Invalid release identity');
const images = JSON.parse(await readFile(process.argv[2], 'utf8'));
for (const service of ['app', 'caddy', 'postgres']) {
  const repository = service === 'postgres' ? 'postgres' : `ghcr.io/${owner.toLowerCase()}/quorum-${service}`;
  if (!images[service]?.startsWith(`${repository}@sha256:`) || !/sha256:[a-f0-9]{64}$/.test(images[service])) {
    throw new Error(`Invalid ${service} image pin`);
  }
}
const migrations = {};
for (const name of (await readdir('server/migrations')).sort()) {
  const match = /^(\d{4})_.*\.sql$/.exec(name);
  if (match) migrations[Number(match[1])] = createHash('sha256').update(await readFile(`server/migrations/${name}`)).digest('hex');
}
await writeFile(process.argv[3], JSON.stringify({schemaVersion: 1, upgradeProtocol: 1, deploymentSchema: 1,
  version, commit, platform: 'linux/amd64', postgresMajor: 16, minimumDatabaseMigration: 24, migrations, images}, null, 2) + '\n');
