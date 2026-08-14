import {createHash, randomUUID} from 'node:crypto';
import type {CommitteeDeletionJob} from '@quorum/contracts';
import type {Pool, PoolClient, QueryResultRow} from 'pg';
import {AppError} from '../../http/errors.js';
import type {Logger} from '../../logger.js';
import type {AuthenticatedSession} from '../identity/store.js';
import {appendEvent, audit, idempotentTransaction, lockedCommittee, requireBusinessIdentity,
  transaction, type Stage4Context} from '../stage4/database.js';
import {assertExactBody} from '../stage4/validation.js';

interface DeletionRow extends QueryResultRow {
  id: string;
  committee_id: string;
  status: CommitteeDeletionJob['status'];
  requested_at: Date;
  completed_at: Date | null;
  failure_code: string | null;
  attempts: number;
  claim_token: string | null;
}

interface BlockerRow extends QueryResultRow {
  blob_jobs: number;
  upload_staging: number;
  migration_staging: number;
  agent_staging: number;
  agent_deletes: number;
}

export const COMMITTEE_PURGE_QUERIES = [
  `DELETE FROM committee_deletion_agent_tasks WHERE deletion_job_id IN
    (SELECT id FROM committee_deletion_jobs WHERE committee_id=$1)`,
  `DELETE FROM storage_agent_conflict_applications WHERE conflict_id IN
    (SELECT id FROM storage_agent_conflicts WHERE committee_id=$1)`,
  `DELETE FROM storage_agent_tasks WHERE committee_id=$1`,
  `DELETE FROM storage_agent_conflicts WHERE committee_id=$1`,
  `DELETE FROM storage_agent_change_requests WHERE committee_id=$1`,
  `DELETE FROM storage_manifest_events WHERE committee_id=$1`,
  `DELETE FROM file_blob_copies WHERE committee_id=$1`,
  `DELETE FROM storage_migration_items WHERE committee_id=$1`,
  `DELETE FROM storage_migrations WHERE committee_id=$1`,
  `DELETE FROM file_blob_delete_jobs WHERE committee_id=$1`,
  `DELETE FROM file_tombstones WHERE committee_id=$1`,
  `DELETE FROM file_versions WHERE committee_id=$1`,
  `DELETE FROM file_entries WHERE committee_id=$1`,
  `DELETE FROM file_uploads WHERE committee_id=$1`,
  `DELETE FROM file_blobs WHERE committee_id=$1`,
  `UPDATE committees SET active_storage_binding_id=NULL WHERE id=$1`,
  `DELETE FROM storage_bindings WHERE committee_id=$1`,
  `DELETE FROM storage_pairing_codes WHERE committee_id=$1`,
  `DELETE FROM storage_hosts WHERE committee_id=$1`,
  `DELETE FROM ballot_vote_revisions WHERE ballot_id IN (SELECT id FROM ballots WHERE committee_id=$1)`,
  `DELETE FROM ballot_votes WHERE ballot_id IN (SELECT id FROM ballots WHERE committee_id=$1)`,
  `DELETE FROM ballots WHERE committee_id=$1`,
  `DELETE FROM strawpoll_anonymous_receipts WHERE strawpoll_id IN (SELECT id FROM strawpolls WHERE committee_id=$1)`,
  `DELETE FROM strawpoll_anonymous_votes WHERE strawpoll_id IN (SELECT id FROM strawpolls WHERE committee_id=$1)`,
  `DELETE FROM strawpoll_seat_votes WHERE strawpoll_id IN (SELECT id FROM strawpolls WHERE committee_id=$1)`,
  `DELETE FROM strawpoll_options WHERE strawpoll_id IN (SELECT id FROM strawpolls WHERE committee_id=$1)`,
  `DELETE FROM strawpolls WHERE committee_id=$1`,
  `DELETE FROM motion_seconds WHERE committee_id=$1`,
  `DELETE FROM motions WHERE committee_id=$1`,
  `DELETE FROM document_actions WHERE committee_id=$1`,
  `DELETE FROM discussion_entries WHERE committee_id=$1`,
  `DELETE FROM amendments WHERE document_id IN (SELECT id FROM documents WHERE committee_id=$1)`,
  `DELETE FROM resolutions WHERE document_id IN (SELECT id FROM documents WHERE committee_id=$1)`,
  `DELETE FROM document_versions WHERE document_id IN (SELECT id FROM documents WHERE committee_id=$1)`,
  `DELETE FROM documents WHERE committee_id=$1`,
  `DELETE FROM speech_actions WHERE committee_id=$1`,
  `DELETE FROM speech_contributions WHERE committee_id=$1`,
  `DELETE FROM speeches WHERE committee_id=$1`,
  `DELETE FROM caucuses WHERE committee_id=$1`,
  `UPDATE speaker_lists SET current_entry_id=NULL WHERE committee_id=$1`,
  `DELETE FROM speaker_queue_entries WHERE committee_id=$1`,
  `DELETE FROM speaker_lists WHERE committee_id=$1`,
  `DELETE FROM timer_states WHERE committee_id=$1`,
  `DELETE FROM current_attendance WHERE committee_id=$1`,
  `DELETE FROM attendance_events WHERE committee_id=$1`,
  `DELETE FROM points WHERE committee_id=$1`,
  `DELETE FROM roll_call_entries WHERE committee_id=$1`,
  `DELETE FROM roll_call_seats WHERE roll_call_id IN (SELECT id FROM roll_calls WHERE committee_id=$1)`,
  `DELETE FROM roll_calls WHERE committee_id=$1`,
  `DELETE FROM meeting_sessions WHERE committee_id=$1`,
  `DELETE FROM committee_notes WHERE committee_id=$1`,
  `DELETE FROM committee_text_posts WHERE committee_id=$1`,
  `DELETE FROM audit_log WHERE committee_id=$1`,
  `DELETE FROM seat_invitations WHERE committee_id=$1`,
  `DELETE FROM seat_assignments WHERE committee_id=$1`,
  `DELETE FROM committee_capabilities WHERE committee_id=$1`,
  `DELETE FROM committee_memberships WHERE committee_id=$1`,
  `DELETE FROM committee_seats WHERE committee_id=$1`,
  `DELETE FROM chair_rule_overrides WHERE committee_id=$1`,
  `DELETE FROM committee_rule_bindings WHERE committee_id=$1`,
  `DELETE FROM committee_events WHERE committee_id=$1`,
  `DELETE FROM rule_package_versions WHERE package_id IN
    (SELECT id FROM rule_packages WHERE committee_id=$1)`,
  `DELETE FROM rule_packages WHERE committee_id=$1`,
  `DELETE FROM idempotency_keys WHERE route LIKE '%'||$1::text||'%'
    OR response_body::text LIKE '%'||$1::text||'%'`,
  `DELETE FROM committees WHERE id=$1`
] as const;

