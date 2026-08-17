// @vitest-environment node

import {describe, expect, it, vi} from 'vitest';
import {COMMITTEE_PURGE_QUERIES, Stage8DeletionService} from './deletion-service';

const committeeId = '20000000-0000-4000-8000-000000000001';
const ownerId = '10000000-0000-4000-8000-000000000001';
const auth = {sessionId: 'session', user: {id: ownerId, email: 'owner@example.com', displayName: 'Owner',
  status: 'ACTIVE', isSystemAdmin: false, sessionVersion: 1, mustChangePassword: false,
  createdAt: '2026-08-14T00:00:00.000Z', disabledAt: null}} as const;
const context = {requestId: 'delete-request', sourceIp: '127.0.0.1', userAgent: 'Vitest'};
const requestedAt = new Date('2026-08-14T01:00:00.000Z');

function requestDatabase(options: {name?: string; ownerId?: string; status?: string; chairUnavailable?: boolean;
  orphan?: boolean} = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT * FROM committees')) return {rows: [{id: committeeId,
      owner_user_id: options.ownerId ?? ownerId, name: options.name ?? 'Security Council', status: options.status ?? 'ARCHIVED',
      revision: 8, next_event_sequence: 4, active_storage_binding_id: null}]};
    if (sql.includes('FROM idempotency_keys')) return {rows: []};
    if (sql.includes('binding.provider_type=\'CHAIR_AGENT\'')) return {rows: options.chairUnavailable ? [{value: 1}] : [],
      rowCount: options.chairUnavailable ? 1 : 0};
    if (sql.startsWith('INSERT INTO committee_deletion_jobs')) return {rows: [{id: '30000000-0000-4000-8000-000000000001',
      committee_id: committeeId, status: 'PENDING', requested_at: requestedAt, completed_at: null, failure_code: null}]};
    if (sql.startsWith("UPDATE committees SET status='DELETING'")) return {rows: [{revision: 9}]};
    if (sql.startsWith('UPDATE file_entries')) return {rows: [{id: '40000000-0000-4000-8000-000000000001',
      last_content_revision: 2}]};
    if (sql.includes('NOT EXISTS (SELECT 1 FROM file_blob_delete_jobs')) return {rows: options.orphan ? [{value: 1}] : [],
      rowCount: options.orphan ? 1 : 0};
    return {rows: [], rowCount: 0};
  });
  const client = {query, release: vi.fn()};
  return {pool: {connect: vi.fn(async () => client)}, query, client};
}

function workerDatabase(options: {blockers?: Partial<Record<'blob_jobs' | 'upload_staging' | 'migration_staging'
  | 'agent_staging' | 'agent_deletes', number>>; failPurgeAt?: string} = {}) {
  const base = {id: '30000000-0000-4000-8000-000000000001', committee_id: committeeId,
    status: 'PENDING', requested_at: requestedAt, completed_at: null, failure_code: null, attempts: 0,
    claim_token: null};
  const clientQuery = vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT * FROM committee_deletion_jobs') && sql.includes('FOR UPDATE SKIP LOCKED')) {
      return {rows: [base]};
    }
    if (sql.startsWith("UPDATE committee_deletion_jobs SET status='IN_PROGRESS'")) {
      return {rows: [{...base, status: 'IN_PROGRESS', attempts: 1,
        claim_token: '40000000-0000-4000-8000-000000000001'}]};
    }
    if (sql.startsWith('SELECT * FROM committee_deletion_jobs') && sql.includes('WHERE id=$1')) {
      return {rows: [{...base, status: 'IN_PROGRESS', attempts: 1,
        claim_token: '40000000-0000-4000-8000-000000000001'}]};
    }
    if (options.failPurgeAt && sql.includes(options.failPurgeAt)) throw new Error('injected purge failure');
    if (sql.startsWith("UPDATE committee_deletion_jobs SET status='COMPLETED'")) {
      return {rows: [{...base, status: 'COMPLETED', attempts: 1, claim_token: null,
        completed_at: new Date('2026-08-14T02:00:00.000Z')}]};
    }
    return {rows: []};
  });
  const poolQuery = vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT\n')) return {rows: [{blob_jobs: 0, upload_staging: 0, migration_staging: 0,
      agent_staging: 0, agent_deletes: 0, ...options.blockers}]};
    if (sql.startsWith("UPDATE committee_deletion_jobs SET status='RETRY'")) return {rows: [{...base,
      status: 'RETRY', attempts: 1, claim_token: null, failure_code: options.failPurgeAt
        ? 'COMMITTEE_PURGE_FAILED' : 'CLEANUP_PENDING'}]};
    return {rows: []};
  });
  const client = {query: clientQuery, release: vi.fn()};
  return {pool: {connect: vi.fn(async () => client), query: poolQuery}, clientQuery, poolQuery};
}

