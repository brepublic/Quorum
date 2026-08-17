ALTER TABLE committees
  ADD COLUMN move_queue_up boolean NOT NULL DEFAULT false,
  ADD COLUMN timers_in_separate_columns boolean NOT NULL DEFAULT false;

DO $$
DECLARE
  meeting record;
  speaker_list_id uuid;
  speech_timer_id uuid;
  event_sequence bigint;
  default_speech_ms bigint;
BEGIN
  FOR meeting IN
    SELECT session.id,session.committee_id,session.active_rule_package_version_id,
      session.created_by_user_id,version.definition
    FROM meeting_sessions session
    JOIN rule_package_versions version ON version.id=session.active_rule_package_version_id
    WHERE session.status='OPEN'
      AND NOT EXISTS (
        SELECT 1 FROM speaker_lists list
        WHERE list.meeting_session_id=session.id AND list.kind='GENERAL'
      )
    ORDER BY session.created_at,session.id
  LOOP
    SELECT COALESCE((item->>'defaultDurationSeconds')::bigint * 1000,60000)
    INTO default_speech_ms
    FROM jsonb_array_elements(COALESCE(meeting.definition->'speakerLists','[]'::jsonb)) item
    WHERE item->>'id'='general-speakers-list'
    LIMIT 1;
    default_speech_ms := COALESCE(default_speech_ms,60000);

    speaker_list_id := gen_random_uuid();
    speech_timer_id := gen_random_uuid();

    INSERT INTO timer_states
      (id,committee_id,owner_type,owner_id,remaining_at_start_ms,created_by_user_id)
    VALUES
      (speech_timer_id,meeting.committee_id,'SPEAKER_LIST',speaker_list_id,default_speech_ms,
       meeting.created_by_user_id);

    INSERT INTO speaker_lists
      (id,committee_id,meeting_session_id,kind,name,topic,default_speech_ms,delegates_can_queue,
       rule_package_version_id,speech_timer_id,created_by_user_id)
    VALUES
      (speaker_list_id,meeting.committee_id,meeting.id,'GENERAL','General Speakers'' List','',
       default_speech_ms,true,meeting.active_rule_package_version_id,speech_timer_id,
       meeting.created_by_user_id);

    UPDATE committees
    SET next_event_sequence=next_event_sequence+1
    WHERE id=meeting.committee_id
    RETURNING next_event_sequence-1 INTO event_sequence;

    INSERT INTO committee_events
      (committee_id,sequence,event_type,resource_type,resource_id,resource_revision,payload,audience)
    VALUES
      (meeting.committee_id,event_sequence,'speaker_list.created','speaker_list',speaker_list_id,1,
       jsonb_build_object('kind','GENERAL','name','General Speakers'' List','topic','',
         'defaultSpeechMs',default_speech_ms,'totalDurationMs',NULL,'delegatesCanQueue',true,
         'rulePackageVersionId',meeting.active_rule_package_version_id,'migrationBackfill',true),
       'PUBLIC');

    INSERT INTO audit_log
      (id,request_id,committee_id,actor_user_id,effective_capabilities,action,resource_type,
       resource_id,result,after_summary)
    VALUES
      (gen_random_uuid(),'migration:0038',meeting.committee_id,NULL,'{}',
       'migration.main_speaker_list_backfilled','speaker_list',speaker_list_id,'SUCCEEDED',
       jsonb_build_object('meetingSessionId',meeting.id,'defaultSpeechMs',default_speech_ms,
         'revision',1));
  END LOOP;
END
$$;

CREATE UNIQUE INDEX speaker_lists_one_general_per_session
  ON speaker_lists (meeting_session_id) WHERE kind = 'GENERAL';

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=38,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=38 WHERE singleton=true;
