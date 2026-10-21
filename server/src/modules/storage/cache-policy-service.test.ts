// @vitest-environment node
import {describe, expect, it, vi} from 'vitest';
import {StorageCachePolicyService} from './cache-policy-service';

describe('administrator cache policy', () => {
  it.each([0, 5 * 1024 ** 3])('uses saved settings without deployment clamps (reserve %s)', async reserve => {
    const query = vi.fn(async () => ({rows: [{published_cache_max_bytes: String(20 * 1024 ** 3),
      pending_review_max_bytes: String(10 * 1024 ** 3), pending_review_committee_max_bytes: String(2 * 1024 ** 3),
      storage_min_free_bytes: String(reserve), storage_min_free_percent: 0, storage_cache_config_revision: 3}]}));
    const policy = new StorageCachePolicyService({query} as never);
    expect(await policy.effective()).toEqual({publishedCacheMaxBytes: 20 * 1024 ** 3,
      pendingReviewMaxBytes: 10 * 1024 ** 3, pendingReviewCommitteeMaxBytes: 2 * 1024 ** 3,
      storageMinFreeBytes: reserve, storageMinFreePercent: 0, revision: 3});
  });
});
