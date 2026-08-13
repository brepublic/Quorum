import {randomUUID} from 'node:crypto';
import type {Pool, PoolClient, QueryResultRow} from 'pg';
import type {Logger} from '../../logger.js';
import type {StorageCapacityGuard, StorageCapacitySnapshot} from './capacity.js';
import type {Stage6FileService} from './file-service.js';
import type {DurableStagingStore} from './staging.js';
import {UploadStreamError} from './staging.js';
import {transaction} from '../stage4/database.js';

type CleanupKind = 'FILE_UPLOAD_STAGING' | 'MIGRATION_STAGING';

interface CleanupCandidate extends QueryResultRow {
  kind: CleanupKind;
  id: string;
  staging_key: string;
  claim_token: string;
}

export interface StorageMaintenanceResult {
  kind: CleanupKind | 'BLOB_DELETE';
  outcome: 'SUCCEEDED' | 'FAILED';
  failureCode: string | null;
}

export interface StorageMetricsProvider {
  renderMetrics(): Promise<string>;
}

function metric(value: number): string {
  return Number.isFinite(value) ? String(value) : '0';
}

export class Stage6MaintenanceService implements StorageMetricsProvider {
  constructor(private readonly pool: Pool, private readonly staging: DurableStagingStore,
    private readonly files: Pick<Stage6FileService, 'processNextDeleteJob'>,
    private readonly capacity: StorageCapacityGuard, private readonly logger: Logger) {}

  async processNext(): Promise<StorageMaintenanceResult | null> {
    const deleted = await this.files.processNextDeleteJob();
    if (deleted) {
      const result: StorageMaintenanceResult = {kind: 'BLOB_DELETE',
        outcome: deleted.status === 'COMPLETED' ? 'SUCCEEDED' : 'FAILED', failureCode: deleted.failureCode};
      this.logResult(result);
      return result;
    }
    const candidate = await this.claimStaging();
    if (!candidate) return null;
    try {
      await this.staging.remove(candidate.staging_key);
      const completed = await this.finishStaging(candidate);
      if (completed) this.logResult(completed);
      return completed;
    } catch (error) {
      const failed = await this.failStaging(candidate, error);
      if (failed) this.logResult(failed);
      return failed;
    }
  }

