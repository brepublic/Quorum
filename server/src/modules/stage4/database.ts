import {createHash, randomUUID} from 'node:crypto';
import type {Pool, PoolClient, QueryResultRow} from 'pg';
import {AppError} from '../../http/errors.js';
import type {AuthenticatedSession} from '../identity/store.js';

export type Stage4Context = {requestId: string; sourceIp?: string; userAgent?: string};

export interface Stage4CommitteeRow extends QueryResultRow {
  id: string;
  owner_user_id: string;
  name: string;
  chair_label: string;
  topic: string;
  conference: string;
  visibility: 'PUBLIC' | 'PRIVATE';
  operation_mode: 'DELEGATE_OPERATED' | 'CHAIR_OPERATED';
  delegate_motion_proposals_enabled: boolean;
  delegate_motion_voting_enabled: boolean;
  move_queue_up: boolean;
  timers_in_separate_columns: boolean;
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED' | 'DELETING';
  active_rule_package_version_id: string;
  active_storage_binding_id: string | null;
  file_manifest_revision: number;
  storage_lease_generation: string | number;
  revision: number;
  next_event_sequence: string | number;
}

export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    if ((error as {code?: string}).code === '23505') {
      throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The requested resource already exists.'});
    }
    if (['23503', '23514', '22P02'].includes((error as {code?: string}).code ?? '')) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'The request contains an invalid reference or value.'});
    }
    throw error;
  } finally {
    client.release();
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])
  );
  return value;
}

export function requestHash(value: unknown): Buffer {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest();
}

export function idempotencyLockKey(userId: string, route: string, key: string): string {
  return JSON.stringify([userId, route, key]);
}

export async function idempotentTransaction<T>(input: {
  pool: Pool;
  auth: AuthenticatedSession;
  route: string;
  key: string;
  request: unknown;
  status: number;
  work: (client: PoolClient) => Promise<T>;
}): Promise<T> {
  if (!input.key || input.key.length > 200) {
    throw new AppError({code: 'BAD_REQUEST', message: 'Idempotency-Key is required.'});
  }
  const hash = requestHash(input.request);
  return transaction(input.pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [idempotencyLockKey(input.auth.user.id, input.route, input.key)]);
    const existing = await client.query<{request_hash: Buffer; response_body: T}>(`SELECT request_hash,response_body
      FROM idempotency_keys WHERE user_id=$1 AND route=$2 AND key=$3`,
    [input.auth.user.id, input.route, input.key]);
    if (existing.rows[0]) {
      if (!existing.rows[0].request_hash.equals(hash)) {
        throw new AppError({code: 'IDEMPOTENCY_CONFLICT', message: 'Idempotency key was already used for another request.'});
      }
      return existing.rows[0].response_body;
    }
    const result = await input.work(client);
    await client.query(`INSERT INTO idempotency_keys
      (user_id,route,key,request_hash,response_status,response_body,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,now()+interval '24 hours')`,
    [input.auth.user.id, input.route, input.key, hash, input.status, result]);
    return result;
  });
}

export function requireBusinessIdentity(auth: AuthenticatedSession): void {
  if (auth.user.mustChangePassword) {
    throw new AppError({code: 'FORBIDDEN', message: 'Change the temporary password first.'});
  }
}

export async function lockedCommittee(client: PoolClient, committeeId: string): Promise<Stage4CommitteeRow> {
  const result = await client.query<Stage4CommitteeRow>('SELECT * FROM committees WHERE id=$1 FOR UPDATE', [committeeId]);
  const row = result.rows[0];
  if (!row) throw new AppError({code: 'NOT_FOUND', message: 'Committee not found.'});
  return row;
}

export function requireEditable(row: Stage4CommitteeRow): void {
  if (row.status === 'ARCHIVED' || row.status === 'DELETING') {
    throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The committee is read-only.'});
  }
}

export function requireProceedingsActive(row: Stage4CommitteeRow): void {
  requireEditable(row);
  if (row.status === 'PAUSED') {
    throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The committee is paused.'});
  }
}

export async function isChair(client: PoolClient, committeeId: string, userId: string): Promise<boolean> {
  const result = await client.query(`SELECT 1 FROM committee_capabilities c JOIN users u ON u.id=c.user_id
    WHERE c.committee_id=$1 AND c.user_id=$2 AND c.capability='CHAIR' AND c.revoked_at IS NULL
      AND u.is_system_admin=false`, [committeeId, userId]);
  return Boolean(result.rowCount);
}

export async function requireChair(client: PoolClient, row: Stage4CommitteeRow, userId: string): Promise<void> {
  if (!(await isChair(client, row.id, userId))) {
    throw new AppError({code: 'FORBIDDEN', message: 'Chair capability is required.'});
  }
}

export async function activeSeat(client: PoolClient, committeeId: string, userId: string): Promise<string | null> {
  const result = await client.query<{seat_id: string}>(`SELECT a.seat_id FROM committee_memberships m
    JOIN seat_assignments a ON a.committee_id=m.committee_id AND a.user_id=m.user_id AND a.status='ACTIVE'
    JOIN committee_seats s ON s.id=a.seat_id AND s.active=true
    WHERE m.committee_id=$1 AND m.user_id=$2 AND m.status='ACTIVE'`, [committeeId, userId]);
  return result.rows[0]?.seat_id ?? null;
}

export async function audit(client: PoolClient, context: Stage4Context, input: {
  committeeId?: string; actorUserId: string; capabilities: string[]; onBehalfOfSeatId?: string;
  action: string; resourceType: string; resourceId?: string; before?: unknown; after?: unknown;
}): Promise<void> {
  await client.query(`INSERT INTO audit_log
    (id,request_id,committee_id,actor_user_id,effective_capabilities,on_behalf_of_seat_id,action,
     resource_type,resource_id,result,before_summary,after_summary,user_agent_summary)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'SUCCEEDED',$10,$11,$12)`,
  [randomUUID(), context.requestId, input.committeeId ?? null, input.actorUserId, input.capabilities,
    input.onBehalfOfSeatId ?? null, input.action, input.resourceType, input.resourceId ?? null,
    input.before ?? null, input.after ?? null, context.userAgent?.slice(0, 240) ?? null]);
}

export async function appendEvent(client: PoolClient, row: Stage4CommitteeRow, input: {
  type: string; resourceType: string; resourceId: string; revision: number;
  audience?: 'PUBLIC' | 'MEMBER' | 'CHAIR'; payload?: Record<string, unknown>;
}): Promise<number> {
  const sequence = Number(row.next_event_sequence);
  await client.query('UPDATE committees SET next_event_sequence=next_event_sequence+1 WHERE id=$1', [row.id]);
  row.next_event_sequence = sequence + 1;
  await client.query(`INSERT INTO committee_events
    (committee_id,sequence,event_type,resource_type,resource_id,resource_revision,payload,audience)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
  [row.id, sequence, input.type, input.resourceType, input.resourceId, input.revision,
    input.payload ?? {}, input.audience ?? 'MEMBER']);
  await client.query("SELECT pg_notify('quorum_committee_events', $1)", [row.id]);
  return sequence;
}
