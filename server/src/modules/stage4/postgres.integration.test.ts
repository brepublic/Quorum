import {testCommitteeInput} from '../../test/committee-fixture';
// @vitest-environment node

import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import pg from 'pg';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {runMigrations} from '../../db/migrations';
import {PostgresIdentityStore} from '../identity/postgres';
import {IdentityService} from '../identity/service';
import type {AuthenticatedSession} from '../identity/store';
import {Stage3Service} from '../stage3/service';
import {DelegateFileService} from '../delegate-files/service';
import {Stage4Service} from './service';

const {Client, Pool} = pg;
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const integration = adminUrl ? describe : describe.skip;
let databaseName = '';
let pool: pg.Pool | undefined;
let identity: IdentityService;
let stage3: Stage3Service;
let stage4: Stage4Service;
let administrator: AuthenticatedSession;

function quoteIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
const context = (name: string) => ({requestId: `stage4-${name}`, sourceIp: '127.0.0.1', userAgent: 'Vitest'});

beforeEach(async () => {
  if (!adminUrl) return;
  databaseName = `quorum_stage4_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(adminUrl); url.pathname = `/${databaseName}`;
  const admin = new Client({connectionString: adminUrl}); await admin.connect();
  try { await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`); } finally { await admin.end(); }
  pool = new Pool({connectionString: url.toString()});
  await runMigrations(pool, resolve('server/migrations'));
  identity = new IdentityService(new PostgresIdentityStore(pool));
  stage3 = new Stage3Service(pool); stage4 = new Stage4Service(pool);
  await stage3.ensureBuiltins();
  const secret = await identity.ensureBootstrapSecret();
  const session = await identity.bootstrapAdmin({secret: secret as string, email: 'admin@example.com',
    displayName: 'System Admin', password: 'admin-password-123'}, context('bootstrap'));
  administrator = await identity.authenticate(session.sessionToken);
});

