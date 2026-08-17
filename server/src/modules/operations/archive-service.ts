import {Readable} from 'node:stream';
import type {Pool, PoolClient, QueryResultRow} from 'pg';
import {AppError} from '../../http/errors.js';
import type {AuthenticatedSession} from '../identity/store.js';

const PAGE_SIZE = 500;

interface ArchiveCommitteeRow extends QueryResultRow {
  id: string; owner_user_id: string; name: string; chair_label: string; topic: string; conference: string;
  visibility: string; operation_mode: string; status: string; revision: number; created_at: Date; archived_at: Date | null;
}

interface ArchiveSection {
  name: string;
  query: string;
}

export const ARCHIVE_SECTIONS: readonly ArchiveSection[] = Object.freeze([
  {name: 'committee_memberships', query: `SELECT user_id,status,joined_at,updated_at FROM committee_memberships WHERE committee_id=$1 ORDER BY user_id`},
  {name: 'committee_chairs', query: `SELECT user_id,granted_at,revoked_at FROM committee_capabilities WHERE committee_id=$1 ORDER BY user_id`},
  {name: 'committee_seats', query: `SELECT id,stable_key,display_name,rank,can_vote,has_veto,must_vote,sort_order,active,revision,created_at,updated_at FROM committee_seats WHERE committee_id=$1 ORDER BY sort_order,id`},
  {name: 'seat_assignments', query: `SELECT id,seat_id,user_id,status,assigned_at,ended_at FROM seat_assignments WHERE committee_id=$1 ORDER BY assigned_at,id`},
  {name: 'seat_invitations', query: `SELECT id,seat_id,max_uses,use_count,expires_at,revoked_at,created_at FROM seat_invitations WHERE committee_id=$1 ORDER BY created_at,id`},
  {name: 'rule_bindings', query: `SELECT b.id,b.package_version_id,b.effective_from_event_sequence,b.activated_at,v.version,v.schema_version,v.definition FROM committee_rule_bindings b JOIN rule_package_versions v ON v.id=b.package_version_id WHERE b.committee_id=$1 ORDER BY b.effective_from_event_sequence,b.id`},
  {name: 'rule_overrides', query: `SELECT id,scope,stable_rule_id,value,operation_key,source_package_version_id,created_package_version_id,created_at FROM chair_rule_overrides WHERE committee_id=$1 ORDER BY created_at,id`},
  {name: 'notes', query: `SELECT id,title,content,sort_order,revision,created_at,updated_at,deleted_at FROM committee_notes WHERE committee_id=$1 ORDER BY sort_order,id`},
  {name: 'text_posts', query: `SELECT id,title,content,sort_order,revision,author_seat_id,author_display_name,created_at,updated_at,deleted_at FROM committee_text_posts WHERE committee_id=$1 ORDER BY created_at,id`},
  {name: 'meeting_sessions', query: `SELECT id,phase_id,active_rule_package_version_id,status,revision,created_at,closed_at FROM meeting_sessions WHERE committee_id=$1 ORDER BY created_at,id`},
  {name: 'roll_calls', query: `SELECT id,meeting_session_id,status,current_seat_id,rule_package_version_id,allowed_responses,revision,started_at,completed_at FROM roll_calls WHERE committee_id=$1 ORDER BY started_at,id`},
  {name: 'roll_call_seats', query: `SELECT s.roll_call_id,s.seat_id,s.seat_display_name,s.sort_order FROM roll_call_seats s JOIN roll_calls r ON r.id=s.roll_call_id WHERE r.committee_id=$1 ORDER BY s.roll_call_id,s.sort_order`},
  {name: 'roll_call_entries', query: `SELECT id,roll_call_id,seat_id,seat_display_name,response,on_behalf_of_seat_id,rule_package_version_id,revision,recorded_at,undone_at FROM roll_call_entries WHERE committee_id=$1 ORDER BY recorded_at,id`},
  {name: 'attendance_events', query: `SELECT id,meeting_session_id,seat_id,seat_display_name,type,on_behalf_of_seat_id,source_roll_call_entry_id,source_point_id,created_at FROM attendance_events WHERE committee_id=$1 ORDER BY created_at,id`},
  {name: 'points', query: `SELECT id,meeting_session_id,point_type_id,content,raised_by_seat_id,raised_by_seat_display_name,on_behalf_of_seat_id,interrupt_requested,status,chair_response,rule_package_version_id,revision,created_at,resolved_at FROM points WHERE committee_id=$1 ORDER BY created_at,id`},
  {name: 'timers', query: `SELECT id,owner_type,owner_id,running,started_at,remaining_at_start_ms,revision,expired_at,created_at,updated_at FROM timer_states WHERE committee_id=$1 ORDER BY created_at,id`},
  {name: 'speaker_lists', query: `SELECT id,meeting_session_id,kind,status,topic,default_speech_ms,rule_package_version_id,current_entry_id,speech_timer_id,total_timer_id,revision,created_at,closed_at FROM speaker_lists WHERE committee_id=$1 ORDER BY created_at,id`},
  {name: 'speaker_queue_entries', query: `SELECT id,speaker_list_id,seat_id,seat_display_name,position,status,on_behalf_of_seat_id,created_at,completed_at FROM speaker_queue_entries WHERE committee_id=$1 ORDER BY speaker_list_id,position,id`},
  {name: 'caucuses', query: `SELECT id,meeting_session_id,speaker_list_id,topic,status,total_timer_id,speech_timer_id,revision,created_at,closed_at FROM caucuses WHERE committee_id=$1 ORDER BY created_at,id`},
  {name: 'speeches', query: `SELECT id,speaker_list_id,queue_entry_id,seat_id,seat_display_name,kind,status,inherited_from_speech_id,inherited_time_ms,can_yield,yield_type,yield_target_seat_id,on_behalf_of_seat_id,revision,started_at,ended_at,created_at FROM speeches WHERE committee_id=$1 ORDER BY created_at,id`},
  {name: 'speech_actions', query: `SELECT id,speech_id,action,remaining_ms,target_type,target_seat_id,on_behalf_of_seat_id,details,created_at FROM speech_actions WHERE committee_id=$1 ORDER BY created_at,id`},
  {name: 'speech_contributions', query: `SELECT id,speech_id,type,seat_id,seat_display_name,content,on_behalf_of_seat_id,created_at FROM speech_contributions WHERE committee_id=$1 ORDER BY created_at,id`},
  {name: 'motions', query: `SELECT id,meeting_session_id,motion_type_id,proposed_by_seat_id,proposed_by_seat_display_name,on_behalf_of_seat_id,parameters,status,rule_package_version_id,rule_evaluation,required_second_count,decided_at,revision,created_at FROM motions WHERE committee_id=$1 ORDER BY created_at,id`},
  {name: 'motion_seconds', query: `SELECT id,motion_id,seat_id,seat_display_name,on_behalf_of_seat_id,created_at FROM motion_seconds WHERE committee_id=$1 ORDER BY created_at,id`},
  {name: 'ballots', query: `SELECT id,meeting_session_id,subject_type,subject_id,status,procedural,choices,rule_package_version_id,rule_evaluation,eligibility_snapshot,threshold_definition,threshold_value,result,opened_at,closed_at,published_at,revision FROM ballots WHERE committee_id=$1 ORDER BY opened_at,id`},
  {name: 'ballot_votes', query: `SELECT v.id,v.ballot_id,v.seat_id,v.seat_display_name,v.current_choice,v.cast_on_behalf,v.cast_at,v.revision FROM ballot_votes v JOIN ballots b ON b.id=v.ballot_id WHERE b.committee_id=$1 ORDER BY v.ballot_id,v.seat_id`},
  {name: 'ballot_vote_revisions', query: `SELECT r.id,r.ballot_id,r.vote_id,r.seat_id,r.previous_choice,r.new_choice,r.on_behalf_of_seat_id,r.reason,r.created_at FROM ballot_vote_revisions r JOIN ballots b ON b.id=r.ballot_id WHERE b.committee_id=$1 ORDER BY r.created_at,r.id`},
  {name: 'strawpolls', query: `SELECT id,meeting_session_id,question,voting_mode,multiple_choice,status,revision,created_at,closed_at FROM strawpolls WHERE committee_id=$1 ORDER BY created_at,id`},
  {name: 'strawpoll_options', query: `SELECT o.id,o.strawpoll_id,o.label,o.sort_order FROM strawpoll_options o JOIN strawpolls s ON s.id=o.strawpoll_id WHERE s.committee_id=$1 ORDER BY o.strawpoll_id,o.sort_order`},
  {name: 'strawpoll_seat_votes', query: `SELECT v.id,v.strawpoll_id,v.seat_id,v.option_ids,v.on_behalf_of_seat_id,v.created_at FROM strawpoll_seat_votes v JOIN strawpolls s ON s.id=v.strawpoll_id WHERE s.committee_id=$1 ORDER BY v.created_at,v.id`},
  {name: 'strawpoll_anonymous_votes', query: `SELECT v.id,v.strawpoll_id,v.option_ids FROM strawpoll_anonymous_votes v JOIN strawpolls s ON s.id=v.strawpoll_id WHERE s.committee_id=$1 ORDER BY v.strawpoll_id,v.id`},
  {name: 'documents', query: `SELECT id,meeting_session_id,kind,title,status,rule_package_version_id,current_version_id,voting_version_id,is_public,created_on_behalf_of_seat_id,revision,created_at,updated_at FROM documents WHERE committee_id=$1 ORDER BY created_at,id`},
  {name: 'document_versions', query: `SELECT v.id,v.document_id,v.version_number,v.content,v.created_on_behalf_of_seat_id,v.created_at FROM document_versions v JOIN documents d ON d.id=v.document_id WHERE d.committee_id=$1 ORDER BY v.document_id,v.version_number`},
  {name: 'resolutions', query: `SELECT r.document_id,r.proposer_seat_id FROM resolutions r JOIN documents d ON d.id=r.document_id WHERE d.committee_id=$1 ORDER BY r.document_id`},
  {name: 'amendments', query: `SELECT a.document_id,a.resolution_document_id,a.proposer_seat_id FROM amendments a JOIN documents d ON d.id=a.document_id WHERE d.committee_id=$1 ORDER BY a.document_id`},
  {name: 'discussion_entries', query: `SELECT id,document_id,seat_id,seat_display_name,content,rule_stable_id,on_behalf_of_seat_id,created_at FROM discussion_entries WHERE committee_id=$1 ORDER BY created_at,id`},
  {name: 'document_actions', query: `SELECT id,document_id,action,from_status,to_status,rule_stable_id,rule_evaluation,created_at FROM document_actions WHERE committee_id=$1 ORDER BY created_at,id`},
  {name: 'file_entries', query: `SELECT id,logical_name,media_type,status,current_version_id,revision,created_at,updated_at,deleted_at FROM file_entries WHERE committee_id=$1 ORDER BY created_at,id`},
  {name: 'file_versions', query: `SELECT id,file_entry_id,version_number,original_name,media_type,size_bytes,encode(sha256,'hex') AS sha256,created_at FROM file_versions WHERE committee_id=$1 ORDER BY file_entry_id,version_number`},
  {name: 'file_tombstones', query: `SELECT id,file_entry_id,last_content_revision,deleted_at FROM file_tombstones WHERE committee_id=$1 ORDER BY deleted_at,id`},
  {name: 'committee_events', query: `SELECT sequence,event_type,resource_type,resource_id,resource_revision,payload,audience,created_at FROM committee_events WHERE committee_id=$1 ORDER BY sequence`},
  {name: 'audit_log', query: `SELECT id,request_id,actor_user_id,effective_capabilities,on_behalf_of_seat_id,action,resource_type,resource_id,result,reason,before_summary,after_summary,created_at FROM audit_log WHERE committee_id=$1 ORDER BY created_at,id`}
]);

