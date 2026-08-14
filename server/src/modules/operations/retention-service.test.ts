// @vitest-environment node

import {describe, expect, it, vi} from 'vitest';
import type {Pool, PoolClient} from 'pg';
import {createLogger} from '../../logger';
import {Stage8RetentionService} from './retention-service';

function setup(fail = false) {
  const sql: string[] = [];
  const client = {
    query: vi.fn(async (statement: string) => {
      sql.push(statement);
      if (statement.includes('pg_try_advisory')) return {rows: [{acquired: true}], rowCount: 1};
      if (fail && statement.startsWith('DELETE FROM sessions')) throw new Error('database unavailable');
      return {rows: [], rowCount: statement.startsWith('DELETE') ? 1 : 0};
    }),
    release: vi.fn()
  } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async () => ({rows: [], rowCount: 1}))
  } as unknown as Pool;
  return {pool, client, sql};
}

describe('stage 8 retention policy', () => {
  it('removes only expired ephemeral records under a singleton transaction lock', async () => {
    const fake = setup();
    const logs: string[] = [];
    const service = new Stage8RetentionService(fake.pool, {
      sessionDays: 30, identityIdempotencyDays: 30, secretDays: 7, registrationDays: 90
    }, createLogger(line => logs.push(line)), () => new Date('2026-08-14T00:00:00.000Z'));

    await expect(service.runOnce()).resolves.toEqual({sessions: 1, idempotencyKeys: 1,
      identityIdempotencyKeys: 1, pairingCodes: 1, seatInvitations: 1, registrationRequests: 1});
    const statements = fake.sql.join('\n');
    expect(statements).toContain('pg_try_advisory_xact_lock');
    expect(statements).toContain('DELETE FROM sessions');
    expect(statements).toContain('DELETE FROM idempotency_keys');
    expect(statements).toContain('DELETE FROM storage_pairing_codes');
    expect(statements).not.toMatch(/DELETE FROM (committee_events|audit_log|identity_audit_log|storage_agent_tasks)/);
    expect(statements).toContain('INSERT INTO operations_retention_runs');
    expect(logs.join('\n')).not.toContain('request_hash');
  });

  it('rolls back the sweep and records only a stable failure code', async () => {
    const fake = setup(true);
    const logs: string[] = [];
    const service = new Stage8RetentionService(fake.pool, {
      sessionDays: 30, identityIdempotencyDays: 30, secretDays: 7, registrationDays: 90
    }, createLogger(line => logs.push(line)), () => new Date('2026-08-14T00:00:00.000Z'));

    await expect(service.runOnce()).rejects.toThrow('database unavailable');
    expect(fake.sql).toContain('ROLLBACK');
    expect(fake.pool.query).toHaveBeenCalledWith(expect.stringContaining("'RETENTION_SWEEP_FAILED'"), expect.any(Array));
    expect(logs.join('\n')).toContain('RETENTION_SWEEP_FAILED');
    expect(logs.join('\n')).not.toContain('database unavailable');
  });
});
