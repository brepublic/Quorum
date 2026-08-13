// @vitest-environment node

import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {StorageAgentTask, StorageManifestEvent} from '@quorum/contracts';
import type {StorageAgentHttpClient} from './client';
import {AgentApiError} from './errors';
import {AgentFileStore} from './files';
import {StorageAgentRuntime} from './runtime';
import {AgentDirectoryScanner} from './scanner';
import {AgentStateStore} from './state';

const roots: string[] = [];
const committeeId = '10000000-0000-4000-8000-000000000001';
const deviceId = '20000000-0000-4000-8000-000000000001';
const fileEntryId = '30000000-0000-4000-8000-000000000001';
const blobId = '40000000-0000-4000-8000-000000000001';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

afterEach(async () => { vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(path => rm(path, {recursive: true, force: true}))); });

function task(type: StorageAgentTask['type'], overrides: Partial<StorageAgentTask> = {}): StorageAgentTask {
  return {id: randomUUID(), committeeId, sequence: 1, type, fileEntryId, fileRevision: 1,
    blobId: type === 'DELETE_FILE' ? null : blobId, expectedSizeBytes: type === 'DELETE_FILE' ? null : 3,
    expectedSha256: type === 'DELETE_FILE' ? null : digest('new'), contentState: 'NONE', receivedSizeBytes: null,
    actualSha256: null, leaseGeneration: 1, status: 'PENDING', revision: 1, attempts: 0, claimToken: null,
    failureCode: null, nextAttemptAt: '2026-08-13T00:00:00.000Z', createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z', ...overrides};
}

async function fixture(clientOverrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'quorum-agent-runtime-')); roots.push(root);
  const state = await AgentStateStore.initialize(root, {committeeId, deviceId});
  const files = new AgentFileStore(state); const scanner = new AgentDirectoryScanner(state, files);
  const client = {heartbeat: vi.fn(async () => ({})), manifest: vi.fn(async () => ({events: [], nextSequence: 0,
    hasMore: false})), tasks: vi.fn(async () => ({tasks: [], nextSequence: 0, hasMore: false})),
    claim: vi.fn(async (value: StorageAgentTask) => ({...value, status: 'IN_PROGRESS',
      claimToken: '50000000-0000-4000-8000-000000000001'})), complete: vi.fn(async (value: StorageAgentTask) => value),
    fail: vi.fn(async (value: StorageAgentTask) => value), download: vi.fn(), upload: vi.fn(), localChange: vi.fn(),
    ...clientOverrides} as unknown as StorageAgentHttpClient;
  return {root, state, files, scanner, client,
    runtime: new StorageAgentRuntime(client, 1, state, files, scanner)};
}

