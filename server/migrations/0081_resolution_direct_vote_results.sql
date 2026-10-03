-- Repair ordinary resolutions whose completed direct vote never reached the document.
DO $$
DECLARE
  target record;
  event_sequence bigint;
  next_revision integer;
BEGIN
  FOR target IN
    SELECT d.id,d.committee_id,d.status,d.revision,last_vote.actor_user_id,
      CASE
        WHEN totals.vetoed THEN 'FAILED'
        WHEN v.direct_vote_majority='TWO_THIRDS_NON_ABSTAINING' AND totals.for_count=0
          AND totals.against_count=0 THEN NULL
        WHEN totals.for_count >= CASE v.direct_vote_majority
          WHEN 'SIMPLE_MAJORITY' THEN floor(totals.eligible_count / 2.0)+1
          WHEN 'TWO_THIRDS' THEN ceil(2 * totals.eligible_count / 3.0)
          ELSE ceil(2 * (totals.for_count+totals.against_count) / 3.0)
        END THEN 'PASSED'
        ELSE 'FAILED'
      END AS outcome
    FROM documents d JOIN document_voting v ON v.document_id=d.id
    CROSS JOIN LATERAL (
      SELECT count(*) AS eligible_count,count(vote.id) AS cast_count,
        count(*) FILTER (WHERE vote.current_choice='FOR') AS for_count,
        count(*) FILTER (WHERE vote.current_choice='AGAINST') AS against_count,
        bool_or(s.has_veto AND vote.current_choice='AGAINST') AS vetoed
      FROM committee_seats s JOIN current_attendance a
        ON a.seat_id=s.id AND a.meeting_session_id=d.meeting_session_id AND a.state='PRESENT'
      LEFT JOIN document_direct_votes vote
        ON vote.document_id=d.id AND vote.seat_id=s.id AND vote.retracted_at IS NULL
      WHERE s.committee_id=d.committee_id AND s.active AND s.can_vote
    ) totals
    CROSS JOIN LATERAL (
      SELECT actor_user_id FROM document_direct_vote_revisions
      WHERE document_id=d.id ORDER BY created_at DESC,id DESC LIMIT 1
    ) last_vote
    WHERE d.kind='RESOLUTION' AND d.draft_type='RESOLUTION' AND d.deleted_at IS NULL
      AND d.status IN ('DRAFT','PUBLISHED','VOTING') AND v.direct_vote_completed_at IS NOT NULL
      AND totals.eligible_count>0 AND totals.cast_count=totals.eligible_count
    ORDER BY d.committee_id,d.id
  LOOP
    IF target.outcome IS NULL THEN CONTINUE; END IF;
    INSERT INTO document_result_decisions
      (id,committee_id,document_id,previous_status,new_status,actor_user_id)
    VALUES (gen_random_uuid(),target.committee_id,target.id,target.status,
      target.outcome::proceeding_document_status,target.actor_user_id);

    UPDATE documents SET status=target.outcome::proceeding_document_status,is_public=true,
      revision=revision+1,updated_at=now() WHERE id=target.id RETURNING revision INTO next_revision;
    UPDATE committees SET next_event_sequence=next_event_sequence+1
      WHERE id=target.committee_id RETURNING next_event_sequence-1 INTO event_sequence;
    INSERT INTO committee_events
      (committee_id,sequence,event_type,resource_type,resource_id,resource_revision,payload,audience)
    VALUES (target.committee_id,event_sequence,'document.result_recorded','document',target.id,next_revision,
      jsonb_build_object('previousStatus',target.status,'outcome',target.outcome,'migrationBackfill',true),'PUBLIC');
    INSERT INTO audit_log
      (id,request_id,committee_id,actor_user_id,effective_capabilities,action,resource_type,
       resource_id,result,before_summary,after_summary)
    VALUES (gen_random_uuid(),'migration:0081',target.committee_id,NULL,'{}',
      'migration.resolution_direct_vote_result_backfilled','document',target.id,'SUCCEEDED',
      jsonb_build_object('status',target.status),jsonb_build_object('status',target.outcome,'revision',next_revision));
  END LOOP;
END
$$;

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=81,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=81 WHERE singleton=true;
