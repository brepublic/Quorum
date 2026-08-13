import {randomUUID} from 'node:crypto';
import type {Pool, PoolClient, QueryResultRow} from 'pg';
import {ERROR_HTTP_STATUS, type ApiErrorCode, type FileUpload, type FileUploadStatus} from '@quorum/contracts';
import {AppError} from '../../http/errors.js';
import type {AuthenticatedSession} from '../identity/store.js';
import {
  appendEvent,
  audit,
  idempotentTransaction,
  isChair,
  lockedCommittee,
  requestHash,
  requireBusinessIdentity,
  requireProceedingsActive,
  transaction,
  type Stage4Context,
  type Stage4CommitteeRow
} from '../stage4/database.js';
import {assertExactBody} from '../stage4/validation.js';
import {normalizeSha256} from './service.js';
import {DurableStagingStore, UploadStreamError} from './staging.js';

interface UploadRow extends QueryResultRow {
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
  status: FileUploadStatus;
  revision: number;
  content_idempotency_key: string | null;
  expires_at: Date;
  failure_code: string | null;
  committed_file_entry_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ActiveBindingRow extends QueryResultRow {
  id: string;
}

interface StoredAttempt {
  ok: boolean;
  upload?: FileUpload;
  code?: ApiErrorCode;
  message?: string;
}

type Claim = {kind: 'WRITE' | 'RECOVER'; upload: UploadRow} | {kind: 'REPLAY'; attempt: StoredAttempt};

export interface CreateUploadInput {
  logicalName: string;
  originalName: string;
  mediaType: string;
  expectedSizeBytes: number;
  sha256: string;
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError({code: 'VALIDATION_FAILED', message: `${name} is invalid.`});
  }
  return value;
}

function boundedText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new AppError({code: 'VALIDATION_FAILED', message: `${name} is invalid.`});
  }
  return value.trim();
}

function byteCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'File size is invalid.'});
  }
  return Number(value);
}

