// @vitest-environment node

import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import pg from 'pg';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {runMigrations} from '../../db/migrations';
import {PostgresIdentityStore} from '../identity/postgres';
import {IdentityService} from '../identity/service';
import type {AuthenticatedSession} from '../identity/store';
import {Stage3Service} from '../stage3/service';
import {Stage4Service} from '../stage4/service';
import {Stage6StorageService} from '../storage/service';
import {DurableStagingStore} from '../storage/staging';
import type {Stage6FileService} from '../storage/file-service';
import {Stage6UploadService} from '../storage/upload-service';
import {Stage7StorageAgentService} from './service';
import {Stage7StorageTaskService} from './task-service';
import {Stage7ChairAgentProviderService} from './chair-provider-service';
import {Stage7LocalChangeService} from './local-change-service';
import {Stage7ConflictService} from './conflict-service';

const {Client, Pool} = pg;
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const integration = adminUrl ? describe : describe.skip;
let databaseName = '';
let pool: pg.Pool | undefined;
let identity: IdentityService;
let stage3: Stage3Service;
let stage4: Stage4Service;
let agent: Stage7StorageAgentService;
let storage: Stage6StorageService;
let tasks: Stage7StorageTaskService;
let uploads: Stage6UploadService;
let chairProvider: Stage7ChairAgentProviderService;
let localChanges: Stage7LocalChangeService;
let conflicts: Stage7ConflictService;
let staging: DurableStagingStore;
let stagingRoot = '';
let administrator: AuthenticatedSession;
let clock = new Date('2026-08-13T08:00:00.000Z');

function quoteIdentifier(value: string): string {return `"${value.replaceAll('"', '""')}"`;}
const context = (name: string) => ({requestId: `stage7-${name}`, sourceIp: '127.0.0.1', userAgent: 'Vitest'});
const publicKey = () => randomBytes(32).toString('base64url');

