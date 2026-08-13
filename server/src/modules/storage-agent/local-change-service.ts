import {randomUUID} from 'node:crypto';
import type {PoolClient, QueryResultRow} from 'pg';
import type {StorageAgentLocalChange, StorageAgentLocalChangeResult, StorageAgentTask} from '@quorum/contracts';
import {AppError} from '../../http/errors.js';
import {appendEvent, requireProceedingsActive, type Stage4CommitteeRow, type Stage4Context} from '../stage4/database.js';
import {assertExactBody} from '../stage4/validation.js';
import type {Stage7StorageAgentService} from './service.js';

interface EntryRow extends QueryResultRow {
  id: string; committee_id: string; logical_name: string; status: string; current_version_id: string | null;
  revision: number; created_by_user_id: string;
}

function integer(value: unknown, name: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1)) {
    throw new AppError({code: 'VALIDATION_FAILED', message: `${name} is invalid.`});
  }
  return Number(value);
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError({code: 'VALIDATION_FAILED', message: `${name} is invalid.`});
  }
  return value;
}

function text(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) {
    throw new AppError({code: 'VALIDATION_FAILED', message: `${name} is invalid.`});
  }
  return value.trim();
}

function sha256(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'SHA-256 is invalid.'});
  }
  return value;
}

function change(value: unknown): StorageAgentLocalChange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Local change is invalid.'});
  }
  const input = value as Record<string, unknown>;
  if (input.kind === 'UPSERT') {
    assertExactBody(input, ['kind', 'fileEntryId', 'baseRevision', 'logicalName', 'originalName', 'mediaType', 'sizeBytes', 'sha256']);
    const fileEntryId = input.fileEntryId === undefined ? undefined : uuid(input.fileEntryId, 'File ID');
    const baseRevision = input.baseRevision === undefined ? undefined : integer(input.baseRevision, 'Revision');
    if (Boolean(fileEntryId) !== Boolean(baseRevision)) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Existing file ID and revision must be provided together.'});
    }
    return {kind: 'UPSERT', fileEntryId, baseRevision, logicalName: text(input.logicalName, 'Logical name', 500),
      originalName: text(input.originalName, 'Original name', 500), mediaType: text(input.mediaType, 'Media type', 255),
      sizeBytes: integer(input.sizeBytes, 'File size', true), sha256: sha256(input.sha256)};
  }
  if (input.kind === 'RENAME') {
    assertExactBody(input, ['kind', 'fileEntryId', 'baseRevision', 'logicalName']);
    return {kind: 'RENAME', fileEntryId: uuid(input.fileEntryId, 'File ID'),
      baseRevision: integer(input.baseRevision, 'Revision'), logicalName: text(input.logicalName, 'Logical name', 500)};
  }
  if (input.kind === 'DELETE') {
    assertExactBody(input, ['kind', 'fileEntryId', 'baseRevision']);
    return {kind: 'DELETE', fileEntryId: uuid(input.fileEntryId, 'File ID'),
      baseRevision: integer(input.baseRevision, 'Revision')};
  }
  throw new AppError({code: 'VALIDATION_FAILED', message: 'Local change kind is invalid.'});
}

function task(row: QueryResultRow): StorageAgentTask {
  return {id: row.id, committeeId: row.committee_id, sequence: Number(row.sequence), type: row.task_type,
    fileEntryId: row.file_entry_id, fileRevision: row.file_revision, blobId: row.blob_id,
    expectedSizeBytes: row.expected_size_bytes === null ? null : Number(row.expected_size_bytes),
    expectedSha256: row.expected_sha256_hex, contentState: row.content_state,
    receivedSizeBytes: row.received_size_bytes === null ? null : Number(row.received_size_bytes),
    actualSha256: row.actual_sha256_hex, leaseGeneration: Number(row.lease_generation), status: row.status,
    revision: row.revision, attempts: row.attempts, claimToken: row.claim_token, failureCode: row.failure_code,
    nextAttemptAt: row.next_attempt_at.toISOString(), createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()};
}

