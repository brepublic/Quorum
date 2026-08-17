#!/usr/bin/env node

import {readFile, stat} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {readReleaseArchive, sha256File, verifyReleaseEntries} from './storage-agent-release-lib.mjs';

const repository = resolve(import.meta.dirname, '..'); const output = resolve(process.argv[2] ?? join(repository, 'release/storage-agent'));
const manifest = JSON.parse(await readFile(join(output, 'release-manifest.json'), 'utf8'));
const agentPackage = JSON.parse(await readFile(join(repository, 'packages/storage-agent/package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(repository, 'scripts/storage-agent-runtime-lock.json'), 'utf8'));
if (manifest.schemaVersion !== 1 || manifest.product !== 'Quorum Chair Storage Agent' ||
  manifest.agentVersion !== agentPackage.version || manifest.nodeVersion !== lock.nodeVersion) throw new Error('Release manifest version is stale.');
const forbiddenValues = [repository, process.env.QUORUM_AGENT_RELEASE_FORBIDDEN_VALUE].filter(Boolean);
for (const artifact of manifest.artifacts) {
  const path = join(output, artifact.file); const info = await stat(path);
  if (info.size !== artifact.size || await sha256File(path) !== artifact.sha256) throw new Error(`Artifact checksum failed: ${artifact.file}`);
  const metadata = verifyReleaseEntries({entries: readReleaseArchive(path, await readFile(path)), target: artifact.target,
    agentVersion: manifest.agentVersion, nodeVersion: manifest.nodeVersion, forbiddenValues});
  if (metadata.signed !== artifact.signed || artifact.notarized && (!artifact.signed || !artifact.target.startsWith('darwin-'))) {
    throw new Error(`Artifact provenance is stale: ${artifact.file}`);
  }
}
const sums = await readFile(join(output, 'SHA256SUMS'), 'utf8');
const expected = `${manifest.artifacts.map(item => `${item.sha256}  ${item.file}`).join('\n')}\n`;
if (sums !== expected) throw new Error('SHA256SUMS does not match release-manifest.json.');
process.stdout.write(`Verified ${manifest.artifacts.length} Agent release artifact(s).\n`);
