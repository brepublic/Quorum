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
import {Stage6FileService} from './file-service';
import {Stage6MigrationService} from './migration-service';
import {Stage6MaintenanceService} from './maintenance-service';
import {createLogger} from '../../logger';

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
let files: Stage6FileService;
let fileS3Configs: Stage6S3ConfigService;
let storageMigrations: Stage6MigrationService;
let administrator: AuthenticatedSession;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

const context = (name: string) => ({requestId: `stage6-${name}`, sourceIp: '127.0.0.1', userAgent: 'Vitest'});
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const blobKey = () => `blobs/${randomUUID().replaceAll('-', '')}`;
const availableCapacity = {sample: async () => ({state: 'normal' as const, usageRatio: 0.5, usagePercent: 50,
  totalBytes: 1000, availableBytes: 500}), assertWriteAllowed: async () => ({state: 'normal' as const,
  usageRatio: 0.5, usagePercent: 50, totalBytes: 1000, availableBytes: 500})};

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
  fileS3Configs = new Stage6S3ConfigService(pool, new StorageCredentialCipher(Buffer.alloc(32, 7), 1),
    () => new IntegrationS3Transport());
  files = new Stage6FileService(pool, volume, fileS3Configs,
    config => new S3CompatibleStore(config, new IntegrationS3Transport(), 20 * 1024 * 1024));
  storageMigrations = new Stage6MigrationService(pool, staging, volume, fileS3Configs,
    config => new S3CompatibleStore(config, new IntegrationS3Transport(), 20 * 1024 * 1024));
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