async function agentAudit(client: PoolClient, context: Stage4Context, committeeId: string, action: string,
  resourceType: string, resourceId: string, after: unknown): Promise<void> {
  await client.query(`INSERT INTO audit_log
    (id,request_id,committee_id,effective_capabilities,action,resource_type,resource_id,result,after_summary,user_agent_summary)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'SUCCEEDED',$8,$9)`,
  [randomUUID(), context.requestId, committeeId, ['STORAGE_AGENT'], action, resourceType, resourceId, after,
    context.userAgent?.slice(0, 240) ?? null]);
}

export class Stage7LocalChangeService {
  constructor(private readonly agent: Stage7StorageAgentService) {}

  async submit(credential: string, body: unknown, context: Stage4Context): Promise<StorageAgentLocalChangeResult> {
    assertExactBody(body as Record<string, unknown>, ['leaseGeneration', 'requestId', 'manifestSequence', 'change']);
    const input = body as Record<string, unknown>;
    const generation = integer(input.leaseGeneration, 'Lease generation');
    const requestId = uuid(input.requestId, 'Request ID');
    const manifestSequence = integer(input.manifestSequence, 'Manifest sequence', true);
    const local = change(input.change);
    const result = await this.agent.withCurrentLease(credential, generation, async (client, lease, committee) => {
      requireProceedingsActive(committee);
      const replay = await client.query<{result: StorageAgentLocalChangeResult}>(`SELECT result
        FROM storage_agent_change_requests WHERE host_id=$1 AND request_id=$2`, [lease.hostId, requestId]);
      if (replay.rows[0]?.result) return replay.rows[0].result;
      const binding = await client.query<{id: string; storage_host_id: string}>(`SELECT id,storage_host_id
        FROM storage_bindings WHERE committee_id=$1 AND id=$2 AND provider_type='CHAIR_AGENT'
          AND status='ACTIVE' FOR UPDATE`, [committee.id, committee.active_storage_binding_id]);
      if (!binding.rows[0] || binding.rows[0].storage_host_id !== lease.hostId) {
        throw new AppError({code: 'STALE_STORAGE_LEASE', message: 'Storage host lease is no longer current.'});
      }
      const latestManifest = Number(committee.next_storage_manifest_sequence) - 1;
      if (manifestSequence !== latestManifest) {
        return this.conflict(client, lease.hostId, committee, requestId, manifestSequence, local,
          'MANIFEST_STALE', null, context);
      }
      let entry: EntryRow | undefined;
      if (local.fileEntryId) {
        entry = (await client.query<EntryRow>('SELECT * FROM file_entries WHERE id=$1 AND committee_id=$2 FOR UPDATE',
          [local.fileEntryId, committee.id])).rows[0];
        if (!entry || entry.status === 'DELETED'
          || await client.query('SELECT 1 FROM file_tombstones WHERE file_entry_id=$1', [local.fileEntryId])
            .then(result => Boolean(result.rowCount))) {
          return this.conflict(client, lease.hostId, committee, requestId, manifestSequence, local,
            'FILE_DELETED', entry?.revision ?? null, context);
        }
        if (entry.revision !== local.baseRevision) {
          return this.conflict(client, lease.hostId, committee, requestId, manifestSequence, local,
            'REVISION_CONFLICT', entry.revision, context);
        }
      }
      if (local.kind !== 'DELETE') {
        const named = await client.query(`SELECT 1 FROM file_entries WHERE committee_id=$1 AND status<>'DELETED'
          AND lower(logical_name)=lower($2) AND ($3::uuid IS NULL OR id<>$3)`,
        [committee.id, local.logicalName, local.fileEntryId ?? null]);
        if (named.rowCount) return this.conflict(client, lease.hostId, committee, requestId, manifestSequence,
          local, 'NAME_CONFLICT', entry?.revision ?? null, context);
      }
      if (local.kind === 'UPSERT') {
        return this.queueContent(client, lease.hostId, generation, committee, requestId, manifestSequence,
          local, entry, binding.rows[0].id, context);
      }
      if (local.kind === 'RENAME') {
        return this.rename(client, lease.hostId, generation, committee, requestId, manifestSequence, local,
          entry as EntryRow, context);
      }
      return this.delete(client, lease.hostId, generation, committee, requestId, manifestSequence, local,
        entry as EntryRow, context);
    });
    if (result.status === 'CONFLICT') {
      throw new AppError({code: 'CHAIR_DECISION_REQUIRED',
        message: 'This local file change conflicts with the server state.', details: result});
    }
    return result;
  }

