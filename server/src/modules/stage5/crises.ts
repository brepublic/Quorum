import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {parseCrisisNoticeName, type CrisisGroup, type CrisisNoticePreview, type ApiErrorParams} from '@quorum/contracts';
import {AppError} from '../../http/errors.js';
import {appendEvent, audit, type Stage4CommitteeRow, type Stage4Context} from '../stage4/database.js';

export async function recordCrisisChange(client: PoolClient, committee: Stage4CommitteeRow, groupId: string,
  command: string, actorUserId: string, context: Stage4Context, audience: 'PUBLIC' | 'CHAIR' = 'PUBLIC') {
  const group = (await client.query('SELECT revision FROM crisis_groups WHERE id=$1', [groupId])).rows[0]!;
  await appendEvent(client, committee, {type: 'crisis.changed', resourceType: 'crisis_group', resourceId: groupId,
    revision: group.revision, audience, payload: {command}});
  await audit(client, context, {committeeId: committee.id, actorUserId, capabilities: ['CHAIR'],
    action: 'crises.changed', resourceType: 'crisis_group', resourceId: groupId, after: {command, revision: group.revision}});
}

export async function crisisGroups(client: PoolClient, committeeId: string, publicOnly = false, now = new Date()): Promise<CrisisGroup[]> {
  const groups = (await client.query(`SELECT g.*,s.ordinal AS session_ordinal,t.running,t.started_at,t.remaining_at_start_ms,
    t.revision AS timer_revision,t.expired_at FROM crisis_groups g JOIN meeting_sessions s ON s.id=g.meeting_session_id
    JOIN timer_states t ON t.id=g.timer_id WHERE g.committee_id=$1 ORDER BY s.ordinal DESC,g.ordinal DESC`, [committeeId])).rows;
  const updates = (await client.query(`SELECT u.*,e.logical_name,e.status AS file_status FROM crisis_updates u
    LEFT JOIN file_entries e ON e.id=u.notice_file_id WHERE u.committee_id=$1 ORDER BY u.ordinal DESC`, [committeeId])).rows;
  return groups.flatMap(g => {
    const cards = updates.filter(u => u.group_id === g.id && (!publicOnly || u.published_at)).map(u => ({id: u.id,
      groupId: u.group_id, ordinal: u.ordinal, title: u.title, status: u.status,
      handlingDurationMs: u.handling_duration_ms === null ? null : Number(u.handling_duration_ms),
      notice: u.notice_file_id ? {id: u.notice_file_id, logicalName: u.notice_name ?? u.logical_name ?? '', status: u.file_status} : null,
      revision: u.revision, publishedAt: u.published_at?.toISOString() ?? null}));
    if (publicOnly && !cards.length) return [];
    const remaining = g.running && g.started_at ? Math.max(0, Number(g.remaining_at_start_ms) - Math.max(0, now.getTime() - g.started_at.getTime()))
      : Number(g.remaining_at_start_ms);
    return [{id: g.id, committeeId, meetingSessionId: g.meeting_session_id, sessionOrdinal: g.session_ordinal,
      ordinal: g.ordinal, nextUpdateOrdinal: g.next_update_ordinal, revision: g.revision,
      endedAt: g.ended_at?.toISOString() ?? null, autoStartAt: g.auto_start_at?.toISOString() ?? null, updates: cards,
      timer: {id: g.timer_id, committeeId, ownerType: 'CRISIS' as const, ownerId: g.id, running: g.running && remaining > 0,
        startedAt: g.started_at?.toISOString() ?? null, remainingAtStartMs: Number(g.remaining_at_start_ms), remainingMs: remaining,
        revision: g.timer_revision, expiredAt: g.expired_at?.toISOString() ?? null, serverTime: now.toISOString()}}];
  });
}

export async function insertCrisisGroup(client: PoolClient, committeeId: string, sessionId: string, actorId: string): Promise<string> {
  const id = randomUUID(); const timerId = randomUUID();
  await client.query(`INSERT INTO timer_states(id,committee_id,owner_type,owner_id,remaining_at_start_ms,created_by_user_id)
    VALUES ($1,$2,'CRISIS',$3,0,$4)`, [timerId, committeeId, id, actorId]);
  await client.query(`INSERT INTO crisis_groups(id,committee_id,meeting_session_id,timer_id) VALUES ($1,$2,$3,$4)`, [id,committeeId,sessionId,timerId]);
  return id;
}

