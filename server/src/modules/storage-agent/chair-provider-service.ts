import {randomUUID} from 'node:crypto';
import type {Pool, PoolClient, QueryResultRow} from 'pg';
import type {FileEntry, FileUpload, PendingHostCommit} from '@quorum/contracts';
import {AppError} from '../../http/errors.js';
import type {AuthenticatedSession, IdentityUser} from '../identity/store.js';
import {appendEvent, audit, idempotentTransaction, isChair, lockedCommittee, requireBusinessIdentity,
  requireProceedingsActive, type Stage4CommitteeRow, type Stage4Context} from '../stage4/database.js';
import {assertExactBody} from '../stage4/validation.js';
import type {Stage6StorageService} from '../storage/service.js';
import type {StorageAgentTaskCompletionFinalizer} from './task-service.js';

interface AgentUploadRow extends QueryResultRow {
  id: string; committee_id: string; storage_binding_id: string; created_by_user_id: string;
  logical_name: string; original_name: string; media_type: string;
  expected_size_bytes: string | number; received_size_bytes: string | number;
  expected_sha256_hex: string; actual_sha256_hex: string | null; staging_key: string;
  status: FileUpload['status']; revision: number; expires_at: Date; failure_code: string | null;
  provider_blob_id: string | null; provider_storage_key: string | null;
  committed_file_entry_id: string | null; agent_commit_state: FileUpload['agentCommitState'];
  agent_task_id: string | null; agent_host_id: string | null; agent_lease_generation: string | number | null;
  created_at: Date; updated_at: Date;
}

interface UserRow extends QueryResultRow {
  id: string; email: string; display_name: string; status: IdentityUser['status']; is_system_admin: boolean;
  session_version: number; must_change_password: boolean; created_at: Date; disabled_at: Date | null;
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError({code: 'VALIDATION_FAILED', message: `${name} is invalid.`});
  }
  return value;
}

function agentBlobKey(blobId: string): string {
  const compact = uuid(blobId, 'Blob ID').replaceAll('-', '').toLowerCase();
  return `agent-blobs/${compact.slice(0, 2)}/${compact}`;
}

function upload(row: AgentUploadRow): FileUpload {
  return {id: row.id, committeeId: row.committee_id, storageBindingId: row.storage_binding_id,
    logicalName: row.logical_name, originalName: row.original_name, mediaType: row.media_type,
    expectedSizeBytes: Number(row.expected_size_bytes), receivedSizeBytes: Number(row.received_size_bytes),
    expectedSha256: row.expected_sha256_hex, actualSha256: row.actual_sha256_hex, status: row.status,
    revision: row.revision, expiresAt: row.expires_at.toISOString(), failureCode: row.failure_code,
    committedFileEntryId: row.committed_file_entry_id, agentCommitState: row.agent_commit_state,
    agentTaskId: row.agent_task_id, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString()};
}

function authFrom(row: UserRow): AuthenticatedSession {
  return {sessionId: 'storage-agent', user: {id: row.id, email: row.email, displayName: row.display_name,
    status: row.status, isSystemAdmin: row.is_system_admin, sessionVersion: row.session_version,
    mustChangePassword: row.must_change_password, createdAt: row.created_at.toISOString(),
    disabledAt: row.disabled_at?.toISOString() ?? null}};
}

