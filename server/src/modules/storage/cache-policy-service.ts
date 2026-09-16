import type {EffectiveStorageCacheConfig, StorageCacheConfig, StorageCacheHardLimits} from '@quorum/contracts';
import type {Pool, QueryResultRow} from 'pg';
import type {ServerConfig} from '../../config.js';

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
  readonly hardLimits: StorageCacheHardLimits;

  constructor(private readonly pool: Pool, config: ServerConfig) {
    this.hardLimits = {
      publishedCacheMaxBytes: config.publishedCacheHardMaxBytes,
      pendingReviewMaxBytes: config.pendingReviewHardMaxBytes,
      pendingReviewCommitteeMaxBytes: config.pendingReviewCommitteeHardMaxBytes,
      storageMinFreeBytes: config.storageHardMinFreeBytes,
      storageMinFreePercent: config.storageHardMinFreePercent
    };
  }

  async effective(): Promise<EffectiveStorageCacheConfig> {
    const result = await this.pool.query<PolicyRow>(`SELECT published_cache_max_bytes,pending_review_max_bytes,
      pending_review_committee_max_bytes,storage_min_free_bytes,storage_min_free_percent,
      storage_cache_config_revision FROM system_settings WHERE singleton=true`);
    const configured = policy(result.rows[0] as PolicyRow);
    return {
      publishedCacheMaxBytes: Math.min(configured.publishedCacheMaxBytes, this.hardLimits.publishedCacheMaxBytes),
      pendingReviewMaxBytes: Math.min(configured.pendingReviewMaxBytes, this.hardLimits.pendingReviewMaxBytes),
      pendingReviewCommitteeMaxBytes: Math.min(configured.pendingReviewCommitteeMaxBytes,
        this.hardLimits.pendingReviewCommitteeMaxBytes),
      storageMinFreeBytes: Math.max(configured.storageMinFreeBytes, this.hardLimits.storageMinFreeBytes),
      storageMinFreePercent: Math.max(configured.storageMinFreePercent, this.hardLimits.storageMinFreePercent),
      revision: configured.revision,
      hardLimits: this.hardLimits
    };
  }
}
