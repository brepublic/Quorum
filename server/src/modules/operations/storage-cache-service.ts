import {statfs} from 'node:fs/promises';
import type {StorageCacheConfig, StorageCacheFilePage, StorageCacheState, StorageCacheStatus} from '@quorum/contracts';
import type {Pool, QueryResultRow} from 'pg';
import {AppError} from '../../http/errors.js';
import type {Logger} from '../../logger.js';
import type {AuthenticatedSession} from '../identity/store.js';
import {audit, transaction, type Stage4Context} from '../stage4/database.js';
import type {StorageCachePolicyService} from '../storage/cache-policy-service.js';
import type {DurableStagingStore} from '../storage/staging.js';
import type {StorageCapacityMonitor} from '../storage/capacity.js';

export class StorageCacheRuntimeStats {
  hits = 0; misses = 0; refills = 0; lastEvictedAt: string | null = null; lastEvictedBytes = 0;
}

function admin(auth: AuthenticatedSession): void {
  if (auth.user.mustChangePassword || !auth.user.isSystemAdmin) {
    throw new AppError({reason: 'SYSTEM_ADMIN_REQUIRED', code: 'FORBIDDEN', message: 'System administrator access is required.'});
  }
}

function integer(value: unknown, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    throw new AppError({reason: 'NUMBER_OUT_OF_RANGE', params: {max: maximum}, code: 'VALIDATION_FAILED', message: `${name} is outside the deployment boundary.`});
  }
  return Number(value);
}

export class StorageCacheOperationsService {
  constructor(private readonly pool: Pool, private readonly cache: DurableStagingStore,
    private readonly policy: StorageCachePolicyService, readonly runtime: StorageCacheRuntimeStats,
    private readonly logger: Logger, private readonly capacity?: StorageCapacityMonitor) {}

  async status(auth: AuthenticatedSession): Promise<StorageCacheStatus> {
    admin(auth); const config = await this.policy.effective(); const fs = await statfs(this.cache.rootPath);
    const usage = (await this.pool.query<{pending: string | number; published: string | number;
      fetching: number; staging: string | number}>(`SELECT
      (SELECT COALESCE(sum(size_bytes),0) FROM storage_cache_entries WHERE state='REVIEW_PINNED') AS pending,
      (SELECT COALESCE(sum(size_bytes),0) FROM storage_cache_entries WHERE state IN ('READY','EVICTING')) AS published,
      (SELECT count(*)::int FROM storage_cache_entries WHERE state='FETCHING') AS fetching,
      (SELECT COALESCE(sum(expected_size_bytes),0) FROM file_uploads WHERE staging_deleted_at IS NULL) AS staging`)).rows[0];
    const pending = Number(usage?.pending ?? 0); const published = Number(usage?.published ?? 0);
    const staging = Number(usage?.staging ?? 0);
    return {config, capacity: {totalBytes: Number(fs.blocks) * Number(fs.bsize),
      availableBytes: Number(fs.bavail) * Number(fs.bsize), quorumBytes: pending + published + staging,
      pendingReviewBytes: pending, publishedCacheBytes: published, otherStagingBytes: staging},
    runtime: {hits: this.runtime.hits, misses: this.runtime.misses, refills: this.runtime.refills,
      fetching: Number(usage?.fetching ?? 0), lastEvictedAt: this.runtime.lastEvictedAt,
      lastEvictedBytes: this.runtime.lastEvictedBytes}};
  }

