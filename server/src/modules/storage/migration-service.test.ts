// @vitest-environment node

import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createLogger} from '../../logger';
import {DurableStagingStore} from './staging';
import {copyProviderBlob, startStorageMigrationWorker} from './migration-service';
import {Stage6MigrationService} from './migration-service';

const roots: string[] = [];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, {recursive: true, force: true})));
});

async function staging() {
  const root = await mkdtemp(join(tmpdir(), 'quorum-migration-copy-'));
  roots.push(root);
  const store = new DurableStagingStore(root, 1024, 2048);
  await store.initialize();
  return store;
}

describe('provider migration streaming copy', () => {
  it('streams the source through durable staging and reuses the server target blob ID', async () => {
    const content = 'streamed migration content';
    const store = await staging();
    const source = {read: vi.fn((_key: string, size: number, sha256: string) => (async function* () {
      expect(size).toBe(Buffer.byteLength(content)); expect(sha256).toBe(digest(content));
      yield content.slice(0, 8); yield content.slice(8);
    })())};
    const targetBlobId = randomUUID();
    const target = {commitFromStaging: vi.fn(async input => {
      await input.staging.verify(input.stagingKey, input.expectedSizeBytes, input.expectedSha256);
      return {storageKey: `blobs/${targetBlobId}`, sizeBytes: input.expectedSizeBytes, sha256: input.expectedSha256};
    })};
    const result = await copyProviderBlob({staging: store, stagingKey: `provider-migrations/aa/${randomUUID()}`,
      source, sourceStorageKey: 'blobs/source', target, targetBlobId,
      sizeBytes: Buffer.byteLength(content), sha256: digest(content)});
    expect(result).toEqual({storageKey: `blobs/${targetBlobId}`,
      sizeBytes: Buffer.byteLength(content), sha256: digest(content)});
    expect(source.read).toHaveBeenCalledOnce();
    expect(target.commitFromStaging).toHaveBeenCalledWith(expect.objectContaining({blobId: targetBlobId}));
  });

  it('reuses a verified durable staging copy after a target failure without rereading source', async () => {
    const content = 'retryable migration content';
    const store = await staging();
    const key = `provider-migrations/bb/${randomUUID()}`;
    const source = {read: vi.fn(() => (async function* () {yield content;})())};
    const targetBlobId = randomUUID();
    const failing = {commitFromStaging: vi.fn(async () => {throw new Error('target unavailable');})};
    await expect(copyProviderBlob({staging: store, stagingKey: key, source, sourceStorageKey: 'blobs/source',
      target: failing, targetBlobId, sizeBytes: Buffer.byteLength(content), sha256: digest(content)}))
      .rejects.toThrow('target unavailable');
    expect(await store.exists(key)).toBe(true);
    const recovered = {commitFromStaging: vi.fn(async input => ({storageKey: 'blobs/recovered',
      sizeBytes: input.expectedSizeBytes, sha256: input.expectedSha256}))};
    await copyProviderBlob({staging: store, stagingKey: key, source, sourceStorageKey: 'blobs/source',
      target: recovered, targetBlobId, sizeBytes: Buffer.byteLength(content), sha256: digest(content)});
    expect(source.read).toHaveBeenCalledOnce();
  });

  it('does not invoke the target when the source stream is short, long, or corrupted', async () => {
    const expected = 'expected';
    for (const [name, actual] of [['short', 'expecte'], ['long', 'expected!'], ['hash', 'xxxxxxxx']] as const) {
      const store = await staging();
      const target = {commitFromStaging: vi.fn()};
      await expect(copyProviderBlob({staging: store,
        stagingKey: `provider-migrations/${name}/${randomUUID()}`,
        source: {read: () => (async function* () {yield actual;})()}, sourceStorageKey: 'blobs/source',
        target, targetBlobId: randomUUID(), sizeBytes: Buffer.byteLength(expected), sha256: digest(expected)}))
        .rejects.toBeDefined();
      expect(target.commitFromStaging).not.toHaveBeenCalled();
    }
  });

  it('runs copy work serially and stops the production loop cleanly', async () => {
    vi.useFakeTimers();
    const processNextCopyItem = vi.fn()
      .mockResolvedValueOnce({id: 'first'})
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const logs: string[] = [];
    const stop = startStorageMigrationWorker({processNextCopyItem}, createLogger(line => logs.push(line)), 100);
    await vi.advanceTimersByTimeAsync(0);
    expect(processNextCopyItem).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(processNextCopyItem).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(processNextCopyItem).toHaveBeenCalledTimes(3);
    expect(logs).toEqual([]);
    vi.useRealTimers();
  });

  it('does not claim provider copy work while capacity is critical or unknown', async () => {
    const service = new Stage6MigrationService({} as never, {} as never, {} as never, {} as never,
      (() => ({})) as never, {sample: vi.fn(), assertWriteAllowed: vi.fn().mockRejectedValue(new Error('full'))});
    await expect(service.processNextCopyItem()).resolves.toBeNull();
  });
});
