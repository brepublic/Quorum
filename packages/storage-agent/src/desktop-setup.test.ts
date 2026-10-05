// @vitest-environment node
import {mkdtemp, mkdir, rm, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {beforeEach, afterEach, describe, it, expect, vi} from 'vitest';
import type {AgentPairingConfig} from '@quorum/contracts';
const paths = vi.hoisted(() => ({documents: ''}));
vi.mock('node:child_process', () => ({execFileSync: () => paths.documents}));
import {proposedDirectory, allocateDirectory, rememberConfiguration, lastConfiguration, desktopSite, rememberSite} from './desktop-setup';
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'quorum-setup-'));
  paths.documents = join(directory, '文档');
  vi.stubEnv('XDG_CONFIG_HOME', join(directory, 'config'));
});
afterEach(async () => {vi.unstubAllEnvs(); await rm(directory, {recursive: true, force: true});});
const council: AgentPairingConfig = {schemaVersion: 1, kind: 'quorum-agent-pairing', serverUrl: 'https://quorum.example.com',
  committeeId: '10000000-0000-4000-8000-000000000001', committeeName: '安理会',
  pairingCode: 'QRM-ABCDE-FGHIJ', purpose: 'INITIAL', expiresAt: '2099-01-01T00:00:00Z'};
describe('desktop storage defaults', () => {
  it('remembers the site alongside existing recovery and directory preferences', async () => {
    expect(await desktopSite()).toBe('https://quorum.sramun.org');
    await rememberConfiguration('/private/connection.json');
    await rememberSite('quorum.example.com');
    expect(await desktopSite()).toBe('https://quorum.example.com');
    expect(await lastConfiguration()).toBe('/private/connection.json');
    await expect(rememberSite('http://wrong.example.com')).rejects.toThrow('HTTPS_REQUIRED');
    expect(await desktopSite()).toBe('https://quorum.example.com');
  });
  it('allocates independent durable numbers, and previews do not consume numbers', async () => {
    const a = await proposedDirectory(council);
    expect(a.rootPath).toBe(join(paths.documents, 'Quorum', '安理会-1'));
    expect(await proposedDirectory(council)).toEqual(a);
    await allocateDirectory(council, a.rootPath, a.ordinal);
    await rm(a.rootPath, {recursive: true});
    expect((await proposedDirectory(council)).ordinal).toBe(2);
    const b = {...council, committeeId: '10000000-0000-4000-8000-000000000002', committeeName: '大会'};
    expect((await proposedDirectory(b)).rootPath).toBe(join(paths.documents, 'Quorum', '大会-1'));
  });
  it('skips existing paths, refuses a concurrent collision and sanitizes committee names', async () => {
    const a = await proposedDirectory(council); await mkdir(a.rootPath, {recursive: true});
    await writeFile(join(a.rootPath, 'keep.txt'), 'keep');
    expect((await proposedDirectory(council)).ordinal).toBe(2);
    await expect(allocateDirectory(council, a.rootPath, a.ordinal)).rejects.toMatchObject({code: 'EEXIST'});
    expect(await readFile(join(a.rootPath, 'keep.txt'), 'utf8')).toBe('keep');
    expect((await proposedDirectory({...council, committeeName: '../危险/目录'})).rootPath.startsWith(join(paths.documents, 'Quorum') + '/')).toBe(true);
  });
  it('restores an explicit private config and forgets it after unpair', async () => {
    expect(await lastConfiguration()).toBeUndefined();
    await rememberConfiguration('/private/agent.json'); expect(await lastConfiguration()).toBe('/private/agent.json');
    await rememberConfiguration(); expect(await lastConfiguration()).toBeUndefined();
  });
  it('reports corrupt preferences instead of silently resetting local numbering', async () => {
    const folder = join(directory, 'config', 'quorum-agent'); await mkdir(folder, {recursive: true});
    await writeFile(join(folder, 'desktop-state.json'), JSON.stringify({ordinals: null}));
    await expect(proposedDirectory(council)).rejects.toThrow('DESKTOP_STATE_INVALID');
  });
});
