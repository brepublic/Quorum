// @vitest-environment node

import {execFile} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {
  createDeterministicTarGz, createDeterministicZip, readTarGz, readZip,
  runtimeFilesFromArchive, sha256
} from './storage-agent-release-lib.mjs';

const run = promisify(execFile); const repository = resolve(import.meta.dirname, '..');

function entry(path: string, value: string, mode = 0o100644) {
  return {path, data: Buffer.from(value), mode};
}

describe('Storage Agent release archives', () => {
  it('writes deterministic ZIP and tar.gz bytes with fixed paths and modes', () => {
    const entries = [entry('root/bin', 'binary', 0o100755), entry('root/README', 'text')];
    const zip = createDeterministicZip(entries); const tar = createDeterministicTarGz(entries);
    expect(createDeterministicZip([...entries].reverse())).toEqual(zip);
    expect(createDeterministicTarGz([...entries].reverse())).toEqual(tar);
    expect(readZip(zip).map(value => [value.path, value.mode, value.data.toString()])).toEqual([
      ['root/README', 0o100644, 'text'], ['root/bin', 0o100755, 'binary']
    ]);
    expect(readTarGz(tar).map(value => [value.path, value.mode, value.data.toString()])).toEqual([
      ['root/README', 0o644, 'text'], ['root/bin', 0o755, 'binary']
    ]);
  });

  it('extracts only the pinned runtime and license from upstream layouts', () => {
    const windows = createDeterministicZip([
      entry('node-v1-win-x64/node.exe', 'windows-runtime'), entry('node-v1-win-x64/LICENSE', 'license'),
      entry('node-v1-win-x64/npm.cmd', 'not-shipped')
    ]);
    const unix = createDeterministicTarGz([
      entry('node-v1-darwin-arm64/bin/node', 'mac-runtime', 0o100755), entry('node-v1-darwin-arm64/LICENSE', 'license')
    ]);
    expect(runtimeFilesFromArchive('win-x64', 'node-v1-win-x64.zip', windows)).toEqual({
      runtime: Buffer.from('windows-runtime'), license: Buffer.from('license')
    });
    expect(runtimeFilesFromArchive('darwin-arm64', 'node-v1-darwin-arm64.tar.gz', unix)).toEqual({
      runtime: Buffer.from('mac-runtime'), license: Buffer.from('license')
    });
  });

  it('builds and verifies all target packages reproducibly without repository or secret data', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'quorum-agent-release-'));
    try {
      const cache = join(temporary, 'cache'); const dist = join(temporary, 'dist');
      const first = join(temporary, 'first'); const second = join(temporary, 'second');
      await mkdir(cache, {recursive: true}); await mkdir(dist, {recursive: true});
      await writeFile(join(dist, 'cli.js'), '#!/usr/bin/env node\nconsole.log("agent");\n');
      await writeFile(join(dist, 'runtime.js'), 'export const runtime = true;\n');
      const targets: Record<string, {archive: string; sha256: string}> = {};
      for (const target of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win-x64']) {
        const archive = `node-v99.0.0-${target}.${target === 'win-x64' ? 'zip' : 'tar.gz'}`;
        const root = archive.replace(/\.tar\.gz$|\.zip$/, '');
        const entries = target === 'win-x64'
          ? [entry(`${root}/node.exe`, `${target}-runtime`), entry(`${root}/LICENSE`, 'node-license')]
          : [entry(`${root}/bin/node`, `${target}-runtime`, 0o100755), entry(`${root}/LICENSE`, 'node-license')];
        const bytes = target === 'win-x64' ? createDeterministicZip(entries) : createDeterministicTarGz(entries);
        await writeFile(join(cache, archive), bytes); targets[target] = {archive, sha256: sha256(bytes)};
      }
      const lockPath = join(temporary, 'lock.json');
      await writeFile(lockPath, JSON.stringify({schemaVersion: 1, nodeVersion: '99.0.0', baseUrl: 'https://invalid.example', targets}));
      const common = ['--lock', lockPath, '--runtime-cache', cache, '--dist', dist, '--offline'];
      await run(process.execPath, [join(repository, 'scripts/build-storage-agent-release.mjs'), ...common, '--output', first], {
        env: {...process.env, QUORUM_AGENT_RELEASE_FORBIDDEN_VALUE: 'secret-test-value'}
      });
      await run(process.execPath, [join(repository, 'scripts/build-storage-agent-release.mjs'), ...common, '--output', second], {
        env: {...process.env, QUORUM_AGENT_RELEASE_FORBIDDEN_VALUE: 'secret-test-value'}
      });
      const firstManifest = JSON.parse(await readFile(join(first, 'release-manifest.json'), 'utf8'));
      const secondManifest = JSON.parse(await readFile(join(second, 'release-manifest.json'), 'utf8'));
      expect(firstManifest.artifacts).toHaveLength(4);
      expect(secondManifest).toEqual(firstManifest);
      expect(firstManifest.artifacts.every((value: {signed: boolean; notarized: boolean}) => !value.signed && !value.notarized)).toBe(true);
      for (const artifact of firstManifest.artifacts) {
        expect(await readFile(join(first, artifact.file))).toEqual(await readFile(join(second, artifact.file)));
      }
    } finally { await rm(temporary, {recursive: true, force: true}); }
  });

  it('rejects path traversal while reading archives', () => {
    expect(() => createDeterministicZip([entry('../escape', 'bad')])).toThrow('Unsafe archive path');
    expect(() => createDeterministicTarGz([entry('/absolute', 'bad')])).toThrow('Unsafe archive path');
  });
});
