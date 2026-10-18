// @vitest-environment node
import {spawn, execFile, type ChildProcess} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {createHash, randomUUID} from 'node:crypto';
import {describe, it, expect, afterEach} from 'vitest';
import {lockAgentRoot} from './runtime-lock';
import {checkPrivatePath, windowsPlatformHelper} from './windows-platform';
import {readAgentConfig, writeAgentConfig, type StorageAgentLocalConfig} from './config';
import {AgentFileStore} from './files';
import {AgentStateStore, AGENT_TEMP_DIRECTORY} from './state';

const execute = promisify(execFile);
const roots: string[] = []; const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    const closed = new Promise<void>(done => child.once('close', () => done())); child.kill(); await closed;
  }
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true});
});
async function root() {const path = await mkdtemp(join(tmpdir(), 'quorum-windows-')); roots.push(path); return path;}
async function ready(child: ChildProcess, expected: string) {
  children.push(child);
  await new Promise<void>((done, fail) => {
    const timeout = setTimeout(() => fail(Error('Readiness timeout')), 5000); let output = '';
    child.once('error', error => {clearTimeout(timeout); fail(error);});
    child.once('exit', () => {clearTimeout(timeout); if (!output.includes(expected)) fail(Error('Child exited before ready'));});
    child.stdout!.on('data', data => {output += data.toString(); if (output.includes(expected)) {clearTimeout(timeout); done();}});
  });
}
const identity = {committeeId:'10000000-0000-4000-8000-000000000001', deviceId:'20000000-0000-4000-8000-000000000001'};
function config(rootPath: string): StorageAgentLocalConfig {return {schemaVersion:1, ...identity, rootPath,
  serverUrl:'https://localhost', credential:'test-only-credential', leaseGeneration:1,
  devicePrivateKey:'-----BEGIN PRIVATE KEY-----\ntest-only\n-----END PRIVATE KEY-----'};}

describe.skipIf(process.platform !== 'win32')('Windows native security and filesystem', () => {
  it('shares a kernel directory lock across processes and case aliases', async () => {
    const path = await root(); const release = await lockAgentRoot(path);
    try {await expect(lockAgentRoot(path.toUpperCase())).rejects.toThrow('AGENT_ALREADY_RUNNING');}
    finally {await release();}
    await (await lockAgentRoot(path))();
  });
  it('releases an orphan lock after the owning Node process is killed', async () => {
    const path = await root();
    const module = pathToFileURL(resolve('packages/storage-agent/dist/runtime-lock.js')).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import {lockAgentRoot} from ${JSON.stringify(module)}; await lockAgentRoot(process.argv[1]); console.log('LOCKED');`, path], {stdio:'pipe', windowsHide:true});
    await ready(child, 'LOCKED');
    await expect(lockAgentRoot(path)).rejects.toThrow('AGENT_ALREADY_RUNNING');
    const closed = new Promise<void>(done => child.once('close', () => done())); child.kill(); await closed;
    await (await lockAgentRoot(path))();
  });
  it('rejects junction roots instead of following them into another directory', async () => {
    const path = await root(); const destination = join(path, 'real'); await mkdir(destination);
    const junction = join(path, 'junction'); await symlink(destination, junction, 'junction');
    await expect(lockAgentRoot(junction)).rejects.toThrow('UNSAFE_AGENT_LOCK');
    const release = await lockAgentRoot(destination); await release();
  });
  it('protects credentials and refuses an ACL that allows Everyone to read them', async () => {
    const path = join(await root(), 'private.json'); const value = config('C:\\test-only');
    await writeAgentConfig(path, value); await checkPrivatePath(path);
    expect(await readAgentConfig(path)).toEqual(value);
    await execute('icacls.exe', [path, '/grant', '*S-1-1-0:(R)'], {windowsHide:true});
    await expect(readAgentConfig(path)).rejects.toMatchObject({code:'INVALID_STORAGE_ROOT'});
  });
  it('preserves an occupied config and removes the failed replacement temporary file', async () => {
    const directory = await root(); const path = join(directory, 'private.json'); const value = config(directory);
    await writeAgentConfig(path, value);
    const holder = spawn(await windowsPlatformHelper(), ['--hold-file', path], {stdio:'pipe',windowsHide:true});
    await ready(holder, 'HELD');
    await expect(writeAgentConfig(path, {...value, leaseGeneration:2})).rejects.toBeTruthy();
    expect(await readAgentConfig(path)).toEqual(value);
    expect(await readdir(directory)).toEqual(['private.json']);
    const closed = new Promise<void>(done => holder.once('close', () => done())); holder.stdin!.end(); await closed;
    await writeAgentConfig(path, {...value, leaseGeneration:2});
    expect((await readAgentConfig(path)).leaseGeneration).toBe(2);
  });
  it('does not unlink a replacement when the same tracked path changes only case', async () => {
    const path = await root(); const state = await AgentStateStore.initialize(path, identity); const files = new AgentFileStore(state);
    const fileEntryId = randomUUID(); const blobId = randomUUID();
    const event = (content: string, logicalName: string, sequence: number) => ({kind:'UPSERT' as const, sequence,
      fileEntryId, blobId, fileRevision:sequence, versionId:randomUUID(), logicalName, originalName:logicalName,
      mediaType:'text/plain', sizeBytes:Buffer.byteLength(content), sha256:createHash('sha256').update(content).digest('hex'), createdAt:new Date().toISOString()});
    await files.applyUpsert(event('first', 'Draft.txt', 1), (async function*(){yield 'first';})());
    await files.applyUpsert(event('second', 'draft.txt', 2), (async function*(){yield 'second';})());
    expect(await readFile(join(path,'DRAFT.TXT'),'utf8')).toBe('second');
    expect(state.snapshot().files[fileEntryId]?.revision).toBe(2);
    expect(await readdir(join(path,AGENT_TEMP_DIRECTORY))).toEqual([]);
  });
});
