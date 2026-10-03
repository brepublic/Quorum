// @vitest-environment node
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {expect, it} from 'vitest';
import {pool, stage4, stage5, context, integration, meetingFixture} from '../../../test/stage5-postgres-fixture';

integration('PostgreSQL resolution vote lifecycle', () => {
  it('rejects empty motion targets and rechecks the body before introducing a draft', async () => {
    const f = await meetingFixture();
    let document = await stage5.createResolution(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, customTitle: null, content: ' \n\t '}, randomUUID(), context('empty'));
    const propose = (type: string) => stage5.proposeMotion(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, motionTypeId: type, onBehalfOfSeatId: f.firstSeat.id,
        parameters: {resolutionTarget: document.id}}, randomUUID(), context(type));
    await expect(propose('introduce-draft-resolution')).rejects.toMatchObject({reason: 'DRAFT_BODY_REQUIRED'});
    document = await stage5.createDocumentVersion(f.firstChair, document.id,
      {baseRevision: document.revision, onBehalfOfSeatId: f.firstSeat.id, customTitle: null, content: 'Body'}, context('fill'));
    const motion = await propose('introduce-draft-resolution');
    document = await stage5.createDocumentVersion(f.firstChair, document.id,
      {baseRevision: document.revision, onBehalfOfSeatId: f.firstSeat.id, customTitle: null, content: ''}, context('clear'));
    await expect(stage5.decideMotion(f.firstChair, motion.id,
      {baseRevision: motion.revision, result: 'PASSED'}, context('introduce'))).rejects.toMatchObject({reason: 'DRAFT_BODY_REQUIRED'});
    expect((await pool!.query('SELECT status FROM motions WHERE id=$1', [motion.id])).rows[0].status).toBe(motion.status);
    await pool!.query("UPDATE documents SET status='PUBLISHED' WHERE id=$1", [document.id]);
    await expect(propose('vote-on-resolution')).rejects.toMatchObject({reason: 'DRAFT_BODY_REQUIRED'});
    expect((await pool!.query('SELECT voting_version_id FROM documents WHERE id=$1', [document.id])).rows[0].voting_version_id).toBeNull();
  });

  it('starts exactly one real vote when competing motions pass', async () => {
    const f = await meetingFixture();
    const document = await stage5.createResolution(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, customTitle: null, content: 'Body'}, randomUUID(), context('body'));
    await pool!.query("UPDATE documents SET status='PUBLISHED' WHERE id=$1", [document.id]);
    const motions = [];
    for (let i = 0; i < 2; i++) motions.push(await stage5.proposeMotion(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, motionTypeId: 'vote-on-resolution', onBehalfOfSeatId: f.firstSeat.id,
        parameters: {resolutionTarget: document.id}}, randomUUID(), context('vote-motion')));
    const results = await Promise.allSettled(motions.map(motion => stage5.decideMotion(f.firstChair, motion.id,
      {baseRevision: motion.revision, result: 'PASSED'}, context('pass'))));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const success = results.find(result => result.status === 'fulfilled');
    if (success?.status !== 'fulfilled') throw new Error('Expected one passed motion');
    expect(success.value.destinationPath).toBe(`/committees/${f.committee.id}/votes/${document.id}`);
    const updated = (await stage4.snapshot(f.committee.id, f.firstChair)).documents!.find(item => item.id === document.id)!;
    expect(updated).toMatchObject({status: 'VOTING', votingVersionId: document.currentVersion.id,
      directVote: {startedAt: expect.any(String)}, revision: document.revision + 1});
    expect((await pool!.query("SELECT count(*)::int AS n FROM audit_log WHERE resource_id=$1 AND action='documents.direct_vote_started'", [document.id])).rows[0].n).toBe(1);
    await expect(stage5.createDocumentVersion(f.firstChair, document.id,
      {baseRevision: updated.revision, onBehalfOfSeatId: f.firstSeat.id, customTitle: null, content: 'Changed'}, context('frozen'))).rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
  });

  it('rolls back passage and freezing when there are no eligible voters', async () => {
    const f = await meetingFixture();
    const document = await stage5.createResolution(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, customTitle: null, content: 'Body'}, randomUUID(), context('body'));
    await pool!.query("UPDATE documents SET status='PUBLISHED' WHERE id=$1", [document.id]);
    const motion = await stage5.proposeMotion(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, motionTypeId: 'vote-on-resolution', onBehalfOfSeatId: f.firstSeat.id,
        parameters: {resolutionTarget: document.id}}, randomUUID(), context('motion'));
    await pool!.query('UPDATE committee_seats SET can_vote=false,has_veto=false,must_vote=false WHERE committee_id=$1', [f.committee.id]);
    await expect(stage5.decideMotion(f.firstChair, motion.id,
      {baseRevision: motion.revision, result: 'PASSED'}, context('pass'))).rejects.toMatchObject({reason: 'NO_ELIGIBLE_VOTERS'});
    const updated = (await stage4.snapshot(f.committee.id, f.firstChair)).documents!.find(item => item.id === document.id)!;
    expect(updated).toMatchObject({status: 'PUBLISHED', votingVersionId: null, directVote: {startedAt: null}, revision: document.revision});
    expect((await pool!.query('SELECT status FROM motions WHERE id=$1', [motion.id])).rows[0].status).toBe(motion.status);
    await stage5.createDocumentVersion(f.firstChair, document.id,
      {baseRevision: updated.revision, onBehalfOfSeatId: f.firstSeat.id, customTitle: null, content: 'Editable'}, context('editable'));
  });

  it('atomically publishes a motion ballot and starts its document vote, with a recoverable body failure', async () => {
    const f = await meetingFixture();
    let document = await stage5.createResolution(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, customTitle: null, content: 'Body'}, randomUUID(), context('body'));
    await pool!.query("UPDATE documents SET status='PUBLISHED' WHERE id=$1", [document.id]);
    const motion = await stage5.proposeMotion(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, motionTypeId: 'vote-on-resolution', onBehalfOfSeatId: f.firstSeat.id,
        parameters: {resolutionTarget: document.id}}, randomUUID(), context('motion'));
    let ballot = await stage5.createBallot(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, subjectType: 'MOTION', subjectId: motion.id, procedural: false,
        thresholdKind: 'SIMPLE_MAJORITY'}, randomUUID(), context('ballot'));
    for (const seat of [f.firstSeat, f.secondSeat]) ballot = await stage5.castVote(f.firstChair, ballot.id,
      {choice: 'FOR', onBehalfOfSeatId: seat.id}, randomUUID(), context('vote'));
    ballot = await stage5.closeBallot(f.firstChair, ballot.id, {baseRevision: ballot.revision}, context('close'));
    document = await stage5.createDocumentVersion(f.firstChair, document.id,
      {baseRevision: document.revision, onBehalfOfSeatId: f.firstSeat.id, customTitle: null, content: '  '}, context('clear'));
    await expect(stage5.publishBallot(f.firstChair, ballot.id, {baseRevision: ballot.revision}, context('publish')))
      .rejects.toMatchObject({reason: 'DRAFT_BODY_REQUIRED'});
    expect((await pool!.query('SELECT status FROM ballots WHERE id=$1', [ballot.id])).rows[0].status).toBe('CLOSED');
    expect((await pool!.query('SELECT status FROM motions WHERE id=$1', [motion.id])).rows[0].status).toBe('VOTING');
    document = await stage5.createDocumentVersion(f.firstChair, document.id,
      {baseRevision: document.revision, onBehalfOfSeatId: f.firstSeat.id, customTitle: null, content: 'Restored'}, context('restore'));
    await stage5.publishBallot(f.firstChair, ballot.id, {baseRevision: ballot.revision}, context('publish-retry'));
    const updated = (await stage4.snapshot(f.committee.id, f.firstChair)).documents!.find(item => item.id === document.id)!;
    expect(updated).toMatchObject({status: 'VOTING', directVote: {startedAt: expect.any(String)}});
    expect((await pool!.query('SELECT destination_path FROM motions WHERE id=$1', [motion.id])).rows[0].destination_path)
      .toBe(`/committees/${f.committee.id}/votes/${document.id}`);
  });

  it('freezes manual direct and formal votes only on successful creation', async () => {
    const f = await meetingFixture();
    const direct = await stage5.createResolution(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, customTitle: null, content: 'Body'}, randomUUID(), context('direct'));
    const key = randomUUID();
    const started = await stage5.startDocumentVote(f.firstChair, direct.id, {baseRevision: direct.revision}, key, context('start'));
    expect(started).toMatchObject({status: 'VOTING', revision: direct.revision + 1, votingVersionId: direct.currentVersion.id});
    expect(await stage5.startDocumentVote(f.firstChair, direct.id, {baseRevision: direct.revision}, key, context('replay'))).toEqual(started);
    const formal = await stage5.createResolution(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, customTitle: null, content: 'Body'}, randomUUID(), context('formal'));
    await pool!.query("UPDATE documents SET status='PUBLISHED' WHERE id=$1", [formal.id]);
    const recommended = await stage5.commandDocument(f.firstChair, formal.id,
      {baseRevision: formal.revision, action: 'RECOMMEND_BALLOT', ruleStableId: 'vote-on-resolution'}, context('recommend'));
    expect(recommended).toMatchObject({status: 'PUBLISHED', votingVersionId: null, directVote: {startedAt: null}});
    const empty = await stage5.createDocumentVersion(f.firstChair, formal.id,
      {baseRevision: recommended.revision, onBehalfOfSeatId: f.firstSeat.id, customTitle: null, content: ''}, context('clear'));
    const create = () => stage5.createBallot(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, subjectType: 'RESOLUTION', subjectId: formal.id, procedural: false,
        thresholdKind: 'SIMPLE_MAJORITY'}, randomUUID(), context('formal-create'));
    await expect(create()).rejects.toMatchObject({reason: 'DRAFT_BODY_REQUIRED'});
    await stage5.createDocumentVersion(f.firstChair, formal.id,
      {baseRevision: empty.revision, onBehalfOfSeatId: f.firstSeat.id, customTitle: null, content: 'Filled'}, context('fill'));
    await create();
    expect((await stage4.snapshot(f.committee.id, f.firstChair)).documents!.find(item => item.id === formal.id))
      .toMatchObject({status: 'VOTING', votingVersionId: expect.any(String)});
  });

  it('repairs only orphan locks, preserves real votes and history, and can be rerun', async () => {
    const f = await meetingFixture();
    const orphan = await stage5.createResolution(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, customTitle: null, content: ''}, randomUUID(), context('orphan'));
    await pool!.query("UPDATE documents SET status='VOTING',voting_version_id=current_version_id WHERE id=$1", [orphan.id]);
    const live = await stage5.createResolution(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, customTitle: null, content: 'Body'}, randomUUID(), context('live'));
    const started = await stage5.startDocumentVote(f.firstChair, live.id, {baseRevision: live.revision}, randomUUID(), context('live-start'));
    const oldStarted = await stage5.createResolution(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, customTitle: null, content: 'Old started vote'}, randomUUID(), context('old-started'));
    await pool!.query('UPDATE document_voting SET direct_vote_started_at=now() WHERE document_id=$1', [oldStarted.id]);
    const formal = await stage5.createResolution(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, customTitle: null, content: 'Formal body'}, randomUUID(), context('formal-history'));
    await pool!.query("UPDATE documents SET status='PUBLISHED' WHERE id=$1", [formal.id]);
    await stage5.createBallot(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, subjectType: 'RESOLUTION', subjectId: formal.id, procedural: false,
        thresholdKind: 'SIMPLE_MAJORITY'}, randomUUID(), context('formal-history-ballot'));
    const history = await stage5.createResolution(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, customTitle: null, content: 'History body'}, randomUUID(), context('history'));
    await stage5.setResolutionDirectVote(f.firstChair, history.id, {seatId: f.firstSeat.id, choice: 'FOR'}, context('history-vote'));
    await pool!.query('UPDATE document_voting SET direct_vote_started_at=NULL WHERE document_id=$1', [history.id]);
    const terminal = await stage5.createResolution(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, customTitle: null, content: 'Terminal'}, randomUUID(), context('terminal'));
    await pool!.query("UPDATE documents SET status='PASSED' WHERE id=$1", [terminal.id]);
    const directive = await stage5.createResolution(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, draftType: 'DIRECTIVE', customTitle: null, content: 'Directive', onBehalfOfSeatId: f.firstSeat.id}, randomUUID(), context('directive'));
    await pool!.query("UPDATE documents SET status='PUBLISHED' WHERE id=$1", [directive.id]);
    await pool!.query("UPDATE documents SET status='VOTING',voting_version_id=current_version_id WHERE id=$1", [directive.id]);
    const deleted = await stage5.createResolution(f.firstChair, f.committee.id,
      {meetingSessionId: f.session.id, customTitle: null, content: 'Deleted'}, randomUUID(), context('deleted'));
    await pool!.query("UPDATE documents SET status='VOTING',voting_version_id=current_version_id,deleted_at=now(),deleted_by_user_id=$2 WHERE id=$1", [deleted.id, f.firstChair.user.id]);
    const before = (await pool!.query('SELECT id,status,voting_version_id,revision FROM documents WHERE id=ANY($1::uuid[]) ORDER BY id',
      [[live.id, formal.id, history.id, terminal.id, directive.id, deleted.id]])).rows;
    const sql = await readFile('server/migrations/0083_resolution_vote_lifecycle.sql', 'utf8');
    const client = await pool!.connect();
    try {
      for (let i = 0; i < 2; i++) {
        await client.query('BEGIN');
        try {await client.query(sql); await client.query('COMMIT');} catch (error) {await client.query('ROLLBACK'); throw error;}
      }
    } finally {client.release();}
    const snapshot = await stage4.snapshot(f.committee.id, f.firstChair);
    const repaired = snapshot.documents!.find(item => item.id === orphan.id)!;
    expect(repaired).toMatchObject({status: 'PUBLISHED', votingVersionId: null, revision: orphan.revision + 1});
    expect(snapshot.documents!.find(item => item.id === live.id)).toMatchObject({status: 'VOTING', revision: started.revision, votingVersionId: started.votingVersionId});
    expect(snapshot.documents!.find(item => item.id === oldStarted.id))
      .toMatchObject({status: 'VOTING', revision: oldStarted.revision + 1, votingVersionId: oldStarted.currentVersion.id});
    expect((await pool!.query('SELECT id,status,voting_version_id,revision FROM documents WHERE id=ANY($1::uuid[]) ORDER BY id',
      [[live.id, formal.id, history.id, terminal.id, directive.id, deleted.id]])).rows).toEqual(before);
    expect((await pool!.query("SELECT count(*)::int AS n FROM audit_log WHERE resource_id=$1 AND request_id='migration:0083'", [orphan.id])).rows[0].n).toBe(1);
    await stage5.createDocumentVersion(f.firstChair, orphan.id,
      {baseRevision: repaired.revision, onBehalfOfSeatId: f.firstSeat.id, customTitle: null, content: 'Recovered'}, context('recovered'));
    await expect(pool!.query('UPDATE documents SET voting_version_id=NULL WHERE id=$1', [live.id])).rejects.toThrow('immutable');
  });
});
