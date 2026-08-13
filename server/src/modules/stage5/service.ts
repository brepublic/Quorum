import {createHash, randomBytes, randomUUID} from 'node:crypto';
import type {Pool, PoolClient, QueryResultRow} from 'pg';
import type {AuthoritativeTimer, BallotChoice, CreatedStrawpoll, FormalBallot, FrozenRuleEvaluation, ProceedingMotion,
  ProceedingDocument, ProceedingDocumentKind, ProceedingDocumentStatus, SpeakerList, SpeakerListKind, SpeakerQueueEntry,
  SpeechRecord, Strawpoll, StrawpollVotingMode, TimerOwnerType, YieldType} from '@quorum/contracts';
import {freezeRuleEvaluation} from '@quorum/contracts';
import {AppError} from '../../http/errors.js';
import type {AuthenticatedSession} from '../identity/store.js';
import {activeSeat, appendEvent, audit, idempotentTransaction, isChair, lockedCommittee, requireBusinessIdentity,
  requireChair, requireProceedingsActive, transaction, type Stage4CommitteeRow, type Stage4Context} from '../stage4/database.js';
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

interface MotionRow extends QueryResultRow {
  id: string; committee_id: string; meeting_session_id: string; motion_type_id: string; proposed_by_seat_id: string;
  proposed_by_seat_display_name: string; parameters: Record<string, unknown>; status: ProceedingMotion['status'];
  rule_package_version_id: string; rule_evaluation: FrozenRuleEvaluation; required_second_count: number;
  revision: number; created_at: Date; decided_at: Date | null;
}

interface BallotRow extends QueryResultRow {
  id: string; committee_id: string; meeting_session_id: string; subject_type: FormalBallot['subjectType']; subject_id: string;
  status: FormalBallot['status']; procedural: boolean; choices: BallotChoice[]; rule_package_version_id: string;
  rule_evaluation: FrozenRuleEvaluation; eligibility_snapshot: FormalBallot['eligibility'];
  threshold_definition: FormalBallot['threshold']; threshold_value: number; result: FormalBallot['result'];
  revision: number; opened_at: Date; closed_at: Date | null; published_at: Date | null;
}

interface StrawpollRow extends QueryResultRow {
  id: string; committee_id: string; meeting_session_id: string; question: string; voting_mode: StrawpollVotingMode;
  multiple_choice: boolean; status: Strawpoll['status']; revision: number; created_at: Date; closed_at: Date | null;
}

