import {randomUUID} from 'node:crypto';
import type {Pool, PoolClient, QueryResultRow} from 'pg';
import type {FileEntry, FileEntryStatus, FileTombstone, StorageBinding} from '@quorum/contracts';
import {AppError} from '../../http/errors.js';
import type {AuthenticatedSession} from '../identity/store.js';
import {
  appendEvent,
  audit,
  idempotentTransaction,
  isChair,
  lockedCommittee,
  requireBusinessIdentity,
  requireChair,
  requireEditable,
  requireProceedingsActive,
  transaction,
  type Stage4CommitteeRow,
  type Stage4Context
} from '../stage4/database.js';
import {assertExactBody} from '../stage4/validation.js';

interface StorageBindingRow extends QueryResultRow {
  id: string;
  committee_id: string;
  provider_type: 'SERVER_VOLUME' | 'S3_COMPATIBLE';
  provider_config_id: string | null;
  status: StorageBinding['status'];
  revision: number;
  created_at: Date;
}

interface FileEntryRow extends QueryResultRow {
  id: string;
  committee_id: string;
  logical_name: string;
  media_type: string;
  status: FileEntryStatus;
  current_version_id: string | null;
  created_by_user_id: string;
  revision: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

interface FileVersionRow extends QueryResultRow {
  id: string;
  version_number: number;
  original_name: string;
  media_type: string;
  size_bytes: string | number;
  sha256_hex: string;
  blob_id: string;
  created_at: Date;
}

export interface ProviderCommitInput {
  bindingId: string;
  fileEntryId?: string;
  baseRevision?: number;
  logicalName: string;
  originalName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
}

function positiveRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Revision is invalid.'});
  }
  return Number(value);
}

function boundedText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new AppError({code: 'VALIDATION_FAILED', message: `${name} is invalid.`});
  }
  return value.trim();
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError({code: 'VALIDATION_FAILED', message: `${name} is invalid.`});
  }
  return value;
}

export function normalizeSha256(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'SHA-256 is invalid.'});
  }
  return value.toLowerCase();
}

export function validateInternalStorageKey(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512
    || !/^[a-z0-9][a-z0-9/_-]*$/.test(value)
    || value.split('/').includes('..')) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Storage key is invalid.'});
  }
  return value;
}

function sizeBytes(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'File size is invalid.'});
  }
  return Number(value);
}

function binding(row: StorageBindingRow): StorageBinding {
  return {
    id: row.id,
    committeeId: row.committee_id,
    providerType: row.provider_type,
    providerConfigId: row.provider_config_id,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at.toISOString()
  };
}

