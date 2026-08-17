import {randomUUID} from 'node:crypto';
import {posix} from 'node:path';
import type {Pool, PoolClient, QueryResultRow} from 'pg';
import type {StorageAgentConflict, StorageAgentConflictResolution, StorageAgentLocalChange} from '@quorum/contracts';
import {AppError} from '../../http/errors.js';
import type {AuthenticatedSession} from '../identity/store.js';
import {appendEvent, audit, idempotentTransaction, isChair, lockedCommittee, requireBusinessIdentity,
  requireProceedingsActive, transaction, type Stage4CommitteeRow, type Stage4Context} from '../stage4/database.js';
import {assertExactBody} from '../stage4/validation.js';
import type {Stage7StorageAgentService} from './service.js';

interface ConflictRow extends QueryResultRow {
  id: string; committee_id: string; host_id: string; file_entry_id: string | null;
  server_revision: number | null; local_base_revision: number | null;
  reason_code: StorageAgentConflict['reasonCode']; status: StorageAgentConflict['status']; revision: number;
  resolution_action: StorageAgentConflictResolution | null; resolution_logical_name: string | null;
  resolution_lease_generation: string | number | null; resolution_file_revision: number | null;
  created_at: Date; resolved_at: Date | null; kind: StorageAgentLocalChange['kind'];
  change_file_entry_id: string | null; base_revision: number | null; logical_name: string | null;
  original_name: string | null; media_type: string | null; size_bytes: string | number | null; sha256_hex: string | null;
}

const SELECT_CONFLICT = `SELECT conflict.*,change.kind,change.file_entry_id AS change_file_entry_id,
  change.base_revision,change.logical_name,change.original_name,change.media_type,change.size_bytes,
  CASE WHEN change.sha256 IS NULL THEN NULL ELSE encode(change.sha256,'hex') END AS sha256_hex
  FROM storage_agent_conflicts conflict
  JOIN storage_agent_change_requests change ON change.id=conflict.change_request_id`;

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError({code: 'VALIDATION_FAILED', message: `${name} is invalid.`});
  }
  return value;
}

function positive(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new AppError({code: 'VALIDATION_FAILED', message: `${name} is invalid.`});
  }
  return Number(value);
}

function optionalPositive(value: unknown, name: string): number | null {
  return value === null ? null : positive(value, name);
}

function resolution(value: unknown): StorageAgentConflictResolution {
  if (!['KEEP_SERVER', 'ACCEPT_LOCAL', 'SAVE_AS_NEW'].includes(String(value))) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Conflict resolution is invalid.'});
  }
  return value as StorageAgentConflictResolution;
}

function logicalName(value: unknown, required: boolean): string | null {
  if (!required && value === undefined) return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 500) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Logical name is invalid.'});
  }
  const normalized = value.trim().replaceAll('\\', '/');
  const parts = normalized.split('/');
  const windowsReserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || value.startsWith('\\\\')
    || parts.some(part => !part || part === '.' || part === '..' || windowsReserved.test(part)
      || part.endsWith('.') || part.endsWith(' ') || part.includes(':'))
    || ['.quorum-agent.json', '.quorum-tmp'].includes(parts[0]!.toLowerCase())) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Logical name is not a safe portable path.'});
  }
  return normalized;
}

function change(row: ConflictRow): StorageAgentLocalChange {
  if (row.kind === 'UPSERT') return {kind: 'UPSERT',
    ...(row.change_file_entry_id ? {fileEntryId: row.change_file_entry_id,
      baseRevision: row.base_revision as number} : {}), logicalName: row.logical_name as string,
    originalName: row.original_name as string, mediaType: row.media_type as string,
    sizeBytes: Number(row.size_bytes), sha256: row.sha256_hex as string};
  if (row.kind === 'RENAME') return {kind: 'RENAME', fileEntryId: row.change_file_entry_id as string,
    baseRevision: row.base_revision as number, logicalName: row.logical_name as string};
  return {kind: 'DELETE', fileEntryId: row.change_file_entry_id as string,
    baseRevision: row.base_revision as number};
}

function conflict(row: ConflictRow): StorageAgentConflict {
  return {id: row.id, committeeId: row.committee_id, hostId: row.host_id, fileEntryId: row.file_entry_id,
    serverRevision: row.server_revision, localBaseRevision: row.local_base_revision, reasonCode: row.reason_code,
    status: row.status, revision: row.revision, change: change(row), resolutionAction: row.resolution_action,
    resolutionLogicalName: row.resolution_logical_name,
    resolutionLeaseGeneration: row.resolution_lease_generation === null ? null : Number(row.resolution_lease_generation),
    resolutionFileRevision: row.resolution_file_revision, createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null};
}

