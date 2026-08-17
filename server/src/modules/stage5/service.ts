import {createHash, randomBytes, randomUUID} from 'node:crypto';
import type {Pool, PoolClient, QueryResultRow} from 'pg';
import type {AuthoritativeTimer, BallotChoice, CreatedStrawpoll, FormalBallot, FrozenRuleEvaluation, ProceedingMotion,
  ProceedingDocument, ProceedingDocumentKind, ProceedingDocumentStatus, SpeakerList, SpeakerListKind, SpeakerQueueEntry,
  ResolutionDirectVoteMajority, ResolutionDirectVoteState, SpeakerStance, SpeechRecord, Strawpoll, StrawpollVotingMode,
  TimerOwnerType, YieldType} from '@quorum/contracts';
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
  name: string; topic: string; default_speech_ms: string | number; delegates_can_queue: boolean;
  rule_package_version_id: string; current_entry_id: string | null;
  speech_timer_id: string; total_timer_id: string | null; linked_resolution_document_id: string | null;
  revision: number; created_at: Date; closed_at: Date | null;
}

interface SpeakerEntryRow extends QueryResultRow {
  id: string; seat_id: string; seat_display_name: string; position: number;
  status: SpeakerQueueEntry['status']; stance: SpeakerStance; speech_duration_ms: string | number; created_at: Date;
}

interface SpeechRow extends QueryResultRow {
  id: string; speaker_list_id: string; queue_entry_id: string; seat_id: string; seat_display_name: string;
  kind: SpeechRecord['kind']; status: SpeechRecord['status']; inherited_from_speech_id: string | null;
  inherited_time_ms: string | number | null; can_yield: boolean; yield_type: YieldType | null;
  yield_target_seat_id: string | null; yield_decision_status: SpeechRecord['yieldDecisionStatus'];
  interaction_target_seat_id: string | null; revision: number; started_at: Date | null; ended_at: Date | null;
}

interface MeetingSessionRow extends QueryResultRow {
  id: string; committee_id: string; name: string; phase_id: string; active_rule_package_version_id: string;
  status: 'PENDING' | 'OPEN' | 'CLOSED'; revision: number; created_at: Date; closed_at: Date | null;
}

interface MotionRow extends QueryResultRow {
  id: string; committee_id: string; meeting_session_id: string; motion_type_id: string; proposed_by_seat_id: string;
  proposed_by_seat_display_name: string; parameters: Record<string, unknown>; status: ProceedingMotion['status'];
  rule_package_version_id: string; rule_evaluation: FrozenRuleEvaluation; required_second_count: number;
  revision: number; created_at: Date; decided_at: Date | null; destination_path: string | null;
  direct_vote_include_non_voting: boolean; direct_vote_started_at: Date | null; direct_vote_settings_revision: number;
}

interface BallotRow extends QueryResultRow {
  id: string; committee_id: string; meeting_session_id: string; subject_type: FormalBallot['subjectType']; subject_id: string;
  status: FormalBallot['status']; procedural: boolean; choices: BallotChoice[] | string; rule_package_version_id: string;
  rule_evaluation: FrozenRuleEvaluation; eligibility_snapshot: FormalBallot['eligibility'];
  threshold_definition: FormalBallot['threshold']; threshold_value: number; result: FormalBallot['result'];
  revision: number; opened_at: Date; closed_at: Date | null; published_at: Date | null;
}

function ballotChoices(value: BallotChoice[] | string): BallotChoice[] {
  if (Array.isArray(value)) return value;
  return value.slice(1, -1).split(",").filter(Boolean) as BallotChoice[];
}

interface StrawpollRow extends QueryResultRow {
  id: string; committee_id: string; meeting_session_id: string; question: string; voting_mode: StrawpollVotingMode;
  multiple_choice: boolean; status: Strawpoll['status']; stage: Strawpoll['stage']; medium: Strawpoll['medium'];
  options_are_public: boolean; series_id: string; round_number: number; superseded_by_id: string | null;
  revision: number; created_at: Date; closed_at: Date | null;
}

interface DocumentRow extends QueryResultRow {
  id: string; committee_id: string; meeting_session_id: string; kind: ProceedingDocumentKind; title: string;
  status: ProceedingDocumentStatus; rule_package_version_id: string; current_version_id: string;
  voting_version_id: string | null; is_public: boolean; created_by_user_id: string;
  created_on_behalf_of_seat_id: string | null; revision: number; created_at: Date; updated_at: Date;
  resolution_document_id: string | null;
}

interface ResolutionRow extends QueryResultRow {
  document_id: string; proposer_seat_id: string | null; seconder_seat_id: string | null; delegates_can_amend: boolean;
  direct_vote_majority: ResolutionDirectVoteMajority; direct_vote_started_at: Date | null; direct_vote_revision: number;
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

function motionText(parameters: Record<string, unknown>, key: string, name: string, max: number): string {
  return text(parameters[key], name, max);
}

function motionId(parameters: Record<string, unknown>, key: string, name: string): string {
  return uuid(parameters[key], name);
}

function motionDurationMs(parameters: Record<string, unknown>, durationKey = 'caucusDuration',
  unitKey = 'caucusUnit'): number {
  const duration = parameters[durationKey]; const unit = parameters[unitKey];
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || !['sec', 'min'].includes(unit as string)) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Motion duration is invalid.'});
  }
  const milliseconds = duration * (unit === 'min' ? 60_000 : 1_000);
  if (!Number.isSafeInteger(milliseconds)) throw new AppError({code: 'VALIDATION_FAILED', message: 'Motion duration is invalid.'});
  return milliseconds;
}

async function speakerListState(client: PoolClient, row: SpeakerListRow): Promise<SpeakerList> {
  const entries = await client.query<SpeakerEntryRow>(`SELECT id,seat_id,seat_display_name,position,status,stance,
    speech_duration_ms,created_at
    FROM speaker_queue_entries WHERE speaker_list_id=$1 ORDER BY position,created_at,id`, [row.id]);
  const speeches = await client.query<SpeechRow>('SELECT * FROM speeches WHERE speaker_list_id=$1 ORDER BY created_at,id', [row.id]);
  const speechRecords: SpeechRecord[] = [];
  for (const speech of speeches.rows) speechRecords.push(await speechState(client, speech));
  return {id: row.id, committeeId: row.committee_id, meetingSessionId: row.meeting_session_id, kind: row.kind,
    status: row.status, name: row.name, topic: row.topic, defaultSpeechMs: Number(row.default_speech_ms),
    delegatesCanQueue: row.delegates_can_queue,
    rulePackageVersionId: row.rule_package_version_id, currentEntryId: row.current_entry_id,
    speechTimerId: row.speech_timer_id, totalTimerId: row.total_timer_id,
    linkedResolutionId: row.linked_resolution_document_id, revision: row.revision,
    queue: entries.rows.map(entry => ({id: entry.id, seatId: entry.seat_id, seatDisplayName: entry.seat_display_name,
      position: entry.position, status: entry.status, stance: entry.stance,
      speechDurationMs: Number(entry.speech_duration_ms), createdAt: entry.created_at.toISOString()})),
    createdAt: row.created_at.toISOString(), closedAt: row.closed_at?.toISOString() ?? null,
    speeches: speechRecords};
}

async function speechState(client: PoolClient, row: SpeechRow): Promise<SpeechRecord> {
  const actions = await client.query<{id: string; action: SpeechRecord['actions'][number]['action'];
    remaining_ms: string | number; target_type: YieldType | null; target_seat_id: string | null; created_at: Date}>(
  `SELECT id,action,remaining_ms,target_type,target_seat_id,created_at FROM speech_actions
    WHERE speech_id=$1 ORDER BY created_at,id`, [row.id]);
  const contributions = await client.query<{id: string; type: 'QUESTION' | 'COMMENT'; seat_id: string;
    seat_display_name: string; content: string; created_at: Date}>(`SELECT id,type,seat_id,seat_display_name,content,created_at
    FROM speech_contributions WHERE speech_id=$1 ORDER BY created_at,id`, [row.id]);
  return {id: row.id, speakerListId: row.speaker_list_id, queueEntryId: row.queue_entry_id, seatId: row.seat_id,
    seatDisplayName: row.seat_display_name, kind: row.kind, status: row.status,
    inheritedFromSpeechId: row.inherited_from_speech_id, inheritedTimeMs: row.inherited_time_ms === null ? null : Number(row.inherited_time_ms),
    canYield: row.can_yield, yieldType: row.yield_type, yieldTargetSeatId: row.yield_target_seat_id,
    yieldDecisionStatus: row.yield_decision_status, interactionTargetSeatId: row.interaction_target_seat_id,
    revision: row.revision, startedAt: row.started_at?.toISOString() ?? null, endedAt: row.ended_at?.toISOString() ?? null,
    actions: actions.rows.map(action => ({id: action.id, action: action.action, remainingMs: Number(action.remaining_ms),
      targetType: action.target_type, targetSeatId: action.target_seat_id, createdAt: action.created_at.toISOString()})),
    contributions: contributions.rows.map(item => ({id: item.id, type: item.type, seatId: item.seat_id,
      seatDisplayName: item.seat_display_name, content: item.content, createdAt: item.created_at.toISOString()}))};
}

async function motionState(client: PoolClient, row: MotionRow): Promise<ProceedingMotion> {
  const seconds = await client.query<{id: string; seat_id: string; seat_display_name: string; created_at: Date}>(`SELECT
    id,seat_id,seat_display_name,created_at FROM motion_seconds WHERE motion_id=$1 ORDER BY created_at,id`, [row.id]);
  const eligible = await client.query<{seat_id: string; seat_display_name: string}>(`SELECT s.id AS seat_id,
    s.display_name AS seat_display_name FROM committee_seats s JOIN current_attendance a ON a.seat_id=s.id
    AND a.meeting_session_id=$2 AND a.state='PRESENT' WHERE s.committee_id=$1 AND s.active=true
    AND ($3 OR s.can_vote=true) ORDER BY s.sort_order,s.stable_key,s.id`,
  [row.committee_id, row.meeting_session_id, row.direct_vote_include_non_voting]);
  const votes = await client.query<{id: string; seat_id: string; seat_display_name: string; current_choice: BallotChoice;
    revision: number; cast_at: Date}>(`SELECT id,seat_id,seat_display_name,current_choice,revision,cast_at
    FROM motion_direct_votes WHERE motion_id=$1 AND retracted_at IS NULL ORDER BY seat_id`, [row.id]);
  const eligibleIds = new Set(eligible.rows.map(item => item.seat_id));
  const currentVotes = votes.rows.filter(item => eligibleIds.has(item.seat_id));
  const threshold = Math.floor(eligible.rows.length / 2) + 1;
  const forCount = currentVotes.filter(item => item.current_choice === 'FOR').length;
  const remaining = Math.max(0, eligible.rows.length - currentVotes.length);
  const automaticResult = eligible.rows.length === 0 || forCount + remaining < threshold ? 'FAILED'
    : forCount >= threshold ? 'PASSED' : null;
  const procedural = row.rule_evaluation.resolvedValues.procedural === true;
  return {id: row.id, committeeId: row.committee_id, meetingSessionId: row.meeting_session_id,
    motionTypeId: row.motion_type_id, proposedBySeatId: row.proposed_by_seat_id,
    proposedBySeatDisplayName: row.proposed_by_seat_display_name, parameters: row.parameters, status: row.status,
    rulePackageVersionId: row.rule_package_version_id, ruleEvaluation: row.rule_evaluation,
    requiredSecondCount: row.required_second_count,
    seconds: seconds.rows.map(item => ({id: item.id, seatId: item.seat_id, seatDisplayName: item.seat_display_name,
      createdAt: item.created_at.toISOString()})), directVote: {includeNonVotingSeats: row.direct_vote_include_non_voting,
      startedAt: row.direct_vote_started_at?.toISOString() ?? null, settingsRevision: row.direct_vote_settings_revision,
      eligibility: eligible.rows.map(item => ({seatId: item.seat_id, seatDisplayName: item.seat_display_name})),
      choices: procedural ? ['FOR', 'AGAINST'] : ['FOR', 'AGAINST', 'ABSTAIN'], threshold, automaticResult,
      votes: currentVotes.map(item => ({id: item.id, seatId: item.seat_id, seatDisplayName: item.seat_display_name,
        choice: item.current_choice, revision: item.revision, castAt: item.cast_at.toISOString()}))},
    revision: row.revision, createdAt: row.created_at.toISOString(),
    decidedAt: row.decided_at?.toISOString() ?? null, destinationPath: row.destination_path};
}

async function ballotState(client: PoolClient, row: BallotRow, includeVotes = true): Promise<FormalBallot> {
  const votes = includeVotes ? await client.query<{id: string; seat_id: string; seat_display_name: string;
    current_choice: BallotChoice; revision: number; cast_at: Date}>(`SELECT id,seat_id,seat_display_name,current_choice,
    revision,cast_at FROM ballot_votes WHERE ballot_id=$1 AND retracted_at IS NULL ORDER BY seat_id`, [row.id]) : {rows: []};
  return {id: row.id, committeeId: row.committee_id, meetingSessionId: row.meeting_session_id,
    subjectType: row.subject_type, subjectId: row.subject_id, status: row.status, procedural: row.procedural,
    choices: ballotChoices(row.choices), rulePackageVersionId: row.rule_package_version_id, ruleEvaluation: row.rule_evaluation,
    eligibility: row.eligibility_snapshot, threshold: row.threshold_definition,
    votes: votes.rows.map(vote => ({id: vote.id, seatId: vote.seat_id, seatDisplayName: vote.seat_display_name,
      choice: vote.current_choice, revision: vote.revision, castAt: vote.cast_at.toISOString()})), result: row.result,
    revision: row.revision, openedAt: row.opened_at.toISOString(), closedAt: row.closed_at?.toISOString() ?? null,
    publishedAt: row.published_at?.toISOString() ?? null};
}

