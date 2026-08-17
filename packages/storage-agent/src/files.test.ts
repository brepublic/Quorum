// @vitest-environment node

import {createHash, randomUUID} from 'node:crypto';
import {link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import type {StorageManifestEvent} from '@quorum/contracts';
import {AgentFileStore} from './files';
import {normalizeAgentRelativePath, secureAgentTarget} from './paths';
import {AGENT_METADATA_FILE, AGENT_TEMP_DIRECTORY, AgentStateStore} from './state';

const roots: string[] = [];
const committeeId = '10000000-0000-4000-8000-000000000001';
const deviceId = '20000000-0000-4000-8000-000000000001';
const fileEntryId = '30000000-0000-4000-8000-000000000001';
const blobId = '40000000-0000-4000-8000-000000000001';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const upsert = (content: string, logicalName = '文件/工作文件.txt', sequence = 1): Extract<StorageManifestEvent,
  {kind: 'UPSERT'}> => ({sequence, kind: 'UPSERT', fileEntryId, fileRevision: sequence, versionId: randomUUID(),
  blobId, logicalName, originalName: 'draft.txt', mediaType: 'text/plain', sizeBytes: Buffer.byteLength(content),
  sha256: digest(content), createdAt: '2026-08-13T00:00:00.000Z'});

afterEach(async () => Promise.all(roots.splice(0).map(path => rm(path, {recursive: true, force: true}))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'quorum-agent-files-')); roots.push(root);
  const state = await AgentStateStore.initialize(root, {committeeId, deviceId});
  return {root, state, files: new AgentFileStore(state)};
}

describe('Chair Agent storage root', () => {
  it('stores only non-secret relative state in protected metadata', async () => {
    const value = await fixture();
    const metadata = JSON.parse(await readFile(join(value.root, AGENT_METADATA_FILE), 'utf8'));
    expect(metadata).toEqual({schemaVersion: 1, committeeId, deviceId, manifestSequence: 0,
      files: {}, pendingUploads: {}, conflicts: {}});
    expect(JSON.stringify(metadata)).not.toContain(value.root);
    expect(JSON.stringify(metadata)).not.toContain('credential');
    expect((await lstat(join(value.root, AGENT_TEMP_DIRECTORY))).isDirectory()).toBe(true);
    await expect(AgentStateStore.initialize(value.root, {committeeId, deviceId})).resolves.toBeTruthy();
  });

  it.each(['../escape', '/absolute', 'C:\\Windows\\file', '\\\\server\\share', '.quorum-storage.json',
    '.quorum-tmp/file', 'nested//file', 'nested/./file'])('rejects unsafe portable path %s', value => {
    expect(() => normalizeAgentRelativePath(value)).toThrow();
  });

  it.each(['CON', 'aux.txt', 'folder/name.', 'folder/name ', 'folder/a:b'])
  ('rejects non-portable path %s on every host platform', value => {
    expect(() => normalizeAgentRelativePath(value)).toThrow();
  });

  it('rejects replaced metadata that points outside the selected root', async () => {
    const value = await fixture(); const outside = await mkdtemp(join(tmpdir(), 'quorum-agent-metadata-'));
    roots.push(outside); const external = join(outside, 'metadata.json');
    await writeFile(external, JSON.stringify(value.state.snapshot()));
    await rm(join(value.root, AGENT_METADATA_FILE)); await symlink(external, join(value.root, AGENT_METADATA_FILE));
    await expect(AgentStateStore.initialize(value.root, {committeeId, deviceId}))
      .rejects.toMatchObject({code: 'INVALID_STORAGE_ROOT'});
  });

  it('does not advance in-memory recovery state when its atomic write fails', async () => {
    const value = await fixture(); const temporary = join(value.root, AGENT_TEMP_DIRECTORY);
    await rm(temporary, {recursive: true}); await writeFile(temporary, 'blocked');
    await expect(value.state.update(state => { state.manifestSequence = 9; })).rejects.toBeTruthy();
    expect(value.state.snapshot().manifestSequence).toBe(0);
  });

  it('rejects a symbolic-link parent that escapes the selected root', async () => {
    const value = await fixture(); const outside = await mkdtemp(join(tmpdir(), 'quorum-agent-outside-'));
    roots.push(outside); await symlink(outside, join(value.root, 'linked'));
    await expect(secureAgentTarget(value.root, 'linked/file.txt', {createParents: true}))
      .rejects.toMatchObject({code: 'UNSAFE_LOCAL_PATH'});
  });
});