async function storageFixture(visibility: 'PUBLIC' | 'PRIVATE' = 'PUBLIC') {
  const owner = await user('owner');
  const chair = await user('chair');
  const member = await user('member');
  let committee = await stage4.createCommittee(owner, {name: 'Stage 6 Council', visibility,
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
  failPut = false;
  failDelete = false;
  corruptReads = false;
  async request(input: S3Request): Promise<S3Response> {
    if (input.method === 'PUT') {
      if (this.failPut) throw new Error('put unavailable');
      const chunks: Buffer[] = [];
      for await (const chunk of input.body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
      this.objects.set(input.key, Buffer.concat(chunks));
      return {statusCode: 200, headers: {}, body: (async function* () {})()};
    }
    if (input.method === 'GET') {
      const content = this.corruptReads ? Buffer.from('corrupt') : this.objects.get(input.key);
      return {statusCode: content ? 200 : 404, headers: {}, body: (async function* () {if (content) yield content;})()};
    }
    if (this.failDelete) throw new Error('delete unavailable');
    this.objects.delete(input.key);
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

async function createMigrationS3Config(name: string) {
  const created = await fileS3Configs.create(administrator, {displayName: name, endpoint: 'https://s3.example.com',
    region: 'ap-shanghai', bucket: 'quorum-files', prefix: name.toLowerCase().replaceAll(' ', '-'),
    forcePathStyle: true, allowPrivateNetwork: false,
    credentials: {accessKeyId: `${name}-access`, secretAccessKey: `${name}-secret`}},
  `${name}-config`, context(`${name}-config`));
  return fileS3Configs.verify(administrator, created.id, `${name}-verify`, context(`${name}-verify`));
}

async function committedServerFile(fixture: Awaited<ReturnType<typeof storageFixture>>, content: string,
  key: string) {
  const upload = await uploads.createUpload(fixture.member, fixture.committee.id, {
    logicalName: `文件 ${key}`, originalName: `${key}.pdf`, mediaType: 'application/pdf',
    expectedSizeBytes: Buffer.byteLength(content), sha256: digest(content)
  }, `${key}-upload`, context(`${key}-upload`));
  await uploads.receiveContent(fixture.member, upload.id, (async function* () {yield content;})(),
    `${key}-content`, Buffer.byteLength(content), context(`${key}-content`));
  return serverVolume.commitUpload(fixture.member, upload.id, {}, `${key}-commit`, context(`${key}-commit`));
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
    await expect(storage.deleteFile(fixture.member, file.id, {baseRevision: file.revision}, 'paused-delete',
      context('paused-delete')))
      .rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    await stage3.setCommitteeStatus(fixture.chair, fixture.committee.id, 'ACTIVE', paused.revision, context('resume'));
    const tombstone = await storage.deleteFile(fixture.member, file.id,
      {baseRevision: file.revision}, 'delete-file', context('delete'));
    expect(tombstone.lastContentRevision).toBe(file.revision);
    const deleted = await pool?.query(`SELECT e.status,e.current_version_id,
      (SELECT count(*)::int FROM file_tombstones WHERE file_entry_id=e.id) AS tombstones,
      (SELECT count(*)::int FROM file_blobs b JOIN file_versions v ON v.blob_id=b.id
        WHERE v.file_entry_id=e.id AND b.durability_state='DELETE_PENDING') AS pending_deletes,
      (SELECT count(*)::int FROM file_blob_delete_jobs j WHERE j.file_entry_id=e.id) AS delete_jobs
      FROM file_entries e WHERE e.id=$1`, [file.id]);
    expect(deleted?.rows[0]).toEqual({status: 'DELETED', current_version_id: null, tombstones: 1,
      pending_deletes: 2, delete_jobs: 2});

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

  it('rejects only new upload bytes at critical capacity while preserving idempotent replay', async () => {
    const fixture = await storageFixture();
    let writable = true;
    const capacity = {sample: availableCapacity.sample, assertWriteAllowed: async () => {
      if (!writable) throw Object.assign(new Error('capacity critical'), {code: 'SERVICE_NOT_READY'});
      return availableCapacity.assertWriteAllowed();
    }};
    const guarded = new Stage6UploadService(pool as pg.Pool, staging, 24 * 60 * 60 * 1000, undefined, capacity);
    const body = {logicalName: '容量保护', originalName: 'capacity.bin', mediaType: 'application/octet-stream',
      expectedSizeBytes: 4, sha256: digest('data')};
    const created = await guarded.createUpload(fixture.member, fixture.committee.id, body,
      'capacity-create', context('capacity-create'));
    writable = false;
    expect(await guarded.createUpload(fixture.member, fixture.committee.id, body,
      'capacity-create', context('capacity-create-replay'))).toEqual(created);
    await expect(guarded.createUpload(fixture.member, fixture.committee.id, body,
      'capacity-create-blocked', context('capacity-create-blocked'))).rejects.toMatchObject({code: 'SERVICE_NOT_READY'});
    await expect(guarded.receiveContent(fixture.member, created.id, (async function* () {yield 'data';})(),
      'capacity-content', 4, context('capacity-content'))).rejects.toMatchObject({code: 'SERVICE_NOT_READY'});
    expect((await pool?.query('SELECT status FROM file_uploads WHERE id=$1', [created.id]))?.rows[0]?.status)
      .toBe('CREATED');
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

  it('cleans committed upload staging but preserves the only STAGED copy', async () => {
    const fixture = await storageFixture();
    await committedServerFile(fixture, 'safe committed cleanup', 'cleanup-committed');
    const stagedContent = 'only staged copy';
    const staged = await uploads.createUpload(fixture.member, fixture.committee.id, {
      logicalName: '暂存保护', originalName: 'staged.bin', mediaType: 'application/octet-stream',
      expectedSizeBytes: Buffer.byteLength(stagedContent), sha256: digest(stagedContent)
    }, 'cleanup-staged-upload', context('cleanup-staged-upload'));
    await uploads.receiveContent(fixture.member, staged.id, (async function* () {yield stagedContent;})(),
      'cleanup-staged-content', Buffer.byteLength(stagedContent), context('cleanup-staged-content'));
    const committed = await pool?.query<{id: string; staging_key: string}>(`SELECT id,staging_key FROM file_uploads
      WHERE logical_name='文件 cleanup-committed'`);
    const maintenance = new Stage6MaintenanceService(pool as pg.Pool, staging, files, availableCapacity,
      createLogger(() => undefined));
    expect(await maintenance.processNext()).toEqual({kind: 'FILE_UPLOAD_STAGING',
      outcome: 'SUCCEEDED', failureCode: null});
    expect(await staging.exists(committed?.rows[0]?.staging_key as string)).toBe(false);
    expect(await staging.exists((await pool?.query<{staging_key: string}>('SELECT staging_key FROM file_uploads WHERE id=$1',
      [staged.id]))?.rows[0]?.staging_key as string)).toBe(true);
    const state = await pool?.query(`SELECT staging_deleted_at IS NOT NULL AS deleted,
      (SELECT count(*)::int FROM storage_cleanup_audit WHERE resource_id=$1 AND outcome='SUCCEEDED') AS audits
      FROM file_uploads WHERE id=$1`, [committed?.rows[0]?.id]);
    expect(state?.rows[0]).toEqual({deleted: true, audits: 1});
  });

  it('retries a fenced staging cleanup failure without losing the committed file', async () => {
    const fixture = await storageFixture();
    const file = await committedServerFile(fixture, 'cleanup retry bytes', 'cleanup-retry');
    const failingStore = new DurableStagingStore(stagingRoot, 20 * 1024 * 1024, 21 * 1024 * 1024, {
      link, lstat, mkdir, open, realpath,
      unlink: async () => {throw Object.assign(new Error('cleanup unavailable'), {code: 'EIO'});}
    });
    await failingStore.initialize();
    const failing = new Stage6MaintenanceService(pool as pg.Pool, failingStore, files, availableCapacity,
      createLogger(() => undefined));
    expect(await failing.processNext()).toEqual({kind: 'FILE_UPLOAD_STAGING', outcome: 'FAILED',
      failureCode: 'STAGING_CLEANUP_FAILED'});
    const retry = await pool?.query(`SELECT cleanup_attempts,cleanup_claim_token,cleanup_failure_code,
      staging_deleted_at FROM file_uploads WHERE logical_name='文件 cleanup-retry'`);
    expect(retry?.rows[0]).toEqual({cleanup_attempts: 1, cleanup_claim_token: null,
      cleanup_failure_code: 'STAGING_CLEANUP_FAILED', staging_deleted_at: null});
    await pool?.query(`UPDATE file_uploads SET cleanup_next_attempt_at=now()-interval '1 second'
      WHERE logical_name='文件 cleanup-retry'`);
    const recovered = new Stage6MaintenanceService(pool as pg.Pool, staging, files, availableCapacity,
      createLogger(() => undefined));
    expect(await recovered.processNext()).toEqual({kind: 'FILE_UPLOAD_STAGING', outcome: 'SUCCEEDED',
      failureCode: null});
    expect((await files.get(fixture.member, file.id)).id).toBe(file.id);
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

  it('enforces review roles, revisions, pause state, visibility, and verified SERVER_VOLUME downloads', async () => {
    const fixture = await storageFixture();
    const content = 'reviewed server volume content';
    const created = await committedServerFile(fixture, content, 'review-flow');
    expect(await files.list(undefined, fixture.committee.id)).toEqual([]);
    await expect(files.get(undefined, created.id)).rejects.toMatchObject({code: 'NOT_FOUND'});
    expect((await files.get(fixture.member, created.id)).id).toBe(created.id);
    await expect(files.publish(fixture.member, created.id, {baseRevision: created.revision}, 'member-publish',
      context('member-publish'))).rejects.toMatchObject({code: 'FORBIDDEN'});

    const pending = await files.submitForReview(fixture.member, created.id, {baseRevision: created.revision},
      'submit-review', context('submit-review'));
    expect(pending).toEqual(expect.objectContaining({status: 'PENDING_REVIEW', revision: created.revision + 1,
      submittedAt: expect.any(String), publishedAt: null}));
    expect(await files.submitForReview(fixture.member, created.id, {baseRevision: created.revision},
      'submit-review', context('submit-review-replay'))).toEqual(pending);
    await expect(files.submitForReview(fixture.member, created.id, {baseRevision: pending.revision},
      'submit-review', context('submit-review-conflict'))).rejects.toMatchObject({code: 'IDEMPOTENCY_CONFLICT'});
    await expect(files.publish(fixture.chair, created.id, {baseRevision: created.revision}, 'stale-publish',
      context('stale-publish'))).rejects.toMatchObject({code: 'REVISION_CONFLICT'});
    const paused = await stage3.setCommitteeStatus(fixture.chair, fixture.committee.id, 'PAUSED',
      fixture.committee.revision + 1, context('pause-review'));
    await expect(files.publish(fixture.chair, created.id, {baseRevision: pending.revision}, 'paused-publish',
      context('paused-publish'))).rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    await stage3.setCommitteeStatus(fixture.chair, fixture.committee.id, 'ACTIVE', paused.revision,
      context('resume-review'));
    const published = await files.publish(fixture.chair, created.id, {baseRevision: pending.revision},
      'publish', context('publish'));
    expect(published).toEqual(expect.objectContaining({status: 'PUBLISHED', revision: pending.revision + 1,
      publishedAt: expect.any(String)}));
    expect(await files.publish(fixture.chair, created.id, {baseRevision: pending.revision}, 'publish',
      context('publish-replay'))).toEqual(published);
    expect(await files.list(undefined, fixture.committee.id)).toEqual([published]);
    const download = await files.download(undefined, created.id);
    const chunks: Buffer[] = [];
    for await (const chunk of download.content) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe(content);
    expect(download.headers).toEqual(expect.objectContaining({'content-type': 'application/pdf',
      'content-disposition': expect.stringMatching(/^attachment;/), 'x-content-type-options': 'nosniff'}));
    const records = await pool?.query(`SELECT
      (SELECT count(*)::int FROM committee_events WHERE resource_id=$1
        AND event_type IN ('file.review_requested','file.published')) AS events,
      (SELECT count(*)::int FROM audit_log WHERE resource_id=$1
        AND action IN ('storage.file_review_requested','storage.file_published')) AS audits`, [created.id]);
    expect(records?.rows[0]).toEqual({events: 2, audits: 2});
  });

  it('hides every file in a private committee from unauthenticated callers', async () => {
    const fixture = await storageFixture('PRIVATE');
    const created = await committedServerFile(fixture, 'private content', 'private-file');
    await expect(files.list(undefined, fixture.committee.id)).rejects.toMatchObject({code: 'NOT_FOUND'});
    await expect(files.get(undefined, created.id)).rejects.toMatchObject({code: 'NOT_FOUND'});
    expect(await files.list(fixture.member, fixture.committee.id)).toEqual([created]);
  });

  it('rolls back review state and its event when audit persistence fails', async () => {
    const fixture = await storageFixture();
    const created = await committedServerFile(fixture, 'review atomicity', 'review-atomicity');
    const pending = await files.submitForReview(fixture.member, created.id, {baseRevision: created.revision},
      'atomic-submit', context('atomic-submit'));
    await pool?.query(`CREATE FUNCTION fail_stage6_publish_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action='storage.file_published' THEN RAISE EXCEPTION 'injected publish audit failure'; END IF;
        RETURN NEW;
      END; $$`);
    await pool?.query(`CREATE TRIGGER fail_stage6_publish_audit BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION fail_stage6_publish_audit()`);
    await expect(files.publish(fixture.chair, created.id, {baseRevision: pending.revision}, 'atomic-publish',
      context('atomic-publish'))).rejects.toThrow('injected publish audit failure');
    const state = await pool?.query(`SELECT e.status,e.revision,
      (SELECT count(*)::int FROM committee_events WHERE resource_id=e.id AND event_type='file.published') AS events,
      (SELECT count(*)::int FROM audit_log WHERE resource_id=e.id AND action='storage.file_published') AS audits,
      (SELECT count(*)::int FROM idempotency_keys WHERE key='atomic-publish') AS idempotency
      FROM file_entries e WHERE e.id=$1`, [created.id]);
    expect(state?.rows[0]).toEqual({status: 'PENDING_REVIEW', revision: pending.revision,
      events: 0, audits: 0, idempotency: 0});
  });

  it('rolls back tombstone, delete jobs, blob state, event, and idempotency when deletion audit fails', async () => {
    const fixture = await storageFixture();
    const created = await committedServerFile(fixture, 'delete atomicity', 'delete-atomicity');
    await pool?.query(`CREATE FUNCTION fail_stage6_delete_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action='storage.file_deleted' THEN RAISE EXCEPTION 'injected delete audit failure'; END IF;
        RETURN NEW;
      END; $$`);
    await pool?.query(`CREATE TRIGGER fail_stage6_delete_audit BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION fail_stage6_delete_audit()`);
    await expect(storage.deleteFile(fixture.member, created.id, {baseRevision: created.revision},
      'atomic-delete', context('atomic-delete'))).rejects.toThrow('injected delete audit failure');
    const state = await pool?.query(`SELECT e.status,e.revision,
      (SELECT count(*)::int FROM file_tombstones WHERE file_entry_id=e.id) AS tombstones,
      (SELECT count(*)::int FROM file_blob_delete_jobs WHERE file_entry_id=e.id) AS jobs,
      (SELECT count(*)::int FROM file_blobs b JOIN file_versions v ON v.blob_id=b.id
        WHERE v.file_entry_id=e.id AND b.durability_state='COMMITTED') AS committed,
      (SELECT count(*)::int FROM committee_events WHERE resource_id=e.id AND event_type='file.deleted') AS events,
      (SELECT count(*)::int FROM idempotency_keys WHERE key='atomic-delete') AS idempotency
      FROM file_entries e WHERE e.id=$1`, [created.id]);
    expect(state?.rows[0]).toEqual({status: 'UPLOAD_COMPLETE', revision: created.revision,
      tombstones: 0, jobs: 0, committed: 1, events: 0, idempotency: 0});
  });

  it('makes logical deletion immediate and completes its durable SERVER_VOLUME delete job', async () => {
    const fixture = await storageFixture();
    const created = await committedServerFile(fixture, 'delete this provider copy', 'delete-job');
    const storageKey = (await pool?.query<{storage_key: string}>(`SELECT b.storage_key FROM file_blobs b
      JOIN file_versions v ON v.blob_id=b.id WHERE v.file_entry_id=$1`, [created.id]))?.rows[0]?.storage_key as string;
    const tombstone = await storage.deleteFile(fixture.member, created.id, {baseRevision: created.revision},
      'logical-delete', context('logical-delete'));
    expect(await storage.deleteFile(fixture.member, created.id, {baseRevision: created.revision},
      'logical-delete', context('logical-delete-replay'))).toEqual(tombstone);
    await expect(files.get(fixture.member, created.id)).rejects.toMatchObject({code: 'NOT_FOUND'});
    const pending = await pool?.query(`SELECT j.status,j.attempts,b.durability_state FROM file_blob_delete_jobs j
      JOIN file_blobs b ON b.id=j.blob_id WHERE j.file_entry_id=$1`, [created.id]);
    expect(pending?.rows[0]).toEqual({status: 'PENDING', attempts: 0, durability_state: 'DELETE_PENDING'});
    await pool?.query(`UPDATE file_blob_delete_jobs SET status='IN_PROGRESS',claimed_at=now()-interval '10 minutes',
      claim_token=$2 WHERE file_entry_id=$1`, [created.id, randomUUID()]);
    const completed = await files.processNextDeleteJob();
    expect(completed).toEqual(expect.objectContaining({status: 'COMPLETED', attempts: 1, failureCode: null}));
    await expect(lstat(volume.pathForKey(storageKey))).rejects.toMatchObject({code: 'ENOENT'});
    expect(await files.processNextDeleteJob()).toBeNull();
    const durable = await pool?.query(`SELECT j.status,b.durability_state FROM file_blob_delete_jobs j
      JOIN file_blobs b ON b.id=j.blob_id WHERE j.file_entry_id=$1`, [created.id]);
    expect(durable?.rows[0]).toEqual({status: 'COMPLETED', durability_state: 'DELETED'});
  });

  it('retries a provider deletion failure without marking the blob deleted', async () => {
    const fixture = await storageFixture();
    const created = await committedServerFile(fixture, 'retry provider delete', 'delete-retry');
    await storage.deleteFile(fixture.member, created.id, {baseRevision: created.revision}, 'retry-delete',
      context('retry-delete'));
    const failingVolume = new ServerVolumeStore(volume.rootPath, 20 * 1024 * 1024, {
      link, lstat, mkdir, open, realpath,
      unlink: async () => {throw Object.assign(new Error('provider unavailable'), {code: 'EIO'});},
      syncFile: handle => handle.sync(), syncDirectory: handle => handle.sync()
    });
    await failingVolume.initialize();
    const failingFiles = new Stage6FileService(pool as pg.Pool, failingVolume, fileS3Configs,
      config => new S3CompatibleStore(config, new IntegrationS3Transport(), 20 * 1024 * 1024));
    const retry = await failingFiles.processNextDeleteJob();
    expect(retry).toEqual(expect.objectContaining({status: 'RETRY', attempts: 1,
      failureCode: 'SERVER_VOLUME_DELETE_FAILED'}));
    const state = await pool?.query(`SELECT j.status,j.failure_code,b.durability_state
      FROM file_blob_delete_jobs j JOIN file_blobs b ON b.id=j.blob_id WHERE j.file_entry_id=$1`, [created.id]);
    expect(state?.rows[0]).toEqual({status: 'RETRY', failure_code: 'SERVER_VOLUME_DELETE_FAILED',
      durability_state: 'DELETE_PENDING'});
  });

  it('recovers when the provider delete succeeded but its database completion rolled back', async () => {
    const fixture = await storageFixture();
    const created = await committedServerFile(fixture, 'delete completion rollback', 'delete-db-retry');
    await storage.deleteFile(fixture.member, created.id, {baseRevision: created.revision},
      'delete-db-retry', context('delete-db-retry'));
    await pool?.query(`CREATE FUNCTION fail_storage_cleanup_success() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.resource_type='BLOB_DELETE' AND NEW.outcome='SUCCEEDED' THEN
          RAISE EXCEPTION 'injected cleanup completion failure';
        END IF;
        RETURN NEW;
      END; $$`);
    await pool?.query(`CREATE TRIGGER fail_storage_cleanup_success BEFORE INSERT ON storage_cleanup_audit
      FOR EACH ROW EXECUTE FUNCTION fail_storage_cleanup_success()`);
    const retried = await files.processNextDeleteJob();
    expect(retried).toEqual(expect.objectContaining({status: 'RETRY', failureCode: 'STORAGE_CLEANUP_COMMIT_FAILED'}));
    await pool?.query('DROP TRIGGER fail_storage_cleanup_success ON storage_cleanup_audit');
    await pool?.query('DROP FUNCTION fail_storage_cleanup_success()');
    await pool?.query(`UPDATE file_blob_delete_jobs SET next_attempt_at=now()-interval '1 second'
      WHERE file_entry_id=$1`, [created.id]);
    expect(await files.processNextDeleteJob()).toEqual(expect.objectContaining({status: 'COMPLETED'}));
    const state = await pool?.query(`SELECT j.status,b.durability_state,
      (SELECT count(*)::int FROM storage_cleanup_audit WHERE resource_id=j.id AND outcome='FAILED') AS failures,
      (SELECT count(*)::int FROM storage_cleanup_audit WHERE resource_id=j.id AND outcome='SUCCEEDED') AS successes
      FROM file_blob_delete_jobs j JOIN file_blobs b ON b.id=j.blob_id WHERE j.file_entry_id=$1`, [created.id]);
    expect(state?.rows[0]).toEqual({status: 'COMPLETED', durability_state: 'DELETED', failures: 1, successes: 1});
  });

  it('reads and deletes an existing S3 blob even after its provider config is disabled', async () => {
    const fixture = await s3Fixture();
    const content = 'published S3 bytes';
    const upload = await uploads.createUpload(fixture.member, fixture.committee.id, {
      logicalName: 'S3 发布文件', originalName: '../../published.svg', mediaType: 'image/svg+xml',
      expectedSizeBytes: Buffer.byteLength(content), sha256: digest(content)
    }, 's3-review-upload', context('s3-review-upload'));
    await uploads.receiveContent(fixture.member, upload.id, (async function* () {yield content;})(),
      's3-review-content', Buffer.byteLength(content), context('s3-review-content'));
    const transport = new IntegrationS3Transport();
    const commits = new Stage6S3CommitService(pool as pg.Pool, storage, staging, fixture.configs,
      config => new S3CompatibleStore(config, transport, 20 * 1024 * 1024));
    const created = await commits.commitUpload(fixture.member, upload.id, {}, 's3-review-commit',
      context('s3-review-commit'));
    const s3Files = new Stage6FileService(pool as pg.Pool, volume, fixture.configs,
      config => new S3CompatibleStore(config, transport, 20 * 1024 * 1024));
    const pending = await s3Files.submitForReview(fixture.member, created.id, {baseRevision: created.revision},
      's3-submit', context('s3-submit'));
    const published = await s3Files.publish(fixture.chair, created.id, {baseRevision: pending.revision},
      's3-publish', context('s3-publish'));
    await pool?.query("UPDATE storage_provider_configs SET status='DISABLED' WHERE id=$1", [fixture.config.id]);
    const download = await s3Files.download(undefined, published.id);
    const chunks: Buffer[] = [];
    for await (const chunk of download.content) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe(content);
    expect(download.headers['content-type']).toBe('application/octet-stream');
    await storage.deleteFile(fixture.member, created.id, {baseRevision: published.revision}, 's3-delete',
      context('s3-delete'));
    expect((await s3Files.processNextDeleteJob())?.status).toBe('COMPLETED');
    expect(transport.objects.size).toBe(0);
  });

  it('copies SERVER_VOLUME blobs to S3 while the source stays active, then switches atomically', async () => {
    const fixture = await storageFixture();
    const content = 'provider migration content';
    const file = await committedServerFile(fixture, content, 'migration-success');
    const config = await createMigrationS3Config('Migration Success');
    const transport = new IntegrationS3Transport();
    const migrations = new Stage6MigrationService(pool as pg.Pool, staging, volume, fileS3Configs,
      provider => new S3CompatibleStore(provider, transport, 20 * 1024 * 1024));
    const created = await migrations.create(fixture.chair, fixture.committee.id, {
      baseRevision: fixture.committee.revision + 1, targetProviderType: 'S3_COMPATIBLE',
      targetProviderConfigId: config.id
    }, 'create-migration-success', context('create-migration-success'));
    expect(created).toEqual(expect.objectContaining({status: 'COPYING', totalItems: 1, completedItems: 0}));
    expect((await files.download(fixture.member, file.id)).file.id).toBe(file.id);
    const before = await pool?.query(`SELECT active_storage_binding_id FROM committees WHERE id=$1`,
      [fixture.committee.id]);
    expect(before?.rows[0]?.active_storage_binding_id).toBe(fixture.binding.id);

    expect(await migrations.processNextCopyItem()).toEqual(expect.objectContaining({status: 'COMPLETED'}));
    const ready = (await migrations.list(fixture.chair, fixture.committee.id))[0];
    expect(ready).toEqual(expect.objectContaining({status: 'READY_TO_CONFIRM', completedItems: 1}));
    transport.corruptReads = true;
    await expect(migrations.confirm(fixture.chair, created.id, {baseRevision: ready?.revision},
      'confirm-corrupt-target', context('confirm-corrupt-target'))).rejects.toMatchObject({code: 'SERVICE_NOT_READY'});
    expect((await pool?.query('SELECT active_storage_binding_id FROM committees WHERE id=$1',
      [fixture.committee.id]))?.rows[0]?.active_storage_binding_id).toBe(fixture.binding.id);
    transport.corruptReads = false;
    const completed = await migrations.confirm(fixture.chair, created.id, {baseRevision: ready?.revision},
      'confirm-migration-success', context('confirm-migration-success'));
    expect(completed.status).toBe('COMPLETED');
    const bindings = await pool?.query(`SELECT id,status FROM storage_bindings WHERE committee_id=$1 ORDER BY id`,
      [fixture.committee.id]);
    expect(bindings?.rows).toEqual(expect.arrayContaining([
      {id: fixture.binding.id, status: 'RETIRED'}, {id: created.targetBindingId, status: 'ACTIVE'}
    ]));
    const migratedFiles = new Stage6FileService(pool as pg.Pool, volume, fileS3Configs,
      provider => new S3CompatibleStore(provider, transport, 20 * 1024 * 1024));
    const download = await migratedFiles.download(fixture.member, file.id);
    const chunks: Buffer[] = [];
    for await (const chunk of download.content) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe(content);
    const immutable = await pool?.query(`SELECT v.blob_id,c.copy_blob_id FROM file_versions v
      JOIN file_blob_copies c ON c.content_blob_id=v.blob_id WHERE v.file_entry_id=$1`, [file.id]);
    expect(immutable?.rows[0]).toEqual({blob_id: file.currentVersion.blobId,
      copy_blob_id: expect.not.stringContaining(file.currentVersion.blobId)});
    const maintenance = new Stage6MaintenanceService(pool as pg.Pool, staging, migratedFiles, availableCapacity,
      createLogger(() => undefined));
    while (await maintenance.processNext()) {
      // Drain committed upload and completed migration staging.
    }
    const cleaned = await pool?.query(`SELECT count(*)::int AS count FROM storage_migration_items
      WHERE migration_id=$1 AND staging_deleted_at IS NOT NULL`, [created.id]);
    expect(cleaned?.rows[0]?.count).toBe(1);
    expect((await migratedFiles.get(fixture.member, file.id)).id).toBe(file.id);
  });

  it('keeps the source active on copy failure and resumes with the same target blob', async () => {
    const fixture = await storageFixture();
    const file = await committedServerFile(fixture, 'retry migration content', 'migration-retry');
    const config = await createMigrationS3Config('Migration Retry');
    const transport = new IntegrationS3Transport(); transport.failPut = true;
    const migrations = new Stage6MigrationService(pool as pg.Pool, staging, volume, fileS3Configs,
      provider => new S3CompatibleStore(provider, transport, 20 * 1024 * 1024));
    const created = await migrations.create(fixture.owner, fixture.committee.id, {
      baseRevision: fixture.committee.revision + 1, targetProviderType: 'S3_COMPATIBLE',
      targetProviderConfigId: config.id
    }, 'create-migration-retry', context('create-migration-retry'));
    const failedItem = await migrations.processNextCopyItem();
    expect(failedItem).toEqual(expect.objectContaining({status: 'RETRY', attempts: 1}));
    const failed = (await migrations.list(fixture.owner, fixture.committee.id))[0];
    expect(failed).toEqual(expect.objectContaining({status: 'FAILED', failureCode: 'S3_WRITE_FAILED'}));
    expect((await files.get(fixture.member, file.id)).id).toBe(file.id);
    expect((await pool?.query('SELECT active_storage_binding_id FROM committees WHERE id=$1',
      [fixture.committee.id]))?.rows[0]?.active_storage_binding_id).toBe(fixture.binding.id);
    transport.failPut = false;
    const retried = await migrations.retry(fixture.owner, created.id, {baseRevision: failed?.revision},
      'retry-migration', context('retry-migration'));
    expect(retried.status).toBe('COPYING');
    const targetBefore = failedItem?.targetBlobId;
    const copied = await migrations.processNextCopyItem();
    expect(copied).toEqual(expect.objectContaining({status: 'COMPLETED', targetBlobId: targetBefore}));
  });

  it('refreshes a changed manifest before allowing provider confirmation', async () => {
    const fixture = await storageFixture();
    await committedServerFile(fixture, 'first manifest file', 'manifest-first');
    const config = await createMigrationS3Config('Manifest Refresh');
    const transport = new IntegrationS3Transport();
    const migrations = new Stage6MigrationService(pool as pg.Pool, staging, volume, fileS3Configs,
      provider => new S3CompatibleStore(provider, transport, 20 * 1024 * 1024));
    const created = await migrations.create(fixture.chair, fixture.committee.id, {
      baseRevision: fixture.committee.revision + 1, targetProviderType: 'S3_COMPATIBLE',
      targetProviderConfigId: config.id
    }, 'create-manifest-migration', context('create-manifest-migration'));
    await committedServerFile(fixture, 'second manifest file', 'manifest-second');
    const failed = (await migrations.list(fixture.chair, fixture.committee.id))[0];
    expect(failed).toEqual(expect.objectContaining({status: 'FAILED', failureCode: 'MANIFEST_CHANGED'}));
    const refreshed = await migrations.retry(fixture.chair, created.id, {baseRevision: failed?.revision},
      'refresh-manifest-migration', context('refresh-manifest-migration'));
    expect(refreshed).toEqual(expect.objectContaining({status: 'COPYING', totalItems: 2}));
    await migrations.processNextCopyItem(); await migrations.processNextCopyItem();
    const ready = (await migrations.list(fixture.chair, fixture.committee.id))[0];
    expect(ready).toEqual(expect.objectContaining({status: 'READY_TO_CONFIRM', completedItems: 2}));
    expect((await migrations.confirm(fixture.chair, created.id, {baseRevision: ready?.revision},
      'confirm-refreshed-migration', context('confirm-refreshed-migration'))).status).toBe('COMPLETED');
  });

  it('cancels verified target copies into durable delete jobs without touching the source', async () => {
    const fixture = await storageFixture();
    const file = await committedServerFile(fixture, 'cancel migration content', 'migration-cancel');
    const config = await createMigrationS3Config('Migration Cancel');
    const transport = new IntegrationS3Transport();
    const migrations = new Stage6MigrationService(pool as pg.Pool, staging, volume, fileS3Configs,
      provider => new S3CompatibleStore(provider, transport, 20 * 1024 * 1024));
    const created = await migrations.create(fixture.chair, fixture.committee.id, {
      baseRevision: fixture.committee.revision + 1, targetProviderType: 'S3_COMPATIBLE',
      targetProviderConfigId: config.id
    }, 'create-cancel-migration', context('create-cancel-migration'));
    await migrations.processNextCopyItem();
    const ready = (await migrations.list(fixture.chair, fixture.committee.id))[0];
    const cancelled = await migrations.cancel(fixture.chair, created.id, {baseRevision: ready?.revision},
      'cancel-migration', context('cancel-migration'));
    expect(cancelled.status).toBe('CANCELLED');
    expect((await pool?.query('SELECT active_storage_binding_id FROM committees WHERE id=$1',
      [fixture.committee.id]))?.rows[0]?.active_storage_binding_id).toBe(fixture.binding.id);
    expect((await files.get(fixture.member, file.id)).id).toBe(file.id);
    const deletion = await pool?.query(`SELECT j.status,b.durability_state FROM file_blob_delete_jobs j
      JOIN file_blobs b ON b.id=j.blob_id WHERE b.storage_binding_id=$1`, [created.targetBindingId]);
    expect(deletion?.rows[0]).toEqual({status: 'PENDING', durability_state: 'DELETE_PENDING'});
    const migratedFiles = new Stage6FileService(pool as pg.Pool, volume, fileS3Configs,
      provider => new S3CompatibleStore(provider, transport, 20 * 1024 * 1024));
    expect((await migratedFiles.processNextDeleteJob())?.status).toBe('COMPLETED');
    expect(transport.objects.size).toBe(0);
  });

  it('migrates an S3 source to SERVER_VOLUME and keeps immutable content identity', async () => {
    const fixture = await s3Fixture();
    const content = 'S3 to server migration';
    const upload = await uploads.createUpload(fixture.member, fixture.committee.id, {
      logicalName: 'S3 源文件', originalName: 'source.bin', mediaType: 'application/octet-stream',
      expectedSizeBytes: Buffer.byteLength(content), sha256: digest(content)
    }, 's3-source-upload', context('s3-source-upload'));
    await uploads.receiveContent(fixture.member, upload.id, (async function* () {yield content;})(),
      's3-source-content', Buffer.byteLength(content), context('s3-source-content'));
    const transport = new IntegrationS3Transport();
    const commits = new Stage6S3CommitService(pool as pg.Pool, storage, staging, fixture.configs,
      provider => new S3CompatibleStore(provider, transport, 20 * 1024 * 1024));
    const file = await commits.commitUpload(fixture.member, upload.id, {}, 's3-source-commit',
      context('s3-source-commit'));
    const migrations = new Stage6MigrationService(pool as pg.Pool, staging, volume, fixture.configs,
      provider => new S3CompatibleStore(provider, transport, 20 * 1024 * 1024));
    const created = await migrations.create(fixture.owner, fixture.committee.id, {
      baseRevision: fixture.committee.revision + 1, targetProviderType: 'SERVER_VOLUME'
    }, 's3-to-volume', context('s3-to-volume'));
    await migrations.processNextCopyItem();
    const ready = (await migrations.list(fixture.owner, fixture.committee.id))[0];
    await migrations.confirm(fixture.owner, created.id, {baseRevision: ready?.revision},
      'confirm-s3-to-volume', context('confirm-s3-to-volume'));
    const download = await files.download(fixture.member, file.id);
    const chunks: Buffer[] = [];
    for await (const chunk of download.content) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe(content);
    expect(download.file.currentVersion.blobId).toBe(file.currentVersion.blobId);
  });

  it('migrates between distinct S3 configs with independently derived object keys', async () => {
    const fixture = await s3Fixture();
    const content = 'S3 config to S3 config migration';
    const upload = await uploads.createUpload(fixture.member, fixture.committee.id, {
      logicalName: 'S3 配置迁移', originalName: '../config-migration.bin', mediaType: 'application/octet-stream',
      expectedSizeBytes: Buffer.byteLength(content), sha256: digest(content)
    }, 's3-config-source-upload', context('s3-config-source-upload'));
    await uploads.receiveContent(fixture.member, upload.id, (async function* () {yield content;})(),
      's3-config-source-content', Buffer.byteLength(content), context('s3-config-source-content'));
    const transport = new IntegrationS3Transport();
    const commits = new Stage6S3CommitService(pool as pg.Pool, storage, staging, fixture.configs,
      provider => new S3CompatibleStore(provider, transport, 20 * 1024 * 1024));
    const file = await commits.commitUpload(fixture.member, upload.id, {}, 's3-config-source-commit',
      context('s3-config-source-commit'));
    const targetDraft = await fixture.configs.create(administrator, {
      displayName: 'S3 Target Config', endpoint: 'https://s3-target.example.com', region: 'ap-shanghai',
      bucket: 'quorum-target', prefix: 'target-config', forcePathStyle: true, allowPrivateNetwork: false,
      credentials: {accessKeyId: 'target-access', secretAccessKey: 'target-secret'}
    }, 's3-target-config', context('s3-target-config'));
    const target = await fixture.configs.verify(administrator, targetDraft.id, 's3-target-verify',
      context('s3-target-verify'));
    const migrations = new Stage6MigrationService(pool as pg.Pool, staging, volume, fixture.configs,
      provider => new S3CompatibleStore(provider, transport, 20 * 1024 * 1024));
    const created = await migrations.create(fixture.owner, fixture.committee.id, {
      baseRevision: fixture.committee.revision + 1, targetProviderType: 'S3_COMPATIBLE',
      targetProviderConfigId: target.id
    }, 's3-config-migration', context('s3-config-migration'));
    await migrations.processNextCopyItem();
    const ready = (await migrations.list(fixture.owner, fixture.committee.id))[0];
    await migrations.confirm(fixture.owner, created.id, {baseRevision: ready?.revision},
      'confirm-s3-config-migration', context('confirm-s3-config-migration'));
    const keys = await pool?.query<{storage_key: string; provider_config_id: string}>(`SELECT b.storage_key,
      binding.provider_config_id FROM file_blobs b JOIN storage_bindings binding ON binding.id=b.storage_binding_id
      WHERE b.id=$1 OR b.id=(SELECT copy_blob_id FROM file_blob_copies WHERE content_blob_id=$1)
      ORDER BY binding.provider_config_id`, [file.currentVersion.blobId]);
    expect(keys?.rows).toHaveLength(2);
    expect(new Set(keys?.rows.map(row => row.provider_config_id))).toEqual(new Set([fixture.config.id, target.id]));
    expect(keys?.rows.some(row => row.storage_key.startsWith('target-config/blobs/'))).toBe(true);
    const migratedFiles = new Stage6FileService(pool as pg.Pool, volume, fixture.configs,
      provider => new S3CompatibleStore(provider, transport, 20 * 1024 * 1024));
    const download = await migratedFiles.download(fixture.member, file.id);
    const chunks: Buffer[] = [];
    for await (const chunk of download.content) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe(content);
  });

  it('keeps migration roles, pause state, revision, event, audit, and confirmation atomic', async () => {
    const fixture = await storageFixture();
    await committedServerFile(fixture, 'atomic migration', 'migration-atomic');
    const config = await createMigrationS3Config('Migration Atomic');
    const transport = new IntegrationS3Transport();
    const migrations = new Stage6MigrationService(pool as pg.Pool, staging, volume, fileS3Configs,
      provider => new S3CompatibleStore(provider, transport, 20 * 1024 * 1024));
    const body = {baseRevision: fixture.committee.revision + 1, targetProviderType: 'S3_COMPATIBLE',
      targetProviderConfigId: config.id};
    await expect(migrations.create(fixture.member, fixture.committee.id, body, 'member-migration',
      context('member-migration'))).rejects.toMatchObject({code: 'FORBIDDEN'});
    await expect(migrations.create(administrator, fixture.committee.id, body, 'admin-migration',
      context('admin-migration'))).rejects.toMatchObject({code: 'FORBIDDEN'});
    const created = await migrations.create(fixture.chair, fixture.committee.id, body,
      'atomic-migration', context('atomic-migration'));
    expect(await migrations.create(fixture.chair, fixture.committee.id, body,
      'atomic-migration', context('atomic-migration-replay'))).toEqual(created);
    await migrations.processNextCopyItem();
    const ready = (await migrations.list(fixture.chair, fixture.committee.id))[0];
    await pool?.query(`CREATE FUNCTION fail_stage6_migration_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action='storage.migration_completed' THEN RAISE EXCEPTION 'injected migration audit failure'; END IF;
        RETURN NEW;
      END; $$`);
    await pool?.query(`CREATE TRIGGER fail_stage6_migration_audit BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION fail_stage6_migration_audit()`);
    await expect(migrations.confirm(fixture.chair, created.id, {baseRevision: ready?.revision},
      'atomic-confirm', context('atomic-confirm'))).rejects.toThrow('injected migration audit failure');
    const state = await pool?.query(`SELECT m.status,source.status AS source_status,target.status AS target_status,
      c.active_storage_binding_id,
      (SELECT count(*)::int FROM committee_events WHERE resource_id=m.id
        AND event_type='storage.migration_completed') AS events,
      (SELECT count(*)::int FROM idempotency_keys WHERE key='atomic-confirm') AS idempotency
      FROM storage_migrations m JOIN storage_bindings source ON source.id=m.source_binding_id
      JOIN storage_bindings target ON target.id=m.target_binding_id JOIN committees c ON c.id=m.committee_id
      WHERE m.id=$1`, [created.id]);
    expect(state?.rows[0]).toEqual({status: 'READY_TO_CONFIRM', source_status: 'ACTIVE',
      target_status: 'MIGRATING', active_storage_binding_id: fixture.binding.id, events: 0, idempotency: 0});
  });
});
