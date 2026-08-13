#!/usr/bin/env node

import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {updateReleaseMetadata} from './storage-agent-release-lib.mjs';

const repository = resolve(import.meta.dirname, '..'); const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const target = option('--target');
const agentVersion = option('--agent-version') ?? JSON.parse(await readFile(join(repository, 'packages/storage-agent/package.json'), 'utf8')).version;
const output = resolve(option('--output') ?? join(repository, 'release/storage-agent'));
if (!target || !['win-x64', 'darwin-x64', 'darwin-arm64'].includes(target)) throw new Error('Use --target win-x64, darwin-x64, or darwin-arm64.');
const stage = join(output, 'staging', `quorum-storage-agent-${agentVersion}-${target}`);

async function run(command, values) {
  await new Promise((accept, reject) => {
    const child = spawn(command, values, {cwd: stage, stdio: 'inherit', shell: false});
    child.once('error', reject); child.once('exit', code => code === 0 ? accept() : reject(new Error(`${command} exited with ${code}.`)));
  });
}

if (target === 'win-x64') {
  const thumbprint = process.env.QUORUM_WINDOWS_SIGNING_CERT_SHA1;
  if (!thumbprint) throw new Error('QUORUM_WINDOWS_SIGNING_CERT_SHA1 is required.');
  await run(process.env.QUORUM_SIGNTOOL_PATH ?? 'signtool.exe', ['sign', '/sha1', thumbprint, '/fd', 'SHA256', '/tr',
    process.env.QUORUM_WINDOWS_TIMESTAMP_URL ?? 'http://timestamp.digicert.com', '/td', 'SHA256', join('runtime', 'node.exe')]);
  await run(process.env.QUORUM_SIGNTOOL_PATH ?? 'signtool.exe', ['verify', '/pa', '/v', join('runtime', 'node.exe')]);
} else {
  const identity = process.env.QUORUM_MACOS_SIGNING_IDENTITY;
  if (!identity) throw new Error('QUORUM_MACOS_SIGNING_IDENTITY is required.');
  await run('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, join('runtime', 'node')]);
  await run('codesign', ['--verify', '--strict', '--verbose=2', join('runtime', 'node')]);
}
await updateReleaseMetadata(stage, {signed: true});
process.stdout.write(`Signed ${target} staging runtime. Re-run the release builder with --archive-only --target ${target}.\n`);
