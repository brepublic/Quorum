import {randomUUID} from 'node:crypto';
import type {Pool, PoolClient, QueryResultRow} from 'pg';
import type {AuthoritativeTimer, SpeakerList, SpeakerListKind, SpeakerQueueEntry, SpeechRecord, TimerOwnerType,
  YieldType} from '@quorum/contracts';
import {AppError} from '../../http/errors.js';
import type {AuthenticatedSession} from '../identity/store.js';
import {activeSeat, appendEvent, audit, idempotentTransaction, isChair, lockedCommittee, requireBusinessIdentity,
  requireChair, requireProceedingsActive, transaction, type Stage4Context} from '../stage4/database.js';
import {assertExactBody} from '../stage4/validation.js';

interface TimerRow extends QueryResultRow {
  id: string;
  committee_id: string;
  owner_type: TimerOwnerType;
  owner_id: string;
  running: boolean;
  started_at: Date | null;
  remaining_at_start_ms: string | number;
  revision: number;
  expired_at: Date | null;
}

interface SpeakerListRow extends QueryResultRow {
  id: string; committee_id: string; meeting_session_id: string; kind: SpeakerListKind; status: 'OPEN' | 'CLOSED';
  topic: string; default_speech_ms: string | number; rule_package_version_id: string; current_entry_id: string | null;
  speech_timer_id: string; total_timer_id: string | null; revision: number; created_at: Date; closed_at: Date | null;
}

interface SpeakerEntryRow extends QueryResultRow {
  id: string; seat_id: string; seat_display_name: string; position: number;
  status: SpeakerQueueEntry['status']; created_at: Date;
}

interface SpeechRow extends QueryResultRow {
  id: string; speaker_list_id: string; queue_entry_id: string; seat_id: string; seat_display_name: string;
  kind: SpeechRecord['kind']; status: SpeechRecord['status']; inherited_from_speech_id: string | null;
  inherited_time_ms: string | number | null; can_yield: boolean; yield_type: YieldType | null;
  yield_target_seat_id: string | null; revision: number; started_at: Date | null; ended_at: Date | null;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new AppError({code: 'VALIDATION_FAILED', message: `${name} is invalid.`});
  }
  return Number(value);
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError({code: 'VALIDATION_FAILED', message: `${name} is invalid.`});
  }
  return value;
}

function text(value: unknown, name: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) {
    throw new AppError({code: 'VALIDATION_FAILED', message: `${name} is invalid.`});
  }
  return allowEmpty ? value : value.trim();
}

async function speakerListState(client: PoolClient, row: SpeakerListRow): Promise<SpeakerList> {
  const entries = await client.query<SpeakerEntryRow>(`SELECT id,seat_id,seat_display_name,position,status,created_at
    FROM speaker_queue_entries WHERE speaker_list_id=$1 ORDER BY position,created_at,id`, [row.id]);
  const speeches = await client.query<SpeechRow>('SELECT * FROM speeches WHERE speaker_list_id=$1 ORDER BY created_at,id', [row.id]);
  return {id: row.id, committeeId: row.committee_id, meetingSessionId: row.meeting_session_id, kind: row.kind,
    status: row.status, topic: row.topic, defaultSpeechMs: Number(row.default_speech_ms),
    rulePackageVersionId: row.rule_package_version_id, currentEntryId: row.current_entry_id,
    speechTimerId: row.speech_timer_id, totalTimerId: row.total_timer_id, revision: row.revision,
    queue: entries.rows.map(entry => ({id: entry.id, seatId: entry.seat_id, seatDisplayName: entry.seat_display_name,
      position: entry.position, status: entry.status, createdAt: entry.created_at.toISOString()})),
    createdAt: row.created_at.toISOString(), closedAt: row.closed_at?.toISOString() ?? null,
    speeches: await Promise.all(speeches.rows.map(speech => speechState(client, speech)))};
}

async function speechState(client: PoolClient, row: SpeechRow): Promise<SpeechRecord> {
  const [actions, contributions] = await Promise.all([
    client.query<{id: string; action: SpeechRecord['actions'][number]['action']; remaining_ms: string | number;
      target_type: YieldType | null; target_seat_id: string | null; created_at: Date}>(`SELECT id,action,remaining_ms,
      target_type,target_seat_id,created_at FROM speech_actions WHERE speech_id=$1 ORDER BY created_at,id`, [row.id]),
    client.query<{id: string; type: 'QUESTION' | 'COMMENT'; seat_id: string; seat_display_name: string; content: string;
      created_at: Date}>(`SELECT id,type,seat_id,seat_display_name,content,created_at FROM speech_contributions
      WHERE speech_id=$1 ORDER BY created_at,id`, [row.id])
  ]);
  return {id: row.id, speakerListId: row.speaker_list_id, queueEntryId: row.queue_entry_id, seatId: row.seat_id,
    seatDisplayName: row.seat_display_name, kind: row.kind, status: row.status,
    inheritedFromSpeechId: row.inherited_from_speech_id, inheritedTimeMs: row.inherited_time_ms === null ? null : Number(row.inherited_time_ms),
    canYield: row.can_yield, yieldType: row.yield_type, yieldTargetSeatId: row.yield_target_seat_id,
    revision: row.revision, startedAt: row.started_at?.toISOString() ?? null, endedAt: row.ended_at?.toISOString() ?? null,
    actions: actions.rows.map(action => ({id: action.id, action: action.action, remainingMs: Number(action.remaining_ms),
      targetType: action.target_type, targetSeatId: action.target_seat_id, createdAt: action.created_at.toISOString()})),
    contributions: contributions.rows.map(item => ({id: item.id, type: item.type, seatId: item.seat_id,
      seatDisplayName: item.seat_display_name, content: item.content, createdAt: item.created_at.toISOString()}))};
}

