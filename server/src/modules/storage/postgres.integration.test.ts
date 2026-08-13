// @vitest-environment node

import {createHash, randomUUID} from 'node:crypto';
import {link, lstat, mkdir, mkdtemp, open, realpath, rm, unlink} from 'node:fs/promises';
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
import {Stage6StorageService} from './service';
import {DurableStagingStore, type StagingOperations} from './staging';
import {Stage6UploadService} from './upload-service';
import {ServerVolumeStore} from './server-volume';
import {Stage6ServerVolumeService} from './server-volume-service';
import {StorageCredentialCipher} from './credential-crypto';
import {Stage6S3ConfigService} from './s3-config-service';
import {Stage6S3CommitService} from './s3-commit-service';
import {S3CompatibleStore, type S3Request, type S3Response, type S3Transport} from './s3-store';

const {Client, Pool} = pg;
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const integration = adminUrl ? describe : describe.skip;
let databaseName = '';
let pool: pg.Pool | undefined;
let identity: IdentityService;
let stage3: Stage3Service;
let stage4: Stage4Service;
let storage: Stage6StorageService;
let uploads: Stage6UploadService;
let staging: DurableStagingStore;
let stagingRoot = '';
let volume: ServerVolumeStore;
let serverVolume: Stage6ServerVolumeService;
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
  stagingRoot = await mkdtemp(join(tmpdir(), 'quorum-stage6-integration-'));
  staging = new DurableStagingStore(stagingRoot, 20 * 1024 * 1024, 21 * 1024 * 1024);
  await staging.initialize();
  uploads = new Stage6UploadService(pool, staging);
  volume = new ServerVolumeStore(join(stagingRoot, 'server-volume'), 20 * 1024 * 1024);
  await volume.initialize();
  serverVolume = new Stage6ServerVolumeService(pool, storage, staging, volume);
  await stage3.ensureBuiltins();
  const secret = await identity.ensureBootstrapSecret();
  const login = await identity.bootstrapAdmin({secret: secret as string, email: 'admin@example.com',
    displayName: 'System Admin', password: 'admin-password-123'}, context('bootstrap'));
  administrator = await identity.authenticate(login.sessionToken);
});