async function fileState(client: PoolClient, row: FileEntryRow): Promise<FileEntry> {
  if (row.status === 'DELETED' || !row.current_version_id) {
    throw new AppError({code: 'NOT_FOUND', message: 'File not found.'});
  }
  const result = await client.query<FileVersionRow>(`SELECT id,version_number,original_name,media_type,size_bytes,
    encode(sha256,'hex') AS sha256_hex,blob_id,created_at FROM file_versions
    WHERE committee_id=$1 AND file_entry_id=$2 AND id=$3`, [row.committee_id, row.id, row.current_version_id]);
  const version = result.rows[0];
  if (!version) throw new AppError({code: 'INTERNAL_ERROR', message: 'File version is unavailable.'});
  return {
    id: row.id,
    committeeId: row.committee_id,
    logicalName: row.logical_name,
    mediaType: row.media_type,
    status: row.status,
    currentVersion: {
      id: version.id,
      versionNumber: version.version_number,
      originalName: version.original_name,
      mediaType: version.media_type,
      sizeBytes: Number(version.size_bytes),
      sha256: version.sha256_hex,
      blobId: version.blob_id,
      createdAt: version.created_at.toISOString()
    },
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

async function canContribute(client: PoolClient, committee: Stage4CommitteeRow, userId: string): Promise<boolean> {
  if (committee.owner_user_id === userId || await isChair(client, committee.id, userId)) return true;
  const membership = await client.query(`SELECT 1 FROM committee_memberships
    WHERE committee_id=$1 AND user_id=$2 AND status='ACTIVE'`, [committee.id, userId]);
  return Boolean(membership.rowCount);
}

async function requireContributor(client: PoolClient, committee: Stage4CommitteeRow, userId: string): Promise<void> {
  if (!(await canContribute(client, committee, userId))) {
    throw new AppError({code: 'FORBIDDEN', message: 'Committee membership is required.'});
  }
}

function requireCommitteeRevision(committee: Stage4CommitteeRow, value: unknown): void {
  const supplied = positiveRevision(value);
  if (committee.revision !== supplied) {
    throw new AppError({code: 'REVISION_CONFLICT', message: 'This committee changed since it was loaded.',
      details: {currentRevision: committee.revision}});
  }
}

function requireFileRevision(row: FileEntryRow, value: unknown): void {
  const supplied = positiveRevision(value);
  if (row.revision !== supplied) {
    throw new AppError({code: 'REVISION_CONFLICT', message: 'This file changed since it was loaded.',
      details: {currentRevision: row.revision}});
  }
}

export class Stage6StorageService {
  constructor(private readonly pool: Pool) {}

  async createServerVolumeBinding(auth: AuthenticatedSession, committeeId: string, body: unknown,
    idempotencyKey: string, context: Stage4Context): Promise<StorageBinding> {
    requireBusinessIdentity(auth);
    assertExactBody(body as Record<string, unknown>, ['baseRevision']);
    const request = body as {baseRevision?: unknown};
    return idempotentTransaction({
      pool: this.pool,
      auth,
      route: `/api/v1/committees/${committeeId}/storage-bindings/server-volume`,
      key: idempotencyKey,
      request: body,
      status: 201,
      work: async client => {
        const committee = await lockedCommittee(client, committeeId);
        requireEditable(committee);
        await requireChair(client, committee, auth.user.id);
        requireCommitteeRevision(committee, request.baseRevision);
        if (await client.query('SELECT 1 FROM storage_bindings WHERE committee_id=$1 AND status=$2',
          [committee.id, 'ACTIVE']).then(result => Boolean(result.rowCount))) {
          throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The committee already has active storage.'});
        }
        const id = randomUUID();
        const created = await client.query<StorageBindingRow>(`INSERT INTO storage_bindings
          (id,committee_id,provider_type,status,created_by_user_id)
          VALUES ($1,$2,'SERVER_VOLUME','ACTIVE',$3) RETURNING *`, [id, committee.id, auth.user.id]);
        await client.query(`UPDATE committees SET active_storage_binding_id=$2,revision=revision+1,updated_at=now()
          WHERE id=$1`, [committee.id, id]);
        committee.revision += 1;
        await appendEvent(client, committee, {type: 'committee.updated', resourceType: 'storage_binding',
          resourceId: id, revision: committee.revision, audience: 'CHAIR',
          payload: {storageBindingId: id, providerType: 'SERVER_VOLUME'}});
        await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
          capabilities: ['CHAIR'], action: 'storage.binding_changed', resourceType: 'storage_binding', resourceId: id,
          after: {providerType: 'SERVER_VOLUME', status: 'ACTIVE', revision: 1}});
        return binding(created.rows[0] as StorageBindingRow);
      }
    });
  }

  /**
   * Internal persistence boundary. A provider may call this only after it has
   * durably committed and independently verified the bytes described here.
   */
  async recordProviderCommit(auth: AuthenticatedSession, committeeId: string, input: ProviderCommitInput,
    idempotencyKey: string, context: Stage4Context): Promise<FileEntry> {
    requireBusinessIdentity(auth);
    assertExactBody(input as unknown as Record<string, unknown>, ['bindingId', 'fileEntryId', 'baseRevision', 'logicalName',
      'originalName', 'mediaType', 'sizeBytes', 'sha256', 'storageKey']);
    const bindingId = uuid(input.bindingId, 'Storage binding ID');
    const fileEntryId = input.fileEntryId === undefined ? undefined : uuid(input.fileEntryId, 'File ID');
    const logicalName = boundedText(input.logicalName, 'Logical name', 500);
    const originalName = boundedText(input.originalName, 'Original name', 500);
    const mediaType = boundedText(input.mediaType, 'Media type', 255).toLowerCase();
    const verifiedSize = sizeBytes(input.sizeBytes);
    const verifiedHash = normalizeSha256(input.sha256);
    const storageKey = validateInternalStorageKey(input.storageKey);
    return idempotentTransaction({
      pool: this.pool,
      auth,
      route: `/internal/storage/provider-commits/${committeeId}`,
      key: idempotencyKey,
      request: input,
      status: 201,
      work: async client => {
        const committee = await lockedCommittee(client, committeeId);
        requireProceedingsActive(committee);
        await requireContributor(client, committee, auth.user.id);
        const activeBinding = await client.query<StorageBindingRow>(`SELECT * FROM storage_bindings
          WHERE id=$1 AND committee_id=$2 AND status='ACTIVE' FOR UPDATE`, [bindingId, committee.id]);
        if (!activeBinding.rows[0] || committee.active_storage_binding_id !== bindingId) {
          throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The storage binding is not active.'});
        }

        let entry: FileEntryRow | undefined;
        if (fileEntryId) {
          entry = (await client.query<FileEntryRow>('SELECT * FROM file_entries WHERE id=$1 FOR UPDATE', [fileEntryId])).rows[0];
          if (!entry || entry.committee_id !== committee.id || entry.status === 'DELETED') {
            throw new AppError({code: 'NOT_FOUND', message: 'File not found.'});
          }
          requireFileRevision(entry, input.baseRevision);
          if (entry.created_by_user_id !== auth.user.id && committee.owner_user_id !== auth.user.id
            && !(await isChair(client, committee.id, auth.user.id))) {
            throw new AppError({code: 'FORBIDDEN', message: 'Only the file owner or Chair may add a version.'});
          }
        } else if (input.baseRevision !== undefined) {
          throw new AppError({code: 'VALIDATION_FAILED', message: 'Revision is only valid for an existing file.'});
        }

        const id = entry?.id ?? randomUUID();
        const versionId = randomUUID();
        const blobId = randomUUID();
        const versionNumber = entry
          ? Number((await client.query<{next_version: number}>(`SELECT coalesce(max(version_number),0)+1 AS next_version
              FROM file_versions WHERE file_entry_id=$1`, [entry.id])).rows[0]?.next_version ?? 1)
          : 1;
        await client.query(`INSERT INTO file_blobs
          (id,committee_id,storage_binding_id,storage_key,size_bytes,sha256,durability_state)
          VALUES ($1,$2,$3,$4,$5,decode($6,'hex'),'COMMITTED')`,
        [blobId, committee.id, bindingId, storageKey, verifiedSize, verifiedHash]);
        if (entry) {
          const updated = await client.query<FileEntryRow>(`UPDATE file_entries SET logical_name=$2,media_type=$3,
            status='UPLOAD_COMPLETE',current_version_id=$4,revision=revision+1,updated_at=now()
            WHERE id=$1 RETURNING *`, [entry.id, logicalName, mediaType, versionId]);
          entry = updated.rows[0];
        } else {
          const created = await client.query<FileEntryRow>(`INSERT INTO file_entries
            (id,committee_id,logical_name,media_type,status,current_version_id,created_by_user_id)
            VALUES ($1,$2,$3,$4,'UPLOAD_COMPLETE',$5,$6) RETURNING *`,
          [id, committee.id, logicalName, mediaType, versionId, auth.user.id]);
          entry = created.rows[0];
        }
        await client.query(`INSERT INTO file_versions
          (id,committee_id,file_entry_id,version_number,blob_id,original_name,media_type,size_bytes,sha256,created_by_user_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,decode($9,'hex'),$10)`,
        [versionId, committee.id, id, versionNumber, blobId, originalName, mediaType, verifiedSize, verifiedHash, auth.user.id]);
        await appendEvent(client, committee, {type: versionNumber === 1 ? 'file.created' : 'file.sync_state_changed',
          resourceType: 'file_entry', resourceId: id, revision: entry?.revision ?? 1,
          payload: {status: 'UPLOAD_COMPLETE', versionNumber, sizeBytes: verifiedSize}});
        await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
          capabilities: await isChair(client, committee.id, auth.user.id) ? ['CHAIR'] : ['MEMBER'],
          action: 'storage.file_version_recorded', resourceType: 'file_entry', resourceId: id,
          before: versionNumber === 1 ? null : {revision: (entry?.revision ?? 2) - 1},
          after: {status: 'UPLOAD_COMPLETE', revision: entry?.revision ?? 1, versionNumber,
            sizeBytes: verifiedSize, sha256: verifiedHash}});
        return fileState(client, entry as FileEntryRow);
      }
    });
  }

  async deleteFile(auth: AuthenticatedSession, fileEntryId: string, body: unknown,
    context: Stage4Context): Promise<FileTombstone> {
    requireBusinessIdentity(auth);
    assertExactBody(body as Record<string, unknown>, ['baseRevision']);
    const request = body as {baseRevision?: unknown};
    return transaction(this.pool, async client => {
      const entry = (await client.query<FileEntryRow>('SELECT * FROM file_entries WHERE id=$1 FOR UPDATE',
        [uuid(fileEntryId, 'File ID')])).rows[0];
      if (!entry || entry.status === 'DELETED') throw new AppError({code: 'NOT_FOUND', message: 'File not found.'});
      const committee = await lockedCommittee(client, entry.committee_id);
      requireProceedingsActive(committee);
      requireFileRevision(entry, request.baseRevision);
      const chair = await isChair(client, committee.id, auth.user.id);
      if (!chair && committee.owner_user_id !== auth.user.id && entry.created_by_user_id !== auth.user.id) {
        throw new AppError({code: 'FORBIDDEN', message: 'Only the file owner or Chair may delete this file.'});
      }
      const tombstoneId = randomUUID();
      const deleted = await client.query<{deleted_at: Date}>(`UPDATE file_entries SET status='DELETED',
        current_version_id=NULL,revision=revision+1,updated_at=now(),deleted_at=now()
        WHERE id=$1 RETURNING deleted_at`, [entry.id]);
      await client.query(`INSERT INTO file_tombstones
        (id,committee_id,file_entry_id,last_content_revision,deleted_by_user_id,deleted_at)
        VALUES ($1,$2,$3,$4,$5,$6)`,
      [tombstoneId, committee.id, entry.id, entry.revision, auth.user.id, deleted.rows[0]?.deleted_at]);
      await client.query(`UPDATE file_blobs b SET durability_state='DELETE_PENDING',updated_at=now()
        FROM file_versions v WHERE v.file_entry_id=$1 AND v.blob_id=b.id AND b.durability_state='COMMITTED'`, [entry.id]);
      await appendEvent(client, committee, {type: 'file.deleted', resourceType: 'file_entry', resourceId: entry.id,
        revision: entry.revision + 1, payload: {status: 'DELETED'}});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
        capabilities: chair ? ['CHAIR'] : committee.owner_user_id === auth.user.id ? ['OWNER'] : ['MEMBER'],
        action: 'storage.file_deleted', resourceType: 'file_entry', resourceId: entry.id,
        before: {status: entry.status, revision: entry.revision},
        after: {status: 'DELETED', revision: entry.revision + 1, tombstoneId}});
      return {id: tombstoneId, fileEntryId: entry.id, committeeId: committee.id,
        lastContentRevision: entry.revision, deletedAt: (deleted.rows[0]?.deleted_at as Date).toISOString()};
    });
  }
}
