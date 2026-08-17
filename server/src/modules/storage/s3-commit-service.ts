import {randomUUID} from 'node:crypto';
import type {Pool, PoolClient, QueryResultRow} from 'pg';
import type {FileEntry} from '@quorum/contracts';
import {AppError} from '../../http/errors.js';
import type {AuthenticatedSession} from '../identity/store.js';
import {appendEvent, audit, idempotencyLockKey, idempotentTransaction, isChair, lockedCommittee, requestHash,
  requireBusinessIdentity, requireProceedingsActive, transaction, type Stage4Context} from '../stage4/database.js';
import {assertExactBody} from '../stage4/validation.js';
import type {Stage6S3ConfigService} from './s3-config-service.js';
import {S3CompatibleStore, type S3ProviderConfig} from './s3-store.js';
import {s3ObjectKey} from './s3-endpoint.js';
import {Stage6StorageService} from './service.js';
import type {DurableStagingStore} from './staging.js';
import {ProviderStorageError} from './server-volume.js';

interface S3UploadRow extends QueryResultRow {
  id: string;
  committee_id: string;
  storage_binding_id: string;
  created_by_user_id: string;
  logical_name: string;
  original_name: string;
  media_type: string;
  expected_size_bytes: string | number;
  received_size_bytes: string | number;
  expected_sha256_hex: string;
  actual_sha256_hex: string | null;
  staging_key: string;
  status: 'CREATED' | 'RECEIVING' | 'STAGED' | 'COMMITTED' | 'CANCELLED' | 'FAILED';
  revision: number;
  provider_blob_id: string | null;
  provider_storage_key: string | null;
}

interface S3BindingRow extends QueryResultRow {
  id: string;
  provider_config_id: string;
  key_prefix: string;
}

type Claim = {kind: 'COMMIT'; upload: S3UploadRow; providerConfigId: string}
  | {kind: 'REPLAY'; file: FileEntry};

export type S3StoreFactory = (config: S3ProviderConfig) => S3CompatibleStore;

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError({code: 'VALIDATION_FAILED', message: `${name} is invalid.`});
  }
  return value;
}

function validateKey(key: string): void {
  if (!key || key.length > 200) throw new AppError({code: 'BAD_REQUEST', message: 'Idempotency-Key is required.'});
}

