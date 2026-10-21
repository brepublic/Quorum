import type {StorageCacheConfig} from '@quorum/contracts';
import type {Pool, QueryResultRow} from 'pg';

interface PolicyRow extends QueryResultRow {
  published_cache_max_bytes: string | number;
  pending_review_max_bytes: string | number;
  pending_review_committee_max_bytes: string | number;
  storage_min_free_bytes: string | number;
  storage_min_free_percent: number;
  storage_cache_config_revision: number;
}

function policy(row: PolicyRow): StorageCacheConfig {
  return {
    publishedCacheMaxBytes: Number(row.published_cache_max_bytes),
    pendingReviewMaxBytes: Number(row.pending_review_max_bytes),
    pendingReviewCommitteeMaxBytes: Number(row.pending_review_committee_max_bytes),
    storageMinFreeBytes: Number(row.storage_min_free_bytes),
    storageMinFreePercent: row.storage_min_free_percent,
    revision: row.storage_cache_config_revision
  };
}

export class StorageCachePolicyService {
  constructor(private readonly pool: Pool) {}

  async effective(): Promise<StorageCacheConfig> {
    const result = await this.pool.query<PolicyRow>(`SELECT published_cache_max_bytes,pending_review_max_bytes,
      pending_review_committee_max_bytes,storage_min_free_bytes,storage_min_free_percent,
      storage_cache_config_revision FROM system_settings WHERE singleton=true`);
    return policy(result.rows[0] as PolicyRow);
  }
}
