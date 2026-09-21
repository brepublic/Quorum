import {randomUUID} from 'node:crypto';
import type {DownloadReadiness} from '@quorum/contracts';
import type {Pool} from 'pg';
import {transaction} from '../stage4/database.js';
import type {StorageCacheService} from './cache-service.js';

export class StorageCacheRefillService {
  constructor(private readonly pool: Pool, private readonly cache?: StorageCacheService) {}

  async prepare(input: {committeeId: string; fileEntryId: string; fileRevision: number; fileVersionId: string;
    blobId: string; sizeBytes: number; sha256: string; providerType: string}): Promise<DownloadReadiness> {
    if (input.providerType !== 'CHAIR_AGENT') return {status: 'READY'};
    try { await this.cache?.assertRefillCapacity(input.sizeBytes); }
    catch { return {status: 'UNAVAILABLE', code: 'STORAGE_CACHE_CAPACITY_UNAVAILABLE'}; }
    return transaction(this.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [input.blobId]);
      const cached = (await client.query<{state: string}>(
        'SELECT state::text FROM storage_cache_entries WHERE blob_id=$1 FOR UPDATE', [input.blobId])).rows[0];
      if (cached?.state === 'READY' || cached?.state === 'REVIEW_PINNED') return {status: 'READY'};
      const host = (await client.query<{id: string; lease_generation: string | number; status: string;
        capabilities: string[]}>(`SELECT h.id,h.lease_generation,h.status,h.capabilities FROM committees c
        JOIN storage_bindings b ON b.id=c.active_storage_binding_id AND b.provider_type='CHAIR_AGENT' AND b.status='ACTIVE'
        JOIN storage_hosts h ON h.id=b.storage_host_id WHERE c.id=$1 FOR UPDATE OF h`, [input.committeeId])).rows[0];
      if (!host || host.status !== 'ACTIVE') return {status: 'UNAVAILABLE', code: 'STORAGE_AGENT_OFFLINE'};
      if (!host.capabilities.includes('CACHE_REFILL')) {
        return {status: 'UNAVAILABLE', code: 'STORAGE_AGENT_UPGRADE_REQUIRED'};
      }
      const active = (await client.query(`SELECT 1 FROM storage_agent_tasks WHERE host_id=$1
        AND lease_generation=$2 AND blob_id=$3 AND task_type='FETCH_BLOB_TO_CACHE'
        AND status IN ('PENDING','IN_PROGRESS','RETRY')`, [host.id, host.lease_generation, input.blobId])).rowCount;
      if (!active) {
        const taskId = randomUUID();
        const source = (await client.query<{file_revision: number; file_entry_id: string}>(`SELECT file_revision,file_entry_id
          FROM storage_manifest_events WHERE committee_id=$1 AND file_entry_id=coalesce((SELECT source_file_entry_id FROM file_versions WHERE id=$4),$2) AND kind='UPSERT' AND blob_id=$3
          ORDER BY sequence DESC LIMIT 1`, [input.committeeId, input.fileEntryId, input.blobId, input.fileVersionId])).rows[0];
        if (!source) return {status: 'UNAVAILABLE', code: 'STORAGE_AGENT_SOURCE_MISSING'};
        const sequence = (await client.query<{sequence: string | number}>(`UPDATE committees
          SET next_storage_agent_task_sequence=next_storage_agent_task_sequence+1 WHERE id=$1
          RETURNING next_storage_agent_task_sequence-1 AS sequence`, [input.committeeId])).rows[0]?.sequence;
        await client.query(`INSERT INTO storage_agent_tasks
          (id,committee_id,host_id,lease_generation,sequence,task_type,file_entry_id,file_revision,blob_id,
           expected_size_bytes,expected_sha256,content_staging_key)
          VALUES ($1,$2,$3,$4,$5,'FETCH_BLOB_TO_CACHE',$6,$7,$8,$9,decode($10,'hex'),$11)`,
        [taskId, input.committeeId, host.id, host.lease_generation, sequence, source.file_entry_id,
          source.file_revision, input.blobId, input.sizeBytes, input.sha256, `agent-cache/${taskId}`]);
      }
      await client.query(`INSERT INTO storage_cache_entries
        (id,committee_id,file_entry_id,file_version_id,blob_id,state,size_bytes)
        VALUES ($1,$2,$3,$4,$5,'FETCHING',$6)
        ON CONFLICT (blob_id) DO UPDATE SET state='FETCHING',storage_key=NULL,cached_at=NULL,
          failure_code=NULL,state_changed_at=now(),updated_at=now()`,
      [randomUUID(), input.committeeId, input.fileEntryId, input.fileVersionId, input.blobId, input.sizeBytes]);
      return {status: 'PREPARING', code: 'DOWNLOAD_PREPARING', retryAfterSeconds: 2};
    });
  }

  async readiness(blobId: string): Promise<DownloadReadiness> {
    const row = (await this.pool.query<{state: string; failure_code: string | null}>(
      'SELECT state::text,failure_code FROM storage_cache_entries WHERE blob_id=$1', [blobId])).rows[0];
    if (row?.state === 'READY' || row?.state === 'REVIEW_PINNED') return {status: 'READY'};
    if (row?.state === 'FETCHING') return {status: 'PREPARING', code: 'DOWNLOAD_PREPARING', retryAfterSeconds: 2};
    return {status: 'UNAVAILABLE', code: row?.failure_code === 'LOCAL_CONTENT_INVALID'
      ? 'STORAGE_AGENT_SOURCE_MISSING' : 'STORAGE_AGENT_OFFLINE'};
  }
}