async function strawpollState(client: PoolClient, row: StrawpollRow): Promise<Strawpoll> {
  const options = await client.query<{id: string; label: string; sort_order: number; vote_count: string}>(`WITH votes AS (
      SELECT unnest(option_ids) AS option_id FROM strawpoll_seat_votes WHERE strawpoll_id=$1 AND retracted_at IS NULL
      UNION ALL
      SELECT unnest(option_ids) AS option_id FROM strawpoll_anonymous_votes WHERE strawpoll_id=$1
    ) SELECT o.id,o.label,o.sort_order,
      CASE WHEN $2='MANUAL' THEN o.manual_tally ELSE count(v.option_id)::int END::text AS vote_count FROM strawpoll_options o
      LEFT JOIN votes v ON v.option_id=o.id WHERE o.strawpoll_id=$1
      GROUP BY o.id,o.label,o.sort_order,o.manual_tally ORDER BY o.sort_order,o.id`, [row.id, row.medium]);
  const seatVotes = await client.query<{id: string; seat_id: string; option_ids: string[]; revision: number; created_at: Date}>(
    `SELECT id,seat_id,option_ids,revision,created_at FROM strawpoll_seat_votes
      WHERE strawpoll_id=$1 AND retracted_at IS NULL ORDER BY seat_id`, [row.id]);
  return {id: row.id, committeeId: row.committee_id, meetingSessionId: row.meeting_session_id,
    question: row.question, votingMode: row.voting_mode, multipleChoice: row.multiple_choice, status: row.status,
    stage: row.stage, medium: row.medium, optionsArePublic: row.options_are_public, seriesId: row.series_id,
    roundNumber: row.round_number, supersededById: row.superseded_by_id,
    options: options.rows.map(option => ({id: option.id, label: option.label, sortOrder: option.sort_order,
      voteCount: Number(option.vote_count)})), seatVotes: seatVotes.rows.map(vote => ({id: vote.id, seatId: vote.seat_id,
      optionIds: vote.option_ids, revision: vote.revision, castAt: vote.created_at.toISOString()})),
    revision: row.revision, createdAt: row.created_at.toISOString(),
    closedAt: row.closed_at?.toISOString() ?? null};
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

async function documentState(client: PoolClient, row: DocumentRow): Promise<ProceedingDocument> {
  const version = await client.query<{id: string; version_number: number; content: string; content_file_entry_id: string | null;
    logical_name: string | null; original_name: string | null; media_type: string | null;
    file_status: 'UPLOAD_COMPLETE' | 'PENDING_REVIEW' | 'PUBLISHED' | null; created_at: Date}>(
  `SELECT v.id,v.version_number,v.content,v.content_file_entry_id,e.logical_name,f.original_name,f.media_type,
    CASE WHEN e.status='DELETED' THEN NULL ELSE e.status END AS file_status,v.created_at
    FROM document_versions v LEFT JOIN file_entries e ON e.id=v.content_file_entry_id
    LEFT JOIN file_versions f ON f.id=e.current_version_id WHERE v.document_id=$1 AND v.id=$2`,
  [row.id, row.current_version_id]);
  const discussion = await client.query<{id: string; seat_id: string; seat_display_name: string; content: string;
    rule_stable_id: string; created_at: Date}>(`SELECT id,seat_id,seat_display_name,content,rule_stable_id,created_at
    FROM discussion_entries WHERE document_id=$1 ORDER BY created_at,id`, [row.id]);
  const current = version.rows[0];
  if (!current) throw new AppError({code: 'INTERNAL_ERROR', message: 'Document version is unavailable.'});
  const resultDecisions = await client.query<{id: string; previous_status: ProceedingDocumentStatus;
    new_status: ProceedingDocumentStatus; reason: string | null; corrects_decision_id: string | null; created_at: Date}>(
  `SELECT id,previous_status,new_status,reason,corrects_decision_id,created_at FROM document_result_decisions
    WHERE document_id=$1 ORDER BY created_at,id`, [row.id]);
  let proposerSeatId: string | null = null; let seconderSeatId: string | null = null;
  let delegatesCanAmend = false; let directVote: ResolutionDirectVoteState | null = null;
  if (row.kind === 'RESOLUTION') {
    const resolution = await client.query<ResolutionRow>('SELECT * FROM resolutions WHERE document_id=$1', [row.id]);
    const metadata = resolution.rows[0];
    if (!metadata) throw new AppError({code: 'INTERNAL_ERROR', message: 'Resolution metadata is unavailable.'});
    proposerSeatId = metadata.proposer_seat_id; seconderSeatId = metadata.seconder_seat_id;
    delegatesCanAmend = metadata.delegates_can_amend;
    directVote = await resolutionDirectVoteState(client, row, metadata);
  } else {
    const amendment = await client.query<{proposer_seat_id: string}>('SELECT proposer_seat_id FROM amendments WHERE document_id=$1', [row.id]);
    proposerSeatId = amendment.rows[0]?.proposer_seat_id ?? null;
  }
  return {id: row.id, committeeId: row.committee_id, meetingSessionId: row.meeting_session_id, kind: row.kind,
    resolutionId: row.resolution_document_id, title: row.title, status: row.status,
    rulePackageVersionId: row.rule_package_version_id,
    currentVersion: {id: current.id, versionNumber: current.version_number, content: current.content,
      contentFile: current.content_file_entry_id && current.logical_name && current.original_name && current.media_type
        && current.file_status ? {id: current.content_file_entry_id, logicalName: current.logical_name,
          originalName: current.original_name, mediaType: current.media_type, status: current.file_status} : null,
      createdAt: current.created_at.toISOString()}, votingVersionId: row.voting_version_id, public: row.is_public,
    proposerSeatId, seconderSeatId, delegatesCanAmend, directVote,
    resultDecisions: resultDecisions.rows.map(item => ({id: item.id, previousStatus: item.previous_status,
      newStatus: item.new_status, reason: item.reason, correctsDecisionId: item.corrects_decision_id,
      createdAt: item.created_at.toISOString()})),
    revision: row.revision, discussion: discussion.rows.map(entry => ({id: entry.id, seatId: entry.seat_id,
      seatDisplayName: entry.seat_display_name, content: entry.content, ruleStableId: entry.rule_stable_id,
      createdAt: entry.created_at.toISOString()})), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString()};
}

async function resolutionDirectVoteState(client: PoolClient, document: DocumentRow,
  resolution: ResolutionRow): Promise<ResolutionDirectVoteState> {
  const eligibility = await client.query<{seat_id: string; seat_display_name: string; must_vote: boolean; has_veto: boolean}>(
  `SELECT s.id AS seat_id,s.display_name AS seat_display_name,s.must_vote,s.has_veto FROM committee_seats s
    JOIN current_attendance a ON a.seat_id=s.id AND a.meeting_session_id=$2 AND a.state='PRESENT'
    WHERE s.committee_id=$1 AND s.active=true AND s.can_vote=true ORDER BY s.sort_order,s.stable_key,s.id`,
  [document.committee_id, document.meeting_session_id]);
  const votes = await client.query<{id: string; seat_id: string; seat_display_name: string; current_choice: BallotChoice;
    revision: number; cast_at: Date}>(`SELECT id,seat_id,seat_display_name,current_choice,revision,cast_at
    FROM resolution_direct_votes WHERE resolution_document_id=$1 AND retracted_at IS NULL ORDER BY seat_id`, [document.id]);
  const eligibleIds = new Set(eligibility.rows.map(item => item.seat_id));
  const currentVotes = votes.rows.filter(vote => eligibleIds.has(vote.seat_id));
  const forCount = currentVotes.filter(vote => vote.current_choice === 'FOR').length;
  const againstCount = currentVotes.filter(vote => vote.current_choice === 'AGAINST').length;
  const castCount = currentVotes.length; const eligibleCount = eligibility.rows.length;
  const hasVetoSeat = eligibility.rows.some(item => item.has_veto);
  const vetoed = castCount >= eligibleCount && currentVotes.some(vote => vote.current_choice === 'AGAINST'
    && eligibility.rows.some(item => item.seat_id === vote.seat_id && item.has_veto));
  let threshold: number; let automaticResult: ResolutionDirectVoteState['automaticResult'] = null;
  if (resolution.direct_vote_majority === 'TWO_THIRDS_NON_ABSTAINING') {
    threshold = Math.ceil(2 * (forCount + againstCount) / 3);
    const remaining = Math.max(0, eligibleCount - castCount);
    const bestFor = forCount + remaining; const bestThreshold = Math.ceil(2 * (forCount + againstCount + remaining) / 3);
    if (vetoed) automaticResult = 'VETOED';
    else if ((!hasVetoSeat || castCount >= eligibleCount) && forCount > 0 && forCount >= threshold) automaticResult = 'PASSED';
    else if (eligibleCount === 0 || bestFor < bestThreshold) automaticResult = 'FAILED';
  } else {
    threshold = resolution.direct_vote_majority === 'TWO_THIRDS'
      ? Math.ceil(2 * eligibleCount / 3) : Math.floor(eligibleCount / 2) + 1;
    const remaining = Math.max(0, eligibleCount - castCount);
    if (vetoed) automaticResult = 'VETOED';
    else if ((!hasVetoSeat || castCount >= eligibleCount) && forCount >= threshold) automaticResult = 'PASSED';
    else if (eligibleCount === 0 || forCount + remaining < threshold) automaticResult = 'FAILED';
  }
  return {majority: resolution.direct_vote_majority, startedAt: resolution.direct_vote_started_at?.toISOString() ?? null,
    settingsRevision: resolution.direct_vote_revision, eligibility: eligibility.rows.map(item => ({seatId: item.seat_id,
      seatDisplayName: item.seat_display_name, mustVote: item.must_vote, hasVeto: item.has_veto})), threshold,
    automaticResult, votes: currentVotes.map(vote => ({id: vote.id, seatId: vote.seat_id,
      seatDisplayName: vote.seat_display_name, choice: vote.current_choice, revision: vote.revision,
      castAt: vote.cast_at.toISOString()}))};
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

export function canYieldSpeech(speech: Pick<SpeechRow, 'kind' | 'can_yield' | 'status'>
  & {yield_decision_status?: SpeechRecord['yieldDecisionStatus']},
  remainingMs: number, timerRunning: boolean): boolean {
  return speech.kind === 'ORIGINAL' && speech.can_yield && speech.status === 'PAUSED'
    && speech.yield_decision_status !== 'PENDING' && remainingMs > 1_000 && !timerRunning;
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
    assertExactBody(input, ['meetingSessionId', 'kind', 'name', 'topic', 'defaultSpeechMs', 'totalDurationMs',
      'delegatesCanQueue']);
    const meetingSessionId = uuid(input.meetingSessionId, 'Meeting session ID'); const kind = input.kind as SpeakerListKind;
    if (!['GENERAL', 'MODERATED_CAUCUS'].includes(kind)) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Speaker list kind is invalid.'});
    }
    const name = text(input.name ?? (kind === 'GENERAL' ? "General Speakers' List" : 'untitled caucus'), 'Name', 200);
    const topic = text(input.topic ?? '', 'Topic', 500, kind === 'GENERAL');
    const defaultSpeechMs = positiveInteger(input.defaultSpeechMs, 'Speech duration');
    const delegatesCanQueue = input.delegatesCanQueue ?? false;
    if (typeof delegatesCanQueue !== 'boolean') {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Delegate queue setting is invalid.'});
    }
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
        if (kind === 'GENERAL') {
          const existing = await client.query('SELECT 1 FROM speaker_lists WHERE meeting_session_id=$1 AND kind=\'GENERAL\'',
            [meetingSessionId]);
          if (existing.rowCount) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The main speakers list already exists.'});
        }
        const listId = randomUUID(); const speechTimerId = randomUUID(); const caucusId = randomUUID();
        const totalTimerId = kind === 'MODERATED_CAUCUS' ? randomUUID() : null;
        await client.query(`INSERT INTO timer_states
          (id,committee_id,owner_type,owner_id,remaining_at_start_ms,created_by_user_id)
          VALUES ($1,$2,'SPEAKER_LIST',$3,$4,$5)`, [speechTimerId, committeeId, listId, defaultSpeechMs, auth.user.id]);
        if (totalTimerId) await client.query(`INSERT INTO timer_states
          (id,committee_id,owner_type,owner_id,remaining_at_start_ms,created_by_user_id)
          VALUES ($1,$2,'CAUCUS',$3,$4,$5)`, [totalTimerId, committeeId, caucusId, totalDurationMs, auth.user.id]);
        const inserted = await client.query<SpeakerListRow>(`INSERT INTO speaker_lists
          (id,committee_id,meeting_session_id,kind,name,topic,default_speech_ms,delegates_can_queue,
           rule_package_version_id,speech_timer_id,total_timer_id,created_by_user_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [listId, committeeId, meetingSessionId, kind, name, topic, defaultSpeechMs, delegatesCanQueue,
          session.rows[0].active_rule_package_version_id, speechTimerId, totalTimerId, auth.user.id]);
        if (totalTimerId) await client.query(`INSERT INTO caucuses
          (id,committee_id,meeting_session_id,speaker_list_id,topic,total_timer_id,speech_timer_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`, [caucusId, committeeId, meetingSessionId, listId, topic, totalTimerId, speechTimerId]);
        await appendEvent(client, committee, {type: 'speaker_list.created', resourceType: 'speaker_list', resourceId: listId,
          revision: 1, payload: {kind, name, topic, defaultSpeechMs, totalDurationMs, delegatesCanQueue,
            rulePackageVersionId: session.rows[0].active_rule_package_version_id}, audience: 'PUBLIC'});
        await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['CHAIR'],
          action: 'proceedings.speaker_list_created', resourceType: 'speaker_list', resourceId: listId,
          after: {kind, name, topic, defaultSpeechMs, totalDurationMs, delegatesCanQueue, revision: 1}});
        return speakerListState(client, inserted.rows[0] as SpeakerListRow);
      }});
  }

  async updateSpeakerList(auth: AuthenticatedSession, listId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<SpeakerList> {
    requireBusinessIdentity(auth);
    assertExactBody(input, ['baseRevision', 'name', 'topic', 'defaultSpeechMs', 'delegatesCanQueue']);
    const baseRevision = positiveInteger(input.baseRevision, 'Base revision');
    if (input.name === undefined && input.topic === undefined && input.defaultSpeechMs === undefined
      && input.delegatesCanQueue === undefined) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'A speaker list change is required.'});
    }
    return transaction(this.pool, async client => {
      const located = await client.query<{committee_id: string}>('SELECT committee_id FROM speaker_lists WHERE id=$1', [listId]);
      if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Speaker list not found.'});
      const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
      await requireChair(client, committee, auth.user.id);
      const found = await client.query<SpeakerListRow>('SELECT * FROM speaker_lists WHERE id=$1 FOR UPDATE', [listId]);
      const list = found.rows[0] as SpeakerListRow;
      if (list.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT',
        message: 'This speaker list changed since it was loaded.', details: {currentRevision: list.revision}});
      const name = input.name === undefined ? list.name : text(input.name, 'Name', 200);
      const topic = input.topic === undefined ? list.topic : text(input.topic, 'Topic', 500, true);
      const defaultSpeechMs = input.defaultSpeechMs === undefined ? Number(list.default_speech_ms)
        : positiveInteger(input.defaultSpeechMs, 'Speech duration');
      const delegatesCanQueue = input.delegatesCanQueue === undefined ? list.delegates_can_queue : input.delegatesCanQueue;
      if (typeof delegatesCanQueue !== 'boolean') {
        throw new AppError({code: 'VALIDATION_FAILED', message: 'Delegate queue setting is invalid.'});
      }
      const updated = await client.query<SpeakerListRow>(`UPDATE speaker_lists SET name=$2,topic=$3,default_speech_ms=$4,
        delegates_can_queue=$5,revision=revision+1 WHERE id=$1 RETURNING *`,
      [listId, name, topic, defaultSpeechMs, delegatesCanQueue]);
      if (list.kind === 'MODERATED_CAUCUS' && topic !== list.topic) {
        await client.query('UPDATE caucuses SET topic=$2,revision=revision+1 WHERE speaker_list_id=$1', [listId, topic]);
      }
      await appendEvent(client, committee, {type: 'speaker_list.changed', resourceType: 'speaker_list', resourceId: listId,
        revision: list.revision + 1, payload: {command: 'UPDATED', name, topic, defaultSpeechMs, delegatesCanQueue},
        audience: 'PUBLIC'});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: 'proceedings.speaker_list_updated', resourceType: 'speaker_list', resourceId: listId,
        before: {name: list.name, topic: list.topic, defaultSpeechMs: Number(list.default_speech_ms),
          delegatesCanQueue: list.delegates_can_queue, revision: list.revision},
        after: {name, topic, defaultSpeechMs, delegatesCanQueue, revision: list.revision + 1}});
      return speakerListState(client, updated.rows[0] as SpeakerListRow);
    });
  }

  async setSpeakerListStatus(auth: AuthenticatedSession, listId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<SpeakerList> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision', 'status']);
    const baseRevision = positiveInteger(input.baseRevision, 'Base revision');
    const status = input.status as SpeakerList['status'];
    if (!['OPEN', 'CLOSED'].includes(status)) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Speaker list status is invalid.'});
    }
    return transaction(this.pool, async client => {
      const located = await client.query<{committee_id: string}>('SELECT committee_id FROM speaker_lists WHERE id=$1', [listId]);
      if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Speaker list not found.'});
      const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
      await requireChair(client, committee, auth.user.id);
      const found = await client.query<SpeakerListRow>('SELECT * FROM speaker_lists WHERE id=$1 FOR UPDATE', [listId]);
      const list = found.rows[0] as SpeakerListRow;
      if (list.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT',
        message: 'This speaker list changed since it was loaded.', details: {currentRevision: list.revision}});
      if (list.status === status) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The speaker list already has that status.'});
      const now = this.now();
      if (status === 'CLOSED') {
        const timers = await client.query<TimerRow>('SELECT * FROM timer_states WHERE id=ANY($1::uuid[]) FOR UPDATE',
          [[list.speech_timer_id, list.total_timer_id].filter(Boolean)]);
        for (const timer of timers.rows) {
          const remaining = remainingTimerMs(timer, now);
          await client.query(`UPDATE timer_states SET running=false,started_at=NULL,remaining_at_start_ms=$2,
            revision=revision+1,updated_at=$3 WHERE id=$1`, [timer.id, remaining, now]);
          await appendEvent(client, committee, {type: 'timer.changed', resourceType: 'timer', resourceId: timer.id,
            revision: timer.revision + 1, payload: {command: 'PAUSED_BY_LIST_CLOSE', running: false, remainingMs: remaining}});
          await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
            action: 'timers.paused', resourceType: 'timer', resourceId: timer.id,
            before: {running: timer.running, remainingMs: remaining, revision: timer.revision},
            after: {running: false, remainingMs: remaining, revision: timer.revision + 1, reason: 'SPEAKER_LIST_CLOSED'}});
        }
        const active = await client.query<SpeechRow>(`SELECT * FROM speeches WHERE speaker_list_id=$1
          AND status IN ('READY','RUNNING','PAUSED') FOR UPDATE`, [listId]);
        const speech = active.rows[0];
        if (speech) {
          const remaining = timers.rows.find(timer => timer.id === list.speech_timer_id);
          const remainingMs = remaining ? remainingTimerMs(remaining, now) : 0;
          if (speech.yield_decision_status === 'PENDING') {
            await client.query(`INSERT INTO speech_actions
              (id,committee_id,speech_id,action,remaining_ms,target_type,target_seat_id,actor_user_id,on_behalf_of_seat_id,details)
              VALUES ($1,$2,$3,'YIELD_REJECTED',$4,'SEAT',$5,$6,$7,$8)`,
            [randomUUID(), committee.id, speech.id, remainingMs, speech.yield_target_seat_id, auth.user.id,
              speech.seat_id, {reason: 'SPEAKER_LIST_CLOSED'}]);
          }
          await client.query(`UPDATE speeches SET status='COMPLETED',ended_at=$2,revision=revision+1,
            yield_decision_status=CASE WHEN yield_decision_status='PENDING' THEN 'REJECTED'::speech_yield_decision_status
              ELSE yield_decision_status END WHERE id=$1`, [speech.id, now]);
          await client.query(`INSERT INTO speech_actions
            (id,committee_id,speech_id,action,remaining_ms,actor_user_id,on_behalf_of_seat_id,details)
            VALUES ($1,$2,$3,'COMPLETED',$4,$5,$6,$7)`,
          [randomUUID(), committee.id, speech.id, remainingMs, auth.user.id, speech.seat_id, {reason: 'SPEAKER_LIST_CLOSED'}]);
          await appendEvent(client, committee, {type: 'speech.changed', resourceType: 'speech', resourceId: speech.id,
            revision: speech.revision + 1, payload: {command: 'COMPLETED_BY_LIST_CLOSE', speakerListId: listId,
              remainingMs}});
          await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
            onBehalfOfSeatId: speech.seat_id, action: 'proceedings.speech_completed', resourceType: 'speech',
            resourceId: speech.id, after: {speakerListId: listId, remainingMs, revision: speech.revision + 1,
              reason: 'SPEAKER_LIST_CLOSED'}});
        }
      }
      const updated = await client.query<SpeakerListRow>(`UPDATE speaker_lists SET status=$2,closed_at=$3,
        revision=revision+1 WHERE id=$1 RETURNING *`, [listId, status, status === 'CLOSED' ? now : null]);
      if (list.kind === 'MODERATED_CAUCUS') await client.query(`UPDATE caucuses SET status=$2,closed_at=$3,
        revision=revision+1 WHERE speaker_list_id=$1`, [listId, status, status === 'CLOSED' ? now : null]);
      await appendEvent(client, committee, {type: 'speaker_list.changed', resourceType: 'speaker_list', resourceId: listId,
        revision: list.revision + 1, payload: {command: status === 'CLOSED' ? 'CLOSED' : 'REOPENED', status}, audience: 'PUBLIC'});
      if (status === 'CLOSED') await appendEvent(client, committee, {type: 'caucus.closed', resourceType: 'speaker_list',
        resourceId: listId, revision: list.revision + 1, payload: {command: 'CLOSED_MANUALLY'}, audience: 'PUBLIC'});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: 'proceedings.speaker_list_status_changed', resourceType: 'speaker_list', resourceId: listId,
        before: {status: list.status, revision: list.revision}, after: {status, revision: list.revision + 1}});
      return speakerListState(client, updated.rows[0] as SpeakerListRow);
    });
  }

  async joinSpeakerQueue(auth: AuthenticatedSession, listId: string, input: Record<string, unknown>, key: string,
    context: Stage4Context): Promise<SpeakerList> {
    requireBusinessIdentity(auth); assertExactBody(input, ['seatId', 'stance']);
    const stance = (input.stance ?? 'NEUTRAL') as SpeakerStance;
    if (!['FOR', 'NEUTRAL', 'AGAINST'].includes(stance)) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Speaker stance is invalid.'});
    }
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
          if (!list.delegates_can_queue) {
            throw new AppError({code: 'FORBIDDEN', message: 'Delegate self-queueing is disabled for this speaker list.'});
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
          (id,committee_id,speaker_list_id,seat_id,seat_display_name,position,stance,speech_duration_ms,
           actor_user_id,on_behalf_of_seat_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$4)`, [entryId, committee.id, listId, seatId, seat.rows[0].display_name,
          position.rows[0]?.next ?? 1, stance, list.default_speech_ms, auth.user.id]);
        const updated = await client.query<SpeakerListRow>('UPDATE speaker_lists SET revision=revision+1 WHERE id=$1 RETURNING *', [listId]);
        await appendEvent(client, committee, {type: 'speaker_queue.changed', resourceType: 'speaker_list', resourceId: listId,
          revision: list.revision + 1, payload: {command: 'JOINED', entryId, seatId}, audience: 'PUBLIC'});
        await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
          capabilities: chair ? ['CHAIR'] : ['MEMBER'], onBehalfOfSeatId: seatId,
          action: 'proceedings.speaker_joined_queue', resourceType: 'speaker_list', resourceId: listId,
          after: {entryId, seatId, stance, speechDurationMs: Number(list.default_speech_ms), revision: list.revision + 1}});
        return speakerListState(client, updated.rows[0] as SpeakerListRow);
      }});
  }

  async removeSpeakerQueueEntry(auth: AuthenticatedSession, listId: string, entryId: string,
    input: Record<string, unknown>, context: Stage4Context): Promise<SpeakerList> {
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
      const entryResult = await client.query<SpeakerEntryRow>(`SELECT * FROM speaker_queue_entries
        WHERE id=$1 AND speaker_list_id=$2 FOR UPDATE`, [entryId, listId]);
      const entry = entryResult.rows[0];
      if (!entry || !['QUEUED', 'CURRENT'].includes(entry.status)) {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The speaker is no longer in the active queue.'});
      }
      const now = this.now();
      if (entry.status === 'CURRENT') {
        const timerResult = await client.query<TimerRow>('SELECT * FROM timer_states WHERE id=$1 FOR UPDATE', [list.speech_timer_id]);
        const timer = timerResult.rows[0]; const remainingMs = timer ? remainingTimerMs(timer, now) : 0;
        if (timer) {
          await client.query(`UPDATE timer_states SET running=false,started_at=NULL,remaining_at_start_ms=$2,
            revision=revision+1,updated_at=$3 WHERE id=$1`, [timer.id, remainingMs, now]);
          await appendEvent(client, committee, {type: 'timer.changed', resourceType: 'timer', resourceId: timer.id,
            revision: timer.revision + 1, payload: {command: 'PAUSED_BY_SPEAKER_REMOVAL', running: false, remainingMs}});
          await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
            action: 'timers.paused', resourceType: 'timer', resourceId: timer.id,
            before: {running: timer.running, remainingMs, revision: timer.revision},
            after: {running: false, remainingMs, revision: timer.revision + 1, reason: 'SPEAKER_REMOVED'}});
        }
        if (list.total_timer_id) {
          const totalResult = await client.query<TimerRow>('SELECT * FROM timer_states WHERE id=$1 FOR UPDATE', [list.total_timer_id]);
          const total = totalResult.rows[0];
          if (total) {
            const totalRemainingMs = remainingTimerMs(total, now);
            await client.query(`UPDATE timer_states SET running=false,started_at=NULL,remaining_at_start_ms=$2,
              revision=revision+1,updated_at=$3 WHERE id=$1`, [total.id, totalRemainingMs, now]);
            await appendEvent(client, committee, {type: 'timer.changed', resourceType: 'timer', resourceId: total.id,
              revision: total.revision + 1,
              payload: {command: 'PAUSED_BY_SPEAKER_REMOVAL', running: false, remainingMs: totalRemainingMs}});
            await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
              action: 'timers.paused', resourceType: 'timer', resourceId: total.id,
              before: {running: total.running, remainingMs: totalRemainingMs, revision: total.revision},
              after: {running: false, remainingMs: totalRemainingMs, revision: total.revision + 1,
                reason: 'SPEAKER_REMOVED'}});
          }
        }
        const active = await client.query<SpeechRow>(`SELECT * FROM speeches WHERE speaker_list_id=$1
          AND status IN ('READY','RUNNING','PAUSED') FOR UPDATE`, [listId]);
        const speech = active.rows[0];
        if (speech) {
          if (speech.yield_decision_status === 'PENDING') {
            await client.query(`INSERT INTO speech_actions
              (id,committee_id,speech_id,action,remaining_ms,target_type,target_seat_id,actor_user_id,on_behalf_of_seat_id,details)
              VALUES ($1,$2,$3,'YIELD_REJECTED',$4,'SEAT',$5,$6,$7,$8)`,
            [randomUUID(), committee.id, speech.id, remainingMs, speech.yield_target_seat_id, auth.user.id,
              speech.seat_id, {reason: 'SPEAKER_REMOVED'}]);
            await appendEvent(client, committee, {type: 'speech.yield_decision_changed', resourceType: 'speech',
              resourceId: speech.id, revision: speech.revision + 1,
              payload: {command: 'REJECTED_BY_SPEAKER_REMOVAL', targetSeatId: speech.yield_target_seat_id}});
            await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
              onBehalfOfSeatId: speech.seat_id, action: 'proceedings.speech_yield_rejected', resourceType: 'speech',
              resourceId: speech.id, after: {targetSeatId: speech.yield_target_seat_id, reason: 'SPEAKER_REMOVED'}});
          }
          await client.query(`UPDATE speeches SET status='COMPLETED',ended_at=$2,revision=revision+1,
            yield_decision_status=CASE WHEN yield_decision_status='PENDING' THEN 'REJECTED'::speech_yield_decision_status
              ELSE yield_decision_status END WHERE id=$1`, [speech.id, now]);
          await client.query(`INSERT INTO speech_actions
            (id,committee_id,speech_id,action,remaining_ms,actor_user_id,on_behalf_of_seat_id,details)
            VALUES ($1,$2,$3,'COMPLETED',$4,$5,$6,$7)`,
          [randomUUID(), committee.id, speech.id, remainingMs, auth.user.id, speech.seat_id, {reason: 'SPEAKER_REMOVED'}]);
          await appendEvent(client, committee, {type: 'speech.changed', resourceType: 'speech', resourceId: speech.id,
            revision: speech.revision + 1,
            payload: {command: 'COMPLETED_BY_SPEAKER_REMOVAL', speakerListId: listId, remainingMs}});
          await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
            onBehalfOfSeatId: speech.seat_id, action: 'proceedings.speech_completed', resourceType: 'speech',
            resourceId: speech.id, after: {speakerListId: listId, remainingMs, revision: speech.revision + 1,
              reason: 'SPEAKER_REMOVED'}});
        }
      }
      await client.query(`UPDATE speaker_queue_entries SET status='SKIPPED',completed_at=$2 WHERE id=$1`, [entryId, now]);
      await renumberActiveQueue(client, listId);
      const updated = await client.query<SpeakerListRow>(`UPDATE speaker_lists SET
        current_entry_id=CASE WHEN current_entry_id=$2 THEN NULL ELSE current_entry_id END,
        revision=revision+1 WHERE id=$1 RETURNING *`, [listId, entryId]);
      await appendEvent(client, committee, {type: 'speaker_queue.changed', resourceType: 'speaker_list', resourceId: listId,
        revision: list.revision + 1, payload: {command: 'REMOVED', entryId, seatId: entry.seat_id}, audience: 'PUBLIC'});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        onBehalfOfSeatId: entry.seat_id, action: 'proceedings.speaker_removed_from_queue', resourceType: 'speaker_list',
        resourceId: listId, before: {entryId, status: entry.status, revision: list.revision},
        after: {entryId, status: 'SKIPPED', revision: list.revision + 1}});
      return speakerListState(client, updated.rows[0] as SpeakerListRow);
    });
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
      let nextId: string | null = null; let nextSpeechDurationMs = Number(list.default_speech_ms);
      if (!closeCaucus) {
        const waiting = await client.query<{id: string; state: string | null; speech_duration_ms: string | number}>(`SELECT
          q.id,q.speech_duration_ms,a.state FROM speaker_queue_entries q
          LEFT JOIN current_attendance a ON a.seat_id=q.seat_id AND a.meeting_session_id=$2
          WHERE q.speaker_list_id=$1 AND q.status='QUEUED' ORDER BY q.position,q.created_at,q.id FOR UPDATE OF q`,
        [listId, list.meeting_session_id]);
        for (const entry of waiting.rows) {
          if (entry.state === 'PRESENT') {
            nextId = entry.id; nextSpeechDurationMs = Number(entry.speech_duration_ms); break;
          }
          await client.query(`UPDATE speaker_queue_entries SET status='SKIPPED',completed_at=$2 WHERE id=$1`, [entry.id, now]);
        }
        if (nextId) await client.query(`UPDATE speaker_queue_entries SET status='CURRENT' WHERE id=$1`, [nextId]);
        await renumberActiveQueue(client, listId);
      }
      if (closeCaucus) {
        await client.query(`UPDATE speaker_lists SET status='CLOSED',current_entry_id=NULL,closed_at=$2,
          revision=revision+1 WHERE id=$1`, [listId, now]);
        await client.query(`UPDATE caucuses SET status='CLOSED',closed_at=$2,revision=revision+1 WHERE speaker_list_id=$1`, [listId, now]);
      } else {
        await client.query(`UPDATE speaker_lists SET current_entry_id=$2,revision=revision+1 WHERE id=$1`, [listId, nextId]);
        await client.query(`UPDATE timer_states SET running=false,started_at=NULL,remaining_at_start_ms=$2,
          expired_at=NULL,revision=revision+1,updated_at=$3 WHERE id=$1`, [list.speech_timer_id, nextSpeechDurationMs, now]);
        await appendEvent(client, committee, {type: 'timer.changed', resourceType: 'timer', resourceId: list.speech_timer_id,
          revision: (speechTimer.rows[0]?.revision ?? 0) + 1,
          payload: {command: 'RESET_FOR_NEXT_SPEAKER', running: false, remainingMs: nextSpeechDurationMs}});
        await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
          action: 'timers.reset', resourceType: 'timer', resourceId: list.speech_timer_id,
          before: {revision: speechTimer.rows[0]?.revision, remainingMs: speechTimer.rows[0]
            ? remainingTimerMs(speechTimer.rows[0], now) : null},
          after: {revision: (speechTimer.rows[0]?.revision ?? 0) + 1, remainingMs: nextSpeechDurationMs}});
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
      const totalTimerResult = list.total_timer_id
        ? await client.query<TimerRow>('SELECT * FROM timer_states WHERE id=$1 FOR UPDATE', [list.total_timer_id])
        : undefined;
      const totalTimer = totalTimerResult?.rows[0];
      const totalRemaining = totalTimer ? remainingTimerMs(totalTimer, now) : null;
      const activeResult = await client.query<SpeechRow>(`SELECT * FROM speeches WHERE speaker_list_id=$1
        AND status IN ('READY','RUNNING','PAUSED') FOR UPDATE`, [listId]);
      let speech = activeResult.rows[0];
      if (command === 'start') {
        if (speech) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'A speech is already active.'});
        if (list.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT',
          message: 'This speaker list changed since it was loaded.', details: {currentRevision: list.revision}});
        if (timer.running || remaining <= 0 || (totalTimer && (totalTimer.running || (totalRemaining ?? 0) <= 0))) {
          throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The speech timers cannot start.'});
        }
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
        if (command === 'resume' && (!['READY', 'PAUSED'].includes(speech.status) || timer.running || remaining <= 0
          || (totalTimer && (totalTimer.running || (totalRemaining ?? 0) <= 0)))) {
          throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The speech cannot resume.'});
        }
        if (command === 'complete' && speech.status === 'COMPLETED') {
          throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The speech is already complete.'});
        }
        const nextStatus = command === 'pause' ? 'PAUSED' : command === 'resume' ? 'RUNNING' : 'COMPLETED';
        const updated = await client.query<SpeechRow>(`UPDATE speeches SET status=$2::speech_status,revision=revision+1,
          started_at=CASE WHEN $2::speech_status='RUNNING' AND started_at IS NULL THEN $3 ELSE started_at END,
          ended_at=CASE WHEN $2::speech_status='COMPLETED' THEN $3 ELSE ended_at END WHERE id=$1 RETURNING *`,
        [speech.id, nextStatus, now]);
        speech = updated.rows[0] as SpeechRow;
      }
      const nextRunning = command === 'start' || command === 'resume';
      const nextRemaining = command === 'pause' || command === 'complete' ? remaining : Number(timer.remaining_at_start_ms);
      await client.query(`UPDATE timer_states SET running=$2,started_at=$3,remaining_at_start_ms=$4,
        revision=revision+1,updated_at=$5 WHERE id=$1`, [timer.id, nextRunning, nextRunning ? now : null, nextRemaining, now]);
      if (totalTimer && totalRemaining !== null) await client.query(`UPDATE timer_states SET running=$2,started_at=$3,
        remaining_at_start_ms=$4,revision=revision+1,updated_at=$5 WHERE id=$1`,
      [totalTimer.id, nextRunning, nextRunning ? now : null, totalRemaining, now]);
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
      if (totalTimer && totalRemaining !== null) await appendEvent(client, committee, {type: 'timer.changed',
        resourceType: 'timer', resourceId: totalTimer.id, revision: totalTimer.revision + 1,
        payload: {command: `CAUCUS_${action}`, running: nextRunning, remainingMs: totalRemaining}});
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
      if (totalTimer && totalRemaining !== null) await audit(client, context, {committeeId: committee.id,
        actorUserId: auth.user.id, capabilities: ['CHAIR'], action: nextRunning
          ? (command === 'resume' ? 'timers.resumed' : 'timers.started') : 'timers.paused',
        resourceType: 'timer', resourceId: totalTimer.id,
        before: {running: totalTimer.running, remainingMs: totalRemaining, revision: totalTimer.revision},
        after: {running: nextRunning, remainingMs: totalRemaining, revision: totalTimer.revision + 1,
          pairedSpeechTimerId: timer.id}});
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
      if (type !== 'CHAIR') {
        targetSeatId = uuid(input.targetSeatId, 'Yield target seat ID');
        const target = await client.query<{display_name: string}>(`SELECT s.display_name FROM committee_seats s
          JOIN current_attendance a ON a.seat_id=s.id AND a.meeting_session_id=$3 AND a.state='PRESENT'
          WHERE s.id=$1 AND s.committee_id=$2 AND s.active=true`, [targetSeatId, committee.id, list.meeting_session_id]);
        if (!target.rows[0]) throw new AppError({code: 'VALIDATION_FAILED', message: 'Yield target seat is not present.'});
        if (targetSeatId === speech.seat_id) throw new AppError({code: 'VALIDATION_FAILED',
          message: 'A speaker cannot yield to the same seat.'});
        targetName = target.rows[0].display_name;
      } else if (input.targetSeatId !== undefined) {
        throw new AppError({code: 'VALIDATION_FAILED', message: 'This yield type does not accept a target seat.'});
      }
      if (type === 'SEAT') {
        const offered = await client.query<SpeechRow>(`UPDATE speeches SET yield_type='SEAT',yield_target_seat_id=$2,
          yield_decision_status='PENDING',revision=revision+1 WHERE id=$1 RETURNING *`, [speechId, targetSeatId]);
        await client.query(`INSERT INTO speech_actions
          (id,committee_id,speech_id,action,remaining_ms,target_type,target_seat_id,actor_user_id,on_behalf_of_seat_id)
          VALUES ($1,$2,$3,'YIELD_OFFERED',$4,'SEAT',$5,$6,$7)`, [randomUUID(), committee.id, speechId, remaining,
          targetSeatId, auth.user.id, speech.seat_id]);
        await appendEvent(client, committee, {type: 'speech.yield_decision_changed', resourceType: 'speech',
          resourceId: speechId, revision: speech.revision + 1, payload: {speakerListId: list.id, command: 'OFFERED',
            targetSeatId, remainingMs: remaining}});
        await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
          onBehalfOfSeatId: speech.seat_id, action: 'proceedings.speech_yield_offered', resourceType: 'speech',
          resourceId: speechId, before: {status: speech.status, revision: speech.revision},
          after: {targetSeatId, remainingMs: remaining, revision: speech.revision + 1}});
        return speechState(client, offered.rows[0] as SpeechRow);
      }
      await client.query(`UPDATE speeches SET status='COMPLETED',yield_type=$2,yield_target_seat_id=NULL,
        interaction_target_seat_id=$3,ended_at=$4,revision=revision+1 WHERE id=$1`,
      [speechId, type, targetSeatId, now]);
      await client.query(`INSERT INTO speech_actions
        (id,committee_id,speech_id,action,remaining_ms,target_type,target_seat_id,actor_user_id,on_behalf_of_seat_id,details)
        VALUES ($1,$2,$3,'YIELDED',$4,$5,NULL,$6,$7,$8)`, [randomUUID(), committee.id, speechId, remaining, type,
        auth.user.id, speech.seat_id, targetSeatId ? {interactionTargetSeatId: targetSeatId} : {}]);
      if (type === 'CHAIR') {
        await client.query(`UPDATE speaker_queue_entries SET status='COMPLETED',completed_at=$2
          WHERE id=$1 AND status='CURRENT'`, [list.current_entry_id, now]);
        const waiting = await client.query<{id: string; state: string | null; speech_duration_ms: string | number}>(`SELECT
          q.id,q.speech_duration_ms,a.state FROM speaker_queue_entries q
          LEFT JOIN current_attendance a ON a.seat_id=q.seat_id AND a.meeting_session_id=$2
          WHERE q.speaker_list_id=$1 AND q.status='QUEUED' ORDER BY q.position,q.created_at,q.id FOR UPDATE OF q`,
        [list.id, list.meeting_session_id]);
        let nextId: string | null = null; let nextDuration = Number(list.default_speech_ms);
        for (const entry of waiting.rows) {
          if (entry.state === 'PRESENT') { nextId = entry.id; nextDuration = Number(entry.speech_duration_ms); break; }
          await client.query(`UPDATE speaker_queue_entries SET status='SKIPPED',completed_at=$2 WHERE id=$1`, [entry.id, now]);
        }
        if (nextId) await client.query(`UPDATE speaker_queue_entries SET status='CURRENT' WHERE id=$1`, [nextId]);
        await renumberActiveQueue(client, list.id);
        await client.query(`UPDATE speaker_lists SET current_entry_id=$2,revision=revision+1 WHERE id=$1`, [list.id, nextId]);
        await client.query(`UPDATE timer_states SET running=false,started_at=NULL,remaining_at_start_ms=$2,
          expired_at=NULL,revision=revision+1,updated_at=$3 WHERE id=$1`, [list.speech_timer_id, nextDuration, now]);
        await appendEvent(client, committee, {type: 'speaker_queue.changed', resourceType: 'speaker_list', resourceId: list.id,
          revision: list.revision + 1, payload: {command: 'ADVANCED_AFTER_CHAIR_YIELD', currentEntryId: nextId},
          audience: 'PUBLIC'});
        await appendEvent(client, committee, {type: 'timer.changed', resourceType: 'timer', resourceId: list.speech_timer_id,
          revision: timer.revision + 1, payload: {command: 'RESET_AFTER_CHAIR_YIELD', running: false,
            remainingMs: nextDuration}});
        await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
          action: 'proceedings.speaker_advanced', resourceType: 'speaker_list', resourceId: list.id,
          before: {currentEntryId: list.current_entry_id, revision: list.revision},
          after: {currentEntryId: nextId, revision: list.revision + 1, reason: 'YIELDED_TO_CHAIR'}});
        await appendEvent(client, committee, {type: 'speech.yielded', resourceType: 'speech', resourceId: speechId,
          revision: speech.revision + 1, payload: {speakerListId: list.id, type, targetSeatId: null,
            inheritedTimeMs: remaining}});
        await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
          onBehalfOfSeatId: speech.seat_id, action: 'proceedings.speech_yielded', resourceType: 'speech', resourceId: speechId,
          before: {status: speech.status, revision: speech.revision},
          after: {type, targetSeatId: null, inheritedSpeechId: null, inheritedTimeMs: remaining,
            revision: speech.revision + 1}});
        const completed = await client.query<SpeechRow>('SELECT * FROM speeches WHERE id=$1', [speechId]);
        return speechState(client, completed.rows[0] as SpeechRow);
      }
      const inheritedId = randomUUID(); const inheritedSeatId = type === 'COMMENTS' ? targetSeatId as string : speech.seat_id;
      const inheritedName = type === 'COMMENTS' ? targetName : speech.seat_display_name;
      const inherited = await client.query<SpeechRow>(`INSERT INTO speeches
        (id,committee_id,speaker_list_id,queue_entry_id,seat_id,seat_display_name,kind,status,inherited_from_speech_id,
         inherited_time_ms,can_yield,yield_type,yield_target_seat_id,interaction_target_seat_id,
         actor_user_id,on_behalf_of_seat_id)
        VALUES ($1,$2,$3,$4,$5,$6,'INHERITED','READY',$7,$8,false,$9,NULL,$10,$11,$5) RETURNING *`,
      [inheritedId, committee.id, list.id, speech.queue_entry_id, inheritedSeatId, inheritedName, speechId, remaining,
        type, targetSeatId, auth.user.id]);
      if (type === 'COMMENTS') {
        await client.query(`UPDATE speaker_queue_entries SET status='SKIPPED',completed_at=$3
          WHERE speaker_list_id=$1 AND seat_id=$2 AND status='QUEUED'`, [list.id, targetSeatId, now]);
        await renumberActiveQueue(client, list.id);
      }
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

  async decideSpeechYield(auth: AuthenticatedSession, speechId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<SpeakerList> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision', 'decision']);
    const baseRevision = positiveInteger(input.baseRevision, 'Base revision');
    const decision = input.decision as 'ACCEPT' | 'REJECT';
    if (!['ACCEPT', 'REJECT'].includes(decision)) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Yield decision is invalid.'});
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
      if (speech.status !== 'PAUSED' || speech.yield_type !== 'SEAT' || speech.yield_decision_status !== 'PENDING'
        || !speech.yield_target_seat_id) {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'There is no pending delegate yield to decide.'});
      }
      const timerResult = await client.query<TimerRow>('SELECT * FROM timer_states WHERE id=$1 FOR UPDATE', [list.speech_timer_id]);
      const timer = timerResult.rows[0] as TimerRow; const now = this.now(); const remaining = remainingTimerMs(timer, now);
      const status = decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED';
      await client.query(`UPDATE speeches SET status='COMPLETED',yield_decision_status=$2,ended_at=$3,
        revision=revision+1 WHERE id=$1`, [speechId, status, now]);
      await client.query(`INSERT INTO speech_actions
        (id,committee_id,speech_id,action,remaining_ms,target_type,target_seat_id,actor_user_id,on_behalf_of_seat_id)
        VALUES ($1,$2,$3,$4,$5,'SEAT',$6,$7,$8)`, [randomUUID(), committee.id, speechId,
        decision === 'ACCEPT' ? 'YIELD_ACCEPTED' : 'YIELD_REJECTED', remaining, speech.yield_target_seat_id,
        auth.user.id, speech.seat_id]);
      let inheritedId: string | null = null;
      if (decision === 'ACCEPT') {
        const target = await client.query<{display_name: string}>(`SELECT s.display_name FROM committee_seats s
          JOIN current_attendance a ON a.seat_id=s.id AND a.meeting_session_id=$3 AND a.state='PRESENT'
          WHERE s.id=$1 AND s.committee_id=$2 AND s.active=true`,
        [speech.yield_target_seat_id, committee.id, list.meeting_session_id]);
        if (!target.rows[0]) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The target seat is no longer present.'});
        inheritedId = randomUUID();
        await client.query(`INSERT INTO speeches
          (id,committee_id,speaker_list_id,queue_entry_id,seat_id,seat_display_name,kind,status,inherited_from_speech_id,
           inherited_time_ms,can_yield,yield_type,yield_target_seat_id,actor_user_id,on_behalf_of_seat_id)
          VALUES ($1,$2,$3,$4,$5,$6,'INHERITED','READY',$7,$8,false,'SEAT',$5,$9,$5)`,
        [inheritedId, committee.id, list.id, speech.queue_entry_id, speech.yield_target_seat_id,
          target.rows[0].display_name, speechId, remaining, auth.user.id]);
        await client.query(`UPDATE speaker_queue_entries SET status='SKIPPED',completed_at=$3
          WHERE speaker_list_id=$1 AND seat_id=$2 AND status='QUEUED'`, [list.id, speech.yield_target_seat_id, now]);
        await renumberActiveQueue(client, list.id);
      } else {
        await client.query(`UPDATE speaker_queue_entries SET status='COMPLETED',completed_at=$2
          WHERE id=$1 AND status='CURRENT'`, [list.current_entry_id, now]);
        const waiting = await client.query<{id: string; state: string | null; speech_duration_ms: string | number}>(`SELECT
          q.id,q.speech_duration_ms,a.state FROM speaker_queue_entries q
          LEFT JOIN current_attendance a ON a.seat_id=q.seat_id AND a.meeting_session_id=$2
          WHERE q.speaker_list_id=$1 AND q.status='QUEUED' ORDER BY q.position,q.created_at,q.id FOR UPDATE OF q`,
        [list.id, list.meeting_session_id]);
        let nextId: string | null = null; let nextDuration = Number(list.default_speech_ms);
        for (const entry of waiting.rows) {
          if (entry.state === 'PRESENT') { nextId = entry.id; nextDuration = Number(entry.speech_duration_ms); break; }
          await client.query(`UPDATE speaker_queue_entries SET status='SKIPPED',completed_at=$2 WHERE id=$1`, [entry.id, now]);
        }
        if (nextId) await client.query(`UPDATE speaker_queue_entries SET status='CURRENT' WHERE id=$1`, [nextId]);
        await renumberActiveQueue(client, list.id);
        await client.query(`UPDATE speaker_lists SET current_entry_id=$2,revision=revision+1 WHERE id=$1`, [list.id, nextId]);
        await client.query(`UPDATE timer_states SET running=false,started_at=NULL,remaining_at_start_ms=$2,
          expired_at=NULL,revision=revision+1,updated_at=$3 WHERE id=$1`, [timer.id, nextDuration, now]);
      }
      await appendEvent(client, committee, {type: 'speech.yield_decision_changed', resourceType: 'speech', resourceId: speechId,
        revision: speech.revision + 1, payload: {speakerListId: list.id, command: status, targetSeatId: speech.yield_target_seat_id,
          inheritedSpeechId: inheritedId, remainingMs: remaining}});
      if (decision === 'REJECT') await appendEvent(client, committee, {type: 'speaker_queue.changed',
        resourceType: 'speaker_list', resourceId: list.id, revision: list.revision + 1,
        payload: {command: 'ADVANCED_AFTER_REJECTED_YIELD'}, audience: 'PUBLIC'});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        onBehalfOfSeatId: speech.seat_id, action: decision === 'ACCEPT'
          ? 'proceedings.speech_yield_accepted' : 'proceedings.speech_yield_rejected',
        resourceType: 'speech', resourceId: speechId, before: {status: speech.status, revision: speech.revision},
        after: {targetSeatId: speech.yield_target_seat_id, inheritedSpeechId: inheritedId, remainingMs: remaining,
          revision: speech.revision + 1}});
      const updated = await client.query<SpeakerListRow>('SELECT * FROM speaker_lists WHERE id=$1', [list.id]);
      return speakerListState(client, updated.rows[0] as SpeakerListRow);
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
    assertExactBody(input, ['meetingSessionId', 'motionTypeId', 'parameters', 'onBehalfOfSeatId', 'secondedBySeatId']);
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
        let secondedBySeatId: string | undefined; let secondedBySeatName: string | undefined;
        if (input.secondedBySeatId !== undefined) {
          if (!chair) throw new AppError({code: 'FORBIDDEN', message: 'Only a Chair can record an initial seconder.'});
          if (Number(requiredSecondCount) < 1) throw new AppError({code: 'VALIDATION_FAILED',
            message: 'This motion does not require a seconder.'});
          secondedBySeatId = uuid(input.secondedBySeatId, 'Seconding seat ID');
          if (secondedBySeatId === seatId) throw new AppError({code: 'VALIDATION_FAILED',
            message: 'The proposer and seconder must be different seats.'});
          const secondingSeat = await client.query<{display_name: string}>(`SELECT s.display_name FROM committee_seats s
            JOIN current_attendance a ON a.seat_id=s.id AND a.meeting_session_id=$3 AND a.state='PRESENT'
            WHERE s.id=$1 AND s.committee_id=$2 AND s.active=true`, [secondedBySeatId, committeeId, meetingSessionId]);
          if (!secondingSeat.rows[0]) throw new AppError({code: 'VALIDATION_FAILED',
            message: 'Only a present active seat may second a motion.'});
          secondedBySeatName = secondingSeat.rows[0].display_name;
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
        const id = randomUUID(); const initialSecondCount = secondedBySeatId ? 1 : 0;
        const initialStatus = initialSecondCount >= Number(requiredSecondCount) ? 'SECONDED' : 'PENDING';
        const includeNonVotingSeats = definition.procedural === true;
        const inserted = await client.query<MotionRow>(`INSERT INTO motions
          (id,committee_id,meeting_session_id,motion_type_id,proposed_by_seat_id,proposed_by_seat_display_name,
           actor_user_id,on_behalf_of_seat_id,parameters,status,rule_package_version_id,rule_evaluation,required_second_count,
           direct_vote_include_non_voting)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$5,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [id, committeeId, meetingSessionId, motionTypeId, seatId, seat.rows[0].display_name, auth.user.id,
          parameters, initialStatus, session.rows[0].active_rule_package_version_id, evaluation, requiredSecondCount,
          includeNonVotingSeats]);
        await appendEvent(client, committee, {type: 'motion.proposed', resourceType: 'motion', resourceId: id,
          revision: 1, payload: {motionTypeId, proposedBySeatId: seatId, status: initialStatus,
            rulePackageVersionId: session.rows[0].active_rule_package_version_id}, audience: 'PUBLIC'});
        await audit(client, context, {committeeId, actorUserId: auth.user.id,
          capabilities: chair ? ['CHAIR'] : ['MEMBER'], onBehalfOfSeatId: seatId,
          action: 'proceedings.motion_proposed', resourceType: 'motion', resourceId: id,
          after: {motionTypeId, seatId, status: initialStatus, rulePackageVersionId: evaluation.packageVersionId,
            requiredSecondCount, includeNonVotingSeats, revision: 1}});
        if (secondedBySeatId && secondedBySeatName) {
          const secondId = randomUUID();
          await client.query(`INSERT INTO motion_seconds
            (id,committee_id,motion_id,seat_id,seat_display_name,actor_user_id,on_behalf_of_seat_id)
            VALUES ($1,$2,$3,$4,$5,$6,$4)`, [secondId, committeeId, id, secondedBySeatId, secondedBySeatName, auth.user.id]);
          await appendEvent(client, committee, {type: 'motion.seconded', resourceType: 'motion', resourceId: id,
            revision: 1, payload: {secondId, seatId: secondedBySeatId, status: initialStatus, initial: true}, audience: 'PUBLIC'});
          await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['CHAIR'],
            onBehalfOfSeatId: secondedBySeatId, action: 'proceedings.motion_seconded', resourceType: 'motion', resourceId: id,
            after: {secondId, seatId: secondedBySeatId, status: initialStatus, revision: 1, initial: true}});
        }
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

  private async enactMotion(client: PoolClient, committee: Stage4CommitteeRow, motion: MotionRow,
    actorUserId: string, now: Date, context: Stage4Context): Promise<string | null> {
    const parameters = motion.parameters; const committeeId = committee.id;
    if (motion.motion_type_id === 'suspend-meeting') {
      const sessionResult = await client.query<MeetingSessionRow>(`SELECT * FROM meeting_sessions
        WHERE id=$1 AND committee_id=$2 FOR UPDATE`, [motion.meeting_session_id, committeeId]);
      const session = sessionResult.rows[0];
      if (!session || session.status !== 'OPEN') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The meeting session is not open.'});
      const activeRollCall = await client.query(`SELECT 1 FROM roll_calls
        WHERE meeting_session_id=$1 AND status='IN_PROGRESS'`, [session.id]);
      if (activeRollCall.rowCount) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Complete or reset the active roll call first.'});
      const pending = await client.query<MeetingSessionRow>(`SELECT * FROM meeting_sessions
        WHERE committee_id=$1 AND status='PENDING' FOR UPDATE`, [committeeId]);
      if ((pending.rowCount ?? 0) > 0) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'A meeting session is already pending.'});
      const closed = await client.query<MeetingSessionRow>(`UPDATE meeting_sessions SET status='CLOSED',revision=revision+1,
        closed_at=$2 WHERE id=$1 RETURNING *`, [session.id, now]);
      const nextId = randomUUID();
      const next = await client.query<MeetingSessionRow>(`INSERT INTO meeting_sessions
        (id,committee_id,name,phase_id,active_rule_package_version_id,status,created_by_user_id)
        SELECT $1,$2,'第' || (count(*) + 1)::text || '会期',$3,$4,'PENDING',$5
        FROM meeting_sessions WHERE committee_id=$2 RETURNING *`,
      [nextId, committeeId, session.phase_id, session.active_rule_package_version_id, actorUserId]);
      const nextSession = next.rows[0] as MeetingSessionRow;
      await appendEvent(client, committee, {type: 'meeting_session.closed', resourceType: 'meeting_session',
        resourceId: session.id, revision: closed.rows[0]!.revision, payload: {phaseId: session.phase_id, motionId: motion.id}});
      await appendEvent(client, committee, {type: 'meeting_session.created', resourceType: 'meeting_session',
        resourceId: nextSession.id, revision: nextSession.revision,
        payload: {name: nextSession.name, phaseId: nextSession.phase_id, rulePackageVersionId: nextSession.active_rule_package_version_id,
          status: 'PENDING', motionId: motion.id}});
      await audit(client, context, {committeeId, actorUserId, capabilities: ['CHAIR'],
        action: 'proceedings.meeting_session_closed', resourceType: 'meeting_session', resourceId: session.id,
        before: {status: session.status, revision: session.revision},
        after: {status: 'CLOSED', revision: closed.rows[0]!.revision, motionId: motion.id}});
      await audit(client, context, {committeeId, actorUserId, capabilities: ['CHAIR'],
        action: 'proceedings.meeting_session_created', resourceType: 'meeting_session', resourceId: nextSession.id,
        after: {name: nextSession.name, status: 'PENDING', phaseId: nextSession.phase_id,
          rulePackageVersionId: nextSession.active_rule_package_version_id, motionId: motion.id}});
      return null;
    }
    if (motion.motion_type_id === 'open-unmoderated-caucus'
      || motion.motion_type_id === 'introduce-working-paper') {
      const durationMs = motionDurationMs(parameters);
      const current = await client.query<TimerRow>(`SELECT * FROM timer_states
        WHERE committee_id=$1 AND owner_type='COMMITTEE' AND owner_id=$1 FOR UPDATE`, [committeeId]);
      let timerId: string; let revision: number; let before: Record<string, unknown> | undefined;
      if (current.rows[0]) {
        const timer = current.rows[0]; timerId = timer.id; revision = timer.revision + 1;
        before = {running: timer.running, remainingMs: remainingTimerMs(timer, now), revision: timer.revision};
        await client.query(`UPDATE timer_states SET running=false,started_at=NULL,remaining_at_start_ms=$2,
          expired_at=NULL,revision=revision+1,updated_at=$3 WHERE id=$1`, [timerId, durationMs, now]);
      } else {
        timerId = randomUUID(); revision = 1;
        await client.query(`INSERT INTO timer_states
          (id,committee_id,owner_type,owner_id,remaining_at_start_ms,created_by_user_id,created_at,updated_at)
          VALUES ($1,$2,'COMMITTEE',$2,$3,$4,$5,$5)`, [timerId, committeeId, durationMs, actorUserId, now]);
      }
      await appendEvent(client, committee, {type: 'timer.changed', resourceType: 'timer', resourceId: timerId,
        revision, payload: {command: current.rows[0] ? 'RESET_BY_MOTION' : 'CREATED_BY_MOTION', running: false, remainingMs: durationMs}});
      await audit(client, context, {committeeId, actorUserId, capabilities: ['CHAIR'], action: current.rows[0]
        ? 'timers.reset' : 'timers.created', resourceType: 'timer', resourceId: timerId, before,
        after: {running: false, remainingMs: durationMs, revision, motionId: motion.id}});
      return `/committees/${committeeId}/unmod`;
    }

    if (motion.motion_type_id === 'extend-unmoderated-caucus') {
      const durationMs = motionDurationMs(parameters);
      const found = await client.query<TimerRow>(`SELECT * FROM timer_states
        WHERE committee_id=$1 AND owner_type='COMMITTEE' AND owner_id=$1 FOR UPDATE`, [committeeId]);
      const timer = found.rows[0];
      if (!timer) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'There is no unmoderated caucus timer to extend.'});
      const remaining = remainingTimerMs(timer, now); const nextRemaining = remaining + durationMs;
      await client.query(`UPDATE timer_states SET started_at=$2,remaining_at_start_ms=$3,expired_at=NULL,
        revision=revision+1,updated_at=$4 WHERE id=$1`, [timer.id, timer.running ? now : null, nextRemaining, now]);
      await appendEvent(client, committee, {type: 'timer.changed', resourceType: 'timer', resourceId: timer.id,
        revision: timer.revision + 1, payload: {command: 'EXTENDED_BY_MOTION', running: timer.running, remainingMs: nextRemaining}});
      await audit(client, context, {committeeId, actorUserId, capabilities: ['CHAIR'], action: 'timers.extended',
        resourceType: 'timer', resourceId: timer.id, before: {remainingMs: remaining, revision: timer.revision},
        after: {remainingMs: nextRemaining, revision: timer.revision + 1, motionId: motion.id}});
      return `/committees/${committeeId}/unmod`;
    }

    if (motion.motion_type_id === 'open-moderated-caucus') {
      const topic = motionText(parameters, 'proposal', 'Caucus topic', 500);
      const totalDurationMs = motionDurationMs(parameters);
      const defaultSpeechMs = motionDurationMs(parameters, 'speakerDuration', 'speakerUnit');
      if (committee.operation_mode !== 'CHAIR_OPERATED'
        && (totalDurationMs < defaultSpeechMs || totalDurationMs % defaultSpeechMs !== 0)) {
        throw new AppError({code: 'VALIDATION_FAILED', message: 'Speaker time must evenly divide the caucus time.'});
      }
      let linkedResolution: {id: string; title: string; proposerSeatId: string; proposerSeatName: string;
        seconderSeatId: string; seconderSeatName: string} | null = null;
      if (parameters.resolutionTarget !== undefined) {
        const resolutionId = motionId(parameters, 'resolutionTarget', 'Target resolution ID');
        const target = await client.query<{id: string; title: string; proposer_seat_id: string | null;
          proposer_seat_name: string | null; seconder_seat_id: string | null; seconder_seat_name: string | null}>(`SELECT
          d.id,d.title,r.proposer_seat_id,p.display_name AS proposer_seat_name,
          r.seconder_seat_id,s.display_name AS seconder_seat_name
          FROM documents d JOIN resolutions r ON r.document_id=d.id
          LEFT JOIN committee_seats p ON p.id=r.proposer_seat_id
          LEFT JOIN committee_seats s ON s.id=r.seconder_seat_id
          WHERE d.id=$1 AND d.committee_id=$2 AND d.meeting_session_id=$3 AND d.deleted_at IS NULL FOR UPDATE OF d,r`,
        [resolutionId, committeeId, motion.meeting_session_id]);
        const row = target.rows[0];
        if (!row) throw new AppError({code: 'NOT_FOUND', message: 'Target resolution not found.'});
        if (!row.proposer_seat_id || !row.proposer_seat_name || !row.seconder_seat_id || !row.seconder_seat_name) {
          throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The target resolution has not been introduced.'});
        }
        const existing = await client.query('SELECT id FROM speaker_lists WHERE linked_resolution_document_id=$1',
          [resolutionId]);
        if (existing.rows[0]) {
          throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The target resolution already has an associated caucus.'});
        }
        linkedResolution = {id: row.id, title: row.title, proposerSeatId: row.proposer_seat_id,
          proposerSeatName: row.proposer_seat_name, seconderSeatId: row.seconder_seat_id,
          seconderSeatName: row.seconder_seat_name};
      }
      const listId = randomUUID(); const caucusId = randomUUID(); const speechTimerId = randomUUID();
      const totalTimerId = randomUUID(); const entryId = randomUUID(); const queuedEntryId = randomUUID();
      await client.query(`INSERT INTO timer_states
        (id,committee_id,owner_type,owner_id,remaining_at_start_ms,created_by_user_id,created_at,updated_at)
        VALUES ($1,$2,'SPEAKER_LIST',$3,$4,$5,$6,$6),
               ($7,$2,'CAUCUS',$8,$9,$5,$6,$6)`,
      [speechTimerId, committeeId, listId, defaultSpeechMs, actorUserId, now, totalTimerId, caucusId, totalDurationMs]);
      await client.query(`INSERT INTO speaker_lists
        (id,committee_id,meeting_session_id,kind,name,topic,default_speech_ms,delegates_can_queue,
         rule_package_version_id,speech_timer_id,total_timer_id,linked_resolution_document_id,created_by_user_id,created_at)
        VALUES ($1,$2,$3,'MODERATED_CAUCUS',$4,$5,$6,false,$7,$8,$9,$10,$11,$12)`,
      [listId, committeeId, motion.meeting_session_id, linkedResolution?.title ?? topic, topic, defaultSpeechMs,
        motion.rule_package_version_id, speechTimerId, totalTimerId, linkedResolution?.id ?? null, actorUserId, now]);
      await client.query(`INSERT INTO caucuses
        (id,committee_id,meeting_session_id,speaker_list_id,topic,total_timer_id,speech_timer_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [caucusId, committeeId, motion.meeting_session_id, listId, topic, totalTimerId, speechTimerId, now]);
      const initialSeatId = linkedResolution?.proposerSeatId ?? motion.proposed_by_seat_id;
      const initialSeatName = linkedResolution?.proposerSeatName ?? motion.proposed_by_seat_display_name;
      await client.query(`INSERT INTO speaker_queue_entries
        (id,committee_id,speaker_list_id,seat_id,seat_display_name,position,status,stance,speech_duration_ms,
         actor_user_id,on_behalf_of_seat_id,created_at)
        VALUES ($1,$2,$3,$4,$5,1,'CURRENT','FOR',$6,$7,$4,$8)`,
      [entryId, committeeId, listId, initialSeatId, initialSeatName, defaultSpeechMs, actorUserId, now]);
      if (linkedResolution) await client.query(`INSERT INTO speaker_queue_entries
        (id,committee_id,speaker_list_id,seat_id,seat_display_name,position,status,stance,speech_duration_ms,
         actor_user_id,on_behalf_of_seat_id,created_at)
        VALUES ($1,$2,$3,$4,$5,2,'QUEUED','FOR',$6,$7,$4,$8)`,
      [queuedEntryId, committeeId, listId, linkedResolution.seconderSeatId, linkedResolution.seconderSeatName,
        defaultSpeechMs, actorUserId, now]);
      await client.query('UPDATE speaker_lists SET current_entry_id=$2 WHERE id=$1', [listId, entryId]);
      await appendEvent(client, committee, {type: 'speaker_list.created', resourceType: 'speaker_list', resourceId: listId,
        revision: 1, payload: {kind: 'MODERATED_CAUCUS', topic, defaultSpeechMs, totalDurationMs,
          currentEntryId: entryId, linkedResolutionId: linkedResolution?.id ?? null, motionId: motion.id}, audience: 'PUBLIC'});
      await audit(client, context, {committeeId, actorUserId, capabilities: ['CHAIR'],
        onBehalfOfSeatId: motion.proposed_by_seat_id, action: 'proceedings.speaker_list_created',
        resourceType: 'speaker_list', resourceId: listId,
        after: {kind: 'MODERATED_CAUCUS', topic, defaultSpeechMs, totalDurationMs,
          initialSpeakerSeatId: initialSeatId, queuedSeconderSeatId: linkedResolution?.seconderSeatId ?? null,
          linkedResolutionId: linkedResolution?.id ?? null, motionId: motion.id, revision: 1}});
      return `/committees/${committeeId}/caucuses/${listId}`;
    }

    if (motion.motion_type_id === 'close-moderated-caucus') {
      const listId = motionId(parameters, 'caucusTarget', 'Target caucus ID');
      const found = await client.query<SpeakerListRow>(`SELECT * FROM speaker_lists
        WHERE id=$1 AND committee_id=$2 AND kind='MODERATED_CAUCUS' FOR UPDATE`, [listId, committeeId]);
      const list = found.rows[0];
      if (!list || list.status !== 'OPEN') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The target caucus is not open.'});
      const active = await client.query<SpeechRow>(`SELECT * FROM speeches WHERE speaker_list_id=$1
        AND status IN ('READY','RUNNING','PAUSED') FOR UPDATE`, [listId]);
      const activeSpeech = active.rows[0];
      await client.query(`UPDATE speaker_lists SET status='CLOSED',closed_at=$2,
        revision=revision+1 WHERE id=$1`, [listId, now]);
      await client.query(`UPDATE caucuses SET status='CLOSED',closed_at=$2,revision=revision+1
        WHERE speaker_list_id=$1`, [listId, now]);
      for (const timerId of [list.speech_timer_id, list.total_timer_id].filter(Boolean) as string[]) {
        const timerResult = await client.query<TimerRow>('SELECT * FROM timer_states WHERE id=$1 FOR UPDATE', [timerId]);
        const timer = timerResult.rows[0]; if (!timer) continue;
        const remainingMs = remainingTimerMs(timer, now);
        await client.query(`UPDATE timer_states SET running=false,started_at=NULL,remaining_at_start_ms=$2,
          revision=revision+1,updated_at=$3 WHERE id=$1`, [timer.id, remainingMs, now]);
        await appendEvent(client, committee, {type: 'timer.changed', resourceType: 'timer', resourceId: timer.id,
          revision: timer.revision + 1,
          payload: {command: 'PAUSED_BY_CAUCUS_CLOSE_MOTION', running: false, remainingMs, motionId: motion.id}});
        await audit(client, context, {committeeId, actorUserId, capabilities: ['CHAIR'], action: 'timers.paused',
          resourceType: 'timer', resourceId: timer.id,
          before: {running: timer.running, remainingMs, revision: timer.revision},
          after: {running: false, remainingMs, revision: timer.revision + 1, motionId: motion.id}});
      }
      if (activeSpeech) {
        const speechTimer = await client.query<TimerRow>('SELECT * FROM timer_states WHERE id=$1', [list.speech_timer_id]);
        const remainingMs = speechTimer.rows[0] ? Number(speechTimer.rows[0].remaining_at_start_ms) : 0;
        if (activeSpeech.yield_decision_status === 'PENDING') {
          await client.query(`INSERT INTO speech_actions
            (id,committee_id,speech_id,action,remaining_ms,target_type,target_seat_id,actor_user_id,on_behalf_of_seat_id,details)
            VALUES ($1,$2,$3,'YIELD_REJECTED',$4,'SEAT',$5,$6,$7,$8)`,
          [randomUUID(), committee.id, activeSpeech.id, remainingMs, activeSpeech.yield_target_seat_id, actorUserId,
            activeSpeech.seat_id, {reason: 'CAUCUS_CLOSED_BY_MOTION', motionId: motion.id}]);
          await appendEvent(client, committee, {type: 'speech.yield_decision_changed', resourceType: 'speech',
            resourceId: activeSpeech.id, revision: activeSpeech.revision + 1,
            payload: {command: 'REJECTED_BY_CAUCUS_CLOSE_MOTION', targetSeatId: activeSpeech.yield_target_seat_id,
              motionId: motion.id}});
          await audit(client, context, {committeeId, actorUserId, capabilities: ['CHAIR'],
            onBehalfOfSeatId: activeSpeech.seat_id, action: 'proceedings.speech_yield_rejected',
            resourceType: 'speech', resourceId: activeSpeech.id,
            after: {targetSeatId: activeSpeech.yield_target_seat_id, reason: 'CAUCUS_CLOSED_BY_MOTION', motionId: motion.id}});
        }
        await client.query(`UPDATE speeches SET status='COMPLETED',ended_at=$2,revision=revision+1,
          yield_decision_status=CASE WHEN yield_decision_status='PENDING' THEN 'REJECTED'::speech_yield_decision_status
            ELSE yield_decision_status END WHERE id=$1`, [activeSpeech.id, now]);
        await client.query(`INSERT INTO speech_actions
          (id,committee_id,speech_id,action,remaining_ms,actor_user_id,on_behalf_of_seat_id,details)
          VALUES ($1,$2,$3,'COMPLETED',$4,$5,$6,$7)`,
        [randomUUID(), committee.id, activeSpeech.id, remainingMs, actorUserId, activeSpeech.seat_id,
          {reason: 'CAUCUS_CLOSED_BY_MOTION', motionId: motion.id}]);
        await appendEvent(client, committee, {type: 'speech.changed', resourceType: 'speech',
          resourceId: activeSpeech.id, revision: activeSpeech.revision + 1,
          payload: {command: 'COMPLETED_BY_CAUCUS_CLOSE_MOTION', speakerListId: listId, remainingMs,
            motionId: motion.id}});
        await audit(client, context, {committeeId, actorUserId, capabilities: ['CHAIR'],
          onBehalfOfSeatId: activeSpeech.seat_id, action: 'proceedings.speech_completed', resourceType: 'speech',
          resourceId: activeSpeech.id,
          after: {speakerListId: listId, remainingMs, revision: activeSpeech.revision + 1,
            reason: 'CAUCUS_CLOSED_BY_MOTION', motionId: motion.id}});
      }
      await appendEvent(client, committee, {type: 'caucus.closed', resourceType: 'speaker_list', resourceId: listId,
        revision: list.revision + 1,
        payload: {command: 'CLOSED_BY_MOTION', motionId: motion.id, currentEntryId: list.current_entry_id},
        audience: 'PUBLIC'});
      await audit(client, context, {committeeId, actorUserId, capabilities: ['CHAIR'], action: 'proceedings.caucus_closed',
        resourceType: 'speaker_list', resourceId: listId, before: {status: list.status, revision: list.revision},
        after: {status: 'CLOSED', revision: list.revision + 1, motionId: motion.id}});
      return `/committees/${committeeId}/caucuses/${listId}`;
    }

    if (motion.motion_type_id === 'extend-moderated-caucus') {
      const listId = motionId(parameters, 'caucusTarget', 'Target caucus ID'); const durationMs = motionDurationMs(parameters);
      const found = await client.query<SpeakerListRow>(`SELECT * FROM speaker_lists
        WHERE id=$1 AND committee_id=$2 AND kind='MODERATED_CAUCUS' FOR UPDATE`, [listId, committeeId]);
      const list = found.rows[0];
      if (!list || list.status !== 'OPEN' || !list.total_timer_id) throw new AppError({code: 'RESOURCE_CONFLICT',
        message: 'The target caucus is not open.'});
      const timerResult = await client.query<TimerRow>('SELECT * FROM timer_states WHERE id=$1 FOR UPDATE', [list.total_timer_id]);
      const timer = timerResult.rows[0]; if (!timer) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The caucus timer is unavailable.'});
      const remaining = remainingTimerMs(timer, now); const nextRemaining = remaining + durationMs;
      await client.query(`UPDATE timer_states SET started_at=$2,remaining_at_start_ms=$3,expired_at=NULL,
        revision=revision+1,updated_at=$4 WHERE id=$1`, [timer.id, timer.running ? now : null, nextRemaining, now]);
      await appendEvent(client, committee, {type: 'timer.changed', resourceType: 'timer', resourceId: timer.id,
        revision: timer.revision + 1, payload: {command: 'EXTENDED_BY_MOTION', running: timer.running,
          remainingMs: nextRemaining, motionId: motion.id}});
      await audit(client, context, {committeeId, actorUserId, capabilities: ['CHAIR'], action: 'timers.extended',
        resourceType: 'timer', resourceId: timer.id, before: {remainingMs: remaining, revision: timer.revision},
        after: {remainingMs: nextRemaining, revision: timer.revision + 1, motionId: motion.id}});
      return `/committees/${committeeId}/caucuses/${listId}`;
    }

    if (motion.motion_type_id === 'introduce-draft-resolution') {
      const documentId = motionId(parameters, 'resolutionTarget', 'Target resolution ID');
      const found = await client.query<DocumentRow>(`SELECT d.*,NULL::uuid AS resolution_document_id FROM documents d
        WHERE d.id=$1 AND d.committee_id=$2 AND d.kind='RESOLUTION' AND d.deleted_at IS NULL FOR UPDATE`,
      [documentId, committeeId]);
      const document = found.rows[0];
      if (!document || document.meeting_session_id !== motion.meeting_session_id) {
        throw new AppError({code: 'NOT_FOUND', message: 'Target resolution not found.'});
      }
      if (document.status !== 'DRAFT') throw new AppError({code: 'RESOURCE_CONFLICT',
        message: 'Only an unintroduced draft resolution can be introduced.'});
      const contentSource = await client.query<{content_file_entry_id: string | null; file_status: string | null}>(
        `SELECT v.content_file_entry_id,e.status AS file_status FROM document_versions v
          LEFT JOIN file_entries e ON e.id=v.content_file_entry_id
          WHERE v.document_id=$1 AND v.id=$2`, [documentId, document.current_version_id]);
      const source = contentSource.rows[0];
      if (source?.content_file_entry_id && source.file_status !== 'PUBLISHED') {
        throw new AppError({code: 'RESOURCE_CONFLICT',
          message: 'Publish the resolution content file before introducing the draft.'});
      }
      const second = await client.query<{seat_id: string}>(`SELECT seat_id FROM motion_seconds
        WHERE motion_id=$1 ORDER BY created_at,id LIMIT 1`, [motion.id]);
      const seconderSeatId = second.rows[0]?.seat_id ?? null;
      const metadata = await client.query<ResolutionRow>('SELECT * FROM resolutions WHERE document_id=$1 FOR UPDATE', [documentId]);
      const resolution = metadata.rows[0] as ResolutionRow;
      const beforeSettings = {proposerSeatId: resolution.proposer_seat_id, seconderSeatId: resolution.seconder_seat_id};
      const afterSettings = {proposerSeatId: motion.proposed_by_seat_id, seconderSeatId};
      await client.query(`UPDATE resolutions SET proposer_seat_id=$2,seconder_seat_id=$3 WHERE document_id=$1`,
      [documentId, motion.proposed_by_seat_id, seconderSeatId]);
      await client.query(`INSERT INTO resolution_setting_revisions
        (id,committee_id,resolution_document_id,before_value,after_value,actor_user_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), committeeId, documentId,
        beforeSettings, afterSettings, actorUserId, now]);
      const updated = await client.query<DocumentRow>(`UPDATE documents SET status='PUBLISHED',is_public=true,
        revision=revision+1,updated_at=$2 WHERE id=$1 RETURNING *,NULL::uuid AS resolution_document_id`, [documentId, now]);
      await client.query(`INSERT INTO document_actions
        (id,committee_id,document_id,action,from_status,to_status,rule_stable_id,rule_evaluation,actor_user_id,created_at)
        VALUES ($1,$2,$3,'PUBLISH','DRAFT','PUBLISHED',$4,$5,$6,$7)`,
      [randomUUID(), committeeId, documentId, motion.motion_type_id, motion.rule_evaluation, actorUserId, now]);
      await appendEvent(client, committee, {type: 'document.status_changed', resourceType: 'document', resourceId: documentId,
        revision: document.revision + 1, payload: {kind: 'RESOLUTION', status: 'PUBLISHED',
          ruleStableId: motion.motion_type_id, motionId: motion.id}, audience: 'PUBLIC'});
      await audit(client, context, {committeeId, actorUserId, capabilities: ['CHAIR'],
        onBehalfOfSeatId: motion.proposed_by_seat_id, action: 'documents.status_changed',
        resourceType: 'document', resourceId: documentId,
        before: {status: document.status, revision: document.revision, ...beforeSettings},
        after: {status: 'PUBLISHED', revision: (updated.rows[0] as DocumentRow).revision,
          ...afterSettings, motionId: motion.id}});
      return `/committees/${committeeId}/resolutions/${documentId}`;
    }

    if (motion.motion_type_id === 'introduce-amendment') {
      motionText(parameters, 'proposal', 'Amendment text', 200_000);
      const documentId = motionId(parameters, 'amendmentTarget', 'Target amendment ID');
      const found = await client.query<DocumentRow>(`SELECT d.*,a.resolution_document_id FROM documents d
        JOIN amendments a ON a.document_id=d.id WHERE d.id=$1 AND d.committee_id=$2 AND d.kind='AMENDMENT'
        AND d.deleted_at IS NULL FOR UPDATE OF d`, [documentId, committeeId]);
      const document = found.rows[0];
      if (!document || document.meeting_session_id !== motion.meeting_session_id) {
        throw new AppError({code: 'NOT_FOUND', message: 'Target amendment not found.'});
      }
      if (document.status !== 'DRAFT') throw new AppError({code: 'RESOURCE_CONFLICT',
        message: 'Only a draft amendment can be introduced.'});
      const contentSource = await client.query<{content: string; content_file_entry_id: string | null;
        file_status: string | null}>(`SELECT v.content,v.content_file_entry_id,e.status AS file_status
        FROM document_versions v LEFT JOIN file_entries e ON e.id=v.content_file_entry_id
        WHERE v.document_id=$1 AND v.id=$2`, [documentId, document.current_version_id]);
      const source = contentSource.rows[0];
      if (!source || !source.content.trim() && !source.content_file_entry_id) throw new AppError({code: 'RESOURCE_CONFLICT',
        message: 'Add amendment text or a file before introducing it.'});
      if (source.content_file_entry_id && source.file_status !== 'PUBLISHED') throw new AppError({code: 'RESOURCE_CONFLICT',
        message: 'Publish the amendment content file before introducing it.'});
      const amendment = await client.query<{proposer_seat_id: string}>(
        'SELECT proposer_seat_id FROM amendments WHERE document_id=$1 FOR UPDATE', [documentId]);
      const previousProposer = amendment.rows[0]?.proposer_seat_id ?? null;
      await client.query('UPDATE amendments SET proposer_seat_id=$2 WHERE document_id=$1',
        [documentId, motion.proposed_by_seat_id]);
      await client.query(`UPDATE documents SET status='PUBLISHED',is_public=true,revision=revision+1,updated_at=$2
        WHERE id=$1`, [documentId, now]);
      await client.query(`INSERT INTO document_actions
        (id,committee_id,document_id,action,from_status,to_status,rule_stable_id,rule_evaluation,actor_user_id,created_at)
        VALUES ($1,$2,$3,'PUBLISH','DRAFT','PUBLISHED',$4,$5,$6,$7)`,
      [randomUUID(), committeeId, documentId, motion.motion_type_id, motion.rule_evaluation, actorUserId, now]);
      await appendEvent(client, committee, {type: 'document.status_changed', resourceType: 'document', resourceId: documentId,
        revision: document.revision + 1, payload: {kind: 'AMENDMENT', status: 'PUBLISHED',
          resolutionId: document.resolution_document_id, motionId: motion.id}, audience: 'PUBLIC'});
      await audit(client, context, {committeeId, actorUserId, capabilities: ['CHAIR'],
        onBehalfOfSeatId: motion.proposed_by_seat_id, action: 'documents.status_changed',
        resourceType: 'document', resourceId: documentId,
        before: {status: 'DRAFT', proposerSeatId: previousProposer, revision: document.revision},
        after: {status: 'PUBLISHED', proposerSeatId: motion.proposed_by_seat_id,
          motionId: motion.id, revision: document.revision + 1}});
      return `/committees/${committeeId}/resolutions/${document.resolution_document_id}/amendments`;
    }

    if (motion.motion_type_id === 'vote-on-amendment') {
      const documentId = motionId(parameters, 'amendmentTarget', 'Target amendment ID');
      const found = await client.query<DocumentRow>(`SELECT d.*,a.resolution_document_id FROM documents d
        JOIN amendments a ON a.document_id=d.id WHERE d.id=$1 AND d.committee_id=$2 AND d.kind='AMENDMENT'
        AND d.deleted_at IS NULL FOR UPDATE OF d`, [documentId, committeeId]);
      const document = found.rows[0];
      if (!document || document.meeting_session_id !== motion.meeting_session_id) {
        throw new AppError({code: 'NOT_FOUND', message: 'Target amendment not found.'});
      }
      if (document.status !== 'PUBLISHED') throw new AppError({code: 'RESOURCE_CONFLICT',
        message: 'Only an introduced amendment can enter voting.'});
      await client.query(`UPDATE documents SET status='VOTING',voting_version_id=current_version_id,
        revision=revision+1,updated_at=$2 WHERE id=$1`, [documentId, now]);
      await client.query(`INSERT INTO document_actions
        (id,committee_id,document_id,action,from_status,to_status,rule_stable_id,rule_evaluation,actor_user_id,created_at)
        VALUES ($1,$2,$3,'RECOMMEND_BALLOT','PUBLISHED','VOTING',$4,$5,$6,$7)`,
      [randomUUID(), committeeId, documentId, motion.motion_type_id, motion.rule_evaluation, actorUserId, now]);
      await appendEvent(client, committee, {type: 'document.status_changed', resourceType: 'document',
        resourceId: documentId, revision: document.revision + 1, payload: {kind: 'AMENDMENT', status: 'VOTING',
          votingVersionId: document.current_version_id, motionId: motion.id}, audience: 'PUBLIC'});
      await audit(client, context, {committeeId, actorUserId, capabilities: ['CHAIR'],
        onBehalfOfSeatId: motion.proposed_by_seat_id, action: 'documents.status_changed',
        resourceType: 'document', resourceId: documentId,
        before: {status: document.status, revision: document.revision},
        after: {status: 'VOTING', votingVersionId: document.current_version_id,
          motionId: motion.id, revision: document.revision + 1}});
      return `/committees/${committeeId}/resolutions/${document.resolution_document_id}/amendments`;
    }

    if (motion.motion_type_id === 'vote-on-resolution') {
      const resolutionId = motionId(parameters, 'resolutionTarget', 'Target resolution ID');
      const found = await client.query<DocumentRow>(`SELECT d.*,NULL::uuid AS resolution_document_id FROM documents d
        WHERE d.id=$1 AND d.committee_id=$2 AND d.kind='RESOLUTION' AND d.deleted_at IS NULL FOR UPDATE`,
        [resolutionId, committeeId]);
      const document = found.rows[0];
      if (!document || document.meeting_session_id !== motion.meeting_session_id) {
        throw new AppError({code: 'NOT_FOUND', message: 'Target resolution not found.'});
      }
      if (document.status !== 'PUBLISHED') throw new AppError({code: 'RESOURCE_CONFLICT',
        message: 'Only an introduced resolution can enter voting.'});
      await client.query(`UPDATE documents SET status='VOTING',voting_version_id=current_version_id,
        revision=revision+1,updated_at=$2 WHERE id=$1`, [resolutionId, now]);
      await client.query(`INSERT INTO document_actions
        (id,committee_id,document_id,action,from_status,to_status,rule_stable_id,rule_evaluation,actor_user_id,created_at)
        VALUES ($1,$2,$3,'RECOMMEND_BALLOT','PUBLISHED','VOTING',$4,$5,$6,$7)`,
      [randomUUID(), committeeId, resolutionId, motion.motion_type_id, motion.rule_evaluation, actorUserId, now]);
      await appendEvent(client, committee, {type: 'document.status_changed', resourceType: 'document',
        resourceId: resolutionId, revision: document.revision + 1, payload: {kind: 'RESOLUTION', status: 'VOTING',
          ruleStableId: motion.motion_type_id, votingVersionId: document.current_version_id, motionId: motion.id},
        audience: 'PUBLIC'});
      await audit(client, context, {committeeId, actorUserId, capabilities: ['CHAIR'],
        onBehalfOfSeatId: motion.proposed_by_seat_id, action: 'documents.status_changed',
        resourceType: 'document', resourceId: resolutionId,
        before: {status: document.status, votingVersionId: document.voting_version_id, revision: document.revision},
        after: {status: 'VOTING', votingVersionId: document.current_version_id,
          revision: document.revision + 1, motionId: motion.id}});
      return `/committees/${committeeId}/resolutions/${resolutionId}/voting`;
    }

    if (motion.motion_type_id === 'propose-strawpoll') {
      const question = motionText(parameters, 'proposal', 'Strawpoll question', 1000); const strawpollId = randomUUID();
      await client.query(`INSERT INTO strawpolls
        (id,committee_id,meeting_session_id,question,voting_mode,multiple_choice,created_by_user_id,created_at)
        VALUES ($1,$2,$3,$4,'SEAT_AUTHENTICATED',true,$5,$6)`,
      [strawpollId, committeeId, motion.meeting_session_id, question, actorUserId, now]);
      await appendEvent(client, committee, {type: 'strawpoll.created', resourceType: 'strawpoll', resourceId: strawpollId,
        revision: 1, payload: {question, votingMode: 'SEAT_AUTHENTICATED', multipleChoice: true,
          options: [], motionId: motion.id}, audience: 'PUBLIC'});
      await audit(client, context, {committeeId, actorUserId, capabilities: ['CHAIR'], action: 'voting.strawpoll_created',
        resourceType: 'strawpoll', resourceId: strawpollId,
        after: {votingMode: 'SEAT_AUTHENTICATED', multipleChoice: true, optionCount: 0, motionId: motion.id, revision: 1}});
      return `/committees/${committeeId}/strawpolls/${strawpollId}`;
    }

    return null;
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
      if (result === 'PASSED' && committee.operation_mode !== 'CHAIR_OPERATED'
        && Number(seconds.rows[0]?.count ?? 0) < motion.required_second_count) throw new AppError({code: 'RESOURCE_CONFLICT',
        message: 'The motion does not have the required seconds.'});
      const now = this.now();
      const destinationPath = result === 'PASSED'
        ? await this.enactMotion(client, committee, motion, auth.user.id, now, context)
        : null;
      const updated = await client.query<MotionRow>(`UPDATE motions SET status=$2,
        decided_by_user_id=$3,decided_at=$4,destination_path=$5,revision=revision+1 WHERE id=$1 RETURNING *`,
      [motionId, result, auth.user.id, now, destinationPath]);
      await appendEvent(client, committee, {type: 'motion.decided', resourceType: 'motion', resourceId: motionId,
        revision: motion.revision + 1, payload: {result, decidedAt: now.toISOString(), destinationPath}, audience: 'PUBLIC'});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: 'proceedings.motion_decided', resourceType: 'motion', resourceId: motionId,
        before: {status: motion.status, revision: motion.revision},
        after: {status: result, decidedAt: now.toISOString(), destinationPath, revision: motion.revision + 1,
          advisoryRuleOverride: committee.operation_mode === 'CHAIR_OPERATED' && result === 'PASSED'
            && Number(seconds.rows[0]?.count ?? 0) < motion.required_second_count}});
      return motionState(client, updated.rows[0] as MotionRow);
    });
  }

  async setMotionDirectVoteSettings(auth: AuthenticatedSession, motionId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<ProceedingMotion> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision', 'includeNonVotingSeats']);
    const baseRevision = positiveInteger(input.baseRevision, 'Settings revision');
    if (typeof input.includeNonVotingSeats !== 'boolean') throw new AppError({code: 'VALIDATION_FAILED',
      message: 'The non-voting-seat setting is invalid.'});
    return transaction(this.pool, async client => {
      const located = await client.query<{committee_id: string}>('SELECT committee_id FROM motions WHERE id=$1', [motionId]);
      if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Motion not found.'});
      const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
      await requireChair(client, committee, auth.user.id);
      const found = await client.query<MotionRow>('SELECT * FROM motions WHERE id=$1 FOR UPDATE', [motionId]);
      const motion = found.rows[0] as MotionRow;
      if (['PASSED', 'FAILED', 'WITHDRAWN', 'SUPERSEDED'].includes(motion.status)) throw new AppError({
        code: 'RESOURCE_CONFLICT', message: 'The motion has already been decided.'});
      if (motion.direct_vote_settings_revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT',
        message: 'The direct-vote setting changed since it was loaded.',
        details: {currentRevision: motion.direct_vote_settings_revision}});
      if (motion.direct_vote_started_at && committee.operation_mode !== 'CHAIR_OPERATED') throw new AppError({
        code: 'RESOURCE_CONFLICT', message: 'This setting is locked after delegate voting starts.'});
      if (motion.direct_vote_include_non_voting === input.includeNonVotingSeats) throw new AppError({
        code: 'RESOURCE_CONFLICT', message: 'This direct-vote setting is already selected.'});
      const now = this.now();
      const updated = await client.query<MotionRow>(`UPDATE motions SET direct_vote_include_non_voting=$2,
        direct_vote_settings_revision=direct_vote_settings_revision+1 WHERE id=$1 RETURNING *`,
      [motionId, input.includeNonVotingSeats]);
      await client.query(`INSERT INTO motion_direct_vote_setting_revisions
        (id,committee_id,motion_id,previous_include_non_voting,new_include_non_voting,actor_user_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), committee.id, motionId,
        motion.direct_vote_include_non_voting, input.includeNonVotingSeats, auth.user.id, now]);
      await appendEvent(client, committee, {type: 'motion.direct_vote_settings_changed', resourceType: 'motion',
        resourceId: motionId, revision: motion.revision,
        payload: {includeNonVotingSeats: input.includeNonVotingSeats,
          settingsRevision: motion.direct_vote_settings_revision + 1}, audience: 'PUBLIC'});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: 'proceedings.motion_direct_vote_settings_changed', resourceType: 'motion', resourceId: motionId,
        before: {includeNonVotingSeats: motion.direct_vote_include_non_voting,
          settingsRevision: motion.direct_vote_settings_revision},
        after: {includeNonVotingSeats: input.includeNonVotingSeats,
          settingsRevision: motion.direct_vote_settings_revision + 1}});
      return motionState(client, updated.rows[0] as MotionRow);
    });
  }

  async setMotionDirectVote(auth: AuthenticatedSession, motionId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<ProceedingMotion> {
    requireBusinessIdentity(auth); assertExactBody(input, ['choice', 'onBehalfOfSeatId']);
    const choice = input.choice === null ? null : input.choice as BallotChoice;
    if (choice !== null && !['FOR', 'AGAINST', 'ABSTAIN'].includes(choice)) throw new AppError({
      code: 'VALIDATION_FAILED', message: 'Vote choice is invalid.'});
    return transaction(this.pool, async client => {
      const located = await client.query<{committee_id: string}>('SELECT committee_id FROM motions WHERE id=$1', [motionId]);
      if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Motion not found.'});
      const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
      const found = await client.query<MotionRow>('SELECT * FROM motions WHERE id=$1 FOR UPDATE', [motionId]);
      const motion = found.rows[0] as MotionRow;
      if (['PASSED', 'FAILED', 'WITHDRAWN', 'SUPERSEDED'].includes(motion.status)) throw new AppError({
        code: 'RESOURCE_CONFLICT', message: 'The motion has already been decided.'});
      const chair = await isChair(client, committee.id, auth.user.id); let seatId: string | null;
      if (chair) seatId = uuid(input.onBehalfOfSeatId, 'Represented seat ID');
      else {
        if (committee.operation_mode !== 'DELEGATE_OPERATED' || !committee.delegate_motion_voting_enabled) {
          throw new AppError({code: 'FORBIDDEN', message: 'Delegate motion voting is disabled.'});
        }
        if (input.onBehalfOfSeatId !== undefined) throw new AppError({code: 'FORBIDDEN',
          message: 'A delegate cannot choose another seat.'});
        seatId = await activeSeat(client, committee.id, auth.user.id);
      }
      if (!seatId) throw new AppError({code: 'FORBIDDEN', message: 'An active seat assignment is required.'});
      const eligible = await client.query<{display_name: string}>(`SELECT s.display_name FROM committee_seats s
        JOIN current_attendance a ON a.seat_id=s.id AND a.meeting_session_id=$3 AND a.state='PRESENT'
        WHERE s.id=$1 AND s.committee_id=$2 AND s.active=true AND ($4 OR s.can_vote=true)`,
      [seatId, committee.id, motion.meeting_session_id, motion.direct_vote_include_non_voting]);
      if (!eligible.rows[0]) throw new AppError({code: 'FORBIDDEN', message: 'This seat is not eligible for the direct vote.'});
      const procedural = motion.rule_evaluation.resolvedValues.procedural === true;
      if (choice === 'ABSTAIN' && procedural) throw new AppError({code: 'VALIDATION_FAILED',
        message: 'Procedural motion votes cannot abstain.'});
      const vote = await client.query<{id: string; current_choice: BallotChoice; revision: number; retracted_at: Date | null}>(
        `SELECT id,current_choice,revision,retracted_at FROM motion_direct_votes WHERE motion_id=$1 AND seat_id=$2 FOR UPDATE`,
        [motionId, seatId]);
      const current = vote.rows[0]; const previousChoice = current && !current.retracted_at ? current.current_choice : null;
      if (choice === previousChoice) throw new AppError({code: 'RESOURCE_CONFLICT', message: choice === null
        ? 'This seat has no current vote to retract.' : 'This seat already has that vote.'});
      const now = this.now(); let voteId: string; let voteRevision: number;
      if (!current) {
        if (choice === null) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'This seat has no current vote to retract.'});
        voteId = randomUUID(); voteRevision = 1;
        await client.query(`INSERT INTO motion_direct_votes
          (id,committee_id,motion_id,seat_id,seat_display_name,current_choice,actor_user_id,on_behalf_of_seat_id,cast_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$4,$8)`, [voteId, committee.id, motionId, seatId,
          eligible.rows[0].display_name, choice, auth.user.id, now]);
      } else if (choice === null) {
        voteId = current.id; voteRevision = current.revision + 1;
        await client.query(`UPDATE motion_direct_votes SET retracted_at=$2,retracted_by_user_id=$3,
          revision=revision+1 WHERE id=$1`, [voteId, now, auth.user.id]);
      } else {
        voteId = current.id; voteRevision = current.revision + 1;
        await client.query(`UPDATE motion_direct_votes SET current_choice=$2,actor_user_id=$3,on_behalf_of_seat_id=$4,
          cast_at=$5,retracted_at=NULL,retracted_by_user_id=NULL,revision=revision+1 WHERE id=$1`,
        [voteId, choice, auth.user.id, seatId, now]);
      }
      await client.query(`INSERT INTO motion_direct_vote_revisions
        (id,committee_id,motion_id,vote_id,seat_id,previous_choice,new_choice,actor_user_id,on_behalf_of_seat_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$5,$9)`, [randomUUID(), committee.id, motionId, voteId, seatId,
        previousChoice, choice, auth.user.id, now]);
      if (!motion.direct_vote_started_at) {
        await client.query('UPDATE motions SET direct_vote_started_at=$2 WHERE id=$1', [motionId, now]);
        motion.direct_vote_started_at = now;
      }
      await appendEvent(client, committee, {type: 'motion.direct_vote_changed', resourceType: 'motion', resourceId: motionId,
        revision: motion.revision, payload: {seatId, hasCurrentVote: choice !== null}, audience: 'PUBLIC'});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
        capabilities: chair ? ['CHAIR'] : ['MEMBER'], onBehalfOfSeatId: seatId,
        action: 'proceedings.motion_direct_vote_changed', resourceType: 'motion', resourceId: motionId,
        before: {seatId, choice: previousChoice, voteRevision: current?.revision ?? 0},
        after: {seatId, choice, voteRevision}});
      const updated = await client.query<MotionRow>('SELECT * FROM motions WHERE id=$1', [motionId]);
      return motionState(client, updated.rows[0] as MotionRow);
    });
  }

  async withdrawMotion(auth: AuthenticatedSession, motionId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<ProceedingMotion> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision']);
    const baseRevision = positiveInteger(input.baseRevision, 'Base revision');
    return transaction(this.pool, async client => {
      const located = await client.query<{committee_id: string}>('SELECT committee_id FROM motions WHERE id=$1', [motionId]);
      if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Motion not found.'});
      const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
      await requireChair(client, committee, auth.user.id);
      const found = await client.query<MotionRow>('SELECT * FROM motions WHERE id=$1 FOR UPDATE', [motionId]);
      const motion = found.rows[0] as MotionRow;
      if (!['PENDING', 'SECONDED'].includes(motion.status)) throw new AppError({code: 'RESOURCE_CONFLICT',
        message: 'Only a pending motion can be withdrawn.'});
      if (motion.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT',
        message: 'This motion changed since it was loaded.', details: {currentRevision: motion.revision}});
      const now = this.now();
      const updated = await client.query<MotionRow>(`UPDATE motions SET status='WITHDRAWN',decided_by_user_id=$2,
        decided_at=$3,revision=revision+1 WHERE id=$1 RETURNING *`, [motionId, auth.user.id, now]);
      await appendEvent(client, committee, {type: 'motion.decided', resourceType: 'motion', resourceId: motionId,
        revision: motion.revision + 1, payload: {result: 'WITHDRAWN', decidedAt: now.toISOString()}, audience: 'PUBLIC'});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: 'proceedings.motion_decided', resourceType: 'motion', resourceId: motionId,
        before: {status: motion.status, revision: motion.revision},
        after: {status: 'WITHDRAWN', decidedAt: now.toISOString(), revision: motion.revision + 1}});
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
        let subjectVersionId: string | null = null; let motionSubject: MotionRow | undefined;
        if (subjectType === 'MOTION') {
          const motion = await client.query<MotionRow>(`SELECT * FROM motions
            WHERE id=$1 AND committee_id=$2 FOR UPDATE`, [subjectId, committeeId]);
          motionSubject = motion.rows[0];
          if (!motionSubject) throw new AppError({code: 'NOT_FOUND', message: 'Motion not found.'});
          if (motionSubject.meeting_session_id !== meetingSessionId) throw new AppError({code: 'RESOURCE_CONFLICT',
            message: 'The motion belongs to another meeting session.'});
          if (motionSubject.status !== 'SECONDED') throw new AppError({code: 'RESOURCE_CONFLICT',
            message: 'The motion is not ready for voting.'});
          const frozenProcedural = motionSubject.rule_evaluation.resolvedValues.procedural === true;
          if (procedural !== frozenProcedural) throw new AppError({code: 'VALIDATION_FAILED',
            message: 'The ballot procedure type does not match the frozen motion rule.'});
          const existing = await client.query('SELECT 1 FROM ballots WHERE subject_type=$1 AND subject_id=$2 LIMIT 1',
            ['MOTION', subjectId]);
          if (existing.rowCount) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The motion already has a ballot.'});
        } else {
          const kind = subjectType === 'RESOLUTION' ? 'RESOLUTION' : 'AMENDMENT';
          const document = await client.query<{status: ProceedingDocumentStatus; voting_version_id: string | null}>(
            `SELECT status,voting_version_id FROM documents WHERE id=$1 AND committee_id=$2 AND kind=$3
              AND deleted_at IS NULL FOR UPDATE`,
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
          session.rows[0].active_rule_package_version_id, evaluation, JSON.stringify(eligibility), {kind: thresholdKind, value: thresholdValue},
          thresholdValue, auth.user.id, now]);
        if (motionSubject) {
          await client.query(`UPDATE motions SET status='VOTING',revision=revision+1 WHERE id=$1`, [motionSubject.id]);
          await appendEvent(client, committee, {type: 'motion.voting_started', resourceType: 'motion',
            resourceId: motionSubject.id, revision: motionSubject.revision + 1,
            payload: {ballotId: id, procedural, thresholdKind}, audience: 'PUBLIC'});
          await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['CHAIR'],
            action: 'proceedings.motion_voting_started', resourceType: 'motion', resourceId: motionSubject.id,
            before: {status: motionSubject.status, revision: motionSubject.revision},
            after: {status: 'VOTING', revision: motionSubject.revision + 1, ballotId: id}});
        }
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
        FROM ballot_votes WHERE ballot_id=$1 AND seat_id=$2 AND retracted_at IS NULL FOR UPDATE`, [ballotId, seatId]);
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

  async setBallotVote(auth: AuthenticatedSession, ballotId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<FormalBallot> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision', 'choice', 'onBehalfOfSeatId']);
    const baseRevision = positiveInteger(input.baseRevision, 'Base revision');
    const choice = input.choice === null ? null : input.choice as BallotChoice;
    if (choice !== null && !['FOR', 'AGAINST', 'ABSTAIN'].includes(choice)) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Vote choice is invalid.'});
    }
    return transaction(this.pool, async client => {
      const located = await client.query<{committee_id: string}>('SELECT committee_id FROM ballots WHERE id=$1', [ballotId]);
      if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Ballot not found.'});
      const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
      const ballotResult = await client.query<BallotRow>('SELECT * FROM ballots WHERE id=$1 FOR UPDATE', [ballotId]);
      const ballot = ballotResult.rows[0] as BallotRow;
      if (ballot.status !== 'OPEN') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The ballot is not open.'});
      if (ballot.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT',
        message: 'This ballot changed since it was loaded.', details: {currentRevision: ballot.revision}});
      const chair = await isChair(client, committee.id, auth.user.id); let seatId: string | null;
      if (chair) seatId = uuid(input.onBehalfOfSeatId, 'Represented seat ID');
      else {
        if (committee.operation_mode === 'CHAIR_OPERATED' || !committee.delegate_motion_voting_enabled) {
          throw new AppError({code: 'FORBIDDEN', message: 'Delegate motion voting is disabled.'});
        }
        if (input.onBehalfOfSeatId !== undefined) throw new AppError({code: 'FORBIDDEN',
          message: 'A delegate cannot choose another seat.'});
        seatId = await activeSeat(client, committee.id, auth.user.id);
      }
      const eligibility = ballot.eligibility_snapshot.find(seat => seat.seatId === seatId);
      if (!seatId || !eligibility) throw new AppError({code: 'FORBIDDEN', message: 'This seat is not eligible for the ballot.'});
      if (choice !== null && (!ballot.choices.includes(choice) || (eligibility.mustVote && choice === 'ABSTAIN'))) {
        throw new AppError({code: 'VALIDATION_FAILED', message: 'This seat cannot cast that choice.'});
      }
      const vote = await client.query<{id: string; current_choice: BallotChoice; revision: number; retracted_at: Date | null}>(
        `SELECT id,current_choice,revision,retracted_at FROM ballot_votes WHERE ballot_id=$1 AND seat_id=$2 FOR UPDATE`,
        [ballotId, seatId]);
      const current = vote.rows[0]; const previousChoice = current && !current.retracted_at ? current.current_choice : null;
      if (choice === null && previousChoice === null) throw new AppError({code: 'RESOURCE_CONFLICT',
        message: 'This seat has no current vote to retract.'});
      if (choice !== null && previousChoice === choice) throw new AppError({code: 'RESOURCE_CONFLICT',
        message: 'This seat already has that vote.'});
      const now = this.now(); let voteId: string; let voteRevision: number;
      if (!current) {
        voteId = randomUUID(); voteRevision = 1;
        await client.query(`INSERT INTO ballot_votes
          (id,ballot_id,seat_id,seat_display_name,current_choice,cast_by_user_id,cast_on_behalf,cast_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [voteId, ballotId, seatId, eligibility.seatDisplayName,
          choice, auth.user.id, chair, now]);
      } else if (choice === null) {
        voteId = current.id; voteRevision = current.revision + 1;
        await client.query(`UPDATE ballot_votes SET retracted_at=$2,retracted_by_user_id=$3,
          revision=revision+1 WHERE id=$1`, [voteId, now, auth.user.id]);
      } else {
        voteId = current.id; voteRevision = current.revision + 1;
        await client.query(`UPDATE ballot_votes SET current_choice=$2,cast_by_user_id=$3,cast_on_behalf=$4,
          cast_at=$5,retracted_at=NULL,retracted_by_user_id=NULL,revision=revision+1 WHERE id=$1`,
        [voteId, choice, auth.user.id, chair, now]);
      }
      await client.query(`INSERT INTO ballot_vote_revisions
        (id,ballot_id,vote_id,seat_id,previous_choice,new_choice,actor_user_id,on_behalf_of_seat_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$4)`, [randomUUID(), ballotId, voteId, seatId,
        previousChoice, choice, auth.user.id]);
      await client.query('UPDATE ballots SET revision=revision+1 WHERE id=$1', [ballotId]);
      await appendEvent(client, committee, {type: 'ballot.vote_changed', resourceType: 'ballot', resourceId: ballotId,
        revision: ballot.revision + 1, payload: {seatId, hasCurrentVote: choice !== null}, audience: 'CHAIR'});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
        capabilities: chair ? ['CHAIR'] : ['MEMBER'], onBehalfOfSeatId: seatId,
        action: 'voting.vote_changed', resourceType: 'ballot', resourceId: ballotId,
        before: {seatId, choice: previousChoice, voteRevision: current?.revision ?? 0},
        after: {seatId, choice, voteRevision, ballotRevision: ballot.revision + 1}});
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
        FROM ballot_votes WHERE ballot_id=$1 AND retracted_at IS NULL`, [ballotId]);
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
      if (ballot.subject_type === 'MOTION') {
        const motion = await client.query<MotionRow>('SELECT * FROM motions WHERE id=$1 FOR UPDATE', [ballot.subject_id]);
        if (!motion.rows[0] || !['SECONDED', 'VOTING'].includes(motion.rows[0].status)) throw new AppError({
          code: 'RESOURCE_CONFLICT', message: 'The ballot motion is no longer awaiting a result.'});
        const nextStatus = result.outcome === 'PASSED' ? 'PASSED' : 'FAILED';
        const destinationPath = nextStatus === 'PASSED'
          ? await this.enactMotion(client, committee, motion.rows[0], auth.user.id, now, context)
          : null;
        await client.query(`UPDATE motions SET status=$2,decided_by_user_id=$3,decided_at=$4,destination_path=$5,
          revision=revision+1 WHERE id=$1`, [ballot.subject_id, nextStatus, auth.user.id, now, destinationPath]);
        await appendEvent(client, committee, {type: 'motion.decided', resourceType: 'motion', resourceId: ballot.subject_id,
          revision: motion.rows[0].revision + 1,
          payload: {result: nextStatus, ballotId, ballotOutcome: result.outcome,
            decidedAt: now.toISOString(), destinationPath}, audience: 'PUBLIC'});
        await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
          action: 'proceedings.motion_decided', resourceType: 'motion', resourceId: ballot.subject_id,
          before: {status: motion.rows[0].status, revision: motion.rows[0].revision},
          after: {status: nextStatus, revision: motion.rows[0].revision + 1,
            ballotId, result, destinationPath}});
      } else if (ballot.subject_type === 'RESOLUTION' || ballot.subject_type === 'AMENDMENT') {
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
    requireBusinessIdentity(auth); assertExactBody(input, ['meetingSessionId', 'question', 'votingMode', 'multipleChoice',
      'options', 'medium', 'optionsArePublic']);
    const meetingSessionId = uuid(input.meetingSessionId, 'Meeting session ID');
    const requestedQuestion = text(input.question, 'Question', 1000, true);
    const votingMode = input.votingMode as StrawpollVotingMode;
    if (!['ANONYMOUS', 'SEAT_AUTHENTICATED'].includes(votingMode)) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Strawpoll voting mode is invalid.'});
    }
    if (typeof input.multipleChoice !== 'boolean') {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Strawpoll choice mode is invalid.'});
    }
    if (!Array.isArray(input.options) || input.options.length > 20) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Strawpoll options are invalid.'});
    }
    const medium = (input.medium ?? 'LINK') as Strawpoll['medium'];
    if (!['LINK', 'MANUAL'].includes(medium)) throw new AppError({code: 'VALIDATION_FAILED',
      message: 'Strawpoll medium is invalid.'});
    if (input.optionsArePublic !== undefined && typeof input.optionsArePublic !== 'boolean') {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Strawpoll option permission is invalid.'});
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
        let question = requestedQuestion;
        if (!question) {
          const numbered = await client.query<{next_number: number}>(`SELECT count(*)::int+1 AS next_number
            FROM strawpolls WHERE committee_id=$1 AND meeting_session_id=$2`, [committeeId, meetingSessionId]);
          question = `New strawpoll ${numbered.rows[0]?.next_number ?? 1}`;
        }
        const id = randomUUID(); const accessToken = votingMode === 'ANONYMOUS' && medium === 'LINK'
          ? randomBytes(32).toString('base64url') : undefined;
        if (votingMode === 'ANONYMOUS' && medium === 'MANUAL') throw new AppError({code: 'VALIDATION_FAILED',
          message: 'Manual strawpolls do not use anonymous voting.'});
        const stage: Strawpoll['stage'] = optionLabels.length >= 2 ? 'VOTING' : 'PREPARING';
        const inserted = await client.query<StrawpollRow>(`INSERT INTO strawpolls
          (id,committee_id,meeting_session_id,question,voting_mode,multiple_choice,anonymous_access_token_hash,
           created_by_user_id,series_id,stage,medium,options_are_public)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$1,$9,$10,$11) RETURNING *`, [id, committeeId, meetingSessionId, question,
          votingMode, input.multipleChoice, accessToken ? sha256(accessToken) : null, auth.user.id, stage, medium,
          input.optionsArePublic ?? false]);
        for (const [index, label] of optionLabels.entries()) {
          await client.query('INSERT INTO strawpoll_options (id,strawpoll_id,label,sort_order) VALUES ($1,$2,$3,$4)',
            [randomUUID(), id, label, index]);
        }
        await appendEvent(client, committee, {type: 'strawpoll.created', resourceType: 'strawpoll', resourceId: id,
          revision: 1, payload: {question, votingMode, multipleChoice: input.multipleChoice, stage, medium,
            options: optionLabels.map((label, index) => ({label, sortOrder: index}))}, audience: 'PUBLIC'});
        await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['CHAIR'],
          action: 'voting.strawpoll_created', resourceType: 'strawpoll', resourceId: id,
          after: {votingMode, multipleChoice: input.multipleChoice, optionCount: optionLabels.length, stage, medium,
            revision: 1}});
        return {...await strawpollState(client, inserted.rows[0] as StrawpollRow),
          ...(accessToken ? {anonymousAccessToken: accessToken} : {})};
      }});
  }

  async voteStrawpoll(auth: AuthenticatedSession, strawpollId: string, input: Record<string, unknown>, key: string,
    context: Stage4Context): Promise<Strawpoll> {
    requireBusinessIdentity(auth);
    assertExactBody(input, ['optionIds', 'onBehalfOfSeatId', 'anonymousAccessToken']);
    if (!Array.isArray(input.optionIds) || input.optionIds.length > 20) {
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
        if (poll.stage !== 'VOTING' || poll.medium !== 'LINK') throw new AppError({code: 'RESOURCE_CONFLICT',
          message: 'The strawpoll is not accepting linked votes.'});
        if (!poll.multiple_choice && optionIds.length > 1) {
          throw new AppError({code: 'VALIDATION_FAILED', message: 'Select one strawpoll option.'});
        }
        const validOptions = optionIds.length === 0 ? {rowCount: 0} : await client.query<{id: string}>(
          'SELECT id FROM strawpoll_options WHERE strawpoll_id=$1 AND id=ANY($2::uuid[])', [strawpollId, optionIds]);
        if (validOptions.rowCount !== optionIds.length) throw new AppError({code: 'VALIDATION_FAILED', message: 'Strawpoll choice is invalid.'});
        const chair = await isChair(client, committee.id, auth.user.id);
        if (poll.voting_mode === 'ANONYMOUS') {
          if (optionIds.length === 0) throw new AppError({code: 'VALIDATION_FAILED',
            message: 'Anonymous strawpoll votes cannot be retracted.'});
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
          const previous = await client.query<{id: string; option_ids: string[]; revision: number; retracted_at: Date | null}>(
            'SELECT id,option_ids,revision,retracted_at FROM strawpoll_seat_votes WHERE strawpoll_id=$1 AND seat_id=$2 FOR UPDATE',
          [strawpollId, seatId]);
          const current = previous.rows[0]; const previousOptionIds = current && !current.retracted_at ? current.option_ids : null;
          if (!current && optionIds.length === 0 || current?.retracted_at && optionIds.length === 0) throw new AppError({
            code: 'RESOURCE_CONFLICT', message: 'This seat has no current strawpoll vote to retract.'});
          if (previousOptionIds && JSON.stringify([...previousOptionIds].sort()) === JSON.stringify([...optionIds].sort())) {
            throw new AppError({code: 'RESOURCE_CONFLICT', message: 'This seat already selected those strawpoll options.'});
          }
          const voteId = current?.id ?? randomUUID();
          if (!current) await client.query(`INSERT INTO strawpoll_seat_votes
            (id,strawpoll_id,seat_id,option_ids,actor_user_id,on_behalf_of_seat_id) VALUES ($1,$2,$3,$4,$5,$3)`,
          [voteId, strawpollId, seatId, optionIds, auth.user.id]);
          else if (optionIds.length === 0) await client.query(`UPDATE strawpoll_seat_votes SET retracted_at=$2,
            retracted_by_user_id=$3,revision=revision+1 WHERE id=$1`, [voteId, this.now(), auth.user.id]);
          else await client.query(`UPDATE strawpoll_seat_votes SET option_ids=$2,actor_user_id=$3,
            on_behalf_of_seat_id=$4,retracted_at=NULL,retracted_by_user_id=NULL,revision=revision+1 WHERE id=$1`,
          [voteId, optionIds, auth.user.id, seatId]);
          await client.query(`INSERT INTO strawpoll_seat_vote_revisions
            (id,strawpoll_id,vote_id,seat_id,previous_option_ids,new_option_ids,actor_user_id,on_behalf_of_seat_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$4)`, [randomUUID(), strawpollId, voteId, seatId,
            previousOptionIds, optionIds.length === 0 ? null : optionIds, auth.user.id]);
          await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
            capabilities: chair ? ['CHAIR'] : ['MEMBER'], onBehalfOfSeatId: seatId,
            action: 'voting.strawpoll_vote_recorded', resourceType: 'strawpoll', resourceId: strawpollId,
            after: {votingMode: 'SEAT_AUTHENTICATED', seatId, previousOptionIds,
              optionIds: optionIds.length === 0 ? null : optionIds, revision: poll.revision + 1}});
        }
        await client.query('UPDATE strawpolls SET revision=revision+1 WHERE id=$1', [strawpollId]);
        await appendEvent(client, committee, {type: poll.voting_mode === 'SEAT_AUTHENTICATED'
          ? 'strawpoll.vote_changed' : 'strawpoll.vote_recorded', resourceType: 'strawpoll', resourceId: strawpollId,
          revision: poll.revision + 1, payload: {votingMode: poll.voting_mode}, audience: 'PUBLIC'});
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
      if (poll.stage !== 'VOTING') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The strawpoll is not voting.'});
      if (poll.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT',
        message: 'This strawpoll changed since it was loaded.', details: {currentRevision: poll.revision}});
      const now = this.now(); const updated = await client.query<StrawpollRow>(`UPDATE strawpolls SET status='CLOSED',
        stage='RESULTS',closed_at=$2,revision=revision+1 WHERE id=$1 RETURNING *`, [strawpollId, now]);
      const state = await strawpollState(client, updated.rows[0] as StrawpollRow);
      await appendEvent(client, committee, {type: 'strawpoll.closed', resourceType: 'strawpoll', resourceId: strawpollId,
        revision: poll.revision + 1, payload: {closedAt: now.toISOString(), options: state.options}, audience: 'PUBLIC'});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: 'voting.strawpoll_closed', resourceType: 'strawpoll', resourceId: strawpollId,
        before: {status: 'OPEN', revision: poll.revision}, after: {status: 'CLOSED', revision: poll.revision + 1}});
      return state;
    });
  }

  async reviseStrawpoll(auth: AuthenticatedSession, strawpollId: string, input: Record<string, unknown>, key: string,
    context: Stage4Context): Promise<CreatedStrawpoll> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision', 'question', 'votingMode', 'multipleChoice',
      'options', 'medium', 'optionsArePublic']);
    const baseRevision = positiveInteger(input.baseRevision, 'Base revision');
    const question = text(input.question, 'Question', 1000); const votingMode = input.votingMode as StrawpollVotingMode;
    const medium = input.medium as Strawpoll['medium'];
    if (!['ANONYMOUS', 'SEAT_AUTHENTICATED'].includes(votingMode) || !['LINK', 'MANUAL'].includes(medium)
      || medium === 'MANUAL' && votingMode !== 'SEAT_AUTHENTICATED') throw new AppError({code: 'VALIDATION_FAILED',
      message: 'Strawpoll voting configuration is invalid.'});
    if (typeof input.multipleChoice !== 'boolean' || typeof input.optionsArePublic !== 'boolean'
      || !Array.isArray(input.options) || input.options.length > 20) throw new AppError({code: 'VALIDATION_FAILED',
      message: 'Strawpoll round settings are invalid.'});
    const optionLabels = input.options.map((value, index) => text(value, `Option ${index + 1}`, 500));
    if (new Set(optionLabels).size !== optionLabels.length) throw new AppError({code: 'VALIDATION_FAILED',
      message: 'Strawpoll options must be unique.'});
    return idempotentTransaction({pool: this.pool, auth, route: `POST /api/v1/strawpolls/${strawpollId}/rounds`,
      key, request: input, status: 201, work: async client => {
        const located = await client.query<{committee_id: string}>('SELECT committee_id FROM strawpolls WHERE id=$1', [strawpollId]);
        if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Strawpoll not found.'});
        const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
        const found = await client.query<StrawpollRow & {anonymous_access_token_hash: Buffer | null}>(
          'SELECT * FROM strawpolls WHERE id=$1 FOR UPDATE', [strawpollId]);
        const poll = found.rows[0];
        if (!poll || poll.superseded_by_id) throw new AppError({code: 'RESOURCE_CONFLICT',
          message: 'This strawpoll round is no longer current.'});
        if (poll.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT',
          message: 'This strawpoll changed since it was loaded.', details: {currentRevision: poll.revision}});
        const chair = await isChair(client, committee.id, auth.user.id);
        if (!chair) {
          if (committee.operation_mode !== 'DELEGATE_OPERATED' || !poll.options_are_public || poll.stage !== 'PREPARING') {
            throw new AppError({code: 'FORBIDDEN', message: 'A Chair is required to edit this strawpoll.'});
          }
          const seatId = await activeSeat(client, committee.id, auth.user.id);
          const present = seatId ? await client.query(`SELECT 1 FROM current_attendance
            WHERE meeting_session_id=$1 AND seat_id=$2 AND state='PRESENT'`, [poll.meeting_session_id, seatId]) : {rowCount: 0};
          if (!present.rowCount) throw new AppError({code: 'FORBIDDEN', message: 'A present seat is required.'});
          const currentOptions = await client.query<{label: string}>(
            'SELECT label FROM strawpoll_options WHERE strawpoll_id=$1 ORDER BY sort_order,id', [strawpollId]);
          const unchanged = question === poll.question && votingMode === poll.voting_mode
            && input.multipleChoice === poll.multiple_choice && medium === poll.medium
            && input.optionsArePublic === poll.options_are_public;
          const appendedOne = optionLabels.length === currentOptions.rows.length + 1
            && currentOptions.rows.every((item, index) => item.label === optionLabels[index]);
          if (!unchanged || !appendedOne) throw new AppError({code: 'FORBIDDEN',
            message: 'Delegates may only add one option to this strawpoll.'});
        }
        const id = randomUUID(); const now = this.now();
        const accessToken = votingMode === 'ANONYMOUS' ? randomBytes(32).toString('base64url') : undefined;
        const inserted = await client.query<StrawpollRow>(`INSERT INTO strawpolls
          (id,committee_id,meeting_session_id,question,voting_mode,multiple_choice,anonymous_access_token_hash,
           created_by_user_id,series_id,round_number,stage,medium,options_are_public,created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PREPARING',$11,$12,$13) RETURNING *`,
        [id, committee.id, poll.meeting_session_id, question, votingMode, input.multipleChoice,
          accessToken ? sha256(accessToken) : null, auth.user.id, poll.series_id, poll.round_number + 1, medium,
          input.optionsArePublic, now]);
        for (const [index, label] of optionLabels.entries()) await client.query(
          'INSERT INTO strawpoll_options (id,strawpoll_id,label,sort_order) VALUES ($1,$2,$3,$4)',
        [randomUUID(), id, label, index]);
        await client.query('UPDATE strawpolls SET superseded_by_id=$2,revision=revision+1 WHERE id=$1', [strawpollId, id]);
        await appendEvent(client, committee, {type: 'strawpoll.round_created', resourceType: 'strawpoll', resourceId: id,
          revision: 1, payload: {seriesId: poll.series_id, roundNumber: poll.round_number + 1,
            previousRoundId: strawpollId}, audience: 'PUBLIC'});
        await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
          capabilities: chair ? ['CHAIR'] : ['MEMBER'], action: 'voting.strawpoll_round_created',
          resourceType: 'strawpoll', resourceId: id,
          before: {roundId: strawpollId, roundNumber: poll.round_number, revision: poll.revision},
          after: {roundId: id, roundNumber: poll.round_number + 1, optionCount: optionLabels.length}});
        return {...await strawpollState(client, inserted.rows[0] as StrawpollRow),
          ...(accessToken ? {anonymousAccessToken: accessToken} : {})};
      }});
  }

  async commandStrawpollStage(auth: AuthenticatedSession, strawpollId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<Strawpoll> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision', 'action']);
    const baseRevision = positiveInteger(input.baseRevision, 'Base revision');
    const action = input.action as 'START' | 'VIEW_RESULTS' | 'REOPEN';
    if (!['START', 'VIEW_RESULTS', 'REOPEN'].includes(action)) throw new AppError({code: 'VALIDATION_FAILED',
      message: 'Strawpoll stage action is invalid.'});
    return transaction(this.pool, async client => {
      const located = await client.query<{committee_id: string}>('SELECT committee_id FROM strawpolls WHERE id=$1', [strawpollId]);
      if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Strawpoll not found.'});
      const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
      await requireChair(client, committee, auth.user.id);
      const found = await client.query<StrawpollRow>('SELECT * FROM strawpolls WHERE id=$1 FOR UPDATE', [strawpollId]);
      const poll = found.rows[0] as StrawpollRow;
      if (poll.superseded_by_id) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'This strawpoll round is no longer current.'});
      if (poll.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT',
        message: 'This strawpoll changed since it was loaded.', details: {currentRevision: poll.revision}});
      const expected = action === 'START' ? 'PREPARING' : action === 'VIEW_RESULTS' ? 'VOTING' : 'RESULTS';
      if (poll.stage !== expected) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The strawpoll is in another stage.'});
      if (action === 'START') {
        const options = await client.query('SELECT 1 FROM strawpoll_options WHERE strawpoll_id=$1', [strawpollId]);
        if (Number(options.rowCount) < 2) throw new AppError({code: 'VALIDATION_FAILED',
          message: 'At least two options are required to start a strawpoll.'});
      }
      const stage: Strawpoll['stage'] = action === 'VIEW_RESULTS' ? 'RESULTS' : 'VOTING';
      const status: Strawpoll['status'] = stage === 'RESULTS' ? 'CLOSED' : 'OPEN'; const now = this.now();
      const updated = await client.query<StrawpollRow>(`UPDATE strawpolls SET stage=$2,status=$3,
        closed_at=$4,revision=revision+1 WHERE id=$1 RETURNING *`,
      [strawpollId, stage, status, stage === 'RESULTS' ? now : null]);
      await appendEvent(client, committee, {type: 'strawpoll.stage_changed', resourceType: 'strawpoll',
        resourceId: strawpollId, revision: poll.revision + 1, payload: {stage}, audience: 'PUBLIC'});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: 'voting.strawpoll_stage_changed', resourceType: 'strawpoll', resourceId: strawpollId,
        before: {stage: poll.stage, revision: poll.revision}, after: {stage, revision: poll.revision + 1}});
      return strawpollState(client, updated.rows[0] as StrawpollRow);
    });
  }

  async setStrawpollManualTally(auth: AuthenticatedSession, strawpollId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<Strawpoll> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision', 'optionId', 'tally']);
    const baseRevision = positiveInteger(input.baseRevision, 'Base revision'); const optionId = uuid(input.optionId, 'Option ID');
    if (!Number.isSafeInteger(input.tally) || Number(input.tally) < 0) throw new AppError({code: 'VALIDATION_FAILED',
      message: 'Manual tally is invalid.'});
    return transaction(this.pool, async client => {
      const located = await client.query<{committee_id: string}>('SELECT committee_id FROM strawpolls WHERE id=$1', [strawpollId]);
      if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Strawpoll not found.'});
      const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
      await requireChair(client, committee, auth.user.id);
      const found = await client.query<StrawpollRow>('SELECT * FROM strawpolls WHERE id=$1 FOR UPDATE', [strawpollId]);
      const poll = found.rows[0] as StrawpollRow;
      if (poll.medium !== 'MANUAL' || poll.stage !== 'VOTING' || poll.superseded_by_id) throw new AppError({
        code: 'RESOURCE_CONFLICT', message: 'This strawpoll is not accepting manual tallies.'});
      if (poll.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT',
        message: 'This strawpoll changed since it was loaded.', details: {currentRevision: poll.revision}});
      const option = await client.query<{manual_tally: number}>(
        'SELECT manual_tally FROM strawpoll_options WHERE id=$1 AND strawpoll_id=$2 FOR UPDATE', [optionId, strawpollId]);
      if (!option.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Strawpoll option not found.'});
      const previous = option.rows[0].manual_tally; const tally = Number(input.tally);
      if (previous === tally) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The manual tally is unchanged.'});
      const now = this.now();
      await client.query('UPDATE strawpoll_options SET manual_tally=$2 WHERE id=$1', [optionId, tally]);
      await client.query(`INSERT INTO strawpoll_manual_tally_revisions
        (id,strawpoll_id,option_id,previous_tally,new_tally,actor_user_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), strawpollId, optionId, previous, tally, auth.user.id, now]);
      const updated = await client.query<StrawpollRow>(
        'UPDATE strawpolls SET revision=revision+1 WHERE id=$1 RETURNING *', [strawpollId]);
      await appendEvent(client, committee, {type: 'strawpoll.manual_tally_changed', resourceType: 'strawpoll',
        resourceId: strawpollId, revision: poll.revision + 1, payload: {optionId, tally}, audience: 'PUBLIC'});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: 'voting.strawpoll_manual_tally_changed', resourceType: 'strawpoll', resourceId: strawpollId,
        before: {optionId, tally: previous, revision: poll.revision},
        after: {optionId, tally, revision: poll.revision + 1}});
      return strawpollState(client, updated.rows[0] as StrawpollRow);
    });
  }

  async createResolution(auth: AuthenticatedSession, committeeId: string, input: Record<string, unknown>, key: string,
    context: Stage4Context): Promise<ProceedingDocument> {
    return this.createDocument(auth, committeeId, 'RESOLUTION', input, key, context);
  }

  async createAmendment(auth: AuthenticatedSession, resolutionId: string, input: Record<string, unknown>, key: string,
    context: Stage4Context): Promise<ProceedingDocument> {
    requireBusinessIdentity(auth);
    const located = await this.pool.query<{committee_id: string}>(
      'SELECT committee_id FROM documents WHERE id=$1 AND kind=$2 AND deleted_at IS NULL',
      [resolutionId, 'RESOLUTION']);
    if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Resolution not found.'});
    return this.createDocument(auth, located.rows[0].committee_id, 'AMENDMENT', {...input, resolutionId}, key, context);
  }

  async deleteAmendment(auth: AuthenticatedSession, documentId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<{id: string; deleted: true}> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision']);
    const baseRevision = positiveInteger(input.baseRevision, 'Base revision');
    return transaction(this.pool, async client => {
      const located = await client.query<{committee_id: string}>(
        'SELECT committee_id FROM documents WHERE id=$1 AND deleted_at IS NULL', [documentId]);
      if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Amendment not found.'});
      const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
      const found = await client.query<DocumentRow & {deleted_at: Date | null}>(`SELECT d.*,a.resolution_document_id
        FROM documents d JOIN amendments a ON a.document_id=d.id WHERE d.id=$1 AND d.deleted_at IS NULL
        FOR UPDATE OF d`, [documentId]);
      const document = found.rows[0];
      if (!document || document.deleted_at) throw new AppError({code: 'NOT_FOUND', message: 'Amendment not found.'});
      if (document.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT',
        message: 'This amendment changed since it was loaded.', details: {currentRevision: document.revision}});
      const chair = await isChair(client, committee.id, auth.user.id);
      const seatId = chair ? null : await activeSeat(client, committee.id, auth.user.id);
      if (!chair && (!seatId || seatId !== document.created_on_behalf_of_seat_id)) throw new AppError({code: 'FORBIDDEN',
        message: 'Only the amendment proposer or a Chair may delete it.'});
      const ballot = await client.query('SELECT 1 FROM ballots WHERE subject_type=$1 AND subject_id=$2 LIMIT 1',
        ['AMENDMENT', documentId]);
      if (ballot.rowCount || document.voting_version_id || ['VOTING', 'INCORPORATED', 'REJECTED'].includes(document.status)) {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'An amendment cannot be deleted after voting begins.'});
      }
      const now = this.now();
      await client.query(`UPDATE documents SET deleted_at=$2,deleted_by_user_id=$3,revision=revision+1,updated_at=$2
        WHERE id=$1`, [documentId, now, auth.user.id]);
      await appendEvent(client, committee, {type: 'document.deleted', resourceType: 'document', resourceId: documentId,
        revision: document.revision + 1, payload: {kind: 'AMENDMENT', resolutionId: document.resolution_document_id},
        audience: document.is_public ? 'PUBLIC' : 'MEMBER'});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id,
        capabilities: chair ? ['CHAIR'] : ['MEMBER'], ...(seatId ? {onBehalfOfSeatId: seatId} : {}),
        action: 'documents.deleted', resourceType: 'document', resourceId: documentId,
        before: {kind: 'AMENDMENT', status: document.status, revision: document.revision},
        after: {deleted: true, revision: document.revision + 1}});
      return {id: documentId, deleted: true};
    });
  }

  private async createDocument(auth: AuthenticatedSession, committeeId: string, kind: ProceedingDocumentKind,
    input: Record<string, unknown>, key: string, context: Stage4Context): Promise<ProceedingDocument> {
    requireBusinessIdentity(auth);
    assertExactBody(input, kind === 'RESOLUTION'
      ? ['meetingSessionId', 'title', 'content', 'onBehalfOfSeatId']
      : ['meetingSessionId', 'title', 'content', 'onBehalfOfSeatId', 'resolutionId']);
    const meetingSessionId = uuid(input.meetingSessionId, 'Meeting session ID');
    const suppliedTitle = text(input.title, 'Title', 500, true).trim();
    const content = text(input.content, 'Content', 200_000, true); const resolutionId = kind === 'AMENDMENT'
      ? uuid(input.resolutionId, 'Resolution ID') : null;
    const route = kind === 'RESOLUTION' ? `POST /api/v1/committees/${committeeId}/resolutions`
      : `POST /api/v1/resolutions/${resolutionId}/amendments`;
    return idempotentTransaction({pool: this.pool, auth, route, key, request: input, status: 201, work: async client => {
      const committee = await lockedCommittee(client, committeeId); requireProceedingsActive(committee);
      const session = await client.query<{status: string; active_rule_package_version_id: string}>(`SELECT status,
        active_rule_package_version_id FROM meeting_sessions WHERE id=$1 AND committee_id=$2`, [meetingSessionId, committeeId]);
      if (!session.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Meeting session not found.'});
      if (session.rows[0].status !== 'OPEN') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Meeting session is closed.'});
      const chair = await isChair(client, committee.id, auth.user.id);
      const actor = kind === 'RESOLUTION' && chair && input.onBehalfOfSeatId === undefined
        ? {chair: true, seatId: null as string | null, displayName: ''}
        : await representedDocumentSeat(client, committee, auth, input.onBehalfOfSeatId, meetingSessionId);
      let title = suppliedTitle;
      if (kind === 'RESOLUTION' && !title) {
        const sequence = await client.query<{next_number: number}>(`SELECT count(*)::int+1 AS next_number
          FROM documents WHERE committee_id=$1 AND kind='RESOLUTION'`, [committeeId]);
        title = `New draft resolution ${sequence.rows[0]?.next_number ?? 1}`;
      }
      if (kind === 'AMENDMENT' && !title) {
        const sequence = await client.query<{next_number: number}>(`SELECT count(*)::int+1 AS next_number
          FROM documents WHERE committee_id=$1 AND kind='AMENDMENT'`, [committeeId]);
        title = `New amendment ${sequence.rows[0]?.next_number ?? 1}`;
      }
      const isPublic = false;
      if (kind === 'AMENDMENT') {
        const parent = await client.query<DocumentRow>(`SELECT d.*,NULL::uuid AS resolution_document_id FROM documents d
          WHERE d.id=$1 AND d.committee_id=$2 AND d.kind='RESOLUTION' AND d.deleted_at IS NULL FOR UPDATE`,
        [resolutionId, committeeId]);
        if (!parent.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Resolution not found.'});
        if (parent.rows[0].meeting_session_id !== meetingSessionId) throw new AppError({code: 'VALIDATION_FAILED',
          message: 'Amendment and resolution must use the same meeting session.'});
        if (!['PUBLISHED', 'POSTPONED'].includes(parent.rows[0].status)) throw new AppError({code: 'RESOURCE_CONFLICT',
          message: 'The resolution does not accept amendments.'});
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
        capabilities: actor.chair ? ['CHAIR'] : ['MEMBER'], ...(actor.seatId ? {onBehalfOfSeatId: actor.seatId} : {}),
        action: 'documents.created', resourceType: 'document', resourceId: id,
        after: {kind, resolutionId, title, versionId, characterCount: [...content].length, revision: 1}});
      const row = inserted.rows[0] as DocumentRow; row.resolution_document_id = resolutionId;
      return documentState(client, row);
    }});
  }

  async createDocumentVersion(auth: AuthenticatedSession, documentId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<ProceedingDocument> {
    requireBusinessIdentity(auth); assertExactBody(input,
      ['baseRevision', 'title', 'content', 'contentFileEntryId', 'onBehalfOfSeatId']);
    const baseRevision = positiveInteger(input.baseRevision, 'Base revision'); const title = text(input.title, 'Title', 500);
    const content = text(input.content, 'Content', 200_000, true);
    const contentFileEntryId = input.contentFileEntryId === undefined || input.contentFileEntryId === null
      ? null : uuid(input.contentFileEntryId, 'Content file entry ID');
    return transaction(this.pool, async client => {
      const located = await client.query<{committee_id: string}>(
        'SELECT committee_id FROM documents WHERE id=$1 AND deleted_at IS NULL', [documentId]);
      if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Document not found.'});
      const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
      const found = await client.query<DocumentRow>(`SELECT d.*,a.resolution_document_id FROM documents d
        LEFT JOIN amendments a ON a.document_id=d.id WHERE d.id=$1 AND d.deleted_at IS NULL FOR UPDATE OF d`, [documentId]);
      const document = found.rows[0]; if (!document) throw new AppError({code: 'NOT_FOUND', message: 'Document not found.'});
      if (contentFileEntryId && content) throw new AppError({code: 'VALIDATION_FAILED',
        message: 'A document body must use either text or a file.'});
      if (contentFileEntryId) {
        const file = await client.query<{id: string}>(`SELECT id FROM file_entries
          WHERE id=$1 AND committee_id=$2 AND status<>'DELETED' FOR KEY SHARE`, [contentFileEntryId, committee.id]);
        if (!file.rows[0]) throw new AppError({code: 'VALIDATION_FAILED', message: 'Content file is unavailable.'});
      }
      if (document.kind === 'AMENDMENT' && !content.trim() && !contentFileEntryId) throw new AppError({code: 'VALIDATION_FAILED',
        message: 'Amendment content is invalid.'});
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
        (id,document_id,version_number,content,content_file_entry_id,created_by_user_id,created_on_behalf_of_seat_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [versionId, documentId, versionNumber, content, contentFileEntryId, auth.user.id, actor.seatId, now]);
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
        after: {versionId, versionNumber, characterCount: [...content].length, contentFileEntryId,
          revision: document.revision + 1}});
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
      const located = await client.query<{committee_id: string}>(
        'SELECT committee_id FROM documents WHERE id=$1 AND deleted_at IS NULL', [documentId]);
      if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Document not found.'});
      const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
      await requireChair(client, committee, auth.user.id);
      const found = await client.query<DocumentRow>(`SELECT d.*,a.resolution_document_id FROM documents d
        LEFT JOIN amendments a ON a.document_id=d.id WHERE d.id=$1 AND d.deleted_at IS NULL FOR UPDATE OF d`, [documentId]);
      const document = found.rows[0]; if (!document) throw new AppError({code: 'NOT_FOUND', message: 'Document not found.'});
      if (action === 'PUBLISH') throw new AppError({code: 'RESOURCE_CONFLICT',
        message: 'A draft document can only be introduced by a passed motion.'});
      if (document.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT',
        message: 'This document changed since it was loaded.', details: {currentRevision: document.revision}});
      const expectedFrom: Record<typeof action, ProceedingDocumentStatus> = {POSTPONE: 'PUBLISHED',
        RESUME: 'POSTPONED', RECOMMEND_BALLOT: 'PUBLISHED'};
      const nextStatus: Record<typeof action, ProceedingDocumentStatus> = {POSTPONE: 'POSTPONED',
        RESUME: 'PUBLISHED', RECOMMEND_BALLOT: 'VOTING'};
      if (document.status !== expectedFrom[action]) throw new AppError({code: 'RESOURCE_CONFLICT',
        message: 'The document is not in the required state.'});
      const now = this.now(); const evaluation = await frozenDocumentRule(client, document, ruleStableId,
        documentRuleIds[document.kind][action], now); const status = nextStatus[action];
      const updated = await client.query<DocumentRow>(`UPDATE documents SET status=$2::proceeding_document_status,is_public=true,
        voting_version_id=CASE WHEN $2::proceeding_document_status='VOTING' THEN current_version_id ELSE voting_version_id END,
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

  async updateDocumentSettings(auth: AuthenticatedSession, documentId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<ProceedingDocument> {
    requireBusinessIdentity(auth);
    assertExactBody(input, ['baseRevision', 'proposerSeatId', 'seconderSeatId', 'delegatesCanAmend', 'majority']);
    const baseRevision = positiveInteger(input.baseRevision, 'Base revision');
    const supplied = ['proposerSeatId', 'seconderSeatId', 'delegatesCanAmend', 'majority']
      .filter(key => Object.prototype.hasOwnProperty.call(input, key));
    if (supplied.length === 0) throw new AppError({code: 'VALIDATION_FAILED', message: 'No document setting was supplied.'});
    return transaction(this.pool, async client => {
      const located = await client.query<{committee_id: string}>(
        'SELECT committee_id FROM documents WHERE id=$1 AND deleted_at IS NULL', [documentId]);
      if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Document not found.'});
      const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
      await requireChair(client, committee, auth.user.id);
      const found = await client.query<DocumentRow>(`SELECT d.*,a.resolution_document_id FROM documents d
        LEFT JOIN amendments a ON a.document_id=d.id WHERE d.id=$1 AND d.deleted_at IS NULL FOR UPDATE OF d`, [documentId]);
      const document = found.rows[0];
      if (!document) throw new AppError({code: 'NOT_FOUND', message: 'Document not found.'});
      if (document.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT',
        message: 'This document changed since it was loaded.', details: {currentRevision: document.revision}});
      if (document.kind === 'AMENDMENT' && supplied.some(key => key !== 'proposerSeatId')) throw new AppError({
        code: 'VALIDATION_FAILED', message: 'This setting is only available for resolutions.'});
      const seat = async (value: unknown, name: string): Promise<string> => {
        const seatId = uuid(value, name);
        const present = await client.query(`SELECT 1 FROM committee_seats s JOIN current_attendance a ON a.seat_id=s.id
          AND a.meeting_session_id=$3 AND a.state='PRESENT' WHERE s.id=$1 AND s.committee_id=$2 AND s.active=true`,
        [seatId, committee.id, document.meeting_session_id]);
        if (!present.rowCount) throw new AppError({code: 'VALIDATION_FAILED', message: `${name} is not present.`});
        return seatId;
      };
      const proposerSeatId = Object.prototype.hasOwnProperty.call(input, 'proposerSeatId')
        ? await seat(input.proposerSeatId, 'Proposer seat') : undefined;
      const seconderSeatId = Object.prototype.hasOwnProperty.call(input, 'seconderSeatId')
        ? input.seconderSeatId === null ? null : await seat(input.seconderSeatId, 'Seconder seat') : undefined;
      if (proposerSeatId && seconderSeatId && proposerSeatId === seconderSeatId) throw new AppError({
        code: 'VALIDATION_FAILED', message: 'The proposer and seconder must be different seats.'});
      if (Object.prototype.hasOwnProperty.call(input, 'delegatesCanAmend') && typeof input.delegatesCanAmend !== 'boolean') {
        throw new AppError({code: 'VALIDATION_FAILED', message: 'The delegate amendment setting is invalid.'});
      }
      const majority = input.majority as ResolutionDirectVoteMajority | undefined;
      if (majority !== undefined && !['SIMPLE_MAJORITY', 'TWO_THIRDS', 'TWO_THIRDS_NON_ABSTAINING'].includes(majority)) {
        throw new AppError({code: 'VALIDATION_FAILED', message: 'The direct-vote majority is invalid.'});
      }
      const now = this.now(); let before: Record<string, unknown>; let after: Record<string, unknown>;
      if (document.kind === 'RESOLUTION') {
        const metadataResult = await client.query<ResolutionRow>('SELECT * FROM resolutions WHERE document_id=$1 FOR UPDATE', [documentId]);
        const metadata = metadataResult.rows[0] as ResolutionRow;
        before = {proposerSeatId: metadata.proposer_seat_id, seconderSeatId: metadata.seconder_seat_id,
          delegatesCanAmend: metadata.delegates_can_amend, majority: metadata.direct_vote_majority};
        after = {proposerSeatId: proposerSeatId ?? metadata.proposer_seat_id,
          seconderSeatId: seconderSeatId === undefined ? metadata.seconder_seat_id : seconderSeatId,
          delegatesCanAmend: input.delegatesCanAmend === undefined ? metadata.delegates_can_amend : input.delegatesCanAmend,
          majority: majority ?? metadata.direct_vote_majority};
        if (after.proposerSeatId === after.seconderSeatId) throw new AppError({code: 'VALIDATION_FAILED',
          message: 'The proposer and seconder must be different seats.'});
        if (JSON.stringify(before) === JSON.stringify(after)) throw new AppError({code: 'RESOURCE_CONFLICT',
          message: 'The document settings are unchanged.'});
        await client.query(`UPDATE resolutions SET proposer_seat_id=$2,seconder_seat_id=$3,delegates_can_amend=$4,
          direct_vote_majority=$5,direct_vote_revision=direct_vote_revision+CASE WHEN direct_vote_majority<>$5 THEN 1 ELSE 0 END
          WHERE document_id=$1`, [documentId, after.proposerSeatId, after.seconderSeatId, after.delegatesCanAmend, after.majority]);
      } else {
        const metadata = await client.query<{proposer_seat_id: string}>('SELECT proposer_seat_id FROM amendments WHERE document_id=$1 FOR UPDATE', [documentId]);
        before = {proposerSeatId: metadata.rows[0]?.proposer_seat_id}; after = {proposerSeatId};
        if (!proposerSeatId || before.proposerSeatId === proposerSeatId) throw new AppError({code: 'RESOURCE_CONFLICT',
          message: 'The document settings are unchanged.'});
        await client.query('UPDATE amendments SET proposer_seat_id=$2 WHERE document_id=$1', [documentId, proposerSeatId]);
      }
      const updated = await client.query<DocumentRow>(`UPDATE documents SET revision=revision+1,updated_at=$2 WHERE id=$1
        RETURNING *,(SELECT resolution_document_id FROM amendments WHERE document_id=$1) AS resolution_document_id`,
      [documentId, now]);
      await client.query(`INSERT INTO resolution_setting_revisions
        (id,committee_id,resolution_document_id,before_value,after_value,actor_user_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), committee.id,
        document.kind === 'RESOLUTION' ? documentId : document.resolution_document_id, before, after, auth.user.id, now]);
      await appendEvent(client, committee, {type: 'document.settings_changed', resourceType: 'document', resourceId: documentId,
        revision: document.revision + 1, payload: {kind: document.kind}, audience: 'MEMBER'});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: 'documents.settings_changed', resourceType: 'document', resourceId: documentId, before, after});
      return documentState(client, updated.rows[0] as DocumentRow);
    });
  }

  async setResolutionDirectVote(auth: AuthenticatedSession, documentId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<ProceedingDocument> {
    requireBusinessIdentity(auth); assertExactBody(input, ['seatId', 'choice']);
    const seatId = uuid(input.seatId, 'Voting seat ID');
    const choice = input.choice === null ? null : input.choice as BallotChoice;
    if (choice !== null && !['FOR', 'AGAINST', 'ABSTAIN'].includes(choice)) throw new AppError({
      code: 'VALIDATION_FAILED', message: 'Vote choice is invalid.'});
    return transaction(this.pool, async client => {
      const located = await client.query<{committee_id: string}>(
        'SELECT committee_id FROM documents WHERE id=$1 AND kind=$2 AND deleted_at IS NULL',
        [documentId, 'RESOLUTION']);
      if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Resolution not found.'});
      const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
      await requireChair(client, committee, auth.user.id);
      const found = await client.query<DocumentRow>(`SELECT d.*,NULL::uuid AS resolution_document_id FROM documents d
        WHERE d.id=$1 AND d.kind='RESOLUTION' AND d.deleted_at IS NULL FOR UPDATE`, [documentId]);
      const document = found.rows[0] as DocumentRow;
      const eligible = await client.query<{display_name: string; must_vote: boolean}>(`SELECT s.display_name,s.must_vote
        FROM committee_seats s JOIN current_attendance a ON a.seat_id=s.id AND a.meeting_session_id=$3 AND a.state='PRESENT'
        WHERE s.id=$1 AND s.committee_id=$2 AND s.active=true AND s.can_vote=true`,
      [seatId, committee.id, document.meeting_session_id]);
      if (!eligible.rows[0]) throw new AppError({code: 'FORBIDDEN', message: 'This seat is not eligible for the resolution vote.'});
      if (choice === 'ABSTAIN' && eligible.rows[0].must_vote) throw new AppError({code: 'VALIDATION_FAILED',
        message: 'This seat must vote for or against.'});
      const vote = await client.query<{id: string; current_choice: BallotChoice; revision: number; retracted_at: Date | null}>(
        `SELECT id,current_choice,revision,retracted_at FROM resolution_direct_votes
          WHERE resolution_document_id=$1 AND seat_id=$2 FOR UPDATE`, [documentId, seatId]);
      const current = vote.rows[0]; const previousChoice = current && !current.retracted_at ? current.current_choice : null;
      if (choice === previousChoice) throw new AppError({code: 'RESOURCE_CONFLICT', message: choice === null
        ? 'This seat has no current vote to retract.' : 'This seat already has that vote.'});
      const now = this.now(); let voteId: string; let voteRevision: number;
      if (!current) {
        if (choice === null) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'This seat has no current vote to retract.'});
        voteId = randomUUID(); voteRevision = 1;
        await client.query(`INSERT INTO resolution_direct_votes
          (id,committee_id,resolution_document_id,seat_id,seat_display_name,current_choice,actor_user_id,on_behalf_of_seat_id,cast_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$4,$8)`, [voteId, committee.id, documentId, seatId,
          eligible.rows[0].display_name, choice, auth.user.id, now]);
      } else if (choice === null) {
        voteId = current.id; voteRevision = current.revision + 1;
        await client.query(`UPDATE resolution_direct_votes SET retracted_at=$2,retracted_by_user_id=$3,
          revision=revision+1 WHERE id=$1`, [voteId, now, auth.user.id]);
      } else {
        voteId = current.id; voteRevision = current.revision + 1;
        await client.query(`UPDATE resolution_direct_votes SET current_choice=$2,actor_user_id=$3,on_behalf_of_seat_id=$4,
          cast_at=$5,retracted_at=NULL,retracted_by_user_id=NULL,revision=revision+1 WHERE id=$1`,
        [voteId, choice, auth.user.id, seatId, now]);
      }
      await client.query(`INSERT INTO resolution_direct_vote_revisions
        (id,committee_id,resolution_document_id,vote_id,seat_id,previous_choice,new_choice,actor_user_id,on_behalf_of_seat_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$5,$9)`, [randomUUID(), committee.id, documentId, voteId, seatId,
        previousChoice, choice, auth.user.id, now]);
      await client.query(`UPDATE resolutions SET direct_vote_started_at=coalesce(direct_vote_started_at,$2)
        WHERE document_id=$1`, [documentId, now]);
      await appendEvent(client, committee, {type: 'document.direct_vote_changed', resourceType: 'document',
        resourceId: documentId, revision: document.revision, payload: {seatId, hasCurrentVote: choice !== null}, audience: 'PUBLIC'});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        onBehalfOfSeatId: seatId, action: 'documents.direct_vote_changed', resourceType: 'document', resourceId: documentId,
        before: {seatId, choice: previousChoice, voteRevision: current?.revision ?? 0},
        after: {seatId, choice, voteRevision}});
      return documentState(client, document);
    });
  }

  async recordDocumentResult(auth: AuthenticatedSession, documentId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<ProceedingDocument> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision', 'outcome', 'reason']);
    const baseRevision = positiveInteger(input.baseRevision, 'Base revision'); const outcome = input.outcome as ProceedingDocumentStatus;
    return transaction(this.pool, async client => {
      const located = await client.query<{committee_id: string}>(
        'SELECT committee_id FROM documents WHERE id=$1 AND deleted_at IS NULL', [documentId]);
      if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Document not found.'});
      const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
      await requireChair(client, committee, auth.user.id);
      const found = await client.query<DocumentRow>(`SELECT d.*,a.resolution_document_id FROM documents d
        LEFT JOIN amendments a ON a.document_id=d.id WHERE d.id=$1 AND d.deleted_at IS NULL FOR UPDATE OF d`, [documentId]);
      const document = found.rows[0] as DocumentRow;
      const allowed = document.kind === 'RESOLUTION' ? ['PASSED', 'FAILED'] : ['INCORPORATED', 'REJECTED'];
      if (!allowed.includes(outcome)) throw new AppError({code: 'VALIDATION_FAILED', message: 'Document result is invalid.'});
      if (document.kind === 'AMENDMENT' && document.status === 'DRAFT') throw new AppError({code: 'RESOURCE_CONFLICT',
        message: 'Introduce the amendment before recording its result.'});
      if (document.kind === 'AMENDMENT' && (document.status === 'VOTING' || document.voting_version_id)) {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Publish the formal ballot result for this amendment.'});
      }
      if (document.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT',
        message: 'This document changed since it was loaded.', details: {currentRevision: document.revision}});
      if (document.status === outcome) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'This result is already recorded.'});
      const terminal = ['PASSED', 'FAILED', 'INCORPORATED', 'REJECTED'].includes(document.status);
      const reason = input.reason === undefined || input.reason === null ? null : text(input.reason, 'Correction reason', 2000);
      if (terminal && !reason) throw new AppError({code: 'VALIDATION_FAILED', message: 'A correction reason is required.'});
      if (!terminal && input.reason !== undefined && input.reason !== null) throw new AppError({code: 'VALIDATION_FAILED',
        message: 'An initial result does not use a correction reason.'});
      const previous = await client.query<{id: string}>(`SELECT id FROM document_result_decisions
        WHERE document_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`, [documentId]);
      const decisionId = randomUUID(); const now = this.now();
      await client.query(`INSERT INTO document_result_decisions
        (id,committee_id,document_id,previous_status,new_status,reason,corrects_decision_id,actor_user_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [decisionId, committee.id, documentId, document.status, outcome,
        reason, terminal ? previous.rows[0]?.id ?? null : null, auth.user.id, now]);
      const updated = await client.query<DocumentRow>(`UPDATE documents SET status=$2::proceeding_document_status,
        is_public=true,revision=revision+1,updated_at=$3
        WHERE id=$1 RETURNING *,(SELECT resolution_document_id FROM amendments WHERE document_id=$1) AS resolution_document_id`,
      [documentId, outcome, now]);
      await appendEvent(client, committee, {type: 'document.result_recorded', resourceType: 'document', resourceId: documentId,
        revision: document.revision + 1, payload: {previousStatus: document.status, outcome, corrected: terminal}, audience: 'PUBLIC'});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: 'documents.result_recorded', resourceType: 'document', resourceId: documentId,
        before: {status: document.status, revision: document.revision},
        after: {status: outcome, revision: document.revision + 1, corrected: terminal, reason}});
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
        const located = await client.query<{committee_id: string}>(
          'SELECT committee_id FROM documents WHERE id=$1 AND deleted_at IS NULL', [documentId]);
        if (!located.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Document not found.'});
        const committee = await lockedCommittee(client, located.rows[0].committee_id); requireProceedingsActive(committee);
        const found = await client.query<DocumentRow>(`SELECT d.*,a.resolution_document_id FROM documents d
          LEFT JOIN amendments a ON a.document_id=d.id WHERE d.id=$1 AND d.deleted_at IS NULL FOR UPDATE OF d`, [documentId]);
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
