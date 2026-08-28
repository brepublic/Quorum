import {randomUUID} from 'node:crypto';
import type {Pool, PoolClient, QueryResultRow} from 'pg';
import type {
  DelegateFileShare,
  DelegateFileType,
  DelegatePortalBootstrap,
  DelegatePortalClaimResult,
  DelegatePublishedFile,
  DelegateReviewFile,
  FileEntry,
  FileUpload,
  PendingHostCommit
} from '@quorum/contracts';
import {AppError} from '../../http/errors.js';
import type {AuthenticatedSession, IdentityUser} from '../identity/store.js';
import {createOpaqueToken, hashOpaqueToken} from '../identity/tokens.js';
import {appendEvent, audit, isChair, lockedCommittee, requireBusinessIdentity, transaction,
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
      const committee = await this.requireManager(client, uuid(committeeId, 'Committee ID'), auth.user.id, true);
      if (committee.revision !== positiveRevision(baseRevision)) throw new AppError({code: 'REVISION_CONFLICT',
        message: 'This committee changed since it was loaded.', details: {currentRevision: committee.revision}});
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
    await this.cache?.assertPendingCapacity(session.committee_id, Number(body.expectedSizeBytes));
    const type = fileType(body.fileType); const uploadBody = {...body}; delete uploadBody.fileType;
    const auth = await this.custodian(session.created_by_user_id);
    const scopedKey = `${session.id}.${key}`;
    const upload = await this.uploads.createUpload(auth, session.committee_id, uploadBody, scopedKey, context);
    await this.pool.query(`INSERT INTO delegate_file_upload_contexts
      (upload_id,delegate_session_id,seat_id,seat_display_name,file_type)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (upload_id) DO NOTHING`,
    [upload.id, session.id, session.seat_id, session.seat_display_name, type]);
    return upload;
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
    return entries.map(file => this.reviewFile(file, metadata.get(file.id)));
  }

  async approve(auth: AuthenticatedSession, fileIdValue: string, body: Record<string, unknown>,
    context: Stage4Context): Promise<DelegateReviewFile> {
    requireBusinessIdentity(auth);
    const fileId = uuid(fileIdValue, 'File ID'); const revision = positiveRevision(body.baseRevision);
    const logicalName = bounded(body.logicalName, 'File name', 500); const type = fileType(body.fileType);
    await transaction(this.pool, async client => {
      const entry = (await client.query<{id: string; committee_id: string; created_by_user_id: string; status: string;
        revision: number; submitted_at: Date | null; created_at: Date}>(`SELECT * FROM file_entries WHERE id=$1 FOR UPDATE`, [fileId])).rows[0];
      if (!entry || entry.status === 'DELETED') throw new AppError({code: 'NOT_FOUND', message: 'File not found.'});
      const committee = await this.requireManager(client, entry.committee_id, auth.user.id, true);
      if (entry.revision !== revision) throw new AppError({code: 'REVISION_CONFLICT', message: 'This file changed since it was loaded.',
        details: {currentRevision: entry.revision}});
      if (!['UPLOAD_COMPLETE', 'PENDING_REVIEW'].includes(entry.status)) throw new AppError({code: 'RESOURCE_CONFLICT',
        message: 'File status does not allow approval.'});
      const existing = (await client.query<MetadataRow>('SELECT * FROM delegate_file_metadata WHERE file_entry_id=$1', [fileId])).rows[0];
      let source: DelegateReviewFile['submissionSource'] = existing?.submission_source ?? 'ACCOUNT';
      let submitter = existing?.submitter_display_name ?? null; let seatId = existing?.submitted_by_seat_id ?? null;
      if (!existing) {
        const chair = entry.created_by_user_id === committee.owner_user_id || await isChair(client, committee.id, entry.created_by_user_id);
        if (chair) { source = 'CHAIR'; submitter = '主席'; }
        else {
          const seat = (await client.query<{id: string; display_name: string}>(`SELECT s.id,s.display_name FROM seat_assignments a
            JOIN committee_seats s ON s.id=a.seat_id WHERE a.committee_id=$1 AND a.user_id=$2 AND a.status='ACTIVE'`,
          [committee.id, entry.created_by_user_id])).rows[0];
          if (seat) { seatId = seat.id; submitter = seat.display_name; }
          else { source = 'LEGACY'; }
        }
      }
      const now = new Date();
      await client.query(`INSERT INTO delegate_file_metadata
        (file_entry_id,submission_source,submitted_by_seat_id,submitter_display_name,file_type,submitted_at)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (file_entry_id) DO UPDATE SET file_type=EXCLUDED.file_type`,
      [fileId, source, seatId, submitter, type, existing?.submitted_at ?? entry.submitted_at ?? entry.created_at]);
      await client.query(`UPDATE file_entries SET logical_name=$2,status='PUBLISHED',submitted_at=COALESCE(submitted_at,$3),
        published_at=$3,published_by_user_id=$4,revision=revision+1,updated_at=$3 WHERE id=$1`,
      [fileId, logicalName, now, auth.user.id]);
      await client.query(`UPDATE storage_cache_entries SET state='READY',state_changed_at=now(),updated_at=now()
        WHERE file_entry_id=$1 AND state='REVIEW_PINNED'`, [fileId]);
      await appendEvent(client, committee, {type: 'file.published', resourceType: 'file_entry', resourceId: fileId,
        revision: entry.revision + 1, audience: 'PUBLIC', payload: {status: 'PUBLISHED', logicalName,
          fileType: type, submissionSource: source, submitterDisplayName: submitter, publishedAt: now.toISOString()}});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
        capabilities: committee.owner_user_id === auth.user.id ? ['OWNER'] : ['CHAIR'],
        action: 'storage.file_published', resourceType: 'file_entry', resourceId: fileId,
        before: {status: entry.status, revision: entry.revision},
        after: {status: 'PUBLISHED', revision: entry.revision + 1, logicalName, fileType: type}});
    });
    return (await this.listReview(auth, (await this.files.get(auth, fileId)).committeeId)).find(item => item.id === fileId) as DelegateReviewFile;
  }

  async reject(auth: AuthenticatedSession, fileId: string, baseRevision: unknown, key: string,
    context: Stage4Context): Promise<{id: string; fileEntryId: string}> {
    const file = await this.files.get(auth, uuid(fileId, 'File ID'));
    await transaction(this.pool, client => this.requireManager(client, file.committeeId, auth.user.id, true));
    const deleted = await this.storage.deleteFile(auth, file.id, {baseRevision: positiveRevision(baseRevision)}, key, context);
    await this.cache?.removeByFile(file.id);
    return deleted;
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
  }>}> {
    const session = await this.authenticate(credential);
    const result = await this.pool.query<{sequence: string | number; event_type: string; resource_id: string;
      payload: Record<string, unknown>; created_at: Date}>(`SELECT sequence,event_type,resource_id,payload,created_at FROM committee_events
      WHERE committee_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 250`,
    [session.committee_id, after]);
    const cursor = result.rows.length ? Number(result.rows[result.rows.length - 1]?.sequence) : after;
    return {cursor, rows: result.rows.filter(row => row.event_type === 'file.published'
      && row.payload.submissionSource === 'DELEGATE_PORTAL'
      && typeof row.payload.logicalName === 'string' && typeof row.payload.submitterDisplayName === 'string')
      .map(row => ({id: Number(row.sequence), fileId: row.resource_id,
        logicalName: String(row.payload.logicalName), submitterDisplayName: String(row.payload.submitterDisplayName),
        publishedAt: typeof row.payload.publishedAt === 'string' ? row.payload.publishedAt : row.created_at.toISOString()}))};
  }

  async chairHostHealthy(credential: string | undefined): Promise<boolean> {
    const session = await this.authenticate(credential);
    return this.hostHealthy(session.committee_id);
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
    if (requireAvailable) await this.assertAvailable(client, committee.id, committee.operation_mode, committee.status,
      committee.active_storage_binding_id);
    return committee;
  }

  private async assertAvailable(client: PoolClient, committeeId: string, mode: string, status: string, bindingId: string | null) {
    const binding = bindingId ? await client.query(`SELECT 1 FROM storage_bindings WHERE id=$1 AND committee_id=$2
      AND status='ACTIVE' AND provider_type='CHAIR_AGENT'`, [bindingId, committeeId]) : {rowCount: 0};
    if (mode !== 'CHAIR_OPERATED' || !['ACTIVE', 'PAUSED'].includes(status) || !binding.rowCount) {
      throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Delegate file sharing is unavailable.'});
    }
  }

  private async shareByCapability(client: PoolClient, capability: string, lock = false): Promise<ShareRow> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) throw new AppError({code: 'NOT_FOUND', message: 'File share not found.'});
    const row = (await client.query<ShareRow>(`SELECT * FROM delegate_file_shares WHERE capability=$1
      AND status='ACTIVE'${lock ? ' FOR UPDATE' : ''}`, [capability])).rows[0];
    if (!row) throw new AppError({code: 'LINK_EXPIRED', message: 'This file share has ended.'});
    const committee = await lockedCommittee(client, row.committee_id);
    await this.assertAvailable(client, committee.id, committee.operation_mode, committee.status, committee.active_storage_binding_id);
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

  private async eligibleSeats(client: PoolClient, committeeId: string): Promise<Array<{id: string; displayName: string}>> {
    const result = await client.query<{id: string; display_name: string}>(`SELECT s.id,s.display_name FROM meeting_sessions ms
      JOIN current_attendance a ON a.meeting_session_id=ms.id AND a.state IN ('PRESENT','TEMPORARILY_LEFT')
      JOIN committee_seats s ON s.id=a.seat_id AND s.active=true
      WHERE ms.committee_id=$1 AND ms.status='OPEN' ORDER BY s.sort_order,s.stable_key,s.id`, [committeeId]);
    return result.rows.map(row => ({id: row.id, displayName: row.display_name}));
  }

  private async portalSnapshot(client: PoolClient, share: ShareRow, session?: DelegateSessionRow): Promise<DelegatePortalBootstrap> {
    const committee = (await client.query<{name: string; next_event_sequence: string | number}>(
      'SELECT name,next_event_sequence FROM committees WHERE id=$1', [share.committee_id])).rows[0];
    if (!committee) throw new AppError({code: 'NOT_FOUND', message: 'Committee not found.'});
    const eligible = await this.eligibleSeats(client, share.committee_id);
    return {committeeId: share.committee_id, committeeName: committee.name, shareId: share.id,
      claimedSeat: session ? {id: session.seat_id, displayName: session.seat_display_name} : null,
      eligibleSeats: session ? [] : eligible,
      mayUpload: Boolean(session && eligible.some(item => item.id === session.seat_id)),
      chairHostHealthy: await this.hostHealthy(share.committee_id, client),
      eventSequence: Number(committee.next_event_sequence) - 1,
      files: session ? await this.publishedForSession(session) : []};
  }

  private async hostHealthy(committeeId: string, client?: PoolClient): Promise<boolean> {
    const executor = client ?? this.pool;
    const result = await executor.query(`SELECT 1 FROM committees c JOIN storage_bindings b
      ON b.id=c.active_storage_binding_id AND b.provider_type='CHAIR_AGENT' AND b.status='ACTIVE'
      JOIN storage_hosts h ON h.id=b.storage_host_id AND h.status='ACTIVE'
      WHERE c.id=$1`, [committeeId]);
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
    return {id: file.id, logicalName: file.logicalName, submitterDisplayName: metadata?.submitter_display_name ?? null,
      fileType: metadata?.file_type ?? null, submittedAt: metadata?.submitted_at?.toISOString() ?? file.submittedAt,
      publishedAt: file.publishedAt ?? '', revision: file.revision,
      status: file.status as DelegateReviewFile['status'], submissionSource: metadata?.submission_source ?? 'LEGACY',
      originalName: file.currentVersion.originalName, sizeBytes: file.currentVersion.sizeBytes};
  }

  private async publishedForSession(session: DelegateSessionRow): Promise<DelegatePublishedFile[]> {
    const entries = (await this.files.list(await this.custodian(session.created_by_user_id), session.committee_id))
      .filter(item => item.status === 'PUBLISHED');
    const metadata = await this.metadata(entries.map(item => item.id));
    return entries.map(file => { const item = metadata.get(file.id); return {
      id: file.id, logicalName: file.logicalName, submitterDisplayName: item?.submitter_display_name ?? null,
      fileType: item?.file_type ?? null, submittedAt: item?.submitted_at?.toISOString() ?? file.submittedAt,
      publishedAt: file.publishedAt as string, revision: file.revision
    }; }).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  }
}