async function uploadForUpdate(client: PoolClient, uploadId: string): Promise<S3UploadRow> {
  const result = await client.query<S3UploadRow>(`SELECT *,encode(expected_sha256,'hex') AS expected_sha256_hex,
    CASE WHEN actual_sha256 IS NULL THEN NULL ELSE encode(actual_sha256,'hex') END AS actual_sha256_hex
    FROM file_uploads WHERE id=$1 FOR UPDATE`, [uploadId]);
  if (!result.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Upload not found.'});
  return result.rows[0];
}

async function requireContributor(client: PoolClient, committee: {id: string; owner_user_id: string},
  userId: string): Promise<void> {
  if (committee.owner_user_id === userId || await isChair(client, committee.id, userId)) return;
  const membership = await client.query(`SELECT 1 FROM committee_memberships
    WHERE committee_id=$1 AND user_id=$2 AND status='ACTIVE'`, [committee.id, userId]);
  if (!membership.rowCount) throw new AppError({code: 'FORBIDDEN', message: 'Committee membership is required.'});
}

export class Stage6S3CommitService {
  constructor(private readonly pool: Pool, private readonly metadata: Stage6StorageService,
    private readonly staging: DurableStagingStore, private readonly configs: Stage6S3ConfigService,
    private readonly storeFactory: S3StoreFactory) {}

  async commitUpload(auth: AuthenticatedSession, uploadId: string, body: unknown,
    idempotencyKey: string, context: Stage4Context): Promise<FileEntry> {
    requireBusinessIdentity(auth);
    assertExactBody(body as Record<string, unknown>, []);
    validateKey(idempotencyKey);
    const id = uuid(uploadId, 'Upload ID');
    const claim = await this.claim(auth, id, idempotencyKey);
    if (claim.kind === 'REPLAY') return claim.file;
    const providerConfig = await this.configs.providerForBinding(claim.providerConfigId);
    const store = this.storeFactory(providerConfig);
    let provider: {storageKey: string; sizeBytes: number; sha256: string};
    try {
      provider = await store.commitFromStaging({blobId: claim.upload.provider_blob_id as string,
        staging: this.staging, stagingKey: claim.upload.staging_key,
        expectedSizeBytes: Number(claim.upload.expected_size_bytes),
        expectedSha256: claim.upload.expected_sha256_hex});
    } catch (error) {
      if (error instanceof ProviderStorageError) throw new AppError({code: error.apiCode, message: error.message});
      throw error;
    }
    return idempotentTransaction({pool: this.pool, auth, route: `/api/v1/file-uploads/${id}/commit`,
      key: idempotencyKey, request: body, status: 201, work: async client => {
        const current = await uploadForUpdate(client, id);
        const committee = await lockedCommittee(client, current.committee_id);
        requireProceedingsActive(committee);
        if (current.created_by_user_id !== auth.user.id) {
          throw new AppError({code: 'FORBIDDEN', message: 'Only the upload creator may commit it.'});
        }
        await requireContributor(client, committee, auth.user.id);
        if (current.status !== 'STAGED' || current.provider_blob_id !== claim.upload.provider_blob_id
          || current.provider_storage_key !== provider.storageKey
          || current.actual_sha256_hex !== current.expected_sha256_hex
          || Number(current.received_size_bytes) !== Number(current.expected_size_bytes)) {
          throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Upload is not ready for provider commit.'});
        }
        const binding = await this.requireS3Binding(client, current, committee.active_storage_binding_id);
        if (binding.provider_config_id !== claim.providerConfigId) {
          throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The S3 provider config changed.'});
        }
        const file = await this.metadata.recordProviderCommitInTransaction(client, auth, committee.id, {
          bindingId: current.storage_binding_id, blobId: current.provider_blob_id as string,
          logicalName: current.logical_name, originalName: current.original_name, mediaType: current.media_type,
          sizeBytes: provider.sizeBytes, sha256: provider.sha256, storageKey: provider.storageKey
        }, context);
        const committed = await client.query<{revision: number}>(`UPDATE file_uploads SET status='COMMITTED',
          committed_at=now(),committed_blob_id=$2,committed_file_entry_id=$3,committed_file_version_id=$4,
          revision=revision+1,updated_at=now() WHERE id=$1 RETURNING revision`,
        [current.id, current.provider_blob_id, file.id, file.currentVersion.id]);
        const revision = committed.rows[0]?.revision ?? current.revision + 1;
        const eventCommittee = await lockedCommittee(client, committee.id);
        await appendEvent(client, eventCommittee, {type: 'file.upload_committed', resourceType: 'file_upload',
          resourceId: current.id, revision,
          payload: {status: 'COMMITTED', providerType: 'S3_COMPATIBLE', fileEntryId: file.id,
            versionId: file.currentVersion.id}});
        await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
          capabilities: await isChair(client, committee.id, auth.user.id) ? ['CHAIR'] : ['MEMBER'],
          action: 'storage.upload_committed', resourceType: 'file_upload', resourceId: current.id,
          before: {status: 'STAGED', revision: current.revision},
          after: {status: 'COMMITTED', revision, providerType: 'S3_COMPATIBLE', fileEntryId: file.id,
            versionId: file.currentVersion.id, blobId: current.provider_blob_id}});
        return file;
      }});
  }

  private async claim(auth: AuthenticatedSession, uploadId: string, key: string): Promise<Claim> {
    const route = `/api/v1/file-uploads/${uploadId}/commit`;
    return transaction(this.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [idempotencyLockKey(auth.user.id, route, key)]);
      const existing = await client.query<{request_hash: Buffer; response_body: FileEntry}>(`SELECT request_hash,response_body
        FROM idempotency_keys WHERE user_id=$1 AND route=$2 AND key=$3`, [auth.user.id, route, key]);
      if (existing.rows[0]) {
        if (!existing.rows[0].request_hash.equals(requestHash({}))) {
          throw new AppError({code: 'IDEMPOTENCY_CONFLICT', message: 'Idempotency key was already used for another request.'});
        }
        return {kind: 'REPLAY', file: existing.rows[0].response_body};
      }
      let upload = await uploadForUpdate(client, uploadId);
      const committee = await lockedCommittee(client, upload.committee_id);
      requireProceedingsActive(committee);
      if (upload.created_by_user_id !== auth.user.id) {
        throw new AppError({code: 'FORBIDDEN', message: 'Only the upload creator may commit it.'});
      }
      await requireContributor(client, committee, auth.user.id);
      if (upload.status !== 'STAGED' || upload.actual_sha256_hex !== upload.expected_sha256_hex
        || Number(upload.received_size_bytes) !== Number(upload.expected_size_bytes)) {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Upload is not ready for provider commit.'});
      }
      const binding = await this.requireS3Binding(client, upload, committee.active_storage_binding_id);
      if (!upload.provider_blob_id) {
        const blobId = randomUUID();
        const storageKey = s3ObjectKey(binding.key_prefix, blobId);
        const claimed = await client.query<S3UploadRow>(`UPDATE file_uploads SET provider_blob_id=$2,
          provider_storage_key=$3,revision=revision+1,updated_at=now() WHERE id=$1
          RETURNING *,encode(expected_sha256,'hex') AS expected_sha256_hex,
            CASE WHEN actual_sha256 IS NULL THEN NULL ELSE encode(actual_sha256,'hex') END AS actual_sha256_hex`,
        [upload.id, blobId, storageKey]);
        upload = claimed.rows[0] as S3UploadRow;
      } else if (upload.provider_storage_key !== s3ObjectKey(binding.key_prefix, upload.provider_blob_id)) {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Upload provider target is invalid.'});
      }
      return {kind: 'COMMIT', upload, providerConfigId: binding.provider_config_id};
    });
  }

  private async requireS3Binding(client: PoolClient, upload: S3UploadRow,
    activeBindingId: string | null): Promise<S3BindingRow> {
    const result = await client.query<S3BindingRow>(`SELECT b.id,b.provider_config_id,c.key_prefix
      FROM storage_bindings b JOIN storage_provider_configs c ON c.id=b.provider_config_id
      WHERE b.id=$1 AND b.committee_id=$2 AND b.status='ACTIVE' AND b.provider_type='S3_COMPATIBLE'
        AND c.status='ACTIVE' FOR SHARE OF b,c`, [upload.storage_binding_id, upload.committee_id]);
    if (!result.rows[0] || result.rows[0].id !== activeBindingId) {
      throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The active storage provider is not S3 compatible.'});
    }
    return result.rows[0];
  }
}
