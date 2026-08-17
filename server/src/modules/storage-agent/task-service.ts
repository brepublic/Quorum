import {randomUUID} from 'node:crypto';
import type {PoolClient, QueryResultRow} from 'pg';
import type {
  StorageAgentTask,
  StorageAgentTaskPage,
  StorageManifestEvent,
  StorageManifestPage
} from '@quorum/contracts';
import {AppError} from '../../http/errors.js';
import {appendEvent, type Stage4CommitteeRow, type Stage4Context} from '../stage4/database.js';
import {assertExactBody} from '../stage4/validation.js';
import type {StorageCapacityGuard} from '../storage/capacity.js';
import type {Stage6FileService} from '../storage/file-service.js';
import {DurableStagingStore, UploadStreamError} from '../storage/staging.js';
import type {CurrentStorageAgentLease, Stage7StorageAgentService} from './service.js';

interface ManifestRow extends QueryResultRow {
  sequence: string | number;
  kind: 'UPSERT' | 'DELETE';
  file_entry_id: string;
  file_revision: number;
  version_id: string | null;
  blob_id: string | null;
  logical_name: string | null;
  original_name: string | null;
  media_type: string | null;
  size_bytes: string | number | null;
  sha256_hex: string | null;
  deleted_at: Date | null;
  created_at: Date;
}

interface TaskRow extends QueryResultRow {
  id: string;
  committee_id: string;
  host_id: string;
  lease_generation: string | number;
  sequence: string | number;
  task_type: StorageAgentTask['type'];
  file_entry_id: string;
  file_revision: number;
  blob_id: string | null;
  expected_size_bytes: string | number | null;
  expected_sha256_hex: string | null;
  content_staging_key: string | null;
  source_upload_id: string | null;
  content_state: 'NONE' | 'RECEIVING' | 'STAGED';
  received_size_bytes: string | number | null;
  actual_sha256_hex: string | null;
  status: StorageAgentTask['status'];
  revision: number;
  attempts: number;
  next_attempt_at: Date;
  claimed_at: Date | null;
  claim_request_id: string | null;
  claim_token: string | null;
  terminal_request_id: string | null;
  terminal_outcome: 'COMPLETED' | 'FAILED' | null;
  failure_code: string | null;
  resolution_conflict_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AgentBlobDestination {
  start(metadata: {sizeBytes: number; sha256: string}): void;
  write(chunk: Buffer): Promise<void>;
}

export interface StorageAgentTaskCompletionFinalizer {
  finalize(client: PoolClient, task: {
    id: string; committeeId: string; hostId: string; leaseGeneration: number;
    type: StorageAgentTask['type']; fileEntryId: string; fileRevision: number;
    blobId: string | null; expectedSizeBytes: number | null; expectedSha256: string | null;
    contentStagingKey: string | null; sourceUploadId: string | null; resolutionConflictId: string | null;
  }, committee: Stage4CommitteeRow, context: Stage4Context): Promise<void>;
}

const TASK_SELECT = `SELECT *,encode(expected_sha256,'hex') AS expected_sha256_hex,
  encode(actual_sha256,'hex') AS actual_sha256_hex
  FROM storage_agent_tasks`;

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new AppError({code: 'VALIDATION_FAILED', message: `${name} is invalid.`});
  }
  return Number(value);
}

function cursor(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Cursor is invalid.'});
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

function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'SHA-256 is invalid.'});
  }
  return value;
}

function failureCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(value)) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Failure code is invalid.'});
  }
  return value;
}

function failureReason(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 240) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Failure reason is invalid.'});
  }
  return value.trim();
}

