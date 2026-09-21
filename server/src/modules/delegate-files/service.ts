import {createHash, randomUUID} from 'node:crypto';
import type {Pool, PoolClient, QueryResultRow} from 'pg';
import type {
  DelegateFileShare,
  DelegateFileType,
  FlagSnapshot,
  DelegatePortalBootstrap,
  DelegatePortalClaimResult,
  DelegatePublishedFile,
  DelegateReviewFile,
  FileEntry,
  FileUpload,
  PendingHostCommit
} from '@quorum/contracts';
import {committeeContentName, isAllowedDelegateFile, type DelegateFileSettings, type DefaultFileRejectionSettings} from '@quorum/contracts';
import {assertExactBody} from '../stage4/validation.js';
import {rejectionTypes, allowedExtensions} from './settings.js';
import {AppError} from '../../http/errors.js';
import type {AuthenticatedSession, IdentityUser} from '../identity/store.js';
import {createOpaqueToken, hashOpaqueToken} from '../identity/tokens.js';
import {appendEvent, audit, idempotentTransaction, isChair, lockedCommittee, requireBusinessIdentity, requireProceedingsActive, transaction,
  type Stage4Context} from '../stage4/database.js';
import type {Stage6UploadService} from '../storage/upload-service.js';
import type {Stage6ProviderCommitService} from '../storage/provider-commit-service.js';
import type {Stage6FileService} from '../storage/file-service.js';
import type {Stage6StorageService} from '../storage/service.js';
import type {StorageCacheService} from '../storage/cache-service.js';

const FILE_TYPES = new Set<DelegateFileType>(['WORKING_PAPER', 'DIRECTIVE_DRAFT', 'RESOLUTION_DRAFT']);
const DELEGATE_SESSION_MS = 30 * 24 * 60 * 60 * 1000;

interface ShareRow extends QueryResultRow {
  id: string; committee_id: string; capability: string; status: 'ACTIVE' | 'ENDED'; revision: number;
  created_by_user_id: string; created_at: Date; ended_at: Date | null;
}
interface DelegateSessionRow extends QueryResultRow {
  id: string; share_id: string; committee_id: string; seat_id: string; seat_display_name: string;
  created_by_user_id: string; expires_at: Date; next_event_sequence: string | number;
}
interface MetadataRow extends QueryResultRow {
  file_entry_id: string; submission_source: DelegateReviewFile['submissionSource'];
  submitted_by_seat_id: string | null; submitter_display_name: string | null;
  file_type: DelegateFileType | null; submitted_at: Date | null;
  rejection_reason: string | null; rejected_at: Date | null;
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw new AppError({code: 'VALIDATION_FAILED', message: `${name} is invalid.`});
  }
  return value;
}
function positiveRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Revision is invalid.'});
  }
  return Number(value);
}
function bounded(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || Array.from(value.trim()).length > maximum) {
    throw new AppError({code: 'VALIDATION_FAILED', message: `${name} is invalid.`});
  }
  return value.trim();
}
function fileType(value: unknown): DelegateFileType {
  if (!FILE_TYPES.has(value as DelegateFileType)) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'File type is invalid.'});
  }
  return value as DelegateFileType;
}
function userAuth(row: QueryResultRow): AuthenticatedSession {
  return {sessionId: 'delegate-file-custodian', user: {
    id: row.id, email: row.email, displayName: row.display_name, status: row.status,
    isSystemAdmin: row.is_system_admin, sessionVersion: row.session_version,
    mustChangePassword: row.must_change_password, createdAt: row.created_at.toISOString(),
    disabledAt: row.disabled_at?.toISOString() ?? null
  } as IdentityUser};
}

export class DelegateFileService {
  constructor(private readonly pool: Pool, private readonly uploads: Stage6UploadService,
    private readonly commits: Stage6ProviderCommitService, private readonly files: Stage6FileService,
    private readonly storage: Stage6StorageService, private readonly cache?: StorageCacheService) {}

  async getSettings(auth: AuthenticatedSession, committeeId?: string): Promise<DelegateFileSettings | DefaultFileRejectionSettings> {
    return transaction(this.pool, async client => {
      await this.authorizeSettings(client, auth, committeeId);
      return this.readSettings(client, committeeId);
    });
  }

  async updateSettings(auth: AuthenticatedSession, committeeId: string | undefined, body: Record<string, unknown>,
    context: Stage4Context): Promise<DelegateFileSettings | DefaultFileRejectionSettings> {
    return transaction(this.pool, async client => {
      await this.authorizeSettings(client, auth, committeeId, true);
      const before = await this.readSettings(client, committeeId, true);
      if (before.revision !== positiveRevision(body.baseRevision)) throw new AppError({code: 'REVISION_CONFLICT',
        message: '设置已被其他人修改，请重新载入后再保存。'});
      const language = committeeId ? (await lockedCommittee(client, committeeId)).committee_language : undefined;
      const types = rejectionTypes(body.rejectionTypes, language);
      if (committeeId) {
        const extensions = allowedExtensions(body.allowedExtensions);
        await client.query(`UPDATE committees SET delegate_file_settings=$2,delegate_file_settings_revision=delegate_file_settings_revision+1
          WHERE id=$1`, [committeeId, {rejectionTypes: types, allowedExtensions: extensions}]);
      } else {
        await client.query(`UPDATE system_settings SET default_file_rejection_types=$1,file_rejection_revision=file_rejection_revision+1
          WHERE singleton=true`, [JSON.stringify(types)]);
      }
      const after = await this.readSettings(client, committeeId);
      await audit(client, context, {committeeId, actorUserId: auth.user.id,
        capabilities: committeeId ? ['CHAIR'] : ['SYSTEM_ADMIN'], action: 'storage.delegate_file_settings_updated',
        resourceType: committeeId ? 'committee' : 'system_settings', resourceId: committeeId, before, after});
      return after;
    });
  }

