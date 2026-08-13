// @vitest-environment node

import {createHash, randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import pg from 'pg';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {runMigrations} from '../../db/migrations';
import {PostgresIdentityStore} from '../identity/postgres';
import {IdentityService} from '../identity/service';
import type {AuthenticatedSession} from '../identity/store';
import {Stage3Service} from '../stage3/service';
import {Stage4Service} from '../stage4/service';
import {Stage6StorageService} from './service';

const {Client, Pool} = pg;
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const integration = adminUrl ? describe : describe.skip;
let databaseName = '';
let pool: pg.Pool | undefined;
let identity: IdentityService;
let stage3: Stage3Service;
let stage4: Stage4Service;
let storage: Stage6StorageService;
let administrator: AuthenticatedSession;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

const context = (name: string) => ({requestId: `stage6-${name}`, sourceIp: '127.0.0.1', userAgent: 'Vitest'});
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const blobKey = () => `blobs/${randomUUID().replaceAll('-', '')}`;

beforeEach(async () => {
  if (!adminUrl) return;
  databaseName = `quorum_stage6_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  const admin = new Client({connectionString: adminUrl});
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  } finally {
    await admin.end();
  }
  pool = new Pool({connectionString: url.toString()});
  await runMigrations(pool, resolve('server/migrations'));
  identity = new IdentityService(new PostgresIdentityStore(pool));
  stage3 = new Stage3Service(pool);
  stage4 = new Stage4Service(pool);
  storage = new Stage6StorageService(pool);
  await stage3.ensureBuiltins();
  const secret = await identity.ensureBootstrapSecret();
  const login = await identity.bootstrapAdmin({secret: secret as string, email: 'admin@example.com',
    displayName: 'System Admin', password: 'admin-password-123'}, context('bootstrap'));
  administrator = await identity.authenticate(login.sessionToken);
});

afterEach(async () => {
  await pool?.end();
  pool = undefined;
  if (!adminUrl || !databaseName) return;
  const admin = new Client({connectionString: adminUrl});
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
  } finally {
    await admin.end();
    databaseName = '';
  }
});

async function user(name: string): Promise<AuthenticatedSession> {
  const created = await identity.createUser(administrator,
    {email: `${name}@example.com`, displayName: name}, context(`create-${name}`));
  const login = await identity.login({email: created.user.email, password: created.temporaryPassword},
    context(`login-${name}`));
  const changed = await identity.changePassword(await identity.authenticate(login.sessionToken), {
    currentPassword: created.temporaryPassword,
    newPassword: `${name}-permanent-password-123`
  }, context(`password-${name}`));
  return identity.authenticate(changed.sessionToken);
}

async function storageFixture() {
  const owner = await user('owner');
  const chair = await user('chair');
  const member = await user('member');
  let committee = await stage4.createCommittee(owner, {name: 'Stage 6 Council', visibility: 'PUBLIC',
    countryTemplateKey: 'builtin:default'}, 'committee', context('committee'));
  committee = await stage3.setChair(owner, committee.id, chair.user.id, true, committee.revision, context('chair'));
  const seat = await stage4.createSeat(chair, committee.id,
    {stableKey: 'member', displayName: 'Member', canVote: true}, 'seat', context('seat'));
  await stage3.assignSeat(chair, committee.id, {seatId: seat.id, userId: member.user.id}, context('assign'));
  const binding = await storage.createServerVolumeBinding(chair, committee.id,
    {baseRevision: committee.revision}, 'binding', context('binding'));
  return {owner, chair, member, committee, binding};
}

integration('PostgreSQL stage 6 file metadata', () => {
  it('commits versions, events, audits, and an irreversible tombstone', async () => {
    const fixture = await storageFixture();
    await expect(storage.createServerVolumeBinding(administrator, fixture.committee.id,
      {baseRevision: fixture.committee.revision}, 'admin-binding', context('admin-binding')))
      .rejects.toMatchObject({code: 'FORBIDDEN'});
    const firstContent = 'first durable content';
    let file = await storage.recordProviderCommit(fixture.member, fixture.committee.id, {
      bindingId: fixture.binding.id,
      logicalName: '工作文件一',
      originalName: 'working-paper-1.pdf',
      mediaType: 'application/pdf',
      sizeBytes: Buffer.byteLength(firstContent),
      sha256: digest(firstContent),
      storageKey: blobKey()
    }, 'first-version', context('first-version'));
    expect(file.currentVersion.versionNumber).toBe(1);
    expect(file.status).toBe('UPLOAD_COMPLETE');

    const secondContent = 'second durable content';
    file = await storage.recordProviderCommit(fixture.member, fixture.committee.id, {
      bindingId: fixture.binding.id,
      fileEntryId: file.id,
      baseRevision: file.revision,
      logicalName: '工作文件一',
      originalName: 'working-paper-1-v2.pdf',
      mediaType: 'application/pdf',
      sizeBytes: Buffer.byteLength(secondContent),
      sha256: digest(secondContent),
      storageKey: blobKey()
    }, 'second-version', context('second-version'));
    expect(file.currentVersion.versionNumber).toBe(2);
    expect(file.currentVersion.sha256).toBe(digest(secondContent));

    const committed = await pool?.query(`SELECT
      (SELECT count(*)::int FROM file_versions WHERE file_entry_id=$1) AS versions,
      (SELECT count(*)::int FROM committee_events WHERE resource_id=$1
        AND event_type IN ('file.created','file.sync_state_changed')) AS events,
      (SELECT count(*)::int FROM audit_log WHERE resource_id=$1
        AND action='storage.file_version_recorded') AS audits`, [file.id]);
    expect(committed?.rows[0]).toEqual({versions: 2, events: 2, audits: 2});
    const actors = await pool?.query('SELECT DISTINCT created_by_user_id FROM file_versions WHERE file_entry_id=$1', [file.id]);
    expect(actors?.rows).toEqual([{created_by_user_id: fixture.member.user.id}]);

    const paused = await stage3.setCommitteeStatus(fixture.chair, fixture.committee.id, 'PAUSED',
      fixture.committee.revision + 1, context('pause'));
    await expect(storage.deleteFile(fixture.member, file.id, {baseRevision: file.revision}, context('paused-delete')))
      .rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    await stage3.setCommitteeStatus(fixture.chair, fixture.committee.id, 'ACTIVE', paused.revision, context('resume'));
    const tombstone = await storage.deleteFile(fixture.member, file.id,
      {baseRevision: file.revision}, context('delete'));
    expect(tombstone.lastContentRevision).toBe(file.revision);
    const deleted = await pool?.query(`SELECT e.status,e.current_version_id,
      (SELECT count(*)::int FROM file_tombstones WHERE file_entry_id=e.id) AS tombstones,
      (SELECT count(*)::int FROM file_blobs b JOIN file_versions v ON v.blob_id=b.id
        WHERE v.file_entry_id=e.id AND b.durability_state='DELETE_PENDING') AS pending_deletes
      FROM file_entries e WHERE e.id=$1`, [file.id]);
    expect(deleted?.rows[0]).toEqual({status: 'DELETED', current_version_id: null, tombstones: 1, pending_deletes: 2});

    await expect(storage.recordProviderCommit(fixture.member, fixture.committee.id, {
      bindingId: fixture.binding.id,
      fileEntryId: file.id,
      baseRevision: file.revision + 1,
      logicalName: '复活文件',
      originalName: 'revived.pdf',
      mediaType: 'application/pdf',
      sizeBytes: 1,
      sha256: digest('x'),
      storageKey: blobKey()
    }, 'revive', context('revive'))).rejects.toMatchObject({code: 'NOT_FOUND'});
    const version = await pool?.query<{id: string}>('SELECT id FROM file_versions WHERE file_entry_id=$1 LIMIT 1', [file.id]);
    await expect(pool?.query('UPDATE file_versions SET version_number=99 WHERE id=$1', [version?.rows[0]?.id])).rejects.toThrow();
    await expect(pool?.query('DELETE FROM file_tombstones WHERE file_entry_id=$1', [file.id])).rejects.toThrow();
  });

  it('rolls back file state and events when audit insertion fails', async () => {
    const fixture = await storageFixture();
    await pool?.query(`CREATE FUNCTION fail_stage6_file_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action='storage.file_version_recorded' THEN RAISE EXCEPTION 'injected audit failure'; END IF;
        RETURN NEW;
      END; $$`);
    await pool?.query(`CREATE TRIGGER fail_stage6_file_audit BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION fail_stage6_file_audit()`);
    await expect(storage.recordProviderCommit(fixture.member, fixture.committee.id, {
      bindingId: fixture.binding.id,
      logicalName: '原子性测试',
      originalName: 'atomic.pdf',
      mediaType: 'application/pdf',
      sizeBytes: 6,
      sha256: digest('atomic'),
      storageKey: blobKey()
    }, 'atomic', context('atomic'))).rejects.toThrow('injected audit failure');
    const state = await pool?.query(`SELECT
      (SELECT count(*)::int FROM file_entries WHERE logical_name='原子性测试') AS files,
      (SELECT count(*)::int FROM committee_events WHERE resource_type='file_entry') AS events,
      (SELECT count(*)::int FROM idempotency_keys WHERE key='atomic') AS idempotency`);
    expect(state?.rows[0]).toEqual({files: 0, events: 0, idempotency: 0});
  });
});