function map(row: DeletionRow): CommitteeDeletionJob {
  return {id: row.id, committeeId: row.committee_id, status: row.status,
    requestedAt: row.requested_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null,
    failureCode: row.failure_code};
}

function body(value: unknown): {baseRevision: number; confirmationName: string} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Deletion confirmation is invalid.'});
  }
  const raw = value as Record<string, unknown>;
  assertExactBody(raw, ['baseRevision', 'confirmationName'], 'Deletion request');
  if (!Number.isSafeInteger(raw.baseRevision) || Number(raw.baseRevision) < 1
    || typeof raw.confirmationName !== 'string' || raw.confirmationName.length > 200) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Deletion confirmation is invalid.'});
  }
  return {baseRevision: Number(raw.baseRevision), confirmationName: raw.confirmationName};
}

export class Stage8DeletionService {
  constructor(private readonly pool: Pool) {}

  async requestDeletion(auth: AuthenticatedSession, committeeId: string, input: unknown,
    idempotencyKey: string, context: Stage4Context): Promise<CommitteeDeletionJob> {
    requireBusinessIdentity(auth);
    const request = body(input);
    return idempotentTransaction({pool: this.pool, auth, route: `/committees/${committeeId}/delete`,
      key: idempotencyKey, request, status: 202, work: async client => {
        const committee = await lockedCommittee(client, committeeId);
        if (committee.owner_user_id !== auth.user.id) {
          throw new AppError({code: 'NOT_FOUND', message: 'Committee not found.'});
        }
        if (committee.status !== 'ARCHIVED') {
          throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Archive the committee before deleting it.'});
        }
        if (committee.revision !== request.baseRevision) {
          throw new AppError({code: 'REVISION_CONFLICT', message: 'This committee changed since it was loaded.',
            details: {currentRevision: committee.revision}});
        }
        if (request.confirmationName !== committee.name) {
          throw new AppError({code: 'VALIDATION_FAILED', message: 'Committee name does not match.'});
        }
        const unavailableChairStorage = await client.query(`SELECT 1 FROM file_blobs blob
          JOIN storage_bindings binding ON binding.id=blob.storage_binding_id
          LEFT JOIN storage_hosts host ON host.id=binding.storage_host_id
          WHERE blob.committee_id=$1 AND blob.durability_state<>'DELETED' AND binding.provider_type='CHAIR_AGENT'
            AND (binding.id IS DISTINCT FROM $2 OR host.status NOT IN ('ACTIVE','DEGRADED')) LIMIT 1`,
        [committee.id, committee.active_storage_binding_id]);
        if (unavailableChairStorage.rowCount) {
          throw new AppError({code: 'SERVICE_NOT_READY',
            message: 'Reconnect the current Chair storage computer before deleting this committee.'});
        }

        const jobId = randomUUID();
        const inserted = await client.query<DeletionRow>(`INSERT INTO committee_deletion_jobs
          (id,committee_id,requested_by_user_id,confirmation_name_sha256)
          VALUES ($1,$2,$3,$4) RETURNING *`, [jobId, committee.id, auth.user.id,
          createHash('sha256').update(request.confirmationName).digest()]);
        const updated = await client.query<{revision: number}>(`UPDATE committees SET status='DELETING',
          revision=revision+1,updated_at=now() WHERE id=$1 RETURNING revision`, [committee.id]);
        committee.revision = updated.rows[0]?.revision ?? committee.revision + 1;

        await client.query(`UPDATE storage_pairing_codes SET revoked_at=now()
          WHERE committee_id=$1 AND used_at IS NULL AND revoked_at IS NULL`, [committee.id]);
        await client.query(`UPDATE storage_agent_tasks SET status='CANCELLED',cancelled_at=now(),
          claimed_at=NULL,claim_request_id=NULL,claim_token=NULL,revision=revision+1,updated_at=now()
          WHERE committee_id=$1 AND status IN ('PENDING','IN_PROGRESS','RETRY')`, [committee.id]);
        await client.query(`UPDATE file_uploads SET status='CANCELLED',cancelled_at=now(),
          cleanup_next_attempt_at=now(),revision=revision+1,updated_at=now()
          WHERE committee_id=$1 AND status IN ('CREATED','RECEIVING','STAGED')`, [committee.id]);
        await client.query(`UPDATE file_uploads SET expires_at=greatest(created_at+interval '1 millisecond',now()),
          cleanup_next_attempt_at=now(),updated_at=now() WHERE committee_id=$1 AND status='FAILED'`, [committee.id]);
        await client.query(`UPDATE storage_migration_items SET status='CANCELLED',claimed_at=NULL,claim_token=NULL,
          cleanup_next_attempt_at=now(),updated_at=now()
          WHERE committee_id=$1 AND status IN ('PENDING','IN_PROGRESS','RETRY')`, [committee.id]);
        await client.query(`UPDATE storage_migrations SET status='CANCELLED',cancelled_at=now(),revision=revision+1,
          updated_at=now() WHERE committee_id=$1 AND status NOT IN ('COMPLETED','CANCELLED')`, [committee.id]);

        const deleted = await client.query<{id: string; last_content_revision: number}>(`UPDATE file_entries
          SET status='DELETED',current_version_id=NULL,deleted_at=now(),revision=revision+1,updated_at=now()
          WHERE committee_id=$1 AND status<>'DELETED' RETURNING id,revision-1 AS last_content_revision`, [committee.id]);
        for (const entry of deleted.rows) {
          await client.query(`INSERT INTO file_tombstones
            (id,committee_id,file_entry_id,last_content_revision,deleted_by_user_id)
            VALUES ($1,$2,$3,$4,$5) ON CONFLICT (file_entry_id) DO NOTHING`,
          [randomUUID(), committee.id, entry.id, entry.last_content_revision, auth.user.id]);
        }
        await client.query(`INSERT INTO committee_deletion_agent_tasks (deletion_job_id,task_id)
          SELECT $1,id FROM storage_agent_tasks WHERE committee_id=$2 AND task_type='DELETE_FILE'
            AND status IN ('PENDING','IN_PROGRESS','RETRY') ON CONFLICT (task_id) DO NOTHING`,
        [jobId, committee.id]);
        await this.enqueueBlobDeletes(client, committee.id);

        await appendEvent(client, committee, {type: 'committee.deletion_started', resourceType: 'committee',
          resourceId: committee.id, revision: committee.revision, audience: 'CHAIR', payload: {status: 'DELETING'}});
        await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
          capabilities: ['COMMITTEE_OWNER'], action: 'committee.deletion_started', resourceType: 'committee',
          resourceId: committee.id, before: {status: 'ARCHIVED'}, after: {status: 'DELETING', jobId}});
        return map(inserted.rows[0] as DeletionRow);
      }});
  }

  async processNext(): Promise<CommitteeDeletionJob | null> {
    const claimed = await transaction(this.pool, async client => {
      const found = await client.query<DeletionRow>(`SELECT * FROM committee_deletion_jobs
        WHERE ((status IN ('PENDING','RETRY') AND next_attempt_at<=now())
          OR (status='IN_PROGRESS' AND (claimed_at IS NULL OR claimed_at<=now()-interval '5 minutes')))
        ORDER BY CASE WHEN status='IN_PROGRESS' THEN claimed_at ELSE next_attempt_at END,requested_at,id
        FOR UPDATE SKIP LOCKED LIMIT 1`);
      const row = found.rows[0];
      if (!row) return null;
      const token = randomUUID();
      const updated = await client.query<DeletionRow>(`UPDATE committee_deletion_jobs SET status='IN_PROGRESS',
        attempts=attempts+1,claimed_at=now(),claim_token=$2,failure_code=NULL,failure_reason=NULL,updated_at=now()
        WHERE id=$1 RETURNING *`, [row.id, token]);
      return updated.rows[0] as DeletionRow;
    });
    if (!claimed) return null;

    try {
      const blockers = await this.blockers(claimed.id, claimed.committee_id);
      if (Object.values(blockers).some(value => value > 0)) {
        return this.retry(claimed, 'CLEANUP_PENDING', 'Provider or staging cleanup is still pending.');
      }
      return await this.purge(claimed);
    } catch {
      return this.retry(claimed, 'COMMITTEE_PURGE_FAILED', 'Committee purge failed.');
    }
  }

  private async enqueueBlobDeletes(client: PoolClient, committeeId: string): Promise<void> {
    await client.query(`INSERT INTO file_blob_delete_jobs
      (id,committee_id,file_entry_id,blob_id)
      SELECT gen_random_uuid(),blob.committee_id,reference.file_entry_id,blob.id
      FROM file_blobs blob JOIN LATERAL (
        SELECT version.file_entry_id FROM file_versions version WHERE version.blob_id=blob.id
        UNION
        SELECT version.file_entry_id FROM file_blob_copies copy
          JOIN file_versions version ON version.blob_id=copy.content_blob_id WHERE copy.copy_blob_id=blob.id
        UNION
        SELECT version.file_entry_id FROM storage_migration_items item
          JOIN file_versions version ON version.blob_id=item.content_blob_id WHERE item.target_blob_id=blob.id
        LIMIT 1
      ) reference ON true
      WHERE blob.committee_id=$1 AND blob.durability_state<>'DELETED'
      ON CONFLICT (blob_id) DO NOTHING`, [committeeId]);
    await client.query(`UPDATE file_blobs SET durability_state='DELETE_PENDING',updated_at=now()
      WHERE committee_id=$1 AND durability_state<>'DELETED'`, [committeeId]);
    const orphan = await client.query(`SELECT 1 FROM file_blobs blob
      WHERE blob.committee_id=$1 AND blob.durability_state<>'DELETED'
        AND NOT EXISTS (SELECT 1 FROM file_blob_delete_jobs job WHERE job.blob_id=blob.id) LIMIT 1`, [committeeId]);
    if (orphan.rowCount) {
      throw new AppError({code: 'SERVICE_NOT_READY', message: 'Stored file cleanup metadata is incomplete.'});
    }
  }

  private async blockers(jobId: string, committeeId: string): Promise<Record<keyof BlockerRow, number>> {
    const result = await this.pool.query<BlockerRow>(`SELECT
      (SELECT count(*)::int FROM file_blob_delete_jobs WHERE committee_id=$1 AND status<>'COMPLETED') AS blob_jobs,
      (SELECT count(*)::int FROM file_uploads WHERE committee_id=$1 AND staging_deleted_at IS NULL) AS upload_staging,
      (SELECT count(*)::int FROM storage_migration_items WHERE committee_id=$1 AND staging_deleted_at IS NULL) AS migration_staging,
      (SELECT count(*)::int FROM storage_agent_tasks WHERE committee_id=$1 AND content_staging_key IS NOT NULL
        AND staging_deleted_at IS NULL) AS agent_staging,
      (SELECT count(*)::int FROM committee_deletion_agent_tasks required
        JOIN storage_agent_tasks task ON task.id=required.task_id
        WHERE required.deletion_job_id=$2 AND task.status<>'COMPLETED') AS agent_deletes`, [committeeId, jobId]);
    const row = result.rows[0] as BlockerRow;
    return {blob_jobs: Number(row.blob_jobs), upload_staging: Number(row.upload_staging),
      migration_staging: Number(row.migration_staging), agent_staging: Number(row.agent_staging),
      agent_deletes: Number(row.agent_deletes)};
  }

  private async retry(claimed: DeletionRow, code: string, reason: string): Promise<CommitteeDeletionJob> {
    const result = await this.pool.query<DeletionRow>(`UPDATE committee_deletion_jobs SET status='RETRY',
      claimed_at=NULL,claim_token=NULL,failure_code=$3,failure_reason=$4,
      next_attempt_at=now()+(least(300,power(2,least(attempts,8)))::text||' seconds')::interval,updated_at=now()
      WHERE id=$1 AND status='IN_PROGRESS' AND claim_token=$2 RETURNING *`,
    [claimed.id, claimed.claim_token, code, reason]);
    return map(result.rows[0] ?? claimed);
  }

  private async purge(claimed: DeletionRow): Promise<CommitteeDeletionJob> {
    return transaction(this.pool, async client => {
      const current = await client.query<DeletionRow>(`SELECT * FROM committee_deletion_jobs
        WHERE id=$1 AND status='IN_PROGRESS' AND claim_token=$2 FOR UPDATE`, [claimed.id, claimed.claim_token]);
      if (!current.rows[0]) return map(claimed);
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      await client.query(`SELECT set_config('quorum.committee_purge_id',$1,true),
        set_config('quorum.committee_purge_token',$2,true)`, [claimed.committee_id, claimed.claim_token]);
      for (const query of COMMITTEE_PURGE_QUERIES) await client.query(query, [claimed.committee_id]);
      const completed = await client.query<DeletionRow>(`UPDATE committee_deletion_jobs SET status='COMPLETED',
        completed_at=now(),claimed_at=NULL,claim_token=NULL,failure_code=NULL,failure_reason=NULL,updated_at=now()
        WHERE id=$1 AND claim_token=$2 RETURNING *`, [claimed.id, claimed.claim_token]);
      return map(completed.rows[0] as DeletionRow);
    });
  }
}

export function startCommitteeDeletionWorker(service: Pick<Stage8DeletionService, 'processNext'>,
  logger: Logger, intervalMs = 1_000): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const run = async () => {
    if (stopped) return;
    try {
      while (!stopped && await service.processNext()) {
        // Durable claims serialize destructive work across application instances.
      }
    } catch (error) {
      logger.error('committee.deletion_worker.failed', {failureCode: 'COMMITTEE_DELETION_WORKER_FAILED', error});
    } finally {
      if (!stopped) { timer = setTimeout(() => void run(), intervalMs); timer.unref(); }
    }
  };
  void run();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
