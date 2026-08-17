import {randomUUID} from 'node:crypto';
import type {Pool, PoolClient} from 'pg';
import type {Logger} from '../../logger.js';

export interface RetentionPolicy {
  sessionDays: number;
  identityIdempotencyDays: number;
  secretDays: number;
  registrationDays: number;
}

export interface RetentionResult {
  sessions: number;
  idempotencyKeys: number;
  identityIdempotencyKeys: number;
  pairingCodes: number;
  seatInvitations: number;
  registrationRequests: number;
}

const DAY_MS = 86_400_000;

function cutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

async function remove(client: PoolClient, sql: string, values: unknown[]): Promise<number> {
  return (await client.query(sql, values)).rowCount ?? 0;
}

export class Stage8RetentionService {
  constructor(private readonly pool: Pool, private readonly policy: RetentionPolicy,
    private readonly logger: Logger, private readonly now: () => Date = () => new Date()) {}

  async runOnce(): Promise<RetentionResult | null> {
    const startedAt = this.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const lock = await client.query<{acquired: boolean}>(
        "SELECT pg_try_advisory_xact_lock(hashtext('quorum:retention')) AS acquired"
      );
      if (!lock.rows[0]?.acquired) {
        await client.query('COMMIT');
        return null;
      }
      const sessionCutoff = cutoff(startedAt, this.policy.sessionDays);
      const identityCutoff = cutoff(startedAt, this.policy.identityIdempotencyDays);
      const secretCutoff = cutoff(startedAt, this.policy.secretDays);
      const registrationCutoff = cutoff(startedAt, this.policy.registrationDays);
      const result: RetentionResult = {
        sessions: await remove(client,
          'DELETE FROM sessions WHERE COALESCE(revoked_at, expires_at) <= $1', [sessionCutoff]),
        idempotencyKeys: await remove(client, 'DELETE FROM idempotency_keys WHERE expires_at <= $1', [startedAt]),
        identityIdempotencyKeys: await remove(client,
          'DELETE FROM identity_idempotency_keys WHERE created_at <= $1', [identityCutoff]),
        pairingCodes: await remove(client, `DELETE FROM storage_pairing_codes
          WHERE COALESCE(used_at, revoked_at, expires_at) <= $1
            AND (used_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at <= $2)`, [secretCutoff, startedAt]),
        seatInvitations: await remove(client, `DELETE FROM seat_invitations
          WHERE expires_at <= $1 OR (revoked_at IS NOT NULL AND revoked_at <= $1)`, [secretCutoff]),
        registrationRequests: await remove(client, `DELETE FROM registration_requests
          WHERE status IN ('APPROVED','REJECTED','CANCELLED') AND decided_at <= $1`, [registrationCutoff])
      };
      await client.query(`INSERT INTO operations_retention_runs
        (id,status,deleted_counts,started_at,completed_at) VALUES ($1,'COMPLETED',$2,$3,$4)`,
      [randomUUID(), result, startedAt, this.now()]);
      await client.query('COMMIT');
      this.logger.info('operations.retention.completed', {deletedCounts: result});
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      try {
        await this.pool.query(`INSERT INTO operations_retention_runs
          (id,status,deleted_counts,failure_code,started_at,completed_at)
          VALUES ($1,'FAILED','{}'::jsonb,'RETENTION_SWEEP_FAILED',$2,$3)`,
        [randomUUID(), startedAt, this.now()]);
      } catch {}
      this.logger.error('operations.retention.failed', {failureCode: 'RETENTION_SWEEP_FAILED'});
      throw error;
    } finally {
      client.release();
    }
  }

  async renderMetrics(): Promise<string> {
    const result = await this.pool.query<{status: string; count: number; latest: Date | null}>(`SELECT status,
      count(*)::int AS count,max(completed_at) AS latest FROM operations_retention_runs GROUP BY status`);
    const counts = new Map(result.rows.map(row => [row.status, Number(row.count)]));
    const latest = result.rows.reduce((value, row) => Math.max(value, row.latest?.getTime() ?? 0), 0);
    return [
      '# TYPE quorum_retention_runs_total counter',
      `quorum_retention_runs_total{outcome="completed"} ${counts.get('COMPLETED') ?? 0}`,
      `quorum_retention_runs_total{outcome="failed"} ${counts.get('FAILED') ?? 0}`,
      '# TYPE quorum_retention_last_run_timestamp_seconds gauge',
      `quorum_retention_last_run_timestamp_seconds ${Math.floor(latest / 1000)}`,
      ''
    ].join('\n');
  }
}

export function startRetentionWorker(service: Pick<Stage8RetentionService, 'runOnce'>, logger: Logger,
  intervalMs = 60 * 60_000): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const run = async () => {
    if (stopped) return;
    try { await service.runOnce(); } catch {}
    if (!stopped) {
      timer = setTimeout(() => void run(), intervalMs);
      timer.unref();
    }
  };
  void run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    logger.debug('operations.retention.stopped');
  };
}