function browserConflict(row: ConflictRow): StorageAgentConflict {
  const value = conflict(row);
  if (value.change.kind === 'DELETE') return value;
  return {...value, change: {...value.change, logicalName: posix.basename(value.change.logicalName)}};
}

async function requireManager(client: PoolClient, committee: Stage4CommitteeRow, userId: string): Promise<void> {
  if (committee.owner_user_id !== userId && !(await isChair(client, committee.id, userId))) {
    throw new AppError({code: 'FORBIDDEN', message: 'Chair or committee owner access is required.'});
  }
}

export class Stage7ConflictService {
  constructor(private readonly pool: Pool, private readonly agent: Stage7StorageAgentService) {}

  async list(auth: AuthenticatedSession, committeeId: string): Promise<StorageAgentConflict[]> {
    requireBusinessIdentity(auth);
    return transaction(this.pool, async client => {
      const committee = (await client.query<Stage4CommitteeRow>('SELECT * FROM committees WHERE id=$1',
        [uuid(committeeId, 'Committee ID')])).rows[0];
      if (!committee || committee.status === 'DELETING') throw new AppError({code: 'NOT_FOUND', message: 'Committee not found.'});
      await requireManager(client, committee, auth.user.id);
      const rows = await client.query<ConflictRow>(`${SELECT_CONFLICT} WHERE conflict.committee_id=$1
        ORDER BY CASE conflict.status WHEN 'PENDING' THEN 0 ELSE 1 END,conflict.created_at DESC,conflict.id`,
      [committee.id]);
      return rows.rows.map(browserConflict);
    });
  }

  async listForAgent(credential: string, leaseGeneration: number): Promise<StorageAgentConflict[]> {
    return this.agent.withCurrentLease(credential, positive(leaseGeneration, 'Lease generation'),
      async (client, lease) => (await client.query<ConflictRow>(`${SELECT_CONFLICT}
        WHERE conflict.host_id=$1 AND conflict.status='RESOLVED' ORDER BY conflict.created_at,conflict.id`,
      [lease.hostId])).rows.map(conflict));
  }