interface DocumentRow extends QueryResultRow {
  id: string; committee_id: string; meeting_session_id: string; kind: ProceedingDocumentKind; title: string;
  status: ProceedingDocumentStatus; rule_package_version_id: string; current_version_id: string;
  voting_version_id: string | null; is_public: boolean; created_by_user_id: string;
  created_on_behalf_of_seat_id: string; revision: number; created_at: Date; updated_at: Date;
  resolution_document_id: string | null;
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

async function motionState(client: PoolClient, row: MotionRow): Promise<ProceedingMotion> {
  const seconds = await client.query<{id: string; seat_id: string; seat_display_name: string; created_at: Date}>(`SELECT
    id,seat_id,seat_display_name,created_at FROM motion_seconds WHERE motion_id=$1 ORDER BY created_at,id`, [row.id]);
  return {id: row.id, committeeId: row.committee_id, meetingSessionId: row.meeting_session_id,
    motionTypeId: row.motion_type_id, proposedBySeatId: row.proposed_by_seat_id,
    proposedBySeatDisplayName: row.proposed_by_seat_display_name, parameters: row.parameters, status: row.status,
    rulePackageVersionId: row.rule_package_version_id, ruleEvaluation: row.rule_evaluation,
    requiredSecondCount: row.required_second_count,
    seconds: seconds.rows.map(item => ({id: item.id, seatId: item.seat_id, seatDisplayName: item.seat_display_name,
      createdAt: item.created_at.toISOString()})), revision: row.revision, createdAt: row.created_at.toISOString(),
    decidedAt: row.decided_at?.toISOString() ?? null};
}

async function ballotState(client: PoolClient, row: BallotRow, includeVotes = true): Promise<FormalBallot> {
  const votes = includeVotes ? await client.query<{id: string; seat_id: string; seat_display_name: string;
    current_choice: BallotChoice; revision: number; cast_at: Date}>(`SELECT id,seat_id,seat_display_name,current_choice,
    revision,cast_at FROM ballot_votes WHERE ballot_id=$1 ORDER BY seat_id`, [row.id]) : {rows: []};
  return {id: row.id, committeeId: row.committee_id, meetingSessionId: row.meeting_session_id,
    subjectType: row.subject_type, subjectId: row.subject_id, status: row.status, procedural: row.procedural,
    choices: row.choices, rulePackageVersionId: row.rule_package_version_id, ruleEvaluation: row.rule_evaluation,
    eligibility: row.eligibility_snapshot, threshold: row.threshold_definition,
    votes: votes.rows.map(vote => ({id: vote.id, seatId: vote.seat_id, seatDisplayName: vote.seat_display_name,
      choice: vote.current_choice, revision: vote.revision, castAt: vote.cast_at.toISOString()})), result: row.result,
    revision: row.revision, openedAt: row.opened_at.toISOString(), closedAt: row.closed_at?.toISOString() ?? null,
    publishedAt: row.published_at?.toISOString() ?? null};
}

async function strawpollState(client: PoolClient, row: StrawpollRow): Promise<Strawpoll> {
  const options = await client.query<{id: string; label: string; sort_order: number; vote_count: string}>(`WITH votes AS (
      SELECT unnest(option_ids) AS option_id FROM strawpoll_seat_votes WHERE strawpoll_id=$1
      UNION ALL
      SELECT unnest(option_ids) AS option_id FROM strawpoll_anonymous_votes WHERE strawpoll_id=$1
    ) SELECT o.id,o.label,o.sort_order,count(v.option_id)::text AS vote_count FROM strawpoll_options o
      LEFT JOIN votes v ON v.option_id=o.id WHERE o.strawpoll_id=$1
      GROUP BY o.id,o.label,o.sort_order ORDER BY o.sort_order,o.id`, [row.id]);
  return {id: row.id, committeeId: row.committee_id, meetingSessionId: row.meeting_session_id,
    question: row.question, votingMode: row.voting_mode, multipleChoice: row.multiple_choice, status: row.status,
    options: options.rows.map(option => ({id: option.id, label: option.label, sortOrder: option.sort_order,
      voteCount: Number(option.vote_count)})), revision: row.revision, createdAt: row.created_at.toISOString(),
    closedAt: row.closed_at?.toISOString() ?? null};
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

async function documentState(client: PoolClient, row: DocumentRow): Promise<ProceedingDocument> {
  const [version, discussion] = await Promise.all([
    client.query<{id: string; version_number: number; content: string; created_at: Date}>(`SELECT id,version_number,
      content,created_at FROM document_versions WHERE document_id=$1 AND id=$2`, [row.id, row.current_version_id]),
    client.query<{id: string; seat_id: string; seat_display_name: string; content: string; rule_stable_id: string;
      created_at: Date}>(`SELECT id,seat_id,seat_display_name,content,rule_stable_id,created_at FROM discussion_entries
      WHERE document_id=$1 ORDER BY created_at,id`, [row.id])
  ]);
  const current = version.rows[0];
  if (!current) throw new AppError({code: 'INTERNAL_ERROR', message: 'Document version is unavailable.'});
  return {id: row.id, committeeId: row.committee_id, meetingSessionId: row.meeting_session_id, kind: row.kind,
    resolutionId: row.resolution_document_id, title: row.title, status: row.status,
    rulePackageVersionId: row.rule_package_version_id,
    currentVersion: {id: current.id, versionNumber: current.version_number, content: current.content,
      createdAt: current.created_at.toISOString()}, votingVersionId: row.voting_version_id, public: row.is_public,
    revision: row.revision, discussion: discussion.rows.map(entry => ({id: entry.id, seatId: entry.seat_id,
      seatDisplayName: entry.seat_display_name, content: entry.content, ruleStableId: entry.rule_stable_id,
      createdAt: entry.created_at.toISOString()})), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString()};
}

const documentRuleIds: Record<ProceedingDocumentKind, Record<'PUBLISH' | 'POSTPONE' | 'RESUME' | 'RECOMMEND_BALLOT' | 'DISCUSS', string>> = {
  RESOLUTION: {PUBLISH: 'introduce-draft-resolution', POSTPONE: 'postpone-resolution', RESUME: 'resume-resolution',
    RECOMMEND_BALLOT: 'vote-on-resolution', DISCUSS: 'discuss-resolution'},
  AMENDMENT: {PUBLISH: 'introduce-amendment', POSTPONE: 'postpone-amendment', RESUME: 'resume-amendment',
    RECOMMEND_BALLOT: 'vote-on-amendment', DISCUSS: 'discuss-amendment'}
};

async function frozenDocumentRule(client: PoolClient, row: DocumentRow, suppliedId: string, expectedId: string,
  now: Date): Promise<FrozenRuleEvaluation> {
  if (suppliedId !== expectedId) throw new AppError({code: 'VALIDATION_FAILED', message: 'Document rule action is invalid.'});
  const packageResult = await client.query<{definition: {motions?: unknown}}>(`SELECT definition FROM rule_package_versions
    WHERE id=$1 AND status='PUBLISHED'`, [row.rule_package_version_id]);
  const motions = packageResult.rows[0]?.definition.motions;
  const matches = Array.isArray(motions) ? motions.filter(item => item && typeof item === 'object'
    && (item as {id?: unknown}).id === suppliedId) : [];
  if (matches.length !== 1) throw new AppError({code: 'VALIDATION_FAILED',
    message: 'Document action is not available in the frozen rule package.'});
  return freezeRuleEvaluation({packageVersionId: row.rule_package_version_id,
    definition: structuredClone(matches[0]) as Record<string, unknown>,
    facts: {documentId: row.id, kind: row.kind, status: row.status, currentVersionId: row.current_version_id},
    resolvedValues: {stableId: suppliedId}, frozenAt: now.toISOString()});
}

async function representedDocumentSeat(client: PoolClient, committee: Stage4CommitteeRow, auth: AuthenticatedSession,
  requestedSeatId: unknown, meetingSessionId: string): Promise<{chair: boolean; seatId: string; displayName: string}> {
  const chair = await isChair(client, committee.id, auth.user.id); let seatId: string | null;
  if (chair) seatId = uuid(requestedSeatId, 'Represented seat ID');
  else {
    if (committee.operation_mode === 'CHAIR_OPERATED') throw new AppError({code: 'FORBIDDEN',
      message: 'Chair capability is required in Chair-operated mode.'});
    if (requestedSeatId !== undefined) throw new AppError({code: 'FORBIDDEN', message: 'A delegate cannot choose another seat.'});
    seatId = await activeSeat(client, committee.id, auth.user.id);
  }
  if (!seatId) throw new AppError({code: 'FORBIDDEN', message: 'An active seat assignment is required.'});
  const seat = await client.query<{display_name: string}>(`SELECT s.display_name FROM committee_seats s
    JOIN current_attendance a ON a.seat_id=s.id AND a.meeting_session_id=$3 AND a.state='PRESENT'
    WHERE s.id=$1 AND s.committee_id=$2 AND s.active=true`, [seatId, committee.id, meetingSessionId]);
  if (!seat.rows[0]) throw new AppError({code: 'FORBIDDEN', message: 'The represented seat is not present.'});
  return {chair, seatId, displayName: seat.rows[0].display_name};
}

export function calculateBallotResult(eligibility: FormalBallot['eligibility'], votes: FormalBallot['votes'],
  threshold: number): NonNullable<FormalBallot['result']> {
  const forCount = votes.filter(vote => vote.choice === 'FOR').length;
  const againstCount = votes.filter(vote => vote.choice === 'AGAINST').length;
  const abstainCount = votes.filter(vote => vote.choice === 'ABSTAIN').length;
  const vetoed = votes.some(vote => vote.choice === 'AGAINST'
    && eligibility.some(seat => seat.seatId === vote.seatId && seat.hasVeto));
  return {outcome: vetoed ? 'VETOED' : forCount >= threshold ? 'PASSED' : 'FAILED', forCount, againstCount, abstainCount};
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

  async proposeMotion(auth: AuthenticatedSession, committeeId: string, input: Record<string, unknown>, key: string,
    context: Stage4Context): Promise<ProceedingMotion> {
    requireBusinessIdentity(auth);
    assertExactBody(input, ['meetingSessionId', 'motionTypeId', 'parameters', 'onBehalfOfSeatId']);
    const meetingSessionId = uuid(input.meetingSessionId, 'Meeting session ID');
    const motionTypeId = text(input.motionTypeId, 'Motion type ID', 128);
    const parameters = input.parameters ?? {};
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)
      || JSON.stringify(parameters).length > 16_000) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Motion parameters are invalid.'});
    }
    return idempotentTransaction({pool: this.pool, auth, route: `POST /api/v1/committees/${committeeId}/motions`,
      key, request: input, status: 201, work: async client => {
        const committee = await lockedCommittee(client, committeeId); requireProceedingsActive(committee);
        const chair = await isChair(client, committeeId, auth.user.id); let seatId: string | null;
        if (chair) seatId = uuid(input.onBehalfOfSeatId, 'Represented seat ID');
        else {
          if (committee.operation_mode === 'CHAIR_OPERATED') throw new AppError({code: 'FORBIDDEN',
            message: 'Chair capability is required in Chair-operated mode.'});
          if (input.onBehalfOfSeatId !== undefined) throw new AppError({code: 'FORBIDDEN',
            message: 'A delegate cannot choose another seat.'});
          seatId = await activeSeat(client, committeeId, auth.user.id);
        }
        if (!seatId) throw new AppError({code: 'FORBIDDEN', message: 'An active seat assignment is required.'});
        const session = await client.query<{status: string; active_rule_package_version_id: string}>(`SELECT status,
          active_rule_package_version_id FROM meeting_sessions WHERE id=$1 AND committee_id=$2`, [meetingSessionId, committeeId]);
        if (!session.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Meeting session not found.'});
        if (session.rows[0].status !== 'OPEN') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Meeting session is closed.'});
        const seat = await client.query<{display_name: string}>(`SELECT s.display_name FROM committee_seats s
          JOIN current_attendance a ON a.seat_id=s.id AND a.meeting_session_id=$3 AND a.state='PRESENT'
          WHERE s.id=$1 AND s.committee_id=$2 AND s.active=true`, [seatId, committeeId, meetingSessionId]);
        if (!seat.rows[0]) throw new AppError({code: 'VALIDATION_FAILED', message: 'Only a present active seat may propose a motion.'});
        const version = await client.query<{definition: {motions?: unknown}}>(`SELECT definition FROM rule_package_versions
          WHERE id=$1 AND status='PUBLISHED'`, [session.rows[0].active_rule_package_version_id]);
        const definitions = version.rows[0]?.definition.motions;
        const matches = Array.isArray(definitions) ? definitions.filter(item => item && typeof item === 'object'
          && (item as {id?: unknown}).id === motionTypeId) : [];
        if (matches.length !== 1) throw new AppError({code: 'VALIDATION_FAILED',
          message: 'Motion type is not active in the meeting rule package.'});
        const definition = structuredClone(matches[0]) as {id: string; requiredSecondCount?: unknown; procedural?: unknown;
          effects?: unknown};
        const requiredSecondCount = definition.requiredSecondCount === undefined ? 0 : definition.requiredSecondCount;
        if (!Number.isSafeInteger(requiredSecondCount) || Number(requiredSecondCount) < 0) {
          throw new AppError({code: 'VALIDATION_FAILED', message: 'Motion second requirement is invalid.'});
        }
        const attendance = await client.query<{seat_id: string}>(`SELECT seat_id FROM current_attendance
          WHERE meeting_session_id=$1 AND state='PRESENT' ORDER BY seat_id`, [meetingSessionId]);
        const now = this.now(); const evaluation = freezeRuleEvaluation({
          packageVersionId: session.rows[0].active_rule_package_version_id,
          definition: definition as unknown as Record<string, unknown>,
          facts: {meetingSessionId, operationMode: committee.operation_mode,
            presentSeatIds: attendance.rows.map(item => item.seat_id)},
          resolvedValues: {requiredSecondCount: Number(requiredSecondCount), procedural: definition.procedural === true,
            effects: Array.isArray(definition.effects) ? structuredClone(definition.effects) : []},
          frozenAt: now.toISOString()
        });
        const id = randomUUID(); const initialStatus = Number(requiredSecondCount) === 0 ? 'SECONDED' : 'PENDING';
        const inserted = await client.query<MotionRow>(`INSERT INTO motions
          (id,committee_id,meeting_session_id,motion_type_id,proposed_by_seat_id,proposed_by_seat_display_name,
           actor_user_id,on_behalf_of_seat_id,parameters,status,rule_package_version_id,rule_evaluation,required_second_count)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$5,$8,$9,$10,$11,$12) RETURNING *`,
        [id, committeeId, meetingSessionId, motionTypeId, seatId, seat.rows[0].display_name, auth.user.id,
          parameters, initialStatus, session.rows[0].active_rule_package_version_id, evaluation, requiredSecondCount]);
        await appendEvent(client, committee, {type: 'motion.proposed', resourceType: 'motion', resourceId: id,
          revision: 1, payload: {motionTypeId, proposedBySeatId: seatId, status: initialStatus,
            rulePackageVersionId: session.rows[0].active_rule_package_version_id}, audience: 'PUBLIC'});
        await audit(client, context, {committeeId, actorUserId: auth.user.id,
          capabilities: chair ? ['CHAIR'] : ['MEMBER'], onBehalfOfSeatId: seatId,
          action: 'proceedings.motion_proposed', resourceType: 'motion', resourceId: id,
          after: {motionTypeId, seatId, status: initialStatus, rulePackageVersionId: evaluation.packageVersionId,
            requiredSecondCount, revision: 1}});
        if (chair) await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['CHAIR'],
          onBehalfOfSeatId: seatId, action: 'proceedings.chair_acted_on_behalf', resourceType: 'motion', resourceId: id,
          after: {command: 'motion.proposed', motionTypeId}});
        return motionState(client, inserted.rows[0] as MotionRow);
      }});
  }

  async secondMotion(auth: AuthenticatedSession, motionId: string, input: Record<string, unknown>, key: string,
    context: Stage4Context): Promise<ProceedingMotion> {
    requireBusinessIdentity(auth); assertExactBody(input, ['onBehalfOfSeatId']);
    return idempotentTransaction({pool: this.pool, auth, route: `POST /api/v1/motions/${motionId}/second`,
      key, request: input, status: 201, work: async client => {
        const located = await client.query<{committee_id: string}>('SELECT committee_id FROM motions WHERE id=$1', [motionId]);
        if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Motion not found.'});
        const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
        const motionResult = await client.query<MotionRow>('SELECT * FROM motions WHERE id=$1 FOR UPDATE', [motionId]);
        const motion = motionResult.rows[0] as MotionRow;
        if (motion.status !== 'PENDING') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'This motion no longer accepts seconds.'});
        const chair = await isChair(client, committee.id, auth.user.id); let seatId: string | null;
        if (chair) seatId = uuid(input.onBehalfOfSeatId, 'Represented seat ID');
        else {
          if (committee.operation_mode === 'CHAIR_OPERATED') throw new AppError({code: 'FORBIDDEN',
            message: 'Chair capability is required in Chair-operated mode.'});
          if (input.onBehalfOfSeatId !== undefined) throw new AppError({code: 'FORBIDDEN', message: 'A delegate cannot choose another seat.'});
          seatId = await activeSeat(client, committee.id, auth.user.id);
        }
        if (!seatId || seatId === motion.proposed_by_seat_id) throw new AppError({code: 'VALIDATION_FAILED',
          message: 'A different present seat must second the motion.'});
        const seat = await client.query<{display_name: string}>(`SELECT s.display_name FROM committee_seats s
          JOIN current_attendance a ON a.seat_id=s.id AND a.meeting_session_id=$3 AND a.state='PRESENT'
          WHERE s.id=$1 AND s.committee_id=$2 AND s.active=true`, [seatId, committee.id, motion.meeting_session_id]);
        if (!seat.rows[0]) throw new AppError({code: 'VALIDATION_FAILED', message: 'Only a present active seat may second a motion.'});
        const secondId = randomUUID(); await client.query(`INSERT INTO motion_seconds
          (id,committee_id,motion_id,seat_id,seat_display_name,actor_user_id,on_behalf_of_seat_id)
          VALUES ($1,$2,$3,$4,$5,$6,$4)`, [secondId, committee.id, motionId, seatId, seat.rows[0].display_name, auth.user.id]);
        const count = await client.query<{count: string}>('SELECT count(*)::text AS count FROM motion_seconds WHERE motion_id=$1', [motionId]);
        const nextStatus = Number(count.rows[0]?.count ?? 0) >= motion.required_second_count ? 'SECONDED' : 'PENDING';
        const updated = await client.query<MotionRow>(`UPDATE motions SET status=$2,revision=revision+1 WHERE id=$1 RETURNING *`,
          [motionId, nextStatus]);
        await appendEvent(client, committee, {type: 'motion.seconded', resourceType: 'motion', resourceId: motionId,
          revision: motion.revision + 1, payload: {secondId, seatId, status: nextStatus}, audience: 'PUBLIC'});
        await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
          capabilities: chair ? ['CHAIR'] : ['MEMBER'], onBehalfOfSeatId: seatId,
          action: 'proceedings.motion_seconded', resourceType: 'motion', resourceId: motionId,
          after: {secondId, seatId, status: nextStatus, revision: motion.revision + 1}});
        return motionState(client, updated.rows[0] as MotionRow);
      }});
  }

  async decideMotion(auth: AuthenticatedSession, motionId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<ProceedingMotion> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision', 'result']);
    const baseRevision = positiveInteger(input.baseRevision, 'Base revision'); const result = input.result;
    if (!['PASSED', 'FAILED'].includes(result as string)) throw new AppError({code: 'VALIDATION_FAILED',
      message: 'Motion result is invalid.'});
    return transaction(this.pool, async client => {
      const located = await client.query<{committee_id: string}>('SELECT committee_id FROM motions WHERE id=$1', [motionId]);
      if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Motion not found.'});
      const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
      await requireChair(client, committee, auth.user.id);
      const motionResult = await client.query<MotionRow>('SELECT * FROM motions WHERE id=$1 FOR UPDATE', [motionId]);
      const motion = motionResult.rows[0] as MotionRow;
      if (!['PENDING', 'SECONDED', 'VOTING'].includes(motion.status)) throw new AppError({code: 'RESOURCE_CONFLICT',
        message: 'The motion has already been decided.'});
      if (motion.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT',
        message: 'This motion changed since it was loaded.', details: {currentRevision: motion.revision}});
      const seconds = await client.query<{count: string}>('SELECT count(*)::text AS count FROM motion_seconds WHERE motion_id=$1', [motionId]);
      if (Number(seconds.rows[0]?.count ?? 0) < motion.required_second_count) throw new AppError({code: 'RESOURCE_CONFLICT',
        message: 'The motion does not have the required seconds.'});
      const now = this.now(); const updated = await client.query<MotionRow>(`UPDATE motions SET status=$2,
        decided_by_user_id=$3,decided_at=$4,revision=revision+1 WHERE id=$1 RETURNING *`,
      [motionId, result, auth.user.id, now]);
      await appendEvent(client, committee, {type: 'motion.decided', resourceType: 'motion', resourceId: motionId,
        revision: motion.revision + 1, payload: {result, decidedAt: now.toISOString()}, audience: 'PUBLIC'});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: 'proceedings.motion_decided', resourceType: 'motion', resourceId: motionId,
        before: {status: motion.status, revision: motion.revision},
        after: {status: result, decidedAt: now.toISOString(), revision: motion.revision + 1}});
      return motionState(client, updated.rows[0] as MotionRow);
    });
  }

  async createBallot(auth: AuthenticatedSession, committeeId: string, input: Record<string, unknown>, key: string,
    context: Stage4Context): Promise<FormalBallot> {
    requireBusinessIdentity(auth);
    assertExactBody(input, ['meetingSessionId', 'subjectType', 'subjectId', 'procedural', 'thresholdKind']);
    const meetingSessionId = uuid(input.meetingSessionId, 'Meeting session ID');
    const subjectType = input.subjectType as FormalBallot['subjectType'];
    if (!['MOTION', 'RESOLUTION', 'AMENDMENT'].includes(subjectType)) throw new AppError({code: 'VALIDATION_FAILED',
      message: 'Ballot subject type is invalid.'});
    const subjectId = uuid(input.subjectId, 'Ballot subject ID'); const procedural = input.procedural;
    if (typeof procedural !== 'boolean') throw new AppError({code: 'VALIDATION_FAILED', message: 'Ballot procedure type is invalid.'});
    const thresholdKind = input.thresholdKind as FormalBallot['threshold']['kind'];
    if (!['SIMPLE_MAJORITY', 'TWO_THIRDS'].includes(thresholdKind)) throw new AppError({code: 'VALIDATION_FAILED',
      message: 'Ballot threshold is invalid.'});
    return idempotentTransaction({pool: this.pool, auth, route: `POST /api/v1/committees/${committeeId}/ballots`,
      key, request: input, status: 201, work: async client => {
        const committee = await lockedCommittee(client, committeeId); requireProceedingsActive(committee);
        await requireChair(client, committee, auth.user.id);
        const session = await client.query<{status: string; active_rule_package_version_id: string}>(`SELECT status,
          active_rule_package_version_id FROM meeting_sessions WHERE id=$1 AND committee_id=$2`, [meetingSessionId, committeeId]);
        if (!session.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Meeting session not found.'});
        if (session.rows[0].status !== 'OPEN') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Meeting session is closed.'});
        let subjectVersionId: string | null = null;
        if (subjectType === 'MOTION') {
          const motion = await client.query('SELECT 1 FROM motions WHERE id=$1 AND committee_id=$2', [subjectId, committeeId]);
          if (!motion.rowCount) throw new AppError({code: 'NOT_FOUND', message: 'Motion not found.'});
        } else {
          const kind = subjectType === 'RESOLUTION' ? 'RESOLUTION' : 'AMENDMENT';
          const document = await client.query<{status: ProceedingDocumentStatus; voting_version_id: string | null}>(
            'SELECT status,voting_version_id FROM documents WHERE id=$1 AND committee_id=$2 AND kind=$3 FOR UPDATE',
            [subjectId, committeeId, kind]);
          if (!document.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Ballot document not found.'});
          if (document.rows[0].status !== 'VOTING' || !document.rows[0].voting_version_id) throw new AppError({
            code: 'RESOURCE_CONFLICT', message: 'The document has not entered formal voting.'});
          subjectVersionId = document.rows[0].voting_version_id;
        }
        const eligible = await client.query<{seat_id: string; display_name: string; must_vote: boolean; has_veto: boolean}>(`SELECT
          s.id AS seat_id,s.display_name,s.must_vote,s.has_veto FROM committee_seats s JOIN current_attendance a
          ON a.seat_id=s.id AND a.meeting_session_id=$2 AND a.state='PRESENT'
          WHERE s.committee_id=$1 AND s.active=true AND s.can_vote=true ORDER BY s.sort_order,s.stable_key,s.id`,
        [committeeId, meetingSessionId]);
        if (eligible.rowCount === 0) throw new AppError({code: 'VALIDATION_FAILED', message: 'The ballot has no eligible seats.'});
        const eligibility = eligible.rows.map(seat => ({seatId: seat.seat_id, seatDisplayName: seat.display_name,
          mustVote: procedural || seat.must_vote, hasVeto: seat.has_veto}));
        const thresholdValue = thresholdKind === 'TWO_THIRDS' ? Math.ceil(eligibility.length * 2 / 3)
          : Math.floor(eligibility.length / 2) + 1;
        const choices: BallotChoice[] = procedural ? ['FOR', 'AGAINST'] : ['FOR', 'AGAINST', 'ABSTAIN'];
        const now = this.now(); const evaluation = freezeRuleEvaluation({
          packageVersionId: session.rows[0].active_rule_package_version_id,
          definition: {subjectType, procedural, thresholdKind},
          facts: {subjectVersionId, eligibleSeatIds: eligibility.map(seat => seat.seatId), eligibleSeatCount: eligibility.length,
            vetoSeatIds: eligibility.filter(seat => seat.hasVeto).map(seat => seat.seatId)},
          resolvedValues: {choices, thresholdValue, mustVoteSeatIds: eligibility.filter(seat => seat.mustVote).map(seat => seat.seatId)},
          frozenAt: now.toISOString()
        });
        const id = randomUUID(); const inserted = await client.query<BallotRow>(`INSERT INTO ballots
          (id,committee_id,meeting_session_id,subject_type,subject_id,procedural,choices,rule_package_version_id,
           rule_evaluation,eligibility_snapshot,threshold_definition,threshold_value,opened_by_user_id,opened_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [id, committeeId, meetingSessionId, subjectType, subjectId, procedural, choices,
          session.rows[0].active_rule_package_version_id, evaluation, eligibility, {kind: thresholdKind, value: thresholdValue},
          thresholdValue, auth.user.id, now]);
        await appendEvent(client, committee, {type: 'ballot.opened', resourceType: 'ballot', resourceId: id, revision: 1,
          payload: {subjectType, subjectId, eligibleSeatCount: eligibility.length, procedural,
            rulePackageVersionId: evaluation.packageVersionId}, audience: 'PUBLIC'});
        await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['CHAIR'],
          action: 'voting.ballot_created', resourceType: 'ballot', resourceId: id,
          after: {subjectType, subjectId, eligibleSeatCount: eligibility.length, thresholdKind, thresholdValue,
            procedural, revision: 1}});
        return ballotState(client, inserted.rows[0] as BallotRow);
      }});
  }

  async castVote(auth: AuthenticatedSession, ballotId: string, input: Record<string, unknown>, key: string,
    context: Stage4Context): Promise<FormalBallot> {
    requireBusinessIdentity(auth); assertExactBody(input, ['choice', 'onBehalfOfSeatId']);
    const choice = input.choice as BallotChoice;
    if (!['FOR', 'AGAINST', 'ABSTAIN'].includes(choice)) throw new AppError({code: 'VALIDATION_FAILED', message: 'Vote choice is invalid.'});
    return idempotentTransaction({pool: this.pool, auth, route: `POST /api/v1/ballots/${ballotId}/votes`, key,
      request: input, status: 201, work: async client => {
        const located = await client.query<{committee_id: string}>('SELECT committee_id FROM ballots WHERE id=$1', [ballotId]);
        if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Ballot not found.'});
        const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
        const ballotResult = await client.query<BallotRow>('SELECT * FROM ballots WHERE id=$1 FOR UPDATE', [ballotId]);
        const ballot = ballotResult.rows[0] as BallotRow;
        if (ballot.status !== 'OPEN') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The ballot is not open.'});
        const chair = await isChair(client, committee.id, auth.user.id); let seatId: string | null;
        if (chair) seatId = uuid(input.onBehalfOfSeatId, 'Represented seat ID');
        else {
          if (committee.operation_mode === 'CHAIR_OPERATED') throw new AppError({code: 'FORBIDDEN',
            message: 'Chair capability is required in Chair-operated mode.'});
          if (input.onBehalfOfSeatId !== undefined) throw new AppError({code: 'FORBIDDEN', message: 'A delegate cannot choose another seat.'});
          seatId = await activeSeat(client, committee.id, auth.user.id);
        }
        const eligibility = ballot.eligibility_snapshot.find(seat => seat.seatId === seatId);
        if (!seatId || !eligibility) throw new AppError({code: 'FORBIDDEN', message: 'This seat is not eligible for the ballot.'});
        if (!ballot.choices.includes(choice) || (eligibility.mustVote && choice === 'ABSTAIN')) {
          throw new AppError({code: 'VALIDATION_FAILED', message: 'This seat cannot cast that choice.'});
        }
        const voteId = randomUUID(); const vote = await client.query(`INSERT INTO ballot_votes
          (id,ballot_id,seat_id,seat_display_name,current_choice,cast_by_user_id,cast_on_behalf)
          VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [voteId, ballotId, seatId, eligibility.seatDisplayName,
          choice, auth.user.id, chair]);
        await client.query(`INSERT INTO ballot_vote_revisions
          (id,ballot_id,vote_id,seat_id,new_choice,actor_user_id,on_behalf_of_seat_id)
          VALUES ($1,$2,$3,$4,$5,$6,$4)`, [randomUUID(), ballotId, vote.rows[0].id, seatId, choice, auth.user.id]);
        await client.query('UPDATE ballots SET revision=revision+1 WHERE id=$1', [ballotId]);
        await appendEvent(client, committee, {type: 'ballot.vote_recorded', resourceType: 'ballot', resourceId: ballotId,
          revision: ballot.revision + 1, payload: {castCountIncrement: 1}, audience: 'CHAIR'});
        await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
          capabilities: chair ? ['CHAIR'] : ['MEMBER'], onBehalfOfSeatId: seatId,
          action: 'voting.vote_cast', resourceType: 'ballot', resourceId: ballotId,
          after: {seatId, choice, voteId, revision: ballot.revision + 1}});
        const updated = await client.query<BallotRow>('SELECT * FROM ballots WHERE id=$1', [ballotId]);
        return ballotState(client, updated.rows[0] as BallotRow);
      }});
  }

  async correctVote(auth: AuthenticatedSession, ballotId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<FormalBallot> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision', 'seatId', 'choice', 'reason']);
    const baseRevision = positiveInteger(input.baseRevision, 'Base revision'); const seatId = uuid(input.seatId, 'Seat ID');
    const choice = input.choice as BallotChoice; const reason = text(input.reason, 'Correction reason', 1000);
    if (!['FOR', 'AGAINST', 'ABSTAIN'].includes(choice)) throw new AppError({code: 'VALIDATION_FAILED', message: 'Vote choice is invalid.'});
    return transaction(this.pool, async client => {
      const located = await client.query<{committee_id: string}>('SELECT committee_id FROM ballots WHERE id=$1', [ballotId]);
      if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Ballot not found.'});
      const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
      await requireChair(client, committee, auth.user.id);
      const ballotResult = await client.query<BallotRow>('SELECT * FROM ballots WHERE id=$1 FOR UPDATE', [ballotId]);
      const ballot = ballotResult.rows[0] as BallotRow;
      if (ballot.status !== 'OPEN') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The ballot is not open.'});
      if (ballot.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT', message: 'This ballot changed since it was loaded.',
        details: {currentRevision: ballot.revision}});
      const eligibility = ballot.eligibility_snapshot.find(seat => seat.seatId === seatId);
      if (!eligibility || !ballot.choices.includes(choice) || (eligibility.mustVote && choice === 'ABSTAIN')) {
        throw new AppError({code: 'VALIDATION_FAILED', message: 'The corrected vote is invalid.'});
      }
      const vote = await client.query<{id: string; current_choice: BallotChoice; revision: number}>(`SELECT id,current_choice,revision
        FROM ballot_votes WHERE ballot_id=$1 AND seat_id=$2 FOR UPDATE`, [ballotId, seatId]);
      if (!vote.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Vote not found.'});
      await client.query(`UPDATE ballot_votes SET current_choice=$2,revision=revision+1 WHERE id=$1`, [vote.rows[0].id, choice]);
      await client.query(`INSERT INTO ballot_vote_revisions
        (id,ballot_id,vote_id,seat_id,previous_choice,new_choice,actor_user_id,on_behalf_of_seat_id,reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$4,$8)`, [randomUUID(), ballotId, vote.rows[0].id, seatId,
        vote.rows[0].current_choice, choice, auth.user.id, reason]);
      await client.query('UPDATE ballots SET revision=revision+1 WHERE id=$1', [ballotId]);
      await appendEvent(client, committee, {type: 'ballot.vote_corrected', resourceType: 'ballot', resourceId: ballotId,
        revision: ballot.revision + 1, payload: {seatId}, audience: 'CHAIR'});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        onBehalfOfSeatId: seatId, action: 'voting.vote_corrected', resourceType: 'ballot', resourceId: ballotId,
        before: {seatId, choice: vote.rows[0].current_choice, voteRevision: vote.rows[0].revision},
        after: {seatId, choice, voteRevision: vote.rows[0].revision + 1, ballotRevision: ballot.revision + 1, reason}});
      const updated = await client.query<BallotRow>('SELECT * FROM ballots WHERE id=$1', [ballotId]);
      return ballotState(client, updated.rows[0] as BallotRow);
    });
  }

  async closeBallot(auth: AuthenticatedSession, ballotId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<FormalBallot> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision']);
    const baseRevision = positiveInteger(input.baseRevision, 'Base revision');
    return transaction(this.pool, async client => {
      const located = await client.query<{committee_id: string}>('SELECT committee_id FROM ballots WHERE id=$1', [ballotId]);
      if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Ballot not found.'});
      const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
      await requireChair(client, committee, auth.user.id);
      const ballotResult = await client.query<BallotRow>('SELECT * FROM ballots WHERE id=$1 FOR UPDATE', [ballotId]);
      const ballot = ballotResult.rows[0] as BallotRow;
      if (ballot.status !== 'OPEN') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The ballot is not open.'});
      if (ballot.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT', message: 'This ballot changed since it was loaded.',
        details: {currentRevision: ballot.revision}});
      const votes = await client.query<{seat_id: string; current_choice: BallotChoice}>(`SELECT seat_id,current_choice
        FROM ballot_votes WHERE ballot_id=$1`, [ballotId]);
      const voted = new Set(votes.rows.map(vote => vote.seat_id));
      const missingMustVote = ballot.eligibility_snapshot.filter(seat => seat.mustVote && !voted.has(seat.seatId));
      const vetoRequiresAll = ballot.eligibility_snapshot.some(seat => seat.hasVeto);
      if (missingMustVote.length > 0 || (vetoRequiresAll && voted.size < ballot.eligibility_snapshot.length)) {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Required eligible votes have not all been cast.'});
      }
      const now = this.now(); const updated = await client.query<BallotRow>(`UPDATE ballots SET status='CLOSED',
        closed_at=$2,revision=revision+1 WHERE id=$1 RETURNING *`, [ballotId, now]);
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: 'voting.ballot_closed', resourceType: 'ballot', resourceId: ballotId,
        before: {status: 'OPEN', revision: ballot.revision}, after: {status: 'CLOSED', revision: ballot.revision + 1}});
      return ballotState(client, updated.rows[0] as BallotRow);
    });
  }

  async publishBallot(auth: AuthenticatedSession, ballotId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<FormalBallot> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision']);
    const baseRevision = positiveInteger(input.baseRevision, 'Base revision');
    return transaction(this.pool, async client => {
      const located = await client.query<{committee_id: string}>('SELECT committee_id FROM ballots WHERE id=$1', [ballotId]);
      if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Ballot not found.'});
      const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
      await requireChair(client, committee, auth.user.id);
      const ballotResult = await client.query<BallotRow>('SELECT * FROM ballots WHERE id=$1 FOR UPDATE', [ballotId]);
      const ballot = ballotResult.rows[0] as BallotRow;
      if (ballot.status !== 'CLOSED') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Close the ballot before publishing.'});
      if (ballot.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT', message: 'This ballot changed since it was loaded.',
        details: {currentRevision: ballot.revision}});
      const state = await ballotState(client, ballot); const result = calculateBallotResult(ballot.eligibility_snapshot,
        state.votes, ballot.threshold_value); const now = this.now();
      const updated = await client.query<BallotRow>(`UPDATE ballots SET status='PUBLISHED',result=$2,published_at=$3,
        revision=revision+1 WHERE id=$1 RETURNING *`, [ballotId, result, now]);
      if (ballot.subject_type === 'RESOLUTION' || ballot.subject_type === 'AMENDMENT') {
        const nextStatus: ProceedingDocumentStatus = ballot.subject_type === 'RESOLUTION'
          ? result.outcome === 'PASSED' ? 'PASSED' : 'FAILED'
          : result.outcome === 'PASSED' ? 'INCORPORATED' : 'REJECTED';
        const document = await client.query<DocumentRow>(`UPDATE documents SET status=$2,revision=revision+1,updated_at=$3
          WHERE id=$1 AND status='VOTING' RETURNING *,
          (SELECT resolution_document_id FROM amendments WHERE document_id=$1) AS resolution_document_id`,
        [ballot.subject_id, nextStatus, now]);
        if (!document.rows[0]) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The ballot document is not in voting state.'});
        const rule = await client.query<{rule_stable_id: string; rule_evaluation: FrozenRuleEvaluation}>(`SELECT
          rule_stable_id,rule_evaluation FROM document_actions WHERE document_id=$1 AND to_status='VOTING'
          ORDER BY created_at DESC,id DESC LIMIT 1`, [ballot.subject_id]);
        if (!rule.rows[0]) throw new AppError({code: 'INTERNAL_ERROR', message: 'Document voting rule is unavailable.'});
        await client.query(`INSERT INTO document_actions
          (id,committee_id,document_id,action,from_status,to_status,rule_stable_id,rule_evaluation,actor_user_id,created_at)
          VALUES ($1,$2,$3,'BALLOT_RESULT','VOTING',$4,$5,$6,$7,$8)`, [randomUUID(), committee.id,
          ballot.subject_id, nextStatus, rule.rows[0].rule_stable_id, rule.rows[0].rule_evaluation, auth.user.id, now]);
        await appendEvent(client, committee, {type: 'document.status_changed', resourceType: 'document',
          resourceId: ballot.subject_id, revision: document.rows[0].revision,
          payload: {kind: ballot.subject_type, status: nextStatus, ballotId}, audience: 'PUBLIC'});
        await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
          action: 'documents.status_changed', resourceType: 'document', resourceId: ballot.subject_id,
          before: {status: 'VOTING'}, after: {status: nextStatus, ballotId, result}});
      }
      await appendEvent(client, committee, {type: 'ballot.result_published', resourceType: 'ballot', resourceId: ballotId,
        revision: ballot.revision + 1, payload: {result, publishedAt: now.toISOString()}, audience: 'PUBLIC'});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: 'voting.result_published', resourceType: 'ballot', resourceId: ballotId,
        before: {status: ballot.status, revision: ballot.revision},
        after: {status: 'PUBLISHED', revision: ballot.revision + 1, result}});
      return ballotState(client, updated.rows[0] as BallotRow);
    });
  }

  async createStrawpoll(auth: AuthenticatedSession, committeeId: string, input: Record<string, unknown>, key: string,
    context: Stage4Context): Promise<CreatedStrawpoll> {
    requireBusinessIdentity(auth); assertExactBody(input, ['meetingSessionId', 'question', 'votingMode', 'multipleChoice', 'options']);
    const meetingSessionId = uuid(input.meetingSessionId, 'Meeting session ID');
    const question = text(input.question, 'Question', 1000); const votingMode = input.votingMode as StrawpollVotingMode;
    if (!['ANONYMOUS', 'SEAT_AUTHENTICATED'].includes(votingMode)) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Strawpoll voting mode is invalid.'});
    }
    if (typeof input.multipleChoice !== 'boolean') {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Strawpoll choice mode is invalid.'});
    }
    if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 20) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Strawpoll options are invalid.'});
    }
    const optionLabels = input.options.map((value, index) => text(value, `Option ${index + 1}`, 500));
    if (new Set(optionLabels).size !== optionLabels.length) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Strawpoll options must be unique.'});
    }
    return idempotentTransaction({pool: this.pool, auth, route: `POST /api/v1/committees/${committeeId}/strawpolls`,
      key, request: input, status: 201, work: async client => {
        const committee = await lockedCommittee(client, committeeId); requireProceedingsActive(committee);
        await requireChair(client, committee, auth.user.id);
        const session = await client.query<{status: string}>('SELECT status FROM meeting_sessions WHERE id=$1 AND committee_id=$2',
          [meetingSessionId, committeeId]);
        if (!session.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Meeting session not found.'});
        if (session.rows[0].status !== 'OPEN') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Meeting session is closed.'});
        const id = randomUUID(); const accessToken = votingMode === 'ANONYMOUS' ? randomBytes(32).toString('base64url') : undefined;
        const inserted = await client.query<StrawpollRow>(`INSERT INTO strawpolls
          (id,committee_id,meeting_session_id,question,voting_mode,multiple_choice,anonymous_access_token_hash,created_by_user_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [id, committeeId, meetingSessionId, question, votingMode,
          input.multipleChoice, accessToken ? sha256(accessToken) : null, auth.user.id]);
        for (const [index, label] of optionLabels.entries()) {
          await client.query('INSERT INTO strawpoll_options (id,strawpoll_id,label,sort_order) VALUES ($1,$2,$3,$4)',
            [randomUUID(), id, label, index]);
        }
        await appendEvent(client, committee, {type: 'strawpoll.created', resourceType: 'strawpoll', resourceId: id,
          revision: 1, payload: {question, votingMode, multipleChoice: input.multipleChoice,
            options: optionLabels.map((label, index) => ({label, sortOrder: index}))}, audience: 'PUBLIC'});
        await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['CHAIR'],
          action: 'voting.strawpoll_created', resourceType: 'strawpoll', resourceId: id,
          after: {votingMode, multipleChoice: input.multipleChoice, optionCount: optionLabels.length, revision: 1}});
        return {...await strawpollState(client, inserted.rows[0] as StrawpollRow),
          ...(accessToken ? {anonymousAccessToken: accessToken} : {})};
      }});
  }

  async voteStrawpoll(auth: AuthenticatedSession, strawpollId: string, input: Record<string, unknown>, key: string,
    context: Stage4Context): Promise<Strawpoll> {
    requireBusinessIdentity(auth);
    assertExactBody(input, ['optionIds', 'onBehalfOfSeatId', 'anonymousAccessToken']);
    if (!Array.isArray(input.optionIds) || input.optionIds.length < 1 || input.optionIds.length > 20) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Strawpoll choices are invalid.'});
    }
    const optionIds = input.optionIds.map((value, index) => uuid(value, `Option ID ${index + 1}`));
    if (new Set(optionIds).size !== optionIds.length) throw new AppError({code: 'VALIDATION_FAILED', message: 'Strawpoll choices are invalid.'});
    return idempotentTransaction({pool: this.pool, auth, route: `POST /api/v1/strawpolls/${strawpollId}/votes`, key,
      request: input, status: 201, work: async client => {
        const located = await client.query<{committee_id: string}>('SELECT committee_id FROM strawpolls WHERE id=$1', [strawpollId]);
        if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Strawpoll not found.'});
        const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
        const pollResult = await client.query<StrawpollRow & {anonymous_access_token_hash: Buffer | null}>(
          'SELECT * FROM strawpolls WHERE id=$1 FOR UPDATE', [strawpollId]);
        const poll = pollResult.rows[0];
        if (!poll) throw new AppError({code: 'NOT_FOUND', message: 'Strawpoll not found.'});
        if (poll.status !== 'OPEN') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The strawpoll is closed.'});
        if (!poll.multiple_choice && optionIds.length !== 1) {
          throw new AppError({code: 'VALIDATION_FAILED', message: 'Select one strawpoll option.'});
        }
        const validOptions = await client.query<{id: string}>('SELECT id FROM strawpoll_options WHERE strawpoll_id=$1 AND id=ANY($2::uuid[])',
          [strawpollId, optionIds]);
        if (validOptions.rowCount !== optionIds.length) throw new AppError({code: 'VALIDATION_FAILED', message: 'Strawpoll choice is invalid.'});
        const chair = await isChair(client, committee.id, auth.user.id);
        if (poll.voting_mode === 'ANONYMOUS') {
          if (input.onBehalfOfSeatId !== undefined) throw new AppError({code: 'VALIDATION_FAILED', message: 'Anonymous votes do not use seats.'});
          const accessToken = text(input.anonymousAccessToken, 'Anonymous access token', 200);
          if (!poll.anonymous_access_token_hash?.equals(sha256(accessToken))) {
            throw new AppError({code: 'FORBIDDEN', message: 'Anonymous strawpoll access is invalid.'});
          }
          const credentialHash = sha256(`${strawpollId}\0${accessToken}\0${auth.user.id}`);
          await client.query('INSERT INTO strawpoll_anonymous_receipts (strawpoll_id,credential_hash) VALUES ($1,$2)',
            [strawpollId, credentialHash]);
          await client.query('INSERT INTO strawpoll_anonymous_votes (id,strawpoll_id,option_ids) VALUES ($1,$2,$3)',
            [randomUUID(), strawpollId, optionIds]);
          await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
            capabilities: chair ? ['CHAIR'] : ['MEMBER'], action: 'voting.strawpoll_vote_recorded',
            resourceType: 'strawpoll', resourceId: strawpollId,
            after: {votingMode: 'ANONYMOUS', selectionCount: optionIds.length, revision: poll.revision + 1}});
        } else {
          if (input.anonymousAccessToken !== undefined) {
            throw new AppError({code: 'VALIDATION_FAILED', message: 'Seat strawpolls do not use anonymous credentials.'});
          }
          let seatId: string | null;
          if (chair) seatId = uuid(input.onBehalfOfSeatId, 'Represented seat ID');
          else {
            if (committee.operation_mode === 'CHAIR_OPERATED') throw new AppError({code: 'FORBIDDEN',
              message: 'Chair capability is required in Chair-operated mode.'});
            if (input.onBehalfOfSeatId !== undefined) throw new AppError({code: 'FORBIDDEN', message: 'A delegate cannot choose another seat.'});
            seatId = await activeSeat(client, committee.id, auth.user.id);
          }
          if (!seatId) throw new AppError({code: 'FORBIDDEN', message: 'An active committee seat is required.'});
          const present = await client.query(`SELECT 1 FROM current_attendance WHERE meeting_session_id=$1 AND seat_id=$2
            AND state='PRESENT'`, [poll.meeting_session_id, seatId]);
          if (!present.rowCount) throw new AppError({code: 'FORBIDDEN', message: 'The represented seat is not present.'});
          await client.query(`INSERT INTO strawpoll_seat_votes
            (id,strawpoll_id,seat_id,option_ids,actor_user_id,on_behalf_of_seat_id) VALUES ($1,$2,$3,$4,$5,$3)`,
          [randomUUID(), strawpollId, seatId, optionIds, auth.user.id]);
          await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
            capabilities: chair ? ['CHAIR'] : ['MEMBER'], onBehalfOfSeatId: seatId,
            action: 'voting.strawpoll_vote_recorded', resourceType: 'strawpoll', resourceId: strawpollId,
            after: {votingMode: 'SEAT_AUTHENTICATED', seatId, optionIds, revision: poll.revision + 1}});
        }
        await client.query('UPDATE strawpolls SET revision=revision+1 WHERE id=$1', [strawpollId]);
        await appendEvent(client, committee, {type: 'strawpoll.vote_recorded', resourceType: 'strawpoll', resourceId: strawpollId,
          revision: poll.revision + 1, payload: {votingMode: poll.voting_mode, voteCountIncrement: 1}, audience: 'PUBLIC'});
        const updated = await client.query<StrawpollRow>('SELECT * FROM strawpolls WHERE id=$1', [strawpollId]);
        return strawpollState(client, updated.rows[0] as StrawpollRow);
      }});
  }

  async closeStrawpoll(auth: AuthenticatedSession, strawpollId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<Strawpoll> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision']);
    const baseRevision = positiveInteger(input.baseRevision, 'Base revision');
    return transaction(this.pool, async client => {
      const located = await client.query<{committee_id: string}>('SELECT committee_id FROM strawpolls WHERE id=$1', [strawpollId]);
      if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Strawpoll not found.'});
      const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
      await requireChair(client, committee, auth.user.id);
      const pollResult = await client.query<StrawpollRow>('SELECT * FROM strawpolls WHERE id=$1 FOR UPDATE', [strawpollId]);
      const poll = pollResult.rows[0] as StrawpollRow;
      if (poll.status !== 'OPEN') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The strawpoll is closed.'});
      if (poll.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT',
        message: 'This strawpoll changed since it was loaded.', details: {currentRevision: poll.revision}});
      const now = this.now(); const updated = await client.query<StrawpollRow>(`UPDATE strawpolls SET status='CLOSED',
        closed_at=$2,revision=revision+1 WHERE id=$1 RETURNING *`, [strawpollId, now]);
      const state = await strawpollState(client, updated.rows[0] as StrawpollRow);
      await appendEvent(client, committee, {type: 'strawpoll.closed', resourceType: 'strawpoll', resourceId: strawpollId,
        revision: poll.revision + 1, payload: {closedAt: now.toISOString(), options: state.options}, audience: 'PUBLIC'});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: 'voting.strawpoll_closed', resourceType: 'strawpoll', resourceId: strawpollId,
        before: {status: 'OPEN', revision: poll.revision}, after: {status: 'CLOSED', revision: poll.revision + 1}});
      return state;
    });
  }

  async createResolution(auth: AuthenticatedSession, committeeId: string, input: Record<string, unknown>, key: string,
    context: Stage4Context): Promise<ProceedingDocument> {
    return this.createDocument(auth, committeeId, 'RESOLUTION', input, key, context);
  }

  async createAmendment(auth: AuthenticatedSession, resolutionId: string, input: Record<string, unknown>, key: string,
    context: Stage4Context): Promise<ProceedingDocument> {
    requireBusinessIdentity(auth);
    const located = await this.pool.query<{committee_id: string}>('SELECT committee_id FROM documents WHERE id=$1 AND kind=$2',
      [resolutionId, 'RESOLUTION']);
    if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Resolution not found.'});
    return this.createDocument(auth, located.rows[0].committee_id, 'AMENDMENT', {...input, resolutionId}, key, context);
  }

  private async createDocument(auth: AuthenticatedSession, committeeId: string, kind: ProceedingDocumentKind,
    input: Record<string, unknown>, key: string, context: Stage4Context): Promise<ProceedingDocument> {
    requireBusinessIdentity(auth);
    assertExactBody(input, kind === 'RESOLUTION'
      ? ['meetingSessionId', 'title', 'content', 'onBehalfOfSeatId']
      : ['meetingSessionId', 'title', 'content', 'onBehalfOfSeatId', 'resolutionId']);
    const meetingSessionId = uuid(input.meetingSessionId, 'Meeting session ID'); const title = text(input.title, 'Title', 500);
    const content = text(input.content, 'Content', 200_000); const resolutionId = kind === 'AMENDMENT'
      ? uuid(input.resolutionId, 'Resolution ID') : null;
    const route = kind === 'RESOLUTION' ? `POST /api/v1/committees/${committeeId}/resolutions`
      : `POST /api/v1/resolutions/${resolutionId}/amendments`;
    return idempotentTransaction({pool: this.pool, auth, route, key, request: input, status: 201, work: async client => {
      const committee = await lockedCommittee(client, committeeId); requireProceedingsActive(committee);
      const session = await client.query<{status: string; active_rule_package_version_id: string}>(`SELECT status,
        active_rule_package_version_id FROM meeting_sessions WHERE id=$1 AND committee_id=$2`, [meetingSessionId, committeeId]);
      if (!session.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Meeting session not found.'});
      if (session.rows[0].status !== 'OPEN') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Meeting session is closed.'});
      const actor = await representedDocumentSeat(client, committee, auth, input.onBehalfOfSeatId, meetingSessionId);
      let isPublic = false;
      if (kind === 'AMENDMENT') {
        const parent = await client.query<DocumentRow>(`SELECT d.*,NULL::uuid AS resolution_document_id FROM documents d
          WHERE d.id=$1 AND d.committee_id=$2 AND d.kind='RESOLUTION' FOR UPDATE`, [resolutionId, committeeId]);
        if (!parent.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Resolution not found.'});
        if (parent.rows[0].meeting_session_id !== meetingSessionId) throw new AppError({code: 'VALIDATION_FAILED',
          message: 'Amendment and resolution must use the same meeting session.'});
        if (!['PUBLISHED', 'POSTPONED'].includes(parent.rows[0].status)) throw new AppError({code: 'RESOURCE_CONFLICT',
          message: 'The resolution does not accept amendments.'});
        const rules = await client.query<{definition: {documents?: {amendmentsPublicByDefault?: unknown}}}>(
          'SELECT definition FROM rule_package_versions WHERE id=$1 AND status=$2',
          [session.rows[0].active_rule_package_version_id, 'PUBLISHED']);
        isPublic = rules.rows[0]?.definition.documents?.amendmentsPublicByDefault === true;
      }
      const id = randomUUID(); const versionId = randomUUID(); const now = this.now();
      const inserted = await client.query<DocumentRow>(`INSERT INTO documents
        (id,committee_id,meeting_session_id,kind,title,rule_package_version_id,current_version_id,is_public,
         created_by_user_id,created_on_behalf_of_seat_id,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *,NULL::uuid AS resolution_document_id`,
      [id, committeeId, meetingSessionId, kind, title, session.rows[0].active_rule_package_version_id, versionId,
        isPublic, auth.user.id, actor.seatId, now]);
      await client.query(`INSERT INTO document_versions
        (id,document_id,version_number,content,created_by_user_id,created_on_behalf_of_seat_id,created_at)
        VALUES ($1,$2,1,$3,$4,$5,$6)`, [versionId, id, content, auth.user.id, actor.seatId, now]);
      if (kind === 'RESOLUTION') await client.query('INSERT INTO resolutions (document_id,proposer_seat_id) VALUES ($1,$2)',
        [id, actor.seatId]);
      else await client.query(`INSERT INTO amendments (document_id,resolution_document_id,proposer_seat_id)
        VALUES ($1,$2,$3)`, [id, resolutionId, actor.seatId]);
      const eventAudience = isPublic ? 'PUBLIC' : 'MEMBER';
      await appendEvent(client, committee, {type: 'document.created', resourceType: 'document', resourceId: id, revision: 1,
        payload: {kind, resolutionId, title, status: 'DRAFT', currentVersionId: versionId,
          rulePackageVersionId: session.rows[0].active_rule_package_version_id}, audience: eventAudience});
      await audit(client, context, {committeeId, actorUserId: auth.user.id,
        capabilities: actor.chair ? ['CHAIR'] : ['MEMBER'], onBehalfOfSeatId: actor.seatId,
        action: 'documents.created', resourceType: 'document', resourceId: id,
        after: {kind, resolutionId, title, versionId, characterCount: [...content].length, revision: 1}});
      const row = inserted.rows[0] as DocumentRow; row.resolution_document_id = resolutionId;
      return documentState(client, row);
    }});
  }

  async createDocumentVersion(auth: AuthenticatedSession, documentId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<ProceedingDocument> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision', 'title', 'content', 'onBehalfOfSeatId']);
    const baseRevision = positiveInteger(input.baseRevision, 'Base revision'); const title = text(input.title, 'Title', 500);
    const content = text(input.content, 'Content', 200_000);
    return transaction(this.pool, async client => {
      const located = await client.query<{committee_id: string}>('SELECT committee_id FROM documents WHERE id=$1', [documentId]);
      if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Document not found.'});
      const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
      const found = await client.query<DocumentRow>(`SELECT d.*,a.resolution_document_id FROM documents d
        LEFT JOIN amendments a ON a.document_id=d.id WHERE d.id=$1 FOR UPDATE OF d`, [documentId]);
      const document = found.rows[0]; if (!document) throw new AppError({code: 'NOT_FOUND', message: 'Document not found.'});
      if (document.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT',
        message: 'This document changed since it was loaded.', details: {currentRevision: document.revision}});
      if (document.status === 'VOTING' || ['PASSED', 'FAILED', 'INCORPORATED', 'REJECTED'].includes(document.status)) {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The document version is frozen.'});
      }
      const actor = await representedDocumentSeat(client, committee, auth, input.onBehalfOfSeatId, document.meeting_session_id);
      if (!actor.chair && actor.seatId !== document.created_on_behalf_of_seat_id) throw new AppError({code: 'FORBIDDEN',
        message: 'Only the proposer or a Chair may create a new version.'});
      const next = await client.query<{version_number: number}>(
        'SELECT coalesce(max(version_number),0)+1 AS version_number FROM document_versions WHERE document_id=$1', [documentId]);
      const versionNumber = next.rows[0]?.version_number ?? 1; const versionId = randomUUID(); const now = this.now();
      await client.query(`INSERT INTO document_versions
        (id,document_id,version_number,content,created_by_user_id,created_on_behalf_of_seat_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [versionId, documentId, versionNumber, content, auth.user.id, actor.seatId, now]);
      const updated = await client.query<DocumentRow>(`UPDATE documents SET title=$2,current_version_id=$3,
        revision=revision+1,updated_at=$4 WHERE id=$1 RETURNING *,
        (SELECT resolution_document_id FROM amendments WHERE document_id=$1) AS resolution_document_id`,
      [documentId, title, versionId, now]);
      await appendEvent(client, committee, {type: 'document.version_created', resourceType: 'document', resourceId: documentId,
        revision: document.revision + 1, payload: {versionId, versionNumber, title},
        audience: document.is_public ? 'PUBLIC' : 'MEMBER'});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
        capabilities: actor.chair ? ['CHAIR'] : ['MEMBER'], onBehalfOfSeatId: actor.seatId,
        action: 'documents.version_created', resourceType: 'document', resourceId: documentId,
        before: {versionId: document.current_version_id, revision: document.revision},
        after: {versionId, versionNumber, characterCount: [...content].length, revision: document.revision + 1}});
      return documentState(client, updated.rows[0] as DocumentRow);
    });
  }

  async commandDocument(auth: AuthenticatedSession, documentId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<ProceedingDocument> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision', 'action', 'ruleStableId']);
    const baseRevision = positiveInteger(input.baseRevision, 'Base revision');
    const action = input.action as 'PUBLISH' | 'POSTPONE' | 'RESUME' | 'RECOMMEND_BALLOT';
    if (!['PUBLISH', 'POSTPONE', 'RESUME', 'RECOMMEND_BALLOT'].includes(action)) throw new AppError({
      code: 'VALIDATION_FAILED', message: 'Document action is invalid.'});
    const ruleStableId = text(input.ruleStableId, 'Rule stable ID', 128);
    return transaction(this.pool, async client => {
      const located = await client.query<{committee_id: string}>('SELECT committee_id FROM documents WHERE id=$1', [documentId]);
      if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Document not found.'});
      const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
      await requireChair(client, committee, auth.user.id);
      const found = await client.query<DocumentRow>(`SELECT d.*,a.resolution_document_id FROM documents d
        LEFT JOIN amendments a ON a.document_id=d.id WHERE d.id=$1 FOR UPDATE OF d`, [documentId]);
      const document = found.rows[0]; if (!document) throw new AppError({code: 'NOT_FOUND', message: 'Document not found.'});
      if (document.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT',
        message: 'This document changed since it was loaded.', details: {currentRevision: document.revision}});
      const expectedFrom: Record<typeof action, ProceedingDocumentStatus> = {PUBLISH: 'DRAFT', POSTPONE: 'PUBLISHED',
        RESUME: 'POSTPONED', RECOMMEND_BALLOT: 'PUBLISHED'};
      const nextStatus: Record<typeof action, ProceedingDocumentStatus> = {PUBLISH: 'PUBLISHED', POSTPONE: 'POSTPONED',
        RESUME: 'PUBLISHED', RECOMMEND_BALLOT: 'VOTING'};
      if (document.status !== expectedFrom[action]) throw new AppError({code: 'RESOURCE_CONFLICT',
        message: 'The document is not in the required state.'});
      const now = this.now(); const evaluation = await frozenDocumentRule(client, document, ruleStableId,
        documentRuleIds[document.kind][action], now); const status = nextStatus[action];
      const updated = await client.query<DocumentRow>(`UPDATE documents SET status=$2,is_public=true,
        voting_version_id=CASE WHEN $2='VOTING' THEN current_version_id ELSE voting_version_id END,
        revision=revision+1,updated_at=$3 WHERE id=$1 RETURNING *,
        (SELECT resolution_document_id FROM amendments WHERE document_id=$1) AS resolution_document_id`,
      [documentId, status, now]);
      await client.query(`INSERT INTO document_actions
        (id,committee_id,document_id,action,from_status,to_status,rule_stable_id,rule_evaluation,actor_user_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [randomUUID(), committee.id, documentId, action,
        document.status, status, ruleStableId, evaluation, auth.user.id, now]);
      await appendEvent(client, committee, {type: 'document.status_changed', resourceType: 'document', resourceId: documentId,
        revision: document.revision + 1, payload: {kind: document.kind, status, ruleStableId,
          votingVersionId: status === 'VOTING' ? document.current_version_id : document.voting_version_id}, audience: 'PUBLIC'});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: 'documents.status_changed', resourceType: 'document', resourceId: documentId,
        before: {status: document.status, revision: document.revision},
        after: {status, ruleStableId, revision: document.revision + 1}});
      return documentState(client, updated.rows[0] as DocumentRow);
    });
  }

  async addDocumentDiscussion(auth: AuthenticatedSession, documentId: string, input: Record<string, unknown>, key: string,
    context: Stage4Context): Promise<ProceedingDocument> {
    requireBusinessIdentity(auth); assertExactBody(input, ['content', 'ruleStableId', 'onBehalfOfSeatId']);
    const content = text(input.content, 'Discussion content', 10_000);
    const ruleStableId = text(input.ruleStableId, 'Rule stable ID', 128);
    return idempotentTransaction({pool: this.pool, auth, route: `POST /api/v1/documents/${documentId}/discussion`,
      key, request: input, status: 201, work: async client => {
        const located = await client.query<{committee_id: string}>('SELECT committee_id FROM documents WHERE id=$1', [documentId]);
        if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Document not found.'});
        const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
        const found = await client.query<DocumentRow>(`SELECT d.*,a.resolution_document_id FROM documents d
          LEFT JOIN amendments a ON a.document_id=d.id WHERE d.id=$1 FOR UPDATE OF d`, [documentId]);
        const document = found.rows[0]; if (!document) throw new AppError({code: 'NOT_FOUND', message: 'Document not found.'});
        if (document.status !== 'PUBLISHED') throw new AppError({code: 'RESOURCE_CONFLICT',
          message: 'The document is not open for discussion.'});
        const actor = await representedDocumentSeat(client, committee, auth, input.onBehalfOfSeatId, document.meeting_session_id);
        await frozenDocumentRule(client, document, ruleStableId, documentRuleIds[document.kind].DISCUSS, this.now());
        const id = randomUUID(); const now = this.now();
        await client.query(`INSERT INTO discussion_entries
          (id,committee_id,document_id,seat_id,seat_display_name,content,rule_stable_id,actor_user_id,on_behalf_of_seat_id,created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$4,$9)`, [id, committee.id, documentId, actor.seatId,
          actor.displayName, content, ruleStableId, auth.user.id, now]);
        await appendEvent(client, committee, {type: 'document.discussion_added', resourceType: 'document', resourceId: documentId,
          revision: document.revision, payload: {id, seatId: actor.seatId, seatDisplayName: actor.displayName,
            content, ruleStableId, createdAt: now.toISOString()}, audience: document.is_public ? 'PUBLIC' : 'MEMBER'});
        await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
          capabilities: actor.chair ? ['CHAIR'] : ['MEMBER'], onBehalfOfSeatId: actor.seatId,
          action: 'documents.discussion_added', resourceType: 'document', resourceId: documentId,
          after: {discussionEntryId: id, ruleStableId, characterCount: [...content].length}});
        return documentState(client, document);
      }});
  }
}