  async renderMetrics(): Promise<string> {
    let capacity: StorageCapacitySnapshot | undefined;
    try {
      capacity = await this.capacity.sample();
    } catch {}
    const queues = await this.pool.query<{blob_delete: number; upload_staging: number; migration_staging: number}>(`SELECT
      (SELECT count(*)::int FROM file_blob_delete_jobs WHERE status<>'COMPLETED') AS blob_delete,
      (SELECT count(*)::int FROM file_uploads WHERE staging_deleted_at IS NULL
        AND (status IN ('COMMITTED','CANCELLED') OR (status='FAILED' AND expires_at<=now()))) AS upload_staging,
      (SELECT count(*)::int FROM storage_migration_items WHERE staging_deleted_at IS NULL
        AND status IN ('COMPLETED','CANCELLED')) AS migration_staging`);
    const audits = await this.pool.query<{resource_type: string; outcome: string; count: number}>(`SELECT
      resource_type,outcome,count(*)::int AS count FROM storage_cleanup_audit GROUP BY resource_type,outcome`);
    const totals = new Map(audits.rows.map(row => [`${row.resource_type}:${row.outcome}`, Number(row.count)]));
    const state = capacity?.state;
    const lines = [
      '# TYPE quorum_storage_capacity_sample_success gauge',
      `quorum_storage_capacity_sample_success ${capacity ? 1 : 0}`,
      '# TYPE quorum_storage_usage_ratio gauge',
      `quorum_storage_usage_ratio ${metric(capacity?.usageRatio ?? 0)}`,
      '# TYPE quorum_storage_available_bytes gauge',
      `quorum_storage_available_bytes ${metric(capacity?.availableBytes ?? 0)}`,
      '# TYPE quorum_storage_capacity_state gauge',
      ...(['normal', 'warning', 'critical'] as const).map(value =>
        `quorum_storage_capacity_state{state="${value}"} ${state === value ? 1 : 0}`),
      '# TYPE quorum_storage_cleanup_queue gauge',
      `quorum_storage_cleanup_queue{kind="blob_delete"} ${Number(queues.rows[0]?.blob_delete ?? 0)}`,
      `quorum_storage_cleanup_queue{kind="upload_staging"} ${Number(queues.rows[0]?.upload_staging ?? 0)}`,
      `quorum_storage_cleanup_queue{kind="migration_staging"} ${Number(queues.rows[0]?.migration_staging ?? 0)}`,
      '# TYPE quorum_storage_cleanup_total counter'
    ];
    for (const kind of ['BLOB_DELETE', 'FILE_UPLOAD_STAGING', 'MIGRATION_STAGING']) {
      for (const outcome of ['SUCCEEDED', 'FAILED']) {
        lines.push(`quorum_storage_cleanup_total{kind="${kind.toLowerCase()}",outcome="${outcome.toLowerCase()}"} ${totals.get(`${kind}:${outcome}`) ?? 0}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  private async claimStaging(): Promise<CleanupCandidate | null> {
    return transaction(this.pool, async client => {
      const upload = await client.query<{id: string; staging_key: string}>(`SELECT id,staging_key FROM file_uploads
        WHERE staging_deleted_at IS NULL
          AND (status IN ('COMMITTED','CANCELLED') OR (status='FAILED' AND expires_at<=now()))
          AND cleanup_next_attempt_at<=now()
          AND (cleanup_claimed_at IS NULL OR cleanup_claimed_at<=now()-interval '5 minutes')
        ORDER BY cleanup_next_attempt_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`);
      if (upload.rows[0]) return this.claim(client, 'FILE_UPLOAD_STAGING', upload.rows[0]);
      const migration = await client.query<{id: string; staging_key: string}>(`SELECT id,staging_key
        FROM storage_migration_items WHERE staging_deleted_at IS NULL AND status IN ('COMPLETED','CANCELLED')
          AND cleanup_next_attempt_at<=now()
          AND (cleanup_claimed_at IS NULL OR cleanup_claimed_at<=now()-interval '5 minutes')
        ORDER BY cleanup_next_attempt_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`);
      return migration.rows[0] ? this.claim(client, 'MIGRATION_STAGING', migration.rows[0]) : null;
    });
  }

  private async claim(client: PoolClient, kind: CleanupKind,
    row: {id: string; staging_key: string}): Promise<CleanupCandidate> {
    const table = kind === 'FILE_UPLOAD_STAGING' ? 'file_uploads' : 'storage_migration_items';
    const token = randomUUID();
    await client.query(`UPDATE ${table} SET cleanup_attempts=cleanup_attempts+1,cleanup_claimed_at=now(),
      cleanup_claim_token=$2,cleanup_failure_code=NULL,cleanup_failure_reason=NULL,updated_at=now() WHERE id=$1`,
    [row.id, token]);
    return {kind, id: row.id, staging_key: row.staging_key, claim_token: token};
  }

  private async finishStaging(candidate: CleanupCandidate): Promise<StorageMaintenanceResult | null> {
    return transaction(this.pool, async client => {
      const table = candidate.kind === 'FILE_UPLOAD_STAGING' ? 'file_uploads' : 'storage_migration_items';
      const completed = await client.query(`UPDATE ${table} SET staging_deleted_at=now(),cleanup_claimed_at=NULL,
        cleanup_claim_token=NULL,cleanup_failure_code=NULL,cleanup_failure_reason=NULL,updated_at=now()
        WHERE id=$1 AND cleanup_claim_token=$2 AND staging_deleted_at IS NULL RETURNING id`,
      [candidate.id, candidate.claim_token]);
      if (!completed.rowCount) return null;
      await client.query(`INSERT INTO storage_cleanup_audit (resource_type,resource_id,outcome)
        VALUES ($1,$2,'SUCCEEDED')`, [candidate.kind, candidate.id]);
      return {kind: candidate.kind, outcome: 'SUCCEEDED', failureCode: null};
    });
  }

  private async failStaging(candidate: CleanupCandidate, error: unknown): Promise<StorageMaintenanceResult | null> {
    const failureCode = error instanceof UploadStreamError ? error.failureCode : 'STAGING_CLEANUP_FAILED';
    const failureReason = error instanceof Error ? error.message.slice(0, 240) : 'Staging cleanup failed.';
    return transaction(this.pool, async client => {
      const table = candidate.kind === 'FILE_UPLOAD_STAGING' ? 'file_uploads' : 'storage_migration_items';
      const failed = await client.query(`UPDATE ${table} SET cleanup_claimed_at=NULL,cleanup_claim_token=NULL,
        cleanup_failure_code=$3,cleanup_failure_reason=$4,
        cleanup_next_attempt_at=now()+(least(300,power(2,least(cleanup_attempts,8)))::text||' seconds')::interval,
        updated_at=now() WHERE id=$1 AND cleanup_claim_token=$2 AND staging_deleted_at IS NULL RETURNING id`,
      [candidate.id, candidate.claim_token, failureCode.slice(0, 80), failureReason]);
      if (!failed.rowCount) return null;
      await client.query(`INSERT INTO storage_cleanup_audit (resource_type,resource_id,outcome,failure_code)
        VALUES ($1,$2,'FAILED',$3)`, [candidate.kind, candidate.id, failureCode.slice(0, 80)]);
      return {kind: candidate.kind, outcome: 'FAILED', failureCode: failureCode.slice(0, 80)};
    });
  }

  private logResult(result: StorageMaintenanceResult): void {
    const fields = {kind: result.kind, outcome: result.outcome, failureCode: result.failureCode};
    if (result.outcome === 'SUCCEEDED') this.logger.info('storage.cleanup.completed', fields);
    else this.logger.warn('storage.cleanup.failed', fields);
  }
}

export function startStorageMaintenanceWorker(service: Pick<Stage6MaintenanceService, 'processNext'>,
  logger: Logger, intervalMs = 1_000): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => void run(), intervalMs);
    timer.unref();
  };
  const run = async () => {
    if (stopped) return;
    try {
      while (!stopped && await service.processNext()) {
        // Drain durable cleanup serially; database claims coordinate multiple application instances.
      }
    } catch {
      logger.error('storage.cleanup_worker.failed', {failureCode: 'STORAGE_CLEANUP_WORKER_FAILED'});
    } finally {
      schedule();
    }
  };
  void run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