  async resolve(auth: AuthenticatedSession, committeeId: string, conflictId: string, body: unknown,
    idempotencyKey: string, context: Stage4Context): Promise<StorageAgentConflict> {
    requireBusinessIdentity(auth);
    assertExactBody(body as Record<string, unknown>,
      ['baseRevision', 'leaseGeneration', 'fileRevision', 'action', 'logicalName']);
    const input = body as Record<string, unknown>; const action = resolution(input.action);
    const expectedRevision = positive(input.baseRevision, 'Conflict revision');
    const generation = positive(input.leaseGeneration, 'Lease generation');
    const fileRevision = optionalPositive(input.fileRevision, 'File revision');
    const id = uuid(conflictId, 'Conflict ID'); const committeeUuid = uuid(committeeId, 'Committee ID');
    return idempotentTransaction({pool: this.pool, auth,
      route: `/api/v1/committees/${committeeUuid}/storage-agent-conflicts/${id}/resolve`,
      key: idempotencyKey, request: body, status: 200, work: async client => {
        const committee = await lockedCommittee(client, committeeUuid); requireProceedingsActive(committee);
        await requireManager(client, committee, auth.user.id);
        if (Number(committee.storage_lease_generation) !== generation) {
          throw new AppError({code: 'REVISION_CONFLICT', message: 'Storage host changed since this conflict was loaded.'});
        }
        const found = await client.query<ConflictRow>(`${SELECT_CONFLICT}
          WHERE conflict.id=$1 AND conflict.committee_id=$2 FOR UPDATE OF conflict`, [id, committee.id]);
        const row = found.rows[0];
        if (!row) throw new AppError({code: 'NOT_FOUND', message: 'Storage conflict not found.'});
        if (row.status !== 'PENDING' || row.revision !== expectedRevision) {
          throw new AppError({code: 'REVISION_CONFLICT', message: 'Storage conflict changed since it was loaded.'});
        }
        const currentHost = (await client.query<{id: string; lease_generation: string | number}>(`SELECT id,lease_generation
          FROM storage_hosts WHERE committee_id=$1 AND status IN ('ACTIVE','DEGRADED') FOR UPDATE`, [committee.id])).rows[0];
        if (!currentHost || Number(currentHost.lease_generation) !== generation) {
          throw new AppError({code: 'REVISION_CONFLICT', message: 'Storage host changed since this conflict was loaded.'});
        }
        const entry = row.file_entry_id ? (await client.query<{id: string; revision: number; status: string}>(
          'SELECT id,revision,status FROM file_entries WHERE id=$1 AND committee_id=$2 FOR UPDATE',
        [row.file_entry_id, committee.id])).rows[0] : undefined;
        const actualFileRevision = entry?.revision ?? null;
        if (actualFileRevision !== fileRevision) {
          throw new AppError({code: 'REVISION_CONFLICT', message: 'File changed since this conflict was loaded.'});
        }
        if (row.reason_code === 'HOST_TRANSFERRED' && action !== 'KEEP_SERVER') {
          throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Content on a revoked host cannot be accepted.'});
        }
        if ((row.reason_code === 'FILE_DELETED' || entry?.status === 'DELETED') && action === 'ACCEPT_LOCAL') {
          throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Deleted content must be saved as a new file.'});
        }
        if (action === 'SAVE_AS_NEW' && row.kind !== 'UPSERT') {
          throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Only local content can be saved as a new file.'});
        }
        const requestedLogicalName = logicalName(input.logicalName, action === 'SAVE_AS_NEW'
          || (action === 'ACCEPT_LOCAL' && row.reason_code === 'NAME_CONFLICT'));
        const updated = await client.query<ConflictRow>(`UPDATE storage_agent_conflicts SET status='RESOLVED',
          revision=revision+1,resolution_action=$2,resolution_logical_name=$3,resolution_lease_generation=$4,
          resolution_file_revision=$5,resolved_at=now(),resolved_by_user_id=$6 WHERE id=$1
          RETURNING *,NULL::text AS kind,NULL::uuid AS change_file_entry_id,NULL::integer AS base_revision,
            NULL::text AS logical_name,NULL::text AS original_name,NULL::text AS media_type,
            NULL::bigint AS size_bytes,NULL::text AS sha256_hex`,
        [id, action, requestedLogicalName, generation, actualFileRevision, auth.user.id]);
        if (action === 'KEEP_SERVER' && row.host_id === currentHost.id) {
          const latest = row.file_entry_id ? (await client.query<{kind: 'UPSERT' | 'DELETE'; file_entry_id: string;
            file_revision: number; blob_id: string | null; size_bytes: string | number | null; sha256: Buffer | null}>(
            `SELECT kind,file_entry_id,file_revision,blob_id,size_bytes,sha256 FROM storage_manifest_events
             WHERE committee_id=$1 AND file_entry_id=$2 ORDER BY sequence DESC LIMIT 1`,
          [committee.id, row.file_entry_id])).rows[0] : undefined;
          const allocated = await client.query<{sequence: string | number}>(`UPDATE committees
            SET next_storage_agent_task_sequence=next_storage_agent_task_sequence+1 WHERE id=$1
            RETURNING next_storage_agent_task_sequence-1 AS sequence`, [committee.id]);
          await client.query(`INSERT INTO storage_agent_tasks
            (id,committee_id,host_id,lease_generation,sequence,task_type,file_entry_id,file_revision,blob_id,
             expected_size_bytes,expected_sha256,resolution_conflict_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [randomUUID(), committee.id, currentHost.id, generation, allocated.rows[0]?.sequence,
            latest?.kind === 'UPSERT' ? 'STORE_BLOB' : 'DELETE_FILE', latest?.file_entry_id ?? id,
            latest?.file_revision ?? 1, latest?.blob_id ?? null, latest?.size_bytes ?? null,
            latest?.sha256 ?? null, id]);
        }
        await appendEvent(client, committee, {type: 'storage_agent.conflict_resolved',
          resourceType: 'storage_agent_conflict', resourceId: id, revision: expectedRevision + 1,
          audience: 'CHAIR', payload: {action}});
        await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
          capabilities: [committee.owner_user_id === auth.user.id ? 'OWNER' : 'CHAIR'],
          action: 'storage.agent_conflict_resolved', resourceType: 'storage_agent_conflict', resourceId: id,
          before: {status: 'PENDING', revision: expectedRevision, reasonCode: row.reason_code},
          after: {status: 'RESOLVED', revision: expectedRevision + 1, action}});
        return {...browserConflict(row), status: 'RESOLVED', revision: expectedRevision + 1,
          resolutionAction: action, resolutionLogicalName: requestedLogicalName,
          resolutionLeaseGeneration: generation, resolutionFileRevision: actualFileRevision,
          resolvedAt: updated.rows[0]?.resolved_at?.toISOString() ?? new Date().toISOString()};
      }});
  }
}