function task(row: TaskRow): StorageAgentTask {
  return {
    id: row.id,
    committeeId: row.committee_id,
    sequence: Number(row.sequence),
    type: row.task_type,
    fileEntryId: row.file_entry_id,
    fileRevision: row.file_revision,
    blobId: row.blob_id,
    expectedSizeBytes: row.expected_size_bytes === null ? null : Number(row.expected_size_bytes),
    expectedSha256: row.expected_sha256_hex,
    contentState: row.content_state,
    receivedSizeBytes: row.received_size_bytes === null ? null : Number(row.received_size_bytes),
    actualSha256: row.actual_sha256_hex,
    leaseGeneration: Number(row.lease_generation),
    status: row.status,
    revision: row.revision,
    attempts: row.attempts,
    claimToken: row.claim_token,
    failureCode: row.failure_code,
    resolutionConflictId: row.resolution_conflict_id,
    nextAttemptAt: row.next_attempt_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function manifestEvent(row: ManifestRow): StorageManifestEvent {
  if (row.kind === 'DELETE') {
    return {sequence: Number(row.sequence), kind: 'DELETE', fileEntryId: row.file_entry_id,
      fileRevision: row.file_revision, deletedAt: (row.deleted_at as Date).toISOString(),
      createdAt: row.created_at.toISOString()};
  }
  return {sequence: Number(row.sequence), kind: 'UPSERT', fileEntryId: row.file_entry_id,
    fileRevision: row.file_revision, versionId: row.version_id as string, blobId: row.blob_id as string,
    logicalName: row.logical_name as string, originalName: row.original_name as string,
    mediaType: row.media_type as string, sizeBytes: Number(row.size_bytes), sha256: row.sha256_hex as string,
    createdAt: row.created_at.toISOString()};
}

async function agentAudit(client: PoolClient, context: Stage4Context, input: {
  committeeId: string; action: string; taskId: string; before?: unknown; after?: unknown;
}): Promise<void> {
  await client.query(`INSERT INTO audit_log
    (id,request_id,committee_id,actor_user_id,effective_capabilities,action,resource_type,resource_id,
     result,before_summary,after_summary,user_agent_summary)
    VALUES ($1,$2,$3,NULL,$4,$5,'storage_agent_task',$6,'SUCCEEDED',$7,$8,$9)`,
  [randomUUID(), context.requestId, input.committeeId, ['STORAGE_AGENT'], input.action, input.taskId,
    input.before ?? null, input.after ?? null, context.userAgent?.slice(0, 240) ?? null]);
}

function requireOwnedTask(row: TaskRow | undefined, lease: CurrentStorageAgentLease): TaskRow {
  if (!row) throw new AppError({code: 'NOT_FOUND', message: 'Storage Agent task not found.'});
  if (row.host_id !== lease.hostId || Number(row.lease_generation) !== lease.leaseGeneration) {
    throw new AppError({code: 'STALE_STORAGE_LEASE', message: 'Storage host lease is no longer current.'});
  }
  return row;
}

function requireClaim(row: TaskRow, claimToken: string): void {
  if (row.status !== 'IN_PROGRESS' || row.claim_token !== claimToken) {
    throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Storage Agent task is not held by this claim.'});
  }
}

export class Stage7StorageTaskService {
  constructor(
    private readonly agent: Stage7StorageAgentService,
    private readonly staging: DurableStagingStore,
    private readonly files: Stage6FileService,
    private readonly capacity?: StorageCapacityGuard,
    private readonly finalizer?: StorageAgentTaskCompletionFinalizer
  ) {}

  async manifest(credential: string, leaseGeneration: number, after = 0, limit = 100): Promise<StorageManifestPage> {
    const requestedGeneration = positiveInteger(leaseGeneration, 'Lease generation');
    const from = cursor(after); const pageSize = Math.min(200, positiveInteger(limit, 'Limit'));
    return this.agent.withCurrentLease(credential, requestedGeneration, async (client, lease) => {
      const result = await client.query<ManifestRow>(`SELECT *,encode(sha256,'hex') AS sha256_hex
        FROM storage_manifest_events WHERE committee_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3`,
      [lease.committeeId, from, pageSize + 1]);
      const rows = result.rows.slice(0, pageSize);
      return {events: rows.map(manifestEvent), nextSequence: Number(rows.at(-1)?.sequence ?? from),
        hasMore: result.rows.length > pageSize};
    });
  }

  async tasks(credential: string, leaseGeneration: number, after = 0, limit = 100): Promise<StorageAgentTaskPage> {
    const requestedGeneration = positiveInteger(leaseGeneration, 'Lease generation');
    const from = cursor(after); const pageSize = Math.min(200, positiveInteger(limit, 'Limit'));
    return this.agent.withCurrentLease(credential, requestedGeneration, async (client, lease) => {
      const result = await client.query<TaskRow>(`${TASK_SELECT} WHERE committee_id=$1 AND host_id=$2
        AND lease_generation=$3 AND sequence>$4 ORDER BY sequence LIMIT $5`,
      [lease.committeeId, lease.hostId, lease.leaseGeneration, from, pageSize + 1]);
      const rows = result.rows.slice(0, pageSize);
      return {tasks: rows.map(task), nextSequence: Number(rows.at(-1)?.sequence ?? from),
        hasMore: result.rows.length > pageSize};
    });
  }

  async claim(credential: string, taskId: string, body: unknown): Promise<StorageAgentTask> {
    assertExactBody(body as Record<string, unknown>, ['leaseGeneration', 'fileRevision', 'requestId']);
    const request = body as {leaseGeneration?: unknown; fileRevision?: unknown; requestId?: unknown};
    const generation = positiveInteger(request.leaseGeneration, 'Lease generation');
    const fileRevision = positiveInteger(request.fileRevision, 'File revision');
    const requestId = uuid(request.requestId, 'Request ID');
    const id = uuid(taskId, 'Task ID');
    return this.agent.withCurrentLease(credential, generation, async (client, lease) => {
      const row = requireOwnedTask((await client.query<TaskRow>(`${TASK_SELECT} WHERE id=$1 FOR UPDATE`, [id])).rows[0], lease);
      if (row.file_revision !== fileRevision) {
        throw new AppError({code: 'REVISION_CONFLICT', message: 'Storage Agent task revision is stale.'});
      }
      if (row.status === 'IN_PROGRESS' && row.claim_request_id === requestId) return task(row);
      if (row.status === 'IN_PROGRESS' && row.claimed_at
        && row.claimed_at > new Date(Date.now() - 5 * 60_000)) {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Storage Agent task is already claimed.'});
      }
      if (!['PENDING', 'RETRY', 'IN_PROGRESS'].includes(row.status)
        || (row.status === 'RETRY' && row.next_attempt_at > new Date())) {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Storage Agent task cannot be claimed.'});
      }
      const updated = await client.query<TaskRow>(`UPDATE storage_agent_tasks SET status='IN_PROGRESS',
        revision=revision+1,attempts=attempts+1,claimed_at=now(),claim_request_id=$2,claim_token=$3,
        failure_code=NULL,failure_reason=NULL,updated_at=now() WHERE id=$1
        RETURNING *,encode(expected_sha256,'hex') AS expected_sha256_hex,
          encode(actual_sha256,'hex') AS actual_sha256_hex`, [row.id, requestId, randomUUID()]);
      return task(updated.rows[0] as TaskRow);
    });
  }

  async receiveContent(credential: string, input: {
    taskId: string; leaseGeneration: number; fileRevision: number; claimToken: string;
    expectedSha256: string; contentLength?: number; source: AsyncIterable<Uint8Array | string>;
    context: Stage4Context;
  }): Promise<StorageAgentTask> {
    await this.capacity?.assertWriteAllowed();
    const id = uuid(input.taskId, 'Task ID');
    const generation = positiveInteger(input.leaseGeneration, 'Lease generation');
    const fileRevision = positiveInteger(input.fileRevision, 'File revision');
    const claimToken = uuid(input.claimToken, 'Claim token');
    const expectedHash = hash(input.expectedSha256);
    const claimed = await this.agent.withCurrentLease(credential, generation, async (client, lease) => {
      const row = requireOwnedTask((await client.query<TaskRow>(`${TASK_SELECT} WHERE id=$1 FOR UPDATE`, [id])).rows[0], lease);
      requireClaim(row, claimToken);
      if (row.task_type !== 'UPLOAD_BLOB' || !row.content_staging_key || row.file_revision !== fileRevision
        || row.expected_sha256_hex !== expectedHash) {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Storage Agent content does not match its task.'});
      }
      if (row.content_state === 'STAGED') return {row, staged: true as const};
      if (row.content_state === 'NONE') {
        const updated = await client.query<TaskRow>(`UPDATE storage_agent_tasks SET content_state='RECEIVING',
          revision=revision+1,updated_at=now() WHERE id=$1
          RETURNING *,encode(expected_sha256,'hex') AS expected_sha256_hex,
            encode(actual_sha256,'hex') AS actual_sha256_hex`, [row.id]);
        return {row: updated.rows[0] as TaskRow, staged: false as const};
      }
      return {row, staged: false as const};
    });
    if (claimed.staged) return task(claimed.row);
    try {
      let content;
      if (await this.staging.exists(claimed.row.content_staging_key as string)) {
          try {
          content = await this.staging.verify(claimed.row.content_staging_key as string,
            Number(claimed.row.expected_size_bytes), expectedHash);
          } catch (error) {
          await this.staging.remove(claimed.row.content_staging_key as string);
            throw error;
          }
      } else {
        content = await this.staging.write({key: claimed.row.content_staging_key as string, source: input.source,
            expectedSizeBytes: Number(claimed.row.expected_size_bytes), expectedSha256: expectedHash,
            contentLength: input.contentLength});
      }
      return await this.agent.withCurrentLease(credential, generation, async (client, lease, committee) => {
        const row = requireOwnedTask((await client.query<TaskRow>(`${TASK_SELECT} WHERE id=$1 FOR UPDATE`, [id])).rows[0], lease);
        requireClaim(row, claimToken);
        if (row.file_revision !== fileRevision || row.content_state !== 'RECEIVING'
          || row.expected_sha256_hex !== expectedHash) {
          throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Storage Agent content is no longer expected.'});
        }
        const updated = await client.query<TaskRow>(`UPDATE storage_agent_tasks SET content_state='STAGED',
          received_size_bytes=$2,actual_sha256=decode($3,'hex'),revision=revision+1,updated_at=now()
          WHERE id=$1 RETURNING *,encode(expected_sha256,'hex') AS expected_sha256_hex,
            encode(actual_sha256,'hex') AS actual_sha256_hex`,
        [row.id, content.sizeBytes, content.sha256]);
        const current = updated.rows[0] as TaskRow;
        await appendEvent(client, committee, {type: 'storage_agent.task_changed', resourceType: 'storage_agent_task',
          resourceId: row.id, revision: current.revision, audience: 'CHAIR',
          payload: {status: current.status, contentState: 'STAGED'}});
        await agentAudit(client, input.context, {committeeId: lease.committeeId,
          action: 'storage.agent_blob_staged', taskId: row.id,
          before: {contentState: row.content_state}, after: {contentState: 'STAGED', sizeBytes: content.sizeBytes}});
        return task(current);
      });
    } catch (error) {
      if (!(error instanceof UploadStreamError)) throw error;
      await this.markStreamFailure(credential, generation, id, claimToken, error, input.context).catch(() => undefined);
      throw new AppError({code: error.apiCode, message: error.message});
    }
  }

  async streamBlob(credential: string, input: {
    taskId: string; blobId: string; leaseGeneration: number; fileRevision: number; claimToken: string;
  }, destination: AgentBlobDestination): Promise<void> {
    const taskId = uuid(input.taskId, 'Task ID'); const blobId = uuid(input.blobId, 'Blob ID');
    const generation = positiveInteger(input.leaseGeneration, 'Lease generation');
    const fileRevision = positiveInteger(input.fileRevision, 'File revision');
    const claimToken = uuid(input.claimToken, 'Claim token');
    const authorized = await this.agent.withCurrentLease(credential, generation, async (client, lease) => {
      const row = requireOwnedTask((await client.query<TaskRow>(`${TASK_SELECT} WHERE id=$1 FOR UPDATE`, [taskId])).rows[0], lease);
      requireClaim(row, claimToken);
      if (row.task_type !== 'STORE_BLOB' || row.blob_id !== blobId || row.file_revision !== fileRevision) {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Blob does not match its storage Agent task.'});
      }
      let stagingKey: string | null = null;
      if (row.source_upload_id) {
        const upload = await client.query<{staging_key: string; status: string; agent_task_id: string}>(`SELECT
          staging_key,status,agent_task_id FROM file_uploads WHERE id=$1 FOR SHARE`, [row.source_upload_id]);
        if (!upload.rows[0] || upload.rows[0].status !== 'STAGED' || upload.rows[0].agent_task_id !== row.id) {
          throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Source upload is not ready for its storage Agent task.'});
        }
        stagingKey = upload.rows[0].staging_key;
      }
      return {committeeId: lease.committeeId, sizeBytes: Number(row.expected_size_bytes),
        sha256: row.expected_sha256_hex as string, stagingKey};
    });
    if (authorized.stagingKey) {
      await this.staging.verify(authorized.stagingKey, authorized.sizeBytes, authorized.sha256);
      destination.start({sizeBytes: authorized.sizeBytes, sha256: authorized.sha256});
      for await (const chunk of this.staging.read(authorized.stagingKey, authorized.sizeBytes, authorized.sha256)) {
        await destination.write(chunk);
      }
      return;
    }
    const stored = await this.files.readStoredBlob(authorized.committeeId, blobId);
    if (stored.sizeBytes !== authorized.sizeBytes || stored.sha256 !== authorized.sha256) {
      throw new AppError({code: 'SERVICE_NOT_READY', message: 'Stored blob integrity does not match its task.'});
    }
    destination.start({sizeBytes: stored.sizeBytes, sha256: stored.sha256});
    for await (const chunk of stored.content) await destination.write(chunk);
  }

  async complete(credential: string, taskId: string, body: unknown, context: Stage4Context): Promise<StorageAgentTask> {
    return this.finish(credential, taskId, body, 'COMPLETED', context);
  }

  async fail(credential: string, taskId: string, body: unknown, context: Stage4Context): Promise<StorageAgentTask> {
    return this.finish(credential, taskId, body, 'FAILED', context);
  }

  private async finish(credential: string, taskId: string, body: unknown,
    outcome: 'COMPLETED' | 'FAILED', context: Stage4Context): Promise<StorageAgentTask> {
    const allowed = outcome === 'FAILED'
      ? ['leaseGeneration', 'fileRevision', 'claimToken', 'requestId', 'failureCode', 'failureReason']
      : ['leaseGeneration', 'fileRevision', 'claimToken', 'requestId'];
    assertExactBody(body as Record<string, unknown>, allowed);
    const request = body as Record<string, unknown>;
    const generation = positiveInteger(request.leaseGeneration, 'Lease generation');
    const fileRevision = positiveInteger(request.fileRevision, 'File revision');
    const claimToken = uuid(request.claimToken, 'Claim token');
    const requestId = uuid(request.requestId, 'Request ID');
    const code = outcome === 'FAILED' ? failureCode(request.failureCode) : null;
    const reason = outcome === 'FAILED' ? failureReason(request.failureReason) : null;
    const id = uuid(taskId, 'Task ID');
    return this.agent.withCurrentLease(credential, generation, async (client, lease, committee) => {
      const row = requireOwnedTask((await client.query<TaskRow>(`${TASK_SELECT} WHERE id=$1 FOR UPDATE`, [id])).rows[0], lease);
      if (row.status === outcome && row.terminal_request_id === requestId) return task(row);
      if (row.terminal_request_id || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(row.status)) {
        throw new AppError({code: 'IDEMPOTENCY_CONFLICT', message: 'Storage Agent task already has a different outcome.'});
      }
      requireClaim(row, claimToken);
      if (row.file_revision !== fileRevision) {
        throw new AppError({code: 'REVISION_CONFLICT', message: 'Storage Agent task revision is stale.'});
      }
      if (outcome === 'COMPLETED' && row.task_type === 'UPLOAD_BLOB' && row.content_state !== 'STAGED') {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Storage Agent content is not staged.'});
      }
      if (outcome === 'FAILED' && row.content_state === 'STAGED') {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Verified staged content cannot be failed.'});
      }
      if (outcome === 'COMPLETED' && this.finalizer) {
        await this.finalizer.finalize(client, {id: row.id, committeeId: row.committee_id, hostId: row.host_id,
          leaseGeneration: Number(row.lease_generation), type: row.task_type, fileEntryId: row.file_entry_id,
          fileRevision: row.file_revision, blobId: row.blob_id,
          expectedSizeBytes: row.expected_size_bytes === null ? null : Number(row.expected_size_bytes),
          expectedSha256: row.expected_sha256_hex, contentStagingKey: row.content_staging_key,
          sourceUploadId: row.source_upload_id, resolutionConflictId: row.resolution_conflict_id}, committee, context);
        const refreshed = await client.query<{next_event_sequence: string | number}>(
          'SELECT next_event_sequence FROM committees WHERE id=$1', [committee.id]);
        committee.next_event_sequence = Number(refreshed.rows[0]?.next_event_sequence ?? committee.next_event_sequence);
      }
      const updated = await client.query<TaskRow>(`UPDATE storage_agent_tasks SET status=$2::storage_agent_task_status,
        terminal_request_id=$3,terminal_outcome=$2::storage_agent_task_status,
        completed_at=CASE WHEN $2::storage_agent_task_status='COMPLETED'::storage_agent_task_status THEN now() ELSE NULL END,
        failure_code=$4,failure_reason=$5,claimed_at=NULL,claim_request_id=NULL,claim_token=NULL,
        revision=revision+1,updated_at=now() WHERE id=$1
        RETURNING *,encode(expected_sha256,'hex') AS expected_sha256_hex,
          encode(actual_sha256,'hex') AS actual_sha256_hex`,
      [row.id, outcome, requestId, code, reason]);
      const current = updated.rows[0] as TaskRow;
      await appendEvent(client, committee, {type: 'storage_agent.task_changed', resourceType: 'storage_agent_task',
        resourceId: row.id, revision: current.revision, audience: 'CHAIR',
        payload: {status: outcome, failureCode: code}});
      await agentAudit(client, context, {committeeId: lease.committeeId,
        action: outcome === 'COMPLETED' ? 'storage.agent_task_completed' : 'storage.agent_task_failed',
        taskId: row.id, before: {status: row.status, revision: row.revision},
        after: {status: outcome, revision: current.revision, failureCode: code}});
      return task(current);
    });
  }

  private async markStreamFailure(credential: string, generation: number, taskId: string, claimToken: string,
    failure: UploadStreamError, context: Stage4Context): Promise<void> {
    await this.agent.withCurrentLease(credential, generation, async (client, lease, committee) => {
      const row = requireOwnedTask((await client.query<TaskRow>(`${TASK_SELECT} WHERE id=$1 FOR UPDATE`, [taskId])).rows[0], lease);
      requireClaim(row, claimToken);
      const updated = await client.query<TaskRow>(`UPDATE storage_agent_tasks SET status='RETRY',content_state='NONE',
        received_size_bytes=NULL,actual_sha256=NULL,claimed_at=NULL,claim_request_id=NULL,claim_token=NULL,
        failure_code=$2,failure_reason=$3,next_attempt_at=now()+interval '1 second',revision=revision+1,updated_at=now()
        WHERE id=$1 RETURNING *,encode(expected_sha256,'hex') AS expected_sha256_hex,
          encode(actual_sha256,'hex') AS actual_sha256_hex`,
      [row.id, failure.failureCode.slice(0, 80), failure.message.slice(0, 240)]);
      const current = updated.rows[0] as TaskRow;
      await appendEvent(client, committee, {type: 'storage_agent.task_changed', resourceType: 'storage_agent_task',
        resourceId: row.id, revision: current.revision, audience: 'CHAIR',
        payload: {status: 'RETRY', failureCode: failure.failureCode}});
      await agentAudit(client, context, {committeeId: lease.committeeId, action: 'storage.agent_task_failed',
        taskId: row.id, before: {status: row.status},
        after: {status: 'RETRY', failureCode: failure.failureCode}});
    });
  }
}
