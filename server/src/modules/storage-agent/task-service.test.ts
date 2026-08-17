// @vitest-environment node

import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {PoolClient} from 'pg';
import type {Stage4CommitteeRow} from '../stage4/database';
import type {Stage6FileService} from '../storage/file-service';
import {DurableStagingStore} from '../storage/staging';
import type {Stage7StorageAgentService} from './service';
import {Stage7StorageTaskService, type StorageAgentTaskCompletionFinalizer} from './task-service';

const roots: string[] = [];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const committeeId = '10000000-0000-4000-8000-000000000001';
const hostId = '20000000-0000-4000-8000-000000000001';
const taskId = '30000000-0000-4000-8000-000000000001';
const entryId = '40000000-0000-4000-8000-000000000001';
const blobId = '50000000-0000-4000-8000-000000000001';
const claimToken = '60000000-0000-4000-8000-000000000001';
const requestId = '70000000-0000-4000-8000-000000000001';

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(path => rm(path, {recursive: true, force: true})));
});

function taskRow(content: string) {
  const now = new Date('2026-08-13T00:00:00.000Z');
  return {id: taskId, committee_id: committeeId, host_id: hostId, lease_generation: '2', sequence: '1',
    task_type: 'UPLOAD_BLOB', file_entry_id: entryId, file_revision: 3, blob_id: blobId,
    expected_size_bytes: String(Buffer.byteLength(content)), expected_sha256_hex: digest(content),
    content_staging_key: 'agent-uploads/30/30000000000040008000000000000001', content_state: 'NONE',
    source_upload_id: null as string | null,
    received_size_bytes: null, actual_sha256_hex: null, status: 'IN_PROGRESS', revision: 2, attempts: 1,
    next_attempt_at: now, claimed_at: now, claim_request_id: requestId, claim_token: claimToken,
    terminal_request_id: null, terminal_outcome: null, failure_code: null, created_at: now, updated_at: now};
}

async function fixture(content = 'agent-stream', finalizer?: StorageAgentTaskCompletionFinalizer) {
  const root = await mkdtemp(join(tmpdir(), 'quorum-agent-task-')); roots.push(root);
  const staging = new DurableStagingStore(root, 64, 80); await staging.initialize();
  const row = taskRow(content);
  const client = {query: vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('FROM storage_agent_tasks') && sql.includes('FOR UPDATE')) return {rows: [row]};
    if (sql.includes("SET content_state='RECEIVING'")) {
      row.content_state = 'RECEIVING'; row.revision += 1; return {rows: [row]};
    }
    if (sql.includes("SET content_state='STAGED'")) {
      row.content_state = 'STAGED'; row.received_size_bytes = values?.[1] as number;
      row.actual_sha256_hex = values?.[2] as string; row.revision += 1; return {rows: [row]};
    }
    if (sql.includes("SET status='RETRY'")) {
      row.status = 'RETRY'; row.content_state = 'NONE'; row.claimed_at = null; row.claim_request_id = null;
      row.claim_token = null; row.failure_code = values?.[1] as string; row.revision += 1; return {rows: [row]};
    }
    if (sql.includes('SET status=$2')) {
      row.status = values?.[1] as string; row.terminal_request_id = values?.[2] as string;
      row.terminal_outcome = values?.[1] as string; row.claim_token = null; row.revision += 1;
      return {rows: [row]};
    }
    return {rows: []};
  })} as unknown as PoolClient;
  const committee = {id: committeeId, next_event_sequence: 1} as Stage4CommitteeRow;
  const withCurrentLease = vi.fn(async (_credential, generation, work) => work(client,
    {hostId, committeeId, deviceId: 'device', leaseGeneration: generation, status: 'ACTIVE'}, committee));
  const agent = {withCurrentLease} as unknown as Stage7StorageAgentService;
  const files = {} as Stage6FileService;
  return {service: new Stage7StorageTaskService(agent, staging, files, undefined, finalizer),
    staging, row, client, withCurrentLease};
}

describe('storage Agent durable task state machine', () => {
  it('streams and verifies task content before exposing a staged result', async () => {
    const value = await fixture();
    const result = await value.service.receiveContent('credential', {taskId, leaseGeneration: 2, fileRevision: 3,
      claimToken, expectedSha256: digest('agent-stream'), contentLength: 12,
      source: (async function* () {yield 'agent-'; yield 'stream';})(),
      context: {requestId: 'stream', userAgent: 'Vitest'}});
    expect(result).toMatchObject({status: 'IN_PROGRESS', contentState: 'STAGED', receivedSizeBytes: 12,
      actualSha256: digest('agent-stream')});
    expect(await value.staging.verify(value.row.content_staging_key, 12, digest('agent-stream')))
      .toEqual({sizeBytes: 12, sha256: digest('agent-stream')});
    expect(value.withCurrentLease).toHaveBeenCalledWith('credential', 2, expect.any(Function));
  });

  it('moves an interrupted or mismatched stream to retry without publishing partial content', async () => {
    const value = await fixture();
    await expect(value.service.receiveContent('credential', {taskId, leaseGeneration: 2, fileRevision: 3,
      claimToken, expectedSha256: digest('agent-stream'), contentLength: 12,
      source: (async function* () {yield 'wrong-stream';})(),
      context: {requestId: 'failure', userAgent: 'Vitest'}})).rejects.toMatchObject({code: 'VALIDATION_FAILED'});
    expect(value.row).toMatchObject({status: 'RETRY', content_state: 'NONE', failure_code: 'UPLOAD_HASH_MISMATCH'});
    expect(await value.staging.exists(value.row.content_staging_key)).toBe(false);
  });

  it('requires verified staged bytes before completing an upload task', async () => {
    const value = await fixture();
    await expect(value.service.complete('credential', taskId, {leaseGeneration: 2, fileRevision: 3,
      claimToken, requestId}, {requestId: 'complete', userAgent: 'Vitest'}))
      .rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    expect(value.row.status).toBe('IN_PROGRESS');
  });

  it('finalizes provider metadata before making a verified upload task terminal', async () => {
    const finalize = vi.fn(async (client: PoolClient) => {
      expect((client.query as ReturnType<typeof vi.fn>).mock.calls.some(call =>
        String(call[0]).includes('SET status=$2'))).toBe(false);
    });
    const value = await fixture('agent-stream', {finalize});
    value.row.content_state = 'STAGED';
    value.row.received_size_bytes = 12;
    value.row.actual_sha256_hex = digest('agent-stream');
    value.row.source_upload_id = '80000000-0000-4000-8000-000000000001';
    await expect(value.service.complete('credential', taskId, {leaseGeneration: 2, fileRevision: 3,
      claimToken, requestId}, {requestId: 'complete', userAgent: 'Vitest'}))
      .resolves.toMatchObject({status: 'COMPLETED'});
    expect(finalize).toHaveBeenCalledOnce();
  });
});
