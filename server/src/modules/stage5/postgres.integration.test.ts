// @vitest-environment node

import {expect, it} from 'vitest';
import {createHash, randomUUID} from 'node:crypto';
import {
  pool, stage3, stage4, stage5, context, integration, user, meetingFixture, meetingEndFixture
} from '../../../test/stage5-postgres-fixture';

integration('PostgreSQL stage 5 proceedings', () => {
  it.each(['suspend-meeting', 'adjourn-meeting'])('%s prepares the next session and preserves proceedings when it starts', async motionTypeId => {
    const fixture = await meetingEndFixture();
    await pool!.query("UPDATE committees SET operation_mode='CHAIR_OPERATED' WHERE id=$1", [fixture.committee.id]);
    const motion = await stage5.proposeMotion(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId, onBehalfOfSeatId: fixture.firstSeat.id, parameters: {}},
      'end-session', context('end-session'));
    const passed = await stage5.decideMotion(fixture.firstChair, motion.id,
      {baseRevision: motion.revision, result: 'PASSED'}, context('end-session-pass'));
    const ended = await stage4.snapshot(fixture.committee.id, fixture.firstChair);
    expect(ended.committee.status).toBe('ACTIVE');
    expect(ended.meetingSessions?.find(session => session.id === fixture.session.id)?.status).toBe('CLOSED');
    expect(ended.meetingSession).toMatchObject({status: 'PENDING', name: 'Session 2'});
    expect(ended.meetingSession?.id).not.toBe(fixture.session.id);
    expect(ended.meetingEndedAt).toBe(motionTypeId === 'adjourn-meeting' ? passed.decidedAt : null);
    expect((await stage4.snapshot(fixture.committee.id)).meetingEndedAt).toBe(ended.meetingEndedAt);
    await expect(stage4.startMeetingSession(fixture.firstDelegate, fixture.committee.id, {}, context('unauthorized-start'), randomUUID()))
      .rejects.toMatchObject({code: 'FORBIDDEN'});
    expect((await stage4.snapshot(fixture.committee.id)).meetingEndedAt).toBe(ended.meetingEndedAt);
    const resumed = await stage4.startMeetingSession(fixture.firstChair, fixture.committee.id, {}, context('resume'), randomUUID());
    expect(resumed).toMatchObject({id: ended.meetingSession?.id, status: 'OPEN'});
    const active = await stage4.snapshot(fixture.committee.id, fixture.firstChair);
    expect(active.meetingEndedAt).toBeNull();
    expect(active.speakerLists?.find(list => list.kind === 'GENERAL')).toMatchObject({
      id: fixture.generalList.id, meetingSessionId: resumed.id, speechTimerId: fixture.generalList.speechTimerId,
      status: fixture.generalList.status});
    expect(active.motions?.find(item => item.id === motion.id)).toMatchObject({status: 'PASSED', motionTypeId});
    if (motionTypeId === 'adjourn-meeting') {
      const audit = await pool!.query(`SELECT after_summary FROM audit_log WHERE committee_id=$1
        AND action='proceedings.meeting_session_started' AND resource_id=$2`, [fixture.committee.id, resumed.id]);
      expect(audit.rows[0]?.after_summary).toMatchObject({previousMeetingEndedAt: ended.meetingEndedAt, meetingEndedAt: null});
    }
  });

  it('does not end the meeting when adjournment fails', async () => {
    const fixture = await meetingEndFixture();
    const motion = await stage5.proposeMotion(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'adjourn-meeting', onBehalfOfSeatId: fixture.firstSeat.id, parameters: {}},
      'failed-adjourn', context('failed-adjourn'));
    await stage5.decideMotion(fixture.firstChair, motion.id,
      {baseRevision: motion.revision, result: 'FAILED'}, context('failed-adjourn-result'));
    const snapshot = await stage4.snapshot(fixture.committee.id, fixture.firstChair);
    expect(snapshot.meetingEndedAt).toBeNull();
    expect(snapshot.meetingSession).toMatchObject({id: fixture.session.id, status: 'OPEN'});
    expect(snapshot.meetingSessions).toHaveLength(1);
  });

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
      customTitle: '主发言名单', topic: '一般性辩论', defaultSpeechMs: 75_000, delegatesCanQueue: true}, context('legacy-settings'));
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
      kind: 'MODERATED_CAUCUS', customTitle: '气候融资', topic: '气候融资', defaultSpeechMs: 60_000,
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

  it('allows direct caucus status and timer controls without the removed motions', async () => {
    const fixture = await meetingFixture();
    const list = await stage5.createSpeakerList(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, kind: 'MODERATED_CAUCUS', customTitle: 'Climate finance',
        topic: 'Climate finance', defaultSpeechMs: 60_000, totalDurationMs: 600_000},
      'fixed-caucus-list', context('fixed-caucus-list'));
    const closed = await stage5.setSpeakerListStatus(fixture.firstChair, list.id,
      {baseRevision: list.revision, status: 'CLOSED'}, context('manual-caucus-close'));
    expect(closed.status).toBe('CLOSED');
    const reopened = await stage5.setSpeakerListStatus(fixture.firstChair, list.id,
      {baseRevision: closed.revision, status: 'OPEN'}, context('manual-caucus-reopen'));
    expect(reopened.status).toBe('OPEN');
    const caucusTimer = await pool!.query<{revision: number}>('SELECT revision FROM timer_states WHERE id=$1',
      [list.totalTimerId]);
    const extendedCaucus = await stage5.commandTimer(fixture.firstChair, list.totalTimerId!, 'extend',
      {baseRevision: caucusTimer.rows[0].revision, durationMs: 60_000}, context('extend-caucus-timer'));
    expect(extendedCaucus.remainingAtStartMs).toBe(660_000);
    const resetCaucus = await stage5.commandTimer(fixture.firstChair, list.totalTimerId!, 'reset',
      {baseRevision: extendedCaucus.revision, durationMs: 600_000}, context('reset-caucus-timer'));
    expect(resetCaucus.remainingAtStartMs).toBe(600_000);
    const unmoderated = await stage5.createTimer(fixture.firstChair, fixture.committee.id,
      {ownerType: 'COMMITTEE', ownerId: fixture.committee.id, durationMs: 600_000}, 'fixed-unmoderated',
      context('fixed-unmoderated'));
    const extendedUnmoderated = await stage5.commandTimer(fixture.firstChair, unmoderated.id, 'extend',
      {baseRevision: unmoderated.revision, durationMs: 60_000}, context('extend-unmoderated-timer'));
    expect(extendedUnmoderated.remainingAtStartMs).toBe(660_000);
    const resetUnmoderated = await stage5.commandTimer(fixture.firstChair, unmoderated.id, 'reset',
      {baseRevision: extendedUnmoderated.revision, durationMs: 600_000}, context('reset-unmoderated-timer'));
    expect(resetUnmoderated.remainingAtStartMs).toBe(600_000);
  });
});