async function renumberActiveQueue(client: PoolClient, listId: string): Promise<void> {
  await client.query(`UPDATE speaker_queue_entries SET position=position+1000000
    WHERE speaker_list_id=$1 AND status IN ('QUEUED','CURRENT')`, [listId]);
  await client.query(`WITH ranked AS (SELECT id,row_number() OVER
      (ORDER BY CASE status WHEN 'CURRENT' THEN 0 ELSE 1 END,position,created_at,id)::integer AS next_position
      FROM speaker_queue_entries WHERE speaker_list_id=$1 AND status IN ('QUEUED','CURRENT'))
    UPDATE speaker_queue_entries q SET position=ranked.next_position FROM ranked WHERE q.id=ranked.id`, [listId]);
}

export function remainingTimerMs(row: Pick<TimerRow, 'running' | 'started_at' | 'remaining_at_start_ms'>, now: Date): number {
  const initial = Number(row.remaining_at_start_ms);
  if (!row.running || !row.started_at) return initial;
  return Math.max(0, initial - Math.max(0, now.getTime() - row.started_at.getTime()));
}

export function timerState(row: TimerRow, now: Date): AuthoritativeTimer {
  return {id: row.id, committeeId: row.committee_id, ownerType: row.owner_type, ownerId: row.owner_id,
    running: row.running && remainingTimerMs(row, now) > 0, startedAt: row.started_at?.toISOString() ?? null,
    remainingAtStartMs: Number(row.remaining_at_start_ms), remainingMs: remainingTimerMs(row, now),
    revision: row.revision, expiredAt: row.expired_at?.toISOString() ?? null, serverTime: now.toISOString()};
}

export function canYieldSpeech(speech: Pick<SpeechRow, 'kind' | 'can_yield' | 'status'>,
  remainingMs: number, timerRunning: boolean): boolean {
  return speech.kind === 'ORIGINAL' && speech.can_yield && speech.status === 'PAUSED'
    && remainingMs > 1_000 && !timerRunning;
}

export class Stage5Service {
  constructor(private readonly pool: Pool, private readonly now: () => Date = () => new Date()) {}