  private async authorizeSettings(client: PoolClient, auth: AuthenticatedSession, committeeId?: string, write = false) {
    if (!committeeId) {
      if (!auth.user.isSystemAdmin) throw new AppError({code: 'FORBIDDEN', message: 'System administrator access is required.'});
      return;
    }
    requireBusinessIdentity(auth);
    const committee = await this.requireManager(client, uuid(committeeId, 'Committee ID'), auth.user.id, false);
    if (write && !['ACTIVE', 'PAUSED'].includes(committee.status)) throw new AppError({code: 'RESOURCE_CONFLICT',
      message: '当前委员会状态不允许修改设置。'});
  }

  private async readSettings(client: PoolClient, committeeId?: string, lock = false): Promise<DelegateFileSettings | DefaultFileRejectionSettings> {
    if (committeeId) {
      const row = (await client.query(`SELECT delegate_file_settings,delegate_file_settings_revision FROM committees WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
        [committeeId])).rows[0];
      return {...row.delegate_file_settings, revision: row.delegate_file_settings_revision};
    }
    const row = (await client.query(`SELECT default_file_rejection_types,file_rejection_revision FROM system_settings WHERE singleton=true${lock ? ' FOR UPDATE' : ''}`)).rows[0];
    return {rejectionTypes: row.default_file_rejection_types, revision: row.file_rejection_revision};
  }

  async getShare(auth: AuthenticatedSession, committeeId: string, origin: string): Promise<DelegateFileShare | null> {
    requireBusinessIdentity(auth);
    return transaction(this.pool, async client => {
      await this.requireManager(client, uuid(committeeId, 'Committee ID'), auth.user.id, false);
      const row = (await client.query<ShareRow>(`SELECT * FROM delegate_file_shares
        WHERE committee_id=$1 AND status='ACTIVE'`, [committeeId])).rows[0];
      return row ? this.share(row, origin) : null;
    });
  }

  async startShare(auth: AuthenticatedSession, committeeId: string, baseRevision: unknown,
    origin: string, context: Stage4Context): Promise<DelegateFileShare> {
    requireBusinessIdentity(auth);
    return transaction(this.pool, async client => {
      const committee = await this.requireManager(client, uuid(committeeId, 'Committee ID'), auth.user.id, false);
      if (committee.revision !== positiveRevision(baseRevision)) throw new AppError({code: 'REVISION_CONFLICT',
        message: 'This committee changed since it was loaded.', details: {currentRevision: committee.revision}});
      await this.assertAvailable(client, committee.id, committee.operation_mode, committee.status);
      const binding = await client.query(`SELECT 1 FROM storage_bindings WHERE id=$1 AND status='ACTIVE'`,
        [committee.active_storage_binding_id]);
      if (!binding.rowCount) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The committee has no active storage.'});
      const started = await client.query(`SELECT 1 FROM meeting_sessions WHERE committee_id=$1 AND status='OPEN'`,
        [committee.id]);
      if (!started.rowCount) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Open the first meeting session before sharing files.'});
      const existing = (await client.query<ShareRow>(`SELECT * FROM delegate_file_shares
        WHERE committee_id=$1 AND status='ACTIVE' FOR UPDATE`, [committee.id])).rows[0];
      if (existing) return this.share(existing, origin);
      const id = randomUUID();
      const inserted = await client.query<ShareRow>(`INSERT INTO delegate_file_shares
        (id,committee_id,capability,created_by_user_id) VALUES ($1,$2,$3,$4) RETURNING *`,
      [id, committee.id, createOpaqueToken(), auth.user.id]);
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
        capabilities: committee.owner_user_id === auth.user.id ? ['OWNER'] : ['CHAIR'],
        action: 'storage.delegate_file_share_started', resourceType: 'delegate_file_share', resourceId: id,
        after: {revision: 1}});
      return this.share(inserted.rows[0] as ShareRow, origin);
    });
  }

  async endShare(auth: AuthenticatedSession, committeeId: string, shareRevision: unknown,
    context: Stage4Context): Promise<DelegateFileShare> {
    requireBusinessIdentity(auth);
    return transaction(this.pool, async client => {
      const committee = await this.requireManager(client, uuid(committeeId, 'Committee ID'), auth.user.id, false);
      const row = (await client.query<ShareRow>(`SELECT * FROM delegate_file_shares
        WHERE committee_id=$1 AND status='ACTIVE' FOR UPDATE`, [committee.id])).rows[0];
      if (!row) throw new AppError({code: 'NOT_FOUND', message: 'Active file share not found.'});
      if (row.revision !== positiveRevision(shareRevision)) throw new AppError({code: 'REVISION_CONFLICT',
        message: 'This share changed since it was loaded.', details: {currentRevision: row.revision}});
      const ended = await client.query<ShareRow>(`UPDATE delegate_file_shares SET status='ENDED',revision=revision+1,
        ended_by_user_id=$2,ended_at=now() WHERE id=$1 RETURNING *`, [row.id, auth.user.id]);
      await client.query('UPDATE delegate_file_sessions SET revoked_at=now() WHERE share_id=$1 AND revoked_at IS NULL', [row.id]);
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
        capabilities: committee.owner_user_id === auth.user.id ? ['OWNER'] : ['CHAIR'],
        action: 'storage.delegate_file_share_ended', resourceType: 'delegate_file_share', resourceId: row.id,
        before: {status: 'ACTIVE', revision: row.revision}, after: {status: 'ENDED', revision: row.revision + 1}});
      return this.share(ended.rows[0] as ShareRow, '');
    });
  }

  async bootstrap(capability: string, credential?: string): Promise<DelegatePortalBootstrap> {
    return transaction(this.pool, async client => {
      const share = await this.shareByCapability(client, capability);
      const session = credential ? await this.optionalSession(client, credential, share.id) : undefined;
      return this.portalSnapshot(client, share, session);
    });
  }

  async claim(capability: string, seatIdValue: unknown, context: Stage4Context): Promise<DelegatePortalClaimResult> {
    return transaction(this.pool, async client => {
      const share = await this.shareByCapability(client, capability, true);
      const seatId = uuid(seatIdValue, 'Seat ID');
      const eligible = await this.eligibleSeats(client, share.committee_id);
      const seat = eligible.find(item => item.id === seatId);
      if (!seat) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'This delegation is not currently eligible.'});
      const sessionToken = createOpaqueToken(); const csrfToken = createOpaqueToken(); const id = randomUUID();
      await client.query(`INSERT INTO delegate_file_sessions
        (id,share_id,seat_id,seat_display_name,credential_hash,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6)`, [id, share.id, seat.id, seat.displayName, hashOpaqueToken(sessionToken),
        new Date(Date.now() + DELEGATE_SESSION_MS)]);
      await audit(client, context, {committeeId: share.committee_id, actorUserId: share.created_by_user_id,
        capabilities: ['DELEGATE_FILE_PORTAL'], onBehalfOfSeatId: seat.id,
        action: 'storage.delegate_file_identity_claimed', resourceType: 'delegate_file_session', resourceId: id,
        after: {shareId: share.id, seatId: seat.id}});
      const session = await this.sessionById(client, id);
      return {...await this.portalSnapshot(client, share, session), sessionToken, csrfToken};
    });
  }

  async authenticate(credential: string | undefined): Promise<DelegateSessionRow> {
    if (!credential) throw new AppError({code: 'AUTHENTICATION_REQUIRED', message: 'Delegate file session is required.'});
    return transaction(this.pool, async client => {
      const session = await this.sessionByCredential(client, credential);
      return session as DelegateSessionRow;
    });
  }

  async createUpload(credential: string | undefined, body: Record<string, unknown>, key: string,
    context: Stage4Context): Promise<FileUpload> {
    const session = await this.authenticate(credential);
    await this.assertMayUpload(session);
    const type = fileType(body.fileType); const uploadBody = {...body}; delete uploadBody.fileType;
    const settings = (await this.pool.query('SELECT delegate_file_settings FROM committees WHERE id=$1', [session.committee_id])).rows[0].delegate_file_settings as DelegateFileSettings;
    const extensions = settings.allowedExtensions[type];
    if (typeof body.originalName !== 'string' || !isAllowedDelegateFile(body.originalName, extensions)) {
      throw new AppError({code: 'VALIDATION_FAILED', reason: 'INVALID_FILE_EXTENSION', params: {formats: extensions.map(ext => '.' + ext).join(', ')}, message: 'The file extension is not allowed.',
        details: {allowedExtensions: extensions}});
    }
    const auth = await this.custodian(session.created_by_user_id);
    const scopedKey = `${session.id}.${key}`;
    return this.uploads.createUpload(auth, session.committee_id, uploadBody, scopedKey, context,
      {sessionId: session.id, seatId: session.seat_id, displayName: session.seat_display_name, fileType: type});
  }

  async receiveContent(credential: string | undefined, uploadIdValue: string, source: AsyncIterable<Uint8Array | string>,
    key: string, contentLength: number | undefined, context: Stage4Context): Promise<FileUpload> {
    const session = await this.ownedUpload(credential, uploadIdValue);
    await this.assertMayUpload(session);
    return this.uploads.receiveContent(await this.custodian(session.created_by_user_id), uploadIdValue, source,
      `${session.id}.${key}`, contentLength, context);
  }

  async commitUpload(credential: string | undefined, uploadIdValue: string, key: string,
    context: Stage4Context): Promise<FileEntry | PendingHostCommit> {
    const session = await this.ownedUpload(credential, uploadIdValue);
    await this.assertMayUpload(session);
    return this.commits.commitUpload(await this.custodian(session.created_by_user_id), uploadIdValue, {},
      `${session.id}.${key}`, context);
  }

  async listReview(auth: AuthenticatedSession, committeeId: string): Promise<DelegateReviewFile[]> {
    requireBusinessIdentity(auth);
    await transaction(this.pool, client => this.requireManager(client, uuid(committeeId, 'Committee ID'), auth.user.id, false));
    const entries = await this.files.list(auth, committeeId);
    const metadata = await this.metadata(entries.map(item => item.id));
    const names = await this.suggestedNames(committeeId, entries.map(file =>
      metadata.get(file.id)?.submitted_at ?? new Date(file.submittedAt ?? file.createdAt)));
    const reviewed = entries.map((file, index) => ({...this.reviewFile(file, metadata.get(file.id)), suggestedNames: names[index]!}));
    const deleted = await this.history(committeeId, undefined, true);
    return [...reviewed, ...deleted];
  }

  private async approvalState(client: PoolClient, auth: AuthenticatedSession, fileId: string,
    body: Record<string, unknown>) {
    const revision = positiveRevision(body.baseRevision);
    const logicalName = bounded(body.logicalName, 'File name', 500); const type = fileType(body.fileType);
    const located = (await client.query<{committee_id: string}>(
      'SELECT committee_id FROM file_entries WHERE id=$1', [fileId])).rows[0];
    if (!located) throw new AppError({code: 'NOT_FOUND', message: 'File not found.'});
    const committee = await this.requireManager(client, located.committee_id, auth.user.id, true);
    const entry = (await client.query(`SELECT * FROM file_entries WHERE id=$1 FOR UPDATE`, [fileId])).rows[0];
    if (!entry || entry.status === 'DELETED' || entry.merged_into_file_entry_id)
      throw new AppError({code: 'NOT_FOUND', message: 'File not found.'});
    if (entry.revision !== revision) throw new AppError({code: 'REVISION_CONFLICT',
      message: 'This file changed since it was loaded.', details: {currentRevision: entry.revision}});
    if (!['UPLOAD_COMPLETE','PENDING_REVIEW'].includes(entry.status)) throw new AppError({code: 'RESOURCE_CONFLICT',
      message: 'File status does not allow approval.'});
    const version = (await client.query(`SELECT v.*,encode(v.sha256,'hex') AS hash FROM file_versions v
      JOIN file_blobs b ON b.id=v.blob_id AND b.durability_state='COMMITTED' WHERE v.id=$1`, [entry.current_version_id])).rows[0];
    if (!version) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'File content is unavailable.'});
    const target = (await client.query(`SELECT * FROM file_entries WHERE committee_id=$1 AND formal_name=$2 COLLATE "C"
      AND status<>'DELETED' AND id<>$3 FOR UPDATE`, [committee.id, logicalName, fileId])).rows[0];
    const token = target ? createHash('sha256').update(JSON.stringify([fileId, revision, entry.current_version_id,
      version.hash, logicalName, type, target.id, target.revision, target.current_version_id])).digest('hex') : null;
    return {committee, entry, version, target, token, logicalName, type};
  }

  async previewApproval(auth: AuthenticatedSession, fileIdValue: string, body: Record<string, unknown>) {
    requireBusinessIdentity(auth); assertExactBody(body, ['baseRevision','logicalName','fileType']);
    return transaction(this.pool, async client => {
      const state = await this.approvalState(client, auth, uuid(fileIdValue, 'File ID'), body);
      return {logicalName: state.logicalName, confirmationToken: state.token,
        target: state.target ? {id: state.target.id as string, revision: state.target.revision as number,
          logicalName: state.target.logical_name as string} : null};
    });
  }

  async approve(auth: AuthenticatedSession, fileIdValue: string, body: Record<string, unknown>,
    context: Stage4Context): Promise<DelegateReviewFile> {
    requireBusinessIdentity(auth); assertExactBody(body, ['baseRevision','logicalName','fileType','confirmationToken']);
    const fileId = uuid(fileIdValue, 'File ID');
    const resultId = await transaction(this.pool, async client => {
      const {committee, entry, version, target, token, logicalName, type} = await this.approvalState(client, auth, fileId, body);
      if (target && target.status !== 'PUBLISHED') throw new AppError({code: 'RESOURCE_CONFLICT',
        message: 'The formal file is not published.', details: {reason: 'FILE_REPLACEMENT_CHANGED'}});
      if ((target || body.confirmationToken !== undefined) && body.confirmationToken !== token)
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Confirm this replacement after refreshing its preview.',
          details: {reason: body.confirmationToken ? 'FILE_REPLACEMENT_CHANGED' : 'FILE_REPLACEMENT_CONFIRMATION_REQUIRED'}});
      const existing = (await client.query<MetadataRow>('SELECT * FROM delegate_file_metadata WHERE file_entry_id=$1', [fileId])).rows[0];
      const source = existing?.submission_source ?? 'LEGACY'; const submitter = existing?.submitter_display_name ?? null;
      const now = new Date(); const resultId = target?.id ?? fileId;
      await client.query(`INSERT INTO delegate_file_metadata
        (file_entry_id,submission_source,submitted_by_seat_id,submitter_display_name,file_type,submitted_at,
         approved_at,approved_by_user_id,approved_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (file_entry_id) DO UPDATE SET
          file_type=EXCLUDED.file_type,approved_at=EXCLUDED.approved_at,approved_by_user_id=EXCLUDED.approved_by_user_id,
          approved_name=EXCLUDED.approved_name`,
      [fileId, source, existing?.submitted_by_seat_id ?? null, submitter, type,
        existing?.submitted_at ?? entry.submitted_at ?? entry.created_at, now, auth.user.id, logicalName]);
      await client.query(`UPDATE file_entries SET logical_name=$2,status='PUBLISHED',submitted_at=COALESCE(submitted_at,$3),
        published_at=$3,published_by_user_id=$4,merged_into_file_entry_id=$5,revision=revision+1,updated_at=$3 WHERE id=$1`,
      [fileId, logicalName, now, auth.user.id, target?.id ?? null]);
      if (target) {
        const versionId = randomUUID();
        await client.query(`INSERT INTO file_versions
          (id,committee_id,file_entry_id,version_number,blob_id,original_name,media_type,size_bytes,sha256,created_by_user_id,source_file_entry_id)
          SELECT $1,$2,$3,coalesce(max(version_number),0)+1,$4,$5,$6,$7,$8,$9,$10 FROM file_versions WHERE file_entry_id=$3`,
        [versionId, committee.id, target.id, version.blob_id, version.original_name, version.media_type,
          version.size_bytes, version.sha256, version.created_by_user_id, fileId]);
        await client.query(`UPDATE file_entries SET current_version_id=$2,media_type=$3,published_at=$4,
          published_by_user_id=$5,submitted_at=$6,revision=revision+1,updated_at=$4 WHERE id=$1`,
        [target.id, versionId, version.media_type, now, auth.user.id, existing?.submitted_at ?? entry.submitted_at ?? entry.created_at]);
        const sequence = (await client.query(`UPDATE committees SET next_storage_manifest_sequence=next_storage_manifest_sequence+1,
          file_manifest_revision=file_manifest_revision+1 WHERE id=$1 RETURNING next_storage_manifest_sequence-1 AS sequence`, [committee.id])).rows[0].sequence;
        await client.query(`INSERT INTO storage_manifest_events
          (committee_id,sequence,kind,file_entry_id,file_revision,version_id,blob_id,logical_name,original_name,media_type,size_bytes,sha256)
          VALUES ($1,$2,'UPSERT',$3,$4,$5,$6,coalesce((SELECT logical_name FROM storage_manifest_events WHERE file_entry_id=$3 ORDER BY sequence DESC LIMIT 1),file_agent_path($3,$7)),$8,$9,$10,$11)`,
        [committee.id, sequence, target.id, target.revision + 1, versionId, version.blob_id, logicalName,
          version.original_name, version.media_type, version.size_bytes, version.sha256]);
        const migrations = await client.query(`UPDATE storage_migrations SET status='FAILED',ready_at=NULL,revision=revision+1,
          failure_code='MANIFEST_CHANGED',failure_reason='The file manifest changed during review.',updated_at=now()
          WHERE committee_id=$1 AND status IN ('COPYING','READY_TO_CONFIRM') RETURNING id,revision`, [committee.id]);
        for (const migration of migrations.rows) await appendEvent(client, committee, {type: 'storage.migration_failed',
          resourceType: 'storage_migration',resourceId: migration.id,revision: migration.revision,audience: 'CHAIR',
          payload: {status: 'FAILED',failureCode: 'MANIFEST_CHANGED'}});
      }
      await client.query(`UPDATE storage_cache_entries SET state='READY',state_changed_at=now(),updated_at=now()
        WHERE file_entry_id=$1 AND state='REVIEW_PINNED'`, [fileId]);
      await appendEvent(client, committee, {type: 'file.published', resourceType: 'file_entry', resourceId: resultId,
        revision: (target?.revision ?? entry.revision) + 1, audience: 'PUBLIC', payload: {status: 'PUBLISHED', logicalName,
          fileType: type, submissionSource: source, submitterDisplayName: submitter, publishedAt: now.toISOString()}});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
        capabilities: committee.owner_user_id === auth.user.id ? ['OWNER'] : ['CHAIR'],
        action: 'storage.file_published', resourceType: 'file_entry', resourceId: fileId,
        before: {status: entry.status, revision: entry.revision, targetRevision: target?.revision},
        after: {status: 'PUBLISHED', revision: entry.revision + 1, logicalName, fileType: type,
          publishedFileId: resultId, sourceVersionId: version.id}});
      return resultId as string;
    });
    return this.reviewFile(await this.files.get(auth, resultId));
  }

  async reject(auth: AuthenticatedSession, fileIdValue: string, body: Record<string, unknown>, key: string,
    context: Stage4Context): Promise<{id: string; fileEntryId: string}> {
    requireBusinessIdentity(auth);
    const fileId = uuid(fileIdValue, 'File ID'); const revision = positiveRevision(body.baseRevision);

    const logicalName = bounded(body.logicalName, 'File name', 500); const type = fileType(body.fileType);
    return idempotentTransaction({pool: this.pool, auth, route: `/api/v1/files/${fileId}/delegate-reject`,
      key, request: body, status: 200, work: async client => {
        const located = (await client.query<{committee_id: string}>(
          'SELECT committee_id FROM file_entries WHERE id=$1', [fileId])).rows[0];
        if (!located) throw new AppError({code: 'NOT_FOUND', message: 'File not found.'});
        const committee = await this.requireManager(client, located.committee_id, auth.user.id, true);
        const entry = (await client.query<{committee_id: string; status: string; revision: number; created_at: Date}>(
          'SELECT * FROM file_entries WHERE id=$1 FOR UPDATE', [fileId])).rows[0];
        if (!entry) throw new AppError({code: 'NOT_FOUND', message: 'File not found.'});
        if (entry.revision !== revision) throw new AppError({code: 'REVISION_CONFLICT', message: 'This file changed since it was loaded.'});
        if (!['UPLOAD_COMPLETE', 'PENDING_REVIEW'].includes(entry.status)) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'File status does not allow rejection.'});
        const settings = await this.readSettings(client, committee.id);
        const rejection = settings.rejectionTypes.find(item => item.id === body.rejectionTypeId);
        if (!rejection) throw new AppError({code: 'VALIDATION_FAILED', message: '请选择有效的驳回类型。'});
        const reason = rejection.custom ? bounded(body.reason, 'Rejection reason', 2000) : committeeContentName(rejection.message, committee.committee_language);
        const now = new Date();
        await client.query(`INSERT INTO delegate_file_metadata
          (file_entry_id,submission_source,submitter_display_name,file_type,submitted_at,rejection_reason,rejected_at)
          VALUES ($1,'LEGACY',NULL,$2,$3,$4,$5) ON CONFLICT (file_entry_id) DO UPDATE
          SET file_type=$2,rejection_reason=$4,rejected_at=$5`, [fileId,type,entry.created_at,reason,now]);
        await client.query(`UPDATE file_entries SET status='REJECTED',logical_name=$2,revision=revision+1,updated_at=$3 WHERE id=$1`, [fileId,logicalName,now]);
        await client.query(`UPDATE storage_cache_entries SET state='READY',state_changed_at=now(),updated_at=now()
          WHERE file_entry_id=$1 AND state='REVIEW_PINNED'`, [fileId]);
        const metadata = (await client.query<MetadataRow>('SELECT * FROM delegate_file_metadata WHERE file_entry_id=$1',[fileId])).rows[0];
        await appendEvent(client,committee,{type:'file.rejected',resourceType:'file_entry',resourceId:fileId,
          revision:revision+1,audience:'CHAIR',payload:{logicalName,fileType:type,rejectionReason:reason,
            submittedBySeatId:metadata?.submitted_by_seat_id,submitterDisplayName:metadata?.submitter_display_name,
            submissionSource:metadata?.submission_source}});
        await audit(client,context,{committeeId:committee.id,actorUserId:auth.user.id,
          capabilities:committee.owner_user_id === auth.user.id ? ['OWNER'] : ['CHAIR'],action:'storage.file_rejected',
          resourceType:'file_entry',resourceId:fileId,before:{status:entry.status,revision},
          after:{status:'REJECTED',revision:revision+1,logicalName,fileType:type,rejectionReason:reason}});
        return {id:fileId,fileEntryId:fileId};
      }});
  }

  async published(credential: string | undefined): Promise<DelegatePublishedFile[]> {
    const session = await this.authenticate(credential);
    return this.publishedForSession(session);
  }

  async download(credential: string | undefined, fileId: string) {
    const session = await this.authenticate(credential);
    const found = (await this.publishedForSession(session)).find(item => item.id === uuid(fileId, 'File ID'));
    if (!found) throw new AppError({code: 'NOT_FOUND', message: 'File not found.'});
    return this.files.download(await this.custodian(session.created_by_user_id), found.id);
  }

  async prepareDownload(credential: string | undefined, fileId: string) {
    const session = await this.authenticate(credential);
    const found = (await this.publishedForSession(session)).find(item => item.id === uuid(fileId, 'File ID'));
    if (!found) throw new AppError({code: 'NOT_FOUND', message: 'File not found.'});
    return this.files.prepareDownload(await this.custodian(session.created_by_user_id), found.id);
  }

  async downloadReadiness(credential: string | undefined, fileId: string) {
    const session = await this.authenticate(credential);
    const found = (await this.publishedForSession(session)).find(item => item.id === uuid(fileId, 'File ID'));
    if (!found) throw new AppError({code: 'NOT_FOUND', message: 'File not found.'});
    return this.files.downloadReadiness(await this.custodian(session.created_by_user_id), found.id);
  }

  async events(credential: string | undefined, after: number): Promise<{cursor: number; rows: Array<{
    id: number; fileId: string; logicalName: string; submitterDisplayName: string; publishedAt: string;
    kind: 'available' | 'rejected'; rejectionReason: string | null;
  }>}> {
    const session = await this.authenticate(credential);
    const result = await this.pool.query<{sequence: string | number; event_type: string; resource_id: string;
      payload: Record<string, unknown>; created_at: Date}>(`SELECT sequence,event_type,resource_id,payload,created_at FROM committee_events
      WHERE committee_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 250`,
    [session.committee_id, after]);
    const cursor = result.rows.length ? Number(result.rows[result.rows.length - 1]?.sequence) : after;
    return {cursor, rows: result.rows.filter(row => (row.event_type === 'file.published' || (row.event_type === 'file.rejected'
        && row.payload.submittedBySeatId === session.seat_id))
      && row.payload.submissionSource === 'DELEGATE_PORTAL'
      && typeof row.payload.logicalName === 'string' && typeof row.payload.submitterDisplayName === 'string')
      .map(row => ({id: Number(row.sequence), fileId: row.resource_id,
        kind: row.event_type === 'file.rejected' ? 'rejected' as const : 'available' as const,
        rejectionReason: typeof row.payload.rejectionReason === 'string' ? row.payload.rejectionReason : null,
        logicalName: String(row.payload.logicalName), submitterDisplayName: String(row.payload.submitterDisplayName),
        publishedAt: typeof row.payload.publishedAt === 'string' ? row.payload.publishedAt : row.created_at.toISOString()}))};
  }

  async storageAvailable(credential: string | undefined): Promise<boolean> {
    const session = await this.authenticate(credential);
    return this.storageHealthy(session.committee_id);
  }

  private share(row: ShareRow, origin: string): DelegateFileShare {
    return {id: row.id, committeeId: row.committee_id,
      url: row.status === 'ACTIVE' && origin ? `${origin}/delegate-files#${row.capability}` : '',
      status: row.status, revision: row.revision, createdAt: row.created_at.toISOString(),
      endedAt: row.ended_at?.toISOString() ?? null};
  }

  private async requireManager(client: PoolClient, committeeId: string, userId: string, requireAvailable: boolean) {
    const committee = await lockedCommittee(client, committeeId);
    if (committee.owner_user_id !== userId && !(await isChair(client, committee.id, userId))) {
      throw new AppError({code: 'FORBIDDEN', message: 'Chair or committee owner access is required.'});
    }
    if (requireAvailable) requireProceedingsActive(committee);
    return committee;
  }

  private async assertAvailable(_client: PoolClient, _committeeId: string, mode: string, status: string) {
    if (mode !== 'CHAIR_OPERATED' || !['ACTIVE', 'PAUSED'].includes(status)) {
      throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Delegate file sharing is unavailable.'});
    }
  }

  private async shareByCapability(client: PoolClient, capability: string, lock = false): Promise<ShareRow> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) throw new AppError({code: 'NOT_FOUND', message: 'File share not found.'});
    const row = (await client.query<ShareRow>(`SELECT * FROM delegate_file_shares WHERE capability=$1
      AND status='ACTIVE'${lock ? ' FOR UPDATE' : ''}`, [capability])).rows[0];
    if (!row) throw new AppError({code: 'LINK_EXPIRED', message: 'This file share has ended.'});
    const committee = await lockedCommittee(client, row.committee_id);
    await this.assertAvailable(client, committee.id, committee.operation_mode, committee.status);
    return row;
  }

  private async optionalSession(client: PoolClient, credential: string, shareId: string) {
    const session = await this.sessionByCredential(client, credential, true);
    return session?.share_id === shareId ? session : undefined;
  }

  private async sessionByCredential(client: PoolClient, credential: string, optional = false): Promise<DelegateSessionRow | undefined> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) {
      if (optional) return undefined;
      throw new AppError({code: 'AUTHENTICATION_REQUIRED', message: 'Delegate file session is invalid.'});
    }
    const row = (await client.query<DelegateSessionRow>(`SELECT s.id,s.share_id,s.seat_id,s.seat_display_name,
      sh.committee_id,sh.created_by_user_id,s.expires_at,c.next_event_sequence
      FROM delegate_file_sessions s JOIN delegate_file_shares sh ON sh.id=s.share_id
      JOIN committees c ON c.id=sh.committee_id WHERE s.credential_hash=$1 AND s.revoked_at IS NULL
        AND s.expires_at>now() AND sh.status='ACTIVE'`, [hashOpaqueToken(credential)])).rows[0];
    if (!row && !optional) throw new AppError({code: 'AUTHENTICATION_REQUIRED', message: 'Delegate file session expired.'});
    if (row) {
      const committee = await lockedCommittee(client, row.committee_id);
      await this.assertAvailable(client, committee.id, committee.operation_mode, committee.status);
    }
    if (row) await client.query(`UPDATE delegate_file_sessions SET last_seen_at=now()
      WHERE id=$1 AND last_seen_at < now()-interval '1 minute'`, [row.id]);
    return row;
  }

  private async sessionById(client: PoolClient, id: string): Promise<DelegateSessionRow> {
    const row = (await client.query<DelegateSessionRow>(`SELECT s.id,s.share_id,s.seat_id,s.seat_display_name,
      sh.committee_id,sh.created_by_user_id,s.expires_at,c.next_event_sequence
      FROM delegate_file_sessions s JOIN delegate_file_shares sh ON sh.id=s.share_id
      JOIN committees c ON c.id=sh.committee_id WHERE s.id=$1`, [id])).rows[0];
    if (!row) throw new AppError({code: 'AUTHENTICATION_REQUIRED', message: 'Delegate file session is unavailable.'});
    return row;
  }

  private async eligibleSeats(client: PoolClient, committeeId: string): Promise<Array<{id: string; displayName: string; flag: FlagSnapshot}>> {
    const result = await client.query<{id: string; display_name: string; flag_type: FlagSnapshot['type']; flag_value: string}>(`SELECT s.id,s.display_name,s.flag_type,s.flag_value FROM meeting_sessions ms
      JOIN current_attendance a ON a.meeting_session_id=ms.id AND a.state IN ('PRESENT','TEMPORARILY_LEFT')
      JOIN committee_seats s ON s.id=a.seat_id AND s.active=true
      WHERE ms.committee_id=$1 AND ms.status='OPEN' ORDER BY s.sort_order,s.stable_key,s.id`, [committeeId]);
    return result.rows.map(row => ({id: row.id, displayName: row.display_name, flag: {type: row.flag_type, value: row.flag_value}}));
  }

  private async portalSnapshot(client: PoolClient, share: ShareRow, session?: DelegateSessionRow): Promise<DelegatePortalBootstrap> {
    const committee = (await client.query<{committee_language: DelegatePortalBootstrap['committeeLanguage']; name: string; next_event_sequence: string | number}>(
      'SELECT name,committee_language,next_event_sequence FROM committees WHERE id=$1', [share.committee_id])).rows[0];
    if (!committee) throw new AppError({code: 'NOT_FOUND', message: 'Committee not found.'});
    const eligible = await this.eligibleSeats(client, share.committee_id);
    const settings = await this.readSettings(client, share.committee_id) as DelegateFileSettings;
    const seat = session ? (await client.query('SELECT flag_type,flag_value FROM committee_seats WHERE id=$1 AND committee_id=$2',
      [session.seat_id, share.committee_id])).rows[0] : undefined;
    return {committeeId: share.committee_id, committeeName: committee.name, committeeLanguage: committee.committee_language, shareId: share.id,
      claimedSeat: session ? {id: session.seat_id, displayName: session.seat_display_name,
        flag: seat ? {type: seat.flag_type, value: seat.flag_value} : undefined} : null,
      allowedExtensions: settings.allowedExtensions,
      eligibleSeats: session ? [] : eligible,
      mayUpload: Boolean(session && eligible.some(item => item.id === session.seat_id)),
      storageAvailable: await this.storageHealthy(share.committee_id, client),
      eventSequence: Number(committee.next_event_sequence) - 1,
      files: session ? await this.publishedForSession(session) : [],
      maxUploadSizeBytes: this.uploads.staging.maxFileBytes,
      pendingUploads: session ? (await client.query<{id: string; logical_name: string; status: string;
        agent_commit_state: string | null; task_status: string | null; provider_commit_failed: boolean}>(`SELECT u.id,u.logical_name,u.status,u.agent_commit_state,u.provider_commit_failed,task.status AS task_status
        FROM file_uploads u LEFT JOIN storage_agent_tasks task ON task.id=u.agent_task_id
        JOIN delegate_file_upload_contexts d ON d.upload_id=u.id
        JOIN delegate_file_sessions ds ON ds.id=d.delegate_session_id
        JOIN delegate_file_shares sh ON sh.id=ds.share_id
        WHERE sh.committee_id=$1 AND d.seat_id=$2 AND u.status NOT IN ('COMMITTED','CANCELLED')
        ORDER BY d.submitted_at DESC`, [share.committee_id, session.seat_id])).rows.map(row => ({
          id: row.id, logicalName: row.logical_name,
          status: row.provider_commit_failed || row.status === 'FAILED' || row.agent_commit_state === 'CONFLICT' || ['FAILED','CANCELLED','RETRY'].includes(row.task_status ?? '') ? 'FAILED' as const : 'SAVING' as const
        })) : [],
      submissions: session ? await this.history(share.committee_id, session.seat_id) : []};
  }

  private async storageHealthy(committeeId: string, client?: PoolClient): Promise<boolean> {
    const executor = client ?? this.pool;
    const result = await executor.query(`SELECT 1 FROM committees c JOIN storage_bindings b
      ON b.id=c.active_storage_binding_id AND b.status='ACTIVE'
      LEFT JOIN storage_hosts h ON h.id=b.storage_host_id
      WHERE c.id=$1 AND (b.provider_type<>'CHAIR_AGENT' OR
        (h.status='ACTIVE' AND h.lease_generation=c.storage_lease_generation))`, [committeeId]);
    return Boolean(result.rowCount);
  }

  private async assertMayUpload(session: DelegateSessionRow): Promise<void> {
    const eligible = await transaction(this.pool, client => this.eligibleSeats(client, session.committee_id));
    if (!eligible.some(item => item.id === session.seat_id)) throw new AppError({code: 'FORBIDDEN',
      message: 'This delegation is not currently eligible to upload.'});
  }

  private async ownedUpload(credential: string | undefined, uploadIdValue: string): Promise<DelegateSessionRow> {
    const session = await this.authenticate(credential); const uploadId = uuid(uploadIdValue, 'Upload ID');
    const result = await this.pool.query(`SELECT 1 FROM delegate_file_upload_contexts
      WHERE upload_id=$1 AND delegate_session_id=$2`, [uploadId, session.id]);
    if (!result.rowCount) throw new AppError({code: 'NOT_FOUND', message: 'Upload not found.'});
    return session;
  }

  private async custodian(userId: string): Promise<AuthenticatedSession> {
    const row = (await this.pool.query(`SELECT * FROM users WHERE id=$1 AND status='ACTIVE'`, [userId])).rows[0];
    if (!row) throw new AppError({code: 'SERVICE_NOT_READY', message: 'The file share custodian is unavailable.'});
    return userAuth(row);
  }

  private async metadata(ids: string[]): Promise<Map<string, MetadataRow>> {
    if (!ids.length) return new Map();
    const rows = await this.pool.query<MetadataRow>('SELECT * FROM delegate_file_metadata WHERE file_entry_id=ANY($1::uuid[])', [ids]);
    return new Map(rows.rows.map(row => [row.file_entry_id, row]));
  }

  private reviewFile(file: FileEntry, metadata?: MetadataRow): DelegateReviewFile {
    return {id: file.id, logicalName: file.logicalName, submitterDisplayName: file.submitterDisplayName ?? null,
      fileType: file.fileType ?? null, submittedAt: file.submittedAt ?? metadata?.submitted_at?.toISOString() ?? null,
      publishedAt: file.publishedAt ?? '', revision: file.revision,
      status: file.status as DelegateReviewFile['status'], submissionSource: file.submissionSource ?? 'LEGACY',
      originalName: file.currentVersion.originalName, sizeBytes: file.currentVersion.sizeBytes,
      rejectionReason: metadata?.rejection_reason ?? null, reviewedAt: metadata?.rejected_at?.toISOString() ?? file.publishedAt};
  }

  private async suggestedNames(committeeId: string, submittedDates: Date[]): Promise<Record<DelegateFileType, {sessionOrdinal: number; ordinal: number}>[]> {
    if (!submittedDates.length) return [];
    const sessions = await this.pool.query<{id: string; ordinal: string; created_at: Date}>(`SELECT id,created_at,
      ordinal::text AS ordinal FROM meeting_sessions WHERE committee_id=$1 ORDER BY created_at,id`, [committeeId]);
    // Count each session once for the entire list, including the no-session fallback.
    const starts = sessions.rows.length ? sessions.rows.map(row => row.created_at) : [new Date(0)];
    const ends = starts.map((_, index) => starts[index + 1] ?? null);
    const counts = await this.pool.query<{ordinal: string; file_type: DelegateFileType; count: string}>(`
      SELECT bounds.ordinal::text,m.file_type,count(*)::text FROM
        unnest($2::timestamptz[],$3::timestamptz[]) WITH ORDINALITY AS bounds(start_at,end_at,ordinal)
      JOIN delegate_file_metadata m ON m.submitted_at >= bounds.start_at
        AND (bounds.end_at IS NULL OR m.submitted_at < bounds.end_at)
      JOIN file_entries e ON e.id=m.file_entry_id WHERE e.committee_id=$1 AND e.published_at IS NOT NULL
      GROUP BY bounds.ordinal,m.file_type`, [committeeId, starts, ends]);
    const totals = new Map(counts.rows.map(row => [`${row.ordinal}:${row.file_type}`, Number(row.count)]));
    const types: DelegateFileType[] = ['WORKING_PAPER', 'DIRECTIVE_DRAFT', 'RESOLUTION_DRAFT'];
    return submittedDates.map(submittedAt => {
      const session = sessions.rows.filter(row => row.created_at <= submittedAt).at(-1) ?? sessions.rows[0];
      const sessionOrdinal = Number(session?.ordinal ?? 1);
      const boundsOrdinal = session ? sessions.rows.indexOf(session) + 1 : 1;
      return Object.fromEntries(types.map(type => [type, {sessionOrdinal,
        ordinal: (totals.get(`${boundsOrdinal}:${type}`) ?? 0) + 1}])) as Record<DelegateFileType, {sessionOrdinal: number; ordinal: number}>;
    });
  }

  private async history(committeeId: string, seatId?: string, deletedOnly = false): Promise<DelegateReviewFile[]> {
    const result = await this.pool.query(`SELECT e.id,e.logical_name,e.status,e.revision,e.published_at,e.merged_into_file_entry_id,m.*,
      v.original_name,v.size_bytes FROM file_entries e JOIN delegate_file_metadata m ON m.file_entry_id=e.id
      JOIN LATERAL (SELECT original_name,size_bytes FROM file_versions WHERE file_entry_id=e.id AND source_file_entry_id IS NULL ORDER BY version_number DESC LIMIT 1) v ON true WHERE e.committee_id=$1
      AND ($2::uuid IS NULL OR (m.submission_source='DELEGATE_PORTAL' AND m.submitted_by_seat_id=$2))
      AND ($3::boolean=false OR ((e.status='DELETED' AND m.rejected_at IS NOT NULL) OR e.merged_into_file_entry_id IS NOT NULL)) ORDER BY m.submitted_at DESC,e.id`,
      [committeeId,seatId ?? null,deletedOnly]);
    return result.rows.map(row => ({id:row.id,logicalName:row.approved_name ?? row.logical_name,publishedFileId:row.merged_into_file_entry_id ?? row.id,status:row.rejected_at ? 'REJECTED' : row.status,
      revision:row.revision,submitterDisplayName:row.submitter_display_name,fileType:row.file_type,
      submittedAt:row.submitted_at?.toISOString() ?? null,publishedAt:(row.approved_at ?? row.published_at)?.toISOString() ?? '',
      submissionSource:row.submission_source,originalName:row.original_name,sizeBytes:Number(row.size_bytes),
      rejectionReason:row.rejection_reason,reviewedAt:(row.rejected_at ?? row.approved_at ?? row.published_at)?.toISOString() ?? null,deleted:row.status==='DELETED'}));
  }

  private async publishedForSession(session: DelegateSessionRow): Promise<DelegatePublishedFile[]> {
    const entries = (await this.files.list(await this.custodian(session.created_by_user_id), session.committee_id))
      .filter(item => item.status === 'PUBLISHED');
    const metadata = await this.metadata(entries.map(item => item.id));
    return entries.map(file => { const item = metadata.get(file.id); return {
      id: file.id, logicalName: file.logicalName, submissionSource: file.submissionSource ?? 'LEGACY', submitterDisplayName: file.submitterDisplayName ?? null,
      fileType: file.fileType ?? null, submittedAt: file.submittedAt,
      publishedAt: file.publishedAt as string, revision: file.revision
    }; }).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  }
}
