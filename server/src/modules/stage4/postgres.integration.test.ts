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
    currentPassword: created.temporaryPassword, newPassword: `${name}-permanent-password-123`
  }, context(`password-${name}`));
  return identity.authenticate(changed.sessionToken);
}

const countryTemplate = {names: {en: 'Countries', 'zh-CN': '国家'}, defaultLanguage: 'en', countryLanguages: ['en', 'zh-CN'],
  countries: [{stableKey: 'china', names: {en: 'China', 'zh-CN': '中国'}, defaultLanguage: 'en', continent: 'Asia', sortOrder: 1,
    flag: {type: 'STANDARD' as const, value: 'cn'}}]};

const committeeTemplate = (countryTemplateKey: string) => ({names: {en: 'Council'}, defaultLanguage: 'en', countryTemplateKey,
  members: [{stableKey: 'china', names: {en: 'China', 'zh-CN': '中国'}, defaultLanguage: 'en', rank: 'VETO' as const,
    canVote: true, hasVeto: true, mustVote: false, sortOrder: 1, flag: {type: 'STANDARD' as const, value: 'cn'}}]});

integration('PostgreSQL stage 4 templates and seat snapshots', () => {
  it('isolates account templates, protects references, snapshots seats, and enforces revisions and Chair capability', async () => {
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

    const committee = await stage4.createCommittee(owner, {name: 'Snapshot Council', visibility: 'PRIVATE', committeeTemplateId: first.id},
      'committee-create', context('committee-create'));
    const seatsBefore = await pool?.query('SELECT stable_key,display_name,rank,can_vote,has_veto,must_vote,flag_type,flag_value FROM committee_seats WHERE committee_id=$1', [committee.id]);
    expect(seatsBefore?.rows).toEqual([expect.objectContaining({stable_key: 'china', display_name: 'China', rank: 'VETO',
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

    await expect(stage4.createSeat(owner, committee.id, {stableKey: 'france', displayName: 'France'}, 'owner-seat', context('owner-seat')))
      .rejects.toMatchObject({code: 'FORBIDDEN'});
    await expect(stage4.createSeat(administrator, committee.id, {stableKey: 'france', displayName: 'France'}, 'admin-seat', context('admin-seat')))
      .rejects.toMatchObject({code: 'FORBIDDEN'});
    const withChair = await stage3.setChair(owner, committee.id, chair.user.id, true, 1, context('grant-chair'));
    expect(withChair.revision).toBe(2);
    const seat = await stage4.createSeat(chair, committee.id, {stableKey: 'france', displayName: 'France', rank: 'VETO',
      canVote: true, hasVeto: true, mustVote: true, flag: {type: 'STANDARD', value: 'fr'}}, 'chair-seat', context('chair-seat'));
    const renamed = await stage4.updateSeat(chair, committee.id, seat.id, {baseRevision: 1,
      patch: {displayName: '法兰西', flag: {type: 'EMOJI', value: '🇫🇷'}}}, context('rename-seat'));
    expect(renamed).toEqual(expect.objectContaining({displayName: '法兰西', revision: 2, mustVote: true}));
    await expect(stage4.updateSeat(chair, committee.id, seat.id, {baseRevision: 1, patch: {sortOrder: 4}}, context('stale-seat')))
      .rejects.toMatchObject({code: 'REVISION_CONFLICT', details: {currentRevision: 2}});
  });

  it('keeps notes and text posts revisioned, plain-text, permissioned, and soft-deleted', async () => {
    const owner = await user('textowner'); const chair = await user('textchair');
    const firstMember = await user('textmemberone'); const secondMember = await user('textmembertwo');
    const committee = await stage4.createCommittee(owner, {name: 'Text Council', visibility: 'PRIVATE',
      countryTemplateKey: 'builtin:default'}, 'text-committee', context('text-committee'));
    await stage3.setChair(owner, committee.id, chair.user.id, true, 1, context('text-chair'));
    const firstSeat = await stage4.createSeat(chair, committee.id, {stableKey: 'one', displayName: 'First'},
      'text-seat-one', context('text-seat-one'));
    const secondSeat = await stage4.createSeat(chair, committee.id, {stableKey: 'two', displayName: 'Second'},
      'text-seat-two', context('text-seat-two'));
    await stage3.assignSeat(chair, committee.id, {seatId: firstSeat.id, userId: firstMember.user.id}, context('assign-one'));
    await stage3.assignSeat(chair, committee.id, {seatId: secondSeat.id, userId: secondMember.user.id}, context('assign-two'));

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
    const committee = await stage4.createCommittee(owner, {name: 'Roll Call Council', visibility: 'PRIVATE',
      countryTemplateKey: 'builtin:default'}, 'roll-committee', context('roll-committee'));
    await stage3.setChair(owner, committee.id, chair.user.id, true, 1, context('roll-chair'));
    const first = await stage4.createSeat(chair, committee.id, {stableKey: 'first', displayName: 'First', sortOrder: 10},
      'roll-seat-first', context('roll-seat-first'));
    const second = await stage4.createSeat(chair, committee.id, {stableKey: 'second', displayName: 'Second', sortOrder: 20},
      'roll-seat-second', context('roll-seat-second'));
    const session = await stage4.startMeetingSession(chair, committee.id, {}, context('meeting-start'));
    await expect(stage4.startMeetingSession(chair, committee.id, {}, context('meeting-duplicate')))
      .rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    const started = await stage4.startRollCall(chair, committee.id, {meetingSessionId: session.id},
      'roll-start', context('roll-start'));
    expect(started).toEqual(expect.objectContaining({currentSeatId: first.id, allowedResponses: ['PRESENT', 'ABSENT']}));
    await stage4.updateSeat(chair, committee.id, first.id, {baseRevision: 1, patch: {displayName: 'Renamed'}}, context('rename-after-freeze'));

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

  it('enforces operation-mode point actors and resolves personal privilege with linked attendance', async () => {
    const owner = await user('pointowner'); const chair = await user('pointchair'); const member = await user('pointmember');
    const beijing = await pool?.query<{id: string}>(`SELECT v.id FROM rule_package_versions v JOIN rule_packages p ON p.id=v.package_id
      WHERE p.stable_key='builtin:beijing-academic' AND v.status='PUBLISHED'`);
    const committee = await stage4.createCommittee(owner, {name: 'Point Council', visibility: 'PRIVATE',
      countryTemplateKey: 'builtin:default', activeRulePackageVersionId: beijing?.rows[0]?.id},
    'point-committee', context('point-committee'));
    await stage3.setChair(owner, committee.id, chair.user.id, true, 1, context('point-chair'));
    const seat = await stage4.createSeat(chair, committee.id, {stableKey: 'delegate', displayName: 'Delegate'},
      'point-seat', context('point-seat'));
    await stage3.assignSeat(chair, committee.id, {seatId: seat.id, userId: member.user.id}, context('point-assign'));
    const session = await stage4.startMeetingSession(chair, committee.id, {}, context('point-session'));
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
    await expect(stage4.createPoint(member, committee.id, {meetingSessionId: session.id,
      pointTypeId: 'point-of-information', content: 'Blocked'}, 'point-blocked', context('point-blocked')))
      .rejects.toMatchObject({code: 'FORBIDDEN'});
  });

  it('filters workspace snapshots by public, member, Chair, Owner, and system-admin audience', async () => {
    const owner = await user('snapshotowner'); const chair = await user('snapshotchair'); const member = await user('snapshotmember');
    const committee = await stage4.createCommittee(owner, {name: 'Public Snapshot', visibility: 'PUBLIC',
      countryTemplateKey: 'builtin:default'}, 'snapshot-committee', context('snapshot-committee'));
    await stage3.setChair(owner, committee.id, chair.user.id, true, 1, context('snapshot-chair'));
    const seat = await stage4.createSeat(chair, committee.id, {stableKey: 'snapshot', displayName: 'Snapshot Seat'},
      'snapshot-seat', context('snapshot-seat'));
    await stage3.assignSeat(chair, committee.id, {seatId: seat.id, userId: member.user.id}, context('snapshot-assign'));
    await stage4.createNote(member, committee.id, {content: 'members only'}, 'snapshot-note', context('snapshot-note'));

    const publicView = await stage4.snapshot(committee.id);
    expect(publicView.viewer).toEqual({audience: 'PUBLIC', seatId: null});
    expect(publicView.committee).not.toHaveProperty('ownerUserId');
    expect(publicView).toEqual(expect.objectContaining({schemaVersion: 2, notes: [], textPosts: [], attendance: [], points: []}));
    expect(publicView.memberships).toBeUndefined();
    const adminView = await stage4.snapshot(committee.id, administrator);
    expect(adminView.viewer.audience).toBe('PUBLIC');

    const memberView = await stage4.snapshot(committee.id, member);
    expect(memberView.viewer).toEqual({audience: 'MEMBER', seatId: seat.id});
    expect(memberView.notes).toEqual([expect.objectContaining({content: 'members only'})]);
    expect(memberView.memberships).toBeUndefined();
    const chairView = await stage4.snapshot(committee.id, chair);
    expect(chairView.viewer.audience).toBe('CHAIR');
    expect(chairView.memberships).toEqual(expect.arrayContaining([expect.objectContaining({userId: member.user.id})]));
    expect(chairView.assignments).toEqual(expect.arrayContaining([expect.objectContaining({seatId: seat.id, userId: member.user.id})]));
    const ownerView = await stage4.snapshot(committee.id, owner);
    expect(ownerView.viewer.audience).toBe('OWNER');
    expect(ownerView.committee).toHaveProperty('ownerUserId', owner.user.id);

    const privateCommittee = await stage4.createCommittee(owner, {name: 'Private Snapshot', visibility: 'PRIVATE',
      countryTemplateKey: 'builtin:default'}, 'private-snapshot', context('private-snapshot'));
    await expect(stage4.snapshot(privateCommittee.id, administrator)).rejects.toMatchObject({code: 'NOT_FOUND'});
    await expect(stage4.snapshot(privateCommittee.id)).rejects.toMatchObject({code: 'NOT_FOUND'});
  });
});
