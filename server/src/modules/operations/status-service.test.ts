// @vitest-environment node

import {describe, expect, it, vi} from 'vitest';
import type {Pool} from 'pg';
import {Stage8OperationsStatusService} from './status-service';

const admin = {sessionId: 'session', user: {id: '10000000-0000-4000-8000-000000000001', email: 'admin@example.com',
  displayName: 'Admin', status: 'ACTIVE' as const, isSystemAdmin: true, sessionVersion: 1,
  mustChangePassword: false, createdAt: '2026-08-14T00:00:00Z', disabledAt: null}};

describe('stage 8 operations status', () => {
  it('returns fixed aggregate fields without identifiers or provider paths', async () => {
    const pool = {query: vi.fn(async () => ({rows: [{schema_compatibility: 26,
      server_time: new Date('2026-08-14T00:00:00Z'), accounts: {active: 2, disabled: 1, anonymized: 1},
      committees: {active: 1, paused: 0, archived: 2, deleting: 0}, blob_delete: 3, upload_staging: 4,
      migration: 0, agent_tasks: 2, committee_deletion: 0, retention_status: 'COMPLETED',
      retention_completed_at: new Date('2026-08-13T00:00:00Z')}]}))} as unknown as Pool;
    const capacity = {sample: vi.fn(async () => ({state: 'warning' as const, usageRatio: 0.82,
      availableBytes: 100, totalBytes: 1000, usedBytes: 900, sampledAt: new Date()}))};
    const service = new Stage8OperationsStatusService(pool, capacity as never);
    const result = await service.status(admin);
    expect(result).toEqual(expect.objectContaining({storage: expect.objectContaining({state: 'warning'}),
      queues: {blobDelete: 3, uploadStaging: 4, migration: 0, agentTasks: 2, committeeDeletion: 0}}));
    expect(JSON.stringify(result)).not.toMatch(/storageKey|email|path|credential/i);
  });

  it('does not grant status access to an ordinary account', async () => {
    const service = new Stage8OperationsStatusService({} as Pool, {} as never);
    await expect(service.status({...admin, user: {...admin.user, isSystemAdmin: false}}))
      .rejects.toMatchObject({code: 'FORBIDDEN'});
  });
});
