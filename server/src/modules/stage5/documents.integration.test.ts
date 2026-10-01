// @vitest-environment node

import {expect, it} from 'vitest';
import {Stage8DeletionService} from '../operations/deletion-service';
import {Stage8ArchiveService} from '../operations/archive-service';
import {createHash, randomUUID} from 'node:crypto';
import {Stage6StorageService} from '../storage/service';
import {
  pool, stage3, stage4, stage5, context, integration, user, meetingFixture, meetingEndFixture, publishedTestCrisis
} from '../../../test/stage5-postgres-fixture';

integration('PostgreSQL stage 5 documents', () => {
  it('creates independent directive entries and one persistent vote with corrections', async () => {
    const f = await meetingEndFixture();
    const make = (draftType: string, key: string) => stage5.createResolution(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, customTitle: null, content: 'Draft body', draftType}, key, context(key));
    const resolution = await make('RESOLUTION', 'new-resolution');
    let directive = await make('DIRECTIVE', 'new-directive');
    const next = await make('DIRECTIVE', 'next-directive');
    expect(resolution).toMatchObject({ordinal: 1, title: 'Draft Resolution 1.1'});
    expect(directive).toMatchObject({ordinal: 1, draftType: 'DIRECTIVE', title: 'Draft Directive 1.1'});
    expect(next).toMatchObject({ordinal: 2, title: 'Draft Directive 1.2'});
    await expect(stage5.startDocumentVote(f.firstChair,directive.id,{baseRevision: directive.revision},'no-crisis',context('no-crisis')))
      .rejects.toMatchObject({reason: 'CRISIS_ASSOCIATION_REQUIRED'});
    const crisis = await publishedTestCrisis(f);
    directive = await stage5.updateDocumentSettings(f.firstChair,directive.id,{baseRevision: directive.revision,crisisGroupId: crisis.id},context('link-crisis'));
    directive = await stage5.updateDocumentSettings(f.firstChair, directive.id,
      {baseRevision: directive.revision, proposerSeatIds: [f.firstSeat.id]}, context('directive-country'));
    const starts = await Promise.all([1,2].map(index => stage5.startDocumentVote(f.firstChair, directive.id,
      {baseRevision: directive.revision}, `start-${index}`, context(`start-${index}`))));
    expect(starts[0].directVote?.startedAt).toBe(starts[1].directVote?.startedAt);
    expect((await pool!.query("SELECT count(*)::int AS count FROM audit_log WHERE resource_id=$1 AND action='documents.direct_vote_started'", [directive.id])).rows[0].count).toBe(1);
    directive = (await stage4.snapshot(f.committee.id, f.firstChair)).documents!.find(item => item.id === directive.id)!;
    expect(directive).toMatchObject({title: 'Draft Directive 1.1', proposers: [{seatId: f.firstSeat.id}], votingVersionId: directive.currentVersion.id});
    await expect(stage5.createDocumentVersion(f.firstChair, directive.id,
      {baseRevision: directive.revision, customTitle: null, content: 'Changed'}, context('frozen-directive'))).rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    const vote = directive.directVote!;
    directive = await stage5.submitResolutionDirectVote(f.firstChair, directive.id,
      {baseDocumentRevision: directive.revision, baseSettingsRevision: vote.settingsRevision, baseCastRevision: vote.castRevision,
        eligibility: vote.eligibility, votes: [{seatId: f.firstSeat.id, choice: 'FOR'}]}, 'directive-submit', context('directive-submit'));
    expect(directive.directVote).toMatchObject({automaticResult: 'PASSED', votes: [{choice: 'FOR'}]});
    expect((await stage4.snapshot(f.committee.id,f.firstChair)).crises![0]).toMatchObject({endedAt: expect.any(String),timer: {running: false},updates: [{status: 'ENDED'}]});
    const completedAt = directive.directVote!.completedAt;
    directive = await stage5.setResolutionDirectVote(f.firstChair, directive.id,
      {seatId: f.firstSeat.id, choice: 'AGAINST'}, context('directive-correct'));
    expect(directive.directVote).toMatchObject({automaticResult: 'FAILED', completedAt, votes: [{choice: 'AGAINST'}]});
    expect((await stage4.snapshot(f.committee.id,f.firstChair)).crises![0]).toMatchObject({endedAt: null,autoStartAt: null,timer: {running: false},updates: [{status: 'PENDING'}]});
    expect((await pool!.query('SELECT count(*)::int AS count FROM document_voting WHERE document_id=$1', [directive.id])).rows[0].count).toBe(1);
  });

  it('gates unfriendly votes on motions and persists adoption and corrections in the shared vote', async () => {
    const f = await meetingEndFixture();
    await pool!.query("UPDATE committees SET operation_mode='CHAIR_OPERATED' WHERE id=$1", [f.committee.id]);
    let resolution = await stage5.createResolution(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, customTitle: null, content: 'Resolution'}, 'am-parent', context('am-parent'));
    const pass = async (motionTypeId: string, parameters: Record<string, unknown>, key: string) => {
      const motion = await stage5.proposeMotion(f.firstChair, f.committee.id,
        {meetingSessionId: f.session.id, motionTypeId, onBehalfOfSeatId: f.firstSeat.id, parameters}, key, context(key));
      await stage5.decideMotion(f.firstChair, motion.id, {baseRevision: motion.revision, result: 'PASSED'}, context(`${key}-pass`));
    };
    await pass('introduce-draft-resolution', {resolutionTarget: resolution.id}, 'intro-parent');
    resolution = (await stage4.snapshot(f.committee.id, f.firstChair)).documents!.find(item => item.id === resolution.id)!;
    const make = (amendmentType: string, key: string) => stage5.createAmendment(f.firstChair, resolution.id,
      {meetingSessionId: f.session.id, customTitle: null, content: 'Amendment', amendmentType, onBehalfOfSeatId: f.firstSeat.id}, key, context(key));
    let amendment = await make('UNFRIENDLY', 'am-unfriendly');
    const friendly = await make('FRIENDLY', 'am-friendly');
    await expect(stage5.startDocumentVote(f.firstChair, amendment.id, {baseRevision: amendment.revision}, 'too-early', context('too-early'))).rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    await expect(stage5.startDocumentVote(f.firstChair, friendly.id, {baseRevision: friendly.revision}, 'friendly-start', context('friendly-start'))).rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    await pass('introduce-amendment', {amendmentTarget: amendment.id, proposal: 'Amendment'}, 'am-intro');
    await pass('vote-on-amendment', {amendmentTarget: amendment.id}, 'am-motion');
    amendment = (await stage4.snapshot(f.committee.id, f.firstChair)).documents!.find(item => item.id === amendment.id)!;
    amendment = await stage5.startDocumentVote(f.firstChair, amendment.id,
      {baseRevision: amendment.revision}, 'am-start', context('am-start'));
    const vote = amendment.directVote!;
    amendment = await stage5.submitResolutionDirectVote(f.firstChair, amendment.id,
      {baseDocumentRevision: amendment.revision, baseSettingsRevision: vote.settingsRevision, baseCastRevision: vote.castRevision,
        eligibility: vote.eligibility, votes: [{seatId: f.firstSeat.id, choice: 'FOR'}]}, 'am-submit', context('am-submit'));
    expect(amendment).toMatchObject({status: 'INCORPORATED', directVote: {automaticResult: 'PASSED'}});
    amendment = await stage5.setResolutionDirectVote(f.firstChair, amendment.id, {seatId: f.firstSeat.id, choice: 'AGAINST'}, context('am-correct'));
    expect(amendment).toMatchObject({status: 'REJECTED', directVote: {automaticResult: 'FAILED'}, resultDecisions: [{newStatus: 'INCORPORATED'}, {newStatus: 'REJECTED'}]});
    await expect(stage5.createBallot(f.firstChair, f.committee.id, {meetingSessionId: f.session.id, subjectType: 'AMENDMENT', subjectId: amendment.id,
      procedural: false, thresholdKind: 'SIMPLE_MAJORITY'}, 'parallel-ballot', context('parallel-ballot'))).rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
  });

  it('purges direct voting histories and linked caucuses without touching another committee', async () => {
    const f = await meetingFixture(); const other = await meetingFixture();
    const crisis=await stage5.createCrisis(f.firstChair,f.committee.id,{meetingSessionId:f.session.id},randomUUID(),context('purge-crisis'));
    const document = await stage5.createResolution(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, customTitle: null, content: ''}, randomUUID(), context('purge-document'));
    await stage5.updateDocumentSettings(f.firstChair, document.id,
      {baseRevision: document.revision, proposerSeatIds: [f.firstSeat.id], seconderSeatIds: [f.secondSeat.id]}, context('purge-countries'));
    await stage5.setResolutionDirectVote(f.firstChair, document.id,
      {seatId: f.firstSeat.id, choice: 'FOR'}, context('purge-resolution-vote'));
    const motion = await stage5.proposeMotion(f.firstDelegate, f.committee.id,
      {meetingSessionId: f.session.id, motionTypeId: 'open-unmoderated-caucus',
        parameters: {caucusDuration: 10, caucusUnit: 'min'}}, randomUUID(), context('purge-motion'));
    await stage5.setMotionDirectVote(f.firstChair, motion.id,
      {onBehalfOfSeatId: f.firstSeat.id, choice: 'FOR'}, context('purge-motion-vote'));
    await pool!.query('UPDATE speaker_lists SET linked_resolution_document_id=$1 WHERE id=$2', [document.id, f.generalList.id]);
    await expect(pool!.query('DELETE FROM document_direct_vote_revisions WHERE committee_id=$1', [f.committee.id]))
      .rejects.toThrow('append-only');
    await expect(pool!.query('DELETE FROM motion_direct_vote_revisions WHERE committee_id=$1', [f.committee.id]))
      .rejects.toThrow('append-only');
    const revision = (await pool!.query('SELECT revision FROM committees WHERE id=$1', [f.committee.id])).rows[0].revision;
    const archived = await stage3.archiveCommittee(f.owner, f.committee.id, revision, context('purge-archive'));
    const exported=await new Stage8ArchiveService(pool!).exportCommittee(f.owner,f.committee.id);
    const chunks=[];for await(const chunk of exported.content) chunks.push(String(chunk));
    const records=chunks.join('').trim().split('\n').map(line=>JSON.parse(line));
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({section:'crisis_groups',record:expect.objectContaining({id:crisis.id})}),
      expect.objectContaining({section:'crisis_updates',record:expect.objectContaining({group_id:crisis.id,status:'UNPUBLISHED'})})
    ]));
    const deletion = new Stage8DeletionService(pool!);
    await deletion.requestDeletion(f.owner, f.committee.id,
      {baseRevision: archived.revision, confirmationName: f.committee.name}, randomUUID(), context('purge'));
    expect(await deletion.processNext()).toMatchObject({status: 'COMPLETED'});
    expect((await pool!.query('SELECT id FROM committees WHERE id=$1', [f.committee.id])).rows).toEqual([]);
    expect((await pool!.query('SELECT id FROM crisis_groups WHERE id=$1',[crisis.id])).rows).toEqual([]);
    expect((await pool!.query('SELECT id FROM timer_states WHERE id=$1',[crisis.timer.id])).rows).toEqual([]);
    expect((await stage4.snapshot(other.committee.id, other.firstChair)).meetingSession?.id).toBe(other.session.id);
  });

  it('introduces an existing draft without an initial seconder or replacing its countries with motion sponsors', async () => {
    const fixture = await meetingFixture();
    const draft = await stage5.createResolution(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, customTitle: null, content: ''},
      'empty-resolution-draft', context('empty-resolution-draft'));
    expect(draft).toMatchObject({title: 'Draft Resolution 1.1', status: 'DRAFT', proposers: [],
      seconders: [], directVote: {majority: 'TWO_THIRDS'}, currentVersion: {content: ''}});
    await stage5.updateDocumentSettings(fixture.firstChair, draft.id,
      {baseRevision: draft.revision, proposerSeatIds: [fixture.secondSeat.id], seconderSeatIds: [fixture.firstSeat.id]}, context('draft-countries'));
    const motion = await stage5.proposeMotion(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'introduce-draft-resolution',
        onBehalfOfSeatId: fixture.firstSeat.id,
        parameters: {resolutionTarget: draft.id}}, 'motion-with-seconder', context('motion-with-seconder'));
    expect(motion).toMatchObject({status: 'SECONDED', proposedBySeatId: fixture.firstSeat.id,
      requiredSecondCount: 0, parameters: {resolutionTarget: draft.id}});
    expect(motion.seconds).toEqual([]);
    expect((await pool?.query('SELECT count(*)::int AS count FROM motion_seconds WHERE motion_id=$1', [motion.id]))?.rows)
      .toEqual([{count: 0}]);
    const passed = await stage5.decideMotion(fixture.firstChair, motion.id,
      {baseRevision: motion.revision, result: 'PASSED'}, context('introduce-resolution'));
    expect(passed).toMatchObject({status: 'PASSED', destinationPath:
      `/committees/${fixture.committee.id}/resolutions/${draft.id}`});
    const introduced = (await stage4.snapshot(fixture.committee.id, fixture.firstChair)).documents!.find(item => item.id === draft.id)!;
    expect(introduced).toMatchObject({status: 'PUBLISHED', public: true,
      proposers: [expect.objectContaining({seatId: fixture.secondSeat.id})],
      seconders: [expect.objectContaining({seatId: fixture.firstSeat.id})]});
  });

  it('saves multiple drafting and seconding countries in roll-call order, with revision and membership checks', async () => {
    const f = await meetingFixture();
    const draft = await stage5.createResolution(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, customTitle: null, content: ''}, 'multi-countries', context('multi-countries'));
    await pool!.query('UPDATE committee_seats SET sort_order=CASE WHEN id=$1 THEN 20 ELSE 10 END WHERE id=ANY($2::uuid[])',
      [f.firstSeat.id, [f.firstSeat.id, f.secondSeat.id]]);
    const ids = [f.firstSeat.id, f.secondSeat.id];
    let updated = await stage5.updateDocumentSettings(f.firstChair, draft.id,
      {baseRevision: draft.revision, proposerSeatIds: ids}, context('multiple-proposers'));
    expect(updated.proposers.map(item => item.seatId)).toEqual([...ids].reverse());
    expect(updated.proposers[0]).toMatchObject({seatDisplayName: f.secondSeat.displayName, flag: f.secondSeat.flag});
    await expect(stage5.updateDocumentSettings(f.secondChair, draft.id,
      {baseRevision: draft.revision, proposerSeatIds: []}, context('stale-countries'))).rejects.toMatchObject({code: 'REVISION_CONFLICT'});
    await expect(stage5.updateDocumentSettings(f.firstDelegate, draft.id,
      {baseRevision: updated.revision, proposerSeatIds: []}, context('delegate-countries'))).rejects.toMatchObject({code: 'FORBIDDEN', reason: 'CHAIR_REQUIRED'});
    await expect(stage5.updateDocumentSettings(f.firstChair, draft.id,
      {baseRevision: updated.revision, seconderSeatIds: ids}, context('overlapping-countries')))
      .rejects.toMatchObject({reason: 'DOCUMENT_COUNTRY_ROLES_OVERLAP'});
    await expect(stage5.updateDocumentSettings(f.firstChair, draft.id,
      {baseRevision: updated.revision, proposerSeatIds: [ids[0], ids[0]]}, context('duplicate-countries')))
      .rejects.toMatchObject({reason: 'INVALID_DOCUMENT_COUNTRIES'});
    await expect(stage5.updateDocumentSettings(f.firstChair, draft.id,
      {baseRevision: updated.revision, proposerSeatIds: [randomUUID()]}, context('foreign-country')))
      .rejects.toMatchObject({reason: 'SEAT_NOT_PRESENT'});
    updated = await stage5.updateDocumentSettings(f.firstChair, draft.id,
      {baseRevision: updated.revision, proposerSeatIds: [], seconderSeatIds: ids}, context('multiple-seconders'));
    expect(updated.seconders.map(item => item.seatId)).toEqual([...ids].reverse());
    await pool!.query("UPDATE documents SET status='PUBLISHED',is_public=true WHERE id=$1", [draft.id]);
    await stage4.createAttendanceEvent(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, seatId: ids[1], type: 'ABSENT'}, context('absent-country'));
    updated = await stage5.updateDocumentSettings(f.firstChair, draft.id,
      {baseRevision: updated.revision, seconderSeatIds: [ids[1]]}, context('remove-other-country'));
    expect(updated.seconders.map(item => item.seatId)).toEqual([ids[1]]);
    const snapshot = await stage4.snapshot(f.committee.id, f.firstChair);
    expect(snapshot.documents!.find(item => item.id === draft.id)!.seconders).toEqual(updated.seconders);
    const events = await pool!.query("SELECT audience FROM committee_events WHERE resource_id=$1 AND event_type='document.settings_changed' ORDER BY sequence DESC LIMIT 1", [draft.id]);
    expect(events.rows[0].audience).toBe('PUBLIC');
    const publicSnapshot = await stage4.snapshot(f.committee.id);
    expect(publicSnapshot.documents!.find(item => item.id === draft.id)!.seconders).toEqual(updated.seconders);
    const history = await pool!.query('SELECT after_value FROM resolution_setting_revisions WHERE resolution_document_id=$1 ORDER BY created_at', [draft.id]);
    expect(history.rows.at(-1).after_value).toMatchObject({proposerSeatIds: [], seconderSeatIds: [ids[1]]});
  });

  it('numbers generated resolution titles within their meeting session', async () => {
    const fixture = await meetingFixture();
    const first = await stage5.createResolution(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, customTitle: null, content: ''}, 'resolution-1-1', context('resolution-1-1'));
    const second = await stage5.createResolution(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, customTitle: null, content: ''}, 'resolution-1-2', context('resolution-1-2'));
    expect([first.title, second.title]).toEqual(['Draft Resolution 1.1', 'Draft Resolution 1.2']);

    await stage4.closeMeetingSession(fixture.firstChair, fixture.session.id,
      {baseRevision: fixture.session.revision}, context('close-first-session'));
    const nextSession = await stage4.startMeetingSession(fixture.firstChair, fixture.committee.id, {}, context('start-second-session'), randomUUID());
    const next = await stage5.createResolution(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: nextSession.id, customTitle: null, content: ''}, 'resolution-2-1', context('resolution-2-1'));
    expect(next.title).toBe('Draft Resolution 2.1');
  });

  it('creates, introduces, records, and softly deletes amendments without replacing their history', async () => {
    const fixture = await meetingFixture();
    let resolution = await stage5.createResolution(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, customTitle: null, content: 'Resolution body'},
      'amendment-parent', context('amendment-parent'));
    const resolutionMotion = await stage5.proposeMotion(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'introduce-draft-resolution',
        onBehalfOfSeatId: fixture.firstSeat.id,
        parameters: {resolutionTarget: resolution.id}}, 'amendment-parent-motion', context('amendment-parent-motion'));
    await stage5.decideMotion(fixture.firstChair, resolutionMotion.id,
      {baseRevision: resolutionMotion.revision, result: 'PASSED'}, context('amendment-parent-introduced'));
    resolution = (await stage4.snapshot(fixture.committee.id, fixture.firstChair)).documents!
      .find(document => document.id === resolution.id)!;

    const deletedDraft = await stage5.createAmendment(fixture.firstDelegate, resolution.id,
      {amendmentType: 'UNFRIENDLY', meetingSessionId: fixture.session.id, customTitle: null, content: ''}, 'empty-amendment', context('empty-amendment'));
    expect(deletedDraft).toMatchObject({title: 'Draft Resolution Unfriendly Amendment 1.1.1', status: 'DRAFT', currentVersion: {content: ''}});
    await stage5.deleteAmendment(fixture.firstDelegate, deletedDraft.id, {baseRevision: deletedDraft.revision},
      context('delete-empty-amendment'));
    const retained = await pool?.query(`SELECT deleted_at,deleted_by_user_id FROM documents WHERE id=$1`, [deletedDraft.id]);
    expect(retained?.rows[0]).toMatchObject({deleted_at: expect.any(Date), deleted_by_user_id: fixture.firstDelegate.user.id});
    expect((await stage4.snapshot(fixture.committee.id, fixture.firstChair)).documents?.some(
      document => document.id === deletedDraft.id)).toBe(false);
    expect((await pool?.query(`SELECT count(*)::int AS count FROM audit_log
      WHERE resource_id=$1 AND action='documents.deleted'`, [deletedDraft.id]))?.rows[0]).toEqual({count: 1});

    let amendment = await stage5.createAmendment(fixture.firstDelegate, resolution.id,
      {amendmentType: 'UNFRIENDLY', meetingSessionId: fixture.session.id, customTitle: null, content: ''}, 'introduced-amendment', context('introduced-amendment'));
    expect(amendment).toMatchObject({proposers: [], seconders: [],
      createdOnBehalfOfSeatId: fixture.firstSeat.id});
    amendment = await stage5.updateDocumentSettings(fixture.firstChair, amendment.id,
      {baseRevision: amendment.revision, proposerSeatIds: [fixture.secondSeat.id],
        seconderSeatIds: [fixture.firstSeat.id]}, context('amendment-countries'));
    expect(amendment).toMatchObject({proposers: [expect.objectContaining({seatId: fixture.secondSeat.id})],
      seconders: [expect.objectContaining({seatId: fixture.firstSeat.id})]});
    expect(resolution.proposers).toEqual([]);
    expect(resolution.seconders).toEqual([]);
    amendment = await stage5.createDocumentVersion(fixture.firstDelegate, amendment.id,
      {baseRevision: amendment.revision, customTitle: amendment.customTitle, content: 'Replace operative clause 1.'},
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
    expect(introduced).toMatchObject({status: 'PUBLISHED', public: true,
      proposers: [expect.objectContaining({seatId: fixture.secondSeat.id})],
      seconders: [expect.objectContaining({seatId: fixture.firstSeat.id})]});
    await expect(stage5.recordDocumentResult(fixture.firstChair, amendment.id,
      {baseRevision: introduced.revision, outcome: 'INCORPORATED'}, context('incorporate-without-ballot')))
      .rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});

    resolution = await stage5.updateDocumentSettings(fixture.firstChair, resolution.id,
      {baseRevision: resolution.revision, proposerSeatIds: [fixture.firstSeat.id, fixture.secondSeat.id]}, context('parent-countries'));
    let friendly = await stage5.createAmendment(fixture.firstDelegate, resolution.id,
      {amendmentType: 'FRIENDLY', meetingSessionId: fixture.session.id, customTitle: null, content: ''},
      'friendly', context('friendly'));
    expect(friendly).toMatchObject({amendmentType: 'FRIENDLY', amendmentOrdinal: 1,
      title: 'Draft Resolution Friendly Amendment 1.1.1', status: 'DRAFT', proposers: []});
    expect(friendly.seconders.map(country => country.seatId).sort()).toEqual([fixture.firstSeat.id, fixture.secondSeat.id].sort());
    await expect(stage5.recordDocumentResult(fixture.firstChair, friendly.id,
      {baseRevision: friendly.revision, outcome: 'INCORPORATED'}, context('empty-friendly')))
      .rejects.toMatchObject({code: 'VALIDATION_FAILED', reason: 'AMENDMENT_BODY_REQUIRED'});
    for (const motionTypeId of ['introduce-amendment', 'vote-on-amendment']) {
      await expect(stage5.proposeMotion(fixture.firstDelegate, fixture.committee.id,
        {meetingSessionId: fixture.session.id, motionTypeId, parameters: {amendmentTarget: friendly.id, proposal: 'Friendly'}},
        `friendly-${motionTypeId}`, context('friendly-motion'))).rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    }
    await expect(stage5.createBallot(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, subjectType: 'AMENDMENT', subjectId: friendly.id,
        procedural: false, thresholdKind: 'SIMPLE_MAJORITY'}, 'friendly-ballot', context('friendly-ballot')))
      .rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    friendly = await stage5.createDocumentVersion(fixture.firstDelegate, friendly.id,
      {baseRevision: friendly.revision, customTitle: null, content: 'Friendly correction'}, context('friendly-body'));
    friendly = await stage5.recordDocumentResult(fixture.firstChair, friendly.id,
      {baseRevision: friendly.revision, outcome: 'INCORPORATED'}, context('adopt-friendly'));
    expect(friendly).toMatchObject({status: 'INCORPORATED', public: true, votingVersionId: null,
      resultDecisions: [expect.objectContaining({previousStatus: 'DRAFT', newStatus: 'INCORPORATED'})]});
    expect((await stage4.snapshot(fixture.committee.id, fixture.firstChair)).documents?.find(item => item.id === friendly.id))
      .toMatchObject({amendmentType: 'FRIENDLY', amendmentOrdinal: 1, title: friendly.title, seconders: friendly.seconders});
    const secondFriendly = await stage5.createAmendment(fixture.firstDelegate, resolution.id,
      {amendmentType: 'FRIENDLY', meetingSessionId: fixture.session.id, customTitle: null, content: ''},
      'friendly-second', context('friendly-second'));
    expect(secondFriendly.title).toBe('Draft Resolution Friendly Amendment 1.1.2');

    let formal = await stage5.createAmendment(fixture.firstDelegate, resolution.id,
      {amendmentType: 'UNFRIENDLY', meetingSessionId: fixture.session.id, customTitle: null, content: 'Delete operative clause 2.'},
      'formal-amendment', context('formal-amendment'));
    expect(formal).toMatchObject({amendmentType: 'UNFRIENDLY', amendmentOrdinal: 3,
      title: 'Draft Resolution Unfriendly Amendment 1.1.3', proposers: [], seconders: []});
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
      `/committees/${fixture.committee.id}/votes/new?draft=${formal.id}`);
    formal = (await stage4.snapshot(fixture.committee.id, fixture.firstChair)).documents!
      .find(document => document.id === formal.id)!;
    expect(formal).toMatchObject({status: 'VOTING', votingVersionId: formal.currentVersion.id});
    await expect(stage5.recordDocumentResult(fixture.firstChair, formal.id,
      {baseRevision: formal.revision, outcome: 'INCORPORATED'}, context('manual-result-after-formal-motion')))
      .rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    let ballot = await stage5.createBallot(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, subjectType: 'AMENDMENT', subjectId: formal.id,
        procedural: false, thresholdKind: 'SIMPLE_MAJORITY'}, 'formal-amendment-ballot', context('formal-amendment-ballot'));
    expect(ballot).toMatchObject({subjectType: 'AMENDMENT', subjectId: formal.id, status: 'OPEN',
      ruleEvaluation: {facts: {subjectVersionId: formal.currentVersion.id}}});
    await expect(stage5.createBallot(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, subjectType: 'AMENDMENT', subjectId: formal.id,
        procedural: false, thresholdKind: 'SIMPLE_MAJORITY'}, 'duplicate-formal-amendment-ballot', context('duplicate-formal-amendment-ballot')))
      .rejects.toMatchObject({code: 'RESOURCE_CONFLICT', reason: 'BALLOT_ALREADY_EXISTS'});
    await expect(stage5.deleteAmendment(fixture.firstChair, formal.id, {baseRevision: formal.revision},
      context('delete-formal-amendment'))).rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    ballot = await stage5.castVote(fixture.firstDelegate, ballot.id, {choice: 'FOR'}, 'amendment-vote-one', context('amendment-vote-one'));
    ballot = await stage5.castVote(fixture.secondDelegate, ballot.id, {choice: 'FOR'}, 'amendment-vote-two', context('amendment-vote-two'));
    ballot = await stage5.closeBallot(fixture.firstChair, ballot.id, {baseRevision: ballot.revision}, context('close-amendment-ballot'));
    await stage5.publishBallot(fixture.firstChair, ballot.id, {baseRevision: ballot.revision}, context('publish-amendment-ballot'));
    expect((await stage4.snapshot(fixture.committee.id, fixture.firstChair)).documents?.find(item => item.id === formal.id))
      .toMatchObject({status: 'INCORPORATED', votingVersionId: formal.currentVersion.id});
  });

  it('opens a resolution-linked caucus empty and lets the Chair add speakers', async () => {
    const fixture = await meetingFixture();
    const draft = await stage5.createResolution(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, customTitle: null, content: 'Draft body'},
      'linked-caucus-draft', context('linked-caucus-draft'));
    const introduction = await stage5.proposeMotion(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'introduce-draft-resolution',
        onBehalfOfSeatId: fixture.firstSeat.id,
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

    const linked = await pool?.query(`SELECT id,custom_title,topic,linked_resolution_document_id,current_entry_id
      FROM speaker_lists WHERE linked_resolution_document_id=$1`, [draft.id]);
    expect(linked?.rows).toEqual([expect.objectContaining({custom_title: null, topic: draft.title,
      linked_resolution_document_id: draft.id, current_entry_id: null})]);
    const queue = await pool?.query(`SELECT seat_id,position,status,stance FROM speaker_queue_entries
      WHERE speaker_list_id=$1 ORDER BY position`, [linked?.rows[0]?.id]);
    expect(queue?.rows).toEqual([]);
    const populated = await stage5.joinSpeakerQueue(fixture.firstChair, linked?.rows[0]?.id,
      {seatId: fixture.secondSeat.id}, 'chair-add-linked-speaker', context('chair-add-linked-speaker'));
    expect(populated.queue).toEqual([expect.objectContaining({seatId: fixture.secondSeat.id, status: 'QUEUED'})]);
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

  it('postpones only the selected introduced resolution and restores its actions after a passed resume motion', async () => {
    const f = await meetingFixture();
    const draft = await stage5.createResolution(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, customTitle: 'Draft A', content: 'Body'}, randomUUID(), context('postpone-draft'));
    const propose = (motionTypeId: string, parameters: Record<string, unknown>) => stage5.proposeMotion(
      f.firstChair, f.committee.id, {meetingSessionId: f.session.id, motionTypeId,
        onBehalfOfSeatId: f.firstSeat.id, parameters}, randomUUID(), context(motionTypeId));
    const pass = async (motion: Awaited<ReturnType<typeof propose>>) => stage5.decideMotion(f.firstChair, motion.id,
      {baseRevision: motion.revision, result: 'PASSED'}, context(`pass-${motion.motionTypeId}`));
    await expect(propose('postpone-resolution', {resolutionTarget: draft.id})).rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    await pass(await propose('introduce-draft-resolution', {resolutionTarget: draft.id}));
    await expect(propose('postpone-resolution', {})).rejects.toMatchObject({code: 'VALIDATION_FAILED'});
    const caucus = await propose('open-moderated-caucus', {proposal: 'Discuss Draft A', resolutionTarget: draft.id,
      caucusDuration: 10, caucusUnit: 'min', speakerDuration: 1, speakerUnit: 'min'});
    await pass(caucus);
    const linked = (await stage4.snapshot(f.committee.id, f.firstChair)).speakerLists!
      .find(list => list.linkedResolutionId === draft.id)!;
    expect(linked.status).toBe('OPEN');
    await pass(await propose('postpone-resolution', {resolutionTarget: draft.id}));
    let snapshot = await stage4.snapshot(f.committee.id, f.firstChair);
    expect(snapshot.documents?.find(document => document.id === draft.id)?.status).toBe('POSTPONED');
    expect(snapshot.speakerLists?.find(list => list.id === linked.id)?.status).toBe('CLOSED');
    const linkedTimer = snapshot.timers!.find(timer => timer.id === linked.totalTimerId)!;
    await expect(stage5.commandTimer(f.firstChair, linkedTimer.id, 'start',
      {baseRevision: linkedTimer.revision}, context('blocked-discussion-timer')))
      .rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    await expect(propose('postpone-resolution', {resolutionTarget: draft.id})).rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    await expect(propose('vote-on-resolution', {resolutionTarget: draft.id})).rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    await expect(propose('open-moderated-caucus', {proposal: 'Discuss Draft A', resolutionTarget: draft.id,
      caucusDuration: 10, caucusUnit: 'min', speakerDuration: 1, speakerUnit: 'min'}))
      .rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    await expect(stage5.createAmendment(f.firstDelegate, draft.id,
      {amendmentType: 'UNFRIENDLY', meetingSessionId: f.session.id, customTitle: null, content: ''}, randomUUID(), context('blocked-amendment')))
      .rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    await expect(stage5.setResolutionDirectVote(f.firstChair, draft.id,
      {seatId: f.firstSeat.id, choice: 'FOR'}, context('blocked-vote'))).rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    await expect(stage5.setSpeakerListStatus(f.firstChair, linked.id,
      {baseRevision: snapshot.speakerLists!.find(list => list.id === linked.id)!.revision, status: 'OPEN'},
      context('blocked-discussion'))).rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    await pass(await propose('resume-resolution', {resolutionTarget: draft.id}));
    snapshot = await stage4.snapshot(f.committee.id, f.firstChair);
    expect(snapshot.documents?.find(document => document.id === draft.id)?.status).toBe('PUBLISHED');
    await expect(propose('resume-resolution', {resolutionTarget: draft.id})).rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    await stage5.setSpeakerListStatus(f.firstChair, linked.id,
      {baseRevision: snapshot.speakerLists!.find(list => list.id === linked.id)!.revision, status: 'OPEN'},
      context('resume-discussion'));
    await propose('vote-on-resolution', {resolutionTarget: draft.id});
    await stage5.setResolutionDirectVote(f.firstChair, draft.id,
      {seatId: f.firstSeat.id, choice: 'FOR'}, context('direct-vote-started'));
    await expect(propose('postpone-resolution', {resolutionTarget: draft.id}))
      .rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    const actions = await pool!.query<{action: string}>(`SELECT action FROM document_actions WHERE document_id=$1
      ORDER BY created_at,id`, [draft.id]);
    expect(actions.rows.map(row => row.action)).toEqual(expect.arrayContaining(['PUBLISH', 'POSTPONE', 'RESUME']));
  });

  it('restores amendment introduction when Formal Debate is reopened in the same meeting session', async () => {
    const f = await meetingFixture();
    const draft = await stage5.createResolution(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, customTitle: 'Draft B', content: 'Body'}, randomUUID(), context('debate-draft'));
    const propose = (motionTypeId: string, parameters: Record<string, unknown>) => stage5.proposeMotion(
      f.firstChair, f.committee.id, {meetingSessionId: f.session.id, motionTypeId,
        onBehalfOfSeatId: f.firstSeat.id, parameters}, randomUUID(), context(motionTypeId));
    const pass = async (motion: Awaited<ReturnType<typeof propose>>) => stage5.decideMotion(f.firstChair, motion.id,
      {baseRevision: motion.revision, result: 'PASSED'}, context(`pass-${motion.motionTypeId}`));
    await pass(await propose('introduce-draft-resolution', {resolutionTarget: draft.id}));
    const amendment = await stage5.createAmendment(f.firstDelegate, draft.id,
      {amendmentType: 'UNFRIENDLY', meetingSessionId: f.session.id, customTitle: null, content: 'Replace clause'}, randomUUID(), context('amendment'));
    await pass(await propose('close-debate', {}));
    await expect(propose('introduce-amendment', {amendmentTarget: amendment.id, proposal: 'Replace clause'}))
      .rejects.toMatchObject({reason: 'FORMAL_DEBATE_CLOSED'});
    await pass(await propose('open-debate', {}));
    const introduction = await propose('introduce-amendment',
      {amendmentTarget: amendment.id, proposal: 'Replace clause'});
    await pass(introduction);
    expect((await stage4.snapshot(f.committee.id, f.firstChair)).documents?.find(item => item.id === amendment.id)?.status)
      .toBe('PUBLISHED');
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
      {meetingSessionId: fixture.session.id, customTitle: null, content: ''},
      'file-resolution-draft', context('file-resolution-draft'));
    await expect(stage5.createDocumentVersion(fixture.firstChair, draft.id,
      {baseRevision: draft.revision, customTitle: draft.customTitle, content: '', contentFileEntryId: fileId,
        onBehalfOfSeatId: fixture.firstSeat.id},
      context('reject-unpublished-file'))).rejects.toMatchObject({code: 'RESOURCE_CONFLICT',
        details: {reason: 'DOCUMENT_FILE_NOT_PUBLISHED'}});
    // A pre-migration document may already reference a submission awaiting review.
    await pool!.query(`WITH legacy AS (INSERT INTO document_versions
      (id,document_id,version_number,content,content_file_entry_id,created_by_user_id,created_on_behalf_of_seat_id)
      SELECT $3,document_id,version_number+1,'',$2,created_by_user_id,created_on_behalf_of_seat_id
        FROM document_versions WHERE id=$1 RETURNING id,document_id)
      UPDATE documents SET current_version_id=legacy.id,revision=revision+1 FROM legacy WHERE documents.id=legacy.document_id`,
      [draft.currentVersion.id,fileId,randomUUID()]);
    draft = {...draft,revision:draft.revision+1};
    const workspace = await stage4.snapshot(fixture.committee.id, fixture.firstChair);
    expect(workspace.documents?.find(document => document.id === draft.id)?.currentVersion.contentFile)
      .toMatchObject({id: fileId, logicalName: 'Draft body', originalName: 'draft.pdf', status: 'UPLOAD_COMPLETE'});

    const motion = await stage5.proposeMotion(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'introduce-draft-resolution',
        onBehalfOfSeatId: fixture.firstSeat.id,
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
    const other = await meetingFixture();
    const otherDraft = await stage5.createResolution(other.firstChair, other.committee.id,
      {meetingSessionId:other.session.id,customTitle:null,content:'',onBehalfOfSeatId:other.firstSeat.id},
      'cross-file-document',context('cross-file-document'));
    await expect(stage5.createDocumentVersion(other.firstChair,otherDraft.id,
      {baseRevision:otherDraft.revision,customTitle:null,content:'',contentFileEntryId:fileId,onBehalfOfSeatId:other.firstSeat.id},
      context('cross-committee-file'))).rejects.toMatchObject({code:'RESOURCE_CONFLICT',details:{reason:'DOCUMENT_FILE_NOT_PUBLISHED'}});
    await expect(stage5.createDocumentVersion(fixture.firstChair,draft.id,
      {baseRevision:draft.revision-1,customTitle:null,content:'',contentFileEntryId:fileId,onBehalfOfSeatId:fixture.firstSeat.id},
      context('stale-document-file'))).rejects.toMatchObject({code:'REVISION_CONFLICT'});
    const passed = await stage5.decideMotion(fixture.firstChair, motion.id,
      {baseRevision: motion.revision, result: 'PASSED'}, context('published-file-introduction'));
    expect(passed).toMatchObject({status: 'PASSED', destinationPath:
      `/committees/${fixture.committee.id}/resolutions/${draft.id}`});
    let amendment = await stage5.createAmendment(fixture.firstDelegate, draft.id,
      {amendmentType: 'UNFRIENDLY', meetingSessionId: fixture.session.id, customTitle: null, content: ''},
      'file-amendment-draft', context('file-amendment-draft'));
    amendment = await stage5.createDocumentVersion(fixture.firstDelegate, amendment.id,
      {baseRevision: amendment.revision, customTitle: amendment.customTitle, content: '', contentFileEntryId: fileId},
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
    await expect(stage5.createDocumentVersion(fixture.secondDelegate, amendment.id,
      {baseRevision: amendment.revision + 1, customTitle: null, content: '', contentFileEntryId: fileId},
      context('reject-other-proposer'))).rejects.toMatchObject({code: 'FORBIDDEN'});
    // Both operations take the committee lock before a file lock; either serialized outcome is valid.
    const fileRevision = (await pool!.query('SELECT revision FROM file_entries WHERE id=$1', [fileId])).rows[0].revision;
    const binding = stage5.createDocumentVersion(fixture.firstDelegate, amendment.id,
      {baseRevision: amendment.revision + 1, customTitle: null, content: '', contentFileEntryId: fileId},
      context('concurrent-file-binding'));
    const deletion = new Stage6StorageService(pool!).deleteFile(fixture.firstChair, fileId,
      {baseRevision: fileRevision}, 'concurrent-file-deletion', context('concurrent-file-deletion'));
    const [bound, removed] = await Promise.allSettled([binding, deletion]);
    expect(removed.status).toBe('fulfilled');
    if (bound.status === 'rejected') expect(bound.reason).toMatchObject({code: 'RESOURCE_CONFLICT',
      details: {reason: 'DOCUMENT_FILE_NOT_PUBLISHED'}});
    const latestRevision = (await pool!.query('SELECT revision FROM documents WHERE id=$1', [amendment.id])).rows[0].revision;
    await expect(stage5.setResolutionDirectVote(fixture.firstChair,draft.id,
      {seatId:fixture.firstSeat.id,choice:'FOR'},context('deleted-direct-vote')))
      .rejects.toMatchObject({code:'RESOURCE_CONFLICT',details:{reason:'DOCUMENT_FILE_NOT_PUBLISHED'}});
    const deletedSnapshot = await stage4.snapshot(fixture.committee.id, fixture.firstChair);
    for (const id of [draft.id, amendment.id]) expect(deletedSnapshot.documents?.find(item => item.id === id)?.currentVersion)
      .toMatchObject({content: '', contentFile: {id: fileId, status: 'DELETED', logicalName: 'Draft body'}});
    await expect(stage5.createDocumentVersion(fixture.firstDelegate, amendment.id,
      {baseRevision: latestRevision, customTitle: null, content: '', contentFileEntryId: fileId},
      context('reject-deleted-file'))).rejects.toMatchObject({code: 'RESOURCE_CONFLICT',
        details: {reason: 'DOCUMENT_FILE_NOT_PUBLISHED'}});

  });

  it('lets the Chair pass an introduction motion without a seconder', async () => {
    const fixture = await meetingFixture();
    const draft = await stage5.createResolution(fixture.firstDelegate, fixture.committee.id,
      {meetingSessionId: fixture.session.id, customTitle: null, content: ''},
      'unseconded-resolution-draft', context('unseconded-resolution-draft'));
    const motion = await stage5.proposeMotion(fixture.firstDelegate, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'introduce-draft-resolution',
        parameters: {resolutionTarget: draft.id}}, 'unseconded-motion', context('unseconded-motion'));
    expect(motion).toMatchObject({status: 'SECONDED', requiredSecondCount: 0, seconds: []});
    const passed = await stage5.decideMotion(fixture.firstChair, motion.id,
      {baseRevision: motion.revision, result: 'PASSED'}, context('pass-unseconded'));
    expect(passed.status).toBe('PASSED');
  });

  it('enacts a passed introduction motion in Chair-operated mode without a seconder', async () => {
    const fixture = await meetingFixture();
    await pool?.query("UPDATE committees SET operation_mode='CHAIR_OPERATED' WHERE id=$1", [fixture.committee.id]);
    const draft = await stage5.createResolution(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, customTitle: null, content: ''},
      'chair-resolution-draft', context('chair-resolution-draft'));
    const motion = await stage5.proposeMotion(fixture.firstChair, fixture.committee.id,
      {meetingSessionId: fixture.session.id, motionTypeId: 'introduce-draft-resolution',
        onBehalfOfSeatId: fixture.firstSeat.id, parameters: {resolutionTarget: draft.id}},
      'chair-advisory-motion', context('chair-advisory-motion'));
    expect(motion).toMatchObject({status: 'SECONDED', requiredSecondCount: 0, seconds: []});
    const passed = await stage5.decideMotion(fixture.firstChair, motion.id,
      {baseRevision: motion.revision, result: 'PASSED'}, context('chair-advisory-pass'));
    expect(passed.status).toBe('PASSED');
    expect(passed.destinationPath).toBe(`/committees/${fixture.committee.id}/resolutions/${draft.id}`);
    const created = await pool?.query(`SELECT custom_title,ordinal,status FROM documents
      WHERE committee_id=$1 AND meeting_session_id=$2`, [fixture.committee.id, fixture.session.id]);
    expect(created?.rows).toEqual([{custom_title: null, ordinal: 1, status: 'PUBLISHED'}]);
    const audit = await pool?.query(`SELECT after_summary FROM audit_log
      WHERE committee_id=$1 AND action='proceedings.motion_decided' ORDER BY created_at DESC LIMIT 1`,
    [fixture.committee.id]);
    expect(audit?.rows[0]?.after_summary).toMatchObject({status: 'PASSED', advisoryRuleOverride: false});
  });
});
