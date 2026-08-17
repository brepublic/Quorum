import {randomUUID} from 'node:crypto';
import type {Pool, PoolClient, QueryResultRow} from 'pg';
import type {StorageMigration, StorageMigrationItem} from '@quorum/contracts';
import {AppError} from '../../http/errors.js';
import type {Logger} from '../../logger.js';
import type {AuthenticatedSession} from '../identity/store.js';
import {appendEvent, audit, idempotentTransaction, isChair, lockedCommittee, requireBusinessIdentity,
  requireProceedingsActive, transaction, type Stage4CommitteeRow, type Stage4Context} from '../stage4/database.js';
import {assertExactBody} from '../stage4/validation.js';
import type {Stage6S3ConfigService} from './s3-config-service.js';
import type {S3CompatibleStore, S3ProviderConfig} from './s3-store.js';
import type {ServerVolumeStore} from './server-volume.js';
import {ProviderStorageError} from './server-volume.js';
import type {DurableStagingStore} from './staging.js';
import {UploadStreamError} from './staging.js';
import type {StorageCapacityGuard} from './capacity.js';

type ProviderType = 'SERVER_VOLUME' | 'S3_COMPATIBLE';
type MigrationStatus = StorageMigration['status'];
type ItemStatus = StorageMigrationItem['status'];
type ProviderStore = Pick<ServerVolumeStore, 'verify' | 'read' | 'commitFromStaging' | 'delete'>;
export type MigrationS3StoreFactory = (config: S3ProviderConfig) =>
  Pick<S3CompatibleStore, 'verify' | 'read' | 'commitFromStaging' | 'delete'>;

interface MigrationRow extends QueryResultRow {
  id: string; committee_id: string; source_binding_id: string; target_binding_id: string;
  status: MigrationStatus; manifest_revision: number; revision: number; failure_code: string | null;
  created_at: Date; updated_at: Date; total_items: number; completed_items: number;
}

interface ItemRow extends QueryResultRow {
  id: string; migration_id: string; committee_id: string; content_blob_id: string; source_blob_id: string;
  target_blob_id: string; staging_key: string; size_bytes: string | number; sha256_hex: string;
  status: ItemStatus; attempts: number; next_attempt_at: Date; claimed_at: Date | null;
  claim_token: string | null; failure_code: string | null;
  source_storage_key: string; source_provider_type: ProviderType; source_provider_config_id: string | null;
  target_provider_type: ProviderType; target_provider_config_id: string | null;
}

interface ContentLocationRow extends QueryResultRow {
  content_blob_id: string; source_blob_id: string | null; size_bytes: string | number; sha256_hex: string;
}

interface BindingRow extends QueryResultRow {
  id: string; committee_id: string; provider_type: ProviderType; provider_config_id: string | null;
  status: 'PENDING' | 'ACTIVE' | 'MIGRATING' | 'FAILED' | 'RETIRED'; revision: number;
}

interface TargetVerificationRow extends QueryResultRow {
  storage_key: string; size_bytes: string | number; sha256_hex: string;
  provider_type: ProviderType; provider_config_id: string | null;
}

const MIGRATION_SELECT = `SELECT m.*,
  (SELECT count(*)::int FROM storage_migration_items i WHERE i.migration_id=m.id) AS total_items,
  (SELECT count(*)::int FROM storage_migration_items i WHERE i.migration_id=m.id AND i.status='COMPLETED') AS completed_items
  FROM storage_migrations m`;

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError({code: 'VALIDATION_FAILED', message: `${name} is invalid.`});
  }
  return value;
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Revision is invalid.'});
  }
  return Number(value);
}

function mapMigration(row: MigrationRow): StorageMigration {
  return {id: row.id, committeeId: row.committee_id, sourceBindingId: row.source_binding_id,
    targetBindingId: row.target_binding_id, status: row.status, manifestRevision: row.manifest_revision,
    revision: row.revision, totalItems: Number(row.total_items), completedItems: Number(row.completed_items),
    failureCode: row.failure_code, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString()};
}

function mapItem(row: ItemRow): StorageMigrationItem {
  return {id: row.id, migrationId: row.migration_id, contentBlobId: row.content_blob_id,
    targetBlobId: row.target_blob_id, status: row.status, attempts: row.attempts, failureCode: row.failure_code};
}

function stagingKey(itemId: string): string {
  const compact = itemId.replaceAll('-', '').toLowerCase();
  return `provider-migrations/${compact.slice(0, 2)}/${compact}`;
}

