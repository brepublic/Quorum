import {randomUUID} from 'node:crypto';
import type {Pool, PoolClient, QueryResultRow} from 'pg';
import type {
  StorageAgentIdentity,
  StorageAgentPairingResult,
  StorageHost,
  StoragePairingCode,
  StoragePairingPurpose
} from '@quorum/contracts';
import {AppError} from '../../http/errors.js';
import type {Logger} from '../../logger.js';
import type {AuthenticatedSession} from '../identity/store.js';
import {
  appendEvent,
  audit,
  isChair,
  lockedCommittee,
  requireBusinessIdentity,
  requireEditable,
  transaction,
  type Stage4CommitteeRow,
  type Stage4Context
} from '../stage4/database.js';
import {assertExactBody} from '../stage4/validation.js';
import {
  createDeviceCredential,
  createPairingCode,
  credentialMatches,
  hashPairingCode,
  normalizePairingCode,
  parseDeviceCredential
} from './tokens.js';

interface PairingRow extends QueryResultRow {
  id: string;
  committee_id: string;
  purpose: StoragePairingPurpose;
  created_by_user_id: string;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
  current_lease_generation?: string | number;
}

interface HostRow extends QueryResultRow {
  id: string;
  committee_id: string;
  device_id: string;
  device_label: string;
  device_public_key: Buffer;
  credential_hash: Buffer;
  paired_by_user_id: string;
  lease_generation: string | number;
  status: StorageHost['status'];
  revision: number;
  last_seen_at: Date | null;
  paired_at: Date;
  revoked_at: Date | null;
}

export interface Stage7AgentOptions {
  pairingTtlMs?: number;
  offlineGraceMs?: number;
  now?: () => Date;
}

export type CurrentStorageAgentLease = StorageAgentIdentity & {status: StorageHost['status']};

const DEFAULT_PAIRING_TTL_MS = 10 * 60_000;
const DEFAULT_OFFLINE_GRACE_MS = 45_000;

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

function generation(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Lease generation is invalid.'});
  }
  return Number(value);
}

function pairingPurpose(value: unknown): StoragePairingPurpose {
  if (value !== 'INITIAL' && value !== 'TRANSFER') {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Pairing purpose is invalid.'});
  }
  return value;
}

function deviceLabel(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Device label is invalid.'});
  }
  return value.trim();
}

function devicePublicKey(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Device public key is invalid.'});
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== 32 || decoded.toString('base64url') !== value) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Device public key is invalid.'});
  }
  return decoded;
}

function host(row: HostRow): StorageHost {
  return {
    id: row.id,
    committeeId: row.committee_id,
    deviceId: row.device_id,
    deviceLabel: row.device_label,
    leaseGeneration: Number(row.lease_generation),
    status: row.status,
    revision: row.revision,
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    pairedAt: row.paired_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null
  };
}

async function requireStorageManager(client: PoolClient, committee: Stage4CommitteeRow, userId: string): Promise<void> {
  if (committee.owner_user_id !== userId && !(await isChair(client, committee.id, userId))) {
    throw new AppError({code: 'FORBIDDEN', message: 'Chair or committee owner access is required.'});
  }
}

async function currentHost(client: PoolClient, committeeId: string, lock = false): Promise<HostRow | undefined> {
  const result = await client.query<HostRow>(`SELECT * FROM storage_hosts
    WHERE committee_id=$1 AND status IN ('ACTIVE','DEGRADED')${lock ? ' FOR UPDATE' : ''}`, [committeeId]);
  return result.rows[0];
}

function requirePairingAvailable(row: PairingRow | undefined, now: Date): PairingRow {
  if (!row || row.used_at || row.revoked_at || row.expires_at <= now) {
    throw new AppError({code: 'LINK_EXPIRED', message: 'Pairing code is invalid or expired.'});
  }
  return row;
}

export class Stage7StorageAgentService {
  private readonly pairingTtlMs: number;
  private readonly offlineGraceMs: number;
  private readonly now: () => Date;

  constructor(private readonly pool: Pool, options: Stage7AgentOptions = {}) {
    this.pairingTtlMs = options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS;
    this.offlineGraceMs = options.offlineGraceMs ?? DEFAULT_OFFLINE_GRACE_MS;
    this.now = options.now ?? (() => new Date());
  }

