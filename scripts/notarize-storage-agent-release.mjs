#!/usr/bin/env node

import {spawn} from 'node:child_process';
import {readFile, writeFile} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';

const repository = resolve(import.meta.dirname, '..'); const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const artifact = resolve(option('--artifact') ?? ''); const output = resolve(option('--output') ?? join(repository, 'release/storage-agent'));
const profile = process.env.QUORUM_MACOS_NOTARY_KEYCHAIN_PROFILE;
if (!artifact.endsWith('.zip') || !basename(artifact).includes('-darwin-')) throw new Error('Use --artifact with a macOS Agent ZIP.');
if (!profile) throw new Error('QUORUM_MACOS_NOTARY_KEYCHAIN_PROFILE is required.');
await new Promise((accept, reject) => {
  const child = spawn('xcrun', ['notarytool', 'submit', basename(artifact), '--keychain-profile', profile, '--wait'],
    {cwd: dirname(artifact), stdio: 'inherit', shell: false});
  child.once('error', reject); child.once('exit', code => code === 0 ? accept() : reject(new Error(`notarytool exited with ${code}.`)));
});
const manifestPath = join(output, 'release-manifest.json'); const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const item = manifest.artifacts.find(value => value.file === basename(artifact));
if (!item) throw new Error('Notarized artifact is not in release-manifest.json.');
item.notarized = true;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write('Notarization accepted. The ZIP ticket is available to Gatekeeper online.\n');