export async function copyProviderBlob(input: {staging: DurableStagingStore; stagingKey: string;
  source: Pick<ProviderStore, 'read'>; sourceStorageKey: string;
  target: Pick<ProviderStore, 'commitFromStaging'>; targetBlobId: string;
  sizeBytes: number; sha256: string}): Promise<{storageKey: string; sizeBytes: number; sha256: string}> {
  if (await input.staging.exists(input.stagingKey)) {
    await input.staging.verify(input.stagingKey, input.sizeBytes, input.sha256);
  } else {
    await input.staging.write({key: input.stagingKey,
      source: input.source.read(input.sourceStorageKey, input.sizeBytes, input.sha256),
      expectedSizeBytes: input.sizeBytes, expectedSha256: input.sha256});
  }
  return input.target.commitFromStaging({blobId: input.targetBlobId, staging: input.staging,
    stagingKey: input.stagingKey, expectedSizeBytes: input.sizeBytes, expectedSha256: input.sha256});
}

export class Stage6MigrationService {
  constructor(private readonly pool: Pool, private readonly staging: DurableStagingStore,
    private readonly serverVolume: ServerVolumeStore, private readonly s3Configs: Stage6S3ConfigService,
    private readonly s3Factory: MigrationS3StoreFactory, private readonly capacity?: StorageCapacityGuard) {}

  async list(auth: AuthenticatedSession, committeeId: string): Promise<StorageMigration[]> {
    requireBusinessIdentity(auth);
    return transaction(this.pool, async client => {
      const committee = await lockedCommittee(client, uuid(committeeId, 'Committee ID'));
      await this.requireOwnerOrChair(client, committee, auth.user.id);
      const result = await client.query<MigrationRow>(`${MIGRATION_SELECT} WHERE m.committee_id=$1
        ORDER BY m.created_at DESC,m.id`, [committee.id]);
      return result.rows.map(mapMigration);
    });
  }