  async listHosts(auth: AuthenticatedSession, committeeId: string): Promise<StorageHost[]> {
    requireBusinessIdentity(auth);
    return transaction(this.pool, async client => {
      const found = await client.query<Stage4CommitteeRow>('SELECT * FROM committees WHERE id=$1',
        [uuid(committeeId, 'Committee ID')]);
      const committee = found.rows[0];
      if (!committee || committee.status === 'DELETING') {
        throw new AppError({code: 'NOT_FOUND', message: 'Committee not found.'});
      }
      await requireStorageManager(client, committee, auth.user.id);
      const result = await client.query<HostRow>(`SELECT * FROM storage_hosts WHERE committee_id=$1
        ORDER BY CASE WHEN status IN ('ACTIVE','DEGRADED') THEN 0 ELSE 1 END,paired_at DESC,id`, [committee.id]);
      return result.rows.map(host);
    });
  }

  async createPairing(auth: AuthenticatedSession, committeeId: string, body: unknown,
    context: Stage4Context): Promise<StoragePairingCode> {
    requireBusinessIdentity(auth);
    assertExactBody(body as Record<string, unknown>, ['baseRevision', 'purpose']);
    const request = body as {baseRevision?: unknown; purpose?: unknown};
    const purpose = pairingPurpose(request.purpose);
    const code = createPairingCode();
    const codeHash = hashPairingCode(code);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.pairingTtlMs);
    return transaction(this.pool, async client => {
      const committee = await lockedCommittee(client, uuid(committeeId, 'Committee ID'));
      requireEditable(committee);
      await requireStorageManager(client, committee, auth.user.id);
      if (committee.revision !== revision(request.baseRevision)) {
        throw new AppError({code: 'REVISION_CONFLICT', message: 'This committee changed since it was loaded.',
          details: {currentRevision: committee.revision}});
      }
      const active = await currentHost(client, committee.id, true);
      if (purpose === 'INITIAL' && active) {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The committee already has a storage host.'});
      }
      if (purpose === 'TRANSFER' && !active) {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The committee has no storage host to transfer.'});
      }
      await client.query(`UPDATE storage_pairing_codes SET revoked_at=$2
        WHERE committee_id=$1 AND used_at IS NULL AND revoked_at IS NULL`, [committee.id, now]);
      const id = randomUUID();
      await client.query(`INSERT INTO storage_pairing_codes
        (id,committee_id,code_hash,purpose,created_by_user_id,expires_at,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, committee.id, codeHash, purpose, auth.user.id, expiresAt, now]);
      await client.query('UPDATE committees SET revision=revision+1,updated_at=$2 WHERE id=$1', [committee.id, now]);
      committee.revision += 1;
      await appendEvent(client, committee, {type: 'storage_host.status_changed', resourceType: 'storage_pairing',
        resourceId: id, revision: committee.revision, audience: 'CHAIR', payload: {status: 'PAIRING_PENDING', purpose}});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
        capabilities: [committee.owner_user_id === auth.user.id ? 'OWNER' : 'CHAIR'],
        action: 'storage.pairing_code_created', resourceType: 'storage_pairing', resourceId: id,
        after: {purpose, expiresAt: expiresAt.toISOString()}});
      return {code, purpose, expiresAt: expiresAt.toISOString()};
    });
  }

  async pair(body: unknown, context: Stage4Context): Promise<StorageAgentPairingResult> {
    assertExactBody(body as Record<string, unknown>, ['pairingCode', 'deviceLabel', 'devicePublicKey']);
    const request = body as {pairingCode?: unknown; deviceLabel?: unknown; devicePublicKey?: unknown};
    if (!normalizePairingCode(request.pairingCode)) {
      throw new AppError({code: 'LINK_EXPIRED', message: 'Pairing code is invalid or expired.'});
    }
    const label = deviceLabel(request.deviceLabel);
    const publicKey = devicePublicKey(request.devicePublicKey);
    const now = this.now();
    const deviceId = randomUUID();
    const hostId = randomUUID();
    const credential = createDeviceCredential(deviceId);
    const parsedCredential = parseDeviceCredential(credential) as {deviceId: string; tokenHash: Buffer};
    return transaction(this.pool, async client => {
      const codeHash = hashPairingCode(request.pairingCode);
      const candidate = await client.query<PairingRow>('SELECT * FROM storage_pairing_codes WHERE code_hash=$1',
        [codeHash]);
      const candidatePairing = requirePairingAvailable(candidate.rows[0], now);
      const committee = await lockedCommittee(client, candidatePairing.committee_id);
      const found = await client.query<PairingRow>(`SELECT * FROM storage_pairing_codes
        WHERE code_hash=$1 FOR UPDATE`, [codeHash]);
      const pairing = requirePairingAvailable(found.rows[0], now);
      requireEditable(committee);
      if (committee.owner_user_id !== pairing.created_by_user_id
        && !(await isChair(client, committee.id, pairing.created_by_user_id))) {
        throw new AppError({code: 'LINK_EXPIRED', message: 'Pairing code is invalid or expired.'});
      }
      const active = await currentHost(client, committee.id, true);
      if ((pairing.purpose === 'INITIAL' && active) || (pairing.purpose === 'TRANSFER' && !active)) {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Storage host state changed before pairing completed.'});
      }
      const updated = await client.query<{storage_lease_generation: string | number; revision: number}>(`UPDATE committees
        SET storage_lease_generation=storage_lease_generation+1,revision=revision+1,updated_at=$2
        WHERE id=$1 RETURNING storage_lease_generation,revision`, [committee.id, now]);
      const leaseGeneration = Number(updated.rows[0]?.storage_lease_generation);
      committee.revision = updated.rows[0]?.revision as number;
      if (active) {
        await client.query(`UPDATE storage_hosts SET status='REVOKED',revision=revision+1,revoked_at=$2,updated_at=$2
          WHERE id=$1`, [active.id, now]);
        await appendEvent(client, committee, {type: 'storage_host.status_changed', resourceType: 'storage_host',
          resourceId: active.id, revision: active.revision + 1, audience: 'CHAIR',
          payload: {status: 'REVOKED', leaseGeneration}});
      }
      const inserted = await client.query<HostRow>(`INSERT INTO storage_hosts
        (id,committee_id,device_id,device_label,device_public_key,credential_hash,paired_by_user_id,
         lease_generation,status,last_seen_at,paired_at,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',$9,$9,$9,$9) RETURNING *`,
      [hostId, committee.id, deviceId, label, publicKey, parsedCredential.tokenHash,
        pairing.created_by_user_id, leaseGeneration, now]);
      const manifest = await client.query<{
        kind: 'UPSERT' | 'DELETE'; file_entry_id: string; file_revision: number;
        blob_id: string | null; size_bytes: string | number | null; sha256: Buffer | null;
      }>(`SELECT DISTINCT ON (file_entry_id) kind,file_entry_id,file_revision,blob_id,size_bytes,sha256
        FROM storage_manifest_events WHERE committee_id=$1 ORDER BY file_entry_id,sequence DESC`, [committee.id]);
      for (const item of manifest.rows) {
        const allocated = await client.query<{sequence: string | number}>(`UPDATE committees
          SET next_storage_agent_task_sequence=next_storage_agent_task_sequence+1 WHERE id=$1
          RETURNING next_storage_agent_task_sequence-1 AS sequence`, [committee.id]);
        await client.query(`INSERT INTO storage_agent_tasks
          (id,committee_id,host_id,lease_generation,sequence,task_type,file_entry_id,file_revision,
           blob_id,expected_size_bytes,expected_sha256)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [randomUUID(), committee.id, hostId, leaseGeneration, allocated.rows[0]?.sequence,
          item.kind === 'UPSERT' ? 'STORE_BLOB' : 'DELETE_FILE', item.file_entry_id, item.file_revision,
          item.blob_id, item.size_bytes, item.sha256]);
      }
      await client.query('UPDATE storage_pairing_codes SET used_at=$2 WHERE id=$1', [pairing.id, now]);
      await appendEvent(client, committee, {type: 'storage_host.status_changed', resourceType: 'storage_host',
        resourceId: hostId, revision: 1, audience: 'CHAIR',
        payload: {status: 'ACTIVE', leaseGeneration, transferred: Boolean(active)}});
      await audit(client, context, {committeeId: committee.id, actorUserId: pairing.created_by_user_id,
        capabilities: [committee.owner_user_id === pairing.created_by_user_id ? 'OWNER' : 'CHAIR'],
        action: active ? 'storage.host_transferred' : 'storage.host_paired', resourceType: 'storage_host',
        resourceId: hostId, before: active ? {hostId: active.id, leaseGeneration: Number(active.lease_generation)} : null,
        after: {hostId, deviceId, deviceLabel: label, leaseGeneration}});
      return {credential, host: host(inserted.rows[0] as HostRow)};
    });
  }

  async revokeHost(auth: AuthenticatedSession, committeeId: string, hostId: string, body: unknown,
    context: Stage4Context): Promise<StorageHost> {
    requireBusinessIdentity(auth);
    assertExactBody(body as Record<string, unknown>, ['baseRevision']);
    const request = body as {baseRevision?: unknown};
    const now = this.now();
    return transaction(this.pool, async client => {
      const committee = await lockedCommittee(client, uuid(committeeId, 'Committee ID'));
      requireEditable(committee);
      await requireStorageManager(client, committee, auth.user.id);
      if (committee.revision !== revision(request.baseRevision)) {
        throw new AppError({code: 'REVISION_CONFLICT', message: 'This committee changed since it was loaded.',
          details: {currentRevision: committee.revision}});
      }
      const active = await currentHost(client, committee.id, true);
      if (!active || active.id !== uuid(hostId, 'Storage host ID')) {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Storage host is no longer active.'});
      }
      const updated = await client.query<{storage_lease_generation: string | number; revision: number}>(`UPDATE committees
        SET storage_lease_generation=storage_lease_generation+1,revision=revision+1,updated_at=$2
        WHERE id=$1 RETURNING storage_lease_generation,revision`, [committee.id, now]);
      committee.revision = updated.rows[0]?.revision as number;
      await client.query(`UPDATE storage_pairing_codes SET revoked_at=$2
        WHERE committee_id=$1 AND used_at IS NULL AND revoked_at IS NULL`, [committee.id, now]);
      const revoked = await client.query<HostRow>(`UPDATE storage_hosts
        SET status='REVOKED',revision=revision+1,revoked_at=$2,updated_at=$2 WHERE id=$1 RETURNING *`,
      [active.id, now]);
      const leaseGeneration = Number(updated.rows[0]?.storage_lease_generation);
      await appendEvent(client, committee, {type: 'storage_host.status_changed', resourceType: 'storage_host',
        resourceId: active.id, revision: active.revision + 1, audience: 'CHAIR',
        payload: {status: 'REVOKED', leaseGeneration}});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
        capabilities: [committee.owner_user_id === auth.user.id ? 'OWNER' : 'CHAIR'],
        action: 'storage.host_revoked', resourceType: 'storage_host', resourceId: active.id,
        before: {status: active.status, leaseGeneration: Number(active.lease_generation)},
        after: {status: 'REVOKED', leaseGeneration}});
      return host(revoked.rows[0] as HostRow);
    });
  }

  async authenticate(credential: string): Promise<StorageAgentIdentity> {
    const parsed = parseDeviceCredential(credential);
    if (!parsed) throw new AppError({code: 'AUTHENTICATION_REQUIRED', message: 'Agent authentication is required.'});
    const result = await this.pool.query<HostRow>(`SELECT h.*,c.storage_lease_generation AS current_lease_generation
      FROM storage_hosts h JOIN committees c ON c.id=h.committee_id WHERE h.device_id=$1`, [parsed.deviceId]);
    const row = result.rows[0];
    if (!row || !credentialMatches(row.credential_hash, parsed.tokenHash)) {
      throw new AppError({code: 'AUTHENTICATION_REQUIRED', message: 'Agent authentication is required.'});
    }
    if (row.status === 'REVOKED' || Number(row.lease_generation) !== Number(row.current_lease_generation)) {
      throw new AppError({code: 'STALE_STORAGE_LEASE', message: 'Storage host lease is no longer current.'});
    }
    return {hostId: row.id, committeeId: row.committee_id, deviceId: row.device_id,
      leaseGeneration: Number(row.lease_generation)};
  }

  async withCurrentLease<T>(credential: string, requestedGeneration: number,
    work: (client: PoolClient, lease: CurrentStorageAgentLease, committee: Stage4CommitteeRow) => Promise<T>): Promise<T> {
    const parsed = parseDeviceCredential(credential);
    if (!parsed) throw new AppError({code: 'AUTHENTICATION_REQUIRED', message: 'Agent authentication is required.'});
    const candidate = await this.pool.query<HostRow>('SELECT * FROM storage_hosts WHERE device_id=$1', [parsed.deviceId]);
    const candidateRow = candidate.rows[0];
    if (!candidateRow || !credentialMatches(candidateRow.credential_hash, parsed.tokenHash)) {
      throw new AppError({code: 'AUTHENTICATION_REQUIRED', message: 'Agent authentication is required.'});
    }
    return transaction(this.pool, async client => {
      const committee = await lockedCommittee(client, candidateRow.committee_id);
      const found = await client.query<HostRow>('SELECT * FROM storage_hosts WHERE device_id=$1 FOR UPDATE',
        [parsed.deviceId]);
      const row = found.rows[0];
      if (!row || !credentialMatches(row.credential_hash, parsed.tokenHash)) {
        throw new AppError({code: 'AUTHENTICATION_REQUIRED', message: 'Agent authentication is required.'});
      }
      if (row.status === 'REVOKED' || Number(row.lease_generation) !== requestedGeneration
        || Number(committee.storage_lease_generation) !== requestedGeneration) {
        throw new AppError({code: 'STALE_STORAGE_LEASE', message: 'Storage host lease is no longer current.'});
      }
      return work(client, {hostId: row.id, committeeId: row.committee_id, deviceId: row.device_id,
        leaseGeneration: Number(row.lease_generation), status: row.status}, committee);
    });
  }

  async heartbeat(credential: string, body: unknown): Promise<StorageHost> {
    assertExactBody(body as Record<string, unknown>, ['leaseGeneration']);
    const requestedGeneration = generation((body as {leaseGeneration?: unknown}).leaseGeneration);
    const parsed = parseDeviceCredential(credential);
    if (!parsed) throw new AppError({code: 'AUTHENTICATION_REQUIRED', message: 'Agent authentication is required.'});
    const now = this.now();
    const candidate = await this.pool.query<HostRow>('SELECT * FROM storage_hosts WHERE device_id=$1', [parsed.deviceId]);
    const candidateRow = candidate.rows[0];
    if (!candidateRow || !credentialMatches(candidateRow.credential_hash, parsed.tokenHash)) {
      throw new AppError({code: 'AUTHENTICATION_REQUIRED', message: 'Agent authentication is required.'});
    }
    return transaction(this.pool, async client => {
      const committee = await lockedCommittee(client, candidateRow.committee_id);
      const found = await client.query<HostRow>('SELECT * FROM storage_hosts WHERE device_id=$1 FOR UPDATE',
        [parsed.deviceId]);
      const row = found.rows[0];
      if (!row || !credentialMatches(row.credential_hash, parsed.tokenHash)) {
        throw new AppError({code: 'AUTHENTICATION_REQUIRED', message: 'Agent authentication is required.'});
      }
      if (row.status === 'REVOKED' || Number(row.lease_generation) !== requestedGeneration
        || Number(committee.storage_lease_generation) !== requestedGeneration) {
        throw new AppError({code: 'STALE_STORAGE_LEASE', message: 'Storage host lease is no longer current.'});
      }
      const recovered = row.status === 'DEGRADED';
      const updated = await client.query<HostRow>(`UPDATE storage_hosts SET status='ACTIVE',last_seen_at=$2,
        revision=revision+$3,updated_at=$2 WHERE id=$1 RETURNING *`, [row.id, now, recovered ? 1 : 0]);
      if (recovered) {
        await appendEvent(client, committee, {type: 'storage_host.status_changed', resourceType: 'storage_host',
          resourceId: row.id, revision: row.revision + 1, audience: 'CHAIR',
          payload: {status: 'ACTIVE', leaseGeneration: requestedGeneration}});
      }
      return host(updated.rows[0] as HostRow);
    });
  }

  async markDegradedHosts(limit = 100): Promise<number> {
    let changed = 0;
    const cutoff = new Date(this.now().getTime() - this.offlineGraceMs);
    while (changed < limit) {
      const marked = await transaction(this.pool, async client => {
        const candidate = await client.query<{id: string; committee_id: string}>(`SELECT id,committee_id
          FROM storage_hosts WHERE status='ACTIVE' AND COALESCE(last_seen_at,paired_at)<$1
          ORDER BY COALESCE(last_seen_at,paired_at),id LIMIT 1`, [cutoff]);
        if (!candidate.rows[0]) return false;
        const committee = await lockedCommittee(client, candidate.rows[0].committee_id);
        const found = await client.query<HostRow>(`SELECT * FROM storage_hosts WHERE id=$1 AND status='ACTIVE'
          AND COALESCE(last_seen_at,paired_at)<$2 FOR UPDATE`, [candidate.rows[0].id, cutoff]);
        const row = found.rows[0];
        if (!row) return false;
        await client.query(`UPDATE storage_hosts SET status='DEGRADED',revision=revision+1,updated_at=$2
          WHERE id=$1`, [row.id, this.now()]);
        await appendEvent(client, committee, {type: 'storage_host.status_changed', resourceType: 'storage_host',
          resourceId: row.id, revision: row.revision + 1, audience: 'CHAIR',
          payload: {status: 'DEGRADED', leaseGeneration: Number(row.lease_generation)}});
        return true;
      });
      if (!marked) break;
      changed += 1;
    }
    return changed;
  }
}

export function startStorageHostMonitor(service: Stage7StorageAgentService, logger: Logger,
  intervalMs = 15_000): () => void {
  let stopped = false;
  let running = false;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    void service.markDegradedHosts().then(count => {
      if (count > 0) logger.warn('storage_agent.hosts_degraded', {count});
    }).catch(error => logger.error('storage_agent.monitor_failed', {error})).finally(() => {running = false;});
  }, intervalMs);
  timer.unref();
  return () => {stopped = true; clearInterval(timer);};
}