function line(value: unknown): string { return `${JSON.stringify(value)}\n`; }

export class Stage8ArchiveService {
  constructor(private readonly pool: Pool, private readonly now: () => Date = () => new Date()) {}

  async exportCommittee(auth: AuthenticatedSession, committeeId: string): Promise<{
    fileName: string; content: Readable;
  }> {
    if (auth.user.mustChangePassword) throw new AppError({code: 'FORBIDDEN', message: 'Change the temporary password first.'});
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const found = await client.query<ArchiveCommitteeRow>(`SELECT id,owner_user_id,name,chair_label,topic,conference,
        visibility,operation_mode,status,revision,created_at,archived_at FROM committees WHERE id=$1`, [committeeId]);
      const committee = found.rows[0];
      if (!committee || committee.owner_user_id !== auth.user.id) throw new AppError({code: 'NOT_FOUND', message: 'Committee not found.'});
      if (committee.status !== 'ARCHIVED') throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Archive the committee before exporting it.'});
      return {fileName: `quorum-committee-${committee.id}.jsonl`, content: this.stream(client, committee)};
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined); client.release(); throw error;
    }
  }

  private stream(client: PoolClient, committee: ArchiveCommitteeRow): Readable {
    const generatedAt = this.now().toISOString();
    const iterator = async function* () {
      let recordCount = 0;
      try {
        yield line({type: 'manifest', format: 'quorum-committee-archive', schemaVersion: 1, generatedAt,
          committee: {id: committee.id, name: committee.name, chairLabel: committee.chair_label, topic: committee.topic,
            conference: committee.conference, visibility: committee.visibility, operationMode: committee.operation_mode,
            status: committee.status, revision: committee.revision, createdAt: committee.created_at,
            archivedAt: committee.archived_at}});
        for (const section of ARCHIVE_SECTIONS) {
          let offset = 0;
          while (true) {
            const page = await client.query(`${section.query} LIMIT $2 OFFSET $3`, [committee.id, PAGE_SIZE, offset]);
            for (const record of page.rows) { yield line({type: 'record', section: section.name, record}); recordCount += 1; }
            if (page.rows.length < PAGE_SIZE) break;
            offset += page.rows.length;
          }
        }
        yield line({type: 'complete', recordCount});
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined); throw error;
      } finally { client.release(); }
    };
    return Readable.from(iterator());
  }
}
