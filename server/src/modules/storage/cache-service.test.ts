// @vitest-environment node

import {mkdtemp, rm, statfs} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {DurableStagingStore} from './staging';
import {cacheStorageKey, StorageCacheService} from './cache-service';
import {normalizeError} from '../../http/errors';

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(), statfs: vi.fn()
}));

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))));

async function fixture(usage = {global_bytes: 0, committee_bytes: 0}) {
  vi.mocked(statfs).mockResolvedValue({bavail: 100, blocks: 1000, bsize: 1} as never);
  const root = await mkdtemp(join(tmpdir(), 'quorum-cache-')); roots.push(root);
  const source = new DurableStagingStore(join(root, 'staging'), 1024, 1024); await source.initialize();
  const cache = new DurableStagingStore(root, 1024, 1024); await cache.initialize();
  const effective = vi.fn(async () => ({publishedCacheMaxBytes: 1024, pendingReviewMaxBytes: 100,
    pendingReviewCommitteeMaxBytes: 80, storageMinFreeBytes: 0, storageMinFreePercent: 0, revision: 1,
    hardLimits: {publishedCacheMaxBytes: 1024, pendingReviewMaxBytes: 100,
      pendingReviewCommitteeMaxBytes: 80, storageMinFreeBytes: 0, storageMinFreePercent: 0}}));
  const query = vi.fn(async (sql: string) => sql.includes('COALESCE(sum(size_bytes)')
    ? {rows: [usage]} : {rows: []});
  const service = new StorageCacheService({query} as never, source, cache, {effective} as never);
  return {source, cache, service, client: {query} as never, query, effective};
}

describe('Chair file cache', () => {
  it('uses a deterministic opaque key and streams verified staging bytes into the cache', async () => {
    const value = await fixture(); const blobId = '10000000-0000-4000-8000-000000000001';
    await value.source.write({key: 'uploads/source', source: (async function* () { yield Buffer.from('abc'); })(), expectedSizeBytes: 3,
      expectedSha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'});
    const key = await value.service.retain(value.client, {committeeId: '20000000-0000-4000-8000-000000000001',
      fileEntryId: '30000000-0000-4000-8000-000000000001',
      fileVersionId: '40000000-0000-4000-8000-000000000001', blobId, sourceKey: 'uploads/source', sizeBytes: 3,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', reviewPinned: true});
    expect(key).toBe(cacheStorageKey(blobId));
    await expect(value.cache.verify(key, 3,
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')).resolves.toBeDefined();
    expect(value.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO storage_cache_entries'),
      expect.arrayContaining(['REVIEW_PINNED', key, 3]));
  });

  it('rejects a new pending file without deleting retained entries', async () => {
    const value = await fixture({global_bytes: 95, committee_bytes: 75});
    await expect(value.service.assertPendingCapacity('20000000-0000-4000-8000-000000000001', 10))
      .rejects.toMatchObject({code: 'SERVICE_NOT_READY'});
    expect(value.query).toHaveBeenCalledTimes(1);
  });

  it('returns disk measurements and effective and deployment limits through the API', async () => {
    const value = await fixture();
    const config = await value.effective();
    value.effective.mockResolvedValue({...config, storageMinFreeBytes: 20, storageMinFreePercent: 10,
      hardLimits: {...config.hardLimits, storageMinFreeBytes: 10, storageMinFreePercent: 5}});
    const error = await value.service.assertPendingCapacity('20000000-0000-4000-8000-000000000001', 1)
      .catch(error => error);
    expect(normalizeError(error, 'reserve-request').body.error).toMatchObject({
      code: 'SERVICE_NOT_READY', reason: 'STORAGE_RESERVE_REQUIRED', requestId: 'reserve-request',
      details: {availableBytes: 100, totalBytes: 1000, writeBytes: 1, minimumFreeBytes: 100,
        storageMinFreeBytes: 20, storageMinFreePercent: 10, hardMinFreeBytes: 10, hardMinFreePercent: 5}
    });
    // Exact equality with the reserve remains writable.
    await expect(value.service.assertPendingCapacity('20000000-0000-4000-8000-000000000001', 0)).resolves.toBeUndefined();
  });
});
