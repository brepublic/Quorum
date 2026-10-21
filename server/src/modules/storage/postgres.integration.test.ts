import {ServerVolumeInventoryService} from '../operations/volume-inventory';
import {ServerVolumeOperationsService} from '../operations/volume-service';
import {testCommitteeInput} from '../../test/committee-fixture';
// @vitest-environment node

import {createHash, randomBytes,randomUUID} from 'node:crypto';
import {link, symlink, lstat, mkdir, mkdtemp, open,readFile, realpath, rm, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import pg from 'pg';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {runMigrations} from '../../db/migrations';
import {PostgresIdentityStore} from '../identity/postgres';
import {IdentityService} from '../identity/service';
import type {AuthenticatedSession} from '../identity/store';
import {Stage3Service} from '../stage3/service';
import {Stage4Service} from '../stage4/service';
import {Stage5Service} from '../stage5/service';
import {Stage6StorageService} from './service';
import {DurableStagingStore, type StagingOperations} from './staging';
import {Stage6UploadService} from './upload-service';
import {ProviderStorageError, ServerVolumeStore} from './server-volume';
import {Stage6ServerVolumeService} from './server-volume-service';
import {StorageCredentialCipher} from './credential-crypto';
import {Stage6S3ConfigService} from './s3-config-service';
import {Stage6S3CommitService} from './s3-commit-service';
import {S3CompatibleStore, type S3Request, type S3Response, type S3Transport} from './s3-store';
import {Stage6FileService} from './file-service';
import {Stage6MigrationService} from './migration-service';
import {Stage6MaintenanceService} from './maintenance-service';
import {DelegateFileService} from '../delegate-files/service';
import {Stage6ProviderCommitService} from './provider-commit-service';
import {createLogger} from '../../logger';
import {Stage7StorageAgentService} from '../storage-agent/service';
import {Stage7StorageTaskService} from '../storage-agent/task-service';
import type {StorageAgentTask} from '@quorum/contracts';
import {AgentStateStore} from '../../../../packages/storage-agent/src/state';
import {AgentFileStore} from '../../../../packages/storage-agent/src/files';
import {StorageCacheService} from './cache-service';
import {StorageCacheRefillService} from './cache-refill-service';
import {Stage7ChairAgentProviderService} from '../storage-agent/chair-provider-service';
import {Stage7ConflictService} from '../storage-agent/conflict-service';
import {Stage7LocalChangeService} from '../storage-agent/local-change-service';

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
  let committee = await stage4.createCommittee(owner, await testCommitteeInput(pool!, owner, {name: 'Stage 6 Council', visibility,
    countryTemplateKey: 'builtin:default'}), 'committee', context('committee'));
  committee = await stage3.setChair(owner, committee.id, chair.user.email, true, committee.revision, context('chair'));
  const seat = await stage4.createSeat(chair, committee.id,
    {stableKey: 'member', canVote: true, canProceduralVote: true}, 'seat', context('seat'));
  await stage3.assignSeat(chair, committee.id, {seatId: seat.id, email: member.user.email}, context('assign'));
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
  let committee = await stage4.createCommittee(owner, await testCommitteeInput(pool!, owner, {name: 'S3 Council', visibility: 'PUBLIC',
    countryTemplateKey: 'builtin:default'}), 's3-committee', context('s3-committee'));
  committee = await stage3.setChair(owner, committee.id, chair.user.email, true, committee.revision, context('s3-chair'));
  const seat = await stage4.createSeat(chair, committee.id,
    {stableKey: 's3-member', canVote: true, canProceduralVote: true}, 's3-seat', context('s3-seat'));
  await stage3.assignSeat(chair, committee.id, {seatId: seat.id, email: member.user.email}, context('s3-assign'));
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
  async function chairMigration(withFile=true) {
    const fixture=await storageFixture();
    const file=withFile?await committedServerFile(fixture,'migration bytes','chair-target'):null;
    const agent=new Stage7StorageAgentService(pool!);
    const revision=async()=>Number((await pool!.query('SELECT revision FROM committees WHERE id=$1',[fixture.committee.id])).rows[0].revision);
    const pairing=await agent.createPairing(fixture.chair,fixture.committee.id,{baseRevision:await revision(),purpose:'INITIAL'},context('chair-pair-code'));
    const paired=await agent.pair({pairingCode:pairing.code,deviceLabel:'Migration Chair',devicePublicKey:randomBytes(32).toString('base64url')},context('chair-pair'));
    const taskService=new Stage7StorageTaskService(agent,staging,files,undefined,undefined,storageMigrations);
    const heartbeat=()=>agent.heartbeat(paired.credential,{leaseGeneration:paired.host.leaseGeneration,agentProtocolVersion:2,
      capabilities:['SSE_WAKE','CACHE_REFILL','STORAGE_MIGRATION']});
    await heartbeat();
    const start=async()=>storageMigrations.create(fixture.chair,fixture.committee.id,{baseRevision:await revision(),targetProviderType:'CHAIR_AGENT'},randomUUID(),context('migration-create'));
    const latest=async()=>(await storageMigrations.list(fixture.chair,fixture.committee.id))[0]!;
    const claim=async(type:StorageAgentTask['type'])=>{
      const page=await taskService.tasks(paired.credential,paired.host.leaseGeneration);
      const task=page.tasks.find(item=>item.type===type&&item.status==='PENDING')!;
      expect(task).toBeTruthy();
      return taskService.claim(paired.credential,task.id,{leaseGeneration:task.leaseGeneration,fileRevision:task.fileRevision,requestId:randomUUID()});
    };
    const finish=(task:StorageAgentTask, failureCode?:string)=>taskService[failureCode?'fail':'complete'](paired.credential,task.id,
      {leaseGeneration:task.leaseGeneration,fileRevision:task.fileRevision,claimToken:task.claimToken,requestId:randomUUID(),
        ...(failureCode?{failureCode}:{})},context('migration-finish'));
    return {fixture,file,agent,paired,taskService,revision,heartbeat,start,latest,claim,finish};
  }

  async function migratedChairFile() {
    const value = await chairMigration();
    const state = await AgentStateStore.initialize(join(stagingRoot, 'chair-review'), {
      committeeId: value.fixture.committee.id, deviceId: value.paired.host.deviceId});
    const local = new AgentFileStore(state);
    await value.start(); await storageMigrations.processNextCopyItem();
    const copy = await value.claim('MIGRATE_BLOB'); const chunks: Buffer[] = [];
    await value.taskService.streamBlob(value.paired.credential, {taskId: copy.id, blobId: copy.blobId!,
      leaseGeneration: copy.leaseGeneration, fileRevision: copy.fileRevision, claimToken: copy.claimToken!},
    {start: () => undefined, write: async chunk => {chunks.push(Buffer.from(chunk));}});
    await local.storeBlob(copy.blobId!, async () => (async function* () {yield Buffer.concat(chunks);})(),
      copy.expectedSizeBytes!, copy.expectedSha256!);
    await value.finish(copy); await storageMigrations.processNextCopyItem();
    const ready = await value.latest();
    await storageMigrations.confirm(value.fixture.chair, ready.id, {baseRevision: ready.revision}, randomUUID(), context('review-migrate'));
    const verify = await value.claim('VERIFY_MIGRATION_BLOB');
    await local.verifyBlob(verify.blobId!, verify.expectedSizeBytes!, verify.expectedSha256!);
    await value.finish(verify); await storageMigrations.processNextCopyItem();
    expect((await value.latest()).status).toBe('COMPLETED');
    expect(await files.processNextDeleteJob()).toMatchObject({status: 'COMPLETED'});
    const original = (await pool!.query('SELECT storage_key,durability_state FROM file_blobs WHERE id=$1',
      [value.file!.currentVersion.blobId])).rows[0];
    expect(original.durability_state).toBe('DELETED');
    await expect(lstat(volume.pathForKey(original.storage_key))).rejects.toMatchObject({code: 'ENOENT'});
    const config = {publishedCacheMaxBytes: 1048576, pendingReviewMaxBytes: 1048576,
      pendingReviewCommitteeMaxBytes: 1048576, storageMinFreeBytes: 0, storageMinFreePercent: 0};
    const cache = new StorageCacheService(pool!, staging, staging,
      {effective: async () => ({...config, revision: 1})} as never);
    const provider = new Stage7ChairAgentProviderService(pool!, storage, cache);
    const tasks = new Stage7StorageTaskService(value.agent, staging, files, undefined, provider, storageMigrations);
    const reader = new Stage6FileService(pool!, volume, fileS3Configs,
      config => new S3CompatibleStore(config, new IntegrationS3Transport(), 20 * 1024 * 1024), staging, staging);
    const review = new DelegateFileService(pool!, uploads,
      new Stage6ProviderCommitService(pool!, serverVolume, {} as never), files, storage, cache);
    return {...value, state, local, copy, tasks, review, reader};
  }

  it.each(['KEEP_SERVER', 'ACCEPT_LOCAL'] as const)
    ('approves migrated content and applies %s after source cleanup without changing content identity', async action => {
    const value = await migratedChairFile(); const {fixture, paired} = value;
    const published = await value.review.approve(fixture.chair, value.file!.id, {
      baseRevision: value.file!.revision, logicalName: 'Migrated formal file', fileType: 'WORKING_PAPER'}, context('migrated-approve'));
    const generation = paired.host.leaseGeneration;
    const manifest = await value.tasks.manifest(paired.credential, generation);
    const event = manifest.events.filter(item => item.fileEntryId === published.id).at(-1)!;
    if (event.kind !== 'UPSERT') throw new Error('Expected current file content');
    expect(event.blobId).toBe(value.file!.currentVersion.blobId);
    const originalPath = await value.local.verifyBlob(value.copy.blobId!, event.sizeBytes, event.sha256);
    await value.local.applyUpsert(event, (async function* () {yield await readFile(originalPath);})());
    const content = Buffer.from('edited migrated content');
    await writeFile(join(value.state.rootPath, event.logicalName), content);
    const change = {kind: 'UPSERT' as const, fileEntryId: published.id, baseRevision: published.revision,
      logicalName: event.logicalName, originalName: 'edited.pdf', mediaType: 'application/pdf',
      sizeBytes: content.length, sha256: digest(content.toString())};
    const changes = new Stage7LocalChangeService(value.agent);
    const conflicts = new Stage7ConflictService(pool!, value.agent);
    await expect(changes.submit(paired.credential, {leaseGeneration: generation, requestId: randomUUID(),
      manifestSequence: manifest.nextSequence, change}, context('migrated-local')))
      .rejects.toMatchObject({code: 'CHAIR_DECISION_REQUIRED'});
    const conflict = (await conflicts.list(fixture.chair, fixture.committee.id))[0]!;
    await conflicts.resolve(fixture.chair, fixture.committee.id, conflict.id, {baseRevision: conflict.revision,
      leaseGeneration: generation, fileRevision: published.revision, action}, randomUUID(), context('migrated-decision'));
    if (action === 'KEEP_SERVER') {
      const task = (await value.tasks.tasks(paired.credential, generation)).tasks.find(item => item.resolutionConflictId === conflict.id)!;
      expect(task).toMatchObject({blobId: event.blobId, localBlobId: value.copy.blobId, fileRevision: published.revision});
      const path = await value.local.verifyBlob(task.localBlobId!, task.expectedSizeBytes!, task.expectedSha256!);
      await value.local.applyUpsert(event, (async function* () {yield await readFile(path);})(), {force: true});
      expect(await readFile(join(value.state.rootPath, event.logicalName), 'utf8')).toBe('migration bytes');
      const claimed = await value.tasks.claim(paired.credential, task.id, {leaseGeneration: generation,
        fileRevision: task.fileRevision, requestId: randomUUID()});
      await value.finish(claimed);
    } else {
      const pending = await changes.submit(paired.credential, {leaseGeneration: generation, requestId: randomUUID(),
        manifestSequence: manifest.nextSequence, resolutionConflictId: conflict.id, change}, context('migrated-replacement'));
      if (pending.status !== 'PENDING_CONTENT') throw new Error('Expected replacement upload');
      const claimed = await value.tasks.claim(paired.credential, pending.task.id, {leaseGeneration: generation,
        fileRevision: pending.task.fileRevision, requestId: randomUUID()});
      await value.tasks.receiveContent(paired.credential, {taskId: claimed.id, leaseGeneration: generation,
        fileRevision: claimed.fileRevision, claimToken: claimed.claimToken!, expectedSha256: change.sha256,
        contentLength: content.length, source: (async function* () {yield content;})(), context: context('migrated-upload')});
      await value.tasks.complete(paired.credential, claimed.id, {leaseGeneration: generation, fileRevision: claimed.fileRevision,
        claimToken: claimed.claimToken, requestId: randomUUID()}, context('migrated-upload-complete'));
      const updated = await files.get(fixture.chair, published.id);
      expect(updated).toMatchObject({id: published.id, logicalName: published.logicalName, status: 'PUBLISHED',
        currentVersion: {sha256: change.sha256, sizeBytes: content.length}});
      expect((await pool!.query('SELECT published_at FROM file_entries WHERE id=$1', [published.id])).rows[0].published_at.toISOString()).toBe(published.publishedAt);
      expect((await pool!.query('SELECT count(*)::int AS count FROM file_versions WHERE file_entry_id=$1', [published.id])).rows[0].count).toBe(2);
      expect((await pool!.query('SELECT file_type FROM delegate_file_metadata WHERE file_entry_id=$1', [published.id])).rows[0].file_type).toBe('WORKING_PAPER');
      const downloaded = await value.reader.download(fixture.chair, published.id); const chunks: Buffer[] = [];
      for await (const chunk of downloaded.content) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(content);
    }
  });

  it.each(['missing', 'deleting', 'wrong-size', 'wrong-hash'] as const)('rejects approval when the current migrated replica is %s', async scenario => {
    const value = await migratedChairFile();
    if (scenario === 'missing') await pool!.query('DELETE FROM file_blob_copies WHERE copy_blob_id=$1', [value.copy.blobId]);
    else if (scenario === 'deleting') await pool!.query("UPDATE file_blobs SET durability_state='DELETE_PENDING' WHERE id=$1", [value.copy.blobId]);
    else if (scenario === 'wrong-size') await pool!.query('UPDATE file_blobs SET size_bytes=size_bytes+1 WHERE id=$1', [value.copy.blobId]);
    else await pool!.query('UPDATE file_blobs SET sha256=$2 WHERE id=$1', [value.copy.blobId, Buffer.alloc(32, 7)]);
    await expect(value.review.approve(value.fixture.chair, value.file!.id, {baseRevision: value.file!.revision,
      logicalName: 'Unavailable migrated file', fileType: 'WORKING_PAPER'}, context('missing-migrated-approve')))
      .rejects.toMatchObject({reason: 'FILE_CONTENT_UNAVAILABLE'});
    expect((await pool!.query('SELECT status,revision FROM file_entries WHERE id=$1', [value.file!.id])).rows[0])
      .toEqual({status: 'PENDING_REVIEW', revision: value.file!.revision});
  });

  it('manually migrates server content to the paired Chair, reports progress, then rechecks before switching',async()=>{
    const value=await chairMigration();
    expect((await pool!.query('SELECT active_storage_binding_id FROM committees WHERE id=$1',[value.fixture.committee.id])).rows[0].active_storage_binding_id).toBe(value.fixture.binding.id);
    const created=await value.start();
    expect(created.status).toBe('COPYING');
    await storageMigrations.processNextCopyItem();
    expect(await files.processNextDeleteJob()).toBeNull();
    const task=await value.claim('MIGRATE_BLOB');
    let content='';
    await value.taskService.streamBlob(value.paired.credential,{taskId:task.id,blobId:task.blobId!,leaseGeneration:task.leaseGeneration,
      fileRevision:task.fileRevision,claimToken:task.claimToken!},{start:()=>undefined,write:async chunk=>{content+=chunk.toString();}});
    expect(content).toBe('migration bytes');
    await pool!.query("UPDATE storage_migration_items SET progress_updated_at=now()-interval '2 seconds' WHERE migration_id=$1",[created.id]);
    await value.taskService.progress(value.paired.credential,task.id,{leaseGeneration:task.leaseGeneration,fileRevision:task.fileRevision,
      claimToken:task.claimToken,bytes:5,phase:'TRANSFERRING'});
    expect((await value.latest()).progress).toMatchObject({currentBytes:5,totalBytes:15,remainingSeconds:expect.any(Number)});
    expect((await value.taskService.fileStatus(value.paired.credential,task.leaseGeneration)).migration?.id).toBe(created.id);
    await value.finish(task);
    await storageMigrations.processNextCopyItem();
    const ready=await value.latest();expect(ready.status).toBe('READY_TO_CONFIRM');
    expect((await files.download(value.fixture.member,value.file!.id)).file.id).toBe(value.file!.id);
    const confirming=await storageMigrations.confirm(value.fixture.chair,created.id,{baseRevision:ready.revision},randomUUID(),context('chair-confirm'));
    expect(confirming.progress?.phase).toBe('CONFIRMING');
    expect(await files.processNextDeleteJob()).toBeNull();
    const verify=await value.claim('VERIFY_MIGRATION_BLOB');await value.finish(verify);
    await storageMigrations.processNextCopyItem();
    expect((await value.latest()).status).toBe('COMPLETED');
    expect((await pool!.query('SELECT active_storage_binding_id FROM committees WHERE id=$1',[value.fixture.committee.id])).rows[0].active_storage_binding_id).toBe(created.targetBindingId);
    const ordinary=(await value.taskService.tasks(value.paired.credential,task.leaseGeneration)).tasks.filter(item=>item.type==='STORE_BLOB').at(-1)!;
    expect(ordinary.localBlobId).toBe(task.blobId);
  });

  it('cancels an in-flight Chair migration, rejects late progress and schedules only its private copy for cleanup',async()=>{
    const value=await chairMigration();await value.start();await storageMigrations.processNextCopyItem();
    const task=await value.claim('MIGRATE_BLOB');const migration=await value.latest();
    await storageMigrations.cancel(value.fixture.chair,migration.id,{baseRevision:migration.revision},randomUUID(),context('chair-cancel'));
    await expect(value.taskService.progress(value.paired.credential,task.id,{leaseGeneration:task.leaseGeneration,fileRevision:task.fileRevision,
      claimToken:task.claimToken,bytes:5,phase:'TRANSFERRING'})).rejects.toMatchObject({code:'RESOURCE_CONFLICT'});
    await expect(value.finish(task)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    await storageMigrations.processNextCopyItem();
    const cleanup=await value.claim('DELETE_MIGRATION_BLOB');expect(cleanup.blobId).toBe(task.blobId);
    await value.finish(cleanup);
    expect((await value.latest()).status).toBe('CANCELLED');
    expect(await files.processNextDeleteJob()).toBeNull();
    expect((await files.download(value.fixture.member,value.file!.id)).file.id).toBe(value.file!.id);
  });

  it('waits for an in-flight volume write before disabling and rejects subsequent writes',async()=>{
    const f=await storageFixture();const upload=await uploads.createUpload(f.chair,f.committee.id,{logicalName:'inflight',originalName:'inflight.txt',
      mediaType:'text/plain',expectedSizeBytes:3,sha256:digest('abc')},randomUUID(),context('inflight-create'));
    await uploads.receiveContent(f.chair,upload.id,(async function*(){yield 'abc';})(),randomUUID(),3,context('inflight-content'));
    let release!:()=>void;let entered!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{entered=resolve;});
    const original=volume.commitFromStaging.bind(volume);
    const spy=vi.spyOn(volume,'commitFromStaging').mockImplementation(async input=>{entered();await gate;return original(input);});
    const committing=serverVolume.commitUpload(f.chair,upload.id,{},randomUUID(),context('inflight-commit'));
    await started;
    let disabled=false;
    const updating=new ServerVolumeOperationsService(pool!).update(administrator,{disabled:true,revision:1},context('disable-inflight')).then(value=>{disabled=true;return value;});
    try {await new Promise(resolve=>setTimeout(resolve,30));expect(disabled).toBe(false);}
    finally {release();}
    const file=await committing;await updating;spy.mockRestore();
    expect((await files.download(f.chair,file.id)).file.id).toBe(file.id);
    await expect(uploads.createUpload(f.chair,f.committee.id,{logicalName:'later',originalName:'later.txt',mediaType:'text/plain',
      expectedSizeBytes:3,sha256:digest('abc')},randomUUID(),context('after-disable'))).rejects.toMatchObject({reason:'SERVER_VOLUME_DISABLED'});
  });

  it('disabling prevents S3 to volume migration and still permits S3 uploads',async()=>{
    const f=await s3Fixture();await new ServerVolumeOperationsService(pool!).update(administrator,{disabled:true,revision:1},context('disable'));
    await expect(storageMigrations.create(f.owner,f.committee.id,{baseRevision:f.committee.revision+1,targetProviderType:'SERVER_VOLUME'},randomUUID(),context('blocked-migration')))
      .rejects.toMatchObject({reason:'SERVER_VOLUME_DISABLED'});
    expect((await storage.volumePolicy(f.owner,f.committee.id)).submissionBlocked).toBe(false);
    expect(await uploads.createUpload(f.member,f.committee.id,{logicalName:'s3 allowed',originalName:'allowed.txt',mediaType:'text/plain',
      expectedSizeBytes:3,sha256:digest('abc')},randomUUID(),context('s3-allowed'))).toHaveProperty('id');
  });

  it('cleanup cancels migrations using deleted sources and never follows volume symlinks',async()=>{
    const f=await storageFixture();const file=await committedServerFile(f,'source','cancel-migration-cleanup');
    const config=await createMigrationS3Config('cleanup target');
    const migration=await storageMigrations.create(f.chair,f.committee.id,{baseRevision:f.committee.revision+1,
      targetProviderType:'S3_COMPATIBLE',targetProviderConfigId:config.id},randomUUID(),context('migration'));
    const service=new ServerVolumeInventoryService(pool!,volume);
    const listed=await service.list(administrator,new URLSearchParams());
    const preview=await service.preview(administrator,{scope:'SELECTED',fileId:listed.files[0]!.id},context('preview'));
    await service.confirm(administrator,preview.id,{confirmed:true},context('confirm'));
    expect((await storageMigrations.list(f.chair,f.committee.id)).find(item=>item.id===migration.id)?.status).toBe('CANCELLED');
    expect(await storageMigrations.processNextCopyItem()).toBeNull();
    while(await service.processNext()){}
    expect((await files.get(f.member,file.id)).contentCleared).toBe(true);
    const outside=join(stagingRoot,'outside');await mkdir(outside);await writeFile(join(outside,'keep'),'keep');
    await symlink(outside,join(volume.rootPath,'escape'));
    expect((await service.list(administrator,new URLSearchParams())).total).toBe(0);
    await expect(service.preview(administrator,{scope:'SELECTED',fileId:'../escape/keep'},context('invalid-path'))).rejects.toMatchObject({code:'VALIDATION_FAILED'});
    expect(await readFile(join(outside,'keep'),'utf8')).toBe('keep');
  });

  it('downloads volume files for admins, exposes owner email and handles untracked or unavailable content',async()=>{
    const f=await storageFixture();const file=await committedServerFile(f,'download bytes','admin-download');
    const service=new ServerVolumeInventoryService(pool!,volume);
    const listing=await service.list(administrator,new URLSearchParams());const tracked=listing.files[0]!;
    expect(tracked.ownerEmail).toBe(f.owner.user.email);
    expect((await service.list(administrator,new URLSearchParams({search:f.owner.user.email}))).total).toBe(1);
    await expect(service.download(f.chair,tracked.id)).rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(service.download({...administrator,user:{...administrator.user,mustChangePassword:true}},tracked.id)).rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(service.download(administrator,'../escape')).rejects.toMatchObject({code:'VALIDATION_FAILED'});
    await expect(service.download(administrator,'f'.repeat(64))).rejects.toMatchObject({code:'NOT_FOUND'});
    await mkdir(join(volume.rootPath,'versions'),{recursive:true});
    await writeFile(join(volume.rootPath,'versions','newer'),'new version');
    await storage.recordProviderCommit(f.member,f.committee.id,{bindingId:f.binding.id,fileEntryId:file.id,
      baseRevision:file.revision,logicalName:file.logicalName,originalName:'new-version.txt',mediaType:'text/plain',
      sizeBytes:11,sha256:digest('new version'),storageKey:'versions/newer'},'new-version',context('new-version'));
    // The row identifies the original physical version, even after the business file advances.
    const download=await service.download(administrator,tracked.id);
    const chunks:Buffer[]=[];for await(const chunk of download.content)chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('download bytes');
    expect(download.headers['content-disposition']).toContain(encodeURIComponent(file.currentVersion.originalName));
    expect(download.headers['content-type']).toBe('application/octet-stream');
    await writeFile(join(volume.rootPath,'untracked'),'orphan bytes');
    const orphan=(await service.list(administrator,new URLSearchParams())).files.find(item=>item.state==='UNTRACKED')!;
    expect(orphan).toMatchObject({ownerEmail:null,committeeId:null,references:[]});
    const untracked=await service.download(administrator,orphan.id);
    const orphanChunks:Buffer[]=[];for await(const chunk of untracked.content)orphanChunks.push(chunk);
    expect(Buffer.concat(orphanChunks).toString()).toBe('orphan bytes');
    expect(untracked.headers['content-disposition']).toContain("filename*=UTF-8''untracked");
    const preview=await service.preview(administrator,{scope:'SELECTED',fileId:orphan.id},context('download-preview'));
    await service.confirm(administrator,preview.id,{confirmed:true},context('download-confirm'));
    expect((await service.list(administrator,new URLSearchParams())).files.find(item=>item.id===orphan.id)?.state).toBe('DELETE_PENDING');
    await expect(service.download(administrator,orphan.id)).rejects.toMatchObject({code:'NOT_FOUND'});
    await unlink(tracked.path);
    await expect(service.download(administrator,tracked.id)).rejects.toMatchObject({code:'NOT_FOUND'});
  });

  it('previews and confirms a single volume deletion, retries physical failures and retains file metadata',async()=>{
    const f=await storageFixture();const file=await committedServerFile(f,'clear me','single-cleanup');
    const service=new ServerVolumeInventoryService(pool!,volume);
    await expect(service.list(f.chair,new URLSearchParams())).rejects.toMatchObject({code:'FORBIDDEN'});
    const listing=await service.list(administrator,new URLSearchParams());
    expect(listing.total).toBe(1);expect(listing.files[0]).toMatchObject({committeeId:f.committee.id,present:true,
      references:[{fileId:file.id,name:file.logicalName,version:1}],hasOtherCopy:false});
    expect(listing.files[0]!.path.startsWith(volume.rootPath)).toBe(true);
    const preview=await service.preview(administrator,{scope:'SELECTED',fileId:listing.files[0]!.id},context('preview'));
    expect(preview).toMatchObject({total:1,withoutOtherCopy:1,status:'PREVIEW'});
    expect(await service.processNext()).toBe(false);
    expect((await files.download(f.member,file.id)).file.id).toBe(file.id);
    await expect(service.confirm(administrator,preview.id,{confirmed:false},context('not-confirmed'))).rejects.toMatchObject({code:'VALIDATION_FAILED'});
    const confirmed=await service.confirm(administrator,preview.id,{confirmed:true},context('confirmed'));
    expect(confirmed.status).toBe('RUNNING');
    expect(await service.confirm(administrator,preview.id,{confirmed:true},context('replay'))).toMatchObject({total:1});
    expect((await files.get(f.member,file.id)).contentCleared).toBe(true);
    await expect(files.download(f.member,file.id)).rejects.toMatchObject({reason:'SERVER_VOLUME_CLEARED'});
    const failure=vi.spyOn(volume,'delete').mockRejectedValueOnce(new Error('temporarily unavailable'));
    expect(await service.processNext()).toBe(true);failure.mockRestore();
    expect((await service.batches(administrator))[0]).toMatchObject({failed:1,completed:0});
    await pool!.query("UPDATE server_volume_cleanup_items SET next_attempt_at=now()");
    const restarted=new ServerVolumeInventoryService(pool!,volume);
    expect(await restarted.processNext()).toBe(true);expect(await restarted.processNext()).toBe(false);
    expect((await restarted.batches(administrator))[0]).toMatchObject({status:'COMPLETED',completed:1,failed:0});
    await expect(lstat(listing.files[0]!.path)).rejects.toMatchObject({code:'ENOENT'});
    expect((await files.list(f.member,f.committee.id))[0]).toMatchObject({id:file.id,contentCleared:true});
    expect((await restarted.list(administrator,new URLSearchParams())).total).toBe(0);
  });

  it('limits archive cleanup to archived volume files and all cleanup to the volume, including untracked files',async()=>{
    const f=await storageFixture();const active=await committedServerFile(f,'active','active-cleanup');
    const archived=await stage4.createCommittee(f.owner,await testCommitteeInput(pool!,f.owner,
      {name:'Archived storage',visibility:'PUBLIC',countryTemplateKey:'builtin:default'}),randomUUID(),context('archive-committee'));
    const binding=await storage.createServerVolumeBinding(f.owner,archived.id,{baseRevision:archived.revision},randomUUID(),context('archive-binding'));
    await committedServerFile({...f,committee:archived,binding,member:f.owner},'archived','archived-cleanup');
    await pool!.query("UPDATE committees SET status='ARCHIVED',archived_at=now() WHERE id=$1",[archived.id]);
    await mkdir(join(volume.rootPath,'parts'),{recursive:true});await writeFile(join(volume.rootPath,'parts','orphan'),'orphan');
    await staging.write({key:'cache/keep',source:(async function*(){yield 'cache';})(),expectedSizeBytes:5,expectedSha256:digest('cache')});
    const service=new ServerVolumeInventoryService(pool!,volume);const policy=new ServerVolumeOperationsService(pool!);
    await expect(service.preview(administrator,{scope:'ALL'},context('need-disable'))).rejects.toMatchObject({reason:'SERVER_VOLUME_DISABLE_FIRST'});
    await policy.update(administrator,{disabled:true,revision:1},context('disabled'));
    const archivedPreview=await service.preview(administrator,{scope:'ARCHIVED'},context('archived-preview'));
    expect(archivedPreview).toMatchObject({total:1,committeeCount:1});
    await service.confirm(administrator,archivedPreview.id,{confirmed:true},context('archive-confirm'));
    while(await service.processNext()) {}
    expect((await files.download(f.member,active.id)).file.id).toBe(active.id);
    expect((await pool!.query('SELECT status FROM committees WHERE id=$1',[archived.id])).rows[0].status).toBe('ARCHIVED');
    const all=await service.preview(administrator,{scope:'ALL'},context('all-preview'));
    expect(all.total).toBe(2);expect(all.files?.some(file=>file.state==='UNTRACKED')).toBe(true);
    await service.confirm(administrator,all.id,{confirmed:true},context('all-confirm'));
    // Confirmed work survives re-enabling the policy.
    await policy.update(administrator,{disabled:false,revision:2},context('enabled'));
    while(await service.processNext()) {}
    expect((await service.list(administrator,new URLSearchParams())).total).toBe(0);
    expect(await staging.exists('cache/keep')).toBe(true);
  });

  it('rejects a stale cleanup preview after a file or archive state changes',async()=>{
    const f=await storageFixture();await committedServerFile(f,'old','stale-cleanup');
    const policy=new ServerVolumeOperationsService(pool!);await policy.update(administrator,{disabled:true,revision:1},context('disabled'));
    await pool!.query("UPDATE committees SET status='ARCHIVED',archived_at=now() WHERE id=$1",[f.committee.id]);
    const service=new ServerVolumeInventoryService(pool!,volume);
    const preview=await service.preview(administrator,{scope:'ARCHIVED'},context('preview'));
    await pool!.query("UPDATE committees SET status='ACTIVE',archived_at=NULL WHERE id=$1",[f.committee.id]);
    await expect(service.confirm(administrator,preview.id,{confirmed:true},context('stale-confirm'))).rejects.toMatchObject({code:'REVISION_CONFLICT'});
    expect(await service.processNext()).toBe(false);
    const all=await service.preview(administrator,{scope:'ALL'},context('all-preview'));
    await writeFile(all.files![0]!.path,'changed');
    await expect(service.confirm(administrator,all.id,{confirmed:true},context('stale-bytes'))).rejects.toMatchObject({code:'REVISION_CONFLICT'});
  });

  it('blocks volume bindings, uploads, staged commits and new versions while preserving reads and cache paths', async () => {
    const f = await storageFixture();
    const file = await committedServerFile(f, 'existing volume file', 'policy-existing');
    const staged = await uploads.createUpload(f.chair, f.committee.id, {logicalName:'blocked.txt',originalName:'blocked.txt',
      mediaType:'text/plain',expectedSizeBytes:3,sha256:digest('abc')},randomUUID(),context('policy-upload'));
    await uploads.receiveContent(f.chair,staged.id,(async function*(){yield 'abc';})(),randomUUID(),3,context('policy-content'));
    const ops = new ServerVolumeOperationsService(pool!);
    await expect(ops.update(f.chair,{disabled:true,revision:1},context('non-admin'))).rejects.toMatchObject({code:'FORBIDDEN'});
    expect(await ops.update(administrator,{disabled:true,revision:1},context('disable'))).toMatchObject({disabled:true,revision:2});
    await expect(ops.update(administrator,{disabled:false,revision:1},context('stale'))).rejects.toMatchObject({code:'REVISION_CONFLICT'});
    expect(await storage.volumePolicy(f.chair,f.committee.id)).toMatchObject({submissionBlocked:true});
    await expect(serverVolume.commitUpload(f.chair,staged.id,{},randomUUID(),context('blocked-commit')))
      .rejects.toMatchObject({reason:'SERVER_VOLUME_DISABLED'});
    await expect(uploads.createUpload(f.chair,f.committee.id,{logicalName:'new',originalName:'new',mediaType:'text/plain',
      expectedSizeBytes:3,sha256:digest('abc')},randomUUID(),context('blocked-create'))).rejects.toMatchObject({reason:'SERVER_VOLUME_DISABLED'});
    await expect(storage.recordProviderCommit(f.chair,f.committee.id,{bindingId:f.binding.id,blobId:randomUUID(),fileEntryId:file.id,
      baseRevision:file.revision,logicalName:file.logicalName,originalName:'new.txt',mediaType:'text/plain',sizeBytes:3,
      sha256:digest('abc'),storageKey:'blobs/new'},randomUUID(),context('blocked-version'))).rejects.toMatchObject({reason:'SERVER_VOLUME_DISABLED'});
    expect((await files.download(f.chair,file.id)).file.id).toBe(file.id);
    const committee = await stage4.createCommittee(f.owner,await testCommitteeInput(pool!,f.owner,
      {name:'No volume',visibility:'PUBLIC',countryTemplateKey:'builtin:default'}),randomUUID(),context('new-committee'));
    await expect(storage.createServerVolumeBinding(f.owner,committee.id,{baseRevision:committee.revision},randomUUID(),context('blocked-binding')))
      .rejects.toMatchObject({reason:'SERVER_VOLUME_DISABLED'});
    await ops.update(administrator,{disabled:false,revision:2},context('enable'));
    expect(await serverVolume.commitUpload(f.chair,staged.id,{},randomUUID(),context('resumed-commit'))).toHaveProperty('id');
  });

  it('automatically frees migrated source bytes, retries cleanup and preserves Chair downloads and approval',async()=>{
    const value=await chairMigration();const next='latest migration content';const nextId=randomUUID();
    const otherCommittee=await stage4.createCommittee(value.fixture.owner,await testCommitteeInput(pool!,value.fixture.owner,
      {name:'Unrelated Council',visibility:'PUBLIC',countryTemplateKey:'builtin:default'}),randomUUID(),context('unrelated-committee'));
    const otherBinding=await storage.createServerVolumeBinding(value.fixture.owner,otherCommittee.id,
      {baseRevision:otherCommittee.revision},randomUUID(),context('unrelated-binding'));
    const other={...value.fixture,member:value.fixture.owner,committee:otherCommittee,binding:otherBinding};
    const unrelated=await committedServerFile(other,'unrelated volume bytes','unrelated-cleanup');
    const key=`migration-history/${randomUUID()}`;
    await staging.write({key,source:(async function*(){yield next;})(),expectedSizeBytes:next.length,expectedSha256:digest(next)});
    const committed=await volume.commitFromStaging({blobId:nextId,staging,stagingKey:key,expectedSizeBytes:next.length,expectedSha256:digest(next)});
    const latestFile=await storage.recordProviderCommit(value.fixture.member,value.fixture.committee.id,{bindingId:value.fixture.binding.id,
      blobId:nextId,fileEntryId:value.file!.id,baseRevision:value.file!.revision,logicalName:value.file!.logicalName,
      originalName:'latest.pdf',mediaType:'application/pdf',sizeBytes:next.length,sha256:digest(next),storageKey:committed.storageKey},randomUUID(),context('history-version'));
    await stage4.startMeetingSession(value.fixture.chair,value.fixture.committee.id,{},context('migration-session'),randomUUID());
    const noticeBytes='Migrated crisis notice';
    const noticeUpload=await uploads.createUpload(value.fixture.chair,value.fixture.committee.id,{logicalName:'Crisis Notice 1.1.1',
      originalName:'notice.pdf',mediaType:'application/pdf',expectedSizeBytes:noticeBytes.length,sha256:digest(noticeBytes),fileType:'CRISIS_NOTICE'},randomUUID(),context('migration-notice'));
    await uploads.receiveContent(value.fixture.chair,noticeUpload.id,(async function*(){yield noticeBytes;})(),randomUUID(),noticeBytes.length,context('migration-notice-bytes'));
    const notice=await serverVolume.commitUpload(value.fixture.chair,noticeUpload.id,{},randomUUID(),context('migration-notice-commit'));
    const review=new DelegateFileService(pool!,uploads,new Stage6ProviderCommitService(pool!,serverVolume,{} as never),files,storage);
    const formal=await committedServerFile(value.fixture,'previous formal version','migration-formal');
    await review.approve(value.fixture.chair,formal.id,{baseRevision:formal.revision,
      logicalName:'Migrated working paper',fileType:'WORKING_PAPER'},context('migration-formal-approve'));
    await new ServerVolumeOperationsService(pool!).update(administrator,{disabled:true,revision:1},context('disable-before-agent-migration'));
    const root=await AgentStateStore.initialize(join(stagingRoot,'chair'),{committeeId:value.fixture.committee.id,deviceId:value.paired.host.deviceId});
    const local=new AgentFileStore(root);await value.start();await storageMigrations.processNextCopyItem();
    expect((await value.latest()).totalItems).toBe(4);
    const sources=await pool!.query('SELECT id,storage_key FROM file_blobs WHERE storage_binding_id=$1',[value.fixture.binding.id]);
    const allocated=await Promise.all(sources.rows.map(source=>lstat(volume.pathForKey(source.storage_key))));
    expect(allocated.reduce((sum,info)=>sum+info.blocks*512,0)).toBeGreaterThan(0);
    for(let index=0;index<4;index+=1){
      const task=await value.claim('MIGRATE_BLOB');const chunks:Buffer[]=[];
      await value.taskService.streamBlob(value.paired.credential,{taskId:task.id,blobId:task.blobId!,leaseGeneration:task.leaseGeneration,
        fileRevision:task.fileRevision,claimToken:task.claimToken!},{start:()=>undefined,write:async chunk=>{chunks.push(chunk);}});
      await local.storeBlob(task.blobId!,async()=>(async function*(){yield Buffer.concat(chunks);})(),task.expectedSizeBytes!,task.expectedSha256!);
      await value.finish(task);
    }
    await storageMigrations.processNextCopyItem();const ready=await value.latest();
    expect(await files.processNextDeleteJob()).toBeNull();
    await storageMigrations.confirm(value.fixture.chair,ready.id,{baseRevision:ready.revision},randomUUID(),context('history-confirm'));
    for(let index=0;index<4;index+=1){const task=await value.claim('VERIFY_MIGRATION_BLOB');
      await local.verifyBlob(task.blobId!,task.expectedSizeBytes!,task.expectedSha256!);await value.finish(task);}
    await storageMigrations.processNextCopyItem();expect((await value.latest()).status).toBe('COMPLETED');
    expect((await storage.volumePolicy(value.fixture.chair,value.fixture.committee.id)).submissionBlocked).toBe(false);
    expect((await pool!.query('SELECT count(*)::int AS count FROM file_blob_delete_jobs WHERE blob_id=ANY($1::uuid[])',
      [sources.rows.map(source=>source.id)])).rows[0].count).toBe(4);
    const failedDelete=vi.spyOn(volume,'delete').mockRejectedValueOnce(new Error('temporary source cleanup failure'));
    try {expect(await files.processNextDeleteJob()).toMatchObject({status:'RETRY'});}
    finally {failedDelete.mockRestore();}
    for(const source of sources.rows)expect((await lstat(volume.pathForKey(source.storage_key))).isFile()).toBe(true);
    await pool!.query("UPDATE file_blob_delete_jobs SET next_attempt_at=now() WHERE status='RETRY'");
    for(let index=0;index<4;index+=1)expect(await files.processNextDeleteJob()).toMatchObject({status:'COMPLETED'});
    for(const source of sources.rows)await expect(lstat(volume.pathForKey(source.storage_key))).rejects.toMatchObject({code:'ENOENT'});
    expect((await pool!.query("SELECT count(*)::int AS count FROM file_blobs WHERE storage_binding_id=$1 AND durability_state='DELETED'",
      [value.fixture.binding.id])).rows[0].count).toBe(4);
    await storageMigrations.processNextCopyItem();expect(await files.processNextDeleteJob()).toBeNull();
    expect((await files.download(other.member,unrelated.id)).file.id).toBe(unrelated.id);
    for(let index=0;index<3;index+=1){const task=await value.claim('STORE_BLOB');
      await local.verifyBlob(task.localBlobId!,task.expectedSizeBytes!,task.expectedSha256!);await value.finish(task);}
    const config={publishedCacheMaxBytes:1048576,pendingReviewMaxBytes:1048576,pendingReviewCommitteeMaxBytes:1048576,
      storageMinFreeBytes:0,storageMinFreePercent:0};
    const cache=new StorageCacheService(pool!,staging,staging,{effective:async()=>({...config,revision:1})} as never);
    const refill=new StorageCacheRefillService(pool!,cache);
    const reader=new Stage6FileService(pool!,volume,fileS3Configs,provider=>new S3CompatibleStore(provider,new IntegrationS3Transport(),1048576),staging,staging,refill);
    expect((await reader.prepareDownload(value.fixture.member,latestFile.id)).status).toBe('PREPARING');
    const service=new Stage7StorageTaskService(value.agent,staging,reader,undefined,new Stage7ChairAgentProviderService(pool!,storage,cache),storageMigrations);
    const pending=(await service.tasks(value.paired.credential,value.paired.host.leaseGeneration)).tasks.find(task=>task.type==='FETCH_BLOB_TO_CACHE')!;
    const task=await service.claim(value.paired.credential,pending.id,{leaseGeneration:pending.leaseGeneration,fileRevision:pending.fileRevision,requestId:randomUUID()});
    const path=await local.verifyBlob(task.localBlobId!,task.expectedSizeBytes!,task.expectedSha256!);
    await service.receiveContent(value.paired.credential,{taskId:task.id,leaseGeneration:task.leaseGeneration,fileRevision:task.fileRevision,
      claimToken:task.claimToken!,expectedSha256:task.expectedSha256!,contentLength:task.expectedSizeBytes!,
      source:(async function*(){yield await readFile(path);})(),context:context('history-refill')});
    await service.complete(value.paired.credential,task.id,{leaseGeneration:task.leaseGeneration,fileRevision:task.fileRevision,
      claimToken:task.claimToken,requestId:randomUUID()},context('history-refill-complete'));
    const download=await reader.download(value.fixture.member,latestFile.id);let actual='';
    for await(const chunk of download.content)actual+=chunk.toString();expect(actual).toBe(next);
    await expect(pool!.query(`INSERT INTO file_versions
      (id,committee_id,file_entry_id,version_number,blob_id,original_name,media_type,size_bytes,sha256,created_by_user_id)
      SELECT $1,committee_id,file_entry_id,version_number+1,blob_id,original_name,media_type,size_bytes+1,sha256,created_by_user_id
      FROM file_versions WHERE id=$2`,[randomUUID(),latestFile.currentVersion.id])).rejects.toThrow('file version blob integrity mismatch');
    const reviewing=new DelegateFileService(pool!,uploads,new Stage6ProviderCommitService(pool!,serverVolume,{} as never),reader,storage);
    const approval={baseRevision:latestFile.revision,logicalName:'Migrated working paper',fileType:'WORKING_PAPER'};
    const preview=await reviewing.previewApproval(value.fixture.chair,latestFile.id,approval);
    expect(preview.target?.id).toBe(formal.id);
    const approved=await reviewing.approve(value.fixture.chair,latestFile.id,{...approval,confirmationToken:preview.confirmationToken},context('approve-migrated-history'));
    expect(approved.status).toBe('PUBLISHED');
    expect(await new Stage5Service(pool!).previewCrisisNotice(value.fixture.chair,notice.id)).toMatchObject({sessionOrdinal:1,groupOrdinal:1,updateOrdinal:1});
    await storage.deleteFile(value.fixture.chair,approved.id,{baseRevision:approved.revision},randomUUID(),context('delete-migrated-history'));
    await storageMigrations.processNextCopyItem();
    for(let index=0;index<3;index+=1){const cleanup=await value.claim('DELETE_MIGRATION_BLOB');
      await local.deleteBlob(cleanup.blobId!);await value.finish(cleanup);}
    const removed=await pool!.query(`SELECT count(*)::int AS count FROM file_blobs WHERE storage_binding_id=$1 AND durability_state='DELETED'`,[ready.targetBindingId]);
    expect(removed.rows[0].count).toBe(3);
  });

  it('backfills completed Chair source cleanup even with a revoked host and critical storage capacity',async()=>{
    const value=await chairMigration();await value.start();await storageMigrations.processNextCopyItem();
    await value.finish(await value.claim('MIGRATE_BLOB'));await storageMigrations.processNextCopyItem();
    const ready=await value.latest();
    await storageMigrations.confirm(value.fixture.chair,ready.id,{baseRevision:ready.revision},randomUUID(),context('backfill-confirm'));
    await value.finish(await value.claim('VERIFY_MIGRATION_BLOB'));await storageMigrations.processNextCopyItem();
    const source=(await pool!.query('SELECT id,storage_key FROM file_blobs WHERE storage_binding_id=$1',[value.fixture.binding.id])).rows[0]!;
    await pool!.query('DELETE FROM file_blob_delete_jobs WHERE blob_id=$1',[source.id]);
    await pool!.query("UPDATE file_blobs SET durability_state='COMMITTED' WHERE id=$1",[source.id]);
    await value.agent.revokeHost(value.fixture.chair,value.fixture.committee.id,value.paired.host.id,{baseRevision:await value.revision()},context('backfill-revoke'));
    const blocked=new Stage6MigrationService(pool!,staging,volume,fileS3Configs,()=>{throw new Error('Unused S3');},
      {...availableCapacity,assertWriteAllowed:async()=>{throw new Error('Storage full');}});
    await blocked.processNextCopyItem();await blocked.processNextCopyItem();
    expect((await pool!.query('SELECT count(*)::int AS count FROM file_blob_delete_jobs WHERE blob_id=$1',[source.id])).rows[0].count).toBe(1);
    expect(await files.processNextDeleteJob()).toMatchObject({status:'COMPLETED'});
    await expect(lstat(volume.pathForKey(source.storage_key))).rejects.toMatchObject({code:'ENOENT'});
  });

  it('rolls back the Chair switch when its durable source cleanup cannot be scheduled',async()=>{
    const value=await chairMigration();await value.start();await storageMigrations.processNextCopyItem();
    await value.finish(await value.claim('MIGRATE_BLOB'));await storageMigrations.processNextCopyItem();
    const ready=await value.latest();
    await storageMigrations.confirm(value.fixture.chair,ready.id,{baseRevision:ready.revision},randomUUID(),context('cleanup-atomic-confirm'));
    await value.finish(await value.claim('VERIFY_MIGRATION_BLOB'));
    await pool!.query(`CREATE FUNCTION fail_source_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'injected source cleanup failure'; END $$;
      CREATE TRIGGER fail_source_cleanup BEFORE INSERT ON file_blob_delete_jobs FOR EACH ROW EXECUTE FUNCTION fail_source_cleanup()`);
    await expect(storageMigrations.processNextCopyItem()).rejects.toThrow('injected source cleanup failure');
    expect((await value.latest()).status).toBe('READY_TO_CONFIRM');
    expect((await pool!.query('SELECT active_storage_binding_id FROM committees WHERE id=$1',[value.fixture.committee.id])).rows[0].active_storage_binding_id).toBe(value.fixture.binding.id);
    expect(await files.processNextDeleteJob()).toBeNull();
    expect((await files.download(value.fixture.member,value.file!.id)).file.id).toBe(value.file!.id);
    await pool!.query('DROP TRIGGER fail_source_cleanup ON file_blob_delete_jobs');
    await storageMigrations.processNextCopyItem();expect((await value.latest()).status).toBe('COMPLETED');
    expect(await files.processNextDeleteJob()).toMatchObject({status:'COMPLETED'});
  });

  it('re-copies a missing final verification target before allowing another switch confirmation',async()=>{
    const value=await chairMigration();await value.start();await storageMigrations.processNextCopyItem();
    const copied=await value.claim('MIGRATE_BLOB');await value.finish(copied);await storageMigrations.processNextCopyItem();
    let ready=await value.latest();await storageMigrations.confirm(value.fixture.chair,ready.id,{baseRevision:ready.revision},randomUUID(),context('missing-confirm'));
    await value.finish(await value.claim('VERIFY_MIGRATION_BLOB'),'LOCAL_CONTENT_INVALID');
    let row=await value.latest();expect(row.status).toBe('FAILED');
    expect(await files.processNextDeleteJob()).toBeNull();
    expect((await files.download(value.fixture.member,value.file!.id)).file.id).toBe(value.file!.id);
    await storageMigrations.retry(value.fixture.chair,row.id,{baseRevision:row.revision},randomUUID(),context('repair-local-copy'));
    await storageMigrations.processNextCopyItem();const recovered=await value.claim('MIGRATE_BLOB');expect(recovered.blobId).toBe(copied.blobId);
    await value.finish(recovered);await storageMigrations.processNextCopyItem();ready=await value.latest();
    await storageMigrations.confirm(value.fixture.chair,ready.id,{baseRevision:ready.revision},randomUUID(),context('repaired-confirm'));
    await value.finish(await value.claim('VERIFY_MIGRATION_BLOB'));await storageMigrations.processNextCopyItem();
    expect((await value.latest()).status).toBe('COMPLETED');
  });

  it('retries failed Chair copies and reuses committed content after a file list change',async()=>{
    const value=await chairMigration();await value.start();await storageMigrations.processNextCopyItem();
    await value.finish(await value.claim('MIGRATE_BLOB'),'ENOSPC');
    let row=await value.latest();expect(row).toMatchObject({status:'FAILED',failureCode:'ENOSPC'});
    await storageMigrations.retry(value.fixture.chair,row.id,{baseRevision:row.revision},randomUUID(),context('chair-retry'));
    await storageMigrations.processNextCopyItem();await value.finish(await value.claim('MIGRATE_BLOB'));
    await committedServerFile(value.fixture,'new file','changed-during-migration');
    await storageMigrations.processNextCopyItem();row=await value.latest();expect(row.failureCode).toBe('MANIFEST_CHANGED');
    await storageMigrations.retry(value.fixture.chair,row.id,{baseRevision:row.revision},randomUUID(),context('chair-reconcile'));
    await storageMigrations.processNextCopyItem();await value.finish(await value.claim('MIGRATE_BLOB'));
    await storageMigrations.processNextCopyItem();expect((await value.latest()).status).toBe('READY_TO_CONFIRM');
  });

  it('requires an online migration-capable Chair and keeps empty storage manual',async()=>{
    const value=await chairMigration(false);
    await value.agent.heartbeat(value.paired.credential,{leaseGeneration:value.paired.host.leaseGeneration,capabilities:['SSE_WAKE','CACHE_REFILL'],agentProtocolVersion:2});
    await expect(value.start()).rejects.toMatchObject({reason:'AGENT_UPGRADE_REQUIRED'});
    await value.heartbeat();
    await pool!.query("UPDATE storage_hosts SET last_seen_at=now()-interval '1 minute' WHERE id=$1",[value.paired.host.id]);
    await expect(value.start()).rejects.toMatchObject({reason:'STORAGE_AGENT_OFFLINE'});
    await value.heartbeat();const row=await value.start();expect(row.status).toBe('READY_TO_CONFIRM');
    await storageMigrations.confirm(value.fixture.chair,row.id,{baseRevision:row.revision},randomUUID(),context('empty-confirm'));
    await storageMigrations.processNextCopyItem();expect((await value.latest()).status).toBe('COMPLETED');
  });

  it('invalidates a Chair migration when its target is revoked',async()=>{
    const value=await chairMigration();await value.start();await storageMigrations.processNextCopyItem();
    await value.agent.revokeHost(value.fixture.chair,value.fixture.committee.id,value.paired.host.id,{baseRevision:await value.revision()},context('revoke-migration-host'));
    await storageMigrations.processNextCopyItem();expect((await value.latest()).failureCode).toBe('HOST_TRANSFERRED');
  });
  it('persists chair crisis uploads and rejects delegate uploads and ordinary review bypasses',async()=> {
    const f=await storageFixture();
    const content='Crisis notice bytes';const body={logicalName:'Crisis Notice 1.1.1',originalName:'unrelated-9.9.9.txt',mediaType:'text/plain',expectedSizeBytes:content.length,sha256:digest(content),fileType:'CRISIS_NOTICE'};
    await expect(uploads.createUpload(f.member,f.committee.id,body,randomUUID(),context('member-crisis-upload'))).rejects.toMatchObject({reason:'CHAIR_REQUIRED'});
    const upload=await uploads.createUpload(f.chair,f.committee.id,body,randomUUID(),context('chair-crisis-upload'));
    await uploads.receiveContent(f.chair,upload.id,(async function*(){yield content;})(),randomUUID(),content.length,context('crisis-bytes'));
    const notice=await serverVolume.commitUpload(f.chair,upload.id,{},randomUUID(),context('crisis-commit'));
    expect(notice).toMatchObject({status:'PENDING_REVIEW',fileType:'CRISIS_NOTICE',submissionSource:'CHAIR'});
    expect((await files.get(f.chair,notice.id)).currentVersion.originalName).toBe(body.originalName);
    const commits=new Stage6ProviderCommitService(pool!,serverVolume,{} as never);
    const review=new DelegateFileService(pool!,uploads,commits,files,storage);
    const input={baseRevision:notice.revision,logicalName:notice.logicalName,fileType:'WORKING_PAPER'};
    await expect(review.approve(f.chair,notice.id,input,context('ordinary-crisis-approve'))).rejects.toMatchObject({reason:'CRISIS_PUBLICATION_REQUIRED'});
    await expect(review.reject(f.chair,notice.id,input,randomUUID(),context('ordinary-crisis-reject'))).rejects.toMatchObject({reason:'CRISIS_PUBLICATION_REQUIRED'});
    await expect(files.publish(f.chair,notice.id,{baseRevision:notice.revision},randomUUID(),context('ordinary-crisis-publish'))).rejects.toMatchObject({reason:'CRISIS_PUBLICATION_REQUIRED'});
    expect((await files.get(f.chair,notice.id)).status).toBe('PENDING_REVIEW');
  });

  it.each(['SERVER_VOLUME','S3_COMPATIBLE'] as const)('confirms formal-name replacement atomically without copying stored bytes on %s', async provider => {
    const fixture = provider === 'SERVER_VOLUME' ? await storageFixture() : await s3Fixture();
    const transport = new IntegrationS3Transport();
    const configs = 'configs' in fixture ? fixture.configs : fileS3Configs;
    const s3 = new Stage6S3CommitService(pool!, storage, staging, configs,
      config => new S3CompatibleStore(config, transport, 20 * 1024 * 1024));
    const reader = new Stage6FileService(pool!, volume, configs,
      config => new S3CompatibleStore(config, transport, 20 * 1024 * 1024));
    const commits = new Stage6ProviderCommitService(pool!, serverVolume, s3);
    const review = new DelegateFileService(pool!, uploads, commits, reader, storage);
    const submit = async (key: string) => {
      const up = await uploads.createUpload(fixture.chair, fixture.committee.id, {logicalName: 'same-original.txt',
        originalName: 'same-original.txt',mediaType: 'text/plain',expectedSizeBytes: key.length,sha256: digest(key)}, key, context(key));
      await uploads.receiveContent(fixture.chair, up.id, (async function* () {yield key;})(), `${key}-bytes`,key.length,context(key));
      const committed = await commits.commitUpload(fixture.chair, up.id, {}, `${key}-commit`,context(key));
      if ('kind' in committed) throw new Error('Unexpected pending host commit');
      return committed;
    };
    const first = await submit('original'); const second = await submit('replacement');
    const input = (file: typeof first, logicalName='Resolution 1') => ({baseRevision:file.revision,logicalName,fileType:file.id===first.id?'RESOLUTION_DRAFT':'WORKING_PAPER'});
    const approved = await review.approve(fixture.chair, first.id,input(first,'\u00a0Resolution 1\u3000'),context('first-review'));
    expect(approved.logicalName).toBe('Resolution 1');
    const firstVersion = (await reader.get(fixture.chair,first.id)).currentVersion.id;
    const session = await stage4.startMeetingSession(fixture.chair,fixture.committee.id,{},context('replacement-session'),randomUUID());
    const seat = (await pool!.query('SELECT id FROM committee_seats WHERE committee_id=$1 ORDER BY id LIMIT 1',[fixture.committee.id])).rows[0];
    await stage4.createAttendanceEvent(fixture.chair,fixture.committee.id,{meetingSessionId:session.id,seatId:seat.id,type:'PRESENT'},context('replacement-attendance'));
    const proceedings = new Stage5Service(pool!);
    let document = await proceedings.createResolution(fixture.chair,fixture.committee.id,
      {meetingSessionId:session.id,customTitle:null,content:'',onBehalfOfSeatId:seat.id},randomUUID(),context('replacement-document'));
    document = await proceedings.createDocumentVersion(fixture.chair,document.id,
      {baseRevision:document.revision,customTitle:null,content:'',contentFileEntryId:first.id,onBehalfOfSeatId:seat.id},context('replacement-binding'));
    await pool!.query("UPDATE documents SET status='PASSED',is_public=true WHERE id=$1",[document.id]);
    const frozenBefore = (await pool!.query('SELECT * FROM documents WHERE id=$1',[document.id])).rows[0];
    await expect(proceedings.createDocumentVersion(fixture.chair,document.id,
      {baseRevision:document.revision,customTitle:null,content:'',contentFileEntryId:first.id,onBehalfOfSeatId:seat.id},context('frozen-binding')))
      .rejects.toMatchObject({code:'RESOURCE_CONFLICT',message:'The document version is frozen.'});

    await expect(review.previewApproval(fixture.member, second.id,input(second))).rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(review.approve(fixture.chair, second.id,input(second),context('unconfirmed')))
      .rejects.toMatchObject({details:{reason:'FILE_REPLACEMENT_CONFIRMATION_REQUIRED'}});
    await pool!.query('UPDATE file_entries SET logical_name=$2 WHERE id=$1',[second.id,'Resolution 1']);
    await expect(reader.publish(fixture.chair,second.id,{baseRevision:second.revision},'old-publish',context('old-publish')))
      .rejects.toMatchObject({details:{reason:'FILE_REPLACEMENT_CONFIRMATION_REQUIRED'}});
    const preview = await review.previewApproval(fixture.chair,second.id,input(second));
    expect(preview.target).toMatchObject({id:first.id,logicalName:'Resolution 1'});
    await expect(review.approve(fixture.chair,second.id,{...input(second,'Renamed'),confirmationToken:preview.confirmationToken},context('renamed')))
      .rejects.toMatchObject({details:{reason:'FILE_REPLACEMENT_CHANGED'}});
    await expect(review.approve(fixture.chair,second.id,{...input(second),fileType:'DIRECTIVE_DRAFT',confirmationToken:preview.confirmationToken},context('type-changed')))
      .rejects.toMatchObject({details:{reason:'FILE_REPLACEMENT_CHANGED'}});
    await pool!.query(`CREATE FUNCTION fail_replacement_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='storage.file_published' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_replacement_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_replacement_audit()`);
    await expect(review.approve(fixture.chair,second.id,{...input(second),confirmationToken:preview.confirmationToken},context('rollback'))).rejects.toThrow();
    expect((await reader.get(fixture.chair,first.id)).currentVersion.id).toBe(firstVersion);
    expect((await reader.get(fixture.chair,second.id)).status).toBe('PENDING_REVIEW');
    await pool!.query('DROP TRIGGER fail_replacement_audit ON audit_log');
    const liveDocument=await proceedings.createResolution(fixture.chair,fixture.committee.id,
      {meetingSessionId:session.id,customTitle:null,content:'',onBehalfOfSeatId:seat.id},randomUUID(),context('live-replacement-document'));
    const [result,bound]=await Promise.all([
      review.approve(fixture.chair,second.id,{...input(second),confirmationToken:preview.confirmationToken},context('replace')),
      proceedings.createDocumentVersion(fixture.chair,liveDocument.id,
        {baseRevision:liveDocument.revision,customTitle:null,content:'',contentFileEntryId:first.id,onBehalfOfSeatId:seat.id},context('concurrent-replacement-binding'))
    ]);
    expect(bound.currentVersion.contentFile).toMatchObject({id:first.id,status:'PUBLISHED'});
    expect(result.id).toBe(first.id);
    const current = await reader.get(fixture.chair,first.id);
    expect(current.currentVersion.blobId).toBe(second.currentVersion.blobId);
    expect(current.currentVersion.versionNumber).toBe(2);
    expect((await pool!.query('SELECT * FROM documents WHERE id=$1',[document.id])).rows[0]).toEqual(frozenBefore);
    const snapshot=await stage4.snapshot(fixture.committee.id,fixture.chair);
    expect(snapshot.documents?.find(item=>item.id===document.id)?.currentVersion.contentFile)
      .toMatchObject({id:first.id,originalName:current.currentVersion.originalName,status:'PUBLISHED',fileType:'WORKING_PAPER'});

    expect((await reader.list(fixture.chair,fixture.committee.id)).map(file=>file.id)).toEqual([first.id]);
    expect((await pool!.query('SELECT count(*)::int AS count FROM file_blobs WHERE committee_id=$1',[fixture.committee.id])).rows[0].count).toBe(2);
    expect((await review.listReview(fixture.chair,fixture.committee.id)).find(file=>file.id===second.id))
      .toMatchObject({status:'PUBLISHED',publishedFileId:first.id,originalName:'same-original.txt'});
    const downloaded = await reader.download(fixture.chair,first.id);
    let bytes=''; for await (const chunk of downloaded.content) bytes+=chunk.toString(); expect(bytes).toBe('replacement');
    await expect(storage.deleteFile(fixture.chair,second.id,{baseRevision:second.revision+1},'delete-source',context('delete-source')))
      .rejects.toMatchObject({code:'NOT_FOUND'});
    const third = await submit('third'); const stale = await review.previewApproval(fixture.chair,third.id,input(third));
    const fourth = await submit('fourth'); const fresh = await review.previewApproval(fixture.chair,fourth.id,input(fourth));
    await review.approve(fixture.chair,fourth.id,{...input(fourth),confirmationToken:fresh.confirmationToken},context('fourth'));
    await expect(review.approve(fixture.chair,third.id,{...input(third),confirmationToken:stale.confirmationToken},context('stale')))
      .rejects.toMatchObject({details:{reason:'FILE_REPLACEMENT_CHANGED'}});
    const a=await submit('parallel-a');const b=await submit('parallel-b');
    const parallel=await Promise.allSettled([review.approve(fixture.chair,a.id,input(a,'Concurrent'),context('concurrent-a')),
      review.approve(fixture.chair,b.id,input(b,'Concurrent'),context('concurrent-b'))]);
    expect(parallel.filter(item=>item.status==='fulfilled')).toHaveLength(1);
    expect(parallel.find(item=>item.status==='rejected')).toMatchObject({reason:{details:{reason:'FILE_REPLACEMENT_CONFIRMATION_REQUIRED'}}});
    // Exact case-sensitive names stay distinct.
    await review.approve(fixture.chair,third.id,input(third,'resolution 1'),context('different-case'));
    const last=await reader.get(fixture.chair,first.id);
    await storage.deleteFile(fixture.chair,first.id,{baseRevision:last.revision},'delete-formal',context('delete-formal'));
    await expect(reader.get(fixture.chair,first.id)).rejects.toMatchObject({code:'NOT_FOUND'});
    expect((await stage4.snapshot(fixture.committee.id,fixture.chair)).documents?.find(item=>item.id===document.id)?.currentVersion.contentFile)
      .toMatchObject({id:first.id,status:'DELETED',originalName:'same-original.txt',fileType:'WORKING_PAPER'});
    expect((await pool!.query('SELECT status FROM file_entries WHERE id=ANY($1::uuid[])',[[second.id,fourth.id]])).rows)
      .toEqual([{status:'DELETED'},{status:'DELETED'}]);
    const reused=await submit('reused');
    expect((await review.previewApproval(fixture.chair,reused.id,input(reused))).target).toBeNull();
    expect((await review.approve(fixture.chair,reused.id,input(reused),context('reuse'))).id).toBe(reused.id);
    const jobs=await pool!.query('SELECT blob_id FROM file_blob_delete_jobs WHERE committee_id=$1',[fixture.committee.id]);
    expect(jobs.rows.map(row=>row.blob_id)).toEqual(expect.arrayContaining([first.currentVersion.blobId,second.currentVersion.blobId,fourth.currentVersion.blobId]));
    expect(jobs.rows.map(row=>row.blob_id)).not.toContain(reused.currentVersion.blobId);
  });

  it('restricts media uploads to news and instant messages in both delegate and account entry points', async () => {
    const f = await storageFixture('PRIVATE');
    const seat = (await stage4.snapshot(f.committee.id, f.chair)).seats.find(seat => seat.stableKey === 'member')!;
    await stage4.updateSeat(f.chair, f.committee.id, seat.id,
      {baseRevision: seat.revision, patch: {rank: 'MEDIA', canVote: false, canProceduralVote: false}}, context('media-seat'));
    await pool!.query("UPDATE committees SET operation_mode='CHAIR_OPERATED' WHERE id=$1", [f.committee.id]);
    await stage4.startMeetingSession(f.chair, f.committee.id, {}, context('media-session'), randomUUID());
    const transport = new IntegrationS3Transport();
    const s3 = new Stage6S3CommitService(pool!, storage, staging, fileS3Configs,
      config => new S3CompatibleStore(config, transport, 20 * 1024 * 1024));
    const portal = new DelegateFileService(pool!, uploads, new Stage6ProviderCommitService(pool!, serverVolume, s3), files, storage);
    const snapshot = await stage4.snapshot(f.committee.id, f.chair);
    const share = await portal.startShare(f.chair, f.committee.id, snapshot.committee.revision,
      'https://localhost', context('media-share'));
    const capability = share.url.split('#')[1]!;
    expect((await portal.bootstrap(capability)).eligibleSeats).toContainEqual(expect.objectContaining({id: seat.id, rank: 'MEDIA'}));
    const claimed = await portal.claim(capability, seat.id, context('media-claim'));
    expect(claimed).toMatchObject({mayUpload: true, claimedSeat: {id: seat.id, rank: 'MEDIA'}});
    const body = {logicalName: 'media.txt', originalName: 'media.txt', mediaType: 'text/plain', expectedSizeBytes: 1, sha256: digest('x')};
    for (const fileType of ['WORKING_PAPER', 'DIRECTIVE_DRAFT', 'RESOLUTION_DRAFT', 'CRISIS_NOTICE', 'CUSTOM:Test']) {
      await expect(portal.createUpload(claimed.sessionToken, {...body, fileType}, randomUUID(), context('media-denied')))
        .rejects.toMatchObject({code: 'FORBIDDEN', reason: 'MEDIA_FILE_TYPE_REQUIRED'});
      await expect(uploads.createUpload(f.member, f.committee.id, {...body, fileType}, randomUUID(), context('account-media-denied')))
        .rejects.toMatchObject({code: 'FORBIDDEN', reason: 'MEDIA_FILE_TYPE_REQUIRED'});
    }
    for (const fileType of ['NEWS', 'INSTANT_MESSAGE']) {
      const upload = await portal.createUpload(claimed.sessionToken, {...body, fileType}, randomUUID(), context('media-allowed'));
      await portal.receiveContent(claimed.sessionToken, upload.id, (async function* () {yield 'x';})(), randomUUID(), 1, context('media-bytes'));
      const committed = await portal.commitUpload(claimed.sessionToken, upload.id, randomUUID(), context('media-commit'));
      expect(committed).toMatchObject({status: 'PENDING_REVIEW', fileType});
      expect(await uploads.createUpload(f.member, f.committee.id, {...body, fileType}, randomUUID(), context('account-media-allowed')))
        .toMatchObject({status: 'CREATED'});
    }
  });

  it.each(['SERVER_VOLUME', 'S3_COMPATIBLE'] as const)('uses the same private submission, review and share lifecycle on %s', async provider => {
    const fixture = provider === 'SERVER_VOLUME' ? await storageFixture('PRIVATE') : await s3Fixture();
    await pool!.query(`UPDATE committees SET visibility='PRIVATE',operation_mode='CHAIR_OPERATED' WHERE id=$1`, [fixture.committee.id]);
    const transport = new IntegrationS3Transport();
    const configs = 'configs' in fixture ? fixture.configs : fileS3Configs;
    const s3 = new Stage6S3CommitService(pool!, storage, staging, configs,
      config => new S3CompatibleStore(config, transport, 20 * 1024 * 1024));
    const reader = new Stage6FileService(pool!, volume, configs,
      config => new S3CompatibleStore(config, transport, 20 * 1024 * 1024));
    const commits = new Stage6ProviderCommitService(pool!, serverVolume, s3);
    // A zero-sized Chair cache must have no effect on durable volume/S3 submissions.
    const cache = {assertPendingCapacity: async () => {throw new Error('Chair cache must not be consulted');}};
    const portal = new DelegateFileService(pool!, uploads, commits, reader, storage, cache as never);
    const session = await stage4.startMeetingSession(fixture.chair, fixture.committee.id, {}, context('open'), randomUUID());
    const seats = (await pool!.query('SELECT id FROM committee_seats WHERE committee_id=$1 ORDER BY sort_order', [fixture.committee.id])).rows;
    const seat = seats[0]!;
    await stage4.createAttendanceEvent(fixture.chair, fixture.committee.id,
      {meetingSessionId: session.id, seatId: seat.id, type: 'PRESENT'}, context('present'));
    const revision = async () => (await pool!.query('SELECT revision FROM committees WHERE id=$1', [fixture.committee.id])).rows[0].revision;
    await expect(portal.startShare(fixture.member, fixture.committee.id, await revision(), 'https://localhost', context('forbidden')))
      .rejects.toMatchObject({code: 'FORBIDDEN'});
    const share = await portal.startShare(fixture.chair, fixture.committee.id, await revision(), 'https://localhost', context('share'));
    const capability = share.url.split('#')[1]!;
    const claimed = await portal.claim(capability, seat.id, context('claim'));
    expect(claimed.storageAvailable).toBe(true);
    const content = 'verified delegate content';
    const body = {logicalName: 'delegate.txt', originalName: 'delegate.txt', mediaType: 'text/plain',
      expectedSizeBytes: Buffer.byteLength(content), sha256: digest(content), fileType: 'WORKING_PAPER'};
    const submit = async (key: string) => {
      const up = await portal.createUpload(claimed.sessionToken, body, key, context(key));
      expect(await portal.createUpload(claimed.sessionToken, body, key, context('repeat'))).toEqual(up);
      await expect(portal.createUpload(claimed.sessionToken, {...body, fileType: 'DIRECTIVE_DRAFT'}, key, context('changed-type')))
        .rejects.toMatchObject({code: 'IDEMPOTENCY_CONFLICT'});
      expect((await portal.bootstrap(capability, claimed.sessionToken)).submissions).not.toContainEqual(expect.objectContaining({id: up.id}));
      await portal.receiveContent(claimed.sessionToken, up.id, (async function* () {yield content;})(), `${key}-bytes`, content.length, context('bytes'));
      if (key === 'first') {
        transport.failPut = true;
        const volumeFailure = provider === 'SERVER_VOLUME' ? vi.spyOn(volume, 'commitFromStaging')
          .mockRejectedValueOnce(new ProviderStorageError('PROVIDER_IO_FAILED', 'SERVICE_NOT_READY', 'Injected disk failure')) : undefined;
        await expect(portal.commitUpload(claimed.sessionToken, up.id, `${key}-commit`, context('failed-copy'))).rejects.toBeDefined();
        const failed = await portal.bootstrap(capability, claimed.sessionToken);
        expect(failed.pendingUploads).toContainEqual(expect.objectContaining({id: up.id, status: 'FAILED'}));
        expect(failed.submissions).toEqual([]);
        expect(await portal.listReview(fixture.chair, fixture.committee.id)).toEqual([]);
        transport.failPut = false;
        volumeFailure?.mockRestore();
      }
      const result = await portal.commitUpload(claimed.sessionToken, up.id, `${key}-commit`, context('commit'));
      expect((await portal.bootstrap(capability, claimed.sessionToken)).pendingUploads).not.toContainEqual(expect.objectContaining({id: up.id}));
      if ('kind' in result) throw new Error('Volume/S3 saves must finish before returning a file');
      expect(result.status).toBe('PENDING_REVIEW');
      expect(await portal.commitUpload(claimed.sessionToken, up.id, `${key}-commit`, context('replay'))).toEqual(result);
      return result;
    };
    const pending = await submit('first');
    expect((await portal.bootstrap(capability, claimed.sessionToken)).files).toEqual([]);
    await expect(portal.download(claimed.sessionToken, pending.id)).rejects.toMatchObject({code: 'NOT_FOUND'});
    await expect(portal.approve(fixture.member, pending.id, {baseRevision: pending.revision, logicalName: 'Approved', fileType: 'WORKING_PAPER'}, context('forbidden')))
      .rejects.toMatchObject({code: 'FORBIDDEN'});
    const approved = await portal.approve(fixture.chair, pending.id,
      {baseRevision: pending.revision, logicalName: 'Approved', fileType: 'WORKING_PAPER'}, context('approve'));
    expect(approved).toMatchObject({status: 'PUBLISHED', submissionSource: 'DELEGATE_PORTAL', fileType: 'WORKING_PAPER'});
    expect((await portal.bootstrap(capability, claimed.sessionToken)).categoryOpenedAt).toEqual({});
    await expect(portal.openPublishedCategory(claimed.sessionToken, 'ALL', approved.id)).rejects.toMatchObject({code: 'VALIDATION_FAILED'});
    await expect(portal.openPublishedCategory(claimed.sessionToken, 'NEWS', approved.id)).rejects.toMatchObject({code: 'VALIDATION_FAILED'});
    const opened = await portal.openPublishedCategory(claimed.sessionToken, 'WORKING_PAPER', approved.id);
    expect(opened.openedAt).toBe(approved.publishedAt);
    const otherBrowser = await portal.claim(capability, seat.id, context('claim-other-browser'));
    expect(otherBrowser.categoryOpenedAt).toEqual({WORKING_PAPER: opened.openedAt});
    expect((await portal.bootstrap(capability, otherBrowser.sessionToken)).categoryOpenedAt)
      .toEqual({WORKING_PAPER: opened.openedAt});
    await expect(portal.openPublishedCategory(otherBrowser.sessionToken, 'OTHER', approved.id))
      .rejects.toMatchObject({code: 'VALIDATION_FAILED'});
    expect((await portal.bootstrap(capability, claimed.sessionToken)).categoryOpenedAt)
      .toEqual({WORKING_PAPER: opened.openedAt});
    await expect(reader.download(undefined, approved.id)).rejects.toMatchObject({code: 'NOT_FOUND'});
    const download = await portal.download(claimed.sessionToken, approved.id);
    const chunks = []; for await (const chunk of download.content) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe(content);
    const rejected = await submit('reject');
    const settings = await portal.getSettings(fixture.chair, fixture.committee.id);
    await portal.reject(fixture.chair, rejected.id, {baseRevision: rejected.revision, logicalName: 'Rejected',
      fileType: 'WORKING_PAPER', rejectionTypeId: settings.rejectionTypes[0]!.id, reason: 'Revise this file'}, 'reject', context('reject'));
    const history = await portal.bootstrap(capability, claimed.sessionToken);
    expect(history.files.map(file => file.id)).toEqual([approved.id]);
    expect(history.submissions).toContainEqual(expect.objectContaining({id: rejected.id, status: 'REJECTED', rejectionReason: expect.any(String)}));
    const {fileType: _, ...chairBody} = body;
    const chairUpload = await uploads.createUpload(fixture.chair, fixture.committee.id, chairBody, 'chair', context('chair'));
    await uploads.receiveContent(fixture.chair, chairUpload.id, (async function* () {yield content;})(), 'chair-bytes', content.length, context('chair-bytes'));
    const chairFile = await commits.commitUpload(fixture.chair, chairUpload.id, {}, 'chair-commit', context('chair-commit'));
    expect(chairFile).toMatchObject({status: 'PENDING_REVIEW', submissionSource: 'CHAIR', fileType: null});
    // Storage outages do not revoke a valid share or credential.
    await pool!.query('UPDATE committees SET active_storage_binding_id=NULL WHERE id=$1', [fixture.committee.id]);
    expect((await portal.bootstrap(capability, claimed.sessionToken)).storageAvailable).toBe(false);
    await pool!.query('UPDATE committees SET active_storage_binding_id=$2 WHERE id=$1', [fixture.committee.id, fixture.binding.id]);
    expect((await portal.bootstrap(capability, claimed.sessionToken)).files.map(file => file.id)).toEqual([approved.id]);
    // Historical published entries without metadata stay published and retain unknown source/type.
    await pool!.query('DELETE FROM delegate_file_metadata WHERE file_entry_id=$1', [approved.id]);
    expect((await portal.bootstrap(capability, claimed.sessionToken)).files[0]).toMatchObject({
      id: approved.id, submissionSource: 'LEGACY', submitterDisplayName: null, fileType: null
    });
    expect((await reader.get(fixture.chair, approved.id)).status).toBe('PUBLISHED');
    if (provider === 'SERVER_VOLUME') {
      const config = await createMigrationS3Config('Shared Migration');
      const migrations = new Stage6MigrationService(pool!, staging, volume, configs,
        config => new S3CompatibleStore(config, transport, 20 * 1024 * 1024));
      const migration = await migrations.create(fixture.chair, fixture.committee.id, {
        baseRevision: await revision(), targetProviderType: 'S3_COMPATIBLE', targetProviderConfigId: config.id
      }, 'shared-migration', context('shared-migration'));
      while (await migrations.processNextCopyItem()) { /* Copy all three retained files. */ }
      const ready = (await migrations.list(fixture.chair, fixture.committee.id))[0]!;
      await migrations.confirm(fixture.chair, migration.id, {baseRevision: ready.revision},
        'confirm-shared-migration', context('confirm-shared-migration'));
      const afterMigration = await portal.bootstrap(capability, claimed.sessionToken);
      expect(afterMigration.storageAvailable).toBe(true);
      expect(afterMigration.files.map(file => file.id)).toEqual([approved.id]);
      expect(afterMigration.submissions).toContainEqual(expect.objectContaining({id: rejected.id, status: 'REJECTED'}));
      expect((await reader.get(fixture.chair, chairFile.id)).status).toBe('PENDING_REVIEW');
      const migratedDownload = await portal.download(claimed.sessionToken, approved.id);
      const migratedChunks = []; for await (const chunk of migratedDownload.content) migratedChunks.push(chunk);
      expect(Buffer.concat(migratedChunks).toString()).toBe(content);
    }
    const beforeChairApproval = (await portal.bootstrap(capability, claimed.sessionToken)).eventSequence;
    const approvedChair = await portal.approve(fixture.chair, chairFile.id,
      {baseRevision: chairFile.revision, logicalName: 'Chair publication', fileType: 'NEWS'}, context('chair-approve'));
    const chairEvent = (await portal.events(claimed.sessionToken, beforeChairApproval)).rows;
    expect(chairEvent).toContainEqual(expect.objectContaining({fileId: approvedChair.id, kind: 'available',
      submissionSource: 'CHAIR', submitterDisplayName: null, logicalName: 'Chair publication'}));
    await portal.endShare(fixture.chair, fixture.committee.id, share.revision, context('end'));
    await expect(portal.authenticate(claimed.sessionToken)).rejects.toMatchObject({code: 'AUTHENTICATION_REQUIRED'});
    await expect(portal.bootstrap(capability)).rejects.toMatchObject({code: 'LINK_EXPIRED'});
  });

  it('reads committed upload receipts only for the uploader, Owner or Chair', async () => {
    const fixture = await storageFixture();
    const upload = await uploads.createUpload(fixture.member, fixture.committee.id, {
      logicalName: 'Receipt', originalName: 'receipt.txt', mediaType: 'text/plain', expectedSizeBytes: 4, sha256: digest('data')
    }, 'receipt-upload', context('receipt-upload'));
    expect(await uploads.getUpload(fixture.member, upload.id)).toMatchObject({id: upload.id, status: 'CREATED'});
    await expect(uploads.getUpload(administrator, upload.id)).rejects.toMatchObject({code: 'FORBIDDEN'});
    const other = await user('other-member');
    const otherSeat = await stage4.createSeat(fixture.chair, fixture.committee.id, {stableKey: 'other'}, 'other-seat', context('other-seat'));
    await stage3.assignSeat(fixture.chair, fixture.committee.id, {seatId: otherSeat.id, email: other.user.email}, context('assign-other'));
    await expect(uploads.getUpload(other, upload.id)).rejects.toMatchObject({code: 'NOT_FOUND'});
    await uploads.receiveContent(fixture.member, upload.id, (async function* () {yield 'data';})(), 'receipt-content', 4, context('receipt-content'));
    const file = await serverVolume.commitUpload(fixture.member, upload.id, {}, 'receipt-commit', context('receipt-commit'));
    for (const viewer of [fixture.member, fixture.owner, fixture.chair]) {
      expect(await uploads.getUpload(viewer, upload.id)).toMatchObject({status: 'COMMITTED', committedFileEntryId: file.id});
    }
  });

  it('lists storage binding state only for the committee Owner or Chair', async () => {
    const fixture = await storageFixture();
    await expect(storage.listBindings(fixture.owner, fixture.committee.id)).resolves.toEqual([fixture.binding]);
    await expect(storage.listBindings(fixture.chair, fixture.committee.id)).resolves.toEqual([fixture.binding]);
    await expect(storage.listBindings(fixture.member, fixture.committee.id)).rejects.toMatchObject({code: 'FORBIDDEN'});
    await expect(storage.listBindings(administrator, fixture.committee.id)).rejects.toMatchObject({code: 'FORBIDDEN'});
    const ownerCommittee = await stage4.createCommittee(fixture.owner, await testCommitteeInput(pool!, fixture.owner, {name: 'Owner storage', visibility: 'PRIVATE',
      countryTemplateKey: 'builtin:default'}), 'owner-storage-committee', context('owner-storage-committee'));
    await expect(storage.createServerVolumeBinding(fixture.owner, ownerCommittee.id,
      {baseRevision: ownerCommittee.revision}, 'owner-storage-binding', context('owner-storage-binding')))
      .resolves.toMatchObject({committeeId: ownerCommittee.id, providerType: 'SERVER_VOLUME', status: 'ACTIVE'});
  });

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
    expect(file.status).toBe('PENDING_REVIEW');

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

    const diskOperations: StagingOperations = {link, symlink, lstat, mkdir, realpath, unlink,
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
      link, symlink, lstat, mkdir, open, realpath,
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

    const pending = created;
    expect(pending).toMatchObject({status: 'PENDING_REVIEW', submittedAt: expect.any(String), publishedAt: null});
    await expect(files.submitForReview(fixture.member, created.id, {baseRevision: created.revision},
      'submit-review', context('submit-review'))).rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    await expect(files.publish(fixture.chair, created.id, {baseRevision: created.revision + 1}, 'stale-publish',
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
    const pending = created;
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
    expect(state?.rows[0]).toEqual({status: 'PENDING_REVIEW', revision: created.revision,
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
      link, symlink, lstat, mkdir, open, realpath,
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
    const pending = created;
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
    await new ServerVolumeOperationsService(pool!).update(administrator,{disabled:true,revision:1},context('disable-for-s3'));
    const source=(await pool!.query('SELECT storage_key FROM file_blobs WHERE id=$1',[file.currentVersion.blobId])).rows[0];
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
    expect(completed.sourceCleanup).toMatchObject({total:1,pending:1});
    expect((await storage.volumePolicy(fixture.chair,fixture.committee.id)).submissionBlocked).toBe(false);
    expect(await uploads.createUpload(fixture.chair,fixture.committee.id,{logicalName:'allowed',originalName:'allowed.txt',mediaType:'text/plain',expectedSizeBytes:3,sha256:digest('abc')},randomUUID(),context('allowed-s3-upload'))).toHaveProperty('id');
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
    await expect(lstat(volume.pathForKey(source.storage_key))).rejects.toMatchObject({code:'ENOENT'});
    expect((await migrations.list(fixture.chair,fixture.committee.id))[0]?.sourceCleanup).toMatchObject({pending:0,failed:0});
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
