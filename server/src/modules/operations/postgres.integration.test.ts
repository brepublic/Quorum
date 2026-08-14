// @vitest-environment node

import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import pg from 'pg';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {runMigrations} from '../../db/migrations';
import {PostgresIdentityStore} from '../identity/postgres';
import {IdentityService} from '../identity/service';
import type {AuthenticatedSession} from '../identity/store';
import {Stage3Service} from '../stage3/service';
import {Stage8ArchiveService} from './archive-service';
import {Stage8DeletionService} from './deletion-service';

const {Client, Pool} = pg;
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const integration = adminUrl ? describe : describe.skip;
let databaseName = '';
let pool: pg.Pool | undefined;
let identity: IdentityService;
let stage3: Stage3Service;
let archives: Stage8ArchiveService;
let deletions: Stage8DeletionService;
let administrator: AuthenticatedSession;

function quoteIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
const context = (name: string) => ({requestId: `stage8-${name}`, sourceIp: '127.0.0.1', userAgent: 'Vitest'});

beforeEach(async () => {
  if (!adminUrl) return;
  databaseName = `quorum_stage8_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(adminUrl); url.pathname = `/${databaseName}`;
  const admin = new Client({connectionString: adminUrl}); await admin.connect();
  try { await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`); } finally { await admin.end(); }
  pool = new Pool({connectionString: url.toString()});
  await runMigrations(pool, resolve('server/migrations'));
  identity = new IdentityService(new PostgresIdentityStore(pool));
  stage3 = new Stage3Service(pool); archives = new Stage8ArchiveService(pool); deletions = new Stage8DeletionService(pool);
  await stage3.ensureBuiltins();
  const secret = await identity.ensureBootstrapSecret();
  const session = await identity.bootstrapAdmin({secret: secret as string, email: 'admin@example.com',
    displayName: 'System Admin', password: 'admin-password-123'}, context('bootstrap'));
  administrator = await identity.authenticate(session.sessionToken);
});

afterEach(async () => {
  await pool?.end(); pool = undefined;
  if (!adminUrl || !databaseName) return;
  const admin = new Client({connectionString: adminUrl}); await admin.connect();
  try { await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`); }
  finally { await admin.end(); databaseName = ''; }
});

async function user(name: string): Promise<AuthenticatedSession> {
  const created = await identity.createUser(administrator, {email: `${name}@example.com`, displayName: name},
    context(`create-${name}`));
  const login = await identity.login({email: created.user.email, password: created.temporaryPassword},
    context(`login-${name}`));
  const changed = await identity.changePassword(await identity.authenticate(login.sessionToken), {
    currentPassword: created.temporaryPassword, newPassword: `${name}-permanent-password-123`
  }, context(`password-${name}`));
  return identity.authenticate(changed.sessionToken);
}

async function text(stream: NodeJS.ReadableStream): Promise<string> {
  let result = ''; for await (const chunk of stream) result += chunk.toString(); return result;
}

integration('PostgreSQL stage 8 integration', () => {
  it('executes every archive section against the migrated schema and preserves the owner boundary', async () => {
    const owner = await user('archiveowner'); const outsider = await user('archiveoutsider');
    const committee = await stage3.createCommittee(owner, {name: 'Archived Committee', visibility: 'PRIVATE'},
      context('committee'));
    await expect(archives.exportCommittee(owner, committee.id)).rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    const archived = await stage3.archiveCommittee(owner, committee.id, 1, context('archive'));
    expect(archived).toEqual(expect.objectContaining({status: 'ARCHIVED', revision: 2}));
    await expect(archives.exportCommittee(outsider, committee.id)).rejects.toMatchObject({code: 'NOT_FOUND'});

    const exported = await archives.exportCommittee(owner, committee.id);
    const records = (await text(exported.content)).trim().split('\n').map(line => JSON.parse(line));
    expect(records[0]).toEqual(expect.objectContaining({type: 'manifest',
      committee: expect.objectContaining({id: committee.id, status: 'ARCHIVED'})}));
    expect(records).toContainEqual(expect.objectContaining({type: 'record', section: 'committee_memberships'}));
    expect(records).toContainEqual(expect.objectContaining({type: 'record', section: 'committee_events'}));
    expect(records).toContainEqual(expect.objectContaining({type: 'record', section: 'audit_log'}));
    expect(records.at(-1)).toEqual(expect.objectContaining({type: 'complete', recordCount: expect.any(Number)}));
  });

  it('atomically removes an archived committee after its durable cleanup boundary is clear', async () => {
    const owner = await user('deleteowner');
    const committee = await stage3.createCommittee(owner, {name: 'Delete Committee', visibility: 'PRIVATE'},
      context('delete-committee'));
    await stage3.archiveCommittee(owner, committee.id, committee.revision, context('delete-archive'));
    const job = await deletions.requestDeletion(owner, committee.id,
      {baseRevision: committee.revision + 1, confirmationName: 'Delete Committee'}, 'delete-key', context('delete'));
    expect(job.status).toBe('PENDING');
    await expect(stage3.snapshot(committee.id, owner)).rejects.toMatchObject({code: 'NOT_FOUND'});
    const completed = await deletions.processNext();
    expect(completed).toEqual(expect.objectContaining({id: job.id, status: 'COMPLETED'}));
    expect((await pool?.query('SELECT 1 FROM committees WHERE id=$1', [committee.id]))?.rowCount).toBe(0);
    expect((await pool?.query('SELECT status FROM committee_deletion_jobs WHERE id=$1', [job.id]))?.rows[0])
      .toEqual({status: 'COMPLETED'});
  });
});