  private async queueContent(client: PoolClient, hostId: string, generation: number,
    committee: Stage4CommitteeRow, requestId: string, manifestSequence: number,
    local: Extract<StorageAgentLocalChange, {kind: 'UPSERT'}>, entry: EntryRow | undefined,
    bindingId: string, context: Stage4Context): Promise<StorageAgentLocalChangeResult> {
    const id = randomUUID(); const uploadId = randomUUID(); const taskId = randomUUID(); const blobId = randomUUID();
    const fileEntryId = entry?.id ?? randomUUID(); const compact = uploadId.replaceAll('-', '');
    const stagingKey = `agent-uploads/${compact.slice(0, 2)}/${compact}`;
    const blobCompact = blobId.replaceAll('-', ''); const storageKey = `agent-blobs/${blobCompact.slice(0, 2)}/${blobCompact}`;
    const actor = await client.query<{paired_by_user_id: string}>('SELECT paired_by_user_id FROM storage_hosts WHERE id=$1', [hostId]);
    const allocated = await client.query<{sequence: string | number}>(`UPDATE committees
      SET next_storage_agent_task_sequence=next_storage_agent_task_sequence+1 WHERE id=$1
      RETURNING next_storage_agent_task_sequence-1 AS sequence`, [committee.id]);
    await client.query(`INSERT INTO file_uploads
      (id,committee_id,storage_binding_id,created_by_user_id,logical_name,original_name,media_type,
       expected_size_bytes,expected_sha256,staging_key,status,expires_at,provider_blob_id,provider_storage_key,
       agent_commit_state,agent_task_id,agent_host_id,agent_lease_generation)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,decode($9,'hex'),$10,'CREATED',now()+interval '30 days',$11,$12,
        'PENDING_HOST_COMMIT',$13,$14,$15)`,
    [uploadId, committee.id, bindingId, actor.rows[0]?.paired_by_user_id, local.logicalName, local.originalName,
      local.mediaType.toLowerCase(), local.sizeBytes, local.sha256, stagingKey, blobId, storageKey,
      taskId, hostId, generation]);
    await client.query(`INSERT INTO storage_agent_tasks
      (id,committee_id,host_id,lease_generation,sequence,task_type,file_entry_id,file_revision,blob_id,
       expected_size_bytes,expected_sha256,content_staging_key,source_upload_id)
      VALUES ($1,$2,$3,$4,$5,'UPLOAD_BLOB',$6,$7,$8,$9,decode($10,'hex'),$11,$12)`,
    [taskId, committee.id, hostId, generation, allocated.rows[0]?.sequence, fileEntryId,
      entry ? entry.revision + 1 : 1, blobId, local.sizeBytes, local.sha256, stagingKey, uploadId]);
    const inserted = await client.query(`INSERT INTO storage_agent_change_requests
      (id,committee_id,host_id,lease_generation,request_id,manifest_sequence,kind,file_entry_id,base_revision,
       logical_name,original_name,media_type,size_bytes,sha256,upload_id,task_id,status)
      VALUES ($1,$2,$3,$4,$5,$6,'UPSERT',$7,$8,$9,$10,$11,$12,decode($13,'hex'),$14,$15,'PENDING_CONTENT')
      RETURNING id`, [id, committee.id, hostId, generation, requestId, manifestSequence, local.fileEntryId ?? null,
      local.baseRevision ?? null, local.logicalName, local.originalName, local.mediaType.toLowerCase(), local.sizeBytes,
      local.sha256, uploadId, taskId]);
    const storedTask = await client.query(`SELECT *,encode(expected_sha256,'hex') AS expected_sha256_hex,
      encode(actual_sha256,'hex') AS actual_sha256_hex FROM storage_agent_tasks WHERE id=$1`, [taskId]);
    const result: StorageAgentLocalChangeResult = {status: 'PENDING_CONTENT',
      changeRequestId: inserted.rows[0].id, task: task(storedTask.rows[0])};
    await client.query('UPDATE storage_agent_change_requests SET result=$2 WHERE id=$1', [id, result]);
    await agentAudit(client, context, committee.id, 'storage.agent_local_change_applied',
      'storage_agent_change', id, {status: 'PENDING_CONTENT', taskId});
    return result;
  }

