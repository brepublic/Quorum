// @vitest-environment node

import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {DurableStagingStore} from './staging';
import {cacheStorageKey, StorageCacheService} from './cache-service';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))));

async function fixture(usage = {global_bytes: 0, committee_bytes: 0}) {
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
  return {source, cache, service, client: {query} as never, query};
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
});
