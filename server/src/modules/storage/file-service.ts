import {randomUUID} from 'node:crypto';
import type {Pool, PoolClient, QueryResultRow} from 'pg';
import type {FileBlobDeleteJob, FileEntry, FileEntryStatus} from '@quorum/contracts';
import {AppError} from '../../http/errors.js';
import type {AuthenticatedSession} from '../identity/store.js';
import {appendEvent, audit, idempotentTransaction, isChair, lockedCommittee, requireBusinessIdentity,
  requireProceedingsActive, transaction, type Stage4Context} from '../stage4/database.js';
import {assertExactBody} from '../stage4/validation.js';
import type {Stage6S3ConfigService} from './s3-config-service.js';
import type {S3CompatibleStore, S3ProviderConfig} from './s3-store.js';
import type {ServerVolumeStore} from './server-volume.js';

interface FileRow extends QueryResultRow {
  id: string;
  committee_id: string;
  logical_name: string;
  entry_media_type: string;
  status: FileEntryStatus;
  current_version_id: string;
  created_by_user_id: string;
  revision: number;
  submitted_at: Date | null;
  published_at: Date | null;
  entry_created_at: Date;
  entry_updated_at: Date;
  version_id: string;
  version_number: number;
  original_name: string;
  version_media_type: string;
  size_bytes: string | number;
  sha256_hex: string;
  blob_id: string;
  version_created_at: Date;
  storage_key: string;
  provider_type: 'SERVER_VOLUME' | 'S3_COMPATIBLE';
  provider_config_id: string | null;
}

interface EntryRow extends QueryResultRow {
  id: string; committee_id: string; created_by_user_id: string; status: FileEntryStatus;
  revision: number; submitted_at: Date | null; published_at: Date | null;
}

interface DeleteJobRow extends QueryResultRow {
  id: string; committee_id: string; file_entry_id: string; blob_id: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'RETRY' | 'COMPLETED'; attempts: number;
  next_attempt_at: Date; claimed_at: Date | null; claim_token: string | null; failure_code: string | null;
  storage_key: string; provider_type: 'SERVER_VOLUME' | 'S3_COMPATIBLE'; provider_config_id: string | null;
}

type Audience = 'PUBLIC' | 'MEMBER' | 'CHAIR' | 'OWNER';
type Store = Pick<ServerVolumeStore, 'verify' | 'readVerified' | 'delete'>;
export type FileS3StoreFactory = (config: S3ProviderConfig) =>
  Pick<S3CompatibleStore, 'verify' | 'readVerified' | 'delete'>;

const FILE_SELECT = `SELECT e.id,e.committee_id,e.logical_name,e.media_type AS entry_media_type,e.status,
  e.current_version_id,e.created_by_user_id,e.revision,e.submitted_at,e.published_at,
  e.created_at AS entry_created_at,e.updated_at AS entry_updated_at,
  v.id AS version_id,v.version_number,v.original_name,v.media_type AS version_media_type,
  v.size_bytes,encode(v.sha256,'hex') AS sha256_hex,v.blob_id,v.created_at AS version_created_at,
  b.storage_key,sb.provider_type,sb.provider_config_id
  FROM file_entries e JOIN committees committee ON committee.id=e.committee_id
  JOIN file_versions v ON v.id=e.current_version_id JOIN file_blobs content ON content.id=v.blob_id
  LEFT JOIN file_blob_copies location ON location.content_blob_id=content.id
    AND location.storage_binding_id=committee.active_storage_binding_id
  LEFT JOIN file_blobs replica ON replica.id=location.copy_blob_id AND replica.durability_state='COMMITTED'
  JOIN file_blobs b ON b.id=CASE WHEN content.storage_binding_id=committee.active_storage_binding_id
    THEN content.id ELSE replica.id END
  JOIN storage_bindings sb ON sb.id=b.storage_binding_id`;

function mapFile(row: FileRow): FileEntry {
  return {id: row.id, committeeId: row.committee_id, logicalName: row.logical_name,
    mediaType: row.entry_media_type, status: row.status, createdByUserId: row.created_by_user_id,
    currentVersion: {id: row.version_id, versionNumber: row.version_number, originalName: row.original_name,
      mediaType: row.version_media_type, sizeBytes: Number(row.size_bytes), sha256: row.sha256_hex,
      blobId: row.blob_id, createdAt: row.version_created_at.toISOString()},
    revision: row.revision, submittedAt: row.submitted_at?.toISOString() ?? null,
    publishedAt: row.published_at?.toISOString() ?? null,
    createdAt: row.entry_created_at.toISOString(), updatedAt: row.entry_updated_at.toISOString()};
}

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