  async createTimer(auth: AuthenticatedSession, committeeId: string, input: Record<string, unknown>, key: string,
    context: Stage4Context): Promise<AuthoritativeTimer> {
    requireBusinessIdentity(auth); assertExactBody(input, ['ownerType', 'ownerId', 'durationMs']);
    const ownerType = input.ownerType as TimerOwnerType;
    if (!['COMMITTEE', 'SPEAKER_LIST', 'CAUCUS', 'SPEECH'].includes(ownerType)) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Timer owner type is invalid.'});
    }
    const ownerId = uuid(input.ownerId, 'Timer owner ID'); const durationMs = positiveInteger(input.durationMs, 'Duration');
    return idempotentTransaction({pool: this.pool, auth, route: `POST /api/v1/committees/${committeeId}/timers`,
      key, request: input, status: 201, work: async client => {
        const committee = await lockedCommittee(client, committeeId); requireProceedingsActive(committee);
        await requireChair(client, committee, auth.user.id);
        const id = randomUUID(); const result = await client.query<TimerRow>(`INSERT INTO timer_states
          (id,committee_id,owner_type,owner_id,remaining_at_start_ms,created_by_user_id)
          VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [id, committeeId, ownerType, ownerId, durationMs, auth.user.id]);
        await appendEvent(client, committee, {type: 'timer.changed', resourceType: 'timer', resourceId: id, revision: 1,
          payload: {command: 'CREATED', ownerType, ownerId, running: false, remainingMs: durationMs}});
        await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['CHAIR'],
          action: 'timers.created', resourceType: 'timer', resourceId: id,
          after: {ownerType, ownerId, durationMs, revision: 1}});
        return timerState(result.rows[0] as TimerRow, this.now());
      }});
  }

  async commandTimer(auth: AuthenticatedSession, timerId: string, command: 'start' | 'pause' | 'resume' | 'extend' | 'reset' | 'expire',
    input: Record<string, unknown>, context: Stage4Context): Promise<AuthoritativeTimer> {
    requireBusinessIdentity(auth);
    assertExactBody(input, command === 'extend' ? ['baseRevision', 'durationMs']
      : command === 'reset' ? ['baseRevision', 'durationMs'] : ['baseRevision']);
    const baseRevision = positiveInteger(input.baseRevision, 'Base revision');
    const durationMs = command === 'extend' || command === 'reset' ? positiveInteger(input.durationMs, 'Duration') : undefined;
    return transaction(this.pool, async client => {
      const located = await client.query<{committee_id: string}>('SELECT committee_id FROM timer_states WHERE id=$1', [timerId]);
      if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Timer not found.'});
      const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
      await requireChair(client, committee, auth.user.id);
      const found = await client.query<TimerRow>('SELECT * FROM timer_states WHERE id=$1 FOR UPDATE', [timerId]);
      const current = found.rows[0] as TimerRow;
      if (current.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT',
        message: 'This timer changed since it was loaded.', details: {currentRevision: current.revision}});
      const now = this.now(); const remaining = remainingTimerMs(current, now);
      let running = current.running; let startedAt: Date | null = current.started_at; let nextRemaining = remaining;
      let expiredAt: Date | null = current.expired_at;
      if (command === 'start' || command === 'resume') {
        if (current.running) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The timer is already running.'});
        if (remaining <= 0) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Reset or extend the timer before starting it.'});
        running = true; startedAt = now; expiredAt = null;
      } else if (command === 'pause') {
        if (!current.running) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The timer is not running.'});
        running = false; startedAt = null;
      } else if (command === 'extend') {
        nextRemaining = remaining + (durationMs as number); startedAt = current.running ? now : null; expiredAt = null;
      } else if (command === 'reset') {
        running = false; startedAt = null; nextRemaining = durationMs as number; expiredAt = null;
      } else {
        if (!current.running || remaining > 0) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The timer has not expired.'});
        running = false; startedAt = null; nextRemaining = 0; expiredAt = now;
      }
      const updated = await client.query<TimerRow>(`UPDATE timer_states SET running=$2,started_at=$3,
        remaining_at_start_ms=$4,expired_at=$5,revision=revision+1,updated_at=$6 WHERE id=$1 RETURNING *`,
      [timerId, running, startedAt, nextRemaining, expiredAt, now]);
      const revision = current.revision + 1; const action = command === 'start' ? 'started' : command === 'pause' ? 'paused'
        : command === 'resume' ? 'resumed' : command === 'extend' ? 'extended' : command === 'reset' ? 'reset' : 'expired';
      await appendEvent(client, committee, {type: command === 'expire' ? 'timer.expired' : 'timer.changed',
        resourceType: 'timer', resourceId: timerId, revision,
        payload: {command: command.toUpperCase(), running, remainingMs: nextRemaining}});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: `timers.${action}`, resourceType: 'timer', resourceId: timerId,
        before: {running: current.running, remainingMs: remaining, revision: current.revision},
        after: {running, remainingMs: nextRemaining, revision}});
      return timerState(updated.rows[0] as TimerRow, now);
    });
  }

  async createSpeakerList(auth: AuthenticatedSession, committeeId: string, input: Record<string, unknown>, key: string,
    context: Stage4Context): Promise<SpeakerList> {
    requireBusinessIdentity(auth);
    assertExactBody(input, ['meetingSessionId', 'kind', 'topic', 'defaultSpeechMs', 'totalDurationMs']);
    const meetingSessionId = uuid(input.meetingSessionId, 'Meeting session ID'); const kind = input.kind as SpeakerListKind;
    if (!['GENERAL', 'MODERATED_CAUCUS'].includes(kind)) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Speaker list kind is invalid.'});
    }
    const topic = text(input.topic ?? '', 'Topic', 500, kind === 'GENERAL');
    const defaultSpeechMs = positiveInteger(input.defaultSpeechMs, 'Speech duration');
    const totalDurationMs = kind === 'MODERATED_CAUCUS' ? positiveInteger(input.totalDurationMs, 'Caucus duration') : null;
    if (totalDurationMs !== null && totalDurationMs < defaultSpeechMs) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Caucus duration must allow one complete speech.'});
    }
    return idempotentTransaction({pool: this.pool, auth, route: `POST /api/v1/committees/${committeeId}/speaker-lists`,
      key, request: input, status: 201, work: async client => {
        const committee = await lockedCommittee(client, committeeId); requireProceedingsActive(committee);
        await requireChair(client, committee, auth.user.id);
        const session = await client.query<{active_rule_package_version_id: string; status: string}>(`SELECT status,
          active_rule_package_version_id FROM meeting_sessions WHERE id=$1 AND committee_id=$2`, [meetingSessionId, committeeId]);
        if (!session.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Meeting session not found.'});
        if (session.rows[0].status !== 'OPEN') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Meeting session is closed.'});
        const listId = randomUUID(); const speechTimerId = randomUUID(); const caucusId = randomUUID();
        const totalTimerId = kind === 'MODERATED_CAUCUS' ? randomUUID() : null;
        await client.query(`INSERT INTO timer_states
          (id,committee_id,owner_type,owner_id,remaining_at_start_ms,created_by_user_id)
          VALUES ($1,$2,'SPEAKER_LIST',$3,$4,$5)`, [speechTimerId, committeeId, listId, defaultSpeechMs, auth.user.id]);
        if (totalTimerId) await client.query(`INSERT INTO timer_states
          (id,committee_id,owner_type,owner_id,remaining_at_start_ms,created_by_user_id)
          VALUES ($1,$2,'CAUCUS',$3,$4,$5)`, [totalTimerId, committeeId, caucusId, totalDurationMs, auth.user.id]);
        const inserted = await client.query<SpeakerListRow>(`INSERT INTO speaker_lists
          (id,committee_id,meeting_session_id,kind,topic,default_speech_ms,rule_package_version_id,
           speech_timer_id,total_timer_id,created_by_user_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [listId, committeeId, meetingSessionId, kind, topic, defaultSpeechMs,
          session.rows[0].active_rule_package_version_id, speechTimerId, totalTimerId, auth.user.id]);
        if (totalTimerId) await client.query(`INSERT INTO caucuses
          (id,committee_id,meeting_session_id,speaker_list_id,topic,total_timer_id,speech_timer_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`, [caucusId, committeeId, meetingSessionId, listId, topic, totalTimerId, speechTimerId]);
        await appendEvent(client, committee, {type: 'speaker_list.created', resourceType: 'speaker_list', resourceId: listId,
          revision: 1, payload: {kind, topic, defaultSpeechMs, totalDurationMs,
            rulePackageVersionId: session.rows[0].active_rule_package_version_id}, audience: 'PUBLIC'});
        await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['CHAIR'],
          action: 'proceedings.speaker_list_created', resourceType: 'speaker_list', resourceId: listId,
          after: {kind, topic, defaultSpeechMs, totalDurationMs, revision: 1}});
        return speakerListState(client, inserted.rows[0] as SpeakerListRow);
      }});
  }

  async joinSpeakerQueue(auth: AuthenticatedSession, listId: string, input: Record<string, unknown>, key: string,
    context: Stage4Context): Promise<SpeakerList> {
    requireBusinessIdentity(auth); assertExactBody(input, ['seatId']);
    return idempotentTransaction({pool: this.pool, auth, route: `POST /api/v1/speaker-lists/${listId}/queue`,
      key, request: input, status: 201, work: async client => {
        const located = await client.query<{committee_id: string}>('SELECT committee_id FROM speaker_lists WHERE id=$1', [listId]);
        if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Speaker list not found.'});
        const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
        const listResult = await client.query<SpeakerListRow>('SELECT * FROM speaker_lists WHERE id=$1 FOR UPDATE', [listId]);
        const list = listResult.rows[0] as SpeakerListRow;
        if (list.status !== 'OPEN') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Speaker list is closed.'});
        const chair = await isChair(client, committee.id, auth.user.id); const requested = input.seatId;
        let seatId: string | null;
        if (chair) seatId = uuid(requested, 'Seat ID');
        else {
          if (committee.operation_mode === 'CHAIR_OPERATED') {
            throw new AppError({code: 'FORBIDDEN', message: 'Chair capability is required in Chair-operated mode.'});
          }
          if (requested !== undefined) throw new AppError({code: 'FORBIDDEN', message: 'A delegate cannot choose another seat.'});
          seatId = await activeSeat(client, committee.id, auth.user.id);
        }
        if (!seatId) throw new AppError({code: 'FORBIDDEN', message: 'An active seat assignment is required.'});
        const seat = await client.query<{display_name: string}>(`SELECT s.display_name FROM committee_seats s
          JOIN current_attendance a ON a.seat_id=s.id AND a.meeting_session_id=$3 AND a.state='PRESENT'
          WHERE s.id=$1 AND s.committee_id=$2 AND s.active=true`, [seatId, committee.id, list.meeting_session_id]);
        if (!seat.rows[0]) throw new AppError({code: 'VALIDATION_FAILED', message: 'Only a present active seat may join the queue.'});
        const duplicate = await client.query(`SELECT 1 FROM speaker_queue_entries WHERE speaker_list_id=$1 AND seat_id=$2
          AND status IN ('QUEUED','CURRENT')`, [listId, seatId]);
        if (duplicate.rowCount) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The seat is already in the queue.'});
        const position = await client.query<{next: number}>(`SELECT coalesce(max(position),0)+1 AS next FROM speaker_queue_entries
          WHERE speaker_list_id=$1 AND status IN ('QUEUED','CURRENT')`, [listId]);
        const entryId = randomUUID(); await client.query(`INSERT INTO speaker_queue_entries
          (id,committee_id,speaker_list_id,seat_id,seat_display_name,position,actor_user_id,on_behalf_of_seat_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$4)`, [entryId, committee.id, listId, seatId, seat.rows[0].display_name,
          position.rows[0]?.next ?? 1, auth.user.id]);
        const updated = await client.query<SpeakerListRow>('UPDATE speaker_lists SET revision=revision+1 WHERE id=$1 RETURNING *', [listId]);
        await appendEvent(client, committee, {type: 'speaker_queue.changed', resourceType: 'speaker_list', resourceId: listId,
          revision: list.revision + 1, payload: {command: 'JOINED', entryId, seatId}, audience: 'PUBLIC'});
        await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
          capabilities: chair ? ['CHAIR'] : ['MEMBER'], onBehalfOfSeatId: seatId,
          action: 'proceedings.speaker_joined_queue', resourceType: 'speaker_list', resourceId: listId,
          after: {entryId, seatId, revision: list.revision + 1}});
        return speakerListState(client, updated.rows[0] as SpeakerListRow);
      }});
  }

  async reorderSpeakerQueue(auth: AuthenticatedSession, listId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<SpeakerList> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision', 'entryIds']);
    const baseRevision = positiveInteger(input.baseRevision, 'Base revision');
    if (!Array.isArray(input.entryIds) || input.entryIds.some(id => typeof id !== 'string')) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Queue order is invalid.'});
    }
    const entryIds = input.entryIds as string[];
    return transaction(this.pool, async client => {
      const located = await client.query<{committee_id: string}>('SELECT committee_id FROM speaker_lists WHERE id=$1', [listId]);
      if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Speaker list not found.'});
      const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
      await requireChair(client, committee, auth.user.id);
      const listResult = await client.query<SpeakerListRow>('SELECT * FROM speaker_lists WHERE id=$1 FOR UPDATE', [listId]);
      const list = listResult.rows[0] as SpeakerListRow;
      if (list.status !== 'OPEN') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Speaker list is closed.'});
      if (list.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT',
        message: 'This speaker list changed since it was loaded.', details: {currentRevision: list.revision}});
      const queued = await client.query<{id: string}>(`SELECT id FROM speaker_queue_entries
        WHERE speaker_list_id=$1 AND status='QUEUED' ORDER BY position`, [listId]);
      if (entryIds.length !== queued.rowCount || new Set(entryIds).size !== entryIds.length
        || queued.rows.some(row => !entryIds.includes(row.id))) {
        throw new AppError({code: 'VALIDATION_FAILED', message: 'Queue order must contain every waiting speaker once.'});
      }
      await client.query(`UPDATE speaker_queue_entries SET position=position+1000000
        WHERE speaker_list_id=$1 AND status='QUEUED'`, [listId]);
      const offset = list.current_entry_id ? 1 : 0;
      for (const [index, entryId] of entryIds.entries()) {
        await client.query(`UPDATE speaker_queue_entries SET position=$3 WHERE speaker_list_id=$1 AND id=$2 AND status='QUEUED'`,
          [listId, entryId, index + 1 + offset]);
      }
      const updated = await client.query<SpeakerListRow>('UPDATE speaker_lists SET revision=revision+1 WHERE id=$1 RETURNING *', [listId]);
      await appendEvent(client, committee, {type: 'speaker_queue.changed', resourceType: 'speaker_list', resourceId: listId,
        revision: list.revision + 1, payload: {command: 'REORDERED'}, audience: 'PUBLIC'});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: 'proceedings.speaker_queue_reordered', resourceType: 'speaker_list', resourceId: listId,
        before: {revision: list.revision}, after: {revision: list.revision + 1, entryIds}});
      return speakerListState(client, updated.rows[0] as SpeakerListRow);
    });
  }

  async advanceSpeakerQueue(auth: AuthenticatedSession, listId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<SpeakerList> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision']);
    const baseRevision = positiveInteger(input.baseRevision, 'Base revision');
    return transaction(this.pool, async client => {
      const located = await client.query<{committee_id: string}>('SELECT committee_id FROM speaker_lists WHERE id=$1', [listId]);
      if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Speaker list not found.'});
      const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
      await requireChair(client, committee, auth.user.id);
      const listResult = await client.query<SpeakerListRow>('SELECT * FROM speaker_lists WHERE id=$1 FOR UPDATE', [listId]);
      const list = listResult.rows[0] as SpeakerListRow;
      if (list.status !== 'OPEN') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Speaker list is closed.'});
      if (list.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT',
        message: 'This speaker list changed since it was loaded.', details: {currentRevision: list.revision}});
      const speechTimer = await client.query<TimerRow>('SELECT * FROM timer_states WHERE id=$1 FOR UPDATE', [list.speech_timer_id]);
      if (speechTimer.rows[0]?.running) throw new AppError({code: 'RESOURCE_CONFLICT',
        message: 'Pause the current speech before advancing the list.'});
      const unfinishedSpeech = await client.query(`SELECT 1 FROM speeches WHERE speaker_list_id=$1
        AND status IN ('READY','RUNNING','PAUSED')`, [listId]);
      if (unfinishedSpeech.rowCount) throw new AppError({code: 'RESOURCE_CONFLICT',
        message: 'Complete the current speech before advancing the list.'});
      const now = this.now();
      if (list.current_entry_id) await client.query(`UPDATE speaker_queue_entries SET status='COMPLETED',completed_at=$2
        WHERE id=$1 AND status='CURRENT'`, [list.current_entry_id, now]);
      let closeCaucus = false;
      if (list.kind === 'MODERATED_CAUCUS' && list.total_timer_id) {
        const total = await client.query<TimerRow>('SELECT * FROM timer_states WHERE id=$1 FOR UPDATE', [list.total_timer_id]);
        closeCaucus = !total.rows[0] || remainingTimerMs(total.rows[0], now) < Number(list.default_speech_ms);
      }
      let nextId: string | null = null;
      if (!closeCaucus) {
        const waiting = await client.query<{id: string; state: string | null}>(`SELECT q.id,a.state FROM speaker_queue_entries q
          LEFT JOIN current_attendance a ON a.seat_id=q.seat_id AND a.meeting_session_id=$2
          WHERE q.speaker_list_id=$1 AND q.status='QUEUED' ORDER BY q.position,q.created_at,q.id FOR UPDATE OF q`,
        [listId, list.meeting_session_id]);
        for (const entry of waiting.rows) {
          if (entry.state === 'PRESENT') { nextId = entry.id; break; }
          await client.query(`UPDATE speaker_queue_entries SET status='SKIPPED',completed_at=$2 WHERE id=$1`, [entry.id, now]);
        }
        if (nextId) await client.query(`UPDATE speaker_queue_entries SET status='CURRENT' WHERE id=$1`, [nextId]);
        await renumberActiveQueue(client, listId);
      }
      if (closeCaucus) {
        await client.query(`UPDATE speaker_queue_entries SET status='SKIPPED',completed_at=$2
          WHERE speaker_list_id=$1 AND status='QUEUED'`, [listId, now]);
        await client.query(`UPDATE speaker_lists SET status='CLOSED',current_entry_id=NULL,closed_at=$2,
          revision=revision+1 WHERE id=$1`, [listId, now]);
        await client.query(`UPDATE caucuses SET status='CLOSED',closed_at=$2,revision=revision+1 WHERE speaker_list_id=$1`, [listId, now]);
      } else {
        await client.query(`UPDATE speaker_lists SET current_entry_id=$2,revision=revision+1 WHERE id=$1`, [listId, nextId]);
        await client.query(`UPDATE timer_states SET running=false,started_at=NULL,remaining_at_start_ms=$2,
          expired_at=NULL,revision=revision+1,updated_at=$3 WHERE id=$1`, [list.speech_timer_id, list.default_speech_ms, now]);
        await appendEvent(client, committee, {type: 'timer.changed', resourceType: 'timer', resourceId: list.speech_timer_id,
          revision: (speechTimer.rows[0]?.revision ?? 0) + 1,
          payload: {command: 'RESET_FOR_NEXT_SPEAKER', running: false, remainingMs: Number(list.default_speech_ms)}});
        await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
          action: 'timers.reset', resourceType: 'timer', resourceId: list.speech_timer_id,
          before: {revision: speechTimer.rows[0]?.revision, remainingMs: speechTimer.rows[0]
            ? remainingTimerMs(speechTimer.rows[0], now) : null},
          after: {revision: (speechTimer.rows[0]?.revision ?? 0) + 1, remainingMs: Number(list.default_speech_ms)}});
      }
      const updated = await client.query<SpeakerListRow>('SELECT * FROM speaker_lists WHERE id=$1', [listId]);
      await appendEvent(client, committee, {type: closeCaucus ? 'caucus.closed' : 'speaker_queue.changed',
        resourceType: 'speaker_list', resourceId: listId, revision: list.revision + 1,
        payload: {command: closeCaucus ? 'CLOSED_INSUFFICIENT_TIME' : 'ADVANCED', currentEntryId: nextId}, audience: 'PUBLIC'});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: closeCaucus ? 'proceedings.caucus_closed' : 'proceedings.speaker_advanced',
        resourceType: 'speaker_list', resourceId: listId, before: {currentEntryId: list.current_entry_id, revision: list.revision},
        after: {currentEntryId: nextId, revision: list.revision + 1, reason: closeCaucus ? 'INSUFFICIENT_SPEECH_TIME' : null}});
      return speakerListState(client, updated.rows[0] as SpeakerListRow);
    });
  }

  async commandSpeech(auth: AuthenticatedSession, listId: string, command: 'start' | 'pause' | 'resume' | 'complete',
    input: Record<string, unknown>, context: Stage4Context): Promise<SpeechRecord> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision']);
    const baseRevision = positiveInteger(input.baseRevision, 'Base revision');
    return transaction(this.pool, async client => {
      const located = await client.query<{committee_id: string}>('SELECT committee_id FROM speaker_lists WHERE id=$1', [listId]);
      if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Speaker list not found.'});
      const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
      await requireChair(client, committee, auth.user.id);
      const listResult = await client.query<SpeakerListRow>('SELECT * FROM speaker_lists WHERE id=$1 FOR UPDATE', [listId]);
      const list = listResult.rows[0] as SpeakerListRow;
      if (list.status !== 'OPEN' || !list.current_entry_id) throw new AppError({code: 'RESOURCE_CONFLICT',
        message: 'The speaker list has no current speaker.'});
      const timerResult = await client.query<TimerRow>('SELECT * FROM timer_states WHERE id=$1 FOR UPDATE', [list.speech_timer_id]);
      const timer = timerResult.rows[0] as TimerRow; const now = this.now(); const remaining = remainingTimerMs(timer, now);
      const activeResult = await client.query<SpeechRow>(`SELECT * FROM speeches WHERE speaker_list_id=$1
        AND status IN ('READY','RUNNING','PAUSED') FOR UPDATE`, [listId]);
      let speech = activeResult.rows[0];
      if (command === 'start') {
        if (speech) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'A speech is already active.'});
        if (list.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT',
          message: 'This speaker list changed since it was loaded.', details: {currentRevision: list.revision}});
        if (timer.running || remaining <= 0) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The speech timer cannot start.'});
        const entry = await client.query<{seat_id: string; seat_display_name: string}>(`SELECT seat_id,seat_display_name
          FROM speaker_queue_entries WHERE id=$1 AND status='CURRENT'`, [list.current_entry_id]);
        if (!entry.rows[0]) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The current speaker is invalid.'});
        const id = randomUUID(); const inserted = await client.query<SpeechRow>(`INSERT INTO speeches
          (id,committee_id,speaker_list_id,queue_entry_id,seat_id,seat_display_name,kind,status,can_yield,
           actor_user_id,on_behalf_of_seat_id,started_at)
          VALUES ($1,$2,$3,$4,$5,$6,'ORIGINAL','RUNNING',true,$7,$5,$8) RETURNING *`,
        [id, committee.id, listId, list.current_entry_id, entry.rows[0].seat_id, entry.rows[0].seat_display_name,
          auth.user.id, now]);
        speech = inserted.rows[0] as SpeechRow;
      } else {
        if (!speech) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'There is no active speech.'});
        if (speech.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT',
          message: 'This speech changed since it was loaded.', details: {currentRevision: speech.revision}});
        if (command === 'pause' && (speech.status !== 'RUNNING' || !timer.running)) {
          throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The speech is not running.'});
        }
        if (command === 'resume' && (!['READY', 'PAUSED'].includes(speech.status) || timer.running || remaining <= 0)) {
          throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The speech cannot resume.'});
        }
        if (command === 'complete' && speech.status === 'COMPLETED') {
          throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The speech is already complete.'});
        }
        const nextStatus = command === 'pause' ? 'PAUSED' : command === 'resume' ? 'RUNNING' : 'COMPLETED';
        const updated = await client.query<SpeechRow>(`UPDATE speeches SET status=$2,revision=revision+1,
          started_at=CASE WHEN $2='RUNNING' AND started_at IS NULL THEN $3 ELSE started_at END,
          ended_at=CASE WHEN $2='COMPLETED' THEN $3 ELSE ended_at END WHERE id=$1 RETURNING *`,
        [speech.id, nextStatus, now]);
        speech = updated.rows[0] as SpeechRow;
      }
      const nextRunning = command === 'start' || command === 'resume';
      const nextRemaining = command === 'pause' || command === 'complete' ? remaining : Number(timer.remaining_at_start_ms);
      await client.query(`UPDATE timer_states SET running=$2,started_at=$3,remaining_at_start_ms=$4,
        revision=revision+1,updated_at=$5 WHERE id=$1`, [timer.id, nextRunning, nextRunning ? now : null, nextRemaining, now]);
      const action = command === 'start' ? 'STARTED' : command === 'pause' ? 'PAUSED'
        : command === 'resume' ? 'RESUMED' : 'COMPLETED';
      await client.query(`INSERT INTO speech_actions
        (id,committee_id,speech_id,action,remaining_ms,actor_user_id,on_behalf_of_seat_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), committee.id, speech.id, action, nextRemaining,
        auth.user.id, speech.seat_id]);
      await appendEvent(client, committee, {type: 'speech.changed', resourceType: 'speech', resourceId: speech.id,
        revision: speech.revision, payload: {command: action, speakerListId: listId, remainingMs: nextRemaining}});
      await appendEvent(client, committee, {type: 'timer.changed', resourceType: 'timer', resourceId: timer.id,
        revision: timer.revision + 1, payload: {command: `SPEECH_${action}`, running: nextRunning, remainingMs: nextRemaining}});
      const auditAction = command === 'start' ? 'proceedings.speech_started' : command === 'pause'
        ? 'proceedings.speech_paused' : command === 'resume' ? 'proceedings.speech_resumed' : 'proceedings.speech_completed';
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        onBehalfOfSeatId: speech.seat_id, action: auditAction,
        resourceType: 'speech', resourceId: speech.id, after: {speakerListId: listId, remainingMs: nextRemaining,
          revision: speech.revision, inherited: speech.kind === 'INHERITED'}});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: nextRunning ? (command === 'resume' ? 'timers.resumed' : 'timers.started')
          : command === 'pause' ? 'timers.paused' : 'timers.paused',
        resourceType: 'timer', resourceId: timer.id, before: {running: timer.running, remainingMs: remaining, revision: timer.revision},
        after: {running: nextRunning, remainingMs: nextRemaining, revision: timer.revision + 1}});
      return speechState(client, speech);
    });
  }

  async yieldSpeech(auth: AuthenticatedSession, speechId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<SpeechRecord> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision', 'type', 'targetSeatId']);
    const baseRevision = positiveInteger(input.baseRevision, 'Base revision'); const type = input.type as YieldType;
    if (!['CHAIR', 'SEAT', 'QUESTIONS', 'COMMENTS'].includes(type)) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Yield type is invalid.'});
    }
    return transaction(this.pool, async client => {
      const located = await client.query<{committee_id: string; speaker_list_id: string}>(`SELECT committee_id,speaker_list_id
        FROM speeches WHERE id=$1`, [speechId]);
      if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Speech not found.'});
      const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
      await requireChair(client, committee, auth.user.id);
      const listResult = await client.query<SpeakerListRow>('SELECT * FROM speaker_lists WHERE id=$1 FOR UPDATE',
        [located.rows[0].speaker_list_id]);
      const list = listResult.rows[0] as SpeakerListRow;
      const speechResult = await client.query<SpeechRow>('SELECT * FROM speeches WHERE id=$1 FOR UPDATE', [speechId]);
      const speech = speechResult.rows[0] as SpeechRow;
      if (speech.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT',
        message: 'This speech changed since it was loaded.', details: {currentRevision: speech.revision}});
      const timerResult = await client.query<TimerRow>('SELECT * FROM timer_states WHERE id=$1 FOR UPDATE', [list.speech_timer_id]);
      const timer = timerResult.rows[0] as TimerRow; const now = this.now(); const remaining = remainingTimerMs(timer, now);
      if (!canYieldSpeech(speech, remaining, timer.running)) throw new AppError({code: 'RESOURCE_CONFLICT',
        message: speech.kind === 'INHERITED' ? 'Inherited speaking time cannot be yielded again.'
          : 'Pause the speech with more than one second remaining before yielding.'});
      let targetSeatId: string | null = null; let targetName = speech.seat_display_name;
      if (type === 'SEAT') {
        targetSeatId = uuid(input.targetSeatId, 'Yield target seat ID');
        const target = await client.query<{display_name: string}>(`SELECT s.display_name FROM committee_seats s
          JOIN current_attendance a ON a.seat_id=s.id AND a.meeting_session_id=$3 AND a.state='PRESENT'
          WHERE s.id=$1 AND s.committee_id=$2 AND s.active=true`, [targetSeatId, committee.id, list.meeting_session_id]);
        if (!target.rows[0]) throw new AppError({code: 'VALIDATION_FAILED', message: 'Yield target seat is not present.'});
        targetName = target.rows[0].display_name;
      } else if (input.targetSeatId !== undefined) {
        throw new AppError({code: 'VALIDATION_FAILED', message: 'This yield type does not accept a target seat.'});
      }
      await client.query(`UPDATE speeches SET status='COMPLETED',yield_type=$2,yield_target_seat_id=$3,
        ended_at=$4,revision=revision+1 WHERE id=$1`, [speechId, type, targetSeatId, now]);
      await client.query(`INSERT INTO speech_actions
        (id,committee_id,speech_id,action,remaining_ms,target_type,target_seat_id,actor_user_id,on_behalf_of_seat_id)
        VALUES ($1,$2,$3,'YIELDED',$4,$5,$6,$7,$8)`, [randomUUID(), committee.id, speechId, remaining, type,
        targetSeatId, auth.user.id, speech.seat_id]);
      const inheritedId = randomUUID(); const inheritedSeatId = targetSeatId ?? speech.seat_id;
      const inherited = await client.query<SpeechRow>(`INSERT INTO speeches
        (id,committee_id,speaker_list_id,queue_entry_id,seat_id,seat_display_name,kind,status,inherited_from_speech_id,
         inherited_time_ms,can_yield,yield_type,yield_target_seat_id,actor_user_id,on_behalf_of_seat_id)
        VALUES ($1,$2,$3,$4,$5,$6,'INHERITED','READY',$7,$8,false,$9,$10,$11,$5) RETURNING *`,
      [inheritedId, committee.id, list.id, speech.queue_entry_id, inheritedSeatId, targetName, speechId, remaining,
        type, targetSeatId, auth.user.id]);
      await appendEvent(client, committee, {type: 'speech.yielded', resourceType: 'speech', resourceId: speechId,
        revision: speech.revision + 1, payload: {speakerListId: list.id, inheritedSpeechId: inheritedId, type,
          targetSeatId, inheritedTimeMs: remaining}});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        onBehalfOfSeatId: speech.seat_id, action: 'proceedings.speech_yielded', resourceType: 'speech', resourceId: speechId,
        before: {status: speech.status, revision: speech.revision}, after: {type, targetSeatId, inheritedSpeechId: inheritedId,
          inheritedTimeMs: remaining, revision: speech.revision + 1}});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        onBehalfOfSeatId: speech.seat_id, action: 'proceedings.chair_acted_on_behalf', resourceType: 'speech',
        resourceId: speechId, after: {command: 'speech.yielded', type, targetSeatId}});
      return speechState(client, inherited.rows[0] as SpeechRow);
    });
  }

  async recordSpeechContribution(auth: AuthenticatedSession, speechId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<SpeechRecord> {
    requireBusinessIdentity(auth); assertExactBody(input, ['type', 'content', 'seatId']);
    const type = input.type as 'QUESTION' | 'COMMENT';
    if (!['QUESTION', 'COMMENT'].includes(type)) throw new AppError({code: 'VALIDATION_FAILED', message: 'Contribution type is invalid.'});
    const content = text(input.content, 'Contribution', 4000);
    return transaction(this.pool, async client => {
      const located = await client.query<{committee_id: string; speaker_list_id: string}>(`SELECT committee_id,speaker_list_id
        FROM speeches WHERE id=$1`, [speechId]);
      if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Speech not found.'});
      const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
      const speechResult = await client.query<SpeechRow>('SELECT * FROM speeches WHERE id=$1 FOR UPDATE', [speechId]);
      const speech = speechResult.rows[0] as SpeechRow;
      const requiredYield = type === 'QUESTION' ? 'QUESTIONS' : 'COMMENTS';
      if (speech.kind !== 'INHERITED' || speech.yield_type !== requiredYield || speech.status === 'COMPLETED') {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'This speech does not accept that contribution.'});
      }
      const chair = await isChair(client, committee.id, auth.user.id); let seatId: string | null;
      if (chair) seatId = uuid(input.seatId, 'Seat ID');
      else {
        if (committee.operation_mode === 'CHAIR_OPERATED') throw new AppError({code: 'FORBIDDEN',
          message: 'Chair capability is required in Chair-operated mode.'});
        if (input.seatId !== undefined) throw new AppError({code: 'FORBIDDEN', message: 'A delegate cannot choose another seat.'});
        seatId = await activeSeat(client, committee.id, auth.user.id);
      }
      if (!seatId) throw new AppError({code: 'FORBIDDEN', message: 'An active seat assignment is required.'});
      const seat = await client.query<{display_name: string}>(`SELECT display_name FROM committee_seats
        WHERE id=$1 AND committee_id=$2 AND active=true`, [seatId, committee.id]);
      if (!seat.rows[0]) throw new AppError({code: 'VALIDATION_FAILED', message: 'Seat is invalid.'});
      const contributionId = randomUUID(); await client.query(`INSERT INTO speech_contributions
        (id,committee_id,speech_id,type,seat_id,seat_display_name,content,actor_user_id,on_behalf_of_seat_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$5)`, [contributionId, committee.id, speechId, type, seatId,
        seat.rows[0].display_name, content, auth.user.id]);
      await client.query(`INSERT INTO speech_actions
        (id,committee_id,speech_id,action,remaining_ms,actor_user_id,on_behalf_of_seat_id,details)
        VALUES ($1,$2,$3,$4,0,$5,$6,$7)`, [randomUUID(), committee.id, speechId,
        type === 'QUESTION' ? 'QUESTION_RECORDED' : 'COMMENT_RECORDED', auth.user.id, seatId,
        {contributionId, characterCount: [...content].length}]);
      await appendEvent(client, committee, {type: 'speech.contribution_recorded', resourceType: 'speech', resourceId: speechId,
        revision: speech.revision, payload: {contributionId, type, seatId}});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
        capabilities: chair ? ['CHAIR'] : ['MEMBER'], onBehalfOfSeatId: seatId,
        action: 'proceedings.speech_contribution_recorded', resourceType: 'speech', resourceId: speechId,
        after: {contributionId, type, seatId, characterCount: [...content].length}});
      if (chair) await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
        capabilities: ['CHAIR'], onBehalfOfSeatId: seatId, action: 'proceedings.chair_acted_on_behalf',
        resourceType: 'speech', resourceId: speechId, after: {command: 'speech.contribution_recorded', type}});
      return speechState(client, speech);
    });
  }
}
