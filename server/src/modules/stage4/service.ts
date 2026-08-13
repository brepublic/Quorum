import {createHash, randomUUID} from 'node:crypto';
import type {Pool, PoolClient, QueryResultRow} from 'pg';
import type {
  CommitteeSummary,
  CommitteeTemplate,
  CommitteeTemplateInput,
  CommitteeNote,
  CommitteeTextPost,
  AttendanceEvent,
  AttendanceEventType,
  AttendanceState,
  CommitteePoint,
  CommitteeWorkspaceSnapshot,
  AuthoritativeTimer,
  SpeakerList,
  SpeechRecord,
  ProceedingMotion,
  FrozenRuleEvaluation,
  FormalBallot,
  BallotChoice,
  MeetingSession,
  PointStatus,
  PublicCommitteePoint,
  RollCall,
  RollCallEntry,
  CountryTemplate,
  CountryTemplateInput,
  FlagSnapshot,
  LocalizedNames,
  SeatRank,
  Stage4CommitteeSeat
} from '@quorum/contracts';
import {localizedDisplayName} from '@quorum/contracts';
import {AppError} from '../../http/errors.js';
import type {AuthenticatedSession} from '../identity/store.js';
import {
  appendEvent,
  audit,
  activeSeat,
  idempotentTransaction,
  isChair,
  lockedCommittee,
  requireBusinessIdentity,
  requireChair,
  requireEditable,
  requireProceedingsActive,
  transaction,
  type Stage4CommitteeRow,
  type Stage4Context
} from './database.js';
import {
  assertExactBody,
  validateCommitteeTemplate,
  validateCountryTemplate,
  validateFlag,
  validateLocalizedNames
} from './validation.js';

interface CountryTemplateRow extends QueryResultRow {
  id: string; names: LocalizedNames; default_language: string; country_languages: string[];
  revision: number; created_at: Date; updated_at: Date;
}
interface CountryRow extends QueryResultRow {
  id: string; stable_key: string; names: LocalizedNames; default_language: string; continent: string | null;
  sort_order: number; flag_type: FlagSnapshot['type']; flag_value: string; revision: number;
}
interface CommitteeTemplateRow extends QueryResultRow {
  id: string; names: LocalizedNames; default_language: string; country_template_key: string;
  revision: number; created_at: Date; updated_at: Date;
}
interface TemplateMemberRow extends QueryResultRow {
  id: string; stable_key: string; names: LocalizedNames; default_language: string; rank: SeatRank;
  can_vote: boolean; has_veto: boolean; must_vote: boolean; sort_order: number;
  flag_type: FlagSnapshot['type']; flag_value: string; revision: number;
}

const BUILTIN_COUNTRY_CODES = (`af al dz as ad ao ai aq ag ar am aw au at az bs bh bd bb by be bz bj bm bt bo bq ba bw bv br io bn bg bf bi cv kh cm ca ky cf td cl cn cx cc co km cg cd ck cr ci hr cu cw cy cz dk dj dm do ec eg sv gq er ee sz et fk fo fj fi fr gf pf tf ga gm ge de gh gi gr gl gd gp gu gt gg gn gw gy ht hm va hn hk hu is in id ir iq ie im il it jm jp je jo kz ke ki kp kr kw kg la lv lb ls lr ly li lt lu mo mg mw my mv ml mt mh mq mr mu yt mx fm md mc mn me ms ma mz mm na nr np nl nc nz ni ne ng nu nf mk mp no om pk pw ps pa pg py pe ph pn pl pt pr qa re ro ru rw bl sh kn lc mf pm vc ws sm st sa sn rs sc sl sg sx sk si sb so za gs ss es lk sd sr sj se ch sy tw tj tz th tl tg tk to tt tn tr tm tc tv ug ua ae gb us um uy uz vu ve vn vg vi wf eh ye zm zw eu un`).split(' ');

function builtInCountryName(code: string, language: string): string {
  if (code === 'un') return language === 'zh-CN' ? '联合国' : 'United Nations';
  if (code === 'eu') return language === 'zh-CN' ? '欧洲联盟' : 'European Union';
  try { return new Intl.DisplayNames([language], {type: 'region'}).of(code.toUpperCase()) || code.toUpperCase(); }
  catch { return code.toUpperCase(); }
}

function builtinCountryTemplate(): CountryTemplate {
  return {
    id: 'builtin:default', key: 'builtin:default', builtin: true,
    names: {'zh-CN': '默认国家', en: 'Default countries'}, defaultLanguage: 'zh-CN',
    countryLanguages: ['zh-CN', 'en'], revision: 1, createdAt: null, updatedAt: null,
    countries: BUILTIN_COUNTRY_CODES.map((code, sortOrder) => ({
      id: `builtin:${code}`, stableKey: code,
      names: {'zh-CN': builtInCountryName(code, 'zh-CN'), en: builtInCountryName(code, 'en')},
      defaultLanguage: 'en', continent: null, sortOrder,
      flag: code === 'un' ? {type: 'EMOJI', value: '🇺🇳'} : {type: 'STANDARD', value: code}, revision: 1
    }))
  };
}

function committeeSummary(row: Stage4CommitteeRow): CommitteeSummary {
  return {id: row.id, ownerUserId: row.owner_user_id, name: row.name, chairLabel: row.chair_label,
    topic: row.topic, conference: row.conference, visibility: row.visibility, operationMode: row.operation_mode,
    status: row.status, activeRulePackageVersionId: row.active_rule_package_version_id, revision: row.revision};
}

function flag(type: FlagSnapshot['type'], value: string): FlagSnapshot { return {type, value} as FlagSnapshot; }

function positiveRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Base revision is invalid.'});
  }
  return Number(value);
}

function requiredText(value: unknown, name: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new AppError({code: 'VALIDATION_FAILED', message: `${name} is invalid.`});
  }
  return value.trim();
}

function optionalText(value: unknown, name: string, max: number): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > max) {
    throw new AppError({code: 'VALIDATION_FAILED', message: `${name} is invalid.`});
  }
  return value;
}

function textContent(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Content is invalid.'});
  }
  return value;
}

function sortOrder(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value)) throw new AppError({code: 'VALIDATION_FAILED', message: 'Sort order is invalid.'});
  return Number(value);
}

function contentSummary(content: string): {characterCount: number; sha256: string} {
  return {characterCount: [...content].length, sha256: createHash('sha256').update(content).digest('hex')};
}