async function audience(client: PoolClient, committee: {id: string; owner_user_id: string; visibility: string},
  auth?: AuthenticatedSession): Promise<Audience> {
  if (auth?.user.id === committee.owner_user_id) return 'OWNER';
  if (auth && await isChair(client, committee.id, auth.user.id)) return 'CHAIR';
  if (auth) {
    const member = await client.query(`SELECT 1 FROM committee_memberships
      WHERE committee_id=$1 AND user_id=$2 AND status='ACTIVE'`, [committee.id, auth.user.id]);
    if (member.rowCount) return 'MEMBER';
  }
  if (committee.visibility === 'PRIVATE') throw new AppError({code: 'NOT_FOUND', message: 'Committee not found.'});
  return 'PUBLIC';
}

export function safeDownloadHeaders(file: FileEntry): Record<string, string> {
  const original = Array.from(file.currentVersion.originalName.normalize('NFC')).slice(0, 500).join('')
    .replace(/[\uD800-\uDFFF]/g, '\uFFFD');
  const extension = /(?:^|\.)([A-Za-z0-9]{1,12})$/.exec(original)?.[1];
  const fallback = `download${extension ? `.${extension.toLowerCase()}` : ''}`;
  const encoded = encodeURIComponent(original).replace(/['()]/g, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  const declared = file.currentVersion.mediaType;
  const baseType = declared.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const validType = !/[\r\n]/.test(declared)
    && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(baseType);
  const risky = /^(?:text\/(?:html|xml|javascript|ecmascript)|application\/(?:xhtml\+xml|xml|javascript|ecmascript)|image\/svg\+xml)$/
    .test(baseType);
  return {
    'content-type': !validType || risky ? 'application/octet-stream' : baseType,
    'content-length': String(file.currentVersion.sizeBytes),
    'content-disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'cross-origin-resource-policy': 'same-origin',
    'cache-control': 'private, no-store'
  };
}

export class Stage6FileService {
  constructor(private readonly pool: Pool, private readonly serverVolume: ServerVolumeStore,
    private readonly s3Configs: Stage6S3ConfigService, private readonly s3Factory: FileS3StoreFactory) {}

  async list(auth: AuthenticatedSession | undefined, committeeId: string): Promise<FileEntry[]> {
    return transaction(this.pool, async client => {
      const committee = await this.committee(client, uuid(committeeId, 'Committee ID'));
      const viewer = await audience(client, committee, auth);
      const result = await client.query<FileRow>(`${FILE_SELECT} WHERE e.committee_id=$1 AND e.status<>'DELETED'
        AND ($2::boolean=false OR e.status='PUBLISHED') ORDER BY e.created_at,e.id`,
      [committee.id, viewer === 'PUBLIC']);
      return result.rows.map(mapFile);
    });
  }

  async get(auth: AuthenticatedSession | undefined, fileId: string): Promise<FileEntry> {
    return mapFile(await this.visibleRow(auth, uuid(fileId, 'File ID')));
  }

  async download(auth: AuthenticatedSession | undefined, fileId: string): Promise<{
    file: FileEntry; headers: Record<string, string>; content: AsyncIterable<Buffer>;
  }> {
    const row = await this.visibleRow(auth, uuid(fileId, 'File ID'));
    const file = mapFile(row);
    const store = await this.store(row.provider_type, row.provider_config_id);
    await store.verify(row.storage_key, Number(row.size_bytes), row.sha256_hex);
    const content = store.readVerified(row.storage_key);
    return {file, headers: safeDownloadHeaders(file), content};
  }

  async submitForReview(auth: AuthenticatedSession, fileId: string, body: unknown,
    idempotencyKey: string, context: Stage4Context): Promise<FileEntry> {
    return this.transition(auth, fileId, body, 'UPLOAD_COMPLETE', 'PENDING_REVIEW',
      'file.review_requested', 'storage.file_review_requested', idempotencyKey, context);
  }

  async publish(auth: AuthenticatedSession, fileId: string, body: unknown,
    idempotencyKey: string, context: Stage4Context): Promise<FileEntry> {
    return this.transition(auth, fileId, body, 'PENDING_REVIEW', 'PUBLISHED',
      'file.published', 'storage.file_published', idempotencyKey, context);
  }

  async processNextDeleteJob(): Promise<FileBlobDeleteJob | null> {
    const claimed = await transaction(this.pool, async client => {
      const result = await client.query<DeleteJobRow>(`SELECT j.*,b.storage_key,s.provider_type,s.provider_config_id
        FROM file_blob_delete_jobs j JOIN file_blobs b ON b.id=j.blob_id
        JOIN storage_bindings s ON s.id=b.storage_binding_id
        WHERE (j.status IN ('PENDING','RETRY') AND j.next_attempt_at<=now())
          OR (j.status='IN_PROGRESS' AND (j.claimed_at IS NULL OR j.claimed_at<=now()-interval '5 minutes'))
        ORDER BY CASE WHEN j.status='IN_PROGRESS' THEN j.claimed_at ELSE j.next_attempt_at END,j.created_at,j.id
        FOR UPDATE OF j SKIP LOCKED LIMIT 1`);
      if (!result.rows[0]) return null;
      const row = result.rows[0];
      const claimToken = randomUUID();
      await client.query(`UPDATE file_blob_delete_jobs SET status='IN_PROGRESS',attempts=attempts+1,
        claimed_at=now(),claim_token=$2,failure_code=NULL,failure_reason=NULL,updated_at=now() WHERE id=$1`,
      [row.id, claimToken]);
      row.attempts += 1; row.status = 'IN_PROGRESS'; row.claim_token = claimToken;
      return row;
    });
    if (!claimed) return null;
    let providerDeleted = false;
    try {
      await (await this.store(claimed.provider_type, claimed.provider_config_id)).delete(claimed.storage_key);
      providerDeleted = true;
      return transaction(this.pool, async client => {
        const completed = await client.query<DeleteJobRow>(`UPDATE file_blob_delete_jobs SET status='COMPLETED',
          completed_at=now(),claimed_at=NULL,claim_token=NULL,failure_code=NULL,failure_reason=NULL,updated_at=now()
          WHERE id=$1 AND status='IN_PROGRESS' AND claim_token=$2 RETURNING *`, [claimed.id, claimed.claim_token]);
        if (!completed.rows[0]) return this.currentDeleteJob(client, claimed.id);
        await client.query(`UPDATE file_blobs SET durability_state='DELETED',updated_at=now() WHERE id=$1`,
          [claimed.blob_id]);
        await client.query(`INSERT INTO storage_cleanup_audit (resource_type,resource_id,outcome)
          VALUES ('BLOB_DELETE',$1,'SUCCEEDED')`, [claimed.id]);
        return this.deleteJob(completed.rows[0]);
      });
    } catch (error) {
      const failureCode = providerDeleted ? 'STORAGE_CLEANUP_COMMIT_FAILED'
        : (error as {failureCode?: string}).failureCode ?? 'PROVIDER_DELETE_FAILED';
      const failureReason = error instanceof Error ? error.message.slice(0, 240) : 'Provider deletion failed.';
      return transaction(this.pool, async client => {
        const retry = await client.query<DeleteJobRow>(`UPDATE file_blob_delete_jobs SET status='RETRY',
          claimed_at=NULL,claim_token=NULL,failure_code=$2,failure_reason=$3,
          next_attempt_at=now()+(least(300,power(2,least(attempts,8)))::text||' seconds')::interval,
          updated_at=now() WHERE id=$1 AND status='IN_PROGRESS' AND claim_token=$4 RETURNING *`,
        [claimed.id, failureCode.slice(0, 80), failureReason, claimed.claim_token]);
        if (!retry.rows[0]) return this.currentDeleteJob(client, claimed.id);
        await client.query(`INSERT INTO storage_cleanup_audit (resource_type,resource_id,outcome,failure_code)
          VALUES ('BLOB_DELETE',$1,'FAILED',$2)`, [claimed.id, failureCode.slice(0, 80)]);
        return this.deleteJob(retry.rows[0]);
      });
    }
  }

  private async transition(auth: AuthenticatedSession, fileId: string, body: unknown,
    expected: FileEntryStatus, next: FileEntryStatus, eventType: string, auditAction: string,
    idempotencyKey: string, context: Stage4Context): Promise<FileEntry> {
    requireBusinessIdentity(auth);
    assertExactBody(body as Record<string, unknown>, ['baseRevision']);
    const baseRevision = revision((body as {baseRevision?: unknown}).baseRevision);
    const id = uuid(fileId, 'File ID');
    return idempotentTransaction({pool: this.pool, auth, route: `/api/v1/files/${id}/${next === 'PUBLISHED'
      ? 'publish' : 'submit-review'}`, key: idempotencyKey, request: body, status: 200, work: async client => {
      const entry = await this.entryForUpdate(client, id);
      const committee = await lockedCommittee(client, entry.committee_id);
      requireProceedingsActive(committee);
      if (entry.revision !== baseRevision) {
        throw new AppError({code: 'REVISION_CONFLICT', message: 'This file changed since it was loaded.',
          details: {currentRevision: entry.revision}});
      }
      const chair = await isChair(client, committee.id, auth.user.id);
      const owner = committee.owner_user_id === auth.user.id;
      if (next === 'PENDING_REVIEW') {
        if (!chair && !owner && entry.created_by_user_id !== auth.user.id) {
          throw new AppError({code: 'FORBIDDEN', message: 'Only the file owner or Chair may submit this file.'});
        }
      } else if (!chair && !owner) {
        throw new AppError({code: 'FORBIDDEN', message: 'Chair or committee owner access is required.'});
      }
      if (entry.status !== expected) {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'File status does not allow this action.'});
      }
      const updated = await client.query<EntryRow>(`UPDATE file_entries SET status=$2,
        submitted_at=CASE WHEN $2='PENDING_REVIEW' THEN now() ELSE submitted_at END,
        published_at=CASE WHEN $2='PUBLISHED' THEN now() ELSE NULL END,
        published_by_user_id=CASE WHEN $2='PUBLISHED' THEN $3 ELSE NULL END,
        revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`, [entry.id, next, auth.user.id]);
      const current = updated.rows[0] as EntryRow;
      await appendEvent(client, committee, {type: eventType, resourceType: 'file_entry', resourceId: entry.id,
        revision: current.revision, payload: {status: next}});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
        capabilities: chair ? ['CHAIR'] : owner ? ['OWNER'] : ['MEMBER'], action: auditAction,
        resourceType: 'file_entry', resourceId: entry.id,
        before: {status: expected, revision: entry.revision}, after: {status: next, revision: current.revision}});
      const row = await client.query<FileRow>(`${FILE_SELECT} WHERE e.id=$1`, [entry.id]);
      return mapFile(row.rows[0] as FileRow);
    }});
  }

  private async visibleRow(auth: AuthenticatedSession | undefined, fileId: string): Promise<FileRow> {
    return transaction(this.pool, async client => {
      const result = await client.query<FileRow>(`${FILE_SELECT} WHERE e.id=$1 AND e.status<>'DELETED'`, [fileId]);
      const row = result.rows[0];
      if (!row) throw new AppError({code: 'NOT_FOUND', message: 'File not found.'});
      const committee = await this.committee(client, row.committee_id);
      const viewer = await audience(client, committee, auth);
      if (viewer === 'PUBLIC' && row.status !== 'PUBLISHED') {
        throw new AppError({code: 'NOT_FOUND', message: 'File not found.'});
      }
      return row;
    });
  }

  private async store(provider: 'SERVER_VOLUME' | 'S3_COMPATIBLE', configId: string | null): Promise<Store> {
    if (provider === 'SERVER_VOLUME') return this.serverVolume;
    if (!configId) throw new AppError({code: 'SERVICE_NOT_READY', message: 'S3 provider config is unavailable.'});
    return this.s3Factory(await this.s3Configs.providerForStoredBlob(configId));
  }

  private async committee(client: PoolClient, id: string): Promise<{
    id: string; owner_user_id: string; visibility: 'PUBLIC' | 'PRIVATE';
  }> {
    const result = await client.query<{id: string; owner_user_id: string; visibility: 'PUBLIC' | 'PRIVATE'}>(
      'SELECT id,owner_user_id,visibility FROM committees WHERE id=$1', [id]);
    if (!result.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Committee not found.'});
    return result.rows[0];
  }

  private async entryForUpdate(client: PoolClient, id: string): Promise<EntryRow> {
    const result = await client.query<EntryRow>('SELECT * FROM file_entries WHERE id=$1 FOR UPDATE', [id]);
    if (!result.rows[0] || result.rows[0].status === 'DELETED') {
      throw new AppError({code: 'NOT_FOUND', message: 'File not found.'});
    }
    return result.rows[0];
  }

  private deleteJob(row: DeleteJobRow): FileBlobDeleteJob {
    return {id: row.id, fileEntryId: row.file_entry_id, blobId: row.blob_id, status: row.status,
      attempts: row.attempts, nextAttemptAt: row.next_attempt_at.toISOString(), failureCode: row.failure_code};
  }

  private async currentDeleteJob(client: PoolClient, id: string): Promise<FileBlobDeleteJob> {
    const result = await client.query<DeleteJobRow>('SELECT * FROM file_blob_delete_jobs WHERE id=$1', [id]);
    if (!result.rows[0]) throw new AppError({code: 'INTERNAL_ERROR', message: 'Delete job is unavailable.'});
    return this.deleteJob(result.rows[0]);
  }
}
