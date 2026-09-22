import {randomUUID} from 'node:crypto';
import {statfs} from 'node:fs/promises';
import type {Pool, PoolClient} from 'pg';
import {AppError} from '../../http/errors.js';
import type {DurableStagingStore} from './staging.js';
import type {StorageCachePolicyService} from './cache-policy-service.js';

export function cacheStorageKey(blobId: string): string {
  const normalized = blobId.toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new AppError({reason: 'INVALID_REFERENCE', code: 'VALIDATION_FAILED', message: 'Blob ID is invalid.'});
  }
  return `cache/${normalized.slice(0, 2)}/${normalized}`;
}

export class StorageCacheService {
  constructor(
    private readonly pool: Pool,
    private readonly source: DurableStagingStore,
    private readonly cache: DurableStagingStore,
    private readonly policy: StorageCachePolicyService
  ) {}

  async retain(client: PoolClient, input: {committeeId: string; fileEntryId: string; fileVersionId: string;
    blobId: string; sourceKey: string; sizeBytes: number; sha256: string; reviewPinned: boolean}): Promise<string> {
    const config = await this.policy.effective();
    if (input.reviewPinned) await this.assertPendingCapacityWith(client, input.committeeId, input.sizeBytes, config);
    await this.assertDiskReserve(input.sizeBytes, config);
    const key = cacheStorageKey(input.blobId);
    if (await this.cache.exists(key)) await this.cache.verify(key, input.sizeBytes, input.sha256);
    else await this.cache.write({key, source: this.source.read(input.sourceKey, input.sizeBytes, input.sha256),
      expectedSizeBytes: input.sizeBytes, expectedSha256: input.sha256, contentLength: input.sizeBytes});
    await client.query(`INSERT INTO storage_cache_entries
      (id,committee_id,file_entry_id,file_version_id,blob_id,state,storage_key,size_bytes,cached_at)
      VALUES ($8,$1,$2,$3,$4,$5,$6,$7,now())
      ON CONFLICT (blob_id) DO UPDATE SET file_entry_id=EXCLUDED.file_entry_id,
        file_version_id=EXCLUDED.file_version_id,state=EXCLUDED.state,storage_key=EXCLUDED.storage_key,
        size_bytes=EXCLUDED.size_bytes,cached_at=EXCLUDED.cached_at,last_accessed_at=NULL,
        failure_code=NULL,state_changed_at=now(),updated_at=now()`,
    [input.committeeId, input.fileEntryId, input.fileVersionId, input.blobId,
      input.reviewPinned ? 'REVIEW_PINNED' : 'READY', key, input.sizeBytes, randomUUID()]);
    return key;
  }

  async assertPendingCapacity(committeeId: string, sizeBytes: number): Promise<void> {
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) return;
    const config = await this.policy.effective();
    await this.assertPendingCapacityWith(this.pool, committeeId, sizeBytes, config);
    await this.assertDiskReserve(sizeBytes, config);
  }

  async assertRefillCapacity(sizeBytes: number): Promise<void> {
    const config = await this.policy.effective();
    const usage = await this.pool.query<{used: string | number}>(`SELECT COALESCE(sum(size_bytes),0) AS used
      FROM storage_cache_entries WHERE state='READY'`);
    if (Number(usage.rows[0]?.used ?? 0) + sizeBytes > config.publishedCacheMaxBytes) {
      throw new AppError({reason: 'CACHE_FULL', expose: true, code: 'SERVICE_NOT_READY', message: 'Published cache is full.'});
    }
    await this.assertDiskReserve(sizeBytes, config);
  }

  private async assertPendingCapacityWith(executor: Pick<PoolClient, 'query'>, committeeId: string,
    sizeBytes: number, config: Awaited<ReturnType<StorageCachePolicyService['effective']>>): Promise<void> {
    const usage = await executor.query<{global_bytes: string | number; committee_bytes: string | number}>(`SELECT
        COALESCE(sum(size_bytes) FILTER (WHERE state='REVIEW_PINNED'),0) AS global_bytes,
        COALESCE(sum(size_bytes) FILTER (WHERE state='REVIEW_PINNED' AND committee_id=$1),0) AS committee_bytes
        FROM storage_cache_entries`, [committeeId]);
    const row = usage.rows[0];
    if (Number(row?.global_bytes ?? 0) + sizeBytes > config.pendingReviewMaxBytes
      || Number(row?.committee_bytes ?? 0) + sizeBytes > config.pendingReviewCommitteeMaxBytes) {
      throw new AppError({reason: 'REVIEW_STORAGE_FULL', expose: true, code: 'SERVICE_NOT_READY', message: 'Pending review storage is full.'});
    }
  }

  private async assertDiskReserve(sizeBytes: number,
    config: Awaited<ReturnType<StorageCachePolicyService['effective']>>): Promise<void> {
    const sample = await statfs(this.cache.rootPath);
    const available = Number(sample.bavail) * Number(sample.bsize);
    const total = Number(sample.blocks) * Number(sample.bsize);
    const minimum = Math.max(config.storageMinFreeBytes, Math.ceil(total * config.storageMinFreePercent / 100));
    if (available - sizeBytes < minimum) {
      throw new AppError({reason: 'STORAGE_RESERVE_REQUIRED', expose: true, code: 'SERVICE_NOT_READY', message: 'Storage reserve would be exceeded.'});
    }
  }

  async removeByFile(fileEntryId: string): Promise<void> {
    const result = await this.pool.query<{storage_key: string | null}>(
      'SELECT storage_key FROM storage_cache_entries WHERE file_entry_id=$1', [fileEntryId]);
    await Promise.all(result.rows.flatMap(row => row.storage_key ? [this.cache.remove(row.storage_key)] : []));
    await this.pool.query('DELETE FROM storage_cache_entries WHERE file_entry_id=$1', [fileEntryId]);
  }
}