async function uploadForUpdate(client: PoolClient, id: string): Promise<AgentUploadRow> {
  const result = await client.query<AgentUploadRow>(`SELECT *,encode(expected_sha256,'hex') AS expected_sha256_hex,
    CASE WHEN actual_sha256 IS NULL THEN NULL ELSE encode(actual_sha256,'hex') END AS actual_sha256_hex
    FROM file_uploads WHERE id=$1 FOR UPDATE`, [id]);
  if (!result.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Upload not found.'});
  return result.rows[0];
}

export class Stage7ChairAgentProviderService implements StorageAgentTaskCompletionFinalizer {
  constructor(private readonly pool: Pool, private readonly metadata: Stage6StorageService) {}

  async queueUpload(auth: AuthenticatedSession, uploadId: string, body: unknown,
    idempotencyKey: string, context: Stage4Context): Promise<PendingHostCommit> {
    requireBusinessIdentity(auth); assertExactBody(body as Record<string, unknown>, []);
    const id = uuid(uploadId, 'Upload ID');
    return idempotentTransaction({pool: this.pool, auth, route: `/api/v1/file-uploads/${id}/commit`,
      key: idempotencyKey, request: body, status: 202, work: async client => {
        const current = await uploadForUpdate(client, id);
        const committee = await lockedCommittee(client, current.committee_id);
        requireProceedingsActive(committee);
        if (current.created_by_user_id !== auth.user.id) {
          throw new AppError({code: 'FORBIDDEN', message: 'Only the upload creator may commit it.'});
        }
        if (current.status !== 'STAGED' || current.actual_sha256_hex !== current.expected_sha256_hex
          || Number(current.received_size_bytes) !== Number(current.expected_size_bytes)) {
          throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Upload is not ready for host commit.'});
        }
        if (current.agent_commit_state === 'PENDING_HOST_COMMIT' && current.agent_task_id
          && current.agent_lease_generation !== null) {
          return {kind: 'PENDING_HOST_COMMIT', upload: upload(current), taskId: current.agent_task_id,
            leaseGeneration: Number(current.agent_lease_generation)};
        }
        if (current.agent_commit_state !== null) {
          throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Upload host commit is already terminal.'});
        }
        const binding = await client.query<{storage_host_id: string; provider_type: string; status: string}>(`SELECT
          storage_host_id,provider_type,status FROM storage_bindings WHERE id=$1 AND committee_id=$2 FOR UPDATE`,
        [current.storage_binding_id, committee.id]);
        const target = binding.rows[0];
        if (!target || target.provider_type !== 'CHAIR_AGENT' || target.status !== 'ACTIVE'
          || committee.active_storage_binding_id !== current.storage_binding_id) {
          throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Chair Agent storage is not active.'});
        }
        const host = await client.query<{id: string; lease_generation: string | number; status: string}>(`SELECT
          id,lease_generation,status FROM storage_hosts WHERE id=$1 AND committee_id=$2 FOR UPDATE`,
        [target.storage_host_id, committee.id]);
        const active = host.rows[0];
        if (!active || !['ACTIVE', 'DEGRADED'].includes(active.status)
          || Number(active.lease_generation) !== Number(committee.storage_lease_generation)) {
          throw new AppError({code: 'SERVICE_NOT_READY', message: 'The current storage host is unavailable.'});
        }
        const taskId = randomUUID(); const blobId = current.provider_blob_id ?? randomUUID();
        const fileEntryId = randomUUID(); const storageKey = current.provider_storage_key ?? agentBlobKey(blobId);
        const allocated = await client.query<{sequence: string | number}>(`UPDATE committees
          SET next_storage_agent_task_sequence=next_storage_agent_task_sequence+1 WHERE id=$1
          RETURNING next_storage_agent_task_sequence-1 AS sequence`, [committee.id]);
        const updated = await client.query<AgentUploadRow>(`UPDATE file_uploads SET provider_blob_id=$2,
          provider_storage_key=$3,agent_commit_state='PENDING_HOST_COMMIT',agent_task_id=$4,
          agent_host_id=$5,agent_lease_generation=$6,revision=revision+1,updated_at=now() WHERE id=$1
          RETURNING *,encode(expected_sha256,'hex') AS expected_sha256_hex,
            encode(actual_sha256,'hex') AS actual_sha256_hex`,
        [current.id, blobId, storageKey, taskId, active.id, active.lease_generation]);
        await client.query(`INSERT INTO storage_agent_tasks
          (id,committee_id,host_id,lease_generation,sequence,task_type,file_entry_id,file_revision,blob_id,
           expected_size_bytes,expected_sha256,source_upload_id)
          VALUES ($1,$2,$3,$4,$5,'STORE_BLOB',$6,1,$7,$8,decode($9,'hex'),$10)`,
        [taskId, committee.id, active.id, active.lease_generation, allocated.rows[0]?.sequence, fileEntryId,
          blobId, current.expected_size_bytes, current.expected_sha256_hex, current.id]);
        const row = updated.rows[0] as AgentUploadRow;
        await appendEvent(client, committee, {type: 'file.upload_host_pending', resourceType: 'file_upload',
          resourceId: current.id, revision: row.revision, audience: 'CHAIR',
          payload: {status: 'PENDING_HOST_COMMIT', taskId}});
        await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
          capabilities: await isChair(client, committee.id, auth.user.id) ? ['CHAIR'] : ['MEMBER'],
          action: 'storage.upload_host_pending', resourceType: 'file_upload', resourceId: current.id,
          before: {status: 'STAGED', revision: current.revision},
          after: {status: 'PENDING_HOST_COMMIT', revision: row.revision, taskId}});
        return {kind: 'PENDING_HOST_COMMIT', upload: upload(row), taskId,
          leaseGeneration: Number(active.lease_generation)};
      }});
  }

  async finalize(client: PoolClient, task: Parameters<StorageAgentTaskCompletionFinalizer['finalize']>[1],
    committee: Stage4CommitteeRow, context: Stage4Context): Promise<void> {
    if (task.resolutionConflictId) return;
    if (task.type === 'DELETE_FILE') {
      const binding = await client.query<{id: string}>(`SELECT id FROM storage_bindings WHERE committee_id=$1
        AND storage_host_id=$2 AND provider_type='CHAIR_AGENT' AND status='ACTIVE' FOR UPDATE`,
      [committee.id, task.hostId]);
      if (!binding.rows[0] || committee.active_storage_binding_id !== binding.rows[0].id) {
        throw new AppError({code: 'STALE_STORAGE_LEASE', message: 'Storage host lease is no longer current.'});
      }
      const blobs = await client.query<{id: string}>(`UPDATE file_blobs blob SET durability_state='DELETED',updated_at=now()
        WHERE blob.storage_binding_id=$2 AND blob.durability_state='DELETE_PENDING' AND (
          EXISTS (SELECT 1 FROM file_versions version WHERE version.file_entry_id=$1 AND version.blob_id=blob.id)
          OR EXISTS (SELECT 1 FROM file_blob_copies copy JOIN file_versions version
            ON version.blob_id=copy.content_blob_id WHERE version.file_entry_id=$1 AND copy.copy_blob_id=blob.id)
        ) RETURNING blob.id`,
      [task.fileEntryId, binding.rows[0].id]);
      if (blobs.rows.length) await client.query(`UPDATE file_blob_delete_jobs SET status='COMPLETED',completed_at=now(),
        claimed_at=NULL,claim_token=NULL,failure_code=NULL,failure_reason=NULL,updated_at=now()
        WHERE blob_id=ANY($1::uuid[]) AND status<>'COMPLETED'`, [blobs.rows.map(row => row.id)]);
      return;
    }
    if (task.type === 'STORE_BLOB' && !task.sourceUploadId) {
      const binding = await client.query<{id: string}>(`SELECT id FROM storage_bindings WHERE committee_id=$1
        AND storage_host_id=$2 AND provider_type='CHAIR_AGENT' AND status='ACTIVE' FOR UPDATE`,
      [committee.id, task.hostId]);
      if (!binding.rows[0] || committee.active_storage_binding_id !== binding.rows[0].id) {
        return;
      }
      const synced = await client.query<{revision: number}>(`UPDATE file_entries SET sync_state='SYNCED',updated_at=now()
        WHERE id=$1 AND committee_id=$2 AND revision=$3 AND status<>'DELETED' AND sync_state<>'SYNCED'
        RETURNING revision`, [task.fileEntryId, committee.id, task.fileRevision]);
      if (synced.rows[0]) {
        await appendEvent(client, committee, {type: 'file.sync_state_changed', resourceType: 'file_entry',
          resourceId: task.fileEntryId, revision: synced.rows[0].revision, audience: 'MEMBER',
          payload: {status: 'SYNCED'}});
      }
      return;
    }
    if (!task.sourceUploadId || !task.blobId || task.expectedSizeBytes === null || !task.expectedSha256) return;
    let current = await uploadForUpdate(client, task.sourceUploadId);
    if (current.status === 'COMMITTED' && current.agent_commit_state === 'HOST_COMMITTED') return;
    if (current.status === 'CREATED' && task.type === 'UPLOAD_BLOB') {
      const staged = await client.query<AgentUploadRow>(`UPDATE file_uploads SET status='STAGED',
        receiving_started_at=now(),staged_at=now(),received_size_bytes=$2,actual_sha256=decode($3,'hex'),
        revision=revision+1,updated_at=now() WHERE id=$1
        RETURNING *,encode(expected_sha256,'hex') AS expected_sha256_hex,
          encode(actual_sha256,'hex') AS actual_sha256_hex`,
      [current.id, task.expectedSizeBytes, task.expectedSha256]);
      current = staged.rows[0] as AgentUploadRow;
    }
    if (current.status !== 'STAGED' || current.agent_commit_state !== 'PENDING_HOST_COMMIT'
      || current.agent_task_id !== task.id || current.agent_host_id !== task.hostId
      || Number(current.agent_lease_generation) !== task.leaseGeneration
      || current.provider_blob_id !== task.blobId || Number(current.expected_size_bytes) !== task.expectedSizeBytes
      || current.expected_sha256_hex !== task.expectedSha256 || current.actual_sha256_hex !== task.expectedSha256) {
      throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Host commit no longer matches its upload.'});
    }
    const binding = await client.query<{provider_type: string; storage_host_id: string; status: string}>(`SELECT
      provider_type,storage_host_id,status FROM storage_bindings WHERE id=$1 FOR UPDATE`, [current.storage_binding_id]);
    if (binding.rows[0]?.provider_type !== 'CHAIR_AGENT' || binding.rows[0]?.status !== 'ACTIVE'
      || binding.rows[0]?.storage_host_id !== task.hostId
      || committee.active_storage_binding_id !== current.storage_binding_id) {
      throw new AppError({code: 'STALE_STORAGE_LEASE', message: 'Storage host lease is no longer current.'});
    }
    const user = await client.query<UserRow>('SELECT * FROM users WHERE id=$1 AND status=$2',
      [current.created_by_user_id, 'ACTIVE']);
    if (!user.rows[0]) throw new AppError({code: 'FORBIDDEN', message: 'Upload creator is no longer active.'});
    const actor = authFrom(user.rows[0]);
    const file = await this.metadata.recordProviderCommitInTransaction(client, actor, committee.id, {
      bindingId: current.storage_binding_id, blobId: task.blobId,
      targetFileEntryId: task.fileRevision === 1 ? task.fileEntryId : undefined,
      fileEntryId: task.fileRevision > 1 ? task.fileEntryId : undefined,
      baseRevision: task.fileRevision > 1 ? task.fileRevision - 1 : undefined,
      logicalName: current.logical_name, originalName: current.original_name, mediaType: current.media_type,
      sizeBytes: task.expectedSizeBytes, sha256: task.expectedSha256,
      storageKey: current.provider_storage_key as string
    }, context);
    const refreshed = await client.query<{next_event_sequence: string | number}>(
      'SELECT next_event_sequence FROM committees WHERE id=$1', [committee.id]);
    committee.next_event_sequence = Number(refreshed.rows[0]?.next_event_sequence ?? committee.next_event_sequence);
    const committed = await client.query<{revision: number}>(`UPDATE file_uploads SET status='COMMITTED',
      agent_commit_state='HOST_COMMITTED',committed_at=now(),committed_blob_id=$2,
      committed_file_entry_id=$3,committed_file_version_id=$4,revision=revision+1,updated_at=now()
      WHERE id=$1 RETURNING revision`, [current.id, task.blobId, file.id, file.currentVersion.id]);
    const revision = committed.rows[0]?.revision ?? current.revision + 1;
    await client.query(`UPDATE storage_agent_change_requests SET status='COMPLETED',completed_at=now(),
      result=jsonb_build_object('status','COMPLETED','changeRequestId',id,'fileEntryId',$2::text,
        'fileRevision',$3::integer) WHERE task_id=$1 AND status='PENDING_CONTENT'`,
    [task.id, file.id, file.revision]);
    await appendEvent(client, committee, {type: 'file.upload_committed', resourceType: 'file_upload',
      resourceId: current.id, revision, payload: {status: 'COMMITTED', fileEntryId: file.id,
        versionId: file.currentVersion.id}});
    await audit(client, context, {committeeId: committee.id, actorUserId: actor.user.id,
      capabilities: ['STORAGE_AGENT'], action: 'storage.upload_host_committed', resourceType: 'file_upload',
      resourceId: current.id, before: {status: 'PENDING_HOST_COMMIT', revision: current.revision},
      after: {status: 'COMMITTED', revision, fileEntryId: file.id, versionId: file.currentVersion.id}});
  }
}
