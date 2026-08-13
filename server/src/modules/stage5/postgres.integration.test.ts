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
import {Stage4Service} from '../stage4/service';
import {Stage5Service} from './service';

const {Client, Pool} = pg;
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const integration = adminUrl ? describe : describe.skip;
let databaseName = ''; let pool: pg.Pool | undefined;
let identity: IdentityService; let stage3: Stage3Service; let stage4: Stage4Service; let stage5: Stage5Service;
let administrator: AuthenticatedSession;

function quoteIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
const context = (name: string) => ({requestId: `stage5-${name}`, sourceIp: '127.0.0.1', userAgent: 'Vitest'});

beforeEach(async () => {
  if (!adminUrl) return;
  databaseName = `quorum_stage5_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(adminUrl); url.pathname = `/${databaseName}`;
  const admin = new Client({connectionString: adminUrl}); await admin.connect();
  try { await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`); } finally { await admin.end(); }
  pool = new Pool({connectionString: url.toString()}); await runMigrations(pool, resolve('server/migrations'));
  identity = new IdentityService(new PostgresIdentityStore(pool)); stage3 = new Stage3Service(pool);
  stage4 = new Stage4Service(pool); stage5 = new Stage5Service(pool); await stage3.ensureBuiltins();
  const secret = await identity.ensureBootstrapSecret();
  const login = await identity.bootstrapAdmin({secret: secret as string, email: 'admin@example.com',
    displayName: 'System Admin', password: 'admin-password-123'}, context('bootstrap'));
  administrator = await identity.authenticate(login.sessionToken);
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

async function meetingFixture() {
  const owner = await user('owner'); const firstChair = await user('chairone'); const secondChair = await user('chairtwo');
  const firstDelegate = await user('delegateone'); const secondDelegate = await user('delegatetwo');
  const sameSeatDelegate = await user('delegatethree');
  const committee = await stage4.createCommittee(owner, {name: 'Stage 5 Council', visibility: 'PUBLIC',
    countryTemplateKey: 'builtin:default'}, 'committee', context('committee'));
  let revised = await stage3.setChair(owner, committee.id, firstChair.user.id, true, committee.revision, context('chair-one'));
  revised = await stage3.setChair(owner, committee.id, secondChair.user.id, true, revised.revision, context('chair-two'));
  const firstSeat = await stage4.createSeat(firstChair, committee.id, {stableKey: 'first', displayName: 'First', canVote: true},
    'seat-first', context('seat-first'));
  const secondSeat = await stage4.createSeat(firstChair, committee.id, {stableKey: 'second', displayName: 'Second', canVote: true},
    'seat-second', context('seat-second'));
  await stage3.assignSeat(firstChair, committee.id, {seatId: firstSeat.id, userId: firstDelegate.user.id}, context('assign-first'));
  await stage3.assignSeat(firstChair, committee.id, {seatId: secondSeat.id, userId: secondDelegate.user.id}, context('assign-second'));
  await stage3.assignSeat(firstChair, committee.id, {seatId: firstSeat.id, userId: sameSeatDelegate.user.id}, context('assign-third'));
  const session = await stage4.startMeetingSession(firstChair, committee.id, {}, context('meeting'));
  await stage4.createAttendanceEvent(firstChair, committee.id,
    {meetingSessionId: session.id, seatId: firstSeat.id, type: 'PRESENT'}, context('present-first'));
  await stage4.createAttendanceEvent(firstChair, committee.id,
    {meetingSessionId: session.id, seatId: secondSeat.id, type: 'PRESENT'}, context('present-second'));
  return {committee, session, firstChair, secondChair, firstDelegate, secondDelegate, sameSeatDelegate, firstSeat, secondSeat};
}

