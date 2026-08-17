import type {Pool, QueryResultRow} from 'pg';
import type {CommitteeEventEnvelope, EventAudience} from '@quorum/contracts';
import {AppError} from '../../http/errors.js';
import type {AuthenticatedSession} from '../identity/store.js';

export type RealtimeAudience = 'PUBLIC' | 'MEMBER' | 'CHAIR' | 'OWNER';

interface CommitteeCursorRow extends QueryResultRow {
  visibility: 'PUBLIC' | 'PRIVATE';
  owner_user_id: string;
  next_event_sequence: string | number;
  events_retained_from_sequence: string | number;
}

interface EventRow extends QueryResultRow {
  sequence: string | number;
  event_type: string;
  resource_type: string;
  resource_id: string;
  resource_revision: number;
  payload: Record<string, unknown>;
  audience: EventAudience;
  created_at: Date;
}

function parsedCursor(value: string | undefined): number | undefined {
  if (value === undefined || !/^(0|[1-9]\d*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function selectEventCursor(input: {
  after?: string;
  lastEventId?: string;
  latestSequence: number;
  retainedFromSequence: number;
}): number {
  const supplied = [parsedCursor(input.after), parsedCursor(input.lastEventId)]
    .filter((value): value is number => value !== undefined);
  if (supplied.length === 0) {
    if (input.after !== undefined || input.lastEventId !== undefined) {
      throw new AppError({code: 'BAD_REQUEST', message: 'The event cursor is invalid.'});
    }
    return input.latestSequence;
  }
  const valid = supplied.filter(value => value <= input.latestSequence && value >= input.retainedFromSequence - 1);
  if (valid.length > 0) return Math.max(...valid);
  if (supplied.some(value => value < input.retainedFromSequence - 1)) {
    throw new AppError({code: 'CURSOR_EXPIRED', message: 'The event cursor expired. Reload the committee snapshot.',
      details: {retainedFromSequence: input.retainedFromSequence}});
  }
  throw new AppError({code: 'BAD_REQUEST', message: 'The event cursor is ahead of the committee.'});
}

function mayReceive(viewer: RealtimeAudience, event: EventAudience): boolean {
  if (event === 'PUBLIC') return true;
  if (event === 'MEMBER') return viewer !== 'PUBLIC';
  return viewer === 'CHAIR' || viewer === 'OWNER';
}

export class RealtimeService {
  constructor(private readonly pool: Pool) {}

  async authorize(committeeId: string, auth?: AuthenticatedSession): Promise<{
    audience: RealtimeAudience;
    latestSequence: number;
    retainedFromSequence: number;
  }> {
    const committee = await this.pool.query<CommitteeCursorRow>(`SELECT visibility,owner_user_id,next_event_sequence,
      events_retained_from_sequence FROM committees WHERE id=$1`, [committeeId]);
    const row = committee.rows[0];
    if (!row) throw new AppError({code: 'NOT_FOUND', message: 'Committee not found.'});
    const cursor = {latestSequence: Number(row.next_event_sequence) - 1,
      retainedFromSequence: Number(row.events_retained_from_sequence)};
    if (auth?.user.id === row.owner_user_id) return {audience: 'OWNER', ...cursor};
    if (auth) {
      const chair = await this.pool.query(`SELECT 1 FROM committee_capabilities c JOIN users u ON u.id=c.user_id
        WHERE c.committee_id=$1 AND c.user_id=$2 AND c.capability='CHAIR' AND c.revoked_at IS NULL
          AND u.is_system_admin=false`, [committeeId, auth.user.id]);
      if (chair.rowCount) return {audience: 'CHAIR', ...cursor};
      const member = await this.pool.query(`SELECT 1 FROM committee_memberships
        WHERE committee_id=$1 AND user_id=$2 AND status='ACTIVE'`, [committeeId, auth.user.id]);
      if (member.rowCount) return {audience: 'MEMBER', ...cursor};
    }
    if (row.visibility === 'PUBLIC') return {audience: 'PUBLIC', ...cursor};
    throw new AppError({code: 'NOT_FOUND', message: 'Committee not found.'});
  }

  async events(committeeId: string, after: number, audience: RealtimeAudience, limit = 250): Promise<CommitteeEventEnvelope[]> {
    const result = await this.pool.query<EventRow>(`SELECT sequence,event_type,resource_type,resource_id,
      resource_revision,payload,audience,created_at FROM committee_events
      WHERE committee_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3`, [committeeId, after, limit]);
    return result.rows.map(row => mayReceive(audience, row.audience) ? {
      id: Number(row.sequence), type: row.event_type, committeeId, resourceType: row.resource_type,
      resourceId: row.resource_id, resourceRevision: row.resource_revision, audience: row.audience,
      payload: row.payload, createdAt: row.created_at.toISOString()
    } : {
      id: Number(row.sequence), type: 'sync.cursor_advanced', committeeId, resourceType: null,
      resourceId: null, resourceRevision: null, audience: 'PUBLIC', payload: {},
      createdAt: row.created_at.toISOString()
    });
  }
}