describe('Chair Agent verified atomic apply', () => {
  it('removes regular crash leftovers from the private temporary directory', async () => {
    const {root, files} = await fixture();
    await writeFile(join(root, AGENT_TEMP_DIRECTORY, 'interrupted.partial'), 'partial');
    await files.cleanupTemporaryFiles();
    expect(await readdir(join(root, AGENT_TEMP_DIRECTORY))).toEqual([]);
  });

  it('fails closed when crash cleanup encounters an unsafe temporary entry', async () => {
    const {root, files} = await fixture();
    await mkdir(join(root, AGENT_TEMP_DIRECTORY, 'unexpected-directory'));
    await expect(files.cleanupTemporaryFiles()).rejects.toMatchObject({code: 'INVALID_STORAGE_ROOT'});
  });

  it('publishes a verified stream and records the manifest revision after success', async () => {
    const value = await fixture(); const event = upsert('verified content');
    await value.files.applyUpsert(event, (async function* () {yield 'verified '; yield 'content';})());
    expect(await readFile(join(value.root, '文件', '工作文件.txt'), 'utf8')).toBe('verified content');
    expect(value.state.snapshot()).toMatchObject({manifestSequence: 1, files: {[fileEntryId]: {
      relativePath: '文件/工作文件.txt', revision: 1, sizeBytes: 16, sha256: digest('verified content')}}});
    expect(await lstat(join(value.root, AGENT_TEMP_DIRECTORY)).then(() => true)).toBe(true);
  });

  it.each([
    ['short', (async function* () {yield 'short';})()],
    ['long', (async function* () {yield 'verified content plus';})()],
    ['hash', (async function* () {yield 'invalid content!';})()],
    ['broken', (async function* () {yield 'part'; throw new Error('disconnect');})()]
  ])('does not expose %s content as a complete local file', async (_name, source) => {
    const value = await fixture(); const event = upsert('verified content');
    await expect(value.files.applyUpsert(event, source)).rejects.toBeTruthy();
    await expect(readFile(join(value.root, '文件', '工作文件.txt'))).rejects.toMatchObject({code: 'ENOENT'});
    expect(value.state.snapshot().files).toEqual({});
    expect(await lstat(join(value.root, AGENT_TEMP_DIRECTORY))).toMatchObject({});
  });

  it('preserves local edits instead of overwriting or deleting them', async () => {
    const value = await fixture(); const first = upsert('server one');
    await value.files.applyUpsert(first, (async function* () {yield 'server one';})());
    await writeFile(join(value.root, '文件', '工作文件.txt'), 'local edit');
    const second = {...upsert('server two', '文件/工作文件.txt', 2), fileRevision: 2};
    await expect(value.files.applyUpsert(second, (async function* () {yield 'server two';})()))
      .rejects.toMatchObject({code: 'LOCAL_CONTENT_CONFLICT'});
    const tombstone: Extract<StorageManifestEvent, {kind: 'DELETE'}> = {sequence: 3, kind: 'DELETE',
      fileEntryId, fileRevision: 3, deletedAt: '2026-08-13T00:00:00.000Z', createdAt: '2026-08-13T00:00:00.000Z'};
    await expect(value.files.applyDelete(tombstone)).rejects.toMatchObject({code: 'LOCAL_CONTENT_CONFLICT'});
    expect(await readFile(join(value.root, '文件', '工作文件.txt'), 'utf8')).toBe('local edit');
  });

  it('rejects hard links and target symlinks without touching their content', async () => {
    const value = await fixture(); await mkdir(join(value.root, 'safe')); const source = join(value.root, 'source');
    await writeFile(source, 'outside alias'); await link(source, join(value.root, 'safe', 'hard.txt'));
    await expect(value.files.applyUpsert(upsert('new', 'safe/hard.txt'), (async function* () {yield 'new';})()))
      .rejects.toMatchObject({code: 'LOCAL_CONTENT_CONFLICT'});
    await symlink(source, join(value.root, 'safe', 'symbolic.txt'));
    await expect(value.files.applyUpsert(upsert('new', 'safe/symbolic.txt'), (async function* () {yield 'new';})()))
      .rejects.toMatchObject({code: 'LOCAL_CONTENT_CONFLICT'});
    expect(await readFile(source, 'utf8')).toBe('outside alias');
  });

  it('limits an explicit conflict overwrite to the path named by that conflict', async () => {
    const value = await fixture(); await writeFile(join(value.root, 'unrelated.txt'), 'keep me');
    const event = upsert('server', 'unrelated.txt');
    await expect(value.files.applyUpsert(event, (async function* () {yield 'server';})(),
      {force: true, conflictPath: 'different.txt'})).rejects.toMatchObject({code: 'LOCAL_CONTENT_CONFLICT'});
    expect(await readFile(join(value.root, 'unrelated.txt'), 'utf8')).toBe('keep me');
    expect(value.state.snapshot().files).toEqual({});
  });

  it('rejects a force apply when the conflict changed after the Chair decision', async () => {
    const value = await fixture(); const first = upsert('server');
    await value.files.applyUpsert(first, (async function* () {yield 'server';})());
    await writeFile(join(value.root, '文件', '工作文件.txt'), 'newer local edit');
    const next = {...upsert('server next', '文件/工作文件.txt', 2), fileRevision: 2};
    await expect(value.files.applyUpsert(next, (async function* () {yield 'server next';})(), {
      force: true, conflictPath: '文件/工作文件.txt',
      conflictExpected: {sizeBytes: 10, sha256: digest('local edit')}}))
      .rejects.toMatchObject({code: 'LOCAL_CONTENT_CONFLICT'});
    expect(await readFile(join(value.root, '文件', '工作文件.txt'), 'utf8')).toBe('newer local edit');
  });

  it('applies a tombstone idempotently before a stale upsert can be scanned', async () => {
    const value = await fixture(); const event = upsert('deleted content');
    await value.files.applyUpsert(event, (async function* () {yield 'deleted content';})());
    const tombstone: Extract<StorageManifestEvent, {kind: 'DELETE'}> = {sequence: 2, kind: 'DELETE',
      fileEntryId, fileRevision: 2, deletedAt: '2026-08-13T00:00:00.000Z', createdAt: '2026-08-13T00:00:00.000Z'};
    await value.files.applyDelete(tombstone); await value.files.applyDelete(tombstone);
    await expect(readFile(join(value.root, '文件', '工作文件.txt'))).rejects.toMatchObject({code: 'ENOENT'});
    expect(value.state.snapshot()).toMatchObject({manifestSequence: 2, files: {}});
  });
});