describe('Chair Agent recovery loop', () => {
  it('applies the latest tombstone before downloading any server UPSERT task', async () => {
    const value = await fixture();
    const old: Extract<StorageManifestEvent, {kind: 'UPSERT'}> = {sequence: 1, kind: 'UPSERT', fileEntryId,
      fileRevision: 1, versionId: randomUUID(), blobId, logicalName: 'old.txt', originalName: 'old.txt',
      mediaType: 'text/plain', sizeBytes: 3, sha256: digest('old'), createdAt: '2026-08-13T00:00:00.000Z'};
    await value.files.applyUpsert(old, (async function* () {yield 'old';})());
    const deleted: Extract<StorageManifestEvent, {kind: 'DELETE'}> = {sequence: 2, kind: 'DELETE', fileEntryId,
      fileRevision: 2, deletedAt: '2026-08-13T00:00:00.000Z', createdAt: '2026-08-13T00:00:00.000Z'};
    const nextId = '60000000-0000-4000-8000-000000000001';
    const next: Extract<StorageManifestEvent, {kind: 'UPSERT'}> = {sequence: 3, kind: 'UPSERT', fileEntryId: nextId,
      fileRevision: 1, versionId: randomUUID(), blobId: randomUUID(), logicalName: 'new.txt', originalName: 'new.txt',
      mediaType: 'text/plain', sizeBytes: 3, sha256: digest('new'), createdAt: '2026-08-13T00:00:00.000Z'};
    const store = task('STORE_BLOB', {fileEntryId: nextId, blobId: next.blobId, expectedSizeBytes: 3,
      expectedSha256: next.sha256});
    vi.mocked(value.client.manifest).mockResolvedValue({events: [old, deleted, next], nextSequence: 3, hasMore: false});
    vi.mocked(value.client.tasks).mockResolvedValue({tasks: [store], nextSequence: 1, hasMore: false});
    vi.mocked(value.client.download).mockResolvedValue((async function* () {yield Buffer.from('new');})());
    const deletedOrder = vi.spyOn(value.files, 'applyDelete'); const upsertOrder = vi.spyOn(value.files, 'applyUpsert');
    await value.runtime.synchronizeOnce();
    expect(deletedOrder.mock.invocationCallOrder[0]).toBeLessThan(upsertOrder.mock.invocationCallOrder[0] as number);
    await expect(readFile(join(value.root, 'old.txt'))).rejects.toMatchObject({code: 'ENOENT'});
    expect(await readFile(join(value.root, 'new.txt'), 'utf8')).toBe('new');
    expect(value.client.complete).toHaveBeenCalledOnce();
  });

  it('persists, uploads, completes, and recovers a local content task without a duplicate change', async () => {
    const value = await fixture(); await writeFile(join(value.root, 'local.txt'), 'local');
    const uploadTask = task('UPLOAD_BLOB', {expectedSizeBytes: 5, expectedSha256: digest('local')});
    const pending = {status: 'PENDING_CONTENT', changeRequestId: randomUUID(), task: uploadTask} as const;
    vi.mocked(value.client.localChange).mockResolvedValueOnce(pending).mockResolvedValueOnce({status: 'COMPLETED',
      changeRequestId: pending.changeRequestId, fileEntryId, fileRevision: 1});
    await value.runtime.synchronizeOnce();
    expect(value.state.snapshot().pendingUploads[uploadTask.id]).toBeTruthy();
    vi.mocked(value.client.tasks).mockResolvedValue({tasks: [uploadTask], nextSequence: 1, hasMore: false});
    await value.runtime.synchronizeOnce();
    expect(value.client.upload).toHaveBeenCalledOnce(); expect(value.client.complete).toHaveBeenCalledOnce();
    expect(value.state.snapshot()).toMatchObject({pendingUploads: {}, files: {[fileEntryId]: {
      relativePath: 'local.txt', sha256: digest('local')}}});
    expect(value.client.localChange).toHaveBeenCalledTimes(2);
  });

  it('recovers local state after the server completed a task before the process persisted the result', async () => {
    const value = await fixture(); await writeFile(join(value.root, 'local.txt'), 'local');
    const uploadTask = task('UPLOAD_BLOB', {expectedSizeBytes: 5, expectedSha256: digest('local')});
    const detected = await value.scanner.detectOne(); if (!detected) throw new Error('Expected local change.');
    await value.scanner.recordResult(detected, randomUUID(), 0, {status: 'PENDING_CONTENT',
      changeRequestId: randomUUID(), task: uploadTask});
    vi.mocked(value.client.tasks).mockResolvedValue({tasks: [{...uploadTask, status: 'COMPLETED'}],
      nextSequence: 1, hasMore: false});
    vi.mocked(value.client.localChange).mockResolvedValue({status: 'COMPLETED', changeRequestId: randomUUID(),
      fileEntryId, fileRevision: 1});
    await value.runtime.synchronizeOnce();
    expect(value.state.snapshot().pendingUploads).toEqual({});
    expect(value.client.claim).not.toHaveBeenCalled();
  });

  it('preserves a concurrent local edit and reports a durable revision conflict before failing the task', async () => {
    const value = await fixture();
    const initial: Extract<StorageManifestEvent, {kind: 'UPSERT'}> = {sequence: 1, kind: 'UPSERT', fileEntryId,
      fileRevision: 1, versionId: randomUUID(), blobId, logicalName: 'draft.txt', originalName: 'draft.txt',
      mediaType: 'text/plain', sizeBytes: 3, sha256: digest('old'), createdAt: '2026-08-13T00:00:00.000Z'};
    await value.files.applyUpsert(initial, (async function* () {yield 'old';})());
    await writeFile(join(value.root, 'draft.txt'), 'local edit');
    const server = {...initial, sequence: 2, fileRevision: 2, versionId: randomUUID(), blobId: randomUUID(),
      sizeBytes: 3, sha256: digest('new')};
    const store = task('STORE_BLOB', {fileRevision: 2, blobId: server.blobId, expectedSha256: server.sha256});
    vi.mocked(value.client.manifest).mockResolvedValue({events: [initial, server], nextSequence: 2, hasMore: false});
    vi.mocked(value.client.tasks).mockResolvedValue({tasks: [store], nextSequence: 1, hasMore: false});
    vi.mocked(value.client.download).mockResolvedValue((async function* () {yield Buffer.from('new');})());
    vi.mocked(value.client.localChange).mockResolvedValue({status: 'CONFLICT', changeRequestId: randomUUID(),
      conflictId: randomUUID(), reasonCode: 'REVISION_CONFLICT'});
    await expect(value.runtime.synchronizeOnce()).rejects.toMatchObject({code: 'LOCAL_CONTENT_CONFLICT'});
    expect(await readFile(join(value.root, 'draft.txt'), 'utf8')).toBe('local edit');
    expect(value.client.localChange).toHaveBeenCalledWith(1, expect.any(String), 2,
      expect.objectContaining({kind: 'UPSERT', fileEntryId, baseRevision: 1}));
    expect(value.client.fail).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.any(String),
      'LOCAL_CONTENT_CONFLICT');
  });

  it('uses a filesystem notification as a fast hint while retaining periodic scan fallback', async () => {
    const controller = new AbortController(); let resolveSubmitted!: () => void;
    const submitted = new Promise<void>(resolve => { resolveSubmitted = resolve; });
    const value = await fixture();
    vi.mocked(value.client.localChange).mockImplementation(async () => {
      resolveSubmitted(); controller.abort();
      return {status: 'CONFLICT', changeRequestId: randomUUID(), conflictId: randomUUID(),
        reasonCode: 'MANIFEST_STALE'};
    });
    const running = value.runtime.run(controller.signal, {scanIntervalMs: 10_000});
    await new Promise(resolve => setTimeout(resolve, 50));
    await writeFile(join(value.root, 'watcher.txt'), 'noticed');
    await Promise.race([submitted, new Promise((_, reject) => setTimeout(() => reject(new Error('watch timeout')), 2_000))]);
    await running;
    expect(value.client.localChange).toHaveBeenCalledOnce();
  });

  it('fails closed on an unknown protocol state before applying partial local changes', async () => {
    const value = await fixture();
    vi.mocked(value.client.manifest).mockResolvedValue({events: [{sequence: 1, kind: 'UNKNOWN'} as never],
      nextSequence: 1, hasMore: false});
    await expect(value.runtime.synchronizeOnce()).rejects.toMatchObject({code: 'UNKNOWN_PROTOCOL_STATE'});
    expect(value.state.snapshot()).toMatchObject({manifestSequence: 0, files: {}});
    expect(value.client.tasks).not.toHaveBeenCalled();
  });

  it('stops the long-running loop immediately when the server fences its lease', async () => {
    const value = await fixture();
    vi.mocked(value.client.heartbeat).mockRejectedValue(new AgentApiError(409, 'STALE_STORAGE_LEASE', 'stale'));
    await expect(value.runtime.run(new AbortController().signal, {scanIntervalMs: 10_000}))
      .rejects.toMatchObject({code: 'STALE_STORAGE_LEASE'});
    expect(value.client.heartbeat).toHaveBeenCalledOnce();
  });

  it('logs only a stable code when an operation error contains local or credential material', async () => {
    const value = await fixture(); const logged: unknown[] = [];
    vi.mocked(value.client.heartbeat).mockRejectedValue(new Error(`secret at ${value.root}`));
    const runtime = new StorageAgentRuntime(value.client, 1, value.state, value.files, value.scanner,
      {info: () => undefined, error: (_event, fields) => { logged.push(fields); }});
    const controller = new AbortController();
    const running = runtime.run(controller.signal, {scanIntervalMs: 10_000, retryMaximumMs: 1});
    await new Promise(resolve => setTimeout(resolve, 20)); controller.abort(); await running;
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.every(item => JSON.stringify(item) === '{"code":"AGENT_OPERATION_FAILED"}')).toBe(true);
    expect(JSON.stringify(logged)).not.toContain(value.root);
    expect(JSON.stringify(logged)).not.toContain('secret');
  });
});
