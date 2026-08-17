// @vitest-environment node

import {describe, expect, it, vi} from 'vitest';
import {ARCHIVE_SECTIONS, Stage8ArchiveService} from './archive-service';

const auth = {sessionId: 'session', user: {id: '10000000-0000-4000-8000-000000000001', email: 'owner@example.com',
  displayName: 'Owner', status: 'ACTIVE', isSystemAdmin: false, sessionVersion: 1, mustChangePassword: false,
  createdAt: '2026-08-13T00:00:00.000Z', disabledAt: null}} as const;
const committeeId = '20000000-0000-4000-8000-000000000001';

function database(options: {ownerId?: string; status?: string; failSection?: string} = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') return {rows: []};
    if (sql.includes('FROM committees WHERE id=$1')) return {rows: [{id: committeeId,
      owner_user_id: options.ownerId ?? auth.user.id, name: '委员会', chair_label: '主席', topic: '议题', conference: '大会',
      visibility: 'PRIVATE', operation_mode: 'DELEGATE_OPERATED', status: options.status ?? 'ARCHIVED', revision: 4,
      created_at: new Date('2026-08-12T00:00:00Z'), archived_at: new Date('2026-08-13T00:00:00Z')}]};
    const section = ARCHIVE_SECTIONS.find(item => sql.startsWith(item.query));
    if (section?.name === options.failSection) throw new Error('database secret and SQL stack');
    if (section?.name === 'file_versions') return {rows: [{id: 'version', file_entry_id: 'file', version_number: 1,
      original_name: '议案.pdf', media_type: 'application/pdf', size_bytes: '12', sha256: 'abcd', created_at: new Date()}]};
    return {rows: []};
  });
  const release = vi.fn(); const client = {query, release};
  const pool = {connect: vi.fn(async () => client)};
  return {pool, client, query, release};
}

async function text(stream: NodeJS.ReadableStream): Promise<string> {
  let result = ''; for await (const chunk of stream) result += chunk.toString(); return result;
}

describe('stage 8 archived committee export', () => {
  it('streams a repeatable-read JSONL snapshot with file hashes but no secret-bearing columns', async () => {
    const value = database(); const service = new Stage8ArchiveService(value.pool as never,
      () => new Date('2026-08-13T08:00:00Z'));
    const exported = await service.exportCommittee(auth, committeeId); const body = await text(exported.content);
    const records = body.trim().split('\n').map(line => JSON.parse(line));
    expect(exported.fileName).toBe(`quorum-committee-${committeeId}.jsonl`);
    expect(records[0]).toEqual(expect.objectContaining({type: 'manifest', schemaVersion: 1,
      committee: expect.objectContaining({status: 'ARCHIVED'})}));
    expect(records).toContainEqual(expect.objectContaining({type: 'record', section: 'file_versions',
      record: expect.objectContaining({sha256: 'abcd'})}));
    expect(records.at(-1)).toEqual(expect.objectContaining({type: 'complete', recordCount: 1}));
    expect(value.query.mock.calls[0]?.[0]).toBe('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(value.query).toHaveBeenCalledWith('COMMIT'); expect(value.release).toHaveBeenCalledOnce();
    const contract = ARCHIVE_SECTIONS.map(item => item.query).join('\n').toLowerCase();
    for (const forbidden of ['code_hash', 'credential_hash', 'token_hash', 'source_ip_hash', 'storage_key',
      'device_credential', 'private_key', 'anonymous_access_token_hash']) expect(contract).not.toContain(forbidden);
  });

  it('returns not found across the owner boundary and requires an archived state', async () => {
    const other = database({ownerId: '30000000-0000-4000-8000-000000000001'});
    await expect(new Stage8ArchiveService(other.pool as never).exportCommittee(auth, committeeId))
      .rejects.toMatchObject({code: 'NOT_FOUND'});
    expect(other.query).toHaveBeenCalledWith('ROLLBACK'); expect(other.release).toHaveBeenCalledOnce();
    const active = database({status: 'ACTIVE'});
    await expect(new Stage8ArchiveService(active.pool as never).exportCommittee(auth, committeeId))
      .rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
  });

  it('rolls back and releases the snapshot if streaming fails', async () => {
    const value = database({failSection: 'notes'}); const exported = await new Stage8ArchiveService(value.pool as never)
      .exportCommittee(auth, committeeId);
    await expect(text(exported.content)).rejects.toThrow('database secret');
    expect(value.query).toHaveBeenCalledWith('ROLLBACK'); expect(value.release).toHaveBeenCalledOnce();
  });
});