  async create(auth: AuthenticatedSession, committeeId: string, body: unknown, idempotencyKey: string,
    context: Stage4Context): Promise<StorageMigration> {
    requireBusinessIdentity(auth);
    assertExactBody(body as Record<string, unknown>, ['baseRevision', 'targetProviderType', 'targetProviderConfigId']);
    const input = body as {baseRevision?: unknown; targetProviderType?: unknown; targetProviderConfigId?: unknown};
    const targetType = input.targetProviderType;
    if (targetType !== 'SERVER_VOLUME' && targetType !== 'S3_COMPATIBLE') {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Target provider type is invalid.'});
    }
    const targetConfigId = targetType === 'S3_COMPATIBLE'
      ? uuid(input.targetProviderConfigId, 'Target provider config ID') : null;
    if (targetType === 'SERVER_VOLUME' && input.targetProviderConfigId !== undefined) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'SERVER_VOLUME does not use a provider config.'});
    }
    const migrationId = randomUUID();
    const targetBindingId = randomUUID();
    const committeeRevision = revision(input.baseRevision);
    return idempotentTransaction({pool: this.pool, auth,
      route: `/api/v1/committees/${committeeId}/storage-migrations`, key: idempotencyKey, request: body, status: 201,
      work: async client => {
        const committee = await lockedCommittee(client, uuid(committeeId, 'Committee ID'));
        requireProceedingsActive(committee);
        await this.requireOwnerOrChair(client, committee, auth.user.id);
        if (committee.revision !== committeeRevision) {
          throw new AppError({code: 'REVISION_CONFLICT', message: 'This committee changed since it was loaded.',
            details: {currentRevision: committee.revision}});
        }
        const source = await this.bindingForUpdate(client, committee.active_storage_binding_id);
        if (!source || source.status !== 'ACTIVE') {
          throw new AppError({code: 'SERVICE_NOT_READY', message: 'The active storage binding is unavailable.'});
        }
        await this.validateTarget(client, source, targetType, targetConfigId);
        await client.query(`INSERT INTO storage_bindings
          (id,committee_id,provider_type,provider_config_id,status,created_by_user_id)
          VALUES ($1,$2,$3,$4,'MIGRATING',$5)`,
        [targetBindingId, committee.id, targetType, targetConfigId, auth.user.id]);
        await client.query(`INSERT INTO storage_migrations
          (id,committee_id,source_binding_id,target_binding_id,manifest_revision,created_by_user_id)
          VALUES ($1,$2,$3,$4,$5,$6)`,
        [migrationId, committee.id, source.id, targetBindingId, committee.file_manifest_revision, auth.user.id]);
        const contents = await this.contentLocations(client, committee.id, source.id);
        for (const content of contents) {
          if (!content.source_blob_id) {
            throw new AppError({code: 'SERVICE_NOT_READY', message: 'A source blob is unavailable.'});
          }
          await this.insertItem(client, migrationId, committee.id, content);
        }
        if (!contents.length) {
          await client.query(`UPDATE storage_migrations SET status='READY_TO_CONFIRM',ready_at=now(),updated_at=now()
            WHERE id=$1`, [migrationId]);
        }
        await client.query('UPDATE committees SET revision=revision+1,updated_at=now() WHERE id=$1', [committee.id]);
        committee.revision += 1;
        await appendEvent(client, committee, {type: 'storage.migration_created', resourceType: 'storage_migration',
          resourceId: migrationId, revision: 1, audience: 'CHAIR',
          payload: {sourceBindingId: source.id, targetBindingId, itemCount: contents.length}});
        await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
          capabilities: await isChair(client, committee.id, auth.user.id) ? ['CHAIR'] : ['OWNER'],
          action: 'storage.migration_created', resourceType: 'storage_migration', resourceId: migrationId,
          after: {sourceBindingId: source.id, targetBindingId, itemCount: contents.length, revision: 1}});
        return this.migration(client, migrationId);
      }});
  }

  async retry(auth: AuthenticatedSession, migrationId: string, body: unknown, idempotencyKey: string,
    context: Stage4Context): Promise<StorageMigration> {
    return this.command(auth, migrationId, body, idempotencyKey, 'retry', context, async (client, committee, row) => {
      if (row.status !== 'FAILED') {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'This storage migration cannot be retried.'});
      }
      const target = await this.bindingForUpdate(client, row.target_binding_id);
      if (!target || target.status !== 'MIGRATING') {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The target storage binding is unavailable.'});
      }
      if (target.provider_type === 'S3_COMPATIBLE') {
        await this.activeS3Config(client, target.provider_config_id as string);
      }
      const contents = await this.contentLocations(client, committee.id, row.source_binding_id);
      const contentIds = new Set(contents.map(item => item.content_blob_id));
      for (const content of contents) {
        if (!content.source_blob_id) throw new AppError({code: 'SERVICE_NOT_READY', message: 'A source blob is unavailable.'});
        const existing = await client.query('SELECT 1 FROM storage_migration_items WHERE migration_id=$1 AND content_blob_id=$2',
          [row.id, content.content_blob_id]);
        if (!existing.rowCount) await this.insertItem(client, row.id, committee.id, content);
      }
      const obsolete = await client.query<{id: string; content_blob_id: string; status: ItemStatus}>(
        `SELECT id,content_blob_id,status FROM storage_migration_items WHERE migration_id=$1`, [row.id]);
      for (const item of obsolete.rows) {
        if (!contentIds.has(item.content_blob_id)) await this.cancelItemAndCopy(client, row, item.id, item.content_blob_id);
      }
      await client.query(`UPDATE storage_migration_items SET status='PENDING',next_attempt_at=now(),
        claimed_at=NULL,claim_token=NULL,completed_at=NULL,failure_code=NULL,failure_reason=NULL,updated_at=now()
        WHERE migration_id=$1 AND status='RETRY'`, [row.id]);
      const outstanding = await client.query(`SELECT 1 FROM storage_migration_items
        WHERE migration_id=$1 AND status IN ('PENDING','IN_PROGRESS','RETRY') LIMIT 1`, [row.id]);
      const next = outstanding.rowCount ? 'COPYING' : 'READY_TO_CONFIRM';
      await client.query(`UPDATE storage_migrations SET status=$2::storage_migration_status,manifest_revision=$3,revision=revision+1,
        ready_at=CASE WHEN $2::storage_migration_status='READY_TO_CONFIRM'::storage_migration_status THEN now() ELSE NULL END,
        failure_code=NULL,failure_reason=NULL,updated_at=now() WHERE id=$1`,
      [row.id, next, committee.file_manifest_revision]);
      await appendEvent(client, committee, {type: 'storage.migration_retried', resourceType: 'storage_migration',
        resourceId: row.id, revision: row.revision + 1, audience: 'CHAIR', payload: {status: next}});
      await this.commandAudit(client, context, auth, committee, row, 'storage.migration_retried', next);
    });
  }

  async confirm(auth: AuthenticatedSession, migrationId: string, body: unknown, idempotencyKey: string,
    context: Stage4Context): Promise<StorageMigration> {
    requireBusinessIdentity(auth);
    assertExactBody(body as Record<string, unknown>, ['baseRevision']);
    const id = uuid(migrationId, 'Storage migration ID');
    const baseRevision = revision((body as {baseRevision?: unknown}).baseRevision);
    const targets = await transaction(this.pool, async client => {
      const row = await this.migrationForUpdate(client, id);
      if (row.status === 'COMPLETED') return [];
      const committee = await lockedCommittee(client, row.committee_id);
      await this.requireOwnerOrChair(client, committee, auth.user.id);
      if (row.status !== 'READY_TO_CONFIRM' || row.revision !== baseRevision) return [];
      const result = await client.query<TargetVerificationRow>(`SELECT b.storage_key,b.size_bytes,
        encode(b.sha256,'hex') AS sha256_hex,binding.provider_type,binding.provider_config_id
        FROM storage_migration_items i JOIN file_blob_copies location
          ON location.content_blob_id=i.content_blob_id AND location.copy_blob_id=i.target_blob_id
        JOIN file_blobs b ON b.id=location.copy_blob_id
        JOIN storage_bindings binding ON binding.id=location.storage_binding_id
        WHERE i.migration_id=$1 AND i.status='COMPLETED' ORDER BY i.id`, [row.id]);
      return result.rows;
    });
    for (const target of targets) {
      try {
        await (await this.store(target.provider_type, target.provider_config_id, true))
          .verify(target.storage_key, Number(target.size_bytes), target.sha256_hex);
      } catch (error) {
        if (error instanceof ProviderStorageError) {
          throw new AppError({code: error.apiCode, message: error.message});
        }
        throw error;
      }
    }
    return this.command(auth, migrationId, body, idempotencyKey, 'confirm', context, async (client, committee, row) => {
      if (row.status !== 'READY_TO_CONFIRM' || row.manifest_revision !== committee.file_manifest_revision) {
        throw new AppError({code: 'REVISION_CONFLICT', message: 'The file manifest changed during storage migration.',
          details: {currentRevision: committee.file_manifest_revision}});
      }
      const source = await this.bindingForUpdate(client, row.source_binding_id);
      const target = await this.bindingForUpdate(client, row.target_binding_id);
      if (!source || !target || source.status !== 'ACTIVE' || target.status !== 'MIGRATING'
        || committee.active_storage_binding_id !== source.id) {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Storage bindings changed during migration.'});
      }
      if (target.provider_type === 'S3_COMPATIBLE') {
        await this.activeS3Config(client, target.provider_config_id as string);
      }
      const missing = await client.query(`SELECT 1 FROM (
          SELECT DISTINCT v.blob_id AS content_blob_id FROM file_versions v
          JOIN file_entries e ON e.id=v.file_entry_id WHERE e.committee_id=$1 AND e.status<>'DELETED'
        ) current_content LEFT JOIN storage_migration_items i
          ON i.migration_id=$2 AND i.content_blob_id=current_content.content_blob_id AND i.status='COMPLETED'
        LEFT JOIN file_blob_copies c ON c.content_blob_id=current_content.content_blob_id
          AND c.storage_binding_id=$3 AND c.copy_blob_id=i.target_blob_id
        WHERE i.id IS NULL OR c.copy_blob_id IS NULL LIMIT 1`, [committee.id, row.id, target.id]);
      if (missing.rowCount) {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Target storage is not fully verified.'});
      }
      await client.query("UPDATE storage_bindings SET status='RETIRED',revision=revision+1,updated_at=now() WHERE id=$1",
        [source.id]);
      await client.query("UPDATE storage_bindings SET status='ACTIVE',revision=revision+1,updated_at=now() WHERE id=$1",
        [target.id]);
      await client.query(`UPDATE committees SET active_storage_binding_id=$2,revision=revision+1,updated_at=now()
        WHERE id=$1`, [committee.id, target.id]);
      committee.revision += 1;
      await client.query(`UPDATE storage_migrations SET status='COMPLETED',completed_at=now(),revision=revision+1,
        failure_code=NULL,failure_reason=NULL,updated_at=now() WHERE id=$1`, [row.id]);
      await appendEvent(client, committee, {type: 'storage.migration_completed', resourceType: 'storage_migration',
        resourceId: row.id, revision: row.revision + 1, audience: 'CHAIR',
        payload: {sourceBindingId: source.id, targetBindingId: target.id}});
      await this.commandAudit(client, context, auth, committee, row, 'storage.migration_completed', 'COMPLETED');
    });
  }

  async cancel(auth: AuthenticatedSession, migrationId: string, body: unknown, idempotencyKey: string,
    context: Stage4Context): Promise<StorageMigration> {
    return this.command(auth, migrationId, body, idempotencyKey, 'cancel', context, async (client, committee, row) => {
      if (!['COPYING', 'READY_TO_CONFIRM', 'FAILED'].includes(row.status)) {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'This storage migration cannot be cancelled.'});
      }
      const items = await client.query<{id: string; content_blob_id: string}>(
        'SELECT id,content_blob_id FROM storage_migration_items WHERE migration_id=$1 FOR UPDATE', [row.id]);
      for (const item of items.rows) await this.cancelItemAndCopy(client, row, item.id, item.content_blob_id);
      await client.query("UPDATE storage_bindings SET status='RETIRED',revision=revision+1,updated_at=now() WHERE id=$1",
        [row.target_binding_id]);
      await client.query(`UPDATE storage_migrations SET status='CANCELLED',cancelled_at=now(),ready_at=NULL,
        revision=revision+1,failure_code=NULL,failure_reason=NULL,updated_at=now() WHERE id=$1`, [row.id]);
      await appendEvent(client, committee, {type: 'storage.migration_cancelled', resourceType: 'storage_migration',
        resourceId: row.id, revision: row.revision + 1, audience: 'CHAIR', payload: {status: 'CANCELLED'}});
      await this.commandAudit(client, context, auth, committee, row, 'storage.migration_cancelled', 'CANCELLED');
    });
  }

  async processNextCopyItem(): Promise<StorageMigrationItem | null> {
    try {
      await this.capacity?.assertWriteAllowed();
    } catch {
      return null;
    }
    const claimed = await transaction(this.pool, async client => {
      const result = await client.query<ItemRow>(`SELECT i.*,encode(i.sha256,'hex') AS sha256_hex,
        source.storage_key AS source_storage_key,source_binding.provider_type AS source_provider_type,
        source_binding.provider_config_id AS source_provider_config_id,
        target_binding.provider_type AS target_provider_type,target_binding.provider_config_id AS target_provider_config_id
        FROM storage_migration_items i JOIN storage_migrations m ON m.id=i.migration_id
        JOIN file_blobs source ON source.id=i.source_blob_id
        JOIN storage_bindings source_binding ON source_binding.id=source.storage_binding_id
        JOIN storage_bindings target_binding ON target_binding.id=m.target_binding_id
        WHERE m.status='COPYING' AND ((i.status IN ('PENDING','RETRY') AND i.next_attempt_at<=now())
          OR (i.status='IN_PROGRESS' AND (i.claimed_at IS NULL OR i.claimed_at<=now()-interval '5 minutes')))
        ORDER BY CASE WHEN i.status='IN_PROGRESS' THEN i.claimed_at ELSE i.next_attempt_at END,i.created_at,i.id
        FOR UPDATE OF i SKIP LOCKED LIMIT 1`);
      const row = result.rows[0];
      if (!row) return null;
      const token = randomUUID();
      await client.query(`UPDATE storage_migration_items SET status='IN_PROGRESS',attempts=attempts+1,
        claimed_at=now(),claim_token=$2,failure_code=NULL,failure_reason=NULL,updated_at=now() WHERE id=$1`,
      [row.id, token]);
      row.status = 'IN_PROGRESS'; row.attempts += 1; row.claim_token = token;
      return row;
    });
    if (!claimed) return null;
    try {
      const source = await this.store(claimed.source_provider_type, claimed.source_provider_config_id, false);
      const target = await this.store(claimed.target_provider_type, claimed.target_provider_config_id, true);
      const committed = await copyProviderBlob({staging: this.staging, stagingKey: claimed.staging_key,
        source, sourceStorageKey: claimed.source_storage_key, target, targetBlobId: claimed.target_blob_id,
        sizeBytes: Number(claimed.size_bytes), sha256: claimed.sha256_hex});
      return this.completeItem(claimed, committed.storageKey);
    } catch (error) {
      return this.failItem(claimed, error);
    }
  }

  private async completeItem(claimed: ItemRow, storageKey: string): Promise<StorageMigrationItem> {
    return transaction(this.pool, async client => {
      const item = await this.itemForUpdate(client, claimed.id);
      if (item.status !== 'IN_PROGRESS' || item.claim_token !== claimed.claim_token) {
        if (item.status === 'CANCELLED') await this.recordDiscardedTarget(client, claimed, storageKey);
        return mapItem(item);
      }
      const migration = await this.migrationForUpdate(client, claimed.migration_id);
      if (migration.status === 'CANCELLED') {
        await this.recordDiscardedTarget(client, claimed, storageKey);
        await client.query(`UPDATE storage_migration_items SET status='CANCELLED',claimed_at=NULL,claim_token=NULL,
          failure_code=NULL,failure_reason=NULL,updated_at=now() WHERE id=$1`, [item.id]);
        return mapItem({...item, status: 'CANCELLED', claim_token: null} as ItemRow);
      }
      await this.insertTargetCopy(client, migration, claimed, storageKey);
      const completed = await client.query<ItemRow>(`UPDATE storage_migration_items SET status='COMPLETED',
        completed_at=now(),claimed_at=NULL,claim_token=NULL,failure_code=NULL,failure_reason=NULL,updated_at=now()
        WHERE id=$1 AND status='IN_PROGRESS' AND claim_token=$2 RETURNING *,encode(sha256,'hex') AS sha256_hex`,
      [claimed.id, claimed.claim_token]);
      const outstanding = await client.query(`SELECT 1 FROM storage_migration_items WHERE migration_id=$1
        AND status IN ('PENDING','IN_PROGRESS','RETRY') LIMIT 1`, [migration.id]);
      if (!outstanding.rowCount && migration.status === 'COPYING') {
        const committee = await lockedCommittee(client, migration.committee_id);
        const manifestMatches = committee.file_manifest_revision === migration.manifest_revision;
        const next = manifestMatches ? 'READY_TO_CONFIRM' : 'FAILED';
        await client.query(`UPDATE storage_migrations SET status=$2::storage_migration_status,revision=revision+1,
          ready_at=CASE WHEN $2::storage_migration_status='READY_TO_CONFIRM'::storage_migration_status THEN now() ELSE NULL END,
          failure_code=CASE WHEN $2::storage_migration_status='FAILED'::storage_migration_status THEN 'MANIFEST_CHANGED' ELSE NULL END,
          failure_reason=CASE WHEN $2::storage_migration_status='FAILED'::storage_migration_status
            THEN 'The file manifest changed during copying.' ELSE NULL END,
          updated_at=now() WHERE id=$1`, [migration.id, next]);
        await appendEvent(client, committee, {type: manifestMatches ? 'storage.migration_ready' : 'storage.migration_failed',
          resourceType: 'storage_migration', resourceId: migration.id, revision: migration.revision + 1,
          audience: 'CHAIR', payload: {status: next}});
      }
      return mapItem(completed.rows[0] as ItemRow);
    });
  }

  private async failItem(claimed: ItemRow, error: unknown): Promise<StorageMigrationItem> {
    const failureCode = error instanceof ProviderStorageError || error instanceof UploadStreamError
      ? error.failureCode : 'PROVIDER_COPY_FAILED';
    const failureReason = error instanceof Error ? error.message.slice(0, 240) : 'Provider copy failed.';
    return transaction(this.pool, async client => {
      const failed = await client.query<ItemRow>(`UPDATE storage_migration_items SET status='RETRY',
        claimed_at=NULL,claim_token=NULL,failure_code=$2,failure_reason=$3,
        next_attempt_at=now()+(least(300,power(2,least(attempts,8)))::text||' seconds')::interval,updated_at=now()
        WHERE id=$1 AND status='IN_PROGRESS' AND claim_token=$4
        RETURNING *,encode(sha256,'hex') AS sha256_hex`,
      [claimed.id, failureCode.slice(0, 80), failureReason, claimed.claim_token]);
      if (!failed.rows[0]) return mapItem(await this.itemForUpdate(client, claimed.id));
      const migration = await this.migrationForUpdate(client, claimed.migration_id);
      if (migration.status === 'COPYING') {
        await client.query(`UPDATE storage_migrations SET status='FAILED',revision=revision+1,
          failure_code=$2,failure_reason=$3,updated_at=now() WHERE id=$1`,
        [migration.id, failureCode.slice(0, 80), failureReason]);
        const committee = await lockedCommittee(client, migration.committee_id);
        await appendEvent(client, committee, {type: 'storage.migration_failed', resourceType: 'storage_migration',
          resourceId: migration.id, revision: migration.revision + 1, audience: 'CHAIR',
          payload: {status: 'FAILED', failureCode: failureCode.slice(0, 80)}});
      }
      return mapItem(failed.rows[0]);
    });
  }

  private async command(auth: AuthenticatedSession, migrationId: string, body: unknown, key: string, command: string,
    context: Stage4Context, work: (client: PoolClient, committee: Stage4CommitteeRow,
      row: MigrationRow) => Promise<void>): Promise<StorageMigration> {
    requireBusinessIdentity(auth);
    assertExactBody(body as Record<string, unknown>, ['baseRevision']);
    const baseRevision = revision((body as {baseRevision?: unknown}).baseRevision);
    const id = uuid(migrationId, 'Storage migration ID');
    return idempotentTransaction({pool: this.pool, auth, route: `/api/v1/storage-migrations/${id}/${command}`,
      key, request: body, status: 200, work: async client => {
        const row = await this.migrationForUpdate(client, id);
        const committee = await lockedCommittee(client, row.committee_id);
        requireProceedingsActive(committee);
        await this.requireOwnerOrChair(client, committee, auth.user.id);
        if (row.revision !== baseRevision) {
          throw new AppError({code: 'REVISION_CONFLICT', message: 'This storage migration changed since it was loaded.',
            details: {currentRevision: row.revision}});
        }
        await work(client, committee, row);
        return this.migration(client, id);
      }});
  }

  private async contentLocations(client: PoolClient, committeeId: string, sourceBindingId: string): Promise<ContentLocationRow[]> {
    const result = await client.query<ContentLocationRow>(`SELECT content.id AS content_blob_id,
      CASE WHEN content.storage_binding_id=$2 THEN content.id ELSE copies.copy_blob_id END AS source_blob_id,
      content.size_bytes,encode(content.sha256,'hex') AS sha256_hex
      FROM (SELECT DISTINCT v.blob_id FROM file_versions v JOIN file_entries e ON e.id=v.file_entry_id
        WHERE e.committee_id=$1 AND e.status<>'DELETED') versions
      JOIN file_blobs content ON content.id=versions.blob_id
      LEFT JOIN file_blob_copies copies ON copies.content_blob_id=content.id AND copies.storage_binding_id=$2
      ORDER BY content.id`, [committeeId, sourceBindingId]);
    return result.rows;
  }

  private async insertItem(client: PoolClient, migrationId: string, committeeId: string,
    content: ContentLocationRow): Promise<void> {
    const id = randomUUID();
    await client.query(`INSERT INTO storage_migration_items
      (id,migration_id,committee_id,content_blob_id,source_blob_id,target_blob_id,staging_key,size_bytes,sha256)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,decode($9,'hex'))`,
    [id, migrationId, committeeId, content.content_blob_id, content.source_blob_id, randomUUID(), stagingKey(id),
      Number(content.size_bytes), content.sha256_hex]);
  }

  private async insertTargetCopy(client: PoolClient, migration: MigrationRow, item: ItemRow,
    storageKey: string): Promise<void> {
    await client.query(`INSERT INTO file_blobs
      (id,committee_id,storage_binding_id,storage_key,size_bytes,sha256,durability_state)
      VALUES ($1,$2,$3,$4,$5,decode($6,'hex'),'COMMITTED') ON CONFLICT (id) DO NOTHING`,
    [item.target_blob_id, item.committee_id, migration.target_binding_id, storageKey,
      Number(item.size_bytes), item.sha256_hex]);
    const blob = await client.query<{storage_binding_id: string; storage_key: string; size_bytes: string | number;
      sha256_hex: string; durability_state: string}>(`SELECT storage_binding_id,storage_key,size_bytes,
      encode(sha256,'hex') AS sha256_hex,durability_state FROM file_blobs WHERE id=$1`, [item.target_blob_id]);
    const stored = blob.rows[0];
    if (!stored || stored.storage_binding_id !== migration.target_binding_id || stored.storage_key !== storageKey
      || Number(stored.size_bytes) !== Number(item.size_bytes) || stored.sha256_hex !== item.sha256_hex
      || stored.durability_state !== 'COMMITTED') {
      throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Target blob metadata conflicts with this copy.'});
    }
    await client.query(`INSERT INTO file_blob_copies
      (committee_id,content_blob_id,copy_blob_id,storage_binding_id,migration_id)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (content_blob_id,storage_binding_id) DO NOTHING`,
    [item.committee_id, item.content_blob_id, item.target_blob_id, migration.target_binding_id, migration.id]);
    const copy = await client.query<{copy_blob_id: string}>(`SELECT copy_blob_id FROM file_blob_copies
      WHERE content_blob_id=$1 AND storage_binding_id=$2`, [item.content_blob_id, migration.target_binding_id]);
    if (copy.rows[0]?.copy_blob_id !== item.target_blob_id) {
      throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Target blob copy conflicts with this migration.'});
    }
  }

  private async recordDiscardedTarget(client: PoolClient, item: ItemRow, storageKey: string): Promise<void> {
    const migration = await this.migrationForUpdate(client, item.migration_id);
    await client.query(`INSERT INTO file_blobs
      (id,committee_id,storage_binding_id,storage_key,size_bytes,sha256,durability_state)
      VALUES ($1,$2,$3,$4,$5,decode($6,'hex'),'DELETE_PENDING') ON CONFLICT (id) DO NOTHING`,
    [item.target_blob_id, item.committee_id, migration.target_binding_id, storageKey,
      Number(item.size_bytes), item.sha256_hex]);
    await client.query("UPDATE file_blobs SET durability_state='DELETE_PENDING',updated_at=now() WHERE id=$1",
      [item.target_blob_id]);
    await this.scheduleBlobDelete(client, item.committee_id, item.content_blob_id, item.target_blob_id);
  }

  private async cancelItemAndCopy(client: PoolClient, migration: MigrationRow, itemId: string,
    contentBlobId: string): Promise<void> {
    const copy = await client.query<{copy_blob_id: string}>(`DELETE FROM file_blob_copies
      WHERE content_blob_id=$1 AND storage_binding_id=$2 RETURNING copy_blob_id`,
    [contentBlobId, migration.target_binding_id]);
    if (copy.rows[0]) {
      await client.query("UPDATE file_blobs SET durability_state='DELETE_PENDING',updated_at=now() WHERE id=$1",
        [copy.rows[0].copy_blob_id]);
      await this.scheduleBlobDelete(client, migration.committee_id, contentBlobId, copy.rows[0].copy_blob_id);
    }
    await client.query(`UPDATE storage_migration_items SET status='CANCELLED',claimed_at=NULL,claim_token=NULL,
      completed_at=NULL,failure_code=NULL,failure_reason=NULL,updated_at=now() WHERE id=$1`, [itemId]);
  }

  private async scheduleBlobDelete(client: PoolClient, committeeId: string, contentBlobId: string,
    blobId: string): Promise<void> {
    const entry = await client.query<{file_entry_id: string}>(
      'SELECT file_entry_id FROM file_versions WHERE blob_id=$1 ORDER BY created_at,id LIMIT 1', [contentBlobId]);
    if (!entry.rows[0]) throw new AppError({code: 'INTERNAL_ERROR', message: 'Blob owner is unavailable.'});
    await client.query(`INSERT INTO file_blob_delete_jobs (id,committee_id,file_entry_id,blob_id)
      VALUES ($1,$2,$3,$4) ON CONFLICT (blob_id) DO NOTHING`,
    [randomUUID(), committeeId, entry.rows[0].file_entry_id, blobId]);
  }

  private async validateTarget(client: PoolClient, source: BindingRow, targetType: ProviderType,
    targetConfigId: string | null): Promise<void> {
    if (targetType === 'S3_COMPATIBLE') await this.activeS3Config(client, targetConfigId as string);
    if (source.provider_type === targetType && source.provider_config_id === targetConfigId) {
      throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The target provider is already active.'});
    }
  }

  private async activeS3Config(client: PoolClient, id: string): Promise<void> {
    const result = await client.query(`SELECT 1 FROM storage_provider_configs
      WHERE id=$1 AND provider_type='S3_COMPATIBLE' AND status='ACTIVE'
        AND verified_revision=revision AND verified_at IS NOT NULL FOR SHARE`, [id]);
    if (!result.rowCount) throw new AppError({code: 'NOT_FOUND', message: 'S3 provider config not found.'});
  }

  private async store(type: ProviderType, configId: string | null, target: boolean): Promise<ProviderStore> {
    if (type === 'SERVER_VOLUME') return this.serverVolume;
    if (!configId) throw new AppError({code: 'SERVICE_NOT_READY', message: 'S3 provider config is unavailable.'});
    const config = target ? await this.s3Configs.providerForMigrationTarget(configId)
      : await this.s3Configs.providerForStoredBlob(configId);
    return this.s3Factory(config);
  }

  private async requireOwnerOrChair(client: PoolClient, committee: Stage4CommitteeRow, userId: string): Promise<void> {
    if (committee.owner_user_id !== userId && !(await isChair(client, committee.id, userId))) {
      throw new AppError({code: 'FORBIDDEN', message: 'Chair or committee owner access is required.'});
    }
  }

  private async commandAudit(client: PoolClient, context: Stage4Context, auth: AuthenticatedSession,
    committee: Stage4CommitteeRow, migration: MigrationRow, action: string, status: string): Promise<void> {
    await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
      capabilities: await isChair(client, committee.id, auth.user.id) ? ['CHAIR'] : ['OWNER'], action,
      resourceType: 'storage_migration', resourceId: migration.id,
      before: {status: migration.status, revision: migration.revision},
      after: {status, revision: migration.revision + 1}});
  }

  private async bindingForUpdate(client: PoolClient, id: string | null): Promise<BindingRow | undefined> {
    if (!id) return undefined;
    return (await client.query<BindingRow>('SELECT * FROM storage_bindings WHERE id=$1 FOR UPDATE', [id])).rows[0];
  }

  private async migration(client: PoolClient, id: string): Promise<StorageMigration> {
    const row = (await client.query<MigrationRow>(`${MIGRATION_SELECT} WHERE m.id=$1`, [id])).rows[0];
    if (!row) throw new AppError({code: 'NOT_FOUND', message: 'Storage migration not found.'});
    return mapMigration(row);
  }

  private async migrationForUpdate(client: PoolClient, id: string): Promise<MigrationRow> {
    const row = (await client.query<MigrationRow>(`SELECT *,0::int AS total_items,0::int AS completed_items
      FROM storage_migrations WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!row) throw new AppError({code: 'NOT_FOUND', message: 'Storage migration not found.'});
    return row;
  }

  private async itemForUpdate(client: PoolClient, id: string): Promise<ItemRow> {
    const row = (await client.query<ItemRow>(`SELECT *,encode(sha256,'hex') AS sha256_hex,
      ''::text AS source_storage_key,'SERVER_VOLUME'::storage_provider_type AS source_provider_type,
      NULL::uuid AS source_provider_config_id,'SERVER_VOLUME'::storage_provider_type AS target_provider_type,
      NULL::uuid AS target_provider_config_id FROM storage_migration_items WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!row) throw new AppError({code: 'INTERNAL_ERROR', message: 'Storage migration item is unavailable.'});
    return row;
  }
}

export function startStorageMigrationWorker(service: Pick<Stage6MigrationService, 'processNextCopyItem'>,
  logger: Logger, intervalMs = 1_000): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => void run(), intervalMs);
    timer.unref();
  };
  const run = async () => {
    if (stopped) return;
    try {
      while (!stopped && await service.processNextCopyItem()) {
        // Drain ready copy work serially; PostgreSQL claims allow multiple instances to cooperate safely.
      }
    } catch (error) {
      logger.error('storage.migration_worker.failed', {error});
    } finally {
      schedule();
    }
  };
  void run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
