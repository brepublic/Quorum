// @vitest-environment node

import {expect, it} from 'vitest';
import pg from 'pg';
import {createHash, randomUUID} from 'node:crypto';
import {Stage4Service} from '../stage4/service';
import {Stage5Service} from './service';
import {
  adminUrl, databaseName, pool, stage3, stage4, stage5, context, integration, user, meetingFixture, meetingEndFixture, testCrisisNotice, preparedTestCrisis, publishedTestCrisis, replacePool, replaceStage5
} from '../../../test/stage5-postgres-fixture';

const {Pool} = pg;

integration('PostgreSQL crisis lifecycle', () => {
  it('preserves every timer owner across database reconnection without browser ticks', async () => {
    const f = await meetingFixture();
    let list = await stage5.createSpeakerList(f.firstChair, f.committee.id, {meetingSessionId: f.session.id,
      kind: 'MODERATED_CAUCUS', topic: 'Background timers', defaultSpeechMs: 60_000, totalDurationMs: 120_000},
      'background-list', context('background-list'));
    list = await stage5.joinSpeakerQueue(f.firstChair, list.id, {seatId: f.firstSeat.id, stance: 'FOR'},
      'background-join', context('background-join'));
    list = await stage5.advanceSpeakerQueue(f.firstChair, list.id, {baseRevision: list.revision}, context('background-stage'));
    const speech = await stage5.commandSpeech(f.firstChair, list.id, 'start', {baseRevision: list.revision}, context('background-speech'));
    const crisis = await publishedTestCrisis(f);
    const timers = [crisis.timer, ...(await stage4.snapshot(f.committee.id, f.firstChair)).timers!
      .filter(timer => [f.generalList.speechTimerId, list.totalTimerId].includes(timer.id))];
    for (const [ownerType, ownerId] of [['COMMITTEE', f.committee.id], ['SPEECH', speech.id]]) {
      timers.push(await stage5.createTimer(f.firstChair, f.committee.id, {ownerType, ownerId, durationMs: 60_000},
        `background-${ownerType}`, context(`background-${ownerType}`)));
    }
    const startedAt = new Date(Date.now() - 10_000);
    const starter = new Stage5Service(pool!, () => startedAt);
    const ids = timers.map(timer => timer.id);
    for (const timer of timers) {
      const reset = await stage5.commandTimer(f.firstChair, timer.id, 'reset',
        {baseRevision: timer.revision, durationMs: 60_000}, context(`background-reset-${timer.ownerType}`));
      await starter.commandTimer(f.firstChair, timer.id, 'start',
        {baseRevision: reset.revision}, context(`background-start-${timer.ownerType}`));
    }
    const before = (await pool!.query('SELECT id,running,started_at,remaining_at_start_ms,revision FROM timer_states WHERE id=ANY($1::uuid[]) ORDER BY id', [ids])).rows;

    await pool!.end();
    const url = new URL(adminUrl!); url.pathname = `/${databaseName}`;
    replacePool(new Pool({connectionString: url.toString()}));
    const reopened = new Stage4Service(pool!);
    const read = async () => {
      const view = await reopened.snapshot(f.committee.id, f.firstChair);
      return [...view.timers!.filter(timer => timer.ownerType !== 'CRISIS'), ...view.crises!.map(group => group.timer)]
        .filter(timer => ids.includes(timer.id));
    };
    const restored = await read();
    expect(restored.map(timer => timer.ownerType).sort()).toEqual(['CAUCUS', 'COMMITTEE', 'CRISIS', 'SPEAKER_LIST', 'SPEECH']);
    for (const timer of restored) {
      expect(timer.running).toBe(true);
      expect(timer.startedAt).toBe(startedAt.toISOString());
      expect(timer.remainingMs).toBe(60_000 - (Date.parse(timer.serverTime) - startedAt.getTime()));
      expect(timer.remainingMs).toBeLessThanOrEqual(50_000);
    }
    expect((await pool!.query('SELECT id,running,started_at,remaining_at_start_ms,revision FROM timer_states WHERE id=ANY($1::uuid[]) ORDER BY id', [ids])).rows).toEqual(before);
    // Simulate a longer browser absence with persisted start times already in the past.
    await pool!.query("UPDATE timer_states SET started_at=started_at-interval '2 minutes' WHERE id=ANY($1::uuid[])", [ids]);
    expect((await read()).every(timer => !timer.running && timer.remainingMs === 0)).toBe(true);
  });

  it('serializes two chairs creating updates and hides unpublished notices from public snapshots',async () => {
    const f = await meetingEndFixture();
    const second = await user('crisis-second-chair');
    await stage3.setChair(f.firstChair,f.committee.id,second.user.email,true,(await stage4.snapshot(f.committee.id,f.firstChair)).committee.revision,context('grant-crisis-chair'));
    const group = await publishedTestCrisis(f);
    const results = await Promise.allSettled([f.firstChair,second].map(auth => stage5.createCrisisUpdate(auth,group.id,{baseRevision: group.revision},randomUUID(),context('concurrent-update'))));
    expect(results.filter(result => result.status==='fulfilled')).toHaveLength(1);
    expect((await pool!.query("SELECT count(*)::int AS n FROM crisis_updates WHERE group_id=$1 AND status='UNPUBLISHED'",[group.id])).rows[0].n).toBe(1);
    const view = await stage4.snapshot(f.committee.id);
    expect(view.crises![0]!.updates).toHaveLength(1);
    expect(view.crises![0]!.updates[0]!.status).toBe('PENDING');
  });

  it('validates system names, corrects jumps, repeats imports, and replaces only unpublished notices',async () => {
    const f = await meetingEndFixture();
    const file = await testCrisisNotice(f,'Crisis Notice 1.3.1');
    await expect(stage5.previewCrisisNotice(f.firstChair,file.id)).rejects.toMatchObject({reason: 'CRISIS_NUMBER_MISMATCH',params: {session: 1,group: 1,update: 1}});
    const renamed = await stage5.saveCrisisNoticeName(f.firstChair,file.id,{baseRevision: file.revision,logicalName: 'Crisis Notice 1.1.1'},context('fix-number'));
    const first = await stage5.importCrisisNotice(f.firstChair,file.id,{baseRevision: renamed.revision},'repeat-import',context('first-import'));
    expect(await stage5.importCrisisNotice(f.firstChair,file.id,{baseRevision: renamed.revision},'repeat-import',context('repeat-import'))).toEqual(first);
    expect(await stage5.importCrisisNotice(f.firstChair,file.id,{baseRevision: renamed.revision},'another-import',context('duplicate-import'))).toEqual(first);
    const moved=await stage5.saveCrisisNoticeName(f.firstChair,file.id,{baseRevision:renamed.revision,logicalName:'Crisis Notice 1.3.1'},context('cannot-skip-group'));
    await expect(stage5.importCrisisNotice(f.firstChair,file.id,{baseRevision:moved.revision},randomUUID(),context('reject-skipped-group'))).rejects.toMatchObject({reason:'CRISIS_NUMBER_MISMATCH',params:{session:1,group:2,update:1}});
    await stage5.saveCrisisNoticeName(f.firstChair,file.id,{baseRevision:moved.revision,logicalName:'Crisis Notice 1.1.1'},context('restore-notice-number'));
    expect((await pool!.query('SELECT count(*)::int AS n FROM crisis_groups WHERE committee_id=$1',[f.committee.id])).rows[0].n).toBe(1);
    let group = (await stage4.snapshot(f.committee.id,f.firstChair)).crises![0]!;
    group = await stage5.updateCrisisCard(f.firstChair,first.updateId,{baseRevision: group.updates[0]!.revision,title: 'Keep title',handlingDurationMs: 60000},context('edit-before-replace'));
    const replacement = await testCrisisNotice(f);
    expect(await stage5.previewCrisisNotice(f.firstChair,replacement.id)).toMatchObject({replacement: {id: file.id}});
    await expect(stage5.importCrisisNotice(f.firstChair,replacement.id,{baseRevision: replacement.revision},'unconfirmed-replace',context('no-replace'))).rejects.toMatchObject({reason: 'CRISIS_NOTICE_CONFLICT'});
    await stage5.importCrisisNotice(f.firstChair,replacement.id,{baseRevision: replacement.revision,replaceNoticeId: file.id},'confirmed-replace',context('replace'));
    group = (await stage4.snapshot(f.committee.id,f.firstChair)).crises![0]!;
    expect(group.updates[0]).toMatchObject({id: first.updateId,ordinal: 1,title: 'Keep title',handlingDurationMs: 60000,notice: {id: replacement.id}});
    expect((await pool!.query('SELECT status FROM file_entries WHERE id=$1',[file.id])).rows[0].status).toBe('PENDING_REVIEW');
    await stage5.publishCrisis(f.firstChair,first.updateId,{baseRevision: group.updates[0]!.revision},'publish-replaced',context('publish-replaced'));
    await expect(stage5.previewCrisisNotice(f.firstChair,file.id)).rejects.toMatchObject({reason: 'CRISIS_NUMBER_MISMATCH',params: {update: 2}});
    const missing = await testCrisisNotice(f,'Crisis Notice 99.1.1');
    await expect(stage5.previewCrisisNotice(f.firstChair,missing.id)).rejects.toMatchObject({reason: 'CRISIS_SESSION_MISSING'});
  });

  it('imports into existing or next groups and moves only unpublished associations after validation',async () => {
    const f=await meetingEndFixture();
    const first=await publishedTestCrisis(f);
    await stage5.createCrisisUpdate(f.firstChair,first.id,{baseRevision:first.revision},randomUUID(),context('first-draft'));
    const file=await testCrisisNotice(f,'Crisis Notice 1.1.2');
    const original=await stage5.importCrisisNotice(f.firstChair,file.id,{baseRevision:file.revision},randomUUID(),context('original-association'));
    const originalCard=(await stage4.snapshot(f.committee.id,f.firstChair)).crises!.find(group=>group.id===first.id)!.updates[0]!;
    await stage5.updateCrisisCard(f.firstChair,original.updateId,{baseRevision:originalCard.revision,title:'Preserved draft',handlingDurationMs:60000},context('original-draft-content'));
    const second=await stage5.createCrisis(f.firstChair,f.committee.id,{meetingSessionId:f.session.id},randomUUID(),context('second-group'));
    let renamed=await stage5.saveCrisisNoticeName(f.firstChair,file.id,{baseRevision:file.revision,logicalName:'Crisis Notice 1.2.1'},context('existing-group-name'));
    expect(await stage5.previewCrisisNotice(f.firstChair,file.id)).toMatchObject({groupId:second.id,updateId:second.updates[0]!.id,replacement:null});
    expect((await pool!.query('SELECT notice_file_id FROM crisis_updates WHERE id=$1',[original.updateId])).rows[0].notice_file_id).toBe(file.id);
    const imported=await stage5.importCrisisNotice(f.firstChair,file.id,{baseRevision:renamed.revision},randomUUID(),context('move-to-existing'));
    expect(imported).toEqual({groupId:second.id,updateId:second.updates[0]!.id});
    expect((await pool!.query('SELECT status,notice_file_id,title,handling_duration_ms FROM crisis_updates WHERE id=$1',[original.updateId])).rows[0])
      .toMatchObject({status:'UNPUBLISHED',notice_file_id:null,title:'Preserved draft',handling_duration_ms:'60000'});
    for (const name of ['Crisis Notice 1.4.1','Crisis Notice 1.3.2']) {
      renamed=await stage5.saveCrisisNoticeName(f.firstChair,file.id,{baseRevision:renamed.revision,logicalName:name},context('skipped-number'));
      await expect(stage5.importCrisisNotice(f.firstChair,file.id,{baseRevision:renamed.revision},randomUUID(),context('reject-skip')))
        .rejects.toMatchObject({reason:'CRISIS_NUMBER_MISMATCH',params:{session:1,group:3,update:1}});
      expect((await pool!.query('SELECT notice_file_id FROM crisis_updates WHERE id=$1',[imported.updateId])).rows[0].notice_file_id).toBe(file.id);
    }
    renamed=await stage5.saveCrisisNoticeName(f.firstChair,file.id,{baseRevision:renamed.revision,logicalName:'Crisis Notice 1.3.1'},context('new-group-name'));
    expect(await stage5.previewCrisisNotice(f.firstChair,file.id)).toMatchObject({groupId:null,updateId:null});
    const third=await stage5.importCrisisNotice(f.firstChair,file.id,{baseRevision:renamed.revision},randomUUID(),context('create-third-group'));
    expect(await stage5.importCrisisNotice(f.firstChair,file.id,{baseRevision:renamed.revision},randomUUID(),context('repeat-third-import'))).toEqual(third);
    expect((await stage4.snapshot(f.committee.id,f.firstChair)).crises).toHaveLength(3);
    const jump=await testCrisisNotice(f,'Crisis Notice 1.1.4');
    await expect(stage5.previewCrisisNotice(f.firstChair,jump.id)).rejects.toMatchObject({reason:'CRISIS_NUMBER_MISMATCH',params:{session:1,group:1,update:2}});
    renamed=await stage5.saveCrisisNoticeName(f.firstChair,file.id,{baseRevision:renamed.revision,logicalName:'Crisis Notice 1.1.2'},context('card-association-name'));
    const emptyCard=(await stage4.snapshot(f.committee.id,f.firstChair)).crises!.find(group=>group.id===first.id)!.updates[0]!;
    await stage5.updateCrisisCard(f.firstChair,emptyCard.id,{baseRevision:emptyCard.revision,fileId:file.id},context('move-from-card'));
    expect((await pool!.query('SELECT notice_file_id FROM crisis_updates WHERE id=$1',[third.updateId])).rows[0].notice_file_id).toBeNull();
    await pool!.query('UPDATE crisis_groups SET ended_at=now() WHERE id=$1',[second.id]);
    const ended=await testCrisisNotice(f,'Crisis Notice 1.2.2');
    await expect(stage5.importCrisisNotice(f.firstChair,ended.id,{baseRevision:ended.revision},randomUUID(),context('ended-group')))
      .rejects.toMatchObject({reason:'CRISIS_GROUP_ENDED'});
  });

  it('rolls publication back completely and does not reset a timer on retry',async () => {
    const f = await meetingEndFixture(); const group = await preparedTestCrisis(f); const card = group.updates[0]!;
    await pool!.query(`CREATE FUNCTION fail_crisis_publish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='storage.file_published' THEN RAISE EXCEPTION 'Injected failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_crisis_publish BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_crisis_publish()`);
    await expect(stage5.publishCrisis(f.firstChair,card.id,{baseRevision: card.revision},'rollback-publish',context('rollback-publish'))).rejects.toThrow('Injected failure');
    expect((await stage4.snapshot(f.committee.id,f.firstChair)).crises![0]).toMatchObject({revision: group.revision,autoStartAt: null,timer: {revision: group.timer.revision,running: false,remainingMs: 0},updates: [{status: 'UNPUBLISHED',revision: card.revision,notice: {status: 'PENDING_REVIEW'}}]});
    await pool!.query('DROP TRIGGER fail_crisis_publish ON audit_log; DROP FUNCTION fail_crisis_publish()');
    const published = await stage5.publishCrisis(f.firstChair,card.id,{baseRevision: card.revision},'rollback-publish',context('retry-publish'));
    const started = await stage5.commandTimer(f.firstChair,published.timer.id,'start',{baseRevision: published.timer.revision},context('manual-start'));
    await stage5.publishCrisis(f.firstChair,card.id,{baseRevision: card.revision},'rollback-publish',context('duplicate-publish'));
    expect((await stage4.snapshot(f.committee.id,f.firstChair)).crises![0]!.timer.revision).toBe(started.revision);
  });

  it('restores overdue automatic starts from durable plans and handles all three settings',async () => {
    const f = await meetingEndFixture(); let clock = new Date(); replaceStage5(new Stage5Service(pool!,()=>clock));
    const group = await publishedTestCrisis(f); expect(group.autoStartAt).not.toBeNull();
    const archivedFixture=await meetingEndFixture();const archivedGroup=await publishedTestCrisis(archivedFixture);
    const archivedRevision=(await stage4.snapshot(archivedFixture.committee.id,archivedFixture.firstChair)).committee.revision;
    await stage3.archiveCommittee(archivedFixture.firstChair,archivedFixture.committee.id,archivedRevision,context('archive-crisis-plan'));
    let snapshot = await stage4.snapshot(f.committee.id,f.firstChair);
    await stage5.setCrisisAutoStartDelay(f.firstChair,f.committee.id,{baseRevision: snapshot.committee.revision,minutes: 0},context('immediate-setting'));
    expect((await stage4.snapshot(f.committee.id,f.firstChair)).crises![0]!.autoStartAt).toBe(group.autoStartAt);
    clock = new Date(clock.getTime()+330000); replaceStage5(new Stage5Service(pool!,()=>clock));
    await stage5.processCrisisAutoStarts();
    const restored = (await pool!.query('SELECT running,started_at,remaining_at_start_ms FROM timer_states WHERE id=$1',[group.timer.id])).rows[0];
    expect(restored).toMatchObject({running: true,remaining_at_start_ms: '1800000'});
    expect(restored.started_at.toISOString()).toBe(group.autoStartAt);
    expect((await pool!.query('SELECT running FROM timer_states WHERE id=$1',[archivedGroup.timer.id])).rows[0].running).toBe(false);
    expect((await pool!.query('SELECT auto_start_at FROM crisis_groups WHERE id=$1',[archivedGroup.id])).rows[0].auto_start_at.toISOString()).toBe(archivedGroup.autoStartAt);
    const immediate = await publishedTestCrisis(f,'Crisis Notice 1.2.1'); expect(immediate.timer.running).toBe(true);
    snapshot = await stage4.snapshot(f.committee.id,f.firstChair);
    await stage5.setCrisisAutoStartDelay(f.firstChair,f.committee.id,{baseRevision: snapshot.committee.revision,minutes: -1},context('manual-setting'));
    const manual = await publishedTestCrisis(f,'Crisis Notice 1.3.1'); expect(manual).toMatchObject({autoStartAt: null,timer: {running: false}});
    const paused = await stage5.commandTimer(f.firstChair,immediate.timer.id,'pause',{baseRevision: immediate.timer.revision},context('pause-manual'));
    clock = new Date(clock.getTime()+3600000); await stage5.processCrisisAutoStarts();
    expect((await pool!.query('SELECT running,revision FROM timer_states WHERE id=$1',[paused.id])).rows[0]).toMatchObject({running: false,revision: paused.revision});
  });

  it('invalidates unfinished directives, preserves votes, and makes completed old-version corrections historical',async () => {
    const f = await meetingEndFixture(); const group = await publishedTestCrisis(f);
    const make = async (name: string) => {
      let d = await stage5.createResolution(f.firstChair,f.committee.id,{meetingSessionId: f.session.id,draftType: 'DIRECTIVE',content: name,customTitle: null},name,context(name));
      d = await stage5.updateDocumentSettings(f.firstChair,d.id,{baseRevision: d.revision,crisisGroupId: group.id},context('directive-link'));
      return stage5.startDocumentVote(f.firstChair,d.id,{baseRevision: d.revision},randomUUID(),context('directive-start'));
    };
    let completed = await make('completed-old'); const unfinished = await make('unfinished-old');
    completed = await stage5.setResolutionDirectVote(f.firstChair,completed.id,{seatId: f.firstSeat.id,choice: 'AGAINST'},context('old-failed'));
    const next = await preparedTestCrisis(f,'Crisis Notice 1.1.2');
    expect((await stage4.snapshot(f.committee.id,f.firstChair)).documents!.find(d=>d.id===unfinished.id)!.directVote!.invalidatedAt).toBeNull();
    await stage5.publishCrisis(f.firstChair,next.updates[0]!.id,{baseRevision: next.updates[0]!.revision},'update-publish',context('update-publish'));
    await expect(stage5.setResolutionDirectVote(f.firstChair,unfinished.id,{seatId: f.firstSeat.id,choice: 'FOR'},context('invalid-vote'))).rejects.toMatchObject({reason: 'CRISIS_UPDATED'});
    await stage5.setResolutionDirectVote(f.firstChair,completed.id,{seatId: f.firstSeat.id,choice: 'FOR'},context('historical-correction'));
    const snapshot = await stage4.snapshot(f.committee.id,f.firstChair);
    expect(snapshot.crises![0]).toMatchObject({endedAt: null,updates: [{status: 'PENDING'},{status: 'SUPERSEDED'}]});
    expect(snapshot.documents!.find(d=>d.id===completed.id)!.status).toBe('PASSED');
    await expect(stage5.createAmendment(f.firstChair,completed.id,{meetingSessionId: f.session.id,onBehalfOfSeatId: f.firstSeat.id,amendmentType: 'FRIENDLY',content: '',customTitle: null},'directive-amendment',context('directive-amendment'))).rejects.toMatchObject({reason: 'DIRECTIVE_AMENDMENTS_FORBIDDEN'});
  });

  it('requires atomic confirmation to end all unfinished groups and pause the committee',async () => {
    const f = await meetingEndFixture(); await publishedTestCrisis(f); await preparedTestCrisis(f,'Crisis Notice 1.2.1');
    const snapshot = await stage4.snapshot(f.committee.id,f.firstChair);
    await expect(stage3.setCommitteeStatus(f.firstChair,f.committee.id,'PAUSED',snapshot.committee.revision,context('pause-without-ending'))).rejects.toMatchObject({reason: 'CRISIS_PAUSE_CONFIRMATION'});
    expect((await stage4.snapshot(f.committee.id,f.firstChair)).committee.status).toBe('ACTIVE');
    await stage3.setCommitteeStatus(f.firstChair,f.committee.id,'PAUSED',snapshot.committee.revision,context('end-and-pause'),true);
    const paused = await stage4.snapshot(f.committee.id,f.firstChair);
    expect(paused.committee.status).toBe('PAUSED');
    expect(paused.crises!.every(g=>g.endedAt && !g.autoStartAt && !g.timer.running && g.updates.every(u=>u.status==='ENDED'))).toBe(true);
    expect(paused.crises!.find(g=>g.ordinal===2)!.updates[0]!.notice!.status).toBe('PENDING_REVIEW');
  });

  it('orders simultaneous publication and complete vote submission under the same committee lock',async()=> {
    const f=await meetingFixture(); const group=await publishedTestCrisis(f);
    let directive=await stage5.createResolution(f.firstChair,f.committee.id,{meetingSessionId:f.session.id,draftType:'DIRECTIVE',content:'Respond',customTitle:null},randomUUID(),context('race-directive'));
    directive=await stage5.updateDocumentSettings(f.firstChair,directive.id,{baseRevision:directive.revision,crisisGroupId:group.id},context('race-link'));
    directive=await stage5.startDocumentVote(f.firstChair,directive.id,{baseRevision:directive.revision},randomUUID(),context('race-start'));
    const next=await preparedTestCrisis(f,'Crisis Notice 1.1.2'); const card=next.updates[0]!;
    const vote=directive.directVote!;
    const outcomes=await Promise.allSettled([
      stage5.publishCrisis(f.firstChair,card.id,{baseRevision:card.revision},randomUUID(),context('race-publish')),
      stage5.submitResolutionDirectVote(f.firstChair,directive.id,{baseDocumentRevision:directive.revision,baseSettingsRevision:vote.settingsRevision,
        baseCastRevision:vote.castRevision,eligibility:vote.eligibility,votes:vote.eligibility.map(seat=>({seatId:seat.seatId,choice:'FOR'}))},randomUUID(),context('race-submit'))
    ]);
    expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    const snapshot=await stage4.snapshot(f.committee.id,f.firstChair);
    const saved=snapshot.documents!.find(d=>d.id===directive.id)!;
    if(outcomes[0]!.status==='fulfilled') {
      expect(outcomes[1]).toMatchObject({status:'rejected',reason:{reason:'CRISIS_UPDATED'}});
      expect(snapshot.crises![0]!.endedAt).toBeNull();expect(saved.directVote!.votes).toHaveLength(0);
    } else {
      expect(outcomes[0]).toMatchObject({status:'rejected',reason:{reason:'CRISIS_GROUP_ENDED'}});
      expect(snapshot.crises![0]!.updates.every(update=>update.status==='ENDED')).toBe(true);
      expect(saved).toMatchObject({status:'PASSED',directVote:{completedAt:expect.any(String)}});
      await stage5.setResolutionDirectVote(f.firstChair,directive.id,{seatId:f.firstSeat.id,choice:'AGAINST'},context('race-correction'));
      const restored=(await stage4.snapshot(f.committee.id,f.firstChair)).crises![0]!;
      expect(restored).toMatchObject({endedAt:null,autoStartAt:null,timer:{running:false},updates:[{status:'UNPUBLISHED'},{status:'PENDING'}]});
    }
  });

  it('preserves partial saved votes on invalidation and never restarts after a manual pause',async()=> {
    const f=await meetingFixture();const group=await publishedTestCrisis(f);
    let d=await stage5.createResolution(f.firstChair,f.committee.id,{meetingSessionId:f.session.id,draftType:'DIRECTIVE',content:'Respond',customTitle:null},randomUUID(),context('partial-directive'));
    d=await stage5.updateDocumentSettings(f.firstChair,d.id,{baseRevision:d.revision,crisisGroupId:group.id},context('partial-link'));
    d=await stage5.startDocumentVote(f.firstChair,d.id,{baseRevision:d.revision},randomUUID(),context('partial-start'));
    d=await stage5.setResolutionDirectVote(f.firstChair,d.id,{seatId:f.firstSeat.id,choice:'FOR'},context('partial-vote'));
    expect(d.directVote!.completedAt).toBeNull();
    let timer=await stage5.commandTimer(f.firstChair,group.timer.id,'start',{baseRevision:group.timer.revision},context('manual-start'));
    timer=await stage5.commandTimer(f.firstChair,timer.id,'pause',{baseRevision:timer.revision},context('manual-pause'));
    const later=new Stage5Service(pool!,()=>new Date(Date.now()+3600000));await later.processCrisisAutoStarts();
    expect((await stage4.snapshot(f.committee.id,f.firstChair)).crises![0]).toMatchObject({autoStartAt:null,timer:{running:false,revision:timer.revision}});
    const next=await preparedTestCrisis(f,'Crisis Notice 1.1.2');await stage5.publishCrisis(f.firstChair,next.updates[0]!.id,{baseRevision:next.updates[0]!.revision},randomUUID(),context('partial-update'));
    const invalid=(await stage4.snapshot(f.committee.id,f.firstChair)).documents!.find(doc=>doc.id===d.id)!;
    expect(invalid).toMatchObject({status:'FAILED',directVote:{invalidatedAt:expect.any(String),votes:[{seatId:f.firstSeat.id,choice:'FOR'}]}});
  });

  it('allows a new session directive to end an earlier group and retains closure while another effective directive passes',async()=> {
    const f=await meetingFixture();const group=await publishedTestCrisis(f);
    await stage4.closeMeetingSession(f.firstChair,f.session.id,{baseRevision:f.session.revision},context('crisis-next-session'));
    const session=await stage4.startMeetingSession(f.firstChair,f.committee.id,{},context('crisis-new-session'),randomUUID());
    for(const seat of [f.firstSeat,f.secondSeat]) await stage4.createAttendanceEvent(f.firstChair,f.committee.id,{meetingSessionId:session.id,seatId:seat.id,type:'PRESENT'},context('crisis-present'));
    const make=async()=> {
      let d=await stage5.createResolution(f.firstChair,f.committee.id,{meetingSessionId:session.id,draftType:'DIRECTIVE',content:'Respond',customTitle:null},randomUUID(),context('cross-session-directive'));
      d=await stage5.updateDocumentSettings(f.firstChair,d.id,{baseRevision:d.revision,crisisGroupId:group.id},context('cross-session-link'));
      d=await stage5.startDocumentVote(f.firstChair,d.id,{baseRevision:d.revision},randomUUID(),context('cross-session-start'));
      for(const seat of [f.firstSeat,f.secondSeat]) d=await stage5.setResolutionDirectVote(f.firstChair,d.id,{seatId:seat.id,choice:'AGAINST'},context('cross-session-failed'));
      return d;
    };
    const first=await make(),second=await make();
    await stage5.createCrisisUpdate(f.firstChair,group.id,{baseRevision:group.revision},randomUUID(),context('draft-before-end'));
    for(const d of [first,second]) for(const seat of [f.firstSeat,f.secondSeat]) await stage5.setResolutionDirectVote(f.firstChair,d.id,{seatId:seat.id,choice:'FOR'},context('cross-session-passed'));
    await stage5.setResolutionDirectVote(f.firstChair,first.id,{seatId:f.firstSeat.id,choice:'AGAINST'},context('first-corrected'));
    expect((await stage4.snapshot(f.committee.id,f.firstChair)).crises![0]!.endedAt).not.toBeNull();
    await stage5.setResolutionDirectVote(f.firstChair,second.id,{seatId:f.firstSeat.id,choice:'AGAINST'},context('second-corrected'));
    expect((await stage4.snapshot(f.committee.id,f.firstChair)).crises![0]).toMatchObject({sessionOrdinal:1,endedAt:null,autoStartAt:null,timer:{running:false},updates:[{status:'UNPUBLISHED'},{status:'PENDING'}]});
  });
});