  private async rename(client: PoolClient, hostId: string, generation: number, committee: Stage4CommitteeRow,
    requestId: string, manifestSequence: number, local: Extract<StorageAgentLocalChange, {kind: 'RENAME'}>,
    entry: EntryRow, context: Stage4Context): Promise<StorageAgentLocalChangeResult> {
    const id = randomUUID();
    const updated = await client.query<{revision: number}>(`UPDATE file_entries SET logical_name=$2,
      revision=revision+1,updated_at=now() WHERE id=$1 RETURNING revision`, [entry.id, local.logicalName]);
    const version = await client.query<{id: string; blob_id: string; original_name: string; media_type: string;
      size_bytes: string | number; sha256: Buffer; created_at: Date}>(`SELECT id,blob_id,original_name,media_type,
      size_bytes,sha256,created_at FROM file_versions WHERE id=$1`, [entry.current_version_id]);
    const sequence = Number(committee.next_storage_manifest_sequence);
    await client.query('UPDATE committees SET next_storage_manifest_sequence=next_storage_manifest_sequence+1 WHERE id=$1', [committee.id]);
    committee.next_storage_manifest_sequence = sequence + 1;
    const current = version.rows[0]!;
    await client.query(`INSERT INTO storage_manifest_events
      (committee_id,sequence,kind,file_entry_id,file_revision,version_id,blob_id,logical_name,original_name,
       media_type,size_bytes,sha256,created_at) VALUES ($1,$2,'UPSERT',$3,$4,$5,$6,$7,$8,$9,$10,$11,now())`,
    [committee.id, sequence, entry.id, updated.rows[0]?.revision, current.id, current.blob_id, local.logicalName,
      current.original_name, current.media_type, current.size_bytes, current.sha256]);
    await client.query('UPDATE committees SET file_manifest_revision=file_manifest_revision+1 WHERE id=$1',
      [committee.id]);
    const result: StorageAgentLocalChangeResult = {status: 'COMPLETED', changeRequestId: id,
      fileEntryId: entry.id, fileRevision: updated.rows[0]?.revision as number};
    await client.query(`INSERT INTO storage_agent_change_requests
      (id,committee_id,host_id,lease_generation,request_id,manifest_sequence,kind,file_entry_id,base_revision,
       logical_name,status,result,completed_at) VALUES ($1,$2,$3,$4,$5,$6,'RENAME',$7,$8,$9,'COMPLETED',$10,now())`,
    [id, committee.id, hostId, generation, requestId, manifestSequence, entry.id, local.baseRevision,
      local.logicalName, result]);
    await appendEvent(client, committee, {type: 'file.sync_state_changed', resourceType: 'file_entry',
      resourceId: entry.id, revision: result.fileRevision, payload: {status: 'SYNCED', renamed: true}});
    await agentAudit(client, context, committee.id, 'storage.agent_local_change_applied',
      'file_entry', entry.id, {kind: 'RENAME', revision: result.fileRevision});
    return result;
  }

