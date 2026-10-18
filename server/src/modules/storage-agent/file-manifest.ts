import {randomUUID} from 'node:crypto';
import type {PoolClient, QueryResultRow} from 'pg';
import {AppError} from '../../http/errors.js';
import {appendEvent, type Stage4CommitteeRow} from '../stage4/database.js';

export interface CurrentAgentFileVersion extends QueryResultRow {
  file_entry_id: string; file_revision: number; version_id: string; blob_id: string;
  logical_name: string; original_name: string; media_type: string; size_bytes: string | number; sha256: Buffer;
}

// Callers hold the committee lock before the file lock. Preserve the Agent's
// existing path: approving a business name does not rename a submitted file.
export async function ensureCurrentFileManifest(client: PoolClient, committee: Stage4CommitteeRow,
  fileId: string, options: {restoreContent?: boolean} = {}): Promise<CurrentAgentFileVersion> {
  const current = (await client.query<CurrentAgentFileVersion>(`SELECT e.id AS file_entry_id,
    e.revision AS file_revision,v.id AS version_id,v.blob_id,
    coalesce((SELECT logical_name FROM storage_manifest_events WHERE committee_id=e.committee_id
      AND file_entry_id=e.id AND kind='UPSERT' ORDER BY sequence DESC LIMIT 1),
      (SELECT history.path FROM (
        SELECT change.logical_name AS path,change.completed_at AS observed_at,change.id
          FROM storage_agent_change_requests change
          WHERE change.committee_id=e.committee_id AND change.file_entry_id=e.id
            AND change.status='COMPLETED' AND change.kind='RENAME'
        UNION ALL
        SELECT coalesce(upload.agent_relative_path,upload.logical_name),upload.committed_at,upload.id
          FROM file_uploads upload
          WHERE upload.committee_id=e.committee_id AND upload.committed_file_entry_id=e.id
            AND upload.status='COMMITTED'
        ) history ORDER BY history.observed_at DESC,history.id DESC LIMIT 1),
      file_agent_path(e.id,e.logical_name)) AS logical_name,
    v.original_name,v.media_type,v.size_bytes,v.sha256
    FROM file_entries e JOIN file_versions v ON v.id=e.current_version_id
      AND v.file_entry_id=e.id AND v.committee_id=e.committee_id
    JOIN file_blobs b ON b.id=v.blob_id AND b.durability_state='COMMITTED'
    WHERE e.committee_id=$1 AND e.id=$2 AND e.status<>'DELETED'`, [committee.id, fileId])).rows[0];
  if (!current) throw new AppError({reason: 'FILE_CONTENT_UNAVAILABLE', code: 'RESOURCE_CONFLICT',
    message: 'File content is unavailable.'});
  const latest = (await client.query<CurrentAgentFileVersion & {kind: string}>(`SELECT *
    FROM storage_manifest_events WHERE committee_id=$1 AND file_entry_id=$2 ORDER BY sequence DESC LIMIT 1`,
  [committee.id, fileId])).rows[0];
  if (latest?.kind === 'UPSERT' && latest.file_revision === current.file_revision
    && latest.version_id === current.version_id && latest.blob_id === current.blob_id
    && latest.logical_name === current.logical_name && latest.original_name === current.original_name
    && latest.media_type === current.media_type && Number(latest.size_bytes) === Number(current.size_bytes)
    && latest.sha256.equals(current.sha256)) return current;
  const allocated = (await client.query<{sequence: string | number}>(`UPDATE committees
    SET next_storage_manifest_sequence=next_storage_manifest_sequence+1,file_manifest_revision=file_manifest_revision+1
    WHERE id=$1 RETURNING next_storage_manifest_sequence-1 AS sequence`, [committee.id])).rows[0]!;
  committee.next_storage_manifest_sequence = Number(allocated.sequence) + 1;
  committee.file_manifest_revision += 1;
  await client.query(`INSERT INTO storage_manifest_events
    (committee_id,sequence,kind,file_entry_id,file_revision,version_id,blob_id,logical_name,
     original_name,media_type,size_bytes,sha256)
    VALUES ($1,$2,'UPSERT',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [committee.id, allocated.sequence, current.file_entry_id, current.file_revision, current.version_id,
    current.blob_id, current.logical_name, current.original_name, current.media_type, current.size_bytes, current.sha256]);
  // The manifest trigger skips blobs already held by the current Chair host.
  // A replacement is held at its submission path, so the formal target still
  // needs a verified STORE_BLOB task when its content changes.
  if (options.restoreContent && (latest?.kind !== 'UPSERT' || latest.blob_id !== current.blob_id
    || Number(latest.size_bytes) !== Number(current.size_bytes) || !latest.sha256.equals(current.sha256))) {
    const holder = (await client.query<{id: string; lease_generation: string | number}>(`SELECT h.id,h.lease_generation
      FROM storage_hosts h JOIN storage_bindings binding ON binding.storage_host_id=h.id
      JOIN file_blobs blob ON blob.storage_binding_id=binding.id AND blob.id=$2
      WHERE h.committee_id=$1 AND h.status IN ('ACTIVE','DEGRADED') AND binding.provider_type='CHAIR_AGENT'`,
    [committee.id, current.blob_id])).rows[0];
    if (holder) {
      const taskSequence = (await client.query<{sequence: string | number}>(`UPDATE committees
        SET next_storage_agent_task_sequence=next_storage_agent_task_sequence+1 WHERE id=$1
        RETURNING next_storage_agent_task_sequence-1 AS sequence`, [committee.id])).rows[0]!;
      await client.query(`INSERT INTO storage_agent_tasks
        (id,committee_id,host_id,lease_generation,sequence,task_type,file_entry_id,file_revision,blob_id,
         expected_size_bytes,expected_sha256)
        VALUES ($1,$2,$3,$4,$5,'STORE_BLOB',$6,$7,$8,$9,$10)`,
      [randomUUID(), committee.id, holder.id, holder.lease_generation, taskSequence.sequence, current.file_entry_id,
        current.file_revision, current.blob_id, current.size_bytes, current.sha256]);
    }
  }
  await invalidateManifestMigrations(client, committee);
  return current;
}

export async function ensureDeletedFileManifest(client: PoolClient, committee: Stage4CommitteeRow,
  fileId: string, revision: number, deletedAt: Date): Promise<void> {
  const latest = (await client.query<{kind: string; file_revision: number}>(`SELECT kind,file_revision
    FROM storage_manifest_events WHERE committee_id=$1 AND file_entry_id=$2 ORDER BY sequence DESC LIMIT 1`,
  [committee.id, fileId])).rows[0];
  if (latest?.kind === 'DELETE' && latest.file_revision === revision) return;
  const allocated = (await client.query<{sequence: string | number}>(`UPDATE committees
    SET next_storage_manifest_sequence=next_storage_manifest_sequence+1,file_manifest_revision=file_manifest_revision+1
    WHERE id=$1 RETURNING next_storage_manifest_sequence-1 AS sequence`, [committee.id])).rows[0]!;
  committee.next_storage_manifest_sequence = Number(allocated.sequence) + 1;
  committee.file_manifest_revision += 1;
  await client.query(`INSERT INTO storage_manifest_events
    (committee_id,sequence,kind,file_entry_id,file_revision,deleted_at)
    VALUES ($1,$2,'DELETE',$3,$4,$5)`, [committee.id, allocated.sequence, fileId, revision, deletedAt]);
  await invalidateManifestMigrations(client, committee);
}

async function invalidateManifestMigrations(client: PoolClient, committee: Stage4CommitteeRow): Promise<void> {
  const migrations = await client.query(`UPDATE storage_migrations SET status='FAILED',ready_at=NULL,revision=revision+1,
    failure_code='MANIFEST_CHANGED',failure_reason='The file manifest changed during review.',updated_at=now()
    WHERE committee_id=$1 AND status IN ('COPYING','READY_TO_CONFIRM') RETURNING id,revision`, [committee.id]);
  for (const migration of migrations.rows) await appendEvent(client, committee, {type: 'storage.migration_failed',
    resourceType: 'storage_migration',resourceId: migration.id,revision: migration.revision,audience: 'CHAIR',
    payload: {status: 'FAILED',failureCode: 'MANIFEST_CHANGED'}});
}
