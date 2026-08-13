// @vitest-environment node

import {randomBytes, randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import pg from 'pg';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {runMigrations} from '../../db/migrations';
import {PostgresIdentityStore} from '../identity/postgres';
import {IdentityService} from '../identity/service';
import type {AuthenticatedSession} from '../identity/store';
import {Stage3Service} from '../stage3/service';
import {Stage4Service} from '../stage4/service';
import {Stage6StorageService} from '../storage/service';
import type {DurableStagingStore} from '../storage/staging';
import type {Stage6FileService} from '../storage/file-service';
import {Stage7StorageAgentService} from './service';
import {Stage7StorageTaskService} from './task-service';

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
  tasks = new Stage7StorageTaskService(agent, {} as DurableStagingStore, {} as Stage6FileService);
  await stage3.ensureBuiltins();
  const secret = await identity.ensureBootstrapSecret();
  const session = await identity.bootstrapAdmin({secret: secret as string, email: 'admin@example.com',
    displayName: 'System Admin', password: 'admin-password-123'}, context('bootstrap'));
  administrator = await identity.authenticate(session.sessionToken);
});

afterEach(async () => {
  await pool?.end(); pool = undefined; clock = new Date('2026-08-13T08:00:00.000Z');
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
});
