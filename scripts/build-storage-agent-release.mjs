#!/usr/bin/env node

import {readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {
  archiveReleaseStage, downloadPinnedArchive, materializeReleaseStage, readReleaseArchive,
  runtimeFilesFromArchive, sha256File, verifyReleaseEntries
} from './storage-agent-release-lib.mjs';

const repository = resolve(import.meta.dirname, '..');
const arguments_ = process.argv.slice(2); const option = name => {
  const index = arguments_.indexOf(name); return index < 0 ? undefined : arguments_[index + 1];
};
const has = name => arguments_.includes(name);
const lock = JSON.parse(await readFile(resolve(option('--lock') ?? join(repository, 'scripts/storage-agent-runtime-lock.json')), 'utf8'));
const agentPackage = JSON.parse(await readFile(join(repository, 'packages/storage-agent/package.json'), 'utf8'));
const targets = option('--target') ? option('--target').split(',') : Object.keys(lock.targets).sort();
const cacheDirectory = resolve(option('--runtime-cache') ?? join(repository, '.tools/storage-agent-runtimes'));
const outputDirectory = resolve(option('--output') ?? join(repository, 'release/storage-agent'));
const stageDirectory = join(outputDirectory, 'staging');
const distDirectory = resolve(option('--dist') ?? join(repository, 'packages/storage-agent/dist'));
const forbiddenValues = [repository, process.env.QUORUM_AGENT_RELEASE_FORBIDDEN_VALUE].filter(Boolean);

for (const target of targets) if (!lock.targets[target]) throw new Error(`Unknown release target: ${target}`);

async function packageTarget(target) {
  const pinned = lock.targets[target]; const archivePath = join(cacheDirectory, pinned.archive);
  const source = await downloadPinnedArchive({url: `${lock.baseUrl}/${pinned.archive}`, destination: archivePath,
    expectedSha256: pinned.sha256, offline: has('--offline')});
  const archive = await readFile(source); const runtime = runtimeFilesFromArchive(target, pinned.archive, archive);
  const rootName = `quorum-storage-agent-${agentPackage.version}-${target}`; const stage = join(stageDirectory, rootName);
  await materializeReleaseStage({rootDirectory: stage, distDirectory,
    releaseReadmePath: join(repository, 'packages/storage-agent/RELEASE_README.md'),
    target, agentVersion: agentPackage.version, nodeVersion: lock.nodeVersion, ...runtime});
  return archiveTarget(target);
}

async function archiveTarget(target) {
  const rootName = `quorum-storage-agent-${agentPackage.version}-${target}`; const stage = join(stageDirectory, rootName);
  const extension = target === 'linux-x64' ? '.tar.gz' : '.zip'; const artifact = join(outputDirectory, `${rootName}${extension}`);
  const result = await archiveReleaseStage({stageDirectory: stage, outputPath: artifact});
  const entries = readReleaseArchive(artifact, await readFile(artifact));
  const metadata = verifyReleaseEntries({entries, target, agentVersion: agentPackage.version, nodeVersion: lock.nodeVersion, forbiddenValues});
  return {target, file: artifact.split('/').at(-1), ...result, signed: metadata.signed, notarized: metadata.notarized};
}

if (!has('--archive-only')) await rm(stageDirectory, {recursive: true, force: true});
const built = [];
for (const target of targets) built.push(has('--archive-only') ? await archiveTarget(target) : await packageTarget(target));

const artifactNames = new Set((await readdir(outputDirectory).catch(() => [])).filter(name => name.endsWith('.zip') || name.endsWith('.tar.gz')));
for (const item of built) artifactNames.add(item.file);
const artifacts = [];
for (const file of [...artifactNames].sort()) {
  const target = Object.keys(lock.targets).find(value => file === `quorum-storage-agent-${agentPackage.version}-${value}${value === 'linux-x64' ? '.tar.gz' : '.zip'}`);
  if (!target) continue;
  const path = join(outputDirectory, file); const entries = readReleaseArchive(path, await readFile(path));
  const metadata = verifyReleaseEntries({entries, target, agentVersion: agentPackage.version, nodeVersion: lock.nodeVersion, forbiddenValues});
  artifacts.push({target, file, sha256: await sha256File(path), size: (await stat(path)).size,
    signed: metadata.signed, notarized: metadata.notarized});
}
const manifest = {schemaVersion: 1, product: 'Quorum Chair Storage Agent', agentVersion: agentPackage.version,
  nodeVersion: lock.nodeVersion, artifacts};
await writeFile(join(outputDirectory, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(join(outputDirectory, 'SHA256SUMS'), `${artifacts.map(item => `${item.sha256}  ${item.file}`).join('\n')}\n`);
for (const item of built) process.stdout.write(`${item.sha256}  ${item.file}\n`);