async function committeeAccess(client: PoolClient, row: Stage4CommitteeRow, userId: string): Promise<{
  audience: 'OWNER' | 'CHAIR' | 'MEMBER'; capabilities: string[]; seatId: string | null;
}> {
  if (row.owner_user_id === userId) return {audience: 'OWNER', capabilities: ['COMMITTEE_OWNER'], seatId: null};
  if (await isChair(client, row.id, userId)) return {audience: 'CHAIR', capabilities: ['CHAIR'], seatId: null};
  const member = await client.query<{seat_id: string | null}>(`SELECT a.seat_id FROM committee_memberships m
    LEFT JOIN seat_assignments a ON a.committee_id=m.committee_id AND a.user_id=m.user_id AND a.status='ACTIVE'
    WHERE m.committee_id=$1 AND m.user_id=$2 AND m.status='ACTIVE'`, [row.id, userId]);
  if (!member.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Committee not found.'});
  return {audience: 'MEMBER', capabilities: ['MEMBER'], seatId: member.rows[0].seat_id};
}

interface NoteRow extends QueryResultRow {
  id: string; committee_id: string; title: string; content: string; sort_order: number; revision: number;
  created_by_user_id: string; created_at: Date; updated_at: Date; deleted_at: Date | null;
}

interface TextPostRow extends QueryResultRow {
  id: string; committee_id: string; title: string; content: string; sort_order: number; revision: number;
  author_seat_id: string | null; author_display_name: string; actor_user_id: string;
  created_at: Date; updated_at: Date; deleted_at: Date | null;
}

interface MeetingSessionRow extends QueryResultRow {
  id: string; committee_id: string; phase_id: string; active_rule_package_version_id: string;
  status: 'OPEN' | 'CLOSED'; revision: number; created_at: Date; closed_at: Date | null;
}

interface RollCallRow extends QueryResultRow {
  id: string; committee_id: string; meeting_session_id: string; status: 'IN_PROGRESS' | 'COMPLETED' | 'ABANDONED';
  current_seat_id: string | null; rule_package_version_id: string; allowed_responses: string[]; revision: number;
  started_at: Date; completed_at: Date | null;
}

interface RollCallEntryRow extends QueryResultRow {
  id: string; seat_id: string; seat_display_name: string; response: string; actor_user_id: string;
  on_behalf_of_seat_id: string; rule_package_version_id: string; recorded_at: Date; revision: number;
}

interface PointRow extends QueryResultRow {
  id: string; committee_id: string; meeting_session_id: string; point_type_id: string; content: string;
  raised_by_seat_id: string; raised_by_seat_display_name: string; actor_user_id: string; on_behalf_of_seat_id: string;
  interrupt_requested: boolean; status: PointStatus; chair_response: string; resolved_by_user_id: string | null;
  rule_package_version_id: string; revision: number; created_at: Date; resolved_at: Date | null;
}

interface SnapshotTimerRow extends QueryResultRow {
  id: string; committee_id: string; owner_type: AuthoritativeTimer['ownerType']; owner_id: string; running: boolean;
  started_at: Date | null; remaining_at_start_ms: string | number; revision: number; expired_at: Date | null;
}

interface SnapshotSpeakerListRow extends QueryResultRow {
  id: string; committee_id: string; meeting_session_id: string; kind: SpeakerList['kind']; status: SpeakerList['status'];
  topic: string; default_speech_ms: string | number; rule_package_version_id: string; current_entry_id: string | null;
  speech_timer_id: string; total_timer_id: string | null; revision: number; created_at: Date; closed_at: Date | null;
}

interface SnapshotSpeechRow extends QueryResultRow {
  id: string; speaker_list_id: string; queue_entry_id: string; seat_id: string; seat_display_name: string;
  kind: SpeechRecord['kind']; status: SpeechRecord['status']; inherited_from_speech_id: string | null;
  inherited_time_ms: string | number | null; can_yield: boolean; yield_type: SpeechRecord['yieldType'];
  yield_target_seat_id: string | null; revision: number; started_at: Date | null; ended_at: Date | null;
}

interface SnapshotMotionRow extends QueryResultRow {
  id: string; committee_id: string; meeting_session_id: string; motion_type_id: string; proposed_by_seat_id: string;
  proposed_by_seat_display_name: string; parameters: Record<string, unknown>; status: ProceedingMotion['status'];
  rule_package_version_id: string; rule_evaluation: FrozenRuleEvaluation; required_second_count: number;
  revision: number; created_at: Date; decided_at: Date | null;
}

interface SnapshotBallotRow extends QueryResultRow {
  id: string; committee_id: string; meeting_session_id: string; subject_type: FormalBallot['subjectType']; subject_id: string;
  status: FormalBallot['status']; procedural: boolean; choices: BallotChoice[]; rule_package_version_id: string;
  rule_evaluation: FrozenRuleEvaluation; eligibility_snapshot: FormalBallot['eligibility'];
  threshold_definition: FormalBallot['threshold']; result: FormalBallot['result']; revision: number;
  opened_at: Date; closed_at: Date | null; published_at: Date | null;
}

async function snapshotSpeeches(client: PoolClient, listId: string): Promise<SpeechRecord[]> {
  const rows = await client.query<SnapshotSpeechRow>('SELECT * FROM speeches WHERE speaker_list_id=$1 ORDER BY created_at,id', [listId]);
  return Promise.all(rows.rows.map(async row => {
    const [actions, contributions] = await Promise.all([
      client.query<{id: string; action: SpeechRecord['actions'][number]['action']; remaining_ms: string | number;
        target_type: SpeechRecord['yieldType']; target_seat_id: string | null; created_at: Date}>(`SELECT id,action,remaining_ms,
        target_type,target_seat_id,created_at FROM speech_actions WHERE speech_id=$1 ORDER BY created_at,id`, [row.id]),
      client.query<{id: string; type: 'QUESTION' | 'COMMENT'; seat_id: string; seat_display_name: string; content: string;
        created_at: Date}>(`SELECT id,type,seat_id,seat_display_name,content,created_at FROM speech_contributions
        WHERE speech_id=$1 ORDER BY created_at,id`, [row.id])
    ]);
    return {id: row.id, speakerListId: row.speaker_list_id, queueEntryId: row.queue_entry_id, seatId: row.seat_id,
      seatDisplayName: row.seat_display_name, kind: row.kind, status: row.status,
      inheritedFromSpeechId: row.inherited_from_speech_id,
      inheritedTimeMs: row.inherited_time_ms === null ? null : Number(row.inherited_time_ms), canYield: row.can_yield,
      yieldType: row.yield_type, yieldTargetSeatId: row.yield_target_seat_id, revision: row.revision,
      startedAt: row.started_at?.toISOString() ?? null, endedAt: row.ended_at?.toISOString() ?? null,
      actions: actions.rows.map(action => ({id: action.id, action: action.action, remainingMs: Number(action.remaining_ms),
        targetType: action.target_type, targetSeatId: action.target_seat_id, createdAt: action.created_at.toISOString()})),
      contributions: contributions.rows.map(item => ({id: item.id, type: item.type, seatId: item.seat_id,
        seatDisplayName: item.seat_display_name, content: item.content, createdAt: item.created_at.toISOString()}))};
  }));
}

function note(row: NoteRow): CommitteeNote {
  return {id: row.id, title: row.title, content: row.content, sortOrder: row.sort_order, revision: row.revision,
    createdByUserId: row.created_by_user_id, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    deletedAt: row.deleted_at?.toISOString() ?? null};
}

function textPost(row: TextPostRow): CommitteeTextPost {
  return {id: row.id, title: row.title, content: row.content, sortOrder: row.sort_order, revision: row.revision,
    authorSeatId: row.author_seat_id, authorDisplayName: row.author_display_name, actorUserId: row.actor_user_id,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    deletedAt: row.deleted_at?.toISOString() ?? null};
}

function meetingSession(row: MeetingSessionRow): MeetingSession {
  return {id: row.id, committeeId: row.committee_id, phaseId: row.phase_id,
    activeRulePackageVersionId: row.active_rule_package_version_id, status: row.status, revision: row.revision,
    createdAt: row.created_at.toISOString(), closedAt: row.closed_at?.toISOString() ?? null};
}

function rollCallEntry(row: RollCallEntryRow): RollCallEntry {
  return {id: row.id, seatId: row.seat_id, seatDisplayName: row.seat_display_name, response: row.response,
    actorUserId: row.actor_user_id, onBehalfOfSeatId: row.on_behalf_of_seat_id,
    rulePackageVersionId: row.rule_package_version_id, recordedAt: row.recorded_at.toISOString(), revision: row.revision};
}

async function rollCall(client: PoolClient, row: RollCallRow): Promise<RollCall> {
  const entries = await client.query<RollCallEntryRow>(`SELECT * FROM roll_call_entries
    WHERE roll_call_id=$1 AND undone_at IS NULL ORDER BY recorded_at,id`, [row.id]);
  return {id: row.id, committeeId: row.committee_id, meetingSessionId: row.meeting_session_id, status: row.status,
    currentSeatId: row.current_seat_id, rulePackageVersionId: row.rule_package_version_id,
    allowedResponses: row.allowed_responses, entries: entries.rows.map(rollCallEntry), revision: row.revision,
    startedAt: row.started_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null};
}

async function insertAttendanceEvent(client: PoolClient, input: {
  committeeId: string; meetingSessionId: string; seatId: string; seatDisplayName: string; type: AttendanceEventType;
  actorUserId: string; sourceRollCallEntryId?: string; sourcePointId?: string;
}): Promise<AttendanceEvent> {
  const state = input.type === 'TEMPORARILY_LEFT' ? 'TEMPORARILY_LEFT'
    : input.type === 'ABSENT' ? 'ABSENT' : 'PRESENT';
  const id = randomUUID();
  const inserted = await client.query<{created_at: Date}>(`INSERT INTO attendance_events
    (id,committee_id,meeting_session_id,seat_id,seat_display_name,type,actor_user_id,on_behalf_of_seat_id,
     source_roll_call_entry_id,source_point_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$4,$8,$9) RETURNING created_at`,
  [id, input.committeeId, input.meetingSessionId, input.seatId, input.seatDisplayName, input.type,
    input.actorUserId, input.sourceRollCallEntryId ?? null, input.sourcePointId ?? null]);
  const createdAt = inserted.rows[0]?.created_at as Date;
  await client.query(`INSERT INTO current_attendance
    (committee_id,meeting_session_id,seat_id,state,last_event_id,updated_at) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (meeting_session_id,seat_id) DO UPDATE SET state=EXCLUDED.state,last_event_id=EXCLUDED.last_event_id,
      updated_at=EXCLUDED.updated_at`, [input.committeeId, input.meetingSessionId, input.seatId, state, id, createdAt]);
  return {id, committeeId: input.committeeId, meetingSessionId: input.meetingSessionId, seatId: input.seatId,
    seatDisplayName: input.seatDisplayName, type: input.type, actorUserId: input.actorUserId,
    onBehalfOfSeatId: input.seatId, sourceRollCallEntryId: input.sourceRollCallEntryId ?? null,
    sourcePointId: input.sourcePointId ?? null, createdAt: createdAt.toISOString()};
}

function point(row: PointRow): CommitteePoint {
  return {id: row.id, committeeId: row.committee_id, meetingSessionId: row.meeting_session_id,
    pointTypeId: row.point_type_id, content: row.content, raisedBySeatId: row.raised_by_seat_id,
    raisedBySeatDisplayName: row.raised_by_seat_display_name, actorUserId: row.actor_user_id,
    onBehalfOfSeatId: row.on_behalf_of_seat_id, interruptRequested: row.interrupt_requested, status: row.status,
    chairResponse: row.chair_response, resolvedByUserId: row.resolved_by_user_id,
    rulePackageVersionId: row.rule_package_version_id, revision: row.revision,
    createdAt: row.created_at.toISOString(), resolvedAt: row.resolved_at?.toISOString() ?? null};
}

async function countryTemplateById(client: PoolClient, ownerId: string, id: string, lock = false): Promise<CountryTemplateRow> {
  const result = await client.query<CountryTemplateRow>(`SELECT * FROM country_templates
    WHERE id=$1 AND owner_user_id=$2${lock ? ' FOR UPDATE' : ''}`, [id, ownerId]);
  if (!result.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Country template not found.'});
  return result.rows[0];
}

async function committeeTemplateById(client: PoolClient, ownerId: string, id: string, lock = false): Promise<CommitteeTemplateRow> {
  const result = await client.query<CommitteeTemplateRow>(`SELECT * FROM committee_templates
    WHERE id=$1 AND owner_user_id=$2${lock ? ' FOR UPDATE' : ''}`, [id, ownerId]);
  if (!result.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Committee template not found.'});
  return result.rows[0];
}

async function countryTemplate(client: PoolClient, row: CountryTemplateRow): Promise<CountryTemplate> {
  const countries = await client.query<CountryRow>(`SELECT * FROM country_template_countries
    WHERE country_template_id=$1 ORDER BY sort_order,stable_key`, [row.id]);
  return {id: row.id, key: `custom:${row.id}`, builtin: false, names: row.names, defaultLanguage: row.default_language,
    countryLanguages: row.country_languages, revision: row.revision, createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(), countries: countries.rows.map(item => ({
      id: item.id, stableKey: item.stable_key, names: item.names, defaultLanguage: item.default_language,
      continent: item.continent, sortOrder: item.sort_order, flag: flag(item.flag_type, item.flag_value), revision: item.revision
    }))};
}

async function committeeTemplate(client: PoolClient, row: CommitteeTemplateRow): Promise<CommitteeTemplate> {
  const members = await client.query<TemplateMemberRow>(`SELECT * FROM committee_template_members
    WHERE committee_template_id=$1 ORDER BY sort_order,stable_key`, [row.id]);
  return {id: row.id, names: row.names, defaultLanguage: row.default_language,
    countryTemplateKey: row.country_template_key, revision: row.revision,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    members: members.rows.map(item => ({id: item.id, stableKey: item.stable_key, names: item.names,
      defaultLanguage: item.default_language, rank: item.rank, canVote: item.can_vote, hasVeto: item.has_veto,
      mustVote: item.must_vote, sortOrder: item.sort_order, flag: flag(item.flag_type, item.flag_value), revision: item.revision}))};
}

async function resolveCountryTemplateReference(client: PoolClient, ownerId: string, key: string): Promise<string | null> {
  if (key === 'builtin:default') return null;
  const match = /^custom:([0-9a-f-]{36})$/.exec(key);
  if (!match) throw new AppError({code: 'VALIDATION_FAILED', message: 'Country template key is invalid.'});
  await countryTemplateById(client, ownerId, match[1] as string);
  return match[1] as string;
}

async function replaceCountries(client: PoolClient, templateId: string, value: CountryTemplateInput): Promise<void> {
  await client.query('DELETE FROM country_template_countries WHERE country_template_id=$1', [templateId]);
  for (const country of value.countries) {
    await client.query(`INSERT INTO country_template_countries
      (id,country_template_id,stable_key,names,default_language,continent,sort_order,flag_type,flag_value)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [randomUUID(), templateId, country.stableKey, country.names, country.defaultLanguage, country.continent ?? null,
      country.sortOrder, country.flag.type, country.flag.value]);
  }
}

async function replaceMembers(client: PoolClient, templateId: string, value: CommitteeTemplateInput): Promise<void> {
  await client.query('DELETE FROM committee_template_members WHERE committee_template_id=$1', [templateId]);
  for (const member of value.members) {
    await client.query(`INSERT INTO committee_template_members
      (id,committee_template_id,stable_key,names,default_language,rank,can_vote,has_veto,must_vote,sort_order,flag_type,flag_value)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [randomUUID(), templateId, member.stableKey, member.names, member.defaultLanguage, member.rank,
      member.canVote, member.hasVeto, member.mustVote, member.sortOrder, member.flag.type, member.flag.value]);
  }
}

export class Stage4Service {
  constructor(private readonly pool: Pool) {}

  async listCountryTemplates(auth: AuthenticatedSession): Promise<CountryTemplate[]> {
    requireBusinessIdentity(auth);
    const client = await this.pool.connect();
    try {
      const rows = await client.query<CountryTemplateRow>('SELECT * FROM country_templates WHERE owner_user_id=$1 ORDER BY created_at,id', [auth.user.id]);
      return [builtinCountryTemplate(), ...await Promise.all(rows.rows.map(row => countryTemplate(client, row)))];
    } finally { client.release(); }
  }

  async getCountryTemplate(auth: AuthenticatedSession, id: string): Promise<CountryTemplate> {
    requireBusinessIdentity(auth);
    if (id === 'builtin:default') return builtinCountryTemplate();
    const client = await this.pool.connect();
    try { return countryTemplate(client, await countryTemplateById(client, auth.user.id, id)); }
    finally { client.release(); }
  }

  async createCountryTemplate(auth: AuthenticatedSession, input: unknown, idempotencyKey: string, context: Stage4Context): Promise<CountryTemplate> {
    requireBusinessIdentity(auth);
    const value = validateCountryTemplate(input);
    return idempotentTransaction({pool: this.pool, auth, route: 'POST /api/v1/country-templates', key: idempotencyKey,
      request: value, status: 201, work: async client => {
        const id = randomUUID();
        const inserted = await client.query<CountryTemplateRow>(`INSERT INTO country_templates
          (id,owner_user_id,names,default_language,country_languages) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [id, auth.user.id, value.names, value.defaultLanguage, value.countryLanguages]);
        await replaceCountries(client, id, value);
        await audit(client, context, {actorUserId: auth.user.id, capabilities: ['ACCOUNT_OWNER'],
          action: 'templates.country_created', resourceType: 'country_template', resourceId: id,
          after: {countryCount: value.countries.length}});
        return countryTemplate(client, inserted.rows[0] as CountryTemplateRow);
      }});
  }

  async updateCountryTemplate(auth: AuthenticatedSession, id: string, input: Record<string, unknown>, context: Stage4Context): Promise<CountryTemplate> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision', 'template']);
    const revision = positiveRevision(input.baseRevision); const value = validateCountryTemplate(input.template);
    return transaction(this.pool, async client => {
      const current = await countryTemplateById(client, auth.user.id, id, true);
      if (current.revision !== revision) throw new AppError({code: 'REVISION_CONFLICT', message: 'This template changed since it was loaded.',
        details: {currentRevision: current.revision}});
      const updated = await client.query<CountryTemplateRow>(`UPDATE country_templates SET names=$2,default_language=$3,
        country_languages=$4,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`,
      [id, value.names, value.defaultLanguage, value.countryLanguages]);
      await replaceCountries(client, id, value);
      await audit(client, context, {actorUserId: auth.user.id, capabilities: ['ACCOUNT_OWNER'],
        action: 'templates.country_updated', resourceType: 'country_template', resourceId: id,
        before: {revision: current.revision}, after: {revision: current.revision + 1, countryCount: value.countries.length}});
      return countryTemplate(client, updated.rows[0] as CountryTemplateRow);
    });
  }

  async cloneCountryTemplate(auth: AuthenticatedSession, id: string, input: Record<string, unknown>,
    idempotencyKey: string, context: Stage4Context): Promise<CountryTemplate> {
    requireBusinessIdentity(auth); assertExactBody(input, ['names', 'defaultLanguage']);
    const source = await this.getCountryTemplate(auth, id);
    const localized = input.names === undefined && input.defaultLanguage === undefined
      ? {names: source.names, defaultLanguage: source.defaultLanguage}
      : validateLocalizedNames(input.names, input.defaultLanguage);
    const value: CountryTemplateInput = {names: localized.names, defaultLanguage: localized.defaultLanguage,
      countryLanguages: source.countryLanguages, countries: source.countries.map(item => ({stableKey: item.stableKey,
        names: item.names, defaultLanguage: item.defaultLanguage, continent: item.continent,
        sortOrder: item.sortOrder, flag: item.flag}))};
    return idempotentTransaction({pool: this.pool, auth, route: `POST /api/v1/country-templates/${id}/clone`,
      key: idempotencyKey, request: input, status: 201, work: async client => {
        const cloneId = randomUUID();
        const inserted = await client.query<CountryTemplateRow>(`INSERT INTO country_templates
          (id,owner_user_id,names,default_language,country_languages) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [cloneId, auth.user.id, value.names, value.defaultLanguage, value.countryLanguages]);
        await replaceCountries(client, cloneId, value);
        await audit(client, context, {actorUserId: auth.user.id, capabilities: ['ACCOUNT_OWNER'],
          action: 'templates.country_cloned', resourceType: 'country_template', resourceId: cloneId,
          after: {sourceTemplateId: id, countryCount: value.countries.length}});
        return countryTemplate(client, inserted.rows[0] as CountryTemplateRow);
      }});
  }

  async deleteCountryTemplate(auth: AuthenticatedSession, id: string, context: Stage4Context): Promise<void> {
    requireBusinessIdentity(auth);
    if (id === 'builtin:default') throw new AppError({code: 'FORBIDDEN', message: 'Built-in templates cannot be deleted.'});
    await transaction(this.pool, async client => {
      const current = await countryTemplateById(client, auth.user.id, id, true);
      const used = await client.query<{id: string; names: LocalizedNames; default_language: string}>(`SELECT id,names,default_language
        FROM committee_templates WHERE owner_user_id=$1 AND country_template_id=$2 ORDER BY created_at,id`, [auth.user.id, id]);
      if (used.rowCount) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'This country template is still in use.',
        details: {templates: used.rows.map(item => ({id: item.id, name: localizedDisplayName(item.names, item.default_language, item.default_language)}))}});
      await client.query('DELETE FROM country_template_countries WHERE country_template_id=$1', [id]);
      await client.query('DELETE FROM country_templates WHERE id=$1', [id]);
      await audit(client, context, {actorUserId: auth.user.id, capabilities: ['ACCOUNT_OWNER'],
        action: 'templates.country_deleted', resourceType: 'country_template', resourceId: id,
        before: {revision: current.revision}});
    });
  }

  async listCommitteeTemplates(auth: AuthenticatedSession): Promise<CommitteeTemplate[]> {
    requireBusinessIdentity(auth); const client = await this.pool.connect();
    try {
      const rows = await client.query<CommitteeTemplateRow>('SELECT * FROM committee_templates WHERE owner_user_id=$1 ORDER BY created_at,id', [auth.user.id]);
      return Promise.all(rows.rows.map(row => committeeTemplate(client, row)));
    } finally { client.release(); }
  }

  async getCommitteeTemplate(auth: AuthenticatedSession, id: string): Promise<CommitteeTemplate> {
    requireBusinessIdentity(auth); const client = await this.pool.connect();
    try { return committeeTemplate(client, await committeeTemplateById(client, auth.user.id, id)); }
    finally { client.release(); }
  }

  async createCommitteeTemplate(auth: AuthenticatedSession, input: unknown, idempotencyKey: string,
    context: Stage4Context): Promise<CommitteeTemplate> {
    requireBusinessIdentity(auth); const value = validateCommitteeTemplate(input);
    return idempotentTransaction({pool: this.pool, auth, route: 'POST /api/v1/committee-templates', key: idempotencyKey,
      request: value, status: 201, work: async client => {
        const countryTemplateId = await resolveCountryTemplateReference(client, auth.user.id, value.countryTemplateKey);
        const id = randomUUID();
        const inserted = await client.query<CommitteeTemplateRow>(`INSERT INTO committee_templates
          (id,owner_user_id,names,default_language,country_template_key,country_template_id)
          VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, auth.user.id, value.names, value.defaultLanguage, value.countryTemplateKey, countryTemplateId]);
        await replaceMembers(client, id, value);
        await audit(client, context, {actorUserId: auth.user.id, capabilities: ['ACCOUNT_OWNER'],
          action: 'templates.committee_created', resourceType: 'committee_template', resourceId: id,
          after: {countryTemplateKey: value.countryTemplateKey, memberCount: value.members.length}});
        return committeeTemplate(client, inserted.rows[0] as CommitteeTemplateRow);
      }});
  }

  async updateCommitteeTemplate(auth: AuthenticatedSession, id: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<CommitteeTemplate> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision', 'template']);
    const baseRevision = positiveRevision(input.baseRevision); const value = validateCommitteeTemplate(input.template);
    return transaction(this.pool, async client => {
      const current = await committeeTemplateById(client, auth.user.id, id, true);
      if (current.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT',
        message: 'This template changed since it was loaded.', details: {currentRevision: current.revision}});
      const countryTemplateId = await resolveCountryTemplateReference(client, auth.user.id, value.countryTemplateKey);
      const updated = await client.query<CommitteeTemplateRow>(`UPDATE committee_templates SET names=$2,default_language=$3,
        country_template_key=$4,country_template_id=$5,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`,
      [id, value.names, value.defaultLanguage, value.countryTemplateKey, countryTemplateId]);
      await replaceMembers(client, id, value);
      await audit(client, context, {actorUserId: auth.user.id, capabilities: ['ACCOUNT_OWNER'],
        action: 'templates.committee_updated', resourceType: 'committee_template', resourceId: id,
        before: {revision: current.revision}, after: {revision: current.revision + 1,
          countryTemplateKey: value.countryTemplateKey, memberCount: value.members.length}});
      return committeeTemplate(client, updated.rows[0] as CommitteeTemplateRow);
    });
  }

  async cloneCommitteeTemplate(auth: AuthenticatedSession, id: string, input: Record<string, unknown>,
    idempotencyKey: string, context: Stage4Context): Promise<CommitteeTemplate> {
    requireBusinessIdentity(auth); assertExactBody(input, ['names', 'defaultLanguage']);
    const source = await this.getCommitteeTemplate(auth, id);
    const localized = input.names === undefined && input.defaultLanguage === undefined
      ? {names: source.names, defaultLanguage: source.defaultLanguage}
      : validateLocalizedNames(input.names, input.defaultLanguage);
    const value: CommitteeTemplateInput = {names: localized.names, defaultLanguage: localized.defaultLanguage,
      countryTemplateKey: source.countryTemplateKey, members: source.members.map(item => ({stableKey: item.stableKey,
        names: item.names, defaultLanguage: item.defaultLanguage, rank: item.rank, canVote: item.canVote,
        hasVeto: item.hasVeto, mustVote: item.mustVote, sortOrder: item.sortOrder, flag: item.flag}))};
    return idempotentTransaction({pool: this.pool, auth, route: `POST /api/v1/committee-templates/${id}/clone`,
      key: idempotencyKey, request: input, status: 201, work: async client => {
        const countryTemplateId = await resolveCountryTemplateReference(client, auth.user.id, value.countryTemplateKey);
        const cloneId = randomUUID();
        const inserted = await client.query<CommitteeTemplateRow>(`INSERT INTO committee_templates
          (id,owner_user_id,names,default_language,country_template_key,country_template_id)
          VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [cloneId, auth.user.id, value.names, value.defaultLanguage, value.countryTemplateKey, countryTemplateId]);
        await replaceMembers(client, cloneId, value);
        await audit(client, context, {actorUserId: auth.user.id, capabilities: ['ACCOUNT_OWNER'],
          action: 'templates.committee_cloned', resourceType: 'committee_template', resourceId: cloneId,
          after: {sourceTemplateId: id, memberCount: value.members.length}});
        return committeeTemplate(client, inserted.rows[0] as CommitteeTemplateRow);
      }});
  }

  async deleteCommitteeTemplate(auth: AuthenticatedSession, id: string, context: Stage4Context): Promise<void> {
    requireBusinessIdentity(auth);
    await transaction(this.pool, async client => {
      const current = await committeeTemplateById(client, auth.user.id, id, true);
      await client.query('DELETE FROM committee_template_members WHERE committee_template_id=$1', [id]);
      await client.query('DELETE FROM committee_templates WHERE id=$1', [id]);
      await audit(client, context, {actorUserId: auth.user.id, capabilities: ['ACCOUNT_OWNER'],
        action: 'templates.committee_deleted', resourceType: 'committee_template', resourceId: id,
        before: {revision: current.revision}});
    });
  }

  async listCommittees(auth: AuthenticatedSession): Promise<CommitteeSummary[]> {
    requireBusinessIdentity(auth);
    const result = await this.pool.query<Stage4CommitteeRow>(`SELECT DISTINCT c.* FROM committees c
      LEFT JOIN committee_memberships m ON m.committee_id=c.id AND m.user_id=$1 AND m.status='ACTIVE'
      LEFT JOIN committee_capabilities p ON p.committee_id=c.id AND p.user_id=$1 AND p.capability='CHAIR' AND p.revoked_at IS NULL
      WHERE c.status<>'DELETING' AND (c.owner_user_id=$1 OR m.user_id IS NOT NULL OR p.user_id IS NOT NULL)
      ORDER BY c.updated_at DESC,c.id`, [auth.user.id]);
    return result.rows.map(committeeSummary);
  }

  async snapshot(committeeId: string, auth?: AuthenticatedSession): Promise<CommitteeWorkspaceSnapshot> {
    if (auth) requireBusinessIdentity(auth);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const found = await client.query<Stage4CommitteeRow>('SELECT * FROM committees WHERE id=$1', [committeeId]);
      const committee = found.rows[0];
      if (!committee || committee.status === 'DELETING') throw new AppError({code: 'NOT_FOUND', message: 'Committee not found.'});
      let viewer: CommitteeWorkspaceSnapshot['viewer'] = {audience: 'PUBLIC', seatId: null};
      if (auth?.user.id === committee.owner_user_id) viewer = {audience: 'OWNER', seatId: await activeSeat(client, committeeId, auth.user.id)};
      else if (auth && await isChair(client, committeeId, auth.user.id)) {
        viewer = {audience: 'CHAIR', seatId: await activeSeat(client, committeeId, auth.user.id)};
      } else if (auth) {
        const member = await client.query<{seat_id: string | null}>(`SELECT a.seat_id FROM committee_memberships m
          LEFT JOIN seat_assignments a ON a.committee_id=m.committee_id AND a.user_id=m.user_id AND a.status='ACTIVE'
          WHERE m.committee_id=$1 AND m.user_id=$2 AND m.status='ACTIVE'`, [committeeId, auth.user.id]);
        if (member.rows[0]) viewer = {audience: 'MEMBER', seatId: member.rows[0].seat_id};
      }
      if (viewer.audience === 'PUBLIC' && committee.visibility === 'PRIVATE') {
        throw new AppError({code: 'NOT_FOUND', message: 'Committee not found.'});
      }
      const seats = await client.query<Stage4CommitteeSeat>(`SELECT id,stable_key AS "stableKey",display_name AS "displayName",rank,
        can_vote AS "canVote",has_veto AS "hasVeto",must_vote AS "mustVote",sort_order AS "sortOrder",active,revision,
        json_build_object('type',flag_type,'value',flag_value) AS flag FROM committee_seats
        WHERE committee_id=$1 AND active=true ORDER BY sort_order,stable_key,id`, [committeeId]);
      const sessionResult = await client.query<MeetingSessionRow>(`SELECT * FROM meeting_sessions WHERE committee_id=$1
        ORDER BY (status='OPEN') DESC,created_at DESC,id DESC LIMIT 1`, [committeeId]);
      const currentSession = sessionResult.rows[0];
      let currentRollCall: RollCall | undefined; let attendance: AttendanceState[] = [];
      let points: Array<CommitteePoint | PublicCommitteePoint> = [];
      if (currentSession) {
        if (viewer.audience !== 'PUBLIC') {
          const rollCallResult = await client.query<RollCallRow>(`SELECT * FROM roll_calls WHERE meeting_session_id=$1
            ORDER BY (status='IN_PROGRESS') DESC,started_at DESC,id DESC LIMIT 1`, [currentSession.id]);
          if (rollCallResult.rows[0]) currentRollCall = await rollCall(client, rollCallResult.rows[0]);
        }
        const attendanceResult = await client.query<{seat_id: string; state: AttendanceState['state']; last_event_id: string; updated_at: Date}>(
          `SELECT seat_id,state,last_event_id,updated_at FROM current_attendance WHERE meeting_session_id=$1 ORDER BY seat_id`, [currentSession.id]);
        attendance = attendanceResult.rows.map(row => ({seatId: row.seat_id, state: row.state,
          lastEventId: row.last_event_id, updatedAt: row.updated_at.toISOString()}));
        const pointRows = await client.query<PointRow>(`SELECT * FROM points WHERE meeting_session_id=$1 ORDER BY created_at,id`, [currentSession.id]);
        points = viewer.audience === 'PUBLIC' ? pointRows.rows.map(row => ({id: row.id, committeeId: row.committee_id,
          meetingSessionId: row.meeting_session_id, pointTypeId: row.point_type_id, raisedBySeatId: row.raised_by_seat_id,
          raisedBySeatDisplayName: row.raised_by_seat_display_name, interruptRequested: row.interrupt_requested,
          status: row.status, rulePackageVersionId: row.rule_package_version_id, revision: row.revision,
          createdAt: row.created_at.toISOString(), resolvedAt: row.resolved_at?.toISOString() ?? null})) : pointRows.rows.map(point);
      }
      const summary = committeeSummary(committee); const {ownerUserId: _ownerUserId, ...publicCommittee} = summary;
      const result: CommitteeWorkspaceSnapshot = {schemaVersion: 2,
        committee: viewer.audience === 'OWNER' || viewer.audience === 'CHAIR' ? summary : publicCommittee,
        seats: seats.rows, viewer, attendance, points, notes: [], textPosts: [],
        sync: {committeeEventSequence: Number(committee.next_event_sequence) - 1},
        ...(currentSession ? {meetingSession: meetingSession(currentSession)} : {}),
        ...(currentRollCall ? {rollCall: currentRollCall} : {})};
      const speakerRows = await client.query<SnapshotSpeakerListRow>(`SELECT * FROM speaker_lists
        WHERE committee_id=$1 ORDER BY created_at,id`, [committeeId]);
      result.speakerLists = await Promise.all(speakerRows.rows.map(async row => {
        const queue = await client.query<{id: string; seat_id: string; seat_display_name: string; position: number;
          status: SpeakerList['queue'][number]['status']; created_at: Date}>(`SELECT id,seat_id,seat_display_name,position,status,created_at
          FROM speaker_queue_entries WHERE speaker_list_id=$1 ORDER BY position,created_at,id`, [row.id]);
        return {id: row.id, committeeId: row.committee_id, meetingSessionId: row.meeting_session_id, kind: row.kind,
          status: row.status, topic: row.topic, defaultSpeechMs: Number(row.default_speech_ms),
          rulePackageVersionId: row.rule_package_version_id, currentEntryId: row.current_entry_id,
          speechTimerId: row.speech_timer_id, totalTimerId: row.total_timer_id, revision: row.revision,
          queue: queue.rows.map(entry => ({id: entry.id, seatId: entry.seat_id, seatDisplayName: entry.seat_display_name,
            position: entry.position, status: entry.status, createdAt: entry.created_at.toISOString()})),
          createdAt: row.created_at.toISOString(), closedAt: row.closed_at?.toISOString() ?? null,
          speeches: await snapshotSpeeches(client, row.id)};
      }));
      const motionRows = await client.query<SnapshotMotionRow>('SELECT * FROM motions WHERE committee_id=$1 ORDER BY created_at,id', [committeeId]);
      result.motions = await Promise.all(motionRows.rows.map(async row => {
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
      }));
      const ballotRows = await client.query<SnapshotBallotRow>('SELECT * FROM ballots WHERE committee_id=$1 ORDER BY opened_at,id', [committeeId]);
      result.ballots = await Promise.all(ballotRows.rows.map(async row => {
        const revealVotes = viewer.audience === 'CHAIR' || viewer.audience === 'OWNER' || row.status === 'PUBLISHED';
        const votes = revealVotes ? await client.query<{id: string; seat_id: string; seat_display_name: string;
          current_choice: BallotChoice; revision: number; cast_at: Date}>(`SELECT id,seat_id,seat_display_name,current_choice,
          revision,cast_at FROM ballot_votes WHERE ballot_id=$1 ORDER BY seat_id`, [row.id]) : {rows: []};
        return {id: row.id, committeeId: row.committee_id, meetingSessionId: row.meeting_session_id,
          subjectType: row.subject_type, subjectId: row.subject_id, status: row.status, procedural: row.procedural,
          choices: row.choices, rulePackageVersionId: row.rule_package_version_id, ruleEvaluation: row.rule_evaluation,
          eligibility: viewer.audience === 'PUBLIC' ? [] : row.eligibility_snapshot, threshold: row.threshold_definition,
          votes: votes.rows.map(vote => ({id: vote.id, seatId: vote.seat_id, seatDisplayName: vote.seat_display_name,
            choice: vote.current_choice, revision: vote.revision, castAt: vote.cast_at.toISOString()})),
          result: row.status === 'PUBLISHED' ? row.result : null, revision: row.revision,
          openedAt: row.opened_at.toISOString(), closedAt: row.closed_at?.toISOString() ?? null,
          publishedAt: row.published_at?.toISOString() ?? null};
      }));
      if (viewer.audience !== 'PUBLIC') {
        const [notes, posts, timers] = await Promise.all([
          client.query<NoteRow>(`SELECT * FROM committee_notes WHERE committee_id=$1 AND deleted_at IS NULL ORDER BY sort_order,created_at,id`, [committeeId]),
          client.query<TextPostRow>(`SELECT * FROM committee_text_posts WHERE committee_id=$1 AND deleted_at IS NULL ORDER BY sort_order,created_at,id`, [committeeId]),
          client.query<SnapshotTimerRow>(`SELECT * FROM timer_states WHERE committee_id=$1 ORDER BY created_at,id`, [committeeId])
        ]);
        result.notes = notes.rows.map(note); result.textPosts = posts.rows.map(textPost);
        const serverTime = new Date();
        result.timers = timers.rows.map(row => { const remaining = row.running && row.started_at
          ? Math.max(0, Number(row.remaining_at_start_ms) - Math.max(0, serverTime.getTime() - row.started_at.getTime()))
          : Number(row.remaining_at_start_ms);
        return {id: row.id, committeeId: row.committee_id, ownerType: row.owner_type, ownerId: row.owner_id,
          running: row.running && remaining > 0, startedAt: row.started_at?.toISOString() ?? null,
          remainingAtStartMs: Number(row.remaining_at_start_ms), remainingMs: remaining, revision: row.revision,
          expiredAt: row.expired_at?.toISOString() ?? null, serverTime: serverTime.toISOString()}; });
      }
      if (viewer.audience === 'OWNER' || viewer.audience === 'CHAIR') {
        const [memberships, chairs, assignments] = await Promise.all([
          client.query<{userId: string; status: string}>(`SELECT user_id AS "userId",status FROM committee_memberships WHERE committee_id=$1 ORDER BY user_id`, [committeeId]),
          client.query<{userId: string}>(`SELECT user_id AS "userId" FROM committee_capabilities
            WHERE committee_id=$1 AND capability='CHAIR' AND revoked_at IS NULL ORDER BY user_id`, [committeeId]),
          client.query<{id: string; seatId: string; userId: string; status: string}>(`SELECT id,seat_id AS "seatId",user_id AS "userId",status
            FROM seat_assignments WHERE committee_id=$1 ORDER BY assigned_at,id`, [committeeId])
        ]);
        result.memberships = memberships.rows; result.chairs = chairs.rows; result.assignments = assignments.rows;
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
  }

  async createCommittee(auth: AuthenticatedSession, input: Record<string, unknown>, idempotencyKey: string,
    context: Stage4Context): Promise<CommitteeSummary> {
    requireBusinessIdentity(auth);
    assertExactBody(input, ['name', 'visibility', 'operationMode', 'activeRulePackageVersionId', 'committeeTemplateId', 'countryTemplateKey']);
    const name = requiredText(input.name, 'Committee name');
    if (!['PUBLIC', 'PRIVATE'].includes(input.visibility as string)) throw new AppError({code: 'VALIDATION_FAILED', message: 'Committee visibility is invalid.'});
    const operationMode = input.operationMode ?? 'DELEGATE_OPERATED';
    if (!['DELEGATE_OPERATED', 'CHAIR_OPERATED'].includes(operationMode as string)) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Committee operation mode is invalid.'});
    }
    const committeeTemplateId = input.committeeTemplateId == null ? null : requiredText(input.committeeTemplateId, 'Committee template ID');
    const requestedCountryKey = input.countryTemplateKey == null ? null : requiredText(input.countryTemplateKey, 'Country template key');
    if ((committeeTemplateId === null) === (requestedCountryKey === null)) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Choose one committee template or one country template.'});
    }
    return idempotentTransaction({pool: this.pool, auth, route: 'POST /api/v1/committees', key: idempotencyKey,
      request: input, status: 201, work: async client => {
        let versionId = typeof input.activeRulePackageVersionId === 'string' ? input.activeRulePackageVersionId : null;
        if (!versionId) {
          const builtin = await client.query<{id: string}>(`SELECT v.id FROM rule_package_versions v JOIN rule_packages p ON p.id=v.package_id
            WHERE p.stable_key='builtin:quorum-default' AND v.status='PUBLISHED'`);
          versionId = builtin.rows[0]?.id ?? null;
        }
        if (!versionId) throw new AppError({code: 'SERVICE_NOT_READY', message: 'Built-in rules are not installed.'});
        const available = await client.query(`SELECT 1 FROM rule_package_versions v JOIN rule_packages p ON p.id=v.package_id
          WHERE v.id=$1 AND v.status='PUBLISHED' AND p.scope IN ('BUILTIN','SYSTEM')`, [versionId]);
        if (!available.rowCount) throw new AppError({code: 'VALIDATION_FAILED', message: 'Rule package version is not published.'});
        let template: CommitteeTemplate | null = null;
        if (committeeTemplateId) template = await committeeTemplate(client,
          await committeeTemplateById(client, auth.user.id, committeeTemplateId, true));
        const countryTemplateKey = template?.countryTemplateKey ?? requestedCountryKey as string;
        await resolveCountryTemplateReference(client, auth.user.id, countryTemplateKey);
        const id = randomUUID();
        const inserted = await client.query<Stage4CommitteeRow>(`INSERT INTO committees
          (id,owner_user_id,name,visibility,operation_mode,active_rule_package_version_id,
           source_committee_template_id,country_template_key,temporary_template,next_event_sequence)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,2) RETURNING *`,
        [id, auth.user.id, name, input.visibility, operationMode, versionId, committeeTemplateId,
          countryTemplateKey, !template]);
        const row = inserted.rows[0] as Stage4CommitteeRow;
        await client.query(`INSERT INTO committee_rule_bindings
          (id,committee_id,package_version_id,effective_from_event_sequence,activated_by_user_id)
          VALUES ($1,$2,$3,1,$4)`, [randomUUID(), id, versionId, auth.user.id]);
        await client.query(`INSERT INTO committee_events
          (committee_id,sequence,event_type,resource_type,resource_id,resource_revision,payload,audience)
          VALUES ($1,1,'committee.created','committee',$1,1,$2,'MEMBER')`,
        [id, {sourceCommitteeTemplateId: committeeTemplateId, countryTemplateKey}]);
        if (template) {
          for (const member of template.members) {
            await client.query(`INSERT INTO committee_seats
              (id,committee_id,stable_key,display_name,rank,can_vote,has_veto,must_vote,sort_order,flag_type,flag_value)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [randomUUID(), id, member.stableKey, localizedDisplayName(member.names, member.defaultLanguage, member.defaultLanguage),
              member.rank, member.canVote, member.hasVeto, member.mustVote, member.sortOrder, member.flag.type, member.flag.value]);
          }
        }
        await audit(client, context, {committeeId: id, actorUserId: auth.user.id, capabilities: ['COMMITTEE_OWNER'],
          action: 'committee.created', resourceType: 'committee', resourceId: id,
          after: {name, sourceCommitteeTemplateId: committeeTemplateId, countryTemplateKey, seatCount: template?.members.length ?? 0}});
        return committeeSummary(row);
      }});
  }

  async createSeat(auth: AuthenticatedSession, committeeId: string, input: Record<string, unknown>,
    idempotencyKey: string, context: Stage4Context): Promise<Stage4CommitteeSeat> {
    requireBusinessIdentity(auth);
    assertExactBody(input, ['stableKey', 'displayName', 'rank', 'canVote', 'hasVeto', 'mustVote', 'sortOrder', 'flag']);
    const stableKey = requiredText(input.stableKey, 'Seat stable key', 128);
    const displayName = requiredText(input.displayName, 'Seat display name');
    const rank = (input.rank ?? 'STANDARD') as SeatRank;
    const canVote = input.canVote ?? ['STANDARD', 'VETO'].includes(rank);
    const hasVeto = input.hasVeto ?? rank === 'VETO'; const mustVote = input.mustVote ?? false;
    const sortOrder = input.sortOrder ?? 0; const seatFlag = validateFlag(input.flag ?? {type: 'EMOJI', value: '🏳️'});
    if (!['STANDARD', 'VETO', 'NGO', 'OBSERVER'].includes(rank) || typeof canVote !== 'boolean'
      || typeof hasVeto !== 'boolean' || typeof mustVote !== 'boolean' || !Number.isSafeInteger(sortOrder)
      || (hasVeto && !canVote)) throw new AppError({code: 'VALIDATION_FAILED', message: 'Seat properties are invalid.'});
    return idempotentTransaction({pool: this.pool, auth, route: `POST /api/v1/committees/${committeeId}/seats`,
      key: idempotencyKey, request: input, status: 201, work: async client => {
        const row = await lockedCommittee(client, committeeId); await requireChair(client, row, auth.user.id); requireEditable(row);
        const id = randomUUID();
        const result = await client.query(`INSERT INTO committee_seats
          (id,committee_id,stable_key,display_name,rank,can_vote,has_veto,must_vote,sort_order,flag_type,flag_value)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          RETURNING id,stable_key AS "stableKey",display_name AS "displayName",rank,can_vote AS "canVote",
            has_veto AS "hasVeto",must_vote AS "mustVote",sort_order AS "sortOrder",active,revision,
            json_build_object('type',flag_type,'value',flag_value) AS flag`,
        [id, committeeId, stableKey, displayName, rank, canVote, hasVeto, mustVote, sortOrder, seatFlag.type, seatFlag.value]);
        await appendEvent(client, row, {type: 'seat.created', resourceType: 'seat', resourceId: id, revision: 1,
          payload: {stableKey, displayName, rank, canVote, hasVeto, mustVote, sortOrder, flagType: seatFlag.type}});
        await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['CHAIR'],
          action: 'committee.seat_created', resourceType: 'seat', resourceId: id,
          after: {stableKey, displayName, rank, canVote, hasVeto, mustVote, sortOrder, flagType: seatFlag.type}});
        return result.rows[0] as Stage4CommitteeSeat;
      }});
  }

  async updateSeat(auth: AuthenticatedSession, committeeId: string, seatId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<Stage4CommitteeSeat> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision', 'patch']);
    const baseRevision = positiveRevision(input.baseRevision);
    if (!input.patch || typeof input.patch !== 'object' || Array.isArray(input.patch)) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Seat patch is invalid.'});
    }
    const patch = input.patch as Record<string, unknown>;
    assertExactBody(patch, ['displayName', 'rank', 'canVote', 'hasVeto', 'mustVote', 'sortOrder', 'flag', 'active'], 'Seat patch');
    if (Object.keys(patch).length === 0) throw new AppError({code: 'VALIDATION_FAILED', message: 'Seat patch is empty.'});
    return transaction(this.pool, async client => {
      const committee = await lockedCommittee(client, committeeId); await requireChair(client, committee, auth.user.id); requireEditable(committee);
      const found = await client.query<{
        revision: number; display_name: string; rank: SeatRank; can_vote: boolean; has_veto: boolean; must_vote: boolean;
        sort_order: number; flag_type: FlagSnapshot['type']; flag_value: string; active: boolean;
      }>('SELECT * FROM committee_seats WHERE id=$1 AND committee_id=$2 FOR UPDATE', [seatId, committeeId]);
      const current = found.rows[0];
      if (!current) throw new AppError({code: 'NOT_FOUND', message: 'Seat not found.'});
      if (current.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT', message: 'This seat changed since it was loaded.',
        details: {currentRevision: current.revision}});
      const displayName = patch.displayName === undefined ? current.display_name : requiredText(patch.displayName, 'Seat display name');
      const rank = (patch.rank ?? current.rank) as SeatRank;
      const canVote = patch.canVote ?? current.can_vote; const hasVeto = patch.hasVeto ?? current.has_veto;
      const mustVote = patch.mustVote ?? current.must_vote; const sortOrder = patch.sortOrder ?? current.sort_order;
      const active = patch.active ?? current.active; const seatFlag = patch.flag === undefined
        ? flag(current.flag_type, current.flag_value) : validateFlag(patch.flag);
      if (!['STANDARD', 'VETO', 'NGO', 'OBSERVER'].includes(rank) || typeof canVote !== 'boolean'
        || typeof hasVeto !== 'boolean' || typeof mustVote !== 'boolean' || !Number.isSafeInteger(sortOrder)
        || typeof active !== 'boolean' || (hasVeto && !canVote)) {
        throw new AppError({code: 'VALIDATION_FAILED', message: 'Seat properties are invalid.'});
      }
      const result = await client.query(`UPDATE committee_seats SET display_name=$3,rank=$4,can_vote=$5,has_veto=$6,
        must_vote=$7,sort_order=$8,flag_type=$9,flag_value=$10,active=$11,revision=revision+1,updated_at=now()
        WHERE id=$1 AND committee_id=$2 RETURNING id,stable_key AS "stableKey",display_name AS "displayName",rank,
        can_vote AS "canVote",has_veto AS "hasVeto",must_vote AS "mustVote",sort_order AS "sortOrder",active,revision,
        json_build_object('type',flag_type,'value',flag_value) AS flag`,
      [seatId, committeeId, displayName, rank, canVote, hasVeto, mustVote, sortOrder, seatFlag.type, seatFlag.value, active]);
      await appendEvent(client, committee, {type: active ? 'seat.updated' : 'seat.deactivated', resourceType: 'seat',
        resourceId: seatId, revision: baseRevision + 1,
        payload: {displayName, rank, canVote, hasVeto, mustVote, sortOrder, active, flagType: seatFlag.type}});
      await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: active ? 'committee.seat_updated' : 'committee.seat_deactivated', resourceType: 'seat', resourceId: seatId,
        before: {revision: current.revision}, after: {revision: current.revision + 1, displayName, rank,
          canVote, hasVeto, mustVote, sortOrder, active, flagType: seatFlag.type}});
      return result.rows[0] as Stage4CommitteeSeat;
    });
  }

  async createNote(auth: AuthenticatedSession, committeeId: string, input: Record<string, unknown>,
    idempotencyKey: string, context: Stage4Context): Promise<CommitteeNote> {
    requireBusinessIdentity(auth); assertExactBody(input, ['title', 'content', 'sortOrder']);
    const title = optionalText(input.title, 'Title', 200); const content = textContent(input.content, 100000);
    const order = sortOrder(input.sortOrder);
    return idempotentTransaction({pool: this.pool, auth, route: `POST /api/v1/committees/${committeeId}/notes`,
      key: idempotencyKey, request: input, status: 201, work: async client => {
        const committee = await lockedCommittee(client, committeeId); requireEditable(committee);
        const access = await committeeAccess(client, committee, auth.user.id); const id = randomUUID();
        const result = await client.query<NoteRow>(`INSERT INTO committee_notes
          (id,committee_id,title,content,sort_order,created_by_user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, committeeId, title, content, order, auth.user.id]);
        const summary = {...contentSummary(content), titleCharacterCount: [...title].length, sortOrder: order};
        await appendEvent(client, committee, {type: 'note.created', resourceType: 'note', resourceId: id, revision: 1,
          payload: summary});
        await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: access.capabilities,
          action: 'proceedings.note_created', resourceType: 'note', resourceId: id, after: summary});
        return note(result.rows[0] as NoteRow);
      }});
  }

  async updateNote(auth: AuthenticatedSession, noteId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<CommitteeNote> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision', 'patch']);
    const baseRevision = positiveRevision(input.baseRevision); const patch = this.textPatch(input.patch, 100000);
    return transaction(this.pool, async client => {
      const found = await client.query<NoteRow>('SELECT * FROM committee_notes WHERE id=$1 FOR UPDATE', [noteId]);
      const current = found.rows[0]; if (!current || current.deleted_at) throw new AppError({code: 'NOT_FOUND', message: 'Note not found.'});
      const committee = await lockedCommittee(client, current.committee_id); requireEditable(committee);
      const access = await committeeAccess(client, committee, auth.user.id);
      if (current.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT', message: 'This note changed since it was loaded.',
        details: {currentRevision: current.revision}});
      const title = patch.title ?? current.title; const content = patch.content ?? current.content;
      const order = patch.sortOrder ?? current.sort_order;
      const result = await client.query<NoteRow>(`UPDATE committee_notes SET title=$2,content=$3,sort_order=$4,
        revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`, [noteId, title, content, order]);
      const before = {...contentSummary(current.content), revision: current.revision};
      const after = {...contentSummary(content), revision: current.revision + 1, titleCharacterCount: [...title].length, sortOrder: order};
      await appendEvent(client, committee, {type: 'note.updated', resourceType: 'note', resourceId: noteId,
        revision: current.revision + 1, payload: after});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: access.capabilities,
        action: 'proceedings.note_updated', resourceType: 'note', resourceId: noteId, before, after});
      return note(result.rows[0] as NoteRow);
    });
  }

  async deleteNote(auth: AuthenticatedSession, noteId: string, baseRevision: number,
    context: Stage4Context): Promise<void> {
    requireBusinessIdentity(auth); const revision = positiveRevision(baseRevision);
    await transaction(this.pool, async client => {
      const found = await client.query<NoteRow>('SELECT * FROM committee_notes WHERE id=$1 FOR UPDATE', [noteId]);
      const current = found.rows[0]; if (!current || current.deleted_at) throw new AppError({code: 'NOT_FOUND', message: 'Note not found.'});
      const committee = await lockedCommittee(client, current.committee_id); requireEditable(committee);
      const access = await committeeAccess(client, committee, auth.user.id);
      if (current.revision !== revision) throw new AppError({code: 'REVISION_CONFLICT', message: 'This note changed since it was loaded.',
        details: {currentRevision: current.revision}});
      await client.query(`UPDATE committee_notes SET title='',content='',revision=revision+1,updated_at=now(),deleted_at=now() WHERE id=$1`, [noteId]);
      const before = {...contentSummary(current.content), revision: current.revision}; const after = {revision: current.revision + 1};
      await appendEvent(client, committee, {type: 'note.deleted', resourceType: 'note', resourceId: noteId,
        revision: current.revision + 1, payload: after});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: access.capabilities,
        action: 'proceedings.note_deleted', resourceType: 'note', resourceId: noteId, before, after});
    });
  }

  async createTextPost(auth: AuthenticatedSession, committeeId: string, input: Record<string, unknown>,
    idempotencyKey: string, context: Stage4Context): Promise<CommitteeTextPost> {
    requireBusinessIdentity(auth); assertExactBody(input, ['title', 'content', 'sortOrder', 'onBehalfOfSeatId']);
    const title = optionalText(input.title, 'Title', 200); const content = textContent(input.content, 20000);
    const order = sortOrder(input.sortOrder);
    return idempotentTransaction({pool: this.pool, auth, route: `POST /api/v1/committees/${committeeId}/text-posts`,
      key: idempotencyKey, request: input, status: 201, work: async client => {
        const committee = await lockedCommittee(client, committeeId); requireEditable(committee);
        const access = await committeeAccess(client, committee, auth.user.id);
        let authorSeatId = access.seatId; let authorDisplayName = auth.user.displayName;
        if (input.onBehalfOfSeatId !== undefined) {
          if (access.audience !== 'CHAIR') throw new AppError({code: 'FORBIDDEN', message: 'Chair capability is required.'});
          authorSeatId = requiredText(input.onBehalfOfSeatId, 'Seat ID');
        }
        if (authorSeatId) {
          const seat = await client.query<{display_name: string}>(`SELECT display_name FROM committee_seats
            WHERE id=$1 AND committee_id=$2 AND active=true`, [authorSeatId, committeeId]);
          if (!seat.rows[0]) throw new AppError({code: 'VALIDATION_FAILED', message: 'Seat is invalid.'});
          authorDisplayName = seat.rows[0].display_name;
        }
        const id = randomUUID(); const result = await client.query<TextPostRow>(`INSERT INTO committee_text_posts
          (id,committee_id,title,content,sort_order,author_seat_id,author_display_name,actor_user_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [id, committeeId, title, content, order, authorSeatId, authorDisplayName, auth.user.id]);
        const summary = {...contentSummary(content), titleCharacterCount: [...title].length, sortOrder: order,
          authorSeatId, actedOnBehalf: Boolean(input.onBehalfOfSeatId)};
        await appendEvent(client, committee, {type: 'text_post.created', resourceType: 'text_post', resourceId: id,
          revision: 1, payload: summary});
        await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: access.capabilities,
          onBehalfOfSeatId: authorSeatId ?? undefined, action: 'proceedings.text_post_created', resourceType: 'text_post',
          resourceId: id, after: summary});
        return textPost(result.rows[0] as TextPostRow);
      }});
  }

  async updateTextPost(auth: AuthenticatedSession, postId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<CommitteeTextPost> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision', 'patch']);
    const baseRevision = positiveRevision(input.baseRevision); const patch = this.textPatch(input.patch, 20000);
    return transaction(this.pool, async client => {
      const found = await client.query<TextPostRow>('SELECT * FROM committee_text_posts WHERE id=$1 FOR UPDATE', [postId]);
      const current = found.rows[0]; if (!current || current.deleted_at) throw new AppError({code: 'NOT_FOUND', message: 'Text post not found.'});
      const committee = await lockedCommittee(client, current.committee_id); requireEditable(committee);
      const access = await committeeAccess(client, committee, auth.user.id);
      if (access.audience === 'MEMBER' && current.actor_user_id !== auth.user.id) {
        throw new AppError({code: 'FORBIDDEN', message: 'You can only edit your own text posts.'});
      }
      if (current.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT', message: 'This text post changed since it was loaded.',
        details: {currentRevision: current.revision}});
      const title = patch.title ?? current.title; const content = patch.content ?? current.content;
      const order = patch.sortOrder ?? current.sort_order;
      const result = await client.query<TextPostRow>(`UPDATE committee_text_posts SET title=$2,content=$3,sort_order=$4,
        revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`, [postId, title, content, order]);
      const before = {...contentSummary(current.content), revision: current.revision};
      const after = {...contentSummary(content), revision: current.revision + 1, titleCharacterCount: [...title].length, sortOrder: order};
      await appendEvent(client, committee, {type: 'text_post.updated', resourceType: 'text_post', resourceId: postId,
        revision: current.revision + 1, payload: after});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: access.capabilities,
        action: 'proceedings.text_post_updated', resourceType: 'text_post', resourceId: postId, before, after});
      return textPost(result.rows[0] as TextPostRow);
    });
  }

  async deleteTextPost(auth: AuthenticatedSession, postId: string, baseRevision: number,
    context: Stage4Context): Promise<void> {
    requireBusinessIdentity(auth); const revision = positiveRevision(baseRevision);
    await transaction(this.pool, async client => {
      const found = await client.query<TextPostRow>('SELECT * FROM committee_text_posts WHERE id=$1 FOR UPDATE', [postId]);
      const current = found.rows[0]; if (!current || current.deleted_at) throw new AppError({code: 'NOT_FOUND', message: 'Text post not found.'});
      const committee = await lockedCommittee(client, current.committee_id); requireEditable(committee);
      const access = await committeeAccess(client, committee, auth.user.id);
      if (access.audience === 'MEMBER' && current.actor_user_id !== auth.user.id) {
        throw new AppError({code: 'FORBIDDEN', message: 'You can only delete your own text posts.'});
      }
      if (current.revision !== revision) throw new AppError({code: 'REVISION_CONFLICT', message: 'This text post changed since it was loaded.',
        details: {currentRevision: current.revision}});
      await client.query(`UPDATE committee_text_posts SET title='',content='',revision=revision+1,updated_at=now(),deleted_at=now() WHERE id=$1`, [postId]);
      const before = {...contentSummary(current.content), revision: current.revision}; const after = {revision: current.revision + 1};
      await appendEvent(client, committee, {type: 'text_post.deleted', resourceType: 'text_post', resourceId: postId,
        revision: current.revision + 1, payload: after});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: access.capabilities,
        action: 'proceedings.text_post_deleted', resourceType: 'text_post', resourceId: postId, before, after});
    });
  }

  async startMeetingSession(auth: AuthenticatedSession, committeeId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<MeetingSession> {
    requireBusinessIdentity(auth); assertExactBody(input, ['phaseId']);
    return transaction(this.pool, async client => {
      const committee = await lockedCommittee(client, committeeId); await requireChair(client, committee, auth.user.id);
      requireProceedingsActive(committee);
      const definition = await client.query<{definition: {phases?: unknown}}>(`SELECT definition FROM rule_package_versions
        WHERE id=$1 AND status='PUBLISHED'`, [committee.active_rule_package_version_id]);
      const phases = definition.rows[0]?.definition.phases;
      if (!definition.rows[0] || !Array.isArray(phases)) {
        throw new AppError({code: 'VALIDATION_FAILED', message: 'The active rule package has invalid phases.'});
      }
      const phaseIds = phases.map(item => item && typeof item === 'object' ? (item as {id?: unknown}).id : undefined)
        .filter((value): value is string => typeof value === 'string' && Boolean(value));
      const phaseId = input.phaseId === undefined ? phaseIds[0] ?? 'open-debate' : requiredText(input.phaseId, 'Phase ID', 128);
      if (phaseIds.length > 0 && !phaseIds.includes(phaseId)) {
        throw new AppError({code: 'VALIDATION_FAILED', message: 'Phase is not defined by the active rule package.'});
      }
      const id = randomUUID();
      const inserted = await client.query<MeetingSessionRow>(`INSERT INTO meeting_sessions
        (id,committee_id,phase_id,active_rule_package_version_id,created_by_user_id)
        VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [id, committeeId, phaseId, committee.active_rule_package_version_id, auth.user.id]);
      await appendEvent(client, committee, {type: 'meeting_session.started', resourceType: 'meeting_session',
        resourceId: id, revision: 1, payload: {phaseId, rulePackageVersionId: committee.active_rule_package_version_id}});
      await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: 'proceedings.meeting_session_started', resourceType: 'meeting_session', resourceId: id,
        after: {phaseId, rulePackageVersionId: committee.active_rule_package_version_id}});
      return meetingSession(inserted.rows[0] as MeetingSessionRow);
    });
  }

  async closeMeetingSession(auth: AuthenticatedSession, sessionId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<MeetingSession> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision']); const baseRevision = positiveRevision(input.baseRevision);
    return transaction(this.pool, async client => {
      const found = await client.query<MeetingSessionRow>('SELECT * FROM meeting_sessions WHERE id=$1 FOR UPDATE', [sessionId]);
      const current = found.rows[0]; if (!current) throw new AppError({code: 'NOT_FOUND', message: 'Meeting session not found.'});
      const committee = await lockedCommittee(client, current.committee_id); await requireChair(client, committee, auth.user.id);
      requireProceedingsActive(committee);
      if (current.status !== 'OPEN') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Meeting session is already closed.'});
      if (current.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT', message: 'This meeting session changed since it was loaded.',
        details: {currentRevision: current.revision}});
      const activeRollCall = await client.query(`SELECT 1 FROM roll_calls WHERE meeting_session_id=$1 AND status='IN_PROGRESS'`, [sessionId]);
      if (activeRollCall.rowCount) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Complete or reset the active roll call first.'});
      const updated = await client.query<MeetingSessionRow>(`UPDATE meeting_sessions SET status='CLOSED',revision=revision+1,
        closed_at=now() WHERE id=$1 RETURNING *`, [sessionId]);
      await appendEvent(client, committee, {type: 'meeting_session.closed', resourceType: 'meeting_session',
        resourceId: sessionId, revision: current.revision + 1, payload: {phaseId: current.phase_id}});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: 'proceedings.meeting_session_closed', resourceType: 'meeting_session', resourceId: sessionId,
        before: {status: current.status, revision: current.revision}, after: {status: 'CLOSED', revision: current.revision + 1}});
      return meetingSession(updated.rows[0] as MeetingSessionRow);
    });
  }

  async startRollCall(auth: AuthenticatedSession, committeeId: string, input: Record<string, unknown>,
    idempotencyKey: string, context: Stage4Context): Promise<RollCall> {
    requireBusinessIdentity(auth); assertExactBody(input, ['meetingSessionId']);
    const meetingSessionId = requiredText(input.meetingSessionId, 'Meeting session ID');
    return idempotentTransaction({pool: this.pool, auth, route: `POST /api/v1/committees/${committeeId}/roll-calls`,
      key: idempotencyKey, request: input, status: 201, work: async client => {
        const committee = await lockedCommittee(client, committeeId); await requireChair(client, committee, auth.user.id);
        requireProceedingsActive(committee);
        const sessionResult = await client.query<MeetingSessionRow>(`SELECT * FROM meeting_sessions
          WHERE id=$1 AND committee_id=$2 FOR UPDATE`, [meetingSessionId, committeeId]);
        const session = sessionResult.rows[0];
        if (!session) throw new AppError({code: 'NOT_FOUND', message: 'Meeting session not found.'});
        if (session.status !== 'OPEN') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Meeting session is closed.'});
        const version = await client.query<{definition: {attendance?: {responses?: unknown}}}>(`SELECT definition
          FROM rule_package_versions WHERE id=$1 AND status='PUBLISHED'`, [session.active_rule_package_version_id]);
        const rawResponses = version.rows[0]?.definition.attendance?.responses;
        const responses = Array.isArray(rawResponses) ? rawResponses : [];
        const allowedValues = new Set(['PRESENT', 'PRESENT_AND_VOTING', 'ABSENT']);
        if (responses.length === 0 || responses.some(value => typeof value !== 'string' || !allowedValues.has(value))
          || new Set(responses).size !== responses.length) {
          throw new AppError({code: 'VALIDATION_FAILED', message: 'The rule package has invalid roll-call responses.'});
        }
        const seats = await client.query<{id: string; display_name: string}>(`SELECT id,display_name FROM committee_seats
          WHERE committee_id=$1 AND active=true ORDER BY sort_order,stable_key,id`, [committeeId]);
        if (seats.rows.length === 0) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The committee has no active seats.'});
        const id = randomUUID(); const inserted = await client.query<RollCallRow>(`INSERT INTO roll_calls
          (id,committee_id,meeting_session_id,current_seat_id,rule_package_version_id,allowed_responses,started_by_user_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [id, committeeId, meetingSessionId, seats.rows[0]?.id, session.active_rule_package_version_id, responses, auth.user.id]);
        for (const [index, seat] of seats.rows.entries()) {
          await client.query(`INSERT INTO roll_call_seats (roll_call_id,seat_id,seat_display_name,sort_order)
            VALUES ($1,$2,$3,$4)`, [id, seat.id, seat.display_name, index]);
        }
        await appendEvent(client, committee, {type: 'roll_call.started', resourceType: 'roll_call', resourceId: id,
          revision: 1, payload: {meetingSessionId, rulePackageVersionId: session.active_rule_package_version_id,
            allowedResponses: responses, seatCount: seats.rows.length}});
        await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['CHAIR'],
          action: 'proceedings.roll_call_started', resourceType: 'roll_call', resourceId: id,
          after: {meetingSessionId, rulePackageVersionId: session.active_rule_package_version_id,
            allowedResponses: responses, seatCount: seats.rows.length}});
        return rollCall(client, inserted.rows[0] as RollCallRow);
      }});
  }

  async recordRollCallResponse(auth: AuthenticatedSession, rollCallId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<RollCall> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision', 'seatId', 'response']);
    const baseRevision = positiveRevision(input.baseRevision); const seatId = requiredText(input.seatId, 'Seat ID');
    const response = requiredText(input.response, 'Response', 128);
    return transaction(this.pool, async client => {
      const found = await client.query<RollCallRow>('SELECT * FROM roll_calls WHERE id=$1 FOR UPDATE', [rollCallId]);
      const current = found.rows[0]; if (!current) throw new AppError({code: 'NOT_FOUND', message: 'Roll call not found.'});
      const committee = await lockedCommittee(client, current.committee_id); await requireChair(client, committee, auth.user.id);
      requireProceedingsActive(committee);
      if (current.status !== 'IN_PROGRESS') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Roll call is not in progress.'});
      if (current.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT', message: 'This roll call changed since it was loaded.',
        details: {currentRevision: current.revision}});
      if (current.current_seat_id !== seatId) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Record the current seat first.'});
      if (!current.allowed_responses.includes(response)) throw new AppError({code: 'VALIDATION_FAILED', message: 'Roll-call response is not allowed.'});
      const frozen = await client.query<{seat_display_name: string; sort_order: number}>(`SELECT seat_display_name,sort_order
        FROM roll_call_seats WHERE roll_call_id=$1 AND seat_id=$2`, [rollCallId, seatId]);
      if (!frozen.rows[0]) throw new AppError({code: 'VALIDATION_FAILED', message: 'Seat is not part of this roll call.'});
      const entryId = randomUUID();
      await client.query(`INSERT INTO roll_call_entries
        (id,committee_id,roll_call_id,seat_id,seat_display_name,response,actor_user_id,on_behalf_of_seat_id,rule_package_version_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$4,$8)`,
      [entryId, current.committee_id, rollCallId, seatId, frozen.rows[0].seat_display_name, response,
        auth.user.id, current.rule_package_version_id]);
      const next = await client.query<{seat_id: string}>(`SELECT s.seat_id FROM roll_call_seats s
        WHERE s.roll_call_id=$1 AND s.sort_order>$2 AND NOT EXISTS (SELECT 1 FROM roll_call_entries e
          WHERE e.roll_call_id=s.roll_call_id AND e.seat_id=s.seat_id AND e.undone_at IS NULL)
        ORDER BY s.sort_order LIMIT 1`, [rollCallId, frozen.rows[0].sort_order]);
      const completed = !next.rows[0];
      const updated = await client.query<RollCallRow>(`UPDATE roll_calls SET current_seat_id=$2,status=$3,
        completed_at=CASE WHEN $3='COMPLETED' THEN now() ELSE NULL END,revision=revision+1 WHERE id=$1 RETURNING *`,
      [rollCallId, next.rows[0]?.seat_id ?? null, completed ? 'COMPLETED' : 'IN_PROGRESS']);
      await appendEvent(client, committee, {type: 'roll_call.response_recorded', resourceType: 'roll_call',
        resourceId: rollCallId, revision: current.revision + 1, payload: {entryId, seatId, response}});
      await audit(client, context, {committeeId: current.committee_id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        onBehalfOfSeatId: seatId, action: 'proceedings.roll_call_response_recorded', resourceType: 'roll_call_entry',
        resourceId: entryId, after: {rollCallId, seatId, response, rulePackageVersionId: current.rule_package_version_id}});
      if (completed) {
        const entries = await client.query<RollCallEntryRow>(`SELECT * FROM roll_call_entries
          WHERE roll_call_id=$1 AND undone_at IS NULL ORDER BY recorded_at,id`, [rollCallId]);
        for (const entry of entries.rows) {
          await insertAttendanceEvent(client, {committeeId: current.committee_id, meetingSessionId: current.meeting_session_id,
            seatId: entry.seat_id, seatDisplayName: entry.seat_display_name,
            type: entry.response === 'ABSENT' ? 'ABSENT' : 'PRESENT', actorUserId: auth.user.id,
            sourceRollCallEntryId: entry.id});
        }
        await appendEvent(client, committee, {type: 'roll_call.completed', resourceType: 'roll_call', resourceId: rollCallId,
          revision: current.revision + 1, payload: {meetingSessionId: current.meeting_session_id, seatCount: entries.rows.length}});
        await appendEvent(client, committee, {type: 'attendance.changed', resourceType: 'meeting_session',
          resourceId: current.meeting_session_id, revision: current.revision + 1,
          payload: {source: 'ROLL_CALL', rollCallId, seatCount: entries.rows.length}});
        await audit(client, context, {committeeId: current.committee_id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
          action: 'proceedings.roll_call_completed', resourceType: 'roll_call', resourceId: rollCallId,
          after: {meetingSessionId: current.meeting_session_id, seatCount: entries.rows.length}});
      }
      return rollCall(client, updated.rows[0] as RollCallRow);
    });
  }

  async undoRollCallResponse(auth: AuthenticatedSession, rollCallId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<RollCall> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision']); const baseRevision = positiveRevision(input.baseRevision);
    return transaction(this.pool, async client => {
      const found = await client.query<RollCallRow>('SELECT * FROM roll_calls WHERE id=$1 FOR UPDATE', [rollCallId]);
      const current = found.rows[0]; if (!current) throw new AppError({code: 'NOT_FOUND', message: 'Roll call not found.'});
      const committee = await lockedCommittee(client, current.committee_id); await requireChair(client, committee, auth.user.id);
      requireProceedingsActive(committee);
      if (current.status !== 'IN_PROGRESS') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Only an active roll call can be undone.'});
      if (current.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT', message: 'This roll call changed since it was loaded.',
        details: {currentRevision: current.revision}});
      const last = await client.query<RollCallEntryRow>(`SELECT * FROM roll_call_entries WHERE roll_call_id=$1 AND undone_at IS NULL
        ORDER BY recorded_at DESC,id DESC LIMIT 1 FOR UPDATE`, [rollCallId]);
      const entry = last.rows[0]; if (!entry) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Roll call has no response to undo.'});
      await client.query('UPDATE roll_call_entries SET undone_at=now() WHERE id=$1', [entry.id]);
      const updated = await client.query<RollCallRow>(`UPDATE roll_calls SET current_seat_id=$2,revision=revision+1
        WHERE id=$1 RETURNING *`, [rollCallId, entry.seat_id]);
      await appendEvent(client, committee, {type: 'roll_call.response_undone', resourceType: 'roll_call', resourceId: rollCallId,
        revision: current.revision + 1, payload: {entryId: entry.id, seatId: entry.seat_id}});
      await audit(client, context, {committeeId: current.committee_id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: 'proceedings.roll_call_response_undone', resourceType: 'roll_call_entry', resourceId: entry.id,
        before: {rollCallId, seatId: entry.seat_id, response: entry.response}, after: {undone: true}});
      return rollCall(client, updated.rows[0] as RollCallRow);
    });
  }

  async resetRollCall(auth: AuthenticatedSession, rollCallId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<RollCall> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision']); const baseRevision = positiveRevision(input.baseRevision);
    return transaction(this.pool, async client => {
      const found = await client.query<RollCallRow>('SELECT * FROM roll_calls WHERE id=$1 FOR UPDATE', [rollCallId]);
      const current = found.rows[0]; if (!current) throw new AppError({code: 'NOT_FOUND', message: 'Roll call not found.'});
      const committee = await lockedCommittee(client, current.committee_id); await requireChair(client, committee, auth.user.id);
      requireProceedingsActive(committee);
      if (current.status !== 'IN_PROGRESS') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Only an active roll call can be reset.'});
      if (current.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT', message: 'This roll call changed since it was loaded.',
        details: {currentRevision: current.revision}});
      const seats = await client.query<{seat_id: string; seat_display_name: string; sort_order: number}>(`SELECT * FROM roll_call_seats
        WHERE roll_call_id=$1 ORDER BY sort_order`, [rollCallId]);
      await client.query(`UPDATE roll_calls SET status='ABANDONED',current_seat_id=NULL,revision=revision+1 WHERE id=$1`, [rollCallId]);
      const nextId = randomUUID(); const inserted = await client.query<RollCallRow>(`INSERT INTO roll_calls
        (id,committee_id,meeting_session_id,current_seat_id,rule_package_version_id,allowed_responses,started_by_user_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [nextId, current.committee_id, current.meeting_session_id, seats.rows[0]?.seat_id,
        current.rule_package_version_id, current.allowed_responses, auth.user.id]);
      for (const seat of seats.rows) await client.query(`INSERT INTO roll_call_seats
        (roll_call_id,seat_id,seat_display_name,sort_order) VALUES ($1,$2,$3,$4)`,
      [nextId, seat.seat_id, seat.seat_display_name, seat.sort_order]);
      await appendEvent(client, committee, {type: 'roll_call.reset', resourceType: 'roll_call', resourceId: rollCallId,
        revision: current.revision + 1, payload: {replacementRollCallId: nextId, meetingSessionId: current.meeting_session_id}});
      await appendEvent(client, committee, {type: 'roll_call.started', resourceType: 'roll_call', resourceId: nextId,
        revision: 1, payload: {resetFromRollCallId: rollCallId, meetingSessionId: current.meeting_session_id,
          rulePackageVersionId: current.rule_package_version_id, allowedResponses: current.allowed_responses, seatCount: seats.rows.length}});
      await audit(client, context, {committeeId: current.committee_id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: 'proceedings.roll_call_reset', resourceType: 'roll_call', resourceId: rollCallId,
        before: {status: 'IN_PROGRESS', revision: current.revision},
        after: {status: 'ABANDONED', revision: current.revision + 1, replacementRollCallId: nextId}});
      return rollCall(client, inserted.rows[0] as RollCallRow);
    });
  }

  async createAttendanceEvent(auth: AuthenticatedSession, committeeId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<AttendanceEvent> {
    requireBusinessIdentity(auth); assertExactBody(input, ['meetingSessionId', 'seatId', 'type']);
    const sessionId = requiredText(input.meetingSessionId, 'Meeting session ID'); const seatId = requiredText(input.seatId, 'Seat ID');
    const type = input.type as AttendanceEventType;
    if (!['PRESENT', 'TEMPORARILY_LEFT', 'RETURNED', 'ABSENT'].includes(type)) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Attendance event type is invalid.'});
    }
    return transaction(this.pool, async client => {
      const committee = await lockedCommittee(client, committeeId); await requireChair(client, committee, auth.user.id);
      requireProceedingsActive(committee);
      const session = await client.query<MeetingSessionRow>(`SELECT * FROM meeting_sessions WHERE id=$1 AND committee_id=$2`,
        [sessionId, committeeId]);
      if (!session.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Meeting session not found.'});
      if (session.rows[0].status !== 'OPEN') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Meeting session is closed.'});
      const seat = await client.query<{display_name: string}>(`SELECT display_name FROM committee_seats
        WHERE id=$1 AND committee_id=$2 AND active=true`, [seatId, committeeId]);
      if (!seat.rows[0]) throw new AppError({code: 'VALIDATION_FAILED', message: 'Seat is invalid.'});
      const event = await insertAttendanceEvent(client, {committeeId, meetingSessionId: sessionId, seatId,
        seatDisplayName: seat.rows[0].display_name, type, actorUserId: auth.user.id});
      await appendEvent(client, committee, {type: 'attendance.changed', resourceType: 'attendance', resourceId: event.id,
        revision: 1, payload: {meetingSessionId: sessionId, seatId, type}});
      await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['CHAIR'], onBehalfOfSeatId: seatId,
        action: 'proceedings.attendance_changed', resourceType: 'attendance_event', resourceId: event.id,
        after: {meetingSessionId: sessionId, seatId, type}});
      return event;
    });
  }

  async createPoint(auth: AuthenticatedSession, committeeId: string, input: Record<string, unknown>,
    idempotencyKey: string, context: Stage4Context): Promise<CommitteePoint> {
    requireBusinessIdentity(auth); assertExactBody(input, ['meetingSessionId', 'pointTypeId', 'content', 'onBehalfOfSeatId']);
    const meetingSessionId = requiredText(input.meetingSessionId, 'Meeting session ID');
    const pointTypeId = requiredText(input.pointTypeId, 'Point type ID', 128);
    const content = requiredText(input.content, 'Point content', 4000);
    return idempotentTransaction({pool: this.pool, auth, route: `POST /api/v1/committees/${committeeId}/points`,
      key: idempotencyKey, request: input, status: 201, work: async client => {
        const committee = await lockedCommittee(client, committeeId); requireProceedingsActive(committee);
        const access = await committeeAccess(client, committee, auth.user.id); const chair = await isChair(client, committeeId, auth.user.id);
        const requestedSeatId = input.onBehalfOfSeatId === undefined ? null : requiredText(input.onBehalfOfSeatId, 'Seat ID');
        let seatId: string | null = null; let actedOnBehalf = false;
        if (committee.operation_mode === 'CHAIR_OPERATED') {
          if (!chair) throw new AppError({code: 'FORBIDDEN', message: 'Chair capability is required.'});
          if (!requestedSeatId) throw new AppError({code: 'VALIDATION_FAILED', message: 'A represented seat is required.'});
          seatId = requestedSeatId; actedOnBehalf = true;
        } else if (requestedSeatId) {
          if (!chair) throw new AppError({code: 'FORBIDDEN', message: 'Only a Chair can act for another seat.'});
          seatId = requestedSeatId; actedOnBehalf = true;
        } else {
          seatId = access.seatId ?? await activeSeat(client, committeeId, auth.user.id);
          if (!seatId) throw new AppError({code: 'FORBIDDEN', message: 'An active seat assignment is required.'});
        }
        const session = await client.query<MeetingSessionRow>(`SELECT * FROM meeting_sessions
          WHERE id=$1 AND committee_id=$2`, [meetingSessionId, committeeId]);
        const meeting = session.rows[0];
        if (!meeting) throw new AppError({code: 'NOT_FOUND', message: 'Meeting session not found.'});
        if (meeting.status !== 'OPEN') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Meeting session is closed.'});
        const seat = await client.query<{display_name: string}>(`SELECT display_name FROM committee_seats
          WHERE id=$1 AND committee_id=$2 AND active=true`, [seatId, committeeId]);
        if (!seat.rows[0]) throw new AppError({code: 'VALIDATION_FAILED', message: 'Seat is invalid.'});
        const version = await client.query<{definition: {points?: unknown}}>(`SELECT definition FROM rule_package_versions
          WHERE id=$1 AND status='PUBLISHED'`, [meeting.active_rule_package_version_id]);
        const rawPoints = version.rows[0]?.definition.points;
        if (!Array.isArray(rawPoints)) throw new AppError({code: 'VALIDATION_FAILED', message: 'The rule package has invalid point types.'});
        const matching = rawPoints.filter(item => item && typeof item === 'object' && (item as {id?: unknown}).id === pointTypeId);
        const definition = matching[0] as {id?: unknown; interruptRequested?: unknown; enabled?: unknown} | undefined;
        if (matching.length !== 1 || !definition || typeof definition.interruptRequested !== 'boolean'
          || definition.enabled === false) {
          throw new AppError({code: 'VALIDATION_FAILED', message: 'Point type is not active in the meeting rule package.'});
        }
        const id = randomUUID(); const result = await client.query<PointRow>(`INSERT INTO points
          (id,committee_id,meeting_session_id,point_type_id,content,raised_by_seat_id,raised_by_seat_display_name,
           actor_user_id,on_behalf_of_seat_id,interrupt_requested,rule_package_version_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$6,$9,$10) RETURNING *`,
        [id, committeeId, meetingSessionId, pointTypeId, content, seatId, seat.rows[0].display_name,
          auth.user.id, definition.interruptRequested, meeting.active_rule_package_version_id]);
        const summary = {meetingSessionId, pointTypeId, seatId, interruptRequested: definition.interruptRequested,
          rulePackageVersionId: meeting.active_rule_package_version_id, actedOnBehalf, ...contentSummary(content)};
        await appendEvent(client, committee, {type: 'point.raised', resourceType: 'point', resourceId: id,
          revision: 1, payload: summary});
        await audit(client, context, {committeeId, actorUserId: auth.user.id,
          capabilities: chair ? ['CHAIR'] : access.capabilities, onBehalfOfSeatId: seatId,
          action: 'proceedings.point_raised', resourceType: 'point', resourceId: id, after: summary});
        if (actedOnBehalf) await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['CHAIR'],
          onBehalfOfSeatId: seatId, action: 'proceedings.chair_acted_on_behalf', resourceType: 'point', resourceId: id,
          after: {command: 'point.raised', pointTypeId}});
        return point(result.rows[0] as PointRow);
      }});
  }

  async resolvePoint(auth: AuthenticatedSession, pointId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<CommitteePoint> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision', 'status', 'chairResponse', 'attendanceChange']);
    const baseRevision = positiveRevision(input.baseRevision);
    const status = input.status as Exclude<PointStatus, 'PENDING'>;
    if (!['UPHELD', 'OVERRULED', 'ANSWERED', 'RESOLVED', 'REJECTED'].includes(status)) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Point resolution status is invalid.'});
    }
    const chairResponse = optionalText(input.chairResponse, 'Chair response', 4000);
    let attendanceType: AttendanceEventType | undefined;
    if (input.attendanceChange !== undefined) {
      if (!input.attendanceChange || typeof input.attendanceChange !== 'object' || Array.isArray(input.attendanceChange)) {
        throw new AppError({code: 'VALIDATION_FAILED', message: 'Attendance change is invalid.'});
      }
      const change = input.attendanceChange as Record<string, unknown>; assertExactBody(change, ['type'], 'Attendance change');
      attendanceType = change.type as AttendanceEventType;
      if (!['PRESENT', 'TEMPORARILY_LEFT', 'RETURNED', 'ABSENT'].includes(attendanceType)) {
        throw new AppError({code: 'VALIDATION_FAILED', message: 'Attendance event type is invalid.'});
      }
    }
    return transaction(this.pool, async client => {
      const found = await client.query<PointRow>('SELECT * FROM points WHERE id=$1 FOR UPDATE', [pointId]);
      const current = found.rows[0]; if (!current) throw new AppError({code: 'NOT_FOUND', message: 'Point not found.'});
      const committee = await lockedCommittee(client, current.committee_id); await requireChair(client, committee, auth.user.id);
      requireProceedingsActive(committee);
      if (current.status !== 'PENDING') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Point has already been resolved.'});
      if (current.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT', message: 'This point changed since it was loaded.',
        details: {currentRevision: current.revision}});
      if (attendanceType && current.point_type_id !== 'point-of-personal-privilege') {
        throw new AppError({code: 'VALIDATION_FAILED', message: 'Only a personal privilege point can change attendance.'});
      }
      const updated = await client.query<PointRow>(`UPDATE points SET status=$2,chair_response=$3,resolved_by_user_id=$4,
        resolved_at=now(),revision=revision+1 WHERE id=$1 RETURNING *`, [pointId, status, chairResponse, auth.user.id]);
      const after = {status, revision: current.revision + 1, responseCharacterCount: [...chairResponse].length,
        responseSha256: createHash('sha256').update(chairResponse).digest('hex')};
      await appendEvent(client, committee, {type: 'point.resolved', resourceType: 'point', resourceId: pointId,
        revision: current.revision + 1, payload: {status}});
      if (attendanceType) {
        const event = await insertAttendanceEvent(client, {committeeId: current.committee_id,
          meetingSessionId: current.meeting_session_id, seatId: current.raised_by_seat_id,
          seatDisplayName: current.raised_by_seat_display_name, type: attendanceType, actorUserId: auth.user.id,
          sourcePointId: pointId});
        await appendEvent(client, committee, {type: 'attendance.changed', resourceType: 'attendance', resourceId: event.id,
          revision: 1, payload: {meetingSessionId: current.meeting_session_id, seatId: current.raised_by_seat_id,
            type: attendanceType, sourcePointId: pointId}});
      }
      await audit(client, context, {committeeId: current.committee_id, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        onBehalfOfSeatId: current.raised_by_seat_id, action: 'proceedings.point_resolved', resourceType: 'point',
        resourceId: pointId, before: {status: current.status, revision: current.revision},
        after: {...after, attendanceType: attendanceType ?? null}});
      if (attendanceType) await audit(client, context, {committeeId: current.committee_id, actorUserId: auth.user.id,
        capabilities: ['CHAIR'], onBehalfOfSeatId: current.raised_by_seat_id,
        action: 'proceedings.attendance_changed', resourceType: 'point', resourceId: pointId,
        after: {meetingSessionId: current.meeting_session_id, seatId: current.raised_by_seat_id, type: attendanceType}});
      return point(updated.rows[0] as PointRow);
    });
  }

  private textPatch(value: unknown, contentLimit: number): {title?: string; content?: string; sortOrder?: number} {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Text resource patch is invalid.'});
    }
    const patch = value as Record<string, unknown>; assertExactBody(patch, ['title', 'content', 'sortOrder'], 'Text resource patch');
    if (Object.keys(patch).length === 0) throw new AppError({code: 'VALIDATION_FAILED', message: 'Text resource patch is empty.'});
    return {title: patch.title === undefined ? undefined : optionalText(patch.title, 'Title', 200),
      content: patch.content === undefined ? undefined : textContent(patch.content, contentLimit),
      sortOrder: patch.sortOrder === undefined ? undefined : sortOrder(patch.sortOrder)};
  }
}
