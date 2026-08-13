import {randomUUID} from 'node:crypto';
import type {Pool, PoolClient, QueryResultRow} from 'pg';
import type {AuthoritativeTimer, TimerOwnerType} from '@quorum/contracts';
import {AppError} from '../../http/errors.js';
import type {AuthenticatedSession} from '../identity/store.js';
import {appendEvent, audit, idempotentTransaction, lockedCommittee, requireBusinessIdentity, requireChair,
  requireProceedingsActive, transaction, type Stage4Context} from '../stage4/database.js';
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
}