  async update(auth: AuthenticatedSession, body: Record<string, unknown>, context: Stage4Context) {
    admin(auth); const hard = this.policy.hardLimits;
    const requested: StorageCacheConfig = {
      publishedCacheMaxBytes: integer(body.publishedCacheMaxBytes, 'Published cache limit', hard.publishedCacheMaxBytes),
      pendingReviewMaxBytes: integer(body.pendingReviewMaxBytes, 'Pending review limit', hard.pendingReviewMaxBytes),
      pendingReviewCommitteeMaxBytes: integer(body.pendingReviewCommitteeMaxBytes, 'Committee pending review limit',
        hard.pendingReviewCommitteeMaxBytes),
      storageMinFreeBytes: integer(body.storageMinFreeBytes, 'Minimum free bytes', Number.MAX_SAFE_INTEGER),
      storageMinFreePercent: integer(body.storageMinFreePercent, 'Minimum free percent', 100),
      revision: integer(body.revision, 'Revision', Number.MAX_SAFE_INTEGER)
    };
    if (requested.pendingReviewCommitteeMaxBytes > requested.pendingReviewMaxBytes
      || requested.storageMinFreeBytes < hard.storageMinFreeBytes
      || requested.storageMinFreePercent < hard.storageMinFreePercent) {
      throw new AppError({reason: 'CACHE_LIMIT_INVALID', code: 'VALIDATION_FAILED', message: 'Storage cache configuration violates deployment boundaries.'});
    }
    await transaction(this.pool, async client => {
      const current = (await client.query<{storage_cache_config_revision: number}>(
        'SELECT storage_cache_config_revision FROM system_settings WHERE singleton=true FOR UPDATE')).rows[0];
      if (current?.storage_cache_config_revision !== requested.revision) {
        throw new AppError({code: 'REVISION_CONFLICT', message: 'Storage cache configuration changed.'});
      }
      await client.query(`UPDATE system_settings SET published_cache_max_bytes=$1,pending_review_max_bytes=$2,
        pending_review_committee_max_bytes=$3,storage_min_free_bytes=$4,storage_min_free_percent=$5,
        storage_cache_config_revision=storage_cache_config_revision+1 WHERE singleton=true`,
      [requested.publishedCacheMaxBytes, requested.pendingReviewMaxBytes,
        requested.pendingReviewCommitteeMaxBytes, requested.storageMinFreeBytes, requested.storageMinFreePercent]);
      await audit(client, context, {actorUserId: auth.user.id, capabilities: ['SYSTEM_ADMIN'],
        action: 'storage.cache_config_updated', resourceType: 'system_settings',
        before: {revision: requested.revision}, after: {revision: requested.revision + 1}});
    });
    return this.policy.effective();
  }

  async files(auth: AuthenticatedSession, state: 'published' | 'pending', page: number, pageSize: number): Promise<StorageCacheFilePage> {
    admin(auth); const size = Math.min(100, Math.max(1, pageSize)); const current = Math.max(1, page);
    const states: StorageCacheState[] = state === 'pending' ? ['REVIEW_PINNED'] : ['READY', 'EVICTING'];
    const result = await this.pool.query<QueryResultRow>(`SELECT cache.id,cache.committee_id,committee.name AS committee_name,
      cache.file_entry_id,entry.logical_name,cache.size_bytes,cache.state::text,cache.cached_at,cache.last_accessed_at,
      count(*) OVER()::int AS total FROM storage_cache_entries cache JOIN committees committee ON committee.id=cache.committee_id
      JOIN file_entries entry ON entry.id=cache.file_entry_id WHERE cache.state=ANY($1::storage_cache_state[])
      ORDER BY CASE WHEN cache.state='REVIEW_PINNED' THEN 0 ELSE 1 END,
        cache.last_accessed_at ASC NULLS FIRST,cache.cached_at ASC NULLS FIRST,cache.id ASC LIMIT $2 OFFSET $3`,
    [states, size, (current - 1) * size]);
    return {files: result.rows.map(row => ({id: row.id, committeeId: row.committee_id,
      committeeName: row.committee_name, fileEntryId: row.file_entry_id, fileName: row.logical_name,
      sizeBytes: Number(row.size_bytes), state: row.state, cachedAt: row.cached_at?.toISOString() ?? null,
      lastAccessedAt: row.last_accessed_at?.toISOString() ?? null})), page: current, pageSize: size,
    total: Number(result.rows[0]?.total ?? 0)};
  }