afterEach(async () => {
  await pool?.end(); pool = undefined;
  if (!adminUrl || !databaseName) return;
  const admin = new Client({connectionString: adminUrl}); await admin.connect();
  try { await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`); }
  finally { await admin.end(); databaseName = ''; }
});

async function user(name: string): Promise<AuthenticatedSession> {
  const created = await identity.createUser(administrator, {email: `${name}@example.com`, displayName: name}, context(`create-${name}`));
  const login = await identity.login({email: created.user.email, password: created.temporaryPassword}, context(`login-${name}`));
  const changed = await identity.changePassword(await identity.authenticate(login.sessionToken), {
    newPassword: `${name}-permanent-password-123`
  }, context(`password-${name}`));
  return identity.authenticate(changed.sessionToken);
}

const countryTemplate = {names: {en: 'Countries', 'zh-CN': '国家'}, defaultLanguage: 'en', countryLanguages: ['en', 'zh-CN'],
  countries: [{stableKey: 'china', names: {en: 'China', 'zh-CN': '中国'}, defaultLanguage: 'en', continent: 'Asia', sortOrder: 1,
    flag: {type: 'STANDARD' as const, value: 'cn'}},
    {stableKey: 'france', names: {en: 'France', 'zh-CN': '法国'}, defaultLanguage: 'en', continent: 'Europe', sortOrder: 2,
      flag: {type: 'STANDARD' as const, value: 'fr'}}]};

const committeeTemplate = (countryTemplateKey: string) => ({names: {en: 'Council'}, defaultLanguage: 'en', countryTemplateKey,
  members: [{stableKey: 'china', names: {en: 'China', 'zh-CN': '中国'}, defaultLanguage: 'en', rank: 'STANDARD' as const,
    canVote: true, hasVeto: true, mustVote: false, sortOrder: 1, flag: {type: 'STANDARD' as const, value: 'cn'}}]});

integration('PostgreSQL stage 4 templates and seat snapshots', () => {
  it('isolates file settings and copies administrator rejection defaults only into new committees', async () => {
    const owner = await user('file-settings');
    const service = new DelegateFileService(pool!, {} as never, {} as never, {} as never, {} as never);
    const create = async (name: string) => stage4.createCommittee(owner, await testCommitteeInput(pool!, owner, {name, visibility: 'PRIVATE', countryTemplateKey: 'builtin:default'}), randomUUID(), context(name));
    const first = await create('first');
    const initial = await service.getSettings(owner, first.id);
    expect(initial.rejectionTypes.map(item => item.label['zh-CN'])).toEqual(['内容格式不合要求', '重复提交', '其他']);
    const defaults = await service.getSettings(administrator);
    const newTypes = [{id: 'new', label: {en: 'Missing sponsors', 'zh-CN': '缺少签署'}, message: {en: 'Add sponsors', 'zh-CN': '请补充签署国'}, custom: false}];
    await expect(service.updateSettings(owner, undefined, {baseRevision: defaults.revision, rejectionTypes: newTypes}, context('unauthorized'))).rejects.toMatchObject({code:'FORBIDDEN'});
    await service.updateSettings(administrator, undefined, {baseRevision: defaults.revision, rejectionTypes: newTypes}, context('defaults'));
    const second = await create('second');
    expect((await service.getSettings(owner, second.id)).rejectionTypes).toEqual(newTypes);
    expect((await service.getSettings(owner, first.id)).rejectionTypes).toEqual(initial.rejectionTypes);
    const extensions = {WORKING_PAPER:['pdf'],DIRECTIVE_DRAFT:['docx'],RESOLUTION_DRAFT:['odt']};
    await service.updateSettings(owner, first.id, {baseRevision:initial.revision,rejectionTypes:newTypes,allowedExtensions:extensions},context('local'));
    await expect(service.updateSettings(owner, first.id, {baseRevision:initial.revision,rejectionTypes:newTypes,allowedExtensions:extensions},context('stale'))).rejects.toMatchObject({code:'REVISION_CONFLICT'});
    expect(await service.getSettings(owner, first.id)).toMatchObject({allowedExtensions:extensions});
    expect(await service.getSettings(owner, second.id)).toMatchObject({allowedExtensions:{WORKING_PAPER:expect.arrayContaining(['doc','pdf','txt'])}});
    await expect(service.getSettings(administrator, first.id)).rejects.toMatchObject({code:'FORBIDDEN'});
    const outsider = await user('outsider-settings');
    await expect(service.getSettings(outsider, first.id)).rejects.toMatchObject({code:'FORBIDDEN'});
  });

  it('applies only current administrator defaults when creating a committee', async () => {
    const owner = await user('defaultbehavior');
    const initial = await identity.getDefaultCommitteeBehavior(administrator);
    const chairDefault = await identity.updateDefaultCommitteeBehavior(administrator,
      {creatorIsChair: true, operationMode: 'CHAIR_OPERATED', baseRevision: initial.revision}, context('defaults-chair'));
    const chaired = await stage4.createCommittee(owner, await testCommitteeInput(pool!, owner, {name: 'Chaired by default', visibility: 'PRIVATE', countryTemplateKey: 'builtin:default'}),
      'default-chaired', context('default-chaired'));
    expect((await pool?.query(`SELECT operation_mode FROM committees WHERE id=$1`, [chaired.id]))?.rows).toEqual([{operation_mode: 'CHAIR_OPERATED'}]);
    expect((await pool?.query(`SELECT capability FROM committee_capabilities WHERE committee_id=$1 AND user_id=$2 AND revoked_at IS NULL`,
      [chaired.id, owner.user.id]))?.rows).toEqual([{capability: 'CHAIR'}]);
    expect((await stage4.snapshot(chaired.id, owner)).viewer.audience).toBe('OWNER');

    await identity.updateDefaultCommitteeBehavior(administrator,
      {creatorIsChair: false, operationMode: 'DELEGATE_OPERATED', baseRevision: chairDefault.revision}, context('defaults-delegate'));
    const delegated = await stage4.createCommittee(owner, await testCommitteeInput(pool!, owner, {name: 'Delegate by default', visibility: 'PRIVATE', countryTemplateKey: 'builtin:default'}),
      'default-delegate', context('default-delegate'));
    const overridden = await stage4.createCommittee(owner, await testCommitteeInput(pool!, owner, {name: 'Explicit mode', visibility: 'PRIVATE', operationMode: 'CHAIR_OPERATED',
      countryTemplateKey: 'builtin:default'}), 'default-override', context('default-override'));
    expect((await pool?.query(`SELECT operation_mode FROM committees WHERE id=$1`, [delegated.id]))?.rows).toEqual([{operation_mode: 'DELEGATE_OPERATED'}]);
    expect((await pool?.query(`SELECT count(*)::int AS count FROM committee_capabilities WHERE committee_id=$1 AND revoked_at IS NULL`,
      [delegated.id]))?.rows).toEqual([{count: 0}]);
    expect((await pool?.query(`SELECT operation_mode FROM committees WHERE id=$1`, [overridden.id]))?.rows).toEqual([{operation_mode: 'CHAIR_OPERATED'}]);
    await expect(stage4.createCommittee(administrator, await testCommitteeInput(pool!, administrator, {name: 'Denied', visibility: 'PRIVATE', countryTemplateKey: 'builtin:default'}),
      'admin-denied', context('admin-denied'))).rejects.toMatchObject({code: 'FORBIDDEN'});
  });

  it('clones the built-in countries and creates committees from the restored built-in templates', async () => {
    const owner = await user('builtinowner');
    const clonedCountries = await stage4.cloneCountryTemplate(owner, 'builtin:default', {}, 'clone-default-countries',
      context('clone-default-countries'));
    expect(clonedCountries).toEqual(expect.objectContaining({builtin: false, revision: 1}));
    expect(clonedCountries.countries).toHaveLength(250);

    const emptyCountries = await stage4.createCountryTemplate(owner, {names: {'zh-CN': '空白国家模板'},
      defaultLanguage: 'zh-CN', countryLanguages: ['zh-CN'], countries: []}, 'empty-countries', context('empty-countries'));
    expect(emptyCountries.countries).toEqual([]);

    const builtins = (await stage4.listCommitteeTemplates(owner)).filter(template => template.builtin);
    expect(builtins.map(template => template.key)).toEqual([
      'builtin:african-union', 'builtin:asean', 'builtin:brics', 'builtin:european-union',
      'builtin:g20', 'builtin:nato', 'builtin:un-security-council'
    ]);
    const securityCouncil = builtins.find(template => template.key === 'builtin:un-security-council')!;
    expect(securityCouncil.members.filter(member => member.hasVeto)).toHaveLength(5);

    const committee = await stage4.createCommittee(owner, await testCommitteeInput(pool!, owner, {name: '联合国安全理事会', topic: '和平与安全',
      conference: '测试会场', visibility: 'PRIVATE', committeeTemplateId: securityCouncil.id}),
    'builtin-committee', context('builtin-committee'));
    expect((await pool?.query('SELECT topic,conference,active_rule_package_version_id,source_committee_template_id,temporary_template FROM committees WHERE id=$1',
      [committee.id]))?.rows).toEqual([expect.objectContaining({topic: '和平与安全', conference: '测试会场',
      active_rule_package_version_id: expect.any(String), source_committee_template_id: null, temporary_template: false})]);
    expect((await pool?.query('SELECT count(*)::int AS count FROM committee_seats WHERE committee_id=$1', [committee.id]))?.rows)
      .toEqual([{count: securityCouncil.members.length}]);
  });

  it('round-trips every capability through template update, clone and committee creation', async () => {
    const owner = await user('capabilityowner');
    const members = ['STANDARD', 'NGO', 'OBSERVER'].flatMap((rank, index) => [
      {...committeeTemplate('builtin:default').members[0]!, stableKey: `veto-${index}`, rank, canVote: true, hasVeto: true, mustVote: true},
      {...committeeTemplate('builtin:default').members[0]!, stableKey: `ordinary-${index}`, rank, canVote: true, hasVeto: false, mustVote: false},
      {...committeeTemplate('builtin:default').members[0]!, stableKey: `nonvoter-${index}`, rank, canVote: false, hasVeto: false, mustVote: false}
    ]);
    const input = {...committeeTemplate('builtin:default'), members};
    let template = await stage4.createCommitteeTemplate(owner, input, 'cap-template', context('cap-template'));
    template = await stage4.updateCommitteeTemplate(owner, template.id,
      {baseRevision: template.revision, template: {...input, names: {en: 'Updated capabilities'}}}, context('cap-update'));
    const cloned = await stage4.cloneCommitteeTemplate(owner, template.id, {}, 'cap-clone', context('cap-clone'));
    for (const member of members) expect(cloned.members.find(item => item.stableKey === member.stableKey)).toMatchObject(member);
    const committee = await stage4.createCommittee(owner,
      await testCommitteeInput(pool!, owner, {name: 'Capabilities', visibility: 'PRIVATE', committeeTemplateId: cloned.id}), 'cap-committee', context('cap-committee'));
    const seats = (await stage4.snapshot(committee.id, owner)).seats;
    for (const member of members) expect(seats.find(item => item.stableKey === member.stableKey)).toMatchObject({
      rank: member.rank, canVote: member.canVote, hasVeto: member.hasVeto, mustVote: member.mustVote});
    const seat = seats.find(item => item.hasVeto)!;
    for (const patch of [{canVote: false}, {canVote: false, hasVeto: false}, {rank: 'VETO'}]) {
      await expect(stage4.updateSeat(owner, committee.id, seat.id,
        {baseRevision: seat.revision, patch}, context('invalid-capability'))).rejects.toMatchObject({code: 'VALIDATION_FAILED'});
      await expect(stage4.createSeat(owner, committee.id, {stableKey: 'invalid', canVote: true, hasVeto: true, mustVote: true, ...patch}, 'invalid-create', context('invalid-create')))
        .rejects.toMatchObject({code: 'VALIDATION_FAILED'});
    }
  });

  it('isolates account templates, protects references, snapshots seats, and enforces revisions and Chair capability', async () => {
    await pool!.query('UPDATE system_settings SET default_committee_creator_is_chair=false');
    const owner = await user('templateowner'); const other = await user('templateother'); const chair = await user('templatechair');
    const countries = await stage4.createCountryTemplate(owner, countryTemplate, 'countries-one', context('countries'));
    const retried = await stage4.createCountryTemplate(owner, countryTemplate, 'countries-one', context('countries-retry'));
    expect(retried.id).toBe(countries.id);
    expect((await stage4.listCountryTemplates(administrator)).map(item => item.id)).toEqual(['builtin:default']);
    await expect(stage4.getCountryTemplate(other, countries.id)).rejects.toMatchObject({code: 'NOT_FOUND'});
    await expect(stage4.deleteCountryTemplate(owner, 'builtin:default', context('delete-builtin')))
      .rejects.toMatchObject({code: 'FORBIDDEN'});

    const first = await stage4.createCommitteeTemplate(owner, committeeTemplate(countries.key), 'committee-one', context('template-one'));
    const second = await stage4.createCommitteeTemplate(owner, {...committeeTemplate(countries.key), names: {en: 'Second'}},
      'committee-two', context('template-two'));
    await expect(stage4.deleteCountryTemplate(owner, countries.id, context('delete-used'))).rejects.toMatchObject({
      code: 'RESOURCE_CONFLICT', details: {templates: expect.arrayContaining([expect.objectContaining({id: first.id}), expect.objectContaining({id: second.id})])}
    });
    const clone = await stage4.cloneCommitteeTemplate(owner, first.id, {}, 'clone-one', context('clone'));
    expect(clone.id).not.toBe(first.id);
    await expect(stage4.updateCommitteeTemplate(owner, first.id, {baseRevision: 99, template: committeeTemplate(countries.key)}, context('stale-template')))
      .rejects.toMatchObject({code: 'REVISION_CONFLICT', details: {currentRevision: 1}});

    const committee = await stage4.createCommittee(owner, await testCommitteeInput(pool!, owner, {name: 'Snapshot Council', visibility: 'PRIVATE', committeeTemplateId: first.id}),
      'committee-create', context('committee-create'));
    const seatsBefore = await pool?.query('SELECT stable_key,display_name,rank,can_vote,has_veto,must_vote,flag_type,flag_value FROM committee_seats WHERE committee_id=$1', [committee.id]);
    expect(seatsBefore?.rows).toEqual([expect.objectContaining({stable_key: 'china', display_name: 'China', rank: 'STANDARD',
      can_vote: true, has_veto: true, must_vote: false, flag_type: 'STANDARD', flag_value: 'cn'})]);
    await stage4.updateCommitteeTemplate(owner, first.id, {baseRevision: 1, template: {...committeeTemplate(countries.key),
      members: [{...committeeTemplate(countries.key).members[0]!, names: {en: 'Changed'}, flag: {type: 'EMOJI', value: '🏳️'}}]}}, context('change-source'));
    expect((await pool?.query('SELECT display_name,flag_type,flag_value FROM committee_seats WHERE committee_id=$1', [committee.id]))?.rows)
      .toEqual([{display_name: 'China', flag_type: 'STANDARD', flag_value: 'cn'}]);
    await stage4.deleteCommitteeTemplate(owner, first.id, context('delete-source-template'));
    expect((await pool?.query('SELECT source_committee_template_id FROM committees WHERE id=$1', [committee.id]))?.rows)
      .toEqual([{source_committee_template_id: null}]);
    expect((await pool?.query('SELECT display_name,flag_type,flag_value FROM committee_seats WHERE committee_id=$1', [committee.id]))?.rows)
      .toEqual([{display_name: 'China', flag_type: 'STANDARD', flag_value: 'cn'}]);

    await expect(stage4.createSeat(owner, committee.id, {stableKey: 'france'}, 'owner-seat', context('owner-seat')))
      .rejects.toMatchObject({code: 'FORBIDDEN'});
    await expect(stage4.createSeat(administrator, committee.id, {stableKey: 'france'}, 'admin-seat', context('admin-seat')))
      .rejects.toMatchObject({code: 'FORBIDDEN'});
    const withChair = await stage3.setChair(owner, committee.id, chair.user.email, true, 1, context('grant-chair'));
    expect(withChair.revision).toBe(2);
    const seat = await stage4.createSeat(chair, committee.id, {stableKey: 'france', rank: 'STANDARD', canVote: true, hasVeto: true, mustVote: true}, 'chair-seat', context('chair-seat'));
    await expect(stage4.updateSeat(chair, committee.id, seat.id, {baseRevision: 1,
      patch: {displayName: '法兰西', flag: {type: 'EMOJI', value: '🇫🇷'}}}, context('rename-seat')))
      .rejects.toMatchObject({code: 'VALIDATION_FAILED'});
    const updated = await stage4.updateSeat(chair, committee.id, seat.id, {baseRevision: 1, patch: {sortOrder: 3}}, context('reorder-seat'));
    expect(updated).toMatchObject({displayName: 'France', revision: 2, mustVote: true});
    await expect(stage4.updateSeat(chair, committee.id, seat.id, {baseRevision: 1, patch: {sortOrder: 4}}, context('stale-seat')))
      .rejects.toMatchObject({code: 'REVISION_CONFLICT', details: {currentRevision: 2}});
  });

  it('keeps notes and text posts revisioned, plain-text, permissioned, and soft-deleted', async () => {
    const owner = await user('textowner'); const chair = await user('textchair');
    const firstMember = await user('textmemberone'); const secondMember = await user('textmembertwo');
    const committee = await stage4.createCommittee(owner, await testCommitteeInput(pool!, owner, {name: 'Text Council', visibility: 'PRIVATE',
      countryTemplateKey: 'builtin:default'}), 'text-committee', context('text-committee'));
    await stage3.setChair(owner, committee.id, chair.user.email, true, 1, context('text-chair'));
    const firstSeat = await stage4.createSeat(chair, committee.id, {stableKey: 'one'},
      'text-seat-one', context('text-seat-one'));
    const secondSeat = await stage4.createSeat(chair, committee.id, {stableKey: 'two'},
      'text-seat-two', context('text-seat-two'));
    await stage3.assignSeat(chair, committee.id, {seatId: firstSeat.id, email: firstMember.user.email}, context('assign-one'));
    await stage3.assignSeat(chair, committee.id, {seatId: secondSeat.id, email: secondMember.user.email}, context('assign-two'));

    const note = await stage4.createNote(firstMember, committee.id, {title: 'Agenda', content: '<b>plain</b>'},
      'note-one', context('note-one'));
    expect(note.content).toBe('<b>plain</b>');
    const retried = await stage4.createNote(firstMember, committee.id, {title: 'Agenda', content: '<b>plain</b>'},
      'note-one', context('note-retry'));
    expect(retried.id).toBe(note.id);
    const edited = await stage4.updateNote(secondMember, note.id, {baseRevision: 1, patch: {content: 'shared'}}, context('note-edit'));
    expect(edited).toEqual(expect.objectContaining({content: 'shared', revision: 2}));
    await expect(stage4.updateNote(firstMember, note.id, {baseRevision: 1, patch: {content: 'stale'}}, context('note-stale')))
      .rejects.toMatchObject({code: 'REVISION_CONFLICT', details: {currentRevision: 2}});

    const post = await stage4.createTextPost(firstMember, committee.id, {content: 'member post'},
      'post-one', context('post-one'));
    expect(post).toEqual(expect.objectContaining({authorSeatId: firstSeat.id, authorDisplayName: 'First'}));
    await expect(stage4.updateTextPost(secondMember, post.id, {baseRevision: 1, patch: {content: 'takeover'}}, context('post-takeover')))
      .rejects.toMatchObject({code: 'FORBIDDEN'});
    const chairPost = await stage4.createTextPost(chair, committee.id, {content: 'dictated', onBehalfOfSeatId: secondSeat.id},
      'post-chair', context('post-chair'));
    expect(chairPost).toEqual(expect.objectContaining({authorSeatId: secondSeat.id, authorDisplayName: 'Second', actorUserId: chair.user.id}));
    await stage4.deleteTextPost(owner, post.id, 1, context('post-delete'));
    const stored = await pool?.query('SELECT title,content,revision,deleted_at IS NOT NULL AS deleted FROM committee_text_posts WHERE id=$1', [post.id]);
    expect(stored?.rows).toEqual([{title: '', content: '', revision: 2, deleted: true}]);
    const auditRows = await pool?.query(`SELECT before_summary,after_summary FROM audit_log
      WHERE resource_id=$1 AND action='proceedings.text_post_deleted'`, [post.id]);
    expect(auditRows?.rows[0]?.before_summary).not.toHaveProperty('content');
    expect(auditRows?.rows[0]?.before_summary).toEqual(expect.objectContaining({characterCount: 11, sha256: expect.any(String)}));
  });

  it('serializes roll calls, freezes seat and rule snapshots, and materializes append-only attendance', async () => {
    const owner = await user('rollowner'); const chair = await user('rollchair');
    const committee = await stage4.createCommittee(owner, await testCommitteeInput(pool!, owner, {name: 'Roll Call Council', visibility: 'PRIVATE',
      countryTemplateKey: 'builtin:default'}), 'roll-committee', context('roll-committee'));
    await stage3.setChair(owner, committee.id, chair.user.email, true, 1, context('roll-chair'));
    const first = await stage4.createSeat(chair, committee.id, {stableKey: 'first', sortOrder: 10},
      'roll-seat-first', context('roll-seat-first'));
    const second = await stage4.createSeat(chair, committee.id, {stableKey: 'second', sortOrder: 20},
      'roll-seat-second', context('roll-seat-second'));
    const session = await stage4.startMeetingSession(chair, committee.id, {}, context('meeting-start'), randomUUID());
    expect((await pool?.query(`SELECT l.kind,l.custom_title,l.topic,l.default_speech_ms,l.delegates_can_queue,
      t.remaining_at_start_ms FROM speaker_lists l JOIN timer_states t ON t.id=l.speech_timer_id
      WHERE l.meeting_session_id=$1`, [session.id]))?.rows).toEqual([{
      kind: 'GENERAL', custom_title: null, topic: '', default_speech_ms: '120000',
      delegates_can_queue: true, remaining_at_start_ms: '120000'}]);
    await expect(stage4.startMeetingSession(chair, committee.id, {}, context('meeting-duplicate'), randomUUID()))
      .rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    const started = await stage4.startRollCall(chair, committee.id, {meetingSessionId: session.id},
      'roll-start', context('roll-start'));
    expect(started).toEqual(expect.objectContaining({currentSeatId: first.id, allowedResponses: ['PRESENT', 'PRESENT_AND_VOTING', 'ABSENT']}));
    await expect(stage4.updateSeat(chair, committee.id, first.id, {baseRevision: 1, patch: {displayName: 'Renamed'}}, context('rename-after-freeze')))
      .rejects.toMatchObject({code: 'VALIDATION_FAILED'});

    const competing = await Promise.allSettled([
      stage4.recordRollCallResponse(chair, started.id, {baseRevision: 1, seatId: first.id, response: 'PRESENT'}, context('response-a')),
      stage4.recordRollCallResponse(chair, started.id, {baseRevision: 1, seatId: first.id, response: 'PRESENT'}, context('response-b'))
    ]);
    expect(competing.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(competing.filter(result => result.status === 'rejected')).toHaveLength(1);
    const afterFirst = (competing.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<Stage4Service['recordRollCallResponse']>>>).value;
    expect(afterFirst).toEqual(expect.objectContaining({revision: 2, currentSeatId: second.id}));
    expect(afterFirst.entries[0]).toEqual(expect.objectContaining({seatDisplayName: 'First'}));
    const undone = await stage4.undoRollCallResponse(chair, started.id, {baseRevision: 2}, context('roll-undo'));
    expect(undone).toEqual(expect.objectContaining({revision: 3, currentSeatId: first.id, entries: []}));
    const redone = await stage4.recordRollCallResponse(chair, started.id,
      {baseRevision: 3, seatId: first.id, response: 'PRESENT'}, context('response-redone'));
    const completed = await stage4.recordRollCallResponse(chair, started.id,
      {baseRevision: redone.revision, seatId: second.id, response: 'ABSENT'}, context('response-final'));
    expect(completed).toEqual(expect.objectContaining({status: 'COMPLETED', currentSeatId: null}));
    const attendance = await pool?.query(`SELECT seat_id,state FROM current_attendance
      WHERE meeting_session_id=$1 ORDER BY seat_id`, [session.id]);
    expect(attendance?.rows).toEqual(expect.arrayContaining([
      {seat_id: first.id, state: 'PRESENT'}, {seat_id: second.id, state: 'ABSENT'}
    ]));
    await stage4.createAttendanceEvent(chair, committee.id,
      {meetingSessionId: session.id, seatId: second.id, type: 'RETURNED'}, context('attendance-returned'));
    expect((await pool?.query(`SELECT state FROM current_attendance WHERE meeting_session_id=$1 AND seat_id=$2`,
      [session.id, second.id]))?.rows).toEqual([{state: 'PRESENT'}]);
    expect((await pool?.query(`SELECT type FROM attendance_events WHERE meeting_session_id=$1 AND seat_id=$2 ORDER BY created_at,id`,
      [session.id, second.id]))?.rows).toEqual([{type: 'ABSENT'}, {type: 'RETURNED'}]);
    const closed = await stage4.closeMeetingSession(chair, session.id, {baseRevision: 1}, context('meeting-close'));
    expect(closed.status).toBe('CLOSED');
  });

  it('preserves session attendance snapshots across new sessions and roll calls', async () => {
    const owner = await user('attendance-history');
    const committee = await stage4.createCommittee(owner, await testCommitteeInput(pool!, owner, {
      name: 'Attendance history', visibility: 'PUBLIC', countryTemplateKey: 'builtin:default'}),
      randomUUID(), context('attendance-history'));
    await stage3.setChair(owner, committee.id, owner.user.email, true, 1, context('history-chair'));
    const first = await stage4.createSeat(owner, committee.id, {stableKey: 'first', sortOrder: 10},
      randomUUID(), context('history-first'));
    const second = await stage4.createSeat(owner, committee.id, {stableKey: 'second', sortOrder: 20},
      randomUUID(), context('history-second'));
    const oldSession = await stage4.startMeetingSession(owner, committee.id, {}, context('history-start'), randomUUID());
    await stage4.createAttendanceEvent(owner, committee.id,
      {meetingSessionId: oldSession.id, seatId: first.id, type: 'PRESENT'}, context('history-present'));
    await stage4.createAttendanceEvent(owner, committee.id,
      {meetingSessionId: oldSession.id, seatId: second.id, type: 'ABSENT'}, context('history-absent'));
    const oldAttendance = (await stage4.snapshot(committee.id, owner)).attendance;
    await stage4.closeMeetingSession(owner, oldSession.id, {baseRevision: oldSession.revision}, context('history-close'));
    const newSession = await stage4.startMeetingSession(owner, committee.id, {}, context('history-next'), randomUUID());
    const beforeRollCall = await stage4.snapshot(committee.id, owner);
    expect(beforeRollCall.attendance).toEqual([]);
    expect(beforeRollCall.attendanceBySession?.[oldSession.id]).toEqual(oldAttendance);
    const roll = await stage4.startRollCall(owner, committee.id, {meetingSessionId: newSession.id},
      randomUUID(), context('history-roll'));
    const partial = await stage4.recordRollCallResponse(owner, roll.id,
      {baseRevision: roll.revision, seatId: first.id, response: 'ABSENT'}, context('history-roll-absent'));
    expect((await stage4.snapshot(committee.id, owner)).attendanceBySession?.[oldSession.id]).toEqual(oldAttendance);
    await stage4.recordRollCallResponse(owner, roll.id,
      {baseRevision: partial.revision, seatId: second.id, response: 'PRESENT'}, context('history-roll-present'));
    for (const viewer of [owner, undefined]) {
      const snapshot = await stage4.snapshot(committee.id, viewer);
      expect(snapshot.attendanceBySession?.[oldSession.id]).toEqual(oldAttendance);
      expect(snapshot.attendance).toEqual(expect.arrayContaining([
        expect.objectContaining({seatId: first.id, state: 'ABSENT'}),
        expect.objectContaining({seatId: second.id, state: 'PRESENT'})
      ]));
      expect(snapshot.attendanceBySession?.[newSession.id]).toEqual(snapshot.attendance);
      expect(Object.keys(snapshot.attendanceBySession ?? {}).sort()).toEqual([oldSession.id, newSession.id].sort());
    }
    await expect(stage4.createAttendanceEvent(owner, committee.id,
      {meetingSessionId: oldSession.id, seatId: first.id, type: 'ABSENT'}, context('history-closed-change')))
      .rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
  });

  it('sets and corrects frozen roll-call seats out of order without losing response history', async () => {
    const owner = await user('freeorderowner'); const chair = await user('freeorderchair');
    const committee = await stage4.createCommittee(owner, await testCommitteeInput(pool!, owner, {name: 'Free Order Council', visibility: 'PRIVATE',
      countryTemplateKey: 'builtin:default'}), 'free-order-committee', context('free-order-committee'));
    await stage3.setChair(owner, committee.id, chair.user.email, true, 1, context('free-order-chair'));
    const first = await stage4.createSeat(chair, committee.id, {stableKey: 'first', sortOrder: 10},
      'free-order-first', context('free-order-first'));
    const second = await stage4.createSeat(chair, committee.id, {stableKey: 'second', sortOrder: 20},
      'free-order-second', context('free-order-second'));
    const session = await stage4.startMeetingSession(chair, committee.id, {}, context('free-order-session'), randomUUID());
    const started = await stage4.startRollCall(chair, committee.id, {meetingSessionId: session.id},
      'free-order-start', context('free-order-start'));

    const future = await stage4.setRollCallResponse(chair, started.id,
      {baseRevision: 1, seatId: second.id, response: 'PRESENT'}, context('free-order-future'));
    expect(future).toEqual(expect.objectContaining({revision: 2, currentSeatId: first.id, status: 'IN_PROGRESS'}));
    const corrected = await stage4.setRollCallResponse(chair, started.id,
      {baseRevision: 2, seatId: second.id, response: 'ABSENT'}, context('free-order-correction'));
    expect(corrected.entries).toEqual([expect.objectContaining({seatId: second.id, response: 'ABSENT'})]);
    const history = await pool?.query(`SELECT response,undone_at IS NOT NULL AS undone FROM roll_call_entries
      WHERE roll_call_id=$1 AND seat_id=$2 ORDER BY recorded_at,id`, [started.id, second.id]);
    expect(history?.rows).toEqual([{response: 'PRESENT', undone: true}, {response: 'ABSENT', undone: false}]);

    const completed = await stage4.setRollCallResponse(chair, started.id,
      {baseRevision: 3, seatId: first.id, response: 'PRESENT'}, context('free-order-complete'));
    expect(completed).toEqual(expect.objectContaining({revision: 4, currentSeatId: null, status: 'COMPLETED'}));
    const recorrected = await stage4.setRollCallResponse(chair, started.id,
      {baseRevision: 4, seatId: second.id, response: 'PRESENT'}, context('free-order-after-complete'));
    expect(recorrected).toEqual(expect.objectContaining({revision: 5, currentSeatId: null, status: 'COMPLETED'}));
    expect((await pool?.query(`SELECT state FROM current_attendance WHERE meeting_session_id=$1 AND seat_id=$2`,
      [session.id, second.id]))?.rows).toEqual([{state: 'PRESENT'}]);
  });

  it('enforces operation-mode point actors and resolves personal privilege with linked attendance', async () => {
    const owner = await user('pointowner'); const chair = await user('pointchair'); const member = await user('pointmember');
    const beijing = await pool?.query<{id: string}>(`SELECT v.id FROM rule_package_versions v JOIN rule_packages p ON p.id=v.package_id
      WHERE p.stable_key='builtin:beijing-academic' AND v.status='PUBLISHED' ORDER BY v.version DESC LIMIT 1`);
    const committee = await stage4.createCommittee(owner, await testCommitteeInput(pool!, owner, {name: 'Point Council', visibility: 'PRIVATE', operationMode: 'DELEGATE_OPERATED',
      countryTemplateKey: 'builtin:default', activeRulePackageVersionId: beijing?.rows[0]?.id}),
    'point-committee', context('point-committee'));
    await stage3.setChair(owner, committee.id, chair.user.email, true, 1, context('point-chair'));
    const seat = await stage4.createSeat(chair, committee.id, {stableKey: 'delegate'},
      'point-seat', context('point-seat'));
    await stage3.assignSeat(chair, committee.id, {seatId: seat.id, email: member.user.email}, context('point-assign'));
    const session = await stage4.startMeetingSession(chair, committee.id, {}, context('point-session'), randomUUID());
    await expect(stage4.createPoint(member, committee.id, {meetingSessionId: session.id,
      pointTypeId: 'point-of-order', content: ''}, 'point-empty-delegate', context('point-empty-delegate')))
      .rejects.toMatchObject({code: 'VALIDATION_FAILED'});
    const order = await stage4.createPoint(member, committee.id, {meetingSessionId: session.id,
      pointTypeId: 'point-of-order', content: 'Rules question'}, 'point-order', context('point-order'));
    expect(order).toEqual(expect.objectContaining({raisedBySeatId: seat.id, actorUserId: member.user.id,
      onBehalfOfSeatId: seat.id, interruptRequested: true, rulePackageVersionId: beijing?.rows[0]?.id}));
    await expect(stage4.resolvePoint(chair, order.id, {baseRevision: 1, status: 'ANSWERED',
      attendanceChange: {type: 'TEMPORARILY_LEFT'}}, context('point-invalid-attendance')))
      .rejects.toMatchObject({code: 'VALIDATION_FAILED'});
    const answered = await stage4.resolvePoint(chair, order.id,
      {baseRevision: 1, status: 'ANSWERED', chairResponse: 'Follow rule 1.'}, context('point-answer'));
    expect(answered).toEqual(expect.objectContaining({status: 'ANSWERED', revision: 2, resolvedByUserId: chair.user.id}));
    await expect(stage4.resolvePoint(chair, order.id, {baseRevision: 2, status: 'RESOLVED'}, context('point-repeat')))
      .rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});

    const privilege = await stage4.createPoint(chair, committee.id, {meetingSessionId: session.id,
      pointTypeId: 'point-of-personal-privilege', content: 'Need to leave', onBehalfOfSeatId: seat.id},
    'point-privilege', context('point-privilege'));
    await stage4.resolvePoint(chair, privilege.id, {baseRevision: 1, status: 'RESOLVED',
      chairResponse: 'Granted', attendanceChange: {type: 'TEMPORARILY_LEFT'}}, context('point-privilege-resolve'));
    const linked = await pool?.query(`SELECT e.type,e.source_point_id,a.state FROM attendance_events e
      JOIN current_attendance a ON a.last_event_id=e.id WHERE e.source_point_id=$1`, [privilege.id]);
    expect(linked?.rows).toEqual([{type: 'TEMPORARILY_LEFT', source_point_id: privilege.id, state: 'TEMPORARILY_LEFT'}]);

    const mode = await stage3.setOperationMode(chair, committee.id, 'CHAIR_OPERATED', 2, context('point-chair-operated'));
    expect(mode.operationMode).toBe('CHAIR_OPERATED');
    const withoutReason = await stage4.createPoint(chair, committee.id, {meetingSessionId: session.id,
      pointTypeId: 'point-of-order', content: '', onBehalfOfSeatId: seat.id}, 'point-without-reason', context('point-without-reason'));
    expect(withoutReason.content).toBe('');
    await expect(stage4.createPoint(member, committee.id, {meetingSessionId: session.id,
      pointTypeId: 'point-of-information', content: 'Blocked'}, 'point-blocked', context('point-blocked')))
      .rejects.toMatchObject({code: 'FORBIDDEN'});
  });

  it('filters workspace snapshots by public, member, Chair, Owner, and system-admin audience', async () => {
    const owner = await user('snapshotowner'); const chair = await user('snapshotchair'); const member = await user('snapshotmember');
    const committee = await stage4.createCommittee(owner, await testCommitteeInput(pool!, owner, {name: 'Public Snapshot', visibility: 'PUBLIC',
      countryTemplateKey: 'builtin:default'}), 'snapshot-committee', context('snapshot-committee'));
    await stage3.setChair(owner, committee.id, chair.user.email, true, 1, context('snapshot-chair'));
    const seat = await stage4.createSeat(chair, committee.id, {stableKey: 'snapshot'},
      'snapshot-seat', context('snapshot-seat'));
    await stage3.assignSeat(chair, committee.id, {seatId: seat.id, email: member.user.email}, context('snapshot-assign'));
    await stage4.createNote(member, committee.id, {content: 'members only'}, 'snapshot-note', context('snapshot-note'));

    const publicView = await stage4.snapshot(committee.id);
    expect(publicView.viewer).toEqual({audience: 'PUBLIC', seatId: null});
    expect(publicView.committee).not.toHaveProperty('ownerUserId');
    expect(publicView).toEqual(expect.objectContaining({schemaVersion: 3, notes: [], textPosts: [], attendance: [], points: []}));
    expect(publicView.activeRules).toEqual(expect.objectContaining({versionId: committee.activeRulePackageVersionId,
      attendanceResponses: expect.arrayContaining(['PRESENT', 'ABSENT']), motionTypes: expect.any(Array),
      pointTypes: expect.any(Array), speakerLists: expect.any(Array)}));
    expect(publicView.memberships).toBeUndefined();
    const adminView = await stage4.snapshot(committee.id, administrator);
    expect(adminView.viewer.audience).toBe('PUBLIC');

    const memberView = await stage4.snapshot(committee.id, member);
    expect(memberView.viewer).toEqual({audience: 'MEMBER', seatId: seat.id});
    expect(memberView.notes).toEqual([expect.objectContaining({content: 'members only'})]);
    expect(memberView.memberships).toBeUndefined();
    const chairView = await stage4.snapshot(committee.id, chair);
    expect(chairView.viewer.audience).toBe('CHAIR');
    expect(chairView.memberships).toEqual(expect.arrayContaining([expect.objectContaining({userEmail: member.user.email})]));
    expect(chairView.assignments).toEqual(expect.arrayContaining([expect.objectContaining({seatId: seat.id, userEmail: member.user.email})]));
    const ownerView = await stage4.snapshot(committee.id, owner);
    expect(ownerView.viewer.audience).toBe('OWNER');
    expect(ownerView.committee).toHaveProperty('ownerUserId', owner.user.id);

    const privateCommittee = await stage4.createCommittee(owner, await testCommitteeInput(pool!, owner, {name: 'Private Snapshot', visibility: 'PRIVATE',
      countryTemplateKey: 'builtin:default'}), 'private-snapshot', context('private-snapshot'));
    await expect(stage4.snapshot(privateCommittee.id, administrator)).rejects.toMatchObject({code: 'NOT_FOUND'});
    await expect(stage4.snapshot(privateCommittee.id)).rejects.toMatchObject({code: 'NOT_FOUND'});
  });
});
