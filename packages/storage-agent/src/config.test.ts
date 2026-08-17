// @vitest-environment node

import {chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {readAgentConfig, writeAgentConfig, type StorageAgentLocalConfig} from './config';

const roots: string[] = [];
const config: StorageAgentLocalConfig = {schemaVersion: 1, serverUrl: 'https://quorum.example.com',
  credential: 'qsa1.20000000-0000-4000-8000-000000000001.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  committeeId: '10000000-0000-4000-8000-000000000001',
  deviceId: '20000000-0000-4000-8000-000000000001', leaseGeneration: 1,
  rootPath: '/chosen/storage/root', devicePrivateKey: '-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----\n'};

afterEach(async () => Promise.all(roots.splice(0).map(path => rm(path, {recursive: true, force: true}))));

describe('Chair Agent private local config', () => {
  it('writes credentials and the private key only to a 0600 regular config file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quorum-agent-config-')); roots.push(root);
    const path = join(root, 'config.json'); await writeAgentConfig(path, config);
    expect(await readAgentConfig(path)).toEqual(config);
    if (process.platform !== 'win32') expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).toContain(config.credential);
  });

  it('rejects a config readable by another local account', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(join(tmpdir(), 'quorum-agent-config-')); roots.push(root);
    const path = join(root, 'config.json'); await writeFile(path, JSON.stringify(config)); await chmod(path, 0o644);
    await expect(readAgentConfig(path)).rejects.toMatchObject({code: 'INVALID_STORAGE_ROOT'});
  });

  it('rejects a symlink config even when its target is valid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quorum-agent-config-')); roots.push(root);
    const target = join(root, 'target.json'); const link = join(root, 'link.json');
    await writeAgentConfig(target, config); await symlink(target, link);
    await expect(readAgentConfig(link)).rejects.toMatchObject({code: 'INVALID_STORAGE_ROOT'});
  });
});
