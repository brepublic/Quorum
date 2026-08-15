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
let databaseName = ''; let pool: pg.Pool | undefined; let fixtureSequence = 0;
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
  const suffix = String(++fixtureSequence);
  const owner = await user(`owner${suffix}`); const firstChair = await user(`chairone${suffix}`);
  const secondChair = await user(`chairtwo${suffix}`);
  const firstDelegate = await user(`delegateone${suffix}`); const secondDelegate = await user(`delegatetwo${suffix}`);
  const sameSeatDelegate = await user(`delegatethree${suffix}`);
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
  const generalList = (await stage4.snapshot(committee.id, firstChair)).speakerLists?.find(list => list.kind === 'GENERAL');
  if (!generalList) throw new Error('Meeting fixture did not create the main speakers list.');
  return {committee, session, generalList, firstChair, secondChair, firstDelegate, secondDelegate, sameSeatDelegate, firstSeat, secondSeat};
}

integration('PostgreSQL stage 5 high-concurrency proceedings', () => {
  it('serializes two Chairs changing one speaker queue', async () => {
    const fixture = await meetingFixture();
    let list = fixture.generalList;
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

  it('persists old speaker-list settings and masks delegate self-queueing in Chair-operated mode', async () => {
    const fixture = await meetingFixture();
    let list = fixture.generalList;
    list = await stage5.updateSpeakerList(fixture.firstChair, list.id, {baseRevision: list.revision,
      name: '主发言名单', topic: '一般性辩论', defaultSpeechMs: 75_000, delegatesCanQueue: true}, context('legacy-settings'));
    list = await stage5.joinSpeakerQueue(fixture.firstDelegate, list.id, {stance: 'FOR'}, 'delegate-joined',
      context('delegate-joined'));
    expect(list).toMatchObject({name: '主发言名单', topic: '一般性辩论', defaultSpeechMs: 75_000,
      delegatesCanQueue: true});
    expect(list.queue[0]).toMatchObject({seatId: fixture.firstSeat.id, stance: 'FOR', speechDurationMs: 75_000});
    const revision = Number((await pool?.query<{revision: number}>('SELECT revision FROM committees WHERE id=$1',
      [fixture.committee.id]))?.rows[0]?.revision);
    await stage3.setOperationMode(fixture.firstChair, fixture.committee.id, 'CHAIR_OPERATED', revision,
      context('chair-operated'));
    await expect(stage5.joinSpeakerQueue(fixture.secondDelegate, list.id, {stance: 'AGAINST'}, 'masked-join',
      context('masked-join'))).rejects.toMatchObject({code: 'FORBIDDEN'});
    const stored = await pool?.query('SELECT delegates_can_queue FROM speaker_lists WHERE id=$1', [list.id]);
    expect(stored?.rows[0]).toEqual({delegates_can_queue: true});
  });

  it('pairs moderated-caucus timers and preserves remaining state across close and reopen', async () => {
    const fixture = await meetingFixture();
    let list = await stage5.createSpeakerList(fixture.firstChair, fixture.committee.id, {meetingSessionId: fixture.session.id,
      kind: 'MODERATED_CAUCUS', name: '气候融资', topic: '气候融资', defaultSpeechMs: 60_000,
      totalDurationMs: 600_000}, 'paired-list', context('paired-list'));
    list = await stage5.joinSpeakerQueue(fixture.firstChair, list.id, {seatId: fixture.firstSeat.id, stance: 'FOR'},
      'paired-join', context('paired-join'));
    list = await stage5.advanceSpeakerQueue(fixture.firstChair, list.id, {baseRevision: list.revision}, context('paired-stage'));
    let speech = await stage5.commandSpeech(fixture.firstChair, list.id, 'start', {baseRevision: list.revision},
      context('paired-start'));
    let timers = await pool?.query<{id: string; running: boolean}>('SELECT id,running FROM timer_states WHERE id=ANY($1::uuid[])',
      [[list.speechTimerId, list.totalTimerId]]);
    expect(timers?.rows).toHaveLength(2); expect(timers?.rows.every(row => row.running)).toBe(true);
    speech = await stage5.commandSpeech(fixture.firstChair, list.id, 'pause', {baseRevision: speech.revision},
      context('paired-pause'));
    timers = await pool?.query<{id: string; running: boolean}>('SELECT id,running FROM timer_states WHERE id=ANY($1::uuid[])',
      [[list.speechTimerId, list.totalTimerId]]);
    expect(timers?.rows.every(row => !row.running)).toBe(true);
    list = await stage5.setSpeakerListStatus(fixture.firstChair, list.id, {baseRevision: list.revision, status: 'CLOSED'},
      context('paired-close'));
    expect(list.status).toBe('CLOSED');
    expect(list.speeches?.find(item => item.id === speech.id)?.status).toBe('COMPLETED');
    list = await stage5.setSpeakerListStatus(fixture.firstChair, list.id, {baseRevision: list.revision, status: 'OPEN'},
      context('paired-reopen'));
    expect(list).toMatchObject({status: 'OPEN', currentEntryId: expect.any(String), closedAt: null});
  });

  it('records delegate yield offers and keeps accept and reject outcomes auditable', async () => {
    const fixture = await meetingFixture();
    let accepted = fixture.generalList;
    accepted = await stage5.joinSpeakerQueue(fixture.firstChair, accepted.id, {seatId: fixture.firstSeat.id},
      'yield-accepted-first', context('yield-accepted-first'));
    accepted = await stage5.joinSpeakerQueue(fixture.firstChair, accepted.id, {seatId: fixture.secondSeat.id},
      'yield-accepted-second', context('yield-accepted-second'));
    accepted = await stage5.advanceSpeakerQueue(fixture.firstChair, accepted.id, {baseRevision: accepted.revision},
      context('yield-accepted-stage'));
    let speech = await stage5.commandSpeech(fixture.firstChair, accepted.id, 'start', {baseRevision: accepted.revision},
      context('yield-accepted-start'));
    speech = await stage5.commandSpeech(fixture.firstChair, accepted.id, 'pause', {baseRevision: speech.revision},
      context('yield-accepted-pause'));
    speech = await stage5.yieldSpeech(fixture.firstChair, speech.id, {baseRevision: speech.revision, type: 'SEAT',
      targetSeatId: fixture.secondSeat.id}, context('yield-offer'));
    expect(speech).toMatchObject({status: 'PAUSED', yieldDecisionStatus: 'PENDING',
      yieldTargetSeatId: fixture.secondSeat.id});
    accepted = await stage5.decideSpeechYield(fixture.firstChair, speech.id,
      {baseRevision: speech.revision, decision: 'ACCEPT'}, context('yield-accept'));
    expect(accepted.speeches).toEqual(expect.arrayContaining([
      expect.objectContaining({id: speech.id, yieldDecisionStatus: 'ACCEPTED', status: 'COMPLETED'}),
      expect.objectContaining({kind: 'INHERITED', seatId: fixture.secondSeat.id, status: 'READY', canYield: false})
    ]));
    expect(accepted.queue.find(entry => entry.seatId === fixture.secondSeat.id)?.status).toBe('SKIPPED');

    const rejectedFixture = await meetingFixture();
    let rejected = rejectedFixture.generalList;
    rejected = await stage5.joinSpeakerQueue(rejectedFixture.firstChair, rejected.id, {seatId: rejectedFixture.firstSeat.id},
      'yield-rejected-first', context('yield-rejected-first'));
    rejected = await stage5.joinSpeakerQueue(rejectedFixture.firstChair, rejected.id, {seatId: rejectedFixture.secondSeat.id},
      'yield-rejected-second', context('yield-rejected-second'));
    rejected = await stage5.advanceSpeakerQueue(rejectedFixture.firstChair, rejected.id, {baseRevision: rejected.revision},
      context('yield-rejected-stage'));
    let rejectedSpeech = await stage5.commandSpeech(rejectedFixture.firstChair, rejected.id, 'start',
      {baseRevision: rejected.revision}, context('yield-rejected-start'));
    rejectedSpeech = await stage5.commandSpeech(rejectedFixture.firstChair, rejected.id, 'pause',
      {baseRevision: rejectedSpeech.revision}, context('yield-rejected-pause'));
    rejectedSpeech = await stage5.yieldSpeech(rejectedFixture.firstChair, rejectedSpeech.id,
      {baseRevision: rejectedSpeech.revision, type: 'SEAT', targetSeatId: rejectedFixture.secondSeat.id}, context('yield-reject-offer'));
    rejected = await stage5.decideSpeechYield(rejectedFixture.firstChair, rejectedSpeech.id,
      {baseRevision: rejectedSpeech.revision, decision: 'REJECT'}, context('yield-reject'));
    expect(rejected.currentEntryId).toBe(rejected.queue.find(entry => entry.seatId === rejectedFixture.secondSeat.id)?.id);
    const actions = await pool?.query<{action: string}>('SELECT action FROM speech_actions WHERE speech_id=$1 ORDER BY created_at,id',
      [rejectedSpeech.id]);
    expect(actions?.rows.map(row => row.action)).toEqual(['STARTED', 'PAUSED', 'YIELD_OFFERED', 'YIELD_REJECTED']);
  });

  it('models legacy questions and comments without requiring contribution text', async () => {
    const prepare = async (key: string) => {
      const fixture = await meetingFixture();
      let list = fixture.generalList;
      list = await stage5.joinSpeakerQueue(fixture.firstChair, list.id, {seatId: fixture.firstSeat.id},
        `${key}-first`, context(`${key}-first`));
      list = await stage5.joinSpeakerQueue(fixture.firstChair, list.id, {seatId: fixture.secondSeat.id},
        `${key}-second`, context(`${key}-second`));
      list = await stage5.advanceSpeakerQueue(fixture.firstChair, list.id, {baseRevision: list.revision},
        context(`${key}-stage`));
      let speech = await stage5.commandSpeech(fixture.firstChair, list.id, 'start', {baseRevision: list.revision},
        context(`${key}-start`));
      speech = await stage5.commandSpeech(fixture.firstChair, list.id, 'pause', {baseRevision: speech.revision},
        context(`${key}-pause`));
      return {fixture, list, speech};
    };

    const questions = await prepare('questions');
    const answer = await stage5.yieldSpeech(questions.fixture.firstChair, questions.speech.id,
      {baseRevision: questions.speech.revision, type: 'QUESTIONS', targetSeatId: questions.fixture.secondSeat.id},
      context('questions-yield'));
    expect(answer).toMatchObject({kind: 'INHERITED', status: 'READY', seatId: questions.fixture.firstSeat.id,
      yieldType: 'QUESTIONS', interactionTargetSeatId: questions.fixture.secondSeat.id, canYield: false});
    expect(answer.contributions).toEqual([]);
    const runningAnswer = await stage5.commandSpeech(questions.fixture.firstChair, questions.list.id, 'resume',
      {baseRevision: answer.revision}, context('questions-answer-start'));
    expect(runningAnswer.status).toBe('RUNNING');

    const comments = await prepare('comments');
    const comment = await stage5.yieldSpeech(comments.fixture.firstChair, comments.speech.id,
      {baseRevision: comments.speech.revision, type: 'COMMENTS', targetSeatId: comments.fixture.secondSeat.id},
      context('comments-yield'));
    expect(comment).toMatchObject({kind: 'INHERITED', status: 'READY', seatId: comments.fixture.secondSeat.id,
      yieldType: 'COMMENTS', interactionTargetSeatId: comments.fixture.secondSeat.id, canYield: false});
    const commentQueue = await pool?.query<{status: string}>(`SELECT status FROM speaker_queue_entries
      WHERE speaker_list_id=$1 AND seat_id=$2`, [comments.list.id, comments.fixture.secondSeat.id]);
    expect(commentQueue?.rows[0]?.status).toBe('SKIPPED');
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

  it('lets a Chair set, change, and retract any eligible seat vote without deleting history', async () => {
    const fixture = await meetingFixture();
    const motion = await stage5.proposeMotion(fixture.firstDelegate, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'open-unmoderated-caucus',
        parameters: {caucusDuration: 10, caucusUnit: 'min'}},
      'mutable-vote-motion', context('mutable-vote-motion'));
    let ballot = await stage5.createBallot(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, subjectType: 'MOTION', subjectId: motion.id,
        procedural: true, thresholdKind: 'SIMPLE_MAJORITY'}, 'mutable-vote-ballot', context('mutable-vote-ballot'));
    ballot = await stage5.setBallotVote(fixture.firstChair, ballot.id,
      {baseRevision: ballot.revision, choice: 'FOR', onBehalfOfSeatId: fixture.secondSeat.id}, context('set-vote'));
    expect(ballot.votes).toEqual([expect.objectContaining({seatId: fixture.secondSeat.id, choice: 'FOR'})]);
    ballot = await stage5.setBallotVote(fixture.firstChair, ballot.id,
      {baseRevision: ballot.revision, choice: 'AGAINST', onBehalfOfSeatId: fixture.secondSeat.id}, context('change-vote'));
    expect(ballot.votes).toEqual([expect.objectContaining({seatId: fixture.secondSeat.id, choice: 'AGAINST'})]);
    ballot = await stage5.setBallotVote(fixture.firstChair, ballot.id,
      {baseRevision: ballot.revision, choice: null, onBehalfOfSeatId: fixture.secondSeat.id}, context('retract-vote'));
    expect(ballot.votes).toEqual([]);
    const current = await pool?.query(`SELECT current_choice,retracted_at,revision FROM ballot_votes
      WHERE ballot_id=$1 AND seat_id=$2`, [ballot.id, fixture.secondSeat.id]);
    expect(current?.rows[0]).toMatchObject({current_choice: 'AGAINST', revision: 3});
    expect(current?.rows[0]?.retracted_at).toBeTruthy();
    const history = await pool?.query(`SELECT previous_choice,new_choice FROM ballot_vote_revisions
      WHERE ballot_id=$1 AND seat_id=$2 ORDER BY created_at,id`, [ballot.id, fixture.secondSeat.id]);
    expect(history?.rows).toEqual([
      {previous_choice: null, new_choice: 'FOR'},
      {previous_choice: 'FOR', new_choice: 'AGAINST'},
      {previous_choice: 'AGAINST', new_choice: null}
    ]);
  });

  it('keeps old direct motion voting separate, includes non-voting seats by default, and preserves changes', async () => {
    const fixture = await meetingFixture();
    await pool?.query("UPDATE committee_seats SET rank='OBSERVER',can_vote=false WHERE id=$1", [fixture.secondSeat.id]);
    let motion = await stage5.proposeMotion(fixture.firstDelegate, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'open-unmoderated-caucus',
        parameters: {caucusDuration: 10, caucusUnit: 'min'}}, 'direct-motion', context('direct-motion'));
    expect(motion.directVote).toMatchObject({includeNonVotingSeats: true, threshold: 2});
    expect(motion.directVote.eligibility.map(item => item.seatId)).toContain(fixture.secondSeat.id);
    motion = await stage5.setMotionDirectVote(fixture.firstChair, motion.id,
      {choice: 'FOR', onBehalfOfSeatId: fixture.secondSeat.id}, context('direct-for'));
    expect(motion.directVote).toMatchObject({startedAt: expect.any(String), automaticResult: null});
    motion = await stage5.setMotionDirectVote(fixture.firstChair, motion.id,
      {choice: 'AGAINST', onBehalfOfSeatId: fixture.secondSeat.id}, context('direct-change'));
    motion = await stage5.setMotionDirectVote(fixture.firstChair, motion.id,
      {choice: null, onBehalfOfSeatId: fixture.secondSeat.id}, context('direct-retract'));
    expect(motion.directVote.votes).toEqual([]);
    await expect(stage5.setMotionDirectVoteSettings(fixture.firstChair, motion.id,
      {baseRevision: motion.directVote.settingsRevision, includeNonVotingSeats: false}, context('locked-setting')))
      .rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    const history = await pool?.query(`SELECT previous_choice,new_choice FROM motion_direct_vote_revisions
      WHERE motion_id=$1 AND seat_id=$2 ORDER BY created_at,id`, [motion.id, fixture.secondSeat.id]);
    expect(history?.rows).toEqual([{previous_choice: null, new_choice: 'FOR'},
      {previous_choice: 'FOR', new_choice: 'AGAINST'}, {previous_choice: 'AGAINST', new_choice: null}]);
  });

  it('withdraws a pending motion without deleting its rule and proposal history', async () => {
    const fixture = await meetingFixture();
    const motion = await stage5.proposeMotion(fixture.firstDelegate, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'open-unmoderated-caucus'},
      'withdraw-motion', context('withdraw-motion'));
    const withdrawn = await stage5.withdrawMotion(fixture.firstChair, motion.id,
      {baseRevision: motion.revision}, context('withdraw-motion-command'));
    expect(withdrawn).toMatchObject({id: motion.id, status: 'WITHDRAWN', revision: motion.revision + 1,
      motionTypeId: motion.motionTypeId, proposedBySeatId: motion.proposedBySeatId});
    await expect(stage5.withdrawMotion(fixture.firstChair, motion.id,
      {baseRevision: withdrawn.revision}, context('withdraw-motion-again'))).rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    const history = await pool?.query(`SELECT status,decided_by_user_id,decided_at FROM motions WHERE id=$1`, [motion.id]);
    expect(history?.rows[0]).toMatchObject({status: 'WITHDRAWN', decided_by_user_id: fixture.firstChair.user.id});
    expect(history?.rows[0]?.decided_at).toBeTruthy();
  });

  it('introduces an existing empty draft and records its proposer and required seconder atomically', async () => {
    const fixture = await meetingFixture();
    const draft = await stage5.createResolution(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, title: '', content: ''},
      'empty-resolution-draft', context('empty-resolution-draft'));
    expect(draft).toMatchObject({title: 'New draft resolution 1', status: 'DRAFT', proposerSeatId: null,
      seconderSeatId: null, currentVersion: {content: ''}});
    const motion = await stage5.proposeMotion(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'introduce-draft-resolution',
        onBehalfOfSeatId: fixture.firstSeat.id, secondedBySeatId: fixture.secondSeat.id,
        parameters: {resolutionTarget: draft.id}}, 'motion-with-seconder', context('motion-with-seconder'));
    expect(motion).toMatchObject({status: 'SECONDED', proposedBySeatId: fixture.firstSeat.id,
      requiredSecondCount: 1, parameters: {resolutionTarget: draft.id}});
    expect(motion.seconds).toEqual([expect.objectContaining({seatId: fixture.secondSeat.id,
      seatDisplayName: fixture.secondSeat.displayName})]);
    const passed = await stage5.decideMotion(fixture.firstChair, motion.id,
      {baseRevision: motion.revision, result: 'PASSED'}, context('introduce-resolution'));
    expect(passed).toMatchObject({status: 'PASSED', destinationPath:
      `/committees/${fixture.committee.id}/resolutions/${draft.id}`});
    const introduced = await pool?.query(`SELECT d.status,d.is_public,r.proposer_seat_id,r.seconder_seat_id
      FROM documents d JOIN resolutions r ON r.document_id=d.id WHERE d.id=$1`, [draft.id]);
    expect(introduced?.rows[0]).toEqual({status: 'PUBLISHED', is_public: true,
      proposer_seat_id: fixture.firstSeat.id, seconder_seat_id: fixture.secondSeat.id});
  });

  it('creates, introduces, records, and softly deletes amendments without replacing their history', async () => {
    const fixture = await meetingFixture();
    let resolution = await stage5.createResolution(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, title: '', content: 'Resolution body'},
      'amendment-parent', context('amendment-parent'));
    const resolutionMotion = await stage5.proposeMotion(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'introduce-draft-resolution',
        onBehalfOfSeatId: fixture.firstSeat.id, secondedBySeatId: fixture.secondSeat.id,
        parameters: {resolutionTarget: resolution.id}}, 'amendment-parent-motion', context('amendment-parent-motion'));
    await stage5.decideMotion(fixture.firstChair, resolutionMotion.id,
      {baseRevision: resolutionMotion.revision, result: 'PASSED'}, context('amendment-parent-introduced'));
    resolution = (await stage4.snapshot(fixture.committee.id, fixture.firstChair)).documents!
      .find(document => document.id === resolution.id)!;

    const deletedDraft = await stage5.createAmendment(fixture.firstDelegate, resolution.id,
      {meetingSessionId: fixture.session.id, title: '', content: ''}, 'empty-amendment', context('empty-amendment'));
    expect(deletedDraft).toMatchObject({title: 'New amendment 1', status: 'DRAFT', currentVersion: {content: ''}});
    await stage5.deleteAmendment(fixture.firstDelegate, deletedDraft.id, {baseRevision: deletedDraft.revision},
      context('delete-empty-amendment'));
    const retained = await pool?.query(`SELECT deleted_at,deleted_by_user_id FROM documents WHERE id=$1`, [deletedDraft.id]);
    expect(retained?.rows[0]).toMatchObject({deleted_at: expect.any(Date), deleted_by_user_id: fixture.firstDelegate.user.id});
    expect((await stage4.snapshot(fixture.committee.id, fixture.firstChair)).documents?.some(
      document => document.id === deletedDraft.id)).toBe(false);
    expect((await pool?.query(`SELECT count(*)::int AS count FROM audit_log
      WHERE resource_id=$1 AND action='documents.deleted'`, [deletedDraft.id]))?.rows[0]).toEqual({count: 1});

    let amendment = await stage5.createAmendment(fixture.firstDelegate, resolution.id,
      {meetingSessionId: fixture.session.id, title: '', content: ''}, 'introduced-amendment', context('introduced-amendment'));
    amendment = await stage5.createDocumentVersion(fixture.firstDelegate, amendment.id,
      {baseRevision: amendment.revision, title: amendment.title, content: 'Replace operative clause 1.'},
      context('amendment-body'));
    const motion = await stage5.proposeMotion(fixture.firstDelegate, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'introduce-amendment',
        parameters: {amendmentTarget: amendment.id, proposal: amendment.currentVersion.content}},
      'introduce-existing-amendment', context('introduce-existing-amendment'));
    if (motion.status === 'PENDING') await stage5.secondMotion(fixture.firstChair, motion.id,
      {onBehalfOfSeatId: fixture.secondSeat.id}, 'second-existing-amendment', context('second-existing-amendment'));
    const seconded = (await stage4.snapshot(fixture.committee.id, fixture.firstChair)).motions!
      .find(item => item.id === motion.id)!;
    const passed = await stage5.decideMotion(fixture.firstChair, motion.id,
      {baseRevision: seconded.revision, result: 'PASSED'}, context('pass-existing-amendment'));
    expect(passed.destinationPath).toBe(`/committees/${fixture.committee.id}/resolutions/${resolution.id}/amendments`);
    const introduced = (await stage4.snapshot(fixture.committee.id, fixture.firstChair)).documents!
      .find(document => document.id === amendment.id)!;
    expect(introduced).toMatchObject({status: 'PUBLISHED', public: true, proposerSeatId: fixture.firstSeat.id});
    const recorded = await stage5.recordDocumentResult(fixture.firstChair, amendment.id,
      {baseRevision: introduced.revision, outcome: 'INCORPORATED'}, context('incorporate-amendment'));
    expect(recorded).toMatchObject({status: 'INCORPORATED', resultDecisions: [expect.objectContaining({
      previousStatus: 'PUBLISHED', newStatus: 'INCORPORATED'})], votingVersionId: null});
    const corrected = await stage5.recordDocumentResult(fixture.firstChair, amendment.id,
      {baseRevision: recorded.revision, outcome: 'REJECTED', reason: 'Chair corrected the announced result.'},
      context('correct-amendment-result'));
    expect(corrected).toMatchObject({status: 'REJECTED', votingVersionId: null, resultDecisions: [
      expect.objectContaining({previousStatus: 'PUBLISHED', newStatus: 'INCORPORATED', reason: null}),
      expect.objectContaining({previousStatus: 'INCORPORATED', newStatus: 'REJECTED',
        reason: 'Chair corrected the announced result.', correctsDecisionId: recorded.resultDecisions[0]?.id}),
    ]});
    await expect(stage5.deleteAmendment(fixture.firstChair, amendment.id, {baseRevision: corrected.revision},
      context('delete-voted-amendment'))).rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});

    let formal = await stage5.createAmendment(fixture.firstDelegate, resolution.id,
      {meetingSessionId: fixture.session.id, title: '', content: 'Delete operative clause 2.'},
      'formal-amendment', context('formal-amendment'));
    const formalIntroduction = await stage5.proposeMotion(fixture.firstDelegate, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'introduce-amendment',
        parameters: {amendmentTarget: formal.id, proposal: formal.currentVersion.content}},
      'formal-amendment-introduction', context('formal-amendment-introduction'));
    await stage5.decideMotion(fixture.firstChair, formalIntroduction.id,
      {baseRevision: formalIntroduction.revision, result: 'PASSED'}, context('formal-amendment-introduced'));
    formal = (await stage4.snapshot(fixture.committee.id, fixture.firstChair)).documents!
      .find(document => document.id === formal.id)!;
    const voteMotion = await stage5.proposeMotion(fixture.firstDelegate, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'vote-on-amendment',
        parameters: {amendmentTarget: formal.id}}, 'vote-on-amendment', context('vote-on-amendment'));
    const votePassed = await stage5.decideMotion(fixture.firstChair, voteMotion.id,
      {baseRevision: voteMotion.revision, result: 'PASSED'}, context('vote-on-amendment-passed'));
    expect(votePassed.destinationPath).toBe(
      `/committees/${fixture.committee.id}/resolutions/${resolution.id}/amendments`);
    formal = (await stage4.snapshot(fixture.committee.id, fixture.firstChair)).documents!
      .find(document => document.id === formal.id)!;
    expect(formal).toMatchObject({status: 'VOTING', votingVersionId: formal.currentVersion.id});
    await expect(stage5.recordDocumentResult(fixture.firstChair, formal.id,
      {baseRevision: formal.revision, outcome: 'INCORPORATED'}, context('manual-result-after-formal-motion')))
      .rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    const ballot = await stage5.createBallot(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, subjectType: 'AMENDMENT', subjectId: formal.id,
        procedural: false, thresholdKind: 'SIMPLE_MAJORITY'}, 'formal-amendment-ballot', context('formal-amendment-ballot'));
    expect(ballot).toMatchObject({subjectType: 'AMENDMENT', subjectId: formal.id, status: 'OPEN',
      ruleEvaluation: {facts: {subjectVersionId: formal.currentVersion.id}}});
    await expect(stage5.deleteAmendment(fixture.firstChair, formal.id, {baseRevision: formal.revision},
      context('delete-formal-amendment'))).rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
  });

  it('opens the one resolution-linked caucus with its proposer speaking and seconder queued', async () => {
    const fixture = await meetingFixture();
    const draft = await stage5.createResolution(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, title: '', content: 'Draft body'},
      'linked-caucus-draft', context('linked-caucus-draft'));
    const introduction = await stage5.proposeMotion(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'introduce-draft-resolution',
        onBehalfOfSeatId: fixture.firstSeat.id, secondedBySeatId: fixture.secondSeat.id,
        parameters: {resolutionTarget: draft.id}}, 'linked-caucus-introduction', context('linked-caucus-introduction'));
    await stage5.decideMotion(fixture.firstChair, introduction.id,
      {baseRevision: introduction.revision, result: 'PASSED'}, context('linked-caucus-introduced'));

    const motion = await stage5.proposeMotion(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'open-moderated-caucus',
        onBehalfOfSeatId: fixture.secondSeat.id,
        parameters: {proposal: draft.title, resolutionTarget: draft.id, caucusDuration: 10, caucusUnit: 'min',
          speakerDuration: 1, speakerUnit: 'min'}}, 'linked-caucus-motion', context('linked-caucus-motion'));
    const passed = await stage5.decideMotion(fixture.firstChair, motion.id,
      {baseRevision: motion.revision, result: 'PASSED'}, context('linked-caucus-passed'));
    expect(passed).toMatchObject({status: 'PASSED', destinationPath: expect.stringMatching(
      new RegExp(`^/committees/${fixture.committee.id}/caucuses/`))});

    const linked = await pool?.query(`SELECT id,name,topic,linked_resolution_document_id,current_entry_id
      FROM speaker_lists WHERE linked_resolution_document_id=$1`, [draft.id]);
    expect(linked?.rows).toEqual([expect.objectContaining({name: draft.title, topic: draft.title,
      linked_resolution_document_id: draft.id, current_entry_id: expect.any(String)})]);
    const queue = await pool?.query(`SELECT seat_id,position,status,stance FROM speaker_queue_entries
      WHERE speaker_list_id=$1 ORDER BY position`, [linked?.rows[0]?.id]);
    expect(queue?.rows).toEqual([
      {seat_id: fixture.firstSeat.id, position: 1, status: 'CURRENT', stance: 'FOR'},
      {seat_id: fixture.secondSeat.id, position: 2, status: 'QUEUED', stance: 'FOR'}
    ]);
    const snapshot = await stage4.snapshot(fixture.committee.id, fixture.firstChair);
    expect(snapshot.speakerLists).toEqual(expect.arrayContaining([
      expect.objectContaining({id: linked?.rows[0]?.id, linkedResolutionId: draft.id})
    ]));

    const duplicate = await stage5.proposeMotion(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'open-moderated-caucus',
        onBehalfOfSeatId: fixture.firstSeat.id,
        parameters: {proposal: draft.title, resolutionTarget: draft.id, caucusDuration: 10, caucusUnit: 'min',
          speakerDuration: 1, speakerUnit: 'min'}}, 'linked-caucus-duplicate', context('linked-caucus-duplicate'));
    await expect(stage5.decideMotion(fixture.firstChair, duplicate.id,
      {baseRevision: duplicate.revision, result: 'PASSED'}, context('linked-caucus-duplicate-passed')))
      .rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    const effects = await pool?.query(`SELECT
      (SELECT count(*)::int FROM speaker_lists WHERE linked_resolution_document_id=$1) AS lists,
      (SELECT count(*)::int FROM timer_states WHERE owner_id IN
        (SELECT id FROM speaker_lists WHERE linked_resolution_document_id=$1)
        OR owner_id IN (SELECT id FROM caucuses WHERE speaker_list_id IN
          (SELECT id FROM speaker_lists WHERE linked_resolution_document_id=$1))) AS timers`, [draft.id]);
    expect(effects?.rows[0]).toEqual({lists: 1, timers: 2});
  });

  it('keeps the motion and resolution unchanged until an attached body file is published', async () => {
    const fixture = await meetingFixture();
    const bindingId = randomUUID(); const blobId = randomUUID(); const fileId = randomUUID(); const fileVersionId = randomUUID();
    await pool?.query('BEGIN');
    try {
      await pool?.query(`INSERT INTO storage_bindings
        (id,committee_id,provider_type,status,created_by_user_id) VALUES ($1,$2,'SERVER_VOLUME','ACTIVE',$3)`,
      [bindingId, fixture.committee.id, fixture.firstChair.user.id]);
      await pool?.query(`INSERT INTO file_blobs
        (id,committee_id,storage_binding_id,storage_key,size_bytes,sha256,durability_state)
        VALUES ($1,$2,$3,$4,4,$5,'COMMITTED')`,
      [blobId, fixture.committee.id, bindingId, `resolution/${fileId}`, Buffer.alloc(32, 1)]);
      await pool?.query(`INSERT INTO file_entries
        (id,committee_id,logical_name,media_type,status,current_version_id,created_by_user_id)
        VALUES ($1,$2,'Draft body','application/pdf','UPLOAD_COMPLETE',$3,$4)`,
      [fileId, fixture.committee.id, fileVersionId, fixture.firstChair.user.id]);
      await pool?.query(`INSERT INTO file_versions
        (id,committee_id,file_entry_id,version_number,blob_id,original_name,media_type,size_bytes,sha256,created_by_user_id)
        VALUES ($1,$2,$3,1,$4,'draft.pdf','application/pdf',4,$5,$6)`,
      [fileVersionId, fixture.committee.id, fileId, blobId, Buffer.alloc(32, 1), fixture.firstChair.user.id]);
      await pool?.query('COMMIT');
    } catch (error) { await pool?.query('ROLLBACK'); throw error; }
    let draft = await stage5.createResolution(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, title: '', content: ''},
      'file-resolution-draft', context('file-resolution-draft'));
    draft = await stage5.createDocumentVersion(fixture.firstChair, draft.id,
      {baseRevision: draft.revision, title: draft.title, content: '', contentFileEntryId: fileId,
        onBehalfOfSeatId: fixture.firstSeat.id},
      context('attach-resolution-file'));
    expect(draft.currentVersion.contentFile).toMatchObject({id: fileId, status: 'UPLOAD_COMPLETE', originalName: 'draft.pdf'});
    const workspace = await stage4.snapshot(fixture.committee.id, fixture.firstChair);
    expect(workspace.documents?.find(document => document.id === draft.id)?.currentVersion.contentFile)
      .toMatchObject({id: fileId, logicalName: 'Draft body', originalName: 'draft.pdf', status: 'UPLOAD_COMPLETE'});
    const motion = await stage5.proposeMotion(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'introduce-draft-resolution',
        onBehalfOfSeatId: fixture.firstSeat.id, secondedBySeatId: fixture.secondSeat.id,
        parameters: {resolutionTarget: draft.id}}, 'file-resolution-motion', context('file-resolution-motion'));
    await expect(stage5.decideMotion(fixture.firstChair, motion.id,
      {baseRevision: motion.revision, result: 'PASSED'}, context('blocked-file-introduction')))
      .rejects.toMatchObject({code: 'RESOURCE_CONFLICT',
        message: 'Publish the resolution content file before introducing the draft.'});
    expect((await pool?.query('SELECT status FROM motions WHERE id=$1', [motion.id]))?.rows[0]).toEqual({status: 'SECONDED'});
    expect((await pool?.query('SELECT status,is_public FROM documents WHERE id=$1', [draft.id]))?.rows[0])
      .toEqual({status: 'DRAFT', is_public: false});
    await pool?.query("UPDATE file_entries SET status='PENDING_REVIEW',submitted_at=now(),revision=revision+1 WHERE id=$1", [fileId]);
    await pool?.query(`UPDATE file_entries SET status='PUBLISHED',published_at=now(),published_by_user_id=$2,
      revision=revision+1 WHERE id=$1`, [fileId, fixture.firstChair.user.id]);
    const passed = await stage5.decideMotion(fixture.firstChair, motion.id,
      {baseRevision: motion.revision, result: 'PASSED'}, context('published-file-introduction'));
    expect(passed).toMatchObject({status: 'PASSED', destinationPath:
      `/committees/${fixture.committee.id}/resolutions/${draft.id}`});
    let amendment = await stage5.createAmendment(fixture.firstDelegate, draft.id,
      {meetingSessionId: fixture.session.id, title: '', content: ''},
      'file-amendment-draft', context('file-amendment-draft'));
    amendment = await stage5.createDocumentVersion(fixture.firstDelegate, amendment.id,
      {baseRevision: amendment.revision, title: amendment.title, content: '', contentFileEntryId: fileId},
      context('attach-amendment-file'));
    expect(amendment.currentVersion.contentFile).toMatchObject({id: fileId, status: 'PUBLISHED'});
    const amendmentMotion = await stage5.proposeMotion(fixture.firstDelegate, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'introduce-amendment',
        parameters: {amendmentTarget: amendment.id, proposal: amendment.currentVersion.contentFile!.logicalName}},
      'file-amendment-motion', context('file-amendment-motion'));
    const amendmentPassed = await stage5.decideMotion(fixture.firstChair, amendmentMotion.id,
      {baseRevision: amendmentMotion.revision, result: 'PASSED'}, context('file-amendment-introduction'));
    expect(amendmentPassed).toMatchObject({status: 'PASSED', destinationPath:
      `/committees/${fixture.committee.id}/resolutions/${draft.id}/amendments`});
    expect((await pool?.query('SELECT status,is_public FROM documents WHERE id=$1', [amendment.id]))?.rows[0])
      .toEqual({status: 'PUBLISHED', is_public: true});
  });

  it('lets the Chair reject an unseconded motion but not pass it', async () => {
    const fixture = await meetingFixture();
    const draft = await stage5.createResolution(fixture.firstDelegate, fixture.committee.id,
      {meetingSessionId: fixture.session.id, title: '', content: ''},
      'unseconded-resolution-draft', context('unseconded-resolution-draft'));
    const motion = await stage5.proposeMotion(fixture.firstDelegate, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'introduce-draft-resolution',
        parameters: {resolutionTarget: draft.id}}, 'unseconded-motion', context('unseconded-motion'));
    await expect(stage5.decideMotion(fixture.firstChair, motion.id,
      {baseRevision: motion.revision, result: 'PASSED'}, context('pass-unseconded')))
      .rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    const failed = await stage5.decideMotion(fixture.firstChair, motion.id,
      {baseRevision: motion.revision, result: 'FAILED'}, context('fail-unseconded'));
    expect(failed.status).toBe('FAILED');
  });

  it('treats rules as advisory in Chair-operated mode and enacts a passed motion before navigation', async () => {
    const fixture = await meetingFixture();
    await pool?.query("UPDATE committees SET operation_mode='CHAIR_OPERATED' WHERE id=$1", [fixture.committee.id]);
    const draft = await stage5.createResolution(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, title: '', content: ''},
      'chair-resolution-draft', context('chair-resolution-draft'));
    const motion = await stage5.proposeMotion(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'introduce-draft-resolution',
        onBehalfOfSeatId: fixture.firstSeat.id, parameters: {resolutionTarget: draft.id}},
      'chair-advisory-motion', context('chair-advisory-motion'));
    expect(motion).toMatchObject({status: 'PENDING', requiredSecondCount: 1});
    const passed = await stage5.decideMotion(fixture.firstChair, motion.id,
      {baseRevision: motion.revision, result: 'PASSED'}, context('chair-advisory-pass'));
    expect(passed.status).toBe('PASSED');
    expect(passed.destinationPath).toBe(`/committees/${fixture.committee.id}/resolutions/${draft.id}`);
    const created = await pool?.query(`SELECT title,status FROM documents
      WHERE committee_id=$1 AND meeting_session_id=$2`, [fixture.committee.id, fixture.session.id]);
    expect(created?.rows).toEqual([{title: 'New draft resolution 1', status: 'PUBLISHED'}]);
    const audit = await pool?.query(`SELECT after_summary FROM audit_log
      WHERE committee_id=$1 AND action='proceedings.motion_decided' ORDER BY created_at DESC LIMIT 1`,
    [fixture.committee.id]);
    expect(audit?.rows[0]?.after_summary).toMatchObject({status: 'PASSED', advisoryRuleOverride: true});
  });

  it('closes a moderated caucus by motion without discarding its current or waiting queue', async () => {
    const fixture = await meetingFixture();
    await pool?.query("UPDATE committees SET operation_mode='CHAIR_OPERATED' WHERE id=$1", [fixture.committee.id]);
    let list = await stage5.createSpeakerList(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, kind: 'MODERATED_CAUCUS', name: 'Climate finance',
        topic: 'Climate finance', defaultSpeechMs: 60_000, totalDurationMs: 600_000},
      'motion-close-list', context('motion-close-list'));
    list = await stage5.joinSpeakerQueue(fixture.firstChair, list.id, {seatId: fixture.firstSeat.id},
      'motion-close-first', context('motion-close-first'));
    list = await stage5.joinSpeakerQueue(fixture.firstChair, list.id, {seatId: fixture.secondSeat.id},
      'motion-close-second', context('motion-close-second'));
    list = await stage5.advanceSpeakerQueue(fixture.firstChair, list.id, {baseRevision: list.revision},
      context('motion-close-stage'));
    const speech = await stage5.commandSpeech(fixture.firstChair, list.id, 'start', {baseRevision: list.revision},
      context('motion-close-start'));
    const motion = await stage5.proposeMotion(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'close-moderated-caucus',
        onBehalfOfSeatId: fixture.firstSeat.id, parameters: {caucusTarget: list.id}},
      'motion-close', context('motion-close'));
    const passed = await stage5.decideMotion(fixture.firstChair, motion.id,
      {baseRevision: motion.revision, result: 'PASSED'}, context('motion-close-pass'));
    expect(passed.destinationPath).toBe(`/committees/${fixture.committee.id}/caucuses/${list.id}`);
    const storedList = await pool?.query<{status: string; current_entry_id: string | null}>(
      'SELECT status,current_entry_id FROM speaker_lists WHERE id=$1', [list.id]);
    expect(storedList?.rows[0]).toEqual({status: 'CLOSED', current_entry_id: list.currentEntryId});
    const queue = await pool?.query<{status: string}>('SELECT status FROM speaker_queue_entries WHERE speaker_list_id=$1 ORDER BY position',
      [list.id]);
    expect(queue?.rows.map(item => item.status)).toEqual(['CURRENT', 'QUEUED']);
    const timers = await pool?.query<{running: boolean; remaining_at_start_ms: string}>(
      'SELECT running,remaining_at_start_ms FROM timer_states WHERE id=ANY($1::uuid[])',
      [[list.speechTimerId, list.totalTimerId]]);
    expect(timers?.rows).toHaveLength(2);
    expect(timers?.rows.every(timer => !timer.running && Number(timer.remaining_at_start_ms) > 0)).toBe(true);
    const storedSpeech = await pool?.query<{status: string}>('SELECT status FROM speeches WHERE id=$1', [speech.id]);
    expect(storedSpeech?.rows[0]?.status).toBe('COMPLETED');
  });

  it('moves a motion through voting and applies the published ballot result', async () => {
    const fixture = await meetingFixture();
    const motion = await stage5.proposeMotion(fixture.firstDelegate, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'open-unmoderated-caucus',
        parameters: {caucusDuration: 10, caucusUnit: 'min'}},
      'balloted-motion', context('balloted-motion'));
    let ballot = await stage5.createBallot(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, subjectType: 'MOTION', subjectId: motion.id,
        procedural: true, thresholdKind: 'SIMPLE_MAJORITY'}, 'motion-ballot', context('motion-ballot'));
    const voting = await pool?.query('SELECT status,revision FROM motions WHERE id=$1', [motion.id]);
    expect(voting?.rows[0]).toEqual({status: 'VOTING', revision: motion.revision + 1});
    ballot = await stage5.castVote(fixture.firstDelegate, ballot.id, {choice: 'FOR'},
      'motion-vote-one', context('motion-vote-one'));
    ballot = await stage5.castVote(fixture.secondDelegate, ballot.id, {choice: 'FOR'},
      'motion-vote-two', context('motion-vote-two'));
    ballot = await stage5.closeBallot(fixture.firstChair, ballot.id, {baseRevision: ballot.revision},
      context('close-motion-ballot'));
    ballot = await stage5.publishBallot(fixture.firstChair, ballot.id, {baseRevision: ballot.revision},
      context('publish-motion-ballot'));
    expect(ballot.result).toMatchObject({outcome: 'PASSED', forCount: 2});
    const decided = await pool?.query('SELECT status,decided_by_user_id,decided_at,destination_path FROM motions WHERE id=$1', [motion.id]);
    expect(decided?.rows[0]).toMatchObject({status: 'PASSED', decided_by_user_id: fixture.firstChair.user.id,
      destination_path: `/committees/${fixture.committee.id}/unmod`});
    expect(decided?.rows[0]?.decided_at).toBeTruthy();
    const timer = await pool?.query(`SELECT running,remaining_at_start_ms FROM timer_states
      WHERE committee_id=$1 AND owner_type='COMMITTEE' AND owner_id=$1`, [fixture.committee.id]);
    expect(timer?.rows[0]).toEqual({running: false, remaining_at_start_ms: '600000'});
  });

  it('starts, presents results, and reopens a prepared strawpoll', async () => {
    const fixture = await meetingFixture();
    const created = await stage5.createStrawpoll(fixture.firstChair, fixture.committee.id, {
      meetingSessionId: fixture.session.id, question: 'Agenda?', votingMode: 'SEAT_AUTHENTICATED',
      multipleChoice: false, options: []}, 'prepared-strawpoll', context('prepared-strawpoll'));
    const prepared = await stage5.reviseStrawpoll(fixture.firstChair, created.id, {
      baseRevision: created.revision, question: 'Agenda?', votingMode: 'SEAT_AUTHENTICATED',
      multipleChoice: false, options: ['For', 'Against'], medium: 'LINK', optionsArePublic: false},
    'prepare-strawpoll', context('prepare-strawpoll'));
    expect(prepared.stage).toBe('PREPARING');
    const voting = await stage5.commandStrawpollStage(fixture.firstChair, prepared.id,
      {baseRevision: prepared.revision, action: 'START'}, context('start-strawpoll'));
    expect(voting).toMatchObject({stage: 'VOTING', status: 'OPEN', closedAt: null});
    const results = await stage5.commandStrawpollStage(fixture.firstChair, voting.id,
      {baseRevision: voting.revision, action: 'VIEW_RESULTS'}, context('results-strawpoll'));
    expect(results).toMatchObject({stage: 'RESULTS', status: 'CLOSED'});
    const reopened = await stage5.commandStrawpollStage(fixture.firstChair, results.id,
      {baseRevision: results.revision, action: 'REOPEN'}, context('reopen-strawpoll'));
    expect(reopened).toMatchObject({stage: 'VOTING', status: 'OPEN', closedAt: null});
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
    const introduction = await stage5.proposeMotion(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'introduce-draft-resolution',
        onBehalfOfSeatId: fixture.firstSeat.id, secondedBySeatId: fixture.secondSeat.id,
        parameters: {resolutionTarget: resolution.id}}, 'introduce-resolution', context('introduce-resolution'));
    await stage5.decideMotion(fixture.firstChair, introduction.id,
      {baseRevision: introduction.revision, result: 'PASSED'}, context('pass-introduction'));
    resolution = await stage5.createDocumentVersion(fixture.firstDelegate, resolution.id, {baseRevision: resolution.revision + 1,
      title: 'A/RES/1', content: '第二版'}, context('version'));
    const voteMotion = await stage5.proposeMotion(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'vote-on-resolution',
        onBehalfOfSeatId: fixture.firstSeat.id, parameters: {resolutionTarget: resolution.id}},
      'vote-on-resolution', context('vote-on-resolution'));
    const passedVoteMotion = await stage5.decideMotion(fixture.firstChair, voteMotion.id,
      {baseRevision: voteMotion.revision, result: 'PASSED'}, context('pass-vote-on-resolution'));
    expect(passedVoteMotion.destinationPath).toBe(
      `/committees/${fixture.committee.id}/resolutions/${resolution.id}/voting`);
    const votingSnapshot = await stage4.snapshot(fixture.committee.id, fixture.firstChair);
    resolution = votingSnapshot.documents?.find(document => document.id === resolution.id) as typeof resolution;
    expect(resolution.status).toBe('VOTING');
    expect(resolution.votingVersionId).toBe(resolution.currentVersion.id);
    await expect(stage5.createDocumentVersion(fixture.firstDelegate, resolution.id, {baseRevision: resolution.revision,
      title: 'A/RES/1', content: '静默替换'}, context('replace'))).rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
  });
});