  private async delete(client: PoolClient, hostId: string, generation: number, committee: Stage4CommitteeRow,
    requestId: string, manifestSequence: number, local: Extract<StorageAgentLocalChange, {kind: 'DELETE'}>,
    entry: EntryRow, context: Stage4Context): Promise<StorageAgentLocalChangeResult> {
    const id = randomUUID(); const tombstoneId = randomUUID();
    const actor = await client.query<{paired_by_user_id: string}>('SELECT paired_by_user_id FROM storage_hosts WHERE id=$1', [hostId]);
    const deleted = await client.query<{revision: number; deleted_at: Date}>(`UPDATE file_entries SET status='DELETED',
      current_version_id=NULL,revision=revision+1,updated_at=now(),deleted_at=now() WHERE id=$1
      RETURNING revision,deleted_at`, [entry.id]);
    await client.query(`INSERT INTO file_tombstones
      (id,committee_id,file_entry_id,last_content_revision,deleted_by_user_id,deleted_at)
      VALUES ($1,$2,$3,$4,$5,$6)`, [tombstoneId, committee.id, entry.id, entry.revision,
      actor.rows[0]?.paired_by_user_id, deleted.rows[0]?.deleted_at]);
    const blobs = await client.query<{blob_id: string}>('SELECT blob_id FROM file_versions WHERE file_entry_id=$1', [entry.id]);
    const ids = blobs.rows.map(row => row.blob_id);
    await client.query(`UPDATE file_blobs SET durability_state='DELETE_PENDING',updated_at=now()
      WHERE id=ANY($1::uuid[]) AND durability_state='COMMITTED'`, [ids]);
    for (const blob of ids) await client.query(`INSERT INTO file_blob_delete_jobs
      (id,committee_id,file_entry_id,blob_id) VALUES ($1,$2,$3,$4) ON CONFLICT (blob_id) DO NOTHING`,
    [randomUUID(), committee.id, entry.id, blob]);
    await client.query('UPDATE committees SET file_manifest_revision=file_manifest_revision+1 WHERE id=$1', [committee.id]);
    const result: StorageAgentLocalChangeResult = {status: 'COMPLETED', changeRequestId: id,
      fileEntryId: entry.id, fileRevision: deleted.rows[0]?.revision as number};
    await client.query(`INSERT INTO storage_agent_change_requests
      (id,committee_id,host_id,lease_generation,request_id,manifest_sequence,kind,file_entry_id,base_revision,
       status,result,completed_at) VALUES ($1,$2,$3,$4,$5,$6,'DELETE',$7,$8,'COMPLETED',$9,now())`,
    [id, committee.id, hostId, generation, requestId, manifestSequence, entry.id, local.baseRevision, result]);
    await appendEvent(client, committee, {type: 'file.deleted', resourceType: 'file_entry', resourceId: entry.id,
      revision: result.fileRevision, payload: {status: 'DELETED'}});
    await agentAudit(client, context, committee.id, 'storage.agent_local_change_applied',
      'file_entry', entry.id, {kind: 'DELETE', revision: result.fileRevision});
    return result;
  }

  private async conflict(client: PoolClient, hostId: string, committee: Stage4CommitteeRow,
    requestId: string, manifestSequence: number, local: StorageAgentLocalChange,
    reasonCode: Extract<StorageAgentLocalChangeResult, {status: 'CONFLICT'}>['reasonCode'],
    serverRevision: number | null, context: Stage4Context): Promise<StorageAgentLocalChangeResult> {
    const id = randomUUID(); const conflictId = randomUUID();
    const result: StorageAgentLocalChangeResult = {status: 'CONFLICT', changeRequestId: id, conflictId, reasonCode};
    await client.query(`INSERT INTO storage_agent_change_requests
      (id,committee_id,host_id,lease_generation,request_id,manifest_sequence,kind,file_entry_id,base_revision,
       logical_name,original_name,media_type,size_bytes,sha256,status,result,completed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
        CASE WHEN $14::text IS NULL THEN NULL ELSE decode($14,'hex') END,'CONFLICT',$15,now())`,
    [id, committee.id, hostId, Number(committee.storage_lease_generation), requestId, manifestSequence, local.kind,
      local.fileEntryId ?? null, local.baseRevision ?? null, local.kind === 'DELETE' ? null : local.logicalName,
      local.kind === 'UPSERT' ? local.originalName : null, local.kind === 'UPSERT' ? local.mediaType : null,
      local.kind === 'UPSERT' ? local.sizeBytes : null, local.kind === 'UPSERT' ? local.sha256 : null, result]);
    await client.query(`INSERT INTO storage_agent_conflicts
      (id,committee_id,host_id,change_request_id,file_entry_id,server_revision,local_base_revision,reason_code)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [conflictId, committee.id, hostId, id, local.fileEntryId ?? null,
      serverRevision, local.baseRevision ?? null, reasonCode]);
    await appendEvent(client, committee, {type: 'storage_agent.conflict_created', resourceType: 'storage_agent_conflict',
      resourceId: conflictId, revision: 1, audience: 'CHAIR', payload: {reasonCode}});
    await agentAudit(client, context, committee.id, 'storage.agent_conflict_created',
      'storage_agent_conflict', conflictId, {reasonCode});
    return result;
  }
}