integration('PostgreSQL stage 5 high-concurrency proceedings', () => {
  it('serializes two Chairs changing one speaker queue', async () => {
    const fixture = await meetingFixture();
    let list = await stage5.createSpeakerList(fixture.firstChair, fixture.committee.id, {meetingSessionId: fixture.session.id,
      kind: 'GENERAL', topic: '', defaultSpeechMs: 60_000}, 'list', context('list'));
    list = await stage5.joinSpeakerQueue(fixture.firstDelegate, list.id, {}, 'join-one', context('join-one'));
    list = await stage5.joinSpeakerQueue(fixture.secondDelegate, list.id, {}, 'join-two', context('join-two'));
    const ids = list.queue.map(entry => entry.id);
    const raced = await Promise.allSettled([
      stage5.reorderSpeakerQueue(fixture.firstChair, list.id, {baseRevision: list.revision, entryIds: ids}, context('reorder-one')),
      stage5.reorderSpeakerQueue(fixture.secondChair, list.id, {baseRevision: list.revision, entryIds: [...ids].reverse()}, context('reorder-two'))
    ]);
    expect(raced.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter(result => result.status === 'rejected')).toHaveLength(1);
    const positions = await pool?.query(`SELECT position,status FROM speaker_queue_entries WHERE speaker_list_id=$1
      AND status IN ('QUEUED','CURRENT') ORDER BY position`, [list.id]);
    expect(positions?.rows.map(row => row.position)).toEqual([1, 2]);
    expect(positions?.rows.filter(row => row.status === 'CURRENT')).toHaveLength(0);
  });

  it('allows only one concurrent vote from representatives of the same seat', async () => {
    const fixture = await meetingFixture();
    const motion = await stage5.proposeMotion(fixture.firstDelegate, fixture.committee.id, {meetingSessionId: fixture.session.id,
      motionTypeId: 'open-unmoderated-caucus'}, 'motion', context('motion'));
    const ballot = await stage5.createBallot(fixture.firstChair, fixture.committee.id, {meetingSessionId: fixture.session.id,
      subjectType: 'MOTION', subjectId: motion.id, procedural: true, thresholdKind: 'SIMPLE_MAJORITY'},
    'ballot', context('ballot'));
    const raced = await Promise.allSettled([
      stage5.castVote(fixture.firstDelegate, ballot.id, {choice: 'FOR'}, 'vote-one', context('vote-one')),
      stage5.castVote(fixture.sameSeatDelegate, ballot.id, {choice: 'AGAINST'}, 'vote-two', context('vote-two'))
    ]);
    expect(raced.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter(result => result.status === 'rejected')).toHaveLength(1);
    const votes = await pool?.query('SELECT seat_id FROM ballot_votes WHERE ballot_id=$1', [ballot.id]);
    expect(votes?.rows).toEqual([{seat_id: fixture.firstSeat.id}]);
  });

  it('separates anonymous selections and freezes a document version under vote', async () => {
    const fixture = await meetingFixture();
    const strawpoll = await stage5.createStrawpoll(fixture.firstChair, fixture.committee.id, {meetingSessionId: fixture.session.id,
      question: '支持？', votingMode: 'ANONYMOUS', multipleChoice: false, options: ['赞成', '反对']},
    'strawpoll', context('strawpoll'));
    await stage5.voteStrawpoll(fixture.firstDelegate, strawpoll.id, {optionIds: [strawpoll.options[0]?.id],
      anonymousAccessToken: strawpoll.anonymousAccessToken}, 'anonymous-vote', context('anonymous-vote'));
    const anonymous = await pool?.query(`SELECT
      (SELECT count(*)::int FROM strawpoll_anonymous_receipts WHERE strawpoll_id=$1) AS receipts,
      (SELECT count(*)::int FROM strawpoll_anonymous_votes WHERE strawpoll_id=$1) AS votes`, [strawpoll.id]);
    expect(anonymous?.rows[0]).toEqual({receipts: 1, votes: 1});
    expect(JSON.stringify(await pool?.query(`SELECT after_summary FROM audit_log
      WHERE resource_id=$1 AND action='voting.strawpoll_vote_recorded'`, [strawpoll.id])))
      .not.toContain(strawpoll.options[0]?.id);

    let resolution = await stage5.createResolution(fixture.firstDelegate, fixture.committee.id, {
      meetingSessionId: fixture.session.id, title: 'A/RES/1', content: '第一版'}, 'resolution', context('resolution'));
    resolution = await stage5.commandDocument(fixture.firstChair, resolution.id, {baseRevision: resolution.revision,
      action: 'PUBLISH', ruleStableId: 'introduce-draft-resolution'}, context('publish'));
    resolution = await stage5.createDocumentVersion(fixture.firstDelegate, resolution.id, {baseRevision: resolution.revision,
      title: 'A/RES/1', content: '第二版'}, context('version'));
    resolution = await stage5.commandDocument(fixture.firstChair, resolution.id, {baseRevision: resolution.revision,
      action: 'RECOMMEND_BALLOT', ruleStableId: 'vote-on-resolution'}, context('recommend'));
    expect(resolution.votingVersionId).toBe(resolution.currentVersion.id);
    await expect(stage5.createDocumentVersion(fixture.firstDelegate, resolution.id, {baseRevision: resolution.revision,
      title: 'A/RES/1', content: '静默替换'}, context('replace'))).rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
  });
});