describe('stage 8 durable committee deletion', () => {
  it('requires the archived Owner, current revision, and an exact committee name', async () => {
    const wrongName = requestDatabase();
    await expect(new Stage8DeletionService(wrongName.pool as never).requestDeletion(auth, committeeId,
      {baseRevision: 8, confirmationName: 'security council'}, 'key', context))
      .rejects.toMatchObject({code: 'VALIDATION_FAILED'});
    expect(wrongName.query).toHaveBeenCalledWith('ROLLBACK');
    expect(wrongName.query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT INTO committee_deletion_jobs'))).toBe(false);

    const active = requestDatabase({status: 'ACTIVE'});
    await expect(new Stage8DeletionService(active.pool as never).requestDeletion(auth, committeeId,
      {baseRevision: 8, confirmationName: 'Security Council'}, 'key', context))
      .rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    const outsider = requestDatabase({ownerId: '50000000-0000-4000-8000-000000000001'});
    await expect(new Stage8DeletionService(outsider.pool as never).requestDeletion(auth, committeeId,
      {baseRevision: 8, confirmationName: 'Security Council'}, 'key', context))
      .rejects.toMatchObject({code: 'NOT_FOUND'});
  });

  it('atomically freezes writes, cancels transient work, tombstones files, and queues every blob', async () => {
    const value = requestDatabase();
    const result = await new Stage8DeletionService(value.pool as never).requestDeletion(auth, committeeId,
      {baseRevision: 8, confirmationName: 'Security Council'}, 'same-key', context);
    expect(result).toEqual(expect.objectContaining({committeeId, status: 'PENDING'}));
    const sql = value.query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain("UPDATE committees SET status='DELETING'");
    expect(sql).toContain("UPDATE storage_agent_tasks SET status='CANCELLED'");
    expect(sql).toContain("UPDATE file_uploads SET status='CANCELLED'");
    expect(sql).toContain("UPDATE storage_migration_items SET status='CANCELLED'");
    expect(sql).toContain("SET status='DELETED',current_version_id=NULL");
    expect(sql).toContain('INSERT INTO file_tombstones');
    expect(sql).toContain('INSERT INTO file_blob_delete_jobs');
    expect(value.query).toHaveBeenCalledWith('COMMIT');
  });

  it('rolls back if Chair storage is unavailable or any blob lacks cleanup metadata', async () => {
    const unavailable = requestDatabase({chairUnavailable: true});
    await expect(new Stage8DeletionService(unavailable.pool as never).requestDeletion(auth, committeeId,
      {baseRevision: 8, confirmationName: 'Security Council'}, 'key', context))
      .rejects.toMatchObject({code: 'SERVICE_NOT_READY'});
    expect(unavailable.query).toHaveBeenCalledWith('ROLLBACK');

    const orphan = requestDatabase({orphan: true});
    await expect(new Stage8DeletionService(orphan.pool as never).requestDeletion(auth, committeeId,
      {baseRevision: 8, confirmationName: 'Security Council'}, 'key', context))
      .rejects.toMatchObject({code: 'SERVICE_NOT_READY'});
    expect(orphan.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('keeps the database purge explicit, scoped, and after every cleanup blocker', () => {
    const contract = COMMITTEE_PURGE_QUERIES.join('\n');
    expect(contract).toContain('DELETE FROM file_blob_delete_jobs');
    expect(contract).toContain('DELETE FROM storage_agent_tasks');
    expect(contract).toContain('DELETE FROM audit_log');
    expect(COMMITTEE_PURGE_QUERIES.at(-1)).toBe('DELETE FROM committees WHERE id=$1');
    expect(COMMITTEE_PURGE_QUERIES.indexOf('DELETE FROM audit_log WHERE committee_id=$1'))
      .toBeLessThan(COMMITTEE_PURGE_QUERIES.indexOf('DELETE FROM committee_seats WHERE committee_id=$1'));
  });

  it('retries without purging while provider, staging, or required Agent cleanup remains', async () => {
    const value = workerDatabase({blockers: {agent_deletes: 1}});
    await expect(new Stage8DeletionService(value.pool as never).processNext())
      .resolves.toEqual(expect.objectContaining({status: 'RETRY', failureCode: 'CLEANUP_PENDING'}));
    expect(value.clientQuery.mock.calls.some(([sql]) => String(sql) === 'DELETE FROM committees WHERE id=$1')).toBe(false);
  });

  it('purges all committee data and completes the durable job in one transaction after cleanup', async () => {
    const value = workerDatabase();
    await expect(new Stage8DeletionService(value.pool as never).processNext())
      .resolves.toEqual(expect.objectContaining({status: 'COMPLETED'}));
    expect(value.clientQuery).toHaveBeenCalledWith('SET CONSTRAINTS ALL DEFERRED');
    expect(value.clientQuery).toHaveBeenCalledWith('DELETE FROM committees WHERE id=$1', [committeeId]);
    expect(value.clientQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('rolls back a partial database purge and leaves the durable job retryable', async () => {
    const value = workerDatabase({failPurgeAt: 'DELETE FROM ballots'});
    await expect(new Stage8DeletionService(value.pool as never).processNext())
      .resolves.toEqual(expect.objectContaining({status: 'RETRY', failureCode: 'COMMITTEE_PURGE_FAILED'}));
    expect(value.clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(value.poolQuery).toHaveBeenCalledWith(expect.stringContaining("status='RETRY'"), expect.any(Array));
  });
});