function uploadState(row: UploadRow): FileUpload {
  return {
    id: row.id,
    committeeId: row.committee_id,
    storageBindingId: row.storage_binding_id,
    logicalName: row.logical_name,
    originalName: row.original_name,
    mediaType: row.media_type,
    expectedSizeBytes: Number(row.expected_size_bytes),
    receivedSizeBytes: Number(row.received_size_bytes),
    expectedSha256: row.expected_sha256_hex,
    actualSha256: row.actual_sha256_hex,
    status: row.status,
    revision: row.revision,
    expiresAt: row.expires_at.toISOString(),
    failureCode: row.failure_code,
    committedFileEntryId: row.committed_file_entry_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function stagingKey(uploadId: string): string {
  const compact = uploadId.replaceAll('-', '');
  return `uploads/${compact.slice(0, 2)}/${compact}`;
}

async function requireContributor(client: PoolClient, committee: Stage4CommitteeRow, userId: string): Promise<void> {
  if (committee.owner_user_id === userId || await isChair(client, committee.id, userId)) return;
  const membership = await client.query(`SELECT 1 FROM committee_memberships
    WHERE committee_id=$1 AND user_id=$2 AND status='ACTIVE'`, [committee.id, userId]);
  if (!membership.rowCount) {
    throw new AppError({code: 'FORBIDDEN', message: 'Committee membership is required.'});
  }
}

async function uploadForUpdate(client: PoolClient, uploadId: string): Promise<UploadRow> {
  const result = await client.query<UploadRow>(`SELECT *,encode(expected_sha256,'hex') AS expected_sha256_hex,
    CASE WHEN actual_sha256 IS NULL THEN NULL ELSE encode(actual_sha256,'hex') END AS actual_sha256_hex
    FROM file_uploads WHERE id=$1 FOR UPDATE`, [uploadId]);
  const row = result.rows[0];
  if (!row) throw new AppError({code: 'NOT_FOUND', message: 'Upload not found.'});
  return row;
}

function validateIdempotencyKey(key: string): void {
  if (!key || key.length > 200) {
    throw new AppError({code: 'BAD_REQUEST', message: 'Idempotency-Key is required.'});
  }
}

function replay(attempt: StoredAttempt): FileUpload {
  if (attempt.ok && attempt.upload) return attempt.upload;
  throw new AppError({
    code: attempt.code ?? 'INTERNAL_ERROR',
    message: attempt.message ?? 'The server could not complete the request.'
  });
}

export function isUploadCleanupEligible(status: FileUploadStatus, expiresAt: Date, now = new Date()): boolean {
  if (status === 'COMMITTED' || status === 'CANCELLED') return true;
  return status === 'FAILED' && expiresAt.getTime() <= now.getTime();
}

export class Stage6UploadService {
  constructor(
    private readonly pool: Pool,
    readonly staging: DurableStagingStore,
    private readonly uploadTtlMs = 24 * 60 * 60 * 1000,
    private readonly now: () => Date = () => new Date()
  ) {}

  async createUpload(auth: AuthenticatedSession, committeeId: string, body: unknown,
    idempotencyKey: string, context: Stage4Context): Promise<FileUpload> {
    requireBusinessIdentity(auth);
    assertExactBody(body as Record<string, unknown>,
      ['logicalName', 'originalName', 'mediaType', 'expectedSizeBytes', 'sha256']);
    const input = body as unknown as CreateUploadInput;
    const logicalName = boundedText(input.logicalName, 'Logical name', 500);
    const originalName = boundedText(input.originalName, 'Original name', 500);
    const mediaType = boundedText(input.mediaType, 'Media type', 255).toLowerCase();
    const expectedSizeBytes = byteCount(input.expectedSizeBytes);
    if (expectedSizeBytes > this.staging.maxFileBytes || expectedSizeBytes > this.staging.maxRequestBytes) {
      throw new AppError({code: 'PAYLOAD_TOO_LARGE', message: 'Upload exceeds the configured limit.'});
    }
    const expectedSha256 = normalizeSha256(input.sha256);
    return idempotentTransaction({
      pool: this.pool,
      auth,
      route: `/api/v1/committees/${committeeId}/file-uploads`,
      key: idempotencyKey,
      request: body,
      status: 201,
      work: async client => {
        const committee = await lockedCommittee(client, uuid(committeeId, 'Committee ID'));
        requireProceedingsActive(committee);
        await requireContributor(client, committee, auth.user.id);
        const activeBinding = await client.query<ActiveBindingRow>(`SELECT id FROM storage_bindings
          WHERE committee_id=$1 AND id=$2 AND status='ACTIVE' FOR SHARE`,
        [committee.id, committee.active_storage_binding_id]);
        if (!activeBinding.rows[0]) {
          throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The committee has no active storage.'});
        }
        const id = randomUUID();
        const expiresAt = new Date(this.now().getTime() + this.uploadTtlMs);
        const created = await client.query<UploadRow>(`INSERT INTO file_uploads
          (id,committee_id,storage_binding_id,created_by_user_id,logical_name,original_name,media_type,
           expected_size_bytes,expected_sha256,staging_key,expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,decode($9,'hex'),$10,$11)
          RETURNING *,encode(expected_sha256,'hex') AS expected_sha256_hex,
            CASE WHEN actual_sha256 IS NULL THEN NULL ELSE encode(actual_sha256,'hex') END AS actual_sha256_hex`,
        [id, committee.id, activeBinding.rows[0].id, auth.user.id, logicalName, originalName, mediaType,
          expectedSizeBytes, expectedSha256, stagingKey(id), expiresAt]);
        const row = created.rows[0] as UploadRow;
        await appendEvent(client, committee, {type: 'file.upload_created', resourceType: 'file_upload',
          resourceId: id, revision: row.revision, payload: {status: 'CREATED', expectedSizeBytes}});
        await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
          capabilities: await isChair(client, committee.id, auth.user.id) ? ['CHAIR'] : ['MEMBER'],
          action: 'storage.upload_created', resourceType: 'file_upload', resourceId: id,
          after: {status: 'CREATED', expectedSizeBytes, sha256: expectedSha256}});
        return uploadState(row);
      }
    });
  }

  async receiveContent(auth: AuthenticatedSession, uploadId: string,
    source: AsyncIterable<Uint8Array | string>, idempotencyKey: string,
    contentLength: number | undefined, context: Stage4Context): Promise<FileUpload> {
    requireBusinessIdentity(auth);
    validateIdempotencyKey(idempotencyKey);
    const id = uuid(uploadId, 'Upload ID');
    const claim = await this.claim(auth, id, idempotencyKey);
    if (claim.kind === 'REPLAY') return replay(claim.attempt);
    try {
      const content = claim.kind === 'RECOVER'
        ? await this.staging.verify(claim.upload.staging_key, Number(claim.upload.expected_size_bytes),
          claim.upload.expected_sha256_hex)
        : await this.staging.write({
          key: claim.upload.staging_key,
          source,
          expectedSizeBytes: Number(claim.upload.expected_size_bytes),
          expectedSha256: claim.upload.expected_sha256_hex,
          contentLength
        });
      return await this.complete(auth, claim.upload, idempotencyKey, content, context);
    } catch (error) {
      if (!(error instanceof UploadStreamError)) throw error;
      await this.fail(auth, claim.upload, idempotencyKey, error, context);
      throw new AppError({code: error.apiCode, message: error.message});
    }
  }

  private async claim(auth: AuthenticatedSession, uploadId: string, key: string): Promise<Claim> {
    const route = `/api/v1/file-uploads/${uploadId}/content`;
    const hash = requestHash({uploadId});
    return transaction(this.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`${auth.user.id}\0${route}\0${key}`]);
      const existing = await client.query<{request_hash: Buffer; response_body: StoredAttempt}>(`SELECT request_hash,response_body
        FROM idempotency_keys WHERE user_id=$1 AND route=$2 AND key=$3`, [auth.user.id, route, key]);
      if (existing.rows[0]) {
        if (!existing.rows[0].request_hash.equals(hash)) {
          throw new AppError({code: 'IDEMPOTENCY_CONFLICT', message: 'Idempotency key was already used for another request.'});
        }
        return {kind: 'REPLAY', attempt: existing.rows[0].response_body};
      }
      const upload = await uploadForUpdate(client, uploadId);
      const committee = await lockedCommittee(client, upload.committee_id);
      requireProceedingsActive(committee);
      if (upload.created_by_user_id !== auth.user.id) {
        throw new AppError({code: 'FORBIDDEN', message: 'Only the upload creator may send its content.'});
      }
      if (upload.status === 'RECEIVING' && upload.content_idempotency_key === key
        && await this.staging.exists(upload.staging_key)) {
        return {kind: 'RECOVER', upload};
      }
      if (upload.status !== 'CREATED') {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Upload content is not expected in its current state.'});
      }
      const claimed = await client.query<UploadRow>(`UPDATE file_uploads SET status='RECEIVING',revision=revision+1,
        content_idempotency_key=$2,receiving_started_at=now(),updated_at=now()
        WHERE id=$1 RETURNING *,encode(expected_sha256,'hex') AS expected_sha256_hex,
          CASE WHEN actual_sha256 IS NULL THEN NULL ELSE encode(actual_sha256,'hex') END AS actual_sha256_hex`,
      [upload.id, key]);
      return {kind: 'WRITE', upload: claimed.rows[0] as UploadRow};
    });
  }

  private async complete(auth: AuthenticatedSession, claimed: UploadRow, key: string,
    content: {sizeBytes: number; sha256: string}, context: Stage4Context): Promise<FileUpload> {
    const route = `/api/v1/file-uploads/${claimed.id}/content`;
    const hash = requestHash({uploadId: claimed.id});
    return transaction(this.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`${auth.user.id}\0${route}\0${key}`]);
      const upload = await uploadForUpdate(client, claimed.id);
      const committee = await lockedCommittee(client, upload.committee_id);
      requireProceedingsActive(committee);
      if (upload.created_by_user_id !== auth.user.id || upload.status !== 'RECEIVING'
        || upload.content_idempotency_key !== key) {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Upload content is not expected in its current state.'});
      }
      const completed = await client.query<UploadRow>(`UPDATE file_uploads SET status='STAGED',
        received_size_bytes=$2,actual_sha256=decode($3,'hex'),staged_at=now(),revision=revision+1,updated_at=now()
        WHERE id=$1 RETURNING *,encode(expected_sha256,'hex') AS expected_sha256_hex,
          encode(actual_sha256,'hex') AS actual_sha256_hex`, [upload.id, content.sizeBytes, content.sha256]);
      const row = completed.rows[0] as UploadRow;
      const state = uploadState(row);
      await appendEvent(client, committee, {type: 'file.upload_staged', resourceType: 'file_upload',
        resourceId: upload.id, revision: row.revision,
        payload: {status: 'STAGED', sizeBytes: content.sizeBytes}});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
        capabilities: await isChair(client, committee.id, auth.user.id) ? ['CHAIR'] : ['MEMBER'],
        action: 'storage.upload_staged', resourceType: 'file_upload', resourceId: upload.id,
        before: {status: 'RECEIVING', revision: upload.revision},
        after: {status: 'STAGED', revision: row.revision, sizeBytes: content.sizeBytes, sha256: content.sha256}});
      const attempt: StoredAttempt = {ok: true, upload: state};
      await client.query(`INSERT INTO idempotency_keys
        (user_id,route,key,request_hash,response_status,response_body,expires_at)
        VALUES ($1,$2,$3,$4,200,$5,now()+interval '24 hours')`,
      [auth.user.id, route, key, hash, attempt]);
      return state;
    });
  }

  private async fail(auth: AuthenticatedSession, claimed: UploadRow, key: string,
    failure: UploadStreamError, context: Stage4Context): Promise<void> {
    const route = `/api/v1/file-uploads/${claimed.id}/content`;
    const hash = requestHash({uploadId: claimed.id});
    await transaction(this.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`${auth.user.id}\0${route}\0${key}`]);
      const upload = await uploadForUpdate(client, claimed.id);
      const committee = await lockedCommittee(client, upload.committee_id);
      if (upload.created_by_user_id !== auth.user.id || upload.status !== 'RECEIVING'
        || upload.content_idempotency_key !== key) {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Upload content is not expected in its current state.'});
      }
      const failed = await client.query<UploadRow>(`UPDATE file_uploads SET status='FAILED',
        received_size_bytes=$2,failure_code=$3,failure_reason=$4,failed_at=now(),revision=revision+1,updated_at=now()
        WHERE id=$1 RETURNING *,encode(expected_sha256,'hex') AS expected_sha256_hex,
          CASE WHEN actual_sha256 IS NULL THEN NULL ELSE encode(actual_sha256,'hex') END AS actual_sha256_hex`,
      [upload.id, failure.receivedSizeBytes, failure.failureCode, failure.message]);
      const row = failed.rows[0] as UploadRow;
      await appendEvent(client, committee, {type: 'file.upload_failed', resourceType: 'file_upload',
        resourceId: upload.id, revision: row.revision,
        payload: {status: 'FAILED', failureCode: failure.failureCode}});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
        capabilities: await isChair(client, committee.id, auth.user.id) ? ['CHAIR'] : ['MEMBER'],
        action: 'storage.upload_failed', resourceType: 'file_upload', resourceId: upload.id,
        before: {status: 'RECEIVING', revision: upload.revision},
        after: {status: 'FAILED', revision: row.revision, failureCode: failure.failureCode,
          receivedSizeBytes: failure.receivedSizeBytes}});
      const attempt: StoredAttempt = {ok: false, code: failure.apiCode, message: failure.message};
      await client.query(`INSERT INTO idempotency_keys
        (user_id,route,key,request_hash,response_status,response_body,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,now()+interval '24 hours')`,
      [auth.user.id, route, key, hash, ERROR_HTTP_STATUS[failure.apiCode], attempt]);
    });
  }
}