beforeEach(async () => {
  if (!adminUrl) return;
  databaseName = `quorum_stage7_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(adminUrl); url.pathname = `/${databaseName}`;
  const admin = new Client({connectionString: adminUrl}); await admin.connect();
  try {await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);} finally {await admin.end();}
  pool = new Pool({connectionString: url.toString()});
  await runMigrations(pool, resolve('server/migrations'));
  identity = new IdentityService(new PostgresIdentityStore(pool));
  stage3 = new Stage3Service(pool); stage4 = new Stage4Service(pool);
  agent = new Stage7StorageAgentService(pool, {now: () => clock, pairingTtlMs: 60_000, offlineGraceMs: 30_000});
  storage = new Stage6StorageService(pool);
  stagingRoot = await mkdtemp(join(tmpdir(), 'quorum-stage7-integration-'));
  staging = new DurableStagingStore(stagingRoot, 1024 * 1024, 1024 * 1024); await staging.initialize();
  uploads = new Stage6UploadService(pool, staging);
  chairProvider = new Stage7ChairAgentProviderService(pool, storage);
  tasks = new Stage7StorageTaskService(agent, staging, {} as Stage6FileService, undefined, chairProvider);
  localChanges = new Stage7LocalChangeService(agent);
  conflicts = new Stage7ConflictService(pool, agent);
  await stage3.ensureBuiltins();
  const secret = await identity.ensureBootstrapSecret();
  const session = await identity.bootstrapAdmin({secret: secret as string, email: 'admin@example.com',
    displayName: 'System Admin', password: 'admin-password-123'}, context('bootstrap'));
  administrator = await identity.authenticate(session.sessionToken);
});

afterEach(async () => {
  await pool?.end(); pool = undefined; clock = new Date('2026-08-13T08:00:00.000Z');
  if (stagingRoot) await rm(stagingRoot, {recursive: true, force: true}); stagingRoot = '';
  if (!adminUrl || !databaseName) return;
  const admin = new Client({connectionString: adminUrl}); await admin.connect();
  try {await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);}
  finally {await admin.end(); databaseName = '';}
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

async function fixture() {
  const owner = await user(`owner${randomUUID().slice(0, 6)}`);
  const chair = await user(`chair${randomUUID().slice(0, 6)}`);
  const member = await user(`member${randomUUID().slice(0, 6)}`);
  let committee = await stage4.createCommittee(owner, {name: 'Agent Council', visibility: 'PRIVATE',
    countryTemplateKey: 'builtin:default'}, randomUUID(), context('committee'));
  committee = await stage3.setChair(owner, committee.id, chair.user.id, true, committee.revision, context('chair'));
  return {owner, chair, member, committee};
}

async function committeeRevision(id: string): Promise<number> {
  return Number((await pool?.query<{revision: number}>('SELECT revision FROM committees WHERE id=$1', [id]))?.rows[0]?.revision);
}

async function pairInitial(owner: AuthenticatedSession, committeeId: string) {
  const pairing = await agent.createPairing(owner, committeeId,
    {baseRevision: await committeeRevision(committeeId), purpose: 'INITIAL'}, context('initial-code'));
  return {pairing, paired: await agent.pair({pairingCode: pairing.code, deviceLabel: 'Chair laptop',
    devicePublicKey: publicKey()}, context('initial-pair'))};
}

async function committedFile(owner: AuthenticatedSession, committeeId: string) {
  const binding = await storage.createServerVolumeBinding(owner, committeeId,
    {baseRevision: await committeeRevision(committeeId)}, randomUUID(), context('binding'));
  const content = 'manifest content';
  return storage.recordProviderCommit(owner, committeeId, {bindingId: binding.id, blobId: randomUUID(),
    logicalName: '议事文件', originalName: 'manifest.txt', mediaType: 'text/plain',
    sizeBytes: Buffer.byteLength(content), sha256: randomBytes(32).toString('hex'),
    storageKey: `blobs/aa/${randomUUID().replaceAll('-', '')}`}, randomUUID(), context('file'));
}

async function chairStorage(owner: AuthenticatedSession, committeeId: string) {
  const paired = await pairInitial(owner, committeeId);
  const binding = await storage.createChairAgentBinding(owner, committeeId,
    {baseRevision: await committeeRevision(committeeId)}, randomUUID(), context('chair-binding'));
  return {paired: paired.paired, binding};
}

async function stagedUpload(owner: AuthenticatedSession, committeeId: string, name = '离线工作文件') {
  const content = Buffer.from('chair agent browser upload');
  const sha256 = createHash('sha256').update(content).digest('hex');
  const created = await uploads.createUpload(owner, committeeId, {logicalName: name, originalName: 'draft.txt',
    mediaType: 'text/plain', expectedSizeBytes: content.length, sha256}, randomUUID(), context('upload-create'));
  const staged = await uploads.receiveContent(owner, created.id, (async function* () {yield content;})(),
    randomUUID(), content.length, context('upload-content'));
  return {content, sha256, staged};
}

integration('PostgreSQL stage 7 storage Agent identity', () => {
  it('keeps secrets hashed and management scoped to explicit Owner or Chair authority', async () => {
    const value = await fixture();
    await expect(agent.createPairing(value.member, value.committee.id,
      {baseRevision: value.committee.revision, purpose: 'INITIAL'}, context('member-code')))
      .rejects.toMatchObject({code: 'FORBIDDEN'});
    await expect(agent.createPairing(administrator, value.committee.id,
      {baseRevision: value.committee.revision, purpose: 'INITIAL'}, context('admin-code')))
      .rejects.toMatchObject({code: 'FORBIDDEN'});
    const pairing = await agent.createPairing(value.chair, value.committee.id,
      {baseRevision: value.committee.revision, purpose: 'INITIAL'}, context('chair-code'));
    const storedCode = await pool?.query<{code_hash: Buffer}>('SELECT code_hash FROM storage_pairing_codes');
    expect(storedCode?.rows[0]?.code_hash).toHaveLength(32);
    expect(storedCode?.rows[0]?.code_hash.toString('utf8')).not.toContain(pairing.code);
    const key = publicKey();
    const paired = await agent.pair({pairingCode: pairing.code, deviceLabel: '主席电脑', devicePublicKey: key},
      context('pair'));
    const storedHost = await pool?.query<{credential_hash: Buffer; device_public_key: Buffer}>(
      'SELECT credential_hash,device_public_key FROM storage_hosts');
    expect(storedHost?.rows[0]?.credential_hash).toHaveLength(32);
    expect(storedHost?.rows[0]?.credential_hash.toString('utf8')).not.toContain(paired.credential);
    expect(storedHost?.rows[0]?.device_public_key.toString('base64url')).toBe(key);
    await expect(agent.listHosts(value.owner, value.committee.id)).resolves.toHaveLength(1);
    await expect(agent.listHosts(value.chair, value.committee.id)).resolves.toHaveLength(1);
    await expect(agent.listHosts(value.member, value.committee.id)).rejects.toMatchObject({code: 'FORBIDDEN'});
    await expect(agent.listHosts(administrator, value.committee.id)).rejects.toMatchObject({code: 'FORBIDDEN'});
    const recorded = JSON.stringify({
      events: (await pool?.query('SELECT payload FROM committee_events WHERE committee_id=$1', [value.committee.id]))?.rows,
      audits: (await pool?.query('SELECT before_summary,after_summary FROM audit_log WHERE committee_id=$1',
        [value.committee.id]))?.rows
    });
    expect(recorded).not.toContain(pairing.code);
    expect(recorded).not.toContain(paired.credential);
    expect(recorded).not.toContain(key);
  });

  it('uses a one-time code and atomically fences the old host during transfer', async () => {
    const value = await fixture();
    const first = await pairInitial(value.owner, value.committee.id);
    const transfer = await agent.createPairing(value.chair, value.committee.id,
      {baseRevision: await committeeRevision(value.committee.id), purpose: 'TRANSFER'}, context('transfer-code'));
    const raced = await Promise.allSettled([
      agent.pair({pairingCode: transfer.code, deviceLabel: 'New host A', devicePublicKey: publicKey()}, context('pair-a')),
      agent.pair({pairingCode: transfer.code, deviceLabel: 'New host B', devicePublicKey: publicKey()}, context('pair-b'))
    ]);
    expect(raced.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter(item => item.status === 'rejected')).toHaveLength(1);
    const second = (raced.find(item => item.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof agent.pair>>>).value;
    expect(second.host.leaseGeneration).toBe(first.paired.host.leaseGeneration + 1);
    await expect(agent.heartbeat(first.paired.credential,
      {leaseGeneration: first.paired.host.leaseGeneration})).rejects.toMatchObject({code: 'STALE_STORAGE_LEASE'});
    await expect(agent.heartbeat(second.credential, {leaseGeneration: second.host.leaseGeneration}))
      .resolves.toMatchObject({status: 'ACTIVE'});
    const state = await pool?.query(`SELECT status,count(*)::int AS count FROM storage_hosts GROUP BY status`);
    expect(state?.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({status: 'ACTIVE', count: 1}),
      expect.objectContaining({status: 'REVOKED', count: 1})
    ]));
  });

  it('increments generation on revocation and rejects every late write from the old device', async () => {
    const value = await fixture(); const first = await pairInitial(value.owner, value.committee.id);
    const revoked = await agent.revokeHost(value.owner, value.committee.id, first.paired.host.id,
      {baseRevision: await committeeRevision(value.committee.id)}, context('revoke'));
    expect(revoked.status).toBe('REVOKED');
    await expect(agent.authenticate(first.paired.credential)).rejects.toMatchObject({code: 'STALE_STORAGE_LEASE'});
    await expect(agent.heartbeat(first.paired.credential,
      {leaseGeneration: first.paired.host.leaseGeneration})).rejects.toMatchObject({code: 'STALE_STORAGE_LEASE'});
    const committee = await pool?.query<{storage_lease_generation: string}>(
      'SELECT storage_lease_generation FROM committees WHERE id=$1', [value.committee.id]);
    expect(Number(committee?.rows[0]?.storage_lease_generation)).toBe(2);
  });

  it('invalidates expired codes and codes whose issuing Chair lost authority', async () => {
    const value = await fixture();
    const chairCode = await agent.createPairing(value.chair, value.committee.id,
      {baseRevision: value.committee.revision, purpose: 'INITIAL'}, context('chair-code'));
    await stage3.setChair(value.owner, value.committee.id, value.chair.user.id, false,
      await committeeRevision(value.committee.id), context('remove-chair'));
    await expect(agent.pair({pairingCode: chairCode.code, deviceLabel: 'Former Chair', devicePublicKey: publicKey()},
      context('former-chair-pair'))).rejects.toMatchObject({code: 'LINK_EXPIRED'});
    const ownerCode = await agent.createPairing(value.owner, value.committee.id,
      {baseRevision: await committeeRevision(value.committee.id), purpose: 'INITIAL'}, context('owner-code'));
    clock = new Date(clock.getTime() + 61_000);
    await expect(agent.pair({pairingCode: ownerCode.code, deviceLabel: 'Late host', devicePublicKey: publicKey()},
      context('expired-pair'))).rejects.toMatchObject({code: 'LINK_EXPIRED'});
  });

  it('marks only storage degraded and recovers it on a valid heartbeat', async () => {
    const value = await fixture(); const first = await pairInitial(value.owner, value.committee.id);
    clock = new Date(clock.getTime() + 31_000);
    await expect(agent.markDegradedHosts()).resolves.toBe(1);
    expect((await agent.listHosts(value.owner, value.committee.id))[0]).toMatchObject({status: 'DEGRADED'});
    const committee = await pool?.query<{status: string}>('SELECT status FROM committees WHERE id=$1', [value.committee.id]);
    expect(committee?.rows[0]?.status).toBe('ACTIVE');
    await expect(agent.heartbeat(first.paired.credential, {leaseGeneration: first.paired.host.leaseGeneration}))
      .resolves.toMatchObject({status: 'ACTIVE'});
    const events = await pool?.query<{status: string}>(`SELECT payload->>'status' AS status FROM committee_events
      WHERE committee_id=$1 AND event_type='storage_host.status_changed' ORDER BY sequence`, [value.committee.id]);
    expect(events?.rows.map(row => row.status)).toEqual(expect.arrayContaining(['DEGRADED', 'ACTIVE']));
  });

  it('rolls back host, generation, code use, event, and audit together on failure', async () => {
    const value = await fixture();
    const pairing = await agent.createPairing(value.owner, value.committee.id,
      {baseRevision: value.committee.revision, purpose: 'INITIAL'}, context('atomic-code'));
    await pool?.query(`CREATE FUNCTION fail_storage_host_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='storage.host_paired' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER fail_storage_host_audit BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION fail_storage_host_audit()`);
    await expect(agent.pair({pairingCode: pairing.code, deviceLabel: 'Atomic host', devicePublicKey: publicKey()},
      context('atomic-pair'))).rejects.toThrow();
    const state = await pool?.query(`SELECT
      (SELECT count(*)::int FROM storage_hosts) AS hosts,
      (SELECT count(*)::int FROM storage_pairing_codes WHERE used_at IS NOT NULL) AS used,
      (SELECT storage_lease_generation::int FROM committees WHERE id=$1) AS generation`, [value.committee.id]);
    expect(state?.rows[0]).toEqual({hosts: 0, used: 0, generation: 0});
  });

  it('backfills a strictly ordered manifest and STORE_BLOB task when the first host pairs', async () => {
    const value = await fixture();
    const file = await committedFile(value.owner, value.committee.id);
    const paired = await pairInitial(value.owner, value.committee.id);
    const manifest = await tasks.manifest(paired.paired.credential, paired.paired.host.leaseGeneration, 0, 100);
    expect(manifest).toMatchObject({hasMore: false, nextSequence: 1});
    expect(manifest.events).toEqual([expect.objectContaining({kind: 'UPSERT', fileEntryId: file.id,
      fileRevision: file.revision, blobId: file.currentVersion.blobId})]);
    const pending = await tasks.tasks(paired.paired.credential, paired.paired.host.leaseGeneration, 0, 100);
    expect(pending.tasks).toEqual([expect.objectContaining({type: 'STORE_BLOB', fileEntryId: file.id,
      blobId: file.currentVersion.blobId, status: 'PENDING'})]);
  });

  it('claims and completes a task idempotently while rejecting a different terminal outcome', async () => {
    const value = await fixture(); await committedFile(value.owner, value.committee.id);
    const paired = await pairInitial(value.owner, value.committee.id);
    const pending = (await tasks.tasks(paired.paired.credential, paired.paired.host.leaseGeneration)).tasks[0]!;
    const claimRequest = randomUUID();
    const claimed = await tasks.claim(paired.paired.credential, pending.id, {leaseGeneration: pending.leaseGeneration,
      fileRevision: pending.fileRevision, requestId: claimRequest});
    const replay = await tasks.claim(paired.paired.credential, pending.id, {leaseGeneration: pending.leaseGeneration,
      fileRevision: pending.fileRevision, requestId: claimRequest});
    expect(replay.claimToken).toBe(claimed.claimToken);
    const completeRequest = randomUUID();
    const completed = await tasks.complete(paired.paired.credential, pending.id,
      {leaseGeneration: pending.leaseGeneration, fileRevision: pending.fileRevision,
        claimToken: claimed.claimToken, requestId: completeRequest}, context('complete-task'));
    await expect(tasks.complete(paired.paired.credential, pending.id,
      {leaseGeneration: pending.leaseGeneration, fileRevision: pending.fileRevision,
        claimToken: claimed.claimToken, requestId: completeRequest}, context('complete-replay')))
      .resolves.toEqual(completed);
    await expect(tasks.fail(paired.paired.credential, pending.id,
      {leaseGeneration: pending.leaseGeneration, fileRevision: pending.fileRevision,
        claimToken: claimed.claimToken, requestId: randomUUID(), failureCode: 'LOCAL_WRITE_FAILED'},
      context('different-outcome'))).rejects.toMatchObject({code: 'IDEMPOTENCY_CONFLICT'});
    const recorded = await pool?.query(`SELECT
      (SELECT count(*)::int FROM committee_events WHERE committee_id=$1
        AND event_type='storage_agent.task_changed') AS events,
      (SELECT count(*)::int FROM audit_log WHERE committee_id=$1
        AND action='storage.agent_task_completed') AS audits`, [value.committee.id]);
    expect(recorded?.rows[0]).toEqual({events: 1, audits: 1});
  });

  it('rolls task state and event back when completion audit persistence fails', async () => {
    const value = await fixture(); await committedFile(value.owner, value.committee.id);
    const paired = await pairInitial(value.owner, value.committee.id);
    const pending = (await tasks.tasks(paired.paired.credential, paired.paired.host.leaseGeneration)).tasks[0]!;
    const claimed = await tasks.claim(paired.paired.credential, pending.id, {leaseGeneration: pending.leaseGeneration,
      fileRevision: pending.fileRevision, requestId: randomUUID()});
    await pool?.query(`CREATE FUNCTION fail_storage_agent_task_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='storage.agent_task_completed' THEN RAISE EXCEPTION 'injected task audit failure'; END IF;
      RETURN NEW; END; $$;
      CREATE TRIGGER fail_storage_agent_task_audit BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION fail_storage_agent_task_audit()`);
    await expect(tasks.complete(paired.paired.credential, pending.id,
      {leaseGeneration: pending.leaseGeneration, fileRevision: pending.fileRevision,
        claimToken: claimed.claimToken, requestId: randomUUID()}, context('atomic-task'))).rejects.toThrow();
    const state = await pool?.query(`SELECT t.status,t.claim_token,
      (SELECT count(*)::int FROM committee_events WHERE committee_id=t.committee_id
        AND event_type='storage_agent.task_changed') AS events
      FROM storage_agent_tasks t WHERE t.id=$1`, [pending.id]);
    expect(state?.rows[0]).toMatchObject({status: 'IN_PROGRESS', claim_token: claimed.claimToken, events: 0});
  });

  it('keeps a browser upload pending until the current Chair host durably completes it', async () => {
    const value = await fixture(); const chair = await chairStorage(value.owner, value.committee.id);
    const source = await stagedUpload(value.owner, value.committee.id);
    const pending = await chairProvider.queueUpload(value.owner, source.staged.id, {}, randomUUID(),
      context('queue-host-commit'));
    expect(pending).toMatchObject({kind: 'PENDING_HOST_COMMIT', upload: {
      status: 'STAGED', agentCommitState: 'PENDING_HOST_COMMIT'}});
    await expect(uploads.listPendingHostCommits(value.owner, value.committee.id))
      .resolves.toEqual([expect.objectContaining({id: source.staged.id})]);
    const claimed = await tasks.claim(chair.paired.credential, pending.taskId, {
      leaseGeneration: pending.leaseGeneration, fileRevision: 1, requestId: randomUUID()});
    const chunks: Buffer[] = [];
    await tasks.streamBlob(chair.paired.credential, {taskId: pending.taskId, blobId: claimed.blobId as string,
      leaseGeneration: pending.leaseGeneration, fileRevision: 1, claimToken: claimed.claimToken as string}, {
      start: metadata => expect(metadata).toEqual({sizeBytes: source.content.length, sha256: source.sha256}),
      write: chunk => {chunks.push(Buffer.from(chunk)); return Promise.resolve();}
    });
    expect(Buffer.concat(chunks)).toEqual(source.content);
    await tasks.complete(chair.paired.credential, pending.taskId, {leaseGeneration: pending.leaseGeneration,
      fileRevision: 1, claimToken: claimed.claimToken, requestId: randomUUID()}, context('host-complete'));
    await expect(uploads.listPendingHostCommits(value.owner, value.committee.id)).resolves.toEqual([]);
    const state = await pool?.query(`SELECT
      (SELECT status::text FROM file_uploads WHERE id=$1) AS upload_status,
      (SELECT agent_commit_state::text FROM file_uploads WHERE id=$1) AS agent_state,
      (SELECT count(*)::int FROM file_entries WHERE committee_id=$2) AS files,
      (SELECT count(*)::int FROM file_versions version JOIN file_entries entry ON entry.id=version.file_entry_id
        WHERE entry.committee_id=$2) AS versions`, [source.staged.id, value.committee.id]);
    expect(state?.rows[0]).toEqual({upload_status: 'COMMITTED', agent_state: 'HOST_COMMITTED', files: 1, versions: 1});
  });

  it('rolls back file metadata and upload completion when the terminal Agent audit fails', async () => {
    const value = await fixture(); const chair = await chairStorage(value.owner, value.committee.id);
    const source = await stagedUpload(value.owner, value.committee.id);
    const pending = await chairProvider.queueUpload(value.owner, source.staged.id, {}, randomUUID(),
      context('queue-atomic-host-commit'));
    const claimed = await tasks.claim(chair.paired.credential, pending.taskId, {
      leaseGeneration: pending.leaseGeneration, fileRevision: 1, requestId: randomUUID()});
    await pool?.query(`CREATE FUNCTION fail_chair_host_commit_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='storage.agent_task_completed' THEN RAISE EXCEPTION 'injected Chair commit failure'; END IF;
      RETURN NEW; END; $$;
      CREATE TRIGGER fail_chair_host_commit_audit BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION fail_chair_host_commit_audit()`);
    await expect(tasks.complete(chair.paired.credential, pending.taskId, {leaseGeneration: pending.leaseGeneration,
      fileRevision: 1, claimToken: claimed.claimToken, requestId: randomUUID()}, context('atomic-host-complete')))
      .rejects.toThrow();
    const state = await pool?.query(`SELECT
      (SELECT status::text FROM file_uploads WHERE id=$1) AS upload_status,
      (SELECT agent_commit_state::text FROM file_uploads WHERE id=$1) AS agent_state,
      (SELECT status::text FROM storage_agent_tasks WHERE id=$2) AS task_status,
      (SELECT count(*)::int FROM file_entries WHERE committee_id=$3) AS files,
      (SELECT count(*)::int FROM file_versions version JOIN file_entries entry ON entry.id=version.file_entry_id
        WHERE entry.committee_id=$3) AS versions`, [source.staged.id, pending.taskId, value.committee.id]);
    expect(state?.rows[0]).toEqual({upload_status: 'STAGED', agent_state: 'PENDING_HOST_COMMIT',
      task_status: 'IN_PROGRESS', files: 0, versions: 0});
  });

  it('replans a pending browser upload for a transferred host and fences the old claim', async () => {
    const value = await fixture(); const first = await chairStorage(value.owner, value.committee.id);
    const source = await stagedUpload(value.owner, value.committee.id);
    const pending = await chairProvider.queueUpload(value.owner, source.staged.id, {}, randomUUID(),
      context('queue-before-transfer'));
    const oldClaim = await tasks.claim(first.paired.credential, pending.taskId, {
      leaseGeneration: pending.leaseGeneration, fileRevision: 1, requestId: randomUUID()});
    const transfer = await agent.createPairing(value.owner, value.committee.id,
      {baseRevision: await committeeRevision(value.committee.id), purpose: 'TRANSFER'}, context('transfer-pending'));
    const second = await agent.pair({pairingCode: transfer.code, deviceLabel: 'Replacement host',
      devicePublicKey: publicKey()}, context('pair-replacement'));
    await expect(tasks.complete(first.paired.credential, pending.taskId, {leaseGeneration: pending.leaseGeneration,
      fileRevision: 1, claimToken: oldClaim.claimToken, requestId: randomUUID()}, context('old-late-complete')))
      .rejects.toMatchObject({code: 'STALE_STORAGE_LEASE'});
    const replacement = (await tasks.tasks(second.credential, second.host.leaseGeneration)).tasks
      .find(item => item.type === 'STORE_BLOB' && item.blobId === oldClaim.blobId);
    expect(replacement).toMatchObject({status: 'PENDING', leaseGeneration: second.host.leaseGeneration});
    const state = await pool?.query(`SELECT
      (SELECT status::text FROM storage_agent_tasks WHERE id=$1) AS old_status,
      (SELECT agent_task_id FROM file_uploads WHERE id=$2) AS current_task,
      (SELECT agent_host_id FROM file_uploads WHERE id=$2) AS current_host`, [pending.taskId, source.staged.id]);
    expect(state?.rows[0]).toEqual({old_status: 'CANCELLED', current_task: replacement?.id,
      current_host: second.host.id});
  });

  it('uploads local Agent content once and records a deleted-file conflict without reviving it', async () => {
    const value = await fixture(); const chair = await chairStorage(value.owner, value.committee.id);
    const content = Buffer.from('local Chair edit');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const requestId = randomUUID();
    const pending = await localChanges.submit(chair.paired.credential, {leaseGeneration: chair.paired.host.leaseGeneration,
      requestId, manifestSequence: 0, change: {kind: 'UPSERT', logicalName: '本地文件', originalName: 'local.txt',
        mediaType: 'text/plain', sizeBytes: content.length, sha256}}, context('local-upsert'));
    expect(pending.status).toBe('PENDING_CONTENT');
    if (pending.status !== 'PENDING_CONTENT') throw new Error('Expected pending local content.');
    await expect(localChanges.submit(chair.paired.credential, {leaseGeneration: chair.paired.host.leaseGeneration,
      requestId, manifestSequence: 0, change: {kind: 'UPSERT', logicalName: '本地文件', originalName: 'local.txt',
        mediaType: 'text/plain', sizeBytes: content.length, sha256}}, context('local-replay')))
      .resolves.toEqual(pending);
    const claimed = await tasks.claim(chair.paired.credential, pending.task.id, {
      leaseGeneration: pending.task.leaseGeneration, fileRevision: 1, requestId: randomUUID()});
    await tasks.receiveContent(chair.paired.credential, {taskId: pending.task.id,
      leaseGeneration: pending.task.leaseGeneration, fileRevision: 1, claimToken: claimed.claimToken as string,
      expectedSha256: sha256, contentLength: content.length, source: (async function* () {yield content;})(),
      context: context('local-content')});
    await tasks.complete(chair.paired.credential, pending.task.id, {leaseGeneration: pending.task.leaseGeneration,
      fileRevision: 1, claimToken: claimed.claimToken, requestId: randomUUID()}, context('local-complete'));
    const completed = await localChanges.submit(chair.paired.credential, {
      leaseGeneration: chair.paired.host.leaseGeneration, requestId, manifestSequence: 0,
      change: {kind: 'UPSERT', logicalName: '本地文件', originalName: 'local.txt', mediaType: 'text/plain',
        sizeBytes: content.length, sha256}}, context('local-completed-replay'));
    expect(completed).toMatchObject({status: 'COMPLETED', fileRevision: 1});
    if (completed.status !== 'COMPLETED') throw new Error('Expected completed local change.');
    const manifest = Number((await pool?.query<{sequence: string}>(
      'SELECT next_storage_manifest_sequence-1 AS sequence FROM committees WHERE id=$1', [value.committee.id]))
      ?.rows[0]?.sequence);
    const deleted = await localChanges.submit(chair.paired.credential, {
      leaseGeneration: chair.paired.host.leaseGeneration, requestId: randomUUID(), manifestSequence: manifest,
      change: {kind: 'DELETE', fileEntryId: completed.fileEntryId, baseRevision: completed.fileRevision}},
    context('local-delete'));
    expect(deleted).toMatchObject({status: 'COMPLETED', fileEntryId: completed.fileEntryId});
    const afterDeleteManifest = Number((await pool?.query<{sequence: string}>(
      'SELECT next_storage_manifest_sequence-1 AS sequence FROM committees WHERE id=$1', [value.committee.id]))
      ?.rows[0]?.sequence);
    await expect(localChanges.submit(chair.paired.credential, {
      leaseGeneration: chair.paired.host.leaseGeneration, requestId: randomUUID(),
      manifestSequence: afterDeleteManifest, change: {kind: 'UPSERT', fileEntryId: completed.fileEntryId,
        baseRevision: completed.fileRevision, logicalName: '本地文件', originalName: 'local.txt',
        mediaType: 'text/plain', sizeBytes: content.length, sha256}}, context('local-deleted-conflict')))
      .rejects.toMatchObject({code: 'CHAIR_DECISION_REQUIRED', details: {
        status: 'CONFLICT', reasonCode: 'FILE_DELETED'}});
    const state = await pool?.query(`SELECT
      (SELECT count(*)::int FROM storage_agent_conflicts WHERE committee_id=$1 AND status='PENDING') AS conflicts,
      (SELECT status::text FROM file_entries WHERE id=$2) AS file_status,
      (SELECT count(*)::int FROM file_versions WHERE file_entry_id=$2) AS versions`,
    [value.committee.id, completed.fileEntryId]);
    expect(state?.rows[0]).toEqual({conflicts: 1, file_status: 'DELETED', versions: 1});
  });

  it('fences, records, and applies a Chair save-as-new decision exactly once', async () => {
    const value = await fixture(); const chair = await chairStorage(value.owner, value.committee.id);
    const local = {kind: 'UPSERT' as const, logicalName: '私人目录/本地草案.txt', originalName: 'local.txt',
      mediaType: 'text/plain', sizeBytes: 5, sha256: createHash('sha256').update('local').digest('hex')};
    await expect(localChanges.submit(chair.paired.credential, {leaseGeneration: chair.paired.host.leaseGeneration,
      requestId: randomUUID(), manifestSequence: 99, change: local}, context('resolution-conflict')))
      .rejects.toMatchObject({code: 'CHAIR_DECISION_REQUIRED'});
    await expect(conflicts.list(value.member, value.committee.id)).rejects.toMatchObject({code: 'FORBIDDEN'});
    const pending = (await conflicts.list(value.chair, value.committee.id))[0]!;
    expect(pending).toMatchObject({status: 'PENDING', reasonCode: 'MANIFEST_STALE', revision: 1,
      change: {logicalName: '本地草案.txt'}});
    await expect(conflicts.resolve(value.owner, value.committee.id, pending.id, {baseRevision: 1,
      leaseGeneration: chair.paired.host.leaseGeneration, fileRevision: null, action: 'SAVE_AS_NEW',
      logicalName: '../escape.txt'}, randomUUID(), context('unsafe-resolution')))
      .rejects.toMatchObject({code: 'VALIDATION_FAILED'});
    const key = randomUUID(); const resolved = await conflicts.resolve(value.owner, value.committee.id, pending.id,
      {baseRevision: 1, leaseGeneration: chair.paired.host.leaseGeneration, fileRevision: null,
        action: 'SAVE_AS_NEW', logicalName: '裁决/本地草案.txt'}, key, context('resolve-save'));
    expect(resolved).toMatchObject({status: 'RESOLVED', revision: 2, resolutionAction: 'SAVE_AS_NEW',
      resolutionLogicalName: '裁决/本地草案.txt'});
    await expect(conflicts.resolve(value.owner, value.committee.id, pending.id, {baseRevision: 1,
      leaseGeneration: chair.paired.host.leaseGeneration, fileRevision: null, action: 'SAVE_AS_NEW',
      logicalName: '裁决/本地草案.txt'}, key, context('resolve-replay'))).resolves.toEqual(resolved);
    await expect(conflicts.listForAgent(chair.paired.credential, chair.paired.host.leaseGeneration))
      .resolves.toEqual([expect.objectContaining({id: resolved.id, status: 'RESOLVED', change: local})]);
    const requestId = randomUUID();
    const applied = await localChanges.submit(chair.paired.credential, {
      leaseGeneration: chair.paired.host.leaseGeneration, requestId, manifestSequence: 99, change: local,
      resolutionConflictId: pending.id}, context('apply-resolution'));
    expect(applied).toMatchObject({status: 'PENDING_CONTENT', task: {resolutionConflictId: null}});
    await expect(localChanges.submit(chair.paired.credential, {
      leaseGeneration: chair.paired.host.leaseGeneration, requestId, manifestSequence: 99, change: local,
      resolutionConflictId: pending.id}, context('apply-resolution-replay'))).resolves.toEqual(applied);
    await expect(localChanges.submit(chair.paired.credential, {
      leaseGeneration: chair.paired.host.leaseGeneration, requestId: randomUUID(), manifestSequence: 99,
      change: local, resolutionConflictId: pending.id}, context('apply-resolution-twice')))
      .rejects.toMatchObject({code: 'IDEMPOTENCY_CONFLICT'});
    const state = await pool?.query(`SELECT
      (SELECT count(*)::int FROM storage_agent_conflict_applications WHERE conflict_id=$1) AS applications,
      (SELECT count(*)::int FROM storage_agent_tasks WHERE source_upload_id IS NOT NULL) AS tasks,
      (SELECT logical_name FROM file_uploads WHERE id=(SELECT source_upload_id FROM storage_agent_tasks
        WHERE source_upload_id IS NOT NULL LIMIT 1)) AS logical_name,
      (SELECT count(*)::int FROM committee_events WHERE resource_id=$1
        AND event_type='storage_agent.conflict_resolved') AS events,
      (SELECT count(*)::int FROM audit_log WHERE resource_id=$1
        AND action='storage.agent_conflict_resolved') AS audits`, [pending.id]);
    expect(state?.rows[0]).toEqual({applications: 1, tasks: 1, logical_name: '裁决/本地草案.txt',
      events: 1, audits: 1});
  });

  it('rolls a failed conflict decision back without exposing a resolution task', async () => {
    const value = await fixture(); const chair = await chairStorage(value.owner, value.committee.id);
    const local = {kind: 'UPSERT' as const, logicalName: '冲突.txt', originalName: 'conflict.txt',
      mediaType: 'text/plain', sizeBytes: 1, sha256: createHash('sha256').update('x').digest('hex')};
    await expect(localChanges.submit(chair.paired.credential, {leaseGeneration: chair.paired.host.leaseGeneration,
      requestId: randomUUID(), manifestSequence: 99, change: local}, context('atomic-conflict')))
      .rejects.toMatchObject({code: 'CHAIR_DECISION_REQUIRED'});
    const pending = (await conflicts.list(value.owner, value.committee.id))[0]!;
    await pool?.query(`CREATE FUNCTION fail_conflict_resolution_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='storage.agent_conflict_resolved' THEN RAISE EXCEPTION 'injected resolution failure'; END IF;
      RETURN NEW; END; $$;
      CREATE TRIGGER fail_conflict_resolution_audit BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION fail_conflict_resolution_audit()`);
    await expect(conflicts.resolve(value.owner, value.committee.id, pending.id, {baseRevision: 1,
      leaseGeneration: chair.paired.host.leaseGeneration, fileRevision: null, action: 'KEEP_SERVER'},
    randomUUID(), context('atomic-resolution'))).rejects.toThrow();
    const state = await pool?.query(`SELECT
      (SELECT status::text FROM storage_agent_conflicts WHERE id=$1) AS status,
      (SELECT count(*)::int FROM storage_agent_tasks WHERE resolution_conflict_id=$1) AS tasks,
      (SELECT count(*)::int FROM committee_events WHERE resource_id=$1
        AND event_type='storage_agent.conflict_resolved') AS events`, [pending.id]);
    expect(state?.rows[0]).toEqual({status: 'PENDING', tasks: 0, events: 0});
  });
});
