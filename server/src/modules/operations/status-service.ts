import type {Pool} from 'pg';
import {AppError} from '../../http/errors.js';
import type {AuthenticatedSession} from '../identity/store.js';
import type {StorageCapacityMonitor} from '../storage/capacity.js';

export interface OperationsStatus {
  database: {schemaCompatibility: number; serverTime: string};
  storage: {state: 'normal' | 'warning' | 'critical'; usageRatio: number; availableBytes: number};
  accounts: Record<'active' | 'disabled' | 'anonymized', number>;
  committees: Record<'active' | 'paused' | 'archived' | 'deleting', number>;
  queues: {blobDelete: number; uploadStaging: number; migration: number; agentTasks: number; committeeDeletion: number};
  retention: {lastStatus: string | null; lastCompletedAt: string | null};
}

export class Stage8OperationsStatusService {
  constructor(private readonly pool: Pool, private readonly capacity: StorageCapacityMonitor) {}

  async status(auth: AuthenticatedSession): Promise<OperationsStatus> {
    if (auth.user.mustChangePassword || !auth.user.isSystemAdmin) {
      throw new AppError({code: 'FORBIDDEN', message: 'System administrator access is required.'});
    }
    const [summary, storage] = await Promise.all([
      this.pool.query<{
        schema_compatibility: number; server_time: Date; accounts: Record<string, number>;
        committees: Record<string, number>; blob_delete: number; upload_staging: number; migration: number;
        agent_tasks: number; committee_deletion: number; retention_status: string | null; retention_completed_at: Date | null;
      }>(`SELECT
        (SELECT schema_compatibility FROM quorum_meta.runtime_metadata WHERE singleton=true) AS schema_compatibility,
        now() AS server_time,
        (SELECT jsonb_build_object('active',count(*) FILTER (WHERE status='ACTIVE'),'disabled',count(*) FILTER (WHERE status='DISABLED'),
          'anonymized',count(*) FILTER (WHERE status='ANONYMIZED')) FROM users) AS accounts,
        (SELECT jsonb_build_object('active',count(*) FILTER (WHERE status='ACTIVE'),'paused',count(*) FILTER (WHERE status='PAUSED'),
          'archived',count(*) FILTER (WHERE status='ARCHIVED'),'deleting',count(*) FILTER (WHERE status='DELETING')) FROM committees) AS committees,
        (SELECT count(*)::int FROM file_blob_delete_jobs WHERE status<>'COMPLETED') AS blob_delete,
        (SELECT count(*)::int FROM file_uploads WHERE staging_deleted_at IS NULL) AS upload_staging,
        (SELECT count(*)::int FROM storage_migrations WHERE status NOT IN ('COMPLETED','CANCELLED')) AS migration,
        (SELECT count(*)::int FROM storage_agent_tasks WHERE status IN ('PENDING','IN_PROGRESS','RETRY')) AS agent_tasks,
        (SELECT count(*)::int FROM committee_deletion_jobs WHERE status<>'COMPLETED') AS committee_deletion,
        (SELECT status FROM operations_retention_runs ORDER BY completed_at DESC,id DESC LIMIT 1) AS retention_status,
        (SELECT completed_at FROM operations_retention_runs ORDER BY completed_at DESC,id DESC LIMIT 1) AS retention_completed_at`),
      this.capacity.sample()
    ]);
    const row = summary.rows[0];
    if (!row) throw new AppError({code: 'SERVICE_NOT_READY', message: 'Operations status is unavailable.'});
    return {
      database: {schemaCompatibility: row.schema_compatibility, serverTime: row.server_time.toISOString()},
      storage: {state: storage.state, usageRatio: storage.usageRatio, availableBytes: storage.availableBytes},
      accounts: row.accounts as OperationsStatus['accounts'],
      committees: row.committees as OperationsStatus['committees'],
      queues: {blobDelete: Number(row.blob_delete), uploadStaging: Number(row.upload_staging),
        migration: Number(row.migration), agentTasks: Number(row.agent_tasks), committeeDeletion: Number(row.committee_deletion)},
      retention: {lastStatus: row.retention_status,
        lastCompletedAt: row.retention_completed_at?.toISOString() ?? null}
    };
  }
}
