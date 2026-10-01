// @vitest-environment node

import {expect, it} from 'vitest';
import {createHash, randomUUID} from 'node:crypto';
import {
  pool, stage3, stage4, stage5, context, integration, user, meetingFixture
} from '../../../test/stage5-postgres-fixture';

integration('PostgreSQL stage 5 voting', () => {
  it('separates procedural and substantive voters while keeping strawpolls open to file-only seats', async () => {
    const f = await meetingFixture(true);
    await stage4.updateSeat(f.firstChair, f.committee.id, f.secondSeat.id,
      {baseRevision: f.secondSeat.revision, patch: {canVote: false}}, context('procedural-only'));
    const media = await stage4.createSeat(f.firstChair, f.committee.id,
      {stableKey: 'other', rank: 'MEDIA'}, randomUUID(), context('file-only'));
    const mediaDelegate = await user('media-rights');
    await stage3.assignSeat(f.firstChair, f.committee.id,
      {seatId: media.id, email: mediaDelegate.user.email}, context('assign-media'));
    const input = {meetingSessionId: f.session.id, motionTypeId: 'open-unmoderated-caucus',
      parameters: {caucusDuration: 10, caucusUnit: 'min'}};
    await expect(stage5.proposeMotion(mediaDelegate, f.committee.id, input,
      randomUUID(), context('media-motion'))).rejects.toMatchObject({reason: 'PRESENT_SEAT_REQUIRED'});
    const motion = await stage5.proposeMotion(f.firstDelegate, f.committee.id, input,
      randomUUID(), context('procedural-motion'));
    expect(motion.directVote?.eligibility.map(seat => seat.seatId)).toEqual([f.firstSeat.id, f.secondSeat.id]);
    expect(motion.directVote?.threshold).toBe(2);
    await expect(stage5.secondMotion(mediaDelegate, motion.id, {}, randomUUID(), context('media-second')))
      .rejects.toMatchObject({reason: 'PRESENT_SEAT_REQUIRED'});
    await stage5.secondMotion(f.secondDelegate, motion.id, {}, randomUUID(), context('procedural-second'));
    await expect(stage5.setMotionDirectVote(f.firstChair, motion.id,
      {onBehalfOfSeatId: media.id, choice: 'FOR'}, context('media-vote'))).rejects.toMatchObject({code: 'FORBIDDEN'});
    const recorded = await stage5.setMotionDirectVote(f.firstChair, motion.id,
      {onBehalfOfSeatId: f.secondSeat.id, choice: 'FOR'}, context('procedural-vote'));
    expect(recorded.directVote?.votes).toContainEqual(expect.objectContaining({seatId: f.secondSeat.id}));
    const ballot = await stage5.createBallot(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, subjectType: 'MOTION', subjectId: motion.id,
        procedural: true, thresholdKind: 'TWO_THIRDS'}, randomUUID(), context('procedural-ballot'));
    expect(ballot.eligibility.map(seat => seat.seatId)).toEqual([f.firstSeat.id, f.secondSeat.id]);
    expect(ballot.threshold.value).toBe(2);
    await stage5.castVote(f.secondDelegate, ballot.id, {choice: 'FOR'}, randomUUID(), context('procedural-ballot-vote'));
    const document = await stage5.createResolution(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, customTitle: null, content: 'Vote'}, randomUUID(), context('substantive-document'));
    const direct = await stage5.setResolutionDirectVote(f.firstChair, document.id,
      {seatId: f.firstSeat.id, choice: 'FOR'}, context('substantive-vote'));
    expect(direct.directVote?.eligibility.map(seat => seat.seatId)).toEqual([f.firstSeat.id]);
    expect(direct.directVote?.threshold).toBe(1);
    await expect(stage5.setResolutionDirectVote(f.firstChair, document.id,
      {seatId: f.secondSeat.id, choice: 'FOR'}, context('nonvoting-document'))).rejects.toMatchObject({code: 'FORBIDDEN'});
    const poll = await stage5.createStrawpoll(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, question: 'Views?', votingMode: 'SEAT_AUTHENTICATED',
        multipleChoice: false, options: ['For', 'Against']}, randomUUID(), context('all-seats-poll'));
    const voted = await stage5.voteStrawpoll(mediaDelegate, poll.id,
      {optionIds: [poll.options[0]!.id]}, randomUUID(), context('media-poll-vote'));
    expect(voted.seatVotes).toContainEqual(expect.objectContaining({seatId: media.id}));
  });

  it('records one vote under concurrent submissions and returns precise duplicate and undo reasons', async () => {
    const f = await meetingFixture();
    const document = await stage5.createResolution(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, customTitle: null, content: ''}, randomUUID(), context('rapid-document'));
    const raced = await Promise.allSettled([
      stage5.setResolutionDirectVote(f.firstChair, document.id,
        {seatId: f.firstSeat.id, choice: 'FOR'}, context('rapid-one')),
      stage5.setResolutionDirectVote(f.secondChair, document.id,
        {seatId: f.firstSeat.id, choice: 'FOR'}, context('rapid-two'))
    ]);
    expect(raced.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(raced.find(result => result.status === 'rejected')).toMatchObject({status: 'rejected',
      reason: {code: 'RESOURCE_CONFLICT', reason: 'VOTE_ALREADY_RECORDED'}});
    const history = await pool!.query('SELECT new_choice FROM document_direct_vote_revisions WHERE document_id=$1', [document.id]);
    expect(history.rows).toEqual([{new_choice: 'FOR'}]);
    await stage5.setResolutionDirectVote(f.firstChair, document.id,
      {seatId: f.firstSeat.id, choice: null}, context('rapid-undo'));
    await expect(stage5.setResolutionDirectVote(f.firstChair, document.id,
      {seatId: f.firstSeat.id, choice: null}, context('rapid-undo-again')))
      .rejects.toMatchObject({code: 'RESOURCE_CONFLICT', reason: 'NO_VOTE_TO_UNDO'});
  });

  it('submits a complete resolution vote atomically, retries once, and keeps later corrections separate', async () => {
    const f = await meetingFixture();
    const document = await stage5.createResolution(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, customTitle: null, content: 'Text'}, randomUUID(), context('batch-document'));
    const direct = document.directVote!;
    const request = {baseDocumentRevision: document.revision, baseSettingsRevision: direct.settingsRevision,
      baseCastRevision: direct.castRevision, eligibility: direct.eligibility,
      votes: [{seatId: f.firstSeat.id, choice: 'FOR'}, {seatId: f.secondSeat.id, choice: 'AGAINST'}]};
    await expect(stage5.submitResolutionDirectVote(f.firstChair, document.id,
      {...request, votes: request.votes.slice(0, 1)}, randomUUID(), context('batch-incomplete')))
      .rejects.toMatchObject({code: 'REVISION_CONFLICT'});
    expect((await pool!.query('SELECT 1 FROM document_direct_votes WHERE document_id=$1',
      [document.id])).rowCount).toBe(0);
    const key = randomUUID();
    const submitted = await stage5.submitResolutionDirectVote(f.firstChair, document.id,
      request, key, context('batch-submit'));
    expect(submitted.directVote).toMatchObject({castRevision: 1, completedAt: expect.any(String),
      votes: expect.arrayContaining([{seatId: f.firstSeat.id, choice: 'FOR',
        id: expect.any(String), seatDisplayName: expect.any(String), revision: 1, castAt: expect.any(String)}])});
    await stage5.submitResolutionDirectVote(f.firstChair, document.id, request, key, context('batch-retry'));
    expect((await pool!.query('SELECT 1 FROM document_direct_vote_revisions WHERE document_id=$1',
      [document.id])).rowCount).toBe(2);
    await expect(stage5.submitResolutionDirectVote(f.secondChair, document.id,
      request, randomUUID(), context('batch-stale'))).rejects.toMatchObject({code: 'REVISION_CONFLICT'});
    const corrected = await stage5.setResolutionDirectVote(f.firstChair, document.id,
      {seatId: f.firstSeat.id, choice: 'AGAINST'}, context('batch-correction'));
    expect(corrected.directVote).toMatchObject({castRevision: 2, completedAt: submitted.directVote?.completedAt});
    expect((await pool!.query('SELECT 1 FROM document_direct_vote_revisions WHERE document_id=$1',
      [document.id])).rowCount).toBe(3);
  });

  it('reads ballot controls from the original rule version after a new binding', async () => {
    const fixture = await meetingFixture();
    const motion = await stage5.proposeMotion(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'close-debate',
        onBehalfOfSeatId: fixture.firstSeat.id, parameters: {}}, randomUUID(), context('historic-motion'));
    const ballot = await stage5.createBallot(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, subjectType: 'MOTION', subjectId: motion.id, procedural: true, thresholdKind: 'SIMPLE_MAJORITY'}, randomUUID(), context('historic-ballot'));
    expect(ballot.chairMayCorrectVote).toBe(true);
    const future = await stage3.overrideRule(fixture.firstChair, fixture.committee.id,
      {scope: 'FUTURE', path: 'ballots.chairMayCorrectVote', value: false}, context('new-ballot-settings'));
    const revision = (await pool!.query('SELECT revision FROM committees WHERE id=$1', [fixture.committee.id])).rows[0].revision;
    await stage3.activateRules(fixture.firstChair, fixture.committee.id, future.createdVersionId!, revision, context('activate-ballot-settings'));
    const snapshot = await stage4.snapshot(fixture.committee.id, fixture.firstChair);
    expect(snapshot.activeRules.ballots.chairMayCorrectVote).toBe(false);
    expect(snapshot.ballots?.find(item => item.id === ballot.id)).toMatchObject({
      rulePackageVersionId: ballot.rulePackageVersionId, chairMayCorrectVote: true});
  });

  it.each(['SIMPLE_MAJORITY', 'TWO_THIRDS', 'TWO_THIRDS_NON_ABSTAINING'] as const)(
    'leaves a resolution without a result when no delegations are eligible under %s', async majority => {
      const f = await meetingFixture();
      const seats = [f.firstSeat, f.secondSeat];
      for (let index = 0; index < seats.length; index += 1) {
        seats[index] = await stage4.updateSeat(f.firstChair, f.committee.id, seats[index].id,
          {baseRevision: seats[index].revision, patch: {canVote: false, canProceduralVote: true}}, context('disable-voting'));
      }
      let document = await stage5.createResolution(f.firstChair, f.committee.id,
        {meetingSessionId: f.session.id, customTitle: null, content: ''}, 'empty-electorate', context('empty-electorate'));
      expect(document.directVote).toMatchObject({eligibility: [], threshold: 0, automaticResult: null});
      document = await stage5.updateDocumentSettings(f.firstChair, document.id,
        {baseRevision: document.revision, majority, proposerSeatIds: [f.firstSeat.id]}, context('majority'));
      expect(document.directVote).toMatchObject({eligibility: [], votes: [], threshold: 0, automaticResult: null});
      const snapshotDocument = async () => (await stage4.snapshot(f.committee.id, f.firstChair))
        .documents?.find(item => item.id === document.id);
      expect((await snapshotDocument())?.directVote).toMatchObject({eligibility: [], threshold: 0, automaticResult: null});
      for (let index = 0; index < seats.length; index += 1) {
        seats[index] = await stage4.updateSeat(f.firstChair, f.committee.id, seats[index].id,
          {baseRevision: seats[index].revision, patch: {canVote: true, canProceduralVote: true}}, context('enable-voting'));
      }
      expect((await snapshotDocument())?.directVote?.automaticResult).toBeNull();
      for (const seat of seats) {
        document = await stage5.setResolutionDirectVote(f.firstChair, document.id,
          {seatId: seat.id, choice: 'FOR'}, context('vote-for'));
      }
      expect(document.directVote?.automaticResult).toBe('PASSED');
      expect((await snapshotDocument())?.directVote?.automaticResult).toBe('PASSED');
      for (const seat of seats) {
        await stage4.updateSeat(f.firstChair, f.committee.id, seat.id,
          {baseRevision: seat.revision, patch: {canVote: false, canProceduralVote: true}}, context('remove-eligibility'));
      }
      expect((await snapshotDocument())?.directVote).toMatchObject({eligibility: [], votes: [], threshold: 0, automaticResult: null});
    });

  it.each(['STANDARD', 'NGO', 'OBSERVER'])('freezes independent capabilities for %s and applies changes only to the next ballot', async rank => {
    const f = await meetingFixture();
    let seat = await stage4.updateSeat(f.firstChair, f.committee.id, f.firstSeat.id,
      {baseRevision: f.firstSeat.revision, patch: {rank, hasVeto: true, mustVote: true}}, context('capabilities'));
    const document = await stage5.createResolution(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, customTitle: 'Capabilities', content: 'Vote'}, 'cap-resolution', context('cap-resolution'));
    await expect(stage5.setResolutionDirectVote(f.firstChair, document.id, {seatId: seat.id, choice: 'ABSTAIN'}, context('direct-abstain')))
      .rejects.toMatchObject({code: 'VALIDATION_FAILED'});
    await stage5.setResolutionDirectVote(f.firstChair, document.id,
      {seatId: seat.id, choice: 'AGAINST'}, context('direct-veto'));
    const direct = await stage5.setResolutionDirectVote(f.firstChair, document.id,
      {seatId: f.secondSeat.id, choice: 'FOR'}, context('direct-for'));
    expect(direct.directVote?.automaticResult).toBe('VETOED');
    const create = async (key: string) => {
      const subject = await stage5.createResolution(f.firstChair, f.committee.id,
        {meetingSessionId: f.session.id, customTitle: key, content: 'Vote'}, key + '-document', context(key));
      // Introduction is covered separately; enter voting through the actual command and frozen rule.
      await pool!.query("UPDATE documents SET status='PUBLISHED' WHERE id=$1", [subject.id]);
      await stage5.commandDocument(f.firstChair, subject.id,
        {baseRevision: subject.revision, action: 'RECOMMEND_BALLOT', ruleStableId: 'vote-on-resolution'}, context(key));
      return stage5.createBallot(f.firstChair, f.committee.id,
        {meetingSessionId: f.session.id, subjectType: 'RESOLUTION', subjectId: subject.id,
          procedural: false, thresholdKind: 'SIMPLE_MAJORITY'}, key, context(key));
    };
    let ballot = await create('cap-ballot');
    expect(ballot.eligibility.find(item => item.seatId === seat.id)).toMatchObject({hasVeto: true, mustVote: true});
    seat = await stage4.updateSeat(f.firstChair, f.committee.id, seat.id,
      {baseRevision: seat.revision, patch: {canVote: false, canProceduralVote: true, hasVeto: false, mustVote: false}}, context('disable-capabilities'));
    await expect(stage5.castVote(f.firstChair, ballot.id, {choice: 'ABSTAIN', onBehalfOfSeatId: seat.id},
      'bad-chair-abstain', context('bad-chair-abstain'))).rejects.toMatchObject({code: 'VALIDATION_FAILED'});
    await expect(stage5.castVote(f.firstDelegate, ballot.id, {choice: 'ABSTAIN'},
      'bad-delegate-abstain', context('bad-delegate-abstain'))).rejects.toMatchObject({code: 'VALIDATION_FAILED'});
    ballot = await stage5.castVote(f.firstDelegate, ballot.id, {choice: 'FOR'}, 'cap-for', context('cap-for'));
    await expect(stage5.correctVote(f.firstChair, ballot.id,
      {baseRevision: ballot.revision, seatId: seat.id, choice: 'ABSTAIN', reason: 'Invalid'}, context('bad-correction')))
      .rejects.toMatchObject({code: 'VALIDATION_FAILED'});
    ballot = await stage5.correctVote(f.firstChair, ballot.id,
      {baseRevision: ballot.revision, seatId: seat.id, choice: 'AGAINST', reason: 'Correct recorded choice'}, context('cap-correction'));
    ballot = await stage5.castVote(f.firstChair, ballot.id, {choice: 'FOR', onBehalfOfSeatId: f.secondSeat.id},
      'cap-second', context('cap-second'));
    const live = (await stage4.snapshot(f.committee.id, f.firstChair)).documents!.find(item => item.id === document.id)!;
    expect(live.directVote?.eligibility.some(item => item.seatId === seat.id)).toBe(false);
    expect(live.directVote?.automaticResult).not.toBe('VETOED');
    const excluded = await create('cap-excluded');
    expect(excluded.eligibility.map(item => item.seatId)).toEqual([f.secondSeat.id]);
    await expect(stage5.castVote(f.firstDelegate, excluded.id, {choice: 'FOR'}, 'excluded', context('excluded')))
      .rejects.toMatchObject({code: 'FORBIDDEN'});
    seat = await stage4.updateSeat(f.firstChair, f.committee.id, seat.id,
      {baseRevision: seat.revision, patch: {canVote: true, canProceduralVote: true}}, context('ordinary-seat'));
    let ordinary = await create('cap-ordinary');
    expect(ordinary.eligibility.find(item => item.seatId === seat.id)).toMatchObject({hasVeto: false, mustVote: false});
    ordinary = await stage5.castVote(f.firstDelegate, ordinary.id, {choice: 'AGAINST'}, 'ordinary-against', context('ordinary-against'));
    ordinary = await stage5.castVote(f.secondDelegate, ordinary.id, {choice: 'FOR'}, 'ordinary-for', context('ordinary-for'));
    ordinary = await stage5.closeBallot(f.firstChair, ordinary.id, {baseRevision: ordinary.revision}, context('ordinary-close'));
    ordinary = await stage5.publishBallot(f.firstChair, ordinary.id, {baseRevision: ordinary.revision}, context('ordinary-publish'));
    expect(ordinary.result?.outcome).toBe('FAILED');
    ballot = await stage5.closeBallot(f.firstChair, ballot.id, {baseRevision: ballot.revision}, context('cap-close'));
    ballot = await stage5.publishBallot(f.firstChair, ballot.id, {baseRevision: ballot.revision}, context('cap-publish'));
    expect(ballot).toMatchObject({status: 'PUBLISHED', result: {outcome: 'VETOED'}});
    expect(ballot.eligibility.find(item => item.seatId === seat.id)).toMatchObject({hasVeto: true, mustVote: true});
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

  it('allows procedural-only seats to vote on motions and preserves corrections', async () => {
    const fixture = await meetingFixture();
    await pool?.query("UPDATE committee_seats SET rank='OBSERVER',can_vote=false WHERE id=$1", [fixture.secondSeat.id]);
    let motion = await stage5.proposeMotion(fixture.firstDelegate, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'open-unmoderated-caucus',
        parameters: {caucusDuration: 10, caucusUnit: 'min'}}, 'direct-motion', context('direct-motion'));
    expect(motion.directVote).toMatchObject({threshold: 2});
    expect(motion.directVote.eligibility.map(item => item.seatId)).toContain(fixture.secondSeat.id);
    motion = await stage5.setMotionDirectVote(fixture.firstChair, motion.id,
      {choice: 'FOR', onBehalfOfSeatId: fixture.secondSeat.id}, context('direct-for'));
    expect(motion.directVote).toMatchObject({startedAt: expect.any(String), automaticResult: null});
    motion = await stage5.setMotionDirectVote(fixture.firstChair, motion.id,
      {choice: 'AGAINST', onBehalfOfSeatId: fixture.secondSeat.id}, context('direct-change'));
    motion = await stage5.setMotionDirectVote(fixture.firstChair, motion.id,
      {choice: null, onBehalfOfSeatId: fixture.secondSeat.id}, context('direct-retract'));
    expect(motion.directVote.votes).toEqual([]);
    const history = await pool?.query(`SELECT previous_choice,new_choice FROM motion_direct_vote_revisions
      WHERE motion_id=$1 AND seat_id=$2 ORDER BY created_at,id`, [motion.id, fixture.secondSeat.id]);
    expect(history?.rows).toEqual([{previous_choice: null, new_choice: 'FOR'},
      {previous_choice: 'FOR', new_choice: 'AGAINST'}, {previous_choice: 'AGAINST', new_choice: null}]);
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
      meetingSessionId: fixture.session.id, customTitle: 'A/RES/1', content: '第一版'}, 'resolution', context('resolution'));
    const introduction = await stage5.proposeMotion(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'introduce-draft-resolution',
        onBehalfOfSeatId: fixture.firstSeat.id,
        parameters: {resolutionTarget: resolution.id}}, 'introduce-resolution', context('introduce-resolution'));
    await stage5.decideMotion(fixture.firstChair, introduction.id,
      {baseRevision: introduction.revision, result: 'PASSED'}, context('pass-introduction'));
    resolution = await stage5.createDocumentVersion(fixture.firstDelegate, resolution.id, {baseRevision: resolution.revision + 1,
      customTitle: 'A/RES/1', content: '第二版'}, context('version'));
    const voteMotion = await stage5.proposeMotion(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'vote-on-resolution',
        onBehalfOfSeatId: fixture.firstSeat.id, parameters: {resolutionTarget: resolution.id}},
      'vote-on-resolution', context('vote-on-resolution'));
    const passedVoteMotion = await stage5.decideMotion(fixture.firstChair, voteMotion.id,
      {baseRevision: voteMotion.revision, result: 'PASSED'}, context('pass-vote-on-resolution'));
    expect(passedVoteMotion.destinationPath).toBe(
      `/committees/${fixture.committee.id}/votes/new?draft=${resolution.id}`);
    const votingSnapshot = await stage4.snapshot(fixture.committee.id, fixture.firstChair);
    resolution = votingSnapshot.documents?.find(document => document.id === resolution.id) as typeof resolution;
    expect(resolution.status).toBe('VOTING');
    expect(resolution.votingVersionId).toBe(resolution.currentVersion.id);
    await expect(stage5.createDocumentVersion(fixture.firstDelegate, resolution.id, {baseRevision: resolution.revision,
      customTitle: 'A/RES/1', content: '静默替换'}, context('replace'))).rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
  });
});