export async function insertCrisisUpdate(client: PoolClient, committeeId: string, groupId: string, fileId?: string): Promise<string> {
  const id = randomUUID();
  await client.query(`INSERT INTO crisis_updates(id,committee_id,group_id,notice_file_id) VALUES ($1,$2,$3,$4)`, [id,committeeId,groupId,fileId ?? null]);
  await client.query('UPDATE crisis_groups SET revision=revision+1 WHERE id=$1', [groupId]);
  return id;
}

export async function closeCrisisGroup(client: PoolClient, committee: Stage4CommitteeRow, groupId: string,
  actorId: string, context: Stage4Context, now: Date, manual = false) {
  const group = (await client.query('SELECT * FROM crisis_groups WHERE id=$1 FOR UPDATE', [groupId])).rows[0]!;
  if (group.ended_at) return;
  await client.query(`UPDATE crisis_updates SET status_before_end=status,status='ENDED',revision=revision+1
    WHERE group_id=$1 AND status<>'ENDED'`, [groupId]);
  await client.query(`UPDATE crisis_groups SET ended_at=$2,manually_ended=$3,auto_start_at=NULL,revision=revision+1 WHERE id=$1`, [groupId,now,manual]);
  const timer = (await client.query(`UPDATE timer_states SET remaining_at_start_ms=CASE WHEN running THEN greatest(0,remaining_at_start_ms-
    greatest(0,floor(extract(epoch FROM ($2::timestamptz-started_at))*1000)::bigint)) ELSE remaining_at_start_ms END,
    running=false,started_at=NULL,revision=revision+1,updated_at=$2 WHERE id=$1 RETURNING revision,remaining_at_start_ms`, [group.timer_id,now])).rows[0]!;
  await appendEvent(client, committee, {type: 'timer.changed',resourceType: 'timer',resourceId: group.timer_id,revision: timer.revision,audience: 'PUBLIC',payload: {command: 'CRISIS_ENDED'}});
  await audit(client,context,{committeeId: committee.id,actorUserId: actorId,capabilities: ['CHAIR'],action: 'timers.paused',resourceType: 'timer',resourceId: group.timer_id,after: {running: false,remainingMs: Number(timer.remaining_at_start_ms),revision: timer.revision}});
  await recordCrisisChange(client,committee,groupId,manual ? 'ENDED_BY_CHAIR' : 'ENDED_BY_DIRECTIVE',actorId,context);
}

export async function reconcileCrisisResult(client: PoolClient, committee: Stage4CommitteeRow, groupId: string,
  actorId: string, context: Stage4Context, now: Date) {
  const group = (await client.query('SELECT * FROM crisis_groups WHERE id=$1 FOR UPDATE', [groupId])).rows[0]!;
  if (group.manually_ended) return;
  const current = (await client.query(`SELECT id FROM crisis_updates WHERE group_id=$1 AND published_at IS NOT NULL
    ORDER BY ordinal DESC LIMIT 1`, [groupId])).rows[0];
  const passed = await client.query(`SELECT 1 FROM document_voting v JOIN documents d ON d.id=v.document_id
    WHERE v.crisis_group_id=$1 AND v.crisis_update_id=$2 AND v.crisis_invalidated_at IS NULL
      AND v.direct_vote_completed_at IS NOT NULL AND v.completed_outcome='PASSED' AND d.deleted_at IS NULL LIMIT 1`, [groupId,current?.id]);
  if (passed.rowCount) {await closeCrisisGroup(client,committee,groupId,actorId,context,now); return;}
  if (!group.ended_at) return;
  await client.query(`UPDATE crisis_updates SET status=status_before_end,status_before_end=NULL,revision=revision+1
    WHERE group_id=$1 AND status='ENDED' AND status_before_end IS NOT NULL`, [groupId]);
  await client.query(`UPDATE crisis_groups SET ended_at=NULL,auto_start_at=NULL,revision=revision+1 WHERE id=$1`, [groupId]);
  await recordCrisisChange(client,committee,groupId,'RESTORED_BY_CORRECTION',actorId,context);
}

export async function requireDirectiveCrisis(client: PoolClient, documentId: string, committeeId: string) {
  const metadata = (await client.query(`SELECT v.*,g.ended_at FROM document_voting v LEFT JOIN crisis_groups g
    ON g.id=v.crisis_group_id WHERE v.document_id=$1`, [documentId])).rows[0]!;
  if (metadata.crisis_invalidated_at) throw new AppError({code: 'RESOURCE_CONFLICT',reason: 'CRISIS_UPDATED',message: 'Crisis updated.'});
  // Existing completed votes remain historical records; they do not gain a crisis association during migration.
  if (metadata.direct_vote_completed_at) return;
  if (!metadata.crisis_group_id) throw new AppError({code: 'VALIDATION_FAILED',reason: 'CRISIS_ASSOCIATION_REQUIRED',message: 'Select a crisis.'});
  if (metadata.ended_at) throw new AppError({code: 'RESOURCE_CONFLICT',reason: 'CRISIS_GROUP_ENDED',message: 'Crisis ended.'});
  const pending = await client.query(`SELECT 1 FROM crisis_updates WHERE id=$1 AND committee_id=$2 AND status='PENDING'`, [metadata.crisis_update_id,committeeId]);
  if (!pending.rowCount) throw new AppError({code: 'RESOURCE_CONFLICT',reason: 'CRISIS_UPDATED',message: 'Crisis updated.'});
}

