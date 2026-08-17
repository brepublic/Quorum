// @vitest-environment node

import {createHash, randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import type {StorageAgentLocalChangeResult, StorageManifestEvent} from '@quorum/contracts';
import {AgentFileStore} from './files';
import {AgentDirectoryScanner} from './scanner';
import {AgentStateStore} from './state';

const roots: string[] = [];
const committeeId = '10000000-0000-4000-8000-000000000001';
const deviceId = '20000000-0000-4000-8000-000000000001';
const fileEntryId = '30000000-0000-4000-8000-000000000001';
const blobId = '40000000-0000-4000-8000-000000000001';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

afterEach(async () => Promise.all(roots.splice(0).map(path => rm(path, {recursive: true, force: true}))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'quorum-agent-scan-')); roots.push(root);
  const state = await AgentStateStore.initialize(root, {committeeId, deviceId});
  const files = new AgentFileStore(state); const scanner = new AgentDirectoryScanner(state, files);
  return {root, state, files, scanner};
}

async function track(value: Awaited<ReturnType<typeof fixture>>, content = 'server content', path = 'draft.txt') {
  const event: Extract<StorageManifestEvent, {kind: 'UPSERT'}> = {sequence: 1, kind: 'UPSERT', fileEntryId,
    fileRevision: 1, versionId: randomUUID(), blobId, logicalName: path, originalName: path,
    mediaType: 'text/plain', sizeBytes: Buffer.byteLength(content), sha256: digest(content),
    createdAt: '2026-08-13T00:00:00.000Z'};
  await value.files.applyUpsert(event, (async function* () {yield content;})());
}

describe('Chair Agent periodic full scan', () => {
  it('detects new and modified files with complete SHA-256 content metadata', async () => {
    const value = await fixture(); await writeFile(join(value.root, '本地新增.txt'), 'new content');
    await expect(value.scanner.detectOne()).resolves.toEqual({relativePath: '本地新增.txt', change: {
      kind: 'UPSERT', logicalName: '本地新增.txt', originalName: '本地新增.txt',
      mediaType: 'application/octet-stream', sizeBytes: 11, sha256: digest('new content')}});
    await rm(join(value.root, '本地新增.txt')); await track(value); await writeFile(join(value.root, 'draft.txt'), 'edited');
    await expect(value.scanner.detectOne()).resolves.toEqual({relativePath: 'draft.txt', change: {
      kind: 'UPSERT', fileEntryId, baseRevision: 1, logicalName: 'draft.txt', originalName: 'draft.txt',
      mediaType: 'application/octet-stream', sizeBytes: 6, sha256: digest('edited')}});
  });

  it('detects a same-content move as rename before reporting deletion', async () => {
    const value = await fixture(); await track(value); await rename(join(value.root, 'draft.txt'),
      join(value.root, 'renamed.txt'));
    await expect(value.scanner.detectOne()).resolves.toEqual({relativePath: 'renamed.txt', change: {
      kind: 'RENAME', fileEntryId, baseRevision: 1, logicalName: 'renamed.txt'}});
  });

  it('reports a tracked missing file as an explicit revisioned delete', async () => {
    const value = await fixture(); await track(value); await unlink(join(value.root, 'draft.txt'));
    await expect(value.scanner.detectOne()).resolves.toEqual({relativePath: 'draft.txt', change: {
      kind: 'DELETE', fileEntryId, baseRevision: 1}});
  });

  it('persists pending task recovery and suppresses its own upload echo', async () => {
    const value = await fixture(); await writeFile(join(value.root, 'new.txt'), 'pending');
    const detected = await value.scanner.detectOne();
    if (!detected || detected.change.kind !== 'UPSERT') throw new Error('Expected local upsert.');
    const taskId = randomUUID(); const requestId = randomUUID();
    const result = {status: 'PENDING_CONTENT', changeRequestId: randomUUID(), task: {id: taskId, committeeId,
      sequence: 1, type: 'UPLOAD_BLOB', fileEntryId, fileRevision: 1, blobId, expectedSizeBytes: 7,
      expectedSha256: digest('pending'), contentState: 'NONE', receivedSizeBytes: null, actualSha256: null,
      leaseGeneration: 1, status: 'PENDING', revision: 1, attempts: 0, claimToken: null, failureCode: null,
      resolutionConflictId: null,
      nextAttemptAt: '2026-08-13T00:00:00.000Z', createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z'}} satisfies StorageAgentLocalChangeResult;
    await value.scanner.recordResult(detected, requestId, 0, result);
    expect(value.state.snapshot().pendingUploads[taskId]).toMatchObject({requestId, relativePath: 'new.txt'});
    await expect(value.scanner.detectOne()).resolves.toBeNull();
    await value.scanner.completePending(taskId, fileEntryId, 1, blobId);
    expect(value.state.snapshot()).toMatchObject({pendingUploads: {}, files: {[fileEntryId]: {
      relativePath: 'new.txt', revision: 1, sha256: digest('pending')}}});
    await expect(value.scanner.detectOne()).resolves.toBeNull();
  });

  it('updates tracked state after a completed rename without treating it as a new file', async () => {
    const value = await fixture(); await track(value); await rename(join(value.root, 'draft.txt'),
      join(value.root, 'renamed.txt'));
    const detected = await value.scanner.detectOne();
    if (!detected) throw new Error('Expected rename.');
    await value.scanner.recordResult(detected, randomUUID(), 1, {status: 'COMPLETED',
      changeRequestId: randomUUID(), fileEntryId, fileRevision: 2});
    expect(value.state.snapshot().files[fileEntryId]).toMatchObject({relativePath: 'renamed.txt', revision: 2});
    await expect(value.scanner.detectOne()).resolves.toBeNull();
  });

  it('rejects symlinks discovered by a full scan instead of following them', async () => {
    const value = await fixture(); const outside = await mkdtemp(join(tmpdir(), 'quorum-agent-scan-outside-'));
    roots.push(outside); await writeFile(join(outside, 'secret'), 'not for upload');
    await symlink(join(outside, 'secret'), join(value.root, 'linked'));
    await expect(value.scanner.detectOne()).rejects.toMatchObject({code: 'UNSAFE_LOCAL_PATH'});
  });

  it('uses deterministic ordering so one manifest-changing command is submitted per scan', async () => {
    const value = await fixture(); await mkdir(join(value.root, 'z')); await writeFile(join(value.root, 'z', 'b'), 'b');
    await writeFile(join(value.root, 'a'), 'a');
    await expect(value.scanner.detectOne()).resolves.toMatchObject({relativePath: 'a'});
  });
});