afterEach(async () => {
  await pool?.end();
  pool = undefined;
  if (stagingRoot) {
    await rm(stagingRoot, {recursive: true, force: true});
    stagingRoot = '';
  }
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

class IntegrationS3Transport implements S3Transport {
  readonly objects = new Map<string, Buffer>();
  async request(input: S3Request): Promise<S3Response> {
    if (input.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const chunk of input.body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
      this.objects.set(input.key, Buffer.concat(chunks));
      return {statusCode: 200, headers: {}, body: (async function* () {})()};
    }
    if (input.method === 'GET') {
      const content = this.objects.get(input.key);
      return {statusCode: content ? 200 : 404, headers: {}, body: (async function* () {if (content) yield content;})()};
    }
    return {statusCode: 200, headers: {}, body: (async function* () {})()};
  }
}

async function s3Fixture() {
  const owner = await user('s3owner');
  const chair = await user('s3chair');
  const member = await user('s3member');
  let committee = await stage4.createCommittee(owner, {name: 'S3 Council', visibility: 'PUBLIC',
    countryTemplateKey: 'builtin:default'}, 's3-committee', context('s3-committee'));
  committee = await stage3.setChair(owner, committee.id, chair.user.id, true, committee.revision, context('s3-chair'));
  const seat = await stage4.createSeat(chair, committee.id,
    {stableKey: 's3-member', displayName: 'S3 Member', canVote: true}, 's3-seat', context('s3-seat'));
  await stage3.assignSeat(chair, committee.id, {seatId: seat.id, userId: member.user.id}, context('s3-assign'));
  const configs = new Stage6S3ConfigService(pool as pg.Pool,
    new StorageCredentialCipher(Buffer.alloc(32, 9), 1), () => new IntegrationS3Transport());
  const config = await configs.create(administrator, {displayName: '测试 S3', endpoint: 'https://s3.example.com',
    region: 'ap-shanghai', bucket: 'quorum-files', prefix: 'instance', forcePathStyle: true,
    allowPrivateNetwork: false, credentials: {accessKeyId: 'access', secretAccessKey: 'secret'}},
  's3-config', context('s3-config'));
  const binding = await storage.createS3Binding(chair, committee.id,
    {baseRevision: committee.revision, providerConfigId: config.id}, 's3-binding', context('s3-binding'));
  return {owner, chair, member, committee, config, binding, configs};
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

  it('streams verified bytes to durable staging without creating a file version', async () => {
    const fixture = await storageFixture();
    const content = 'stage 6.2 durable bytes';
    const created = await uploads.createUpload(fixture.member, fixture.committee.id, {
      logicalName: '工作文件二',
      originalName: '../../committee-notes.pdf',
      mediaType: 'application/pdf',
      expectedSizeBytes: Buffer.byteLength(content),
      sha256: digest(content)
    }, 'create-upload', context('create-upload'));
    expect(created.status).toBe('CREATED');
    const staged = await uploads.receiveContent(fixture.member, created.id,
      (async function* () { yield 'stage 6.2 '; yield Buffer.from('durable bytes'); })(),
      'upload-content', Buffer.byteLength(content), context('upload-content'));
    expect(staged).toEqual(expect.objectContaining({
      status: 'STAGED',
      receivedSizeBytes: Buffer.byteLength(content),
      actualSha256: digest(content)
    }));
    const replayed = await uploads.receiveContent(fixture.member, created.id,
      (async function* () { yield content; })(), 'upload-content', Buffer.byteLength(content),
      context('upload-content-replay'));
    expect(replayed).toEqual(staged);
    const state = await pool?.query(`SELECT u.status,u.received_size_bytes,encode(u.actual_sha256,'hex') AS actual_sha256,
      u.staging_key,
      (SELECT count(*)::int FROM file_entries) AS files,
      (SELECT count(*)::int FROM file_versions) AS versions,
      (SELECT count(*)::int FROM file_blobs) AS blobs,
      (SELECT count(*)::int FROM committee_events WHERE resource_id=u.id) AS events,
      (SELECT count(*)::int FROM audit_log WHERE resource_id=u.id) AS audits,
      (SELECT count(*)::int FROM idempotency_keys WHERE key IN ('create-upload','upload-content')) AS idempotency
      FROM file_uploads u WHERE u.id=$1`, [created.id]);
    expect(state?.rows[0]).toEqual(expect.objectContaining({
      status: 'STAGED', received_size_bytes: String(Buffer.byteLength(content)), actual_sha256: digest(content),
      files: 0, versions: 0, blobs: 0, events: 2, audits: 2, idempotency: 2
    }));
    expect(state?.rows[0]?.staging_key).toMatch(/^uploads\/[a-f0-9]{2}\/[a-f0-9]{32}$/);
    expect(state?.rows[0]?.staging_key).not.toContain('committee-notes');
  });

  it('records short, long, interrupted, hash, and disk failures without file records', async () => {
    const fixture = await storageFixture();
    const cases: Array<{name: string; expected: number; hash: string; source: () => AsyncIterable<string>}> = [
      {name: 'short', expected: 5, hash: digest('12345'), source: () => (async function* () { yield '1234'; })()},
      {name: 'long', expected: 4, hash: digest('1234'), source: () => (async function* () { yield '12345'; })()},
      {name: 'hash', expected: 4, hash: digest('xxxx'), source: () => (async function* () { yield '1234'; })()},
      {name: 'interrupted', expected: 8, hash: digest('12345678'), source: () => (async function* () {
        yield '1234'; throw new Error('connection reset');
      })()}
    ];
    for (const item of cases) {
      const upload = await uploads.createUpload(fixture.member, fixture.committee.id, {
        logicalName: item.name, originalName: `${item.name}.bin`, mediaType: 'application/octet-stream',
        expectedSizeBytes: item.expected, sha256: item.hash
      }, `create-${item.name}`, context(`create-${item.name}`));
      await expect(uploads.receiveContent(fixture.member, upload.id, item.source(),
        `content-${item.name}`, undefined, context(`content-${item.name}`))).rejects.toBeDefined();
    }

    const diskOperations: StagingOperations = {link, lstat, mkdir, realpath, unlink,
      open: async () => { throw Object.assign(new Error('disk full'), {code: 'ENOSPC'}); }} as StagingOperations;
    const failingStore = new DurableStagingStore(join(stagingRoot, 'disk-failure'), 1024, 2048, diskOperations);
    await failingStore.initialize();
    const failingUploads = new Stage6UploadService(pool as pg.Pool, failingStore);
    const diskUpload = await failingUploads.createUpload(fixture.member, fixture.committee.id, {
      logicalName: 'disk', originalName: 'disk.bin', mediaType: 'application/octet-stream',
      expectedSizeBytes: 4, sha256: digest('data')
    }, 'create-disk', context('create-disk'));
    await expect(failingUploads.receiveContent(fixture.member, diskUpload.id,
      (async function* () { yield 'data'; })(), 'content-disk', 4, context('content-disk')))
      .rejects.toMatchObject({code: 'SERVICE_NOT_READY'});

    await expect(uploads.createUpload(fixture.member, fixture.committee.id, {
      logicalName: 'large', originalName: 'large.bin', mediaType: 'application/octet-stream',
      expectedSizeBytes: staging.maxFileBytes + 1, sha256: digest('large')
    }, 'create-large', context('create-large'))).rejects.toMatchObject({code: 'PAYLOAD_TOO_LARGE'});
    const state = await pool?.query(`SELECT
      (SELECT count(*)::int FROM file_uploads WHERE status='FAILED') AS failed,
      (SELECT count(*)::int FROM file_entries) AS files,
      (SELECT count(*)::int FROM file_versions) AS versions,
      (SELECT count(*)::int FROM file_blobs) AS blobs`);
    expect(state?.rows[0]).toEqual({failed: 5, files: 0, versions: 0, blobs: 0});
  });

  it('keeps a completed staging copy when a paused committee blocks final state', async () => {
    const fixture = await storageFixture();
    const content = 'pause-safe';
    const upload = await uploads.createUpload(fixture.member, fixture.committee.id, {
      logicalName: '暂停测试', originalName: 'paused.bin', mediaType: 'application/octet-stream',
      expectedSizeBytes: Buffer.byteLength(content), sha256: digest(content)
    }, 'create-paused', context('create-paused'));
    let pausedRevision = 0;
    const source = (async function* () {
      yield 'pause-';
      const paused = await stage3.setCommitteeStatus(fixture.chair, fixture.committee.id, 'PAUSED',
        fixture.committee.revision + 1, context('pause-during-upload'));
      pausedRevision = paused.revision;
      yield 'safe';
    })();
    await expect(uploads.receiveContent(fixture.member, upload.id, source,
      'paused-content', Buffer.byteLength(content), context('paused-content')))
      .rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    const receiving = await pool?.query(`SELECT status,staging_key,
      (SELECT count(*)::int FROM file_versions) AS versions FROM file_uploads WHERE id=$1`, [upload.id]);
    expect(receiving?.rows[0]).toEqual(expect.objectContaining({status: 'RECEIVING', versions: 0}));
    expect(await staging.exists(receiving?.rows[0]?.staging_key)).toBe(true);

    await expect(uploads.createUpload(fixture.member, fixture.committee.id, {
      logicalName: '暂停拒绝', originalName: 'blocked.bin', mediaType: 'application/octet-stream',
      expectedSizeBytes: 1, sha256: digest('x')
    }, 'paused-create', context('paused-create'))).rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    await stage3.setCommitteeStatus(fixture.chair, fixture.committee.id, 'ACTIVE',
      pausedRevision, context('resume-after-upload'));
    const recovered = await uploads.receiveContent(fixture.member, upload.id,
      (async function* () { yield 'ignored'; })(), 'paused-content', undefined, context('recover-content'));
    expect(recovered.status).toBe('STAGED');
  });

  it('rolls back staged state, event, audit, and idempotency together', async () => {
    const fixture = await storageFixture();
    const content = 'atomic-staging';
    const upload = await uploads.createUpload(fixture.member, fixture.committee.id, {
      logicalName: '原子暂存', originalName: 'atomic.bin', mediaType: 'application/octet-stream',
      expectedSizeBytes: Buffer.byteLength(content), sha256: digest(content)
    }, 'create-atomic-staging', context('create-atomic-staging'));
    await pool?.query(`CREATE FUNCTION fail_stage6_upload_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action='storage.upload_staged' THEN RAISE EXCEPTION 'injected upload audit failure'; END IF;
        RETURN NEW;
      END; $$`);
    await pool?.query(`CREATE TRIGGER fail_stage6_upload_audit BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION fail_stage6_upload_audit()`);
    await expect(uploads.receiveContent(fixture.member, upload.id,
      (async function* () { yield content; })(), 'atomic-staging-content', Buffer.byteLength(content),
      context('atomic-staging-content'))).rejects.toThrow('injected upload audit failure');
    const state = await pool?.query(`SELECT u.status,u.staging_key,
      (SELECT count(*)::int FROM committee_events WHERE resource_id=u.id AND event_type='file.upload_staged') AS events,
      (SELECT count(*)::int FROM audit_log WHERE resource_id=u.id AND action='storage.upload_staged') AS audits,
      (SELECT count(*)::int FROM idempotency_keys WHERE key='atomic-staging-content') AS idempotency,
      (SELECT count(*)::int FROM file_versions) AS versions
      FROM file_uploads u WHERE u.id=$1`, [upload.id]);
    expect(state?.rows[0]).toEqual(expect.objectContaining({
      status: 'RECEIVING', events: 0, audits: 0, idempotency: 0, versions: 0
    }));
    expect(await staging.exists(state?.rows[0]?.staging_key)).toBe(true);
  });

  it('commits a STAGED upload to SERVER_VOLUME exactly once', async () => {
    const fixture = await storageFixture();
    const content = 'server-volume-provider-content';
    const upload = await uploads.createUpload(fixture.member, fixture.committee.id, {
      logicalName: '服务器卷文件', originalName: '../../provider.pdf', mediaType: 'application/pdf',
      expectedSizeBytes: Buffer.byteLength(content), sha256: digest(content)
    }, 'provider-upload', context('provider-upload'));
    await uploads.receiveContent(fixture.member, upload.id, (async function* () { yield content; })(),
      'provider-content', Buffer.byteLength(content), context('provider-content'));
    const file = await serverVolume.commitUpload(fixture.member, upload.id, {},
      'provider-commit', context('provider-commit'));
    expect(file.currentVersion).toEqual(expect.objectContaining({
      sizeBytes: Buffer.byteLength(content), sha256: digest(content)
    }));
    const replayed = await serverVolume.commitUpload(fixture.member, upload.id, {},
      'provider-commit', context('provider-commit-replay'));
    expect(replayed).toEqual(file);
    const state = await pool?.query(`SELECT u.status,u.provider_blob_id,u.provider_storage_key,
      u.committed_blob_id,u.committed_file_entry_id,u.committed_file_version_id,
      (SELECT count(*)::int FROM file_blobs WHERE id=u.provider_blob_id) AS blobs,
      (SELECT count(*)::int FROM file_versions WHERE file_entry_id=u.committed_file_entry_id) AS versions,
      (SELECT count(*)::int FROM committee_events WHERE resource_id=u.id AND event_type='file.upload_committed') AS events,
      (SELECT count(*)::int FROM audit_log WHERE resource_id=u.id AND action='storage.upload_committed') AS audits,
      (SELECT count(*)::int FROM idempotency_keys WHERE key='provider-commit') AS idempotency
      FROM file_uploads u WHERE u.id=$1`, [upload.id]);
    expect(state?.rows[0]).toEqual(expect.objectContaining({
      status: 'COMMITTED',
      committed_blob_id: state?.rows[0]?.provider_blob_id,
      committed_file_entry_id: file.id,
      committed_file_version_id: file.currentVersion.id,
      blobs: 1, versions: 1, events: 1, audits: 1, idempotency: 1
    }));
    expect(state?.rows[0]?.provider_storage_key).toMatch(/^blobs\/[a-f0-9]{2}\/[a-f0-9]{32}$/);
    expect(state?.rows[0]?.provider_storage_key).not.toContain('provider.pdf');
    expect(await volume.verify(state?.rows[0]?.provider_storage_key,
      Buffer.byteLength(content), digest(content))).toEqual({sizeBytes: Buffer.byteLength(content), sha256: digest(content)});
  });

  it('rolls back upload, file, event, audit, and idempotency while retaining both byte copies', async () => {
    const fixture = await storageFixture();
    const content = 'provider-atomic-content';
    const upload = await uploads.createUpload(fixture.member, fixture.committee.id, {
      logicalName: 'Provider 原子性', originalName: 'atomic-provider.bin', mediaType: 'application/octet-stream',
      expectedSizeBytes: Buffer.byteLength(content), sha256: digest(content)
    }, 'provider-atomic-upload', context('provider-atomic-upload'));
    await uploads.receiveContent(fixture.member, upload.id, (async function* () { yield content; })(),
      'provider-atomic-content', Buffer.byteLength(content), context('provider-atomic-content'));
    await pool?.query(`CREATE FUNCTION fail_stage6_provider_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action='storage.upload_committed' THEN RAISE EXCEPTION 'injected provider audit failure'; END IF;
        RETURN NEW;
      END; $$`);
    await pool?.query(`CREATE TRIGGER fail_stage6_provider_audit BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION fail_stage6_provider_audit()`);
    await expect(serverVolume.commitUpload(fixture.member, upload.id, {},
      'provider-atomic-commit', context('provider-atomic-commit'))).rejects.toThrow('injected provider audit failure');
    const failed = await pool?.query(`SELECT status,provider_blob_id,provider_storage_key,staging_key,
      (SELECT count(*)::int FROM file_entries) AS files,
      (SELECT count(*)::int FROM file_blobs) AS blobs,
      (SELECT count(*)::int FROM file_versions) AS versions,
      (SELECT count(*)::int FROM committee_events WHERE resource_id=file_uploads.id
        AND event_type='file.upload_committed') AS events,
      (SELECT count(*)::int FROM audit_log WHERE resource_id=file_uploads.id
        AND action='storage.upload_committed') AS audits,
      (SELECT count(*)::int FROM idempotency_keys WHERE key='provider-atomic-commit') AS idempotency
      FROM file_uploads WHERE id=$1`, [upload.id]);
    expect(failed?.rows[0]).toEqual(expect.objectContaining({
      status: 'STAGED', files: 0, blobs: 0, versions: 0, events: 0, audits: 0, idempotency: 0
    }));
    expect(await staging.exists(failed?.rows[0]?.staging_key)).toBe(true);
    expect(await volume.verify(failed?.rows[0]?.provider_storage_key,
      Buffer.byteLength(content), digest(content))).toBeDefined();
    await pool?.query('DROP TRIGGER fail_stage6_provider_audit ON audit_log');
    await pool?.query('DROP FUNCTION fail_stage6_provider_audit()');
    const recovered = await serverVolume.commitUpload(fixture.member, upload.id, {},
      'provider-atomic-commit', context('provider-atomic-retry'));
    expect(recovered.currentVersion.sha256).toBe(digest(content));
  });

  it('rejects SERVER_VOLUME commit while the committee is paused', async () => {
    const fixture = await storageFixture();
    const content = 'paused-provider';
    const upload = await uploads.createUpload(fixture.member, fixture.committee.id, {
      logicalName: '暂停 Provider', originalName: 'paused-provider.bin', mediaType: 'application/octet-stream',
      expectedSizeBytes: Buffer.byteLength(content), sha256: digest(content)
    }, 'paused-provider-upload', context('paused-provider-upload'));
    await uploads.receiveContent(fixture.member, upload.id, (async function* () { yield content; })(),
      'paused-provider-content', Buffer.byteLength(content), context('paused-provider-content'));
    await stage3.setCommitteeStatus(fixture.chair, fixture.committee.id, 'PAUSED',
      fixture.committee.revision + 1, context('pause-provider'));
    await expect(serverVolume.commitUpload(fixture.member, upload.id, {},
      'paused-provider-commit', context('paused-provider-commit'))).rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    const state = await pool?.query(`SELECT status,
      (SELECT count(*)::int FROM file_versions) AS versions FROM file_uploads WHERE id=$1`, [upload.id]);
    expect(state?.rows[0]).toEqual({status: 'STAGED', versions: 0});
  });

  it('rechecks contributor membership before claiming or writing a provider target', async () => {
    const fixture = await storageFixture();
    const content = 'revoked-provider';
    const upload = await uploads.createUpload(fixture.member, fixture.committee.id, {
      logicalName: '已撤销成员上传', originalName: 'revoked.bin', mediaType: 'application/octet-stream',
      expectedSizeBytes: Buffer.byteLength(content), sha256: digest(content)
    }, 'revoked-provider-upload', context('revoked-provider-upload'));
    await uploads.receiveContent(fixture.member, upload.id, (async function* () { yield content; })(),
      'revoked-provider-content', Buffer.byteLength(content), context('revoked-provider-content'));
    await pool?.query(`UPDATE committee_memberships SET status='SUSPENDED',updated_at=now()
      WHERE committee_id=$1 AND user_id=$2`, [fixture.committee.id, fixture.member.user.id]);
    await expect(serverVolume.commitUpload(fixture.member, upload.id, {},
      'revoked-provider-commit', context('revoked-provider-commit'))).rejects.toMatchObject({code: 'FORBIDDEN'});
    const state = await pool?.query(`SELECT status,provider_blob_id,provider_storage_key,
      (SELECT count(*)::int FROM file_versions) AS versions FROM file_uploads WHERE id=$1`, [upload.id]);
    expect(state?.rows[0]).toEqual({status: 'STAGED', provider_blob_id: null, provider_storage_key: null, versions: 0});
  });

  it('encrypts S3 credentials, hides them from summaries, and restricts configuration to the administrator', async () => {
    const cipher = new StorageCredentialCipher(Buffer.alloc(32, 8), 2);
    const configs = new Stage6S3ConfigService(pool as pg.Pool, cipher, () => new IntegrationS3Transport());
    const ordinary = await user('ordinary-config-user');
    const body = {displayName: '对象存储', endpoint: 'https://s3.example.com', region: 'ap-shanghai',
      bucket: 'quorum-files', prefix: 'instance', forcePathStyle: true, allowPrivateNetwork: false,
      credentials: {accessKeyId: 'visible-access', secretAccessKey: 'top-secret'}};
    await expect(configs.create(ordinary, body, 'forbidden-s3-config', context('forbidden-s3-config')))
      .rejects.toMatchObject({code: 'FORBIDDEN'});
    const created = await configs.create(administrator, body, 'create-s3-config', context('create-s3-config'));
    expect(created).not.toHaveProperty('credentials');
    const stored = await pool?.query(`SELECT credentials_ciphertext,credentials_nonce,credentials_auth_tag,
      credential_key_version FROM storage_provider_configs WHERE id=$1`, [created.id]);
    expect(stored?.rows[0]?.credentials_ciphertext.toString('utf8')).not.toContain('top-secret');
    expect(cipher.decrypt(created.id, {ciphertext: stored?.rows[0]?.credentials_ciphertext,
      nonce: stored?.rows[0]?.credentials_nonce, authTag: stored?.rows[0]?.credentials_auth_tag,
      keyVersion: stored?.rows[0]?.credential_key_version})).toEqual(body.credentials);
  });

  it('commits a STAGED upload to S3 exactly once with a blob-derived object key', async () => {
    const fixture = await s3Fixture();
    const content = 's3-provider-content';
    const upload = await uploads.createUpload(fixture.member, fixture.committee.id, {
      logicalName: 'S3 文件', originalName: '../../unsafe-name.pdf', mediaType: 'application/pdf',
      expectedSizeBytes: Buffer.byteLength(content), sha256: digest(content)
    }, 's3-upload', context('s3-upload'));
    await uploads.receiveContent(fixture.member, upload.id, (async function* () {yield content;})(),
      's3-content', Buffer.byteLength(content), context('s3-content'));
    const transport = new IntegrationS3Transport();
    const service = new Stage6S3CommitService(pool as pg.Pool, storage, staging, fixture.configs,
      config => new S3CompatibleStore(config, transport, 20 * 1024 * 1024));
    const file = await service.commitUpload(fixture.member, upload.id, {}, 's3-commit', context('s3-commit'));
    const replay = await service.commitUpload(fixture.member, upload.id, {}, 's3-commit', context('s3-replay'));
    expect(replay).toEqual(file);
    const state = await pool?.query(`SELECT status,provider_storage_key,
      (SELECT count(*)::int FROM file_blobs) AS blobs,(SELECT count(*)::int FROM file_versions) AS versions
      FROM file_uploads WHERE id=$1`, [upload.id]);
    expect(state?.rows[0]).toEqual(expect.objectContaining({status: 'COMMITTED', blobs: 1, versions: 1}));
    expect(state?.rows[0]?.provider_storage_key).toMatch(/^instance\/blobs\/[a-f0-9]{2}\/[a-f0-9]{32}$/);
    expect(state?.rows[0]?.provider_storage_key).not.toContain('unsafe-name');
  });
});