export async function crisisNoticePreview(client: PoolClient, committeeId: string, fileId: string): Promise<CrisisNoticePreview> {
  const file = (await client.query(`SELECT e.*,m.file_type,m.submission_source,b.durability_state FROM file_entries e
    JOIN delegate_file_metadata m ON m.file_entry_id=e.id LEFT JOIN file_versions v ON v.id=e.current_version_id
    LEFT JOIN file_blobs b ON b.id=v.blob_id WHERE e.id=$1 AND e.committee_id=$2`, [fileId,committeeId])).rows[0];
  if (!file || file.file_type !== 'CRISIS_NOTICE' || !['UPLOAD_COMPLETE','PENDING_REVIEW'].includes(file.status)
    || file.durability_state !== 'COMMITTED') throw new AppError({code: 'VALIDATION_FAILED',reason: 'CRISIS_NOTICE_REQUIRED',message: 'Saved crisis notice required.'});
  const number = parseCrisisNoticeName(file.logical_name);
  if (!number) throw new AppError({code: 'VALIDATION_FAILED',reason: 'CRISIS_NUMBER_REQUIRED',message: 'Complete crisis number.'});
  const mismatch = (params: ApiErrorParams): never => {throw new AppError({code: 'RESOURCE_CONFLICT',reason: 'CRISIS_NUMBER_MISMATCH',params,message: 'Use the next crisis number.'});};
  const linked=(await client.query(`SELECT u.id,u.group_id,u.ordinal,g.ordinal AS group_ordinal,s.ordinal AS session_ordinal
    FROM crisis_updates u JOIN crisis_groups g ON g.id=u.group_id JOIN meeting_sessions s ON s.id=g.meeting_session_id
    WHERE u.notice_file_id=$1 AND u.committee_id=$2`,[fileId,committeeId])).rows[0];
  if(linked) {
    if(linked.session_ordinal!==number.sessionOrdinal || linked.group_ordinal!==number.groupOrdinal || linked.ordinal!==number.updateOrdinal)
      mismatch({session:linked.session_ordinal,group:linked.group_ordinal,update:linked.ordinal});
    return {...number,groupId:linked.group_id,updateId:linked.id,replacement:null};
  }
  const session = (await client.query('SELECT * FROM meeting_sessions WHERE committee_id=$1 AND ordinal=$2', [committeeId,number.sessionOrdinal])).rows[0];
  if (!session) throw new AppError({code: 'VALIDATION_FAILED',reason: 'CRISIS_SESSION_MISSING',message: 'Session not found.'});
  const group = (await client.query('SELECT * FROM crisis_groups WHERE meeting_session_id=$1 AND ordinal=$2', [session.id,number.groupOrdinal])).rows[0];
  if (!group) {
    if (number.groupOrdinal !== session.next_crisis_ordinal || number.updateOrdinal !== 1) mismatch({session: number.sessionOrdinal,group: session.next_crisis_ordinal,update: 1});
    return {...number,groupId: null,updateId: null,replacement: null};
  }
  if (group.ended_at) throw new AppError({code: 'RESOURCE_CONFLICT',reason: 'CRISIS_GROUP_ENDED',message: 'Crisis ended.'});
  const draft = (await client.query(`SELECT u.*,e.logical_name,v.original_name FROM crisis_updates u LEFT JOIN file_entries e ON e.id=u.notice_file_id
    LEFT JOIN file_versions v ON v.id=e.current_version_id
    WHERE u.group_id=$1 AND u.status='UNPUBLISHED'`, [group.id])).rows[0];
  if (number.updateOrdinal !== (draft?.ordinal ?? group.next_update_ordinal)) mismatch({session: number.sessionOrdinal,group: group.ordinal,update: draft?.ordinal ?? group.next_update_ordinal});
  return {...number,groupId: group.id,updateId: draft?.id ?? null,
    replacement: draft?.notice_file_id ? {id: draft.notice_file_id,logicalName: draft.logical_name,originalName:draft.original_name} : null};
}