  async evictOne(): Promise<boolean> {
    const config = await this.policy.effective(); const fs = await statfs(this.cache.rootPath);
    const capacityState = await this.capacity?.sample();
    const used = Number((await this.pool.query<{used: string | number}>(`SELECT COALESCE(sum(size_bytes),0) AS used
      FROM storage_cache_entries WHERE state='READY'`)).rows[0]?.used ?? 0);
    const total = Number(fs.blocks) * Number(fs.bsize); const available = Number(fs.bavail) * Number(fs.bsize);
    if (capacityState?.state === 'normal' && used <= config.publishedCacheMaxBytes
      && available >= Math.max(config.storageMinFreeBytes, total * config.storageMinFreePercent / 100)) return false;
    if (!capacityState && used <= config.publishedCacheMaxBytes
      && available >= Math.max(config.storageMinFreeBytes, total * config.storageMinFreePercent / 100)) return false;
    const claimed = await transaction(this.pool, async client => (await client.query<{id: string; storage_key: string;
      size_bytes: string | number}>(`UPDATE storage_cache_entries SET state='EVICTING',state_changed_at=now(),updated_at=now()
      WHERE id=(SELECT id FROM storage_cache_entries WHERE state='READY'
        ORDER BY last_accessed_at ASC NULLS FIRST,cached_at ASC,id ASC FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id,storage_key,size_bytes`)).rows[0]);
    if (!claimed) return false;
    try {
      await this.cache.remove(claimed.storage_key);
      await this.pool.query(`UPDATE storage_cache_entries SET state='MISSING',storage_key=NULL,cached_at=NULL,
        state_changed_at=now(),updated_at=now() WHERE id=$1 AND state='EVICTING'`, [claimed.id]);
      this.runtime.lastEvictedAt = new Date().toISOString(); this.runtime.lastEvictedBytes = Number(claimed.size_bytes);
      return true;
    } catch (error) {
      await this.pool.query(`UPDATE storage_cache_entries SET state='READY',state_changed_at=now(),updated_at=now()
        WHERE id=$1 AND state='EVICTING'`, [claimed.id]);
      this.logger.error('storage.cache_eviction_failed', {error}); return false;
    }
  }

  async renderMetrics(): Promise<string> {
    const rows = await this.pool.query<{state: string; bytes: string | number; count: number}>(`SELECT state::text,
      COALESCE(sum(size_bytes),0) AS bytes,count(*)::int AS count FROM storage_cache_entries GROUP BY state`);
    const lines = ['# TYPE quorum_storage_cache_bytes gauge', '# TYPE quorum_storage_cache_entries gauge'];
    for (const state of ['REVIEW_PINNED', 'READY', 'MISSING', 'FETCHING', 'EVICTING', 'FAILED']) {
      const row = rows.rows.find(item => item.state === state);
      lines.push(`quorum_storage_cache_bytes{state="${state.toLowerCase()}"} ${Number(row?.bytes ?? 0)}`,
        `quorum_storage_cache_entries{state="${state.toLowerCase()}"} ${Number(row?.count ?? 0)}`);
    }
    lines.push('# TYPE quorum_storage_cache_access_total counter',
      `quorum_storage_cache_access_total{result="hit"} ${this.runtime.hits}`,
      `quorum_storage_cache_access_total{result="miss"} ${this.runtime.misses}`,
      '# TYPE quorum_storage_cache_refill_total counter', `quorum_storage_cache_refill_total ${this.runtime.refills}`);
    return `${lines.join('\n')}\n`;
  }
}

export function startStorageCacheWorker(service: StorageCacheOperationsService, intervalMs = 15_000): () => void {
  let stopped = false; let running = false;
  const timer = setInterval(() => { if (running || stopped) return; running = true;
    void service.evictOne().finally(() => {running = false;}); }, intervalMs); timer.unref();
  return () => {stopped = true; clearInterval(timer);};
}
