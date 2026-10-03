-- The runner executes this whole migration in one transaction. Keep the immutable
-- voting-version guard in normal operation; bypass it only for proven orphan locks.
LOCK TABLE committees IN EXCLUSIVE MODE;
LOCK TABLE documents IN ACCESS EXCLUSIVE MODE;
ALTER TABLE documents DISABLE TRIGGER documents_explicit_state_machine;
DO $$
DECLARE
  target record;
  event_sequence bigint;
  next_revision integer;
  next_voting_version uuid;
BEGIN
  FOR target IN
    SELECT d.id,d.committee_id,d.status,d.revision,d.voting_version_id,
      CASE WHEN d.status='VOTING' THEN 'PUBLISHED' ELSE 'VOTING' END AS next_status
    FROM documents d JOIN document_voting v ON v.document_id=d.id
    WHERE d.kind='RESOLUTION' AND d.draft_type='RESOLUTION' AND d.deleted_at IS NULL AND (
      (d.status='VOTING' AND v.direct_vote_started_at IS NULL AND v.direct_vote_completed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM ballots b WHERE b.subject_id=d.id)
        AND NOT EXISTS (SELECT 1 FROM document_direct_votes vote WHERE vote.document_id=d.id)
        AND NOT EXISTS (SELECT 1 FROM document_direct_vote_revisions h WHERE h.document_id=d.id)
        AND NOT EXISTS (SELECT 1 FROM document_result_decisions r WHERE r.document_id=d.id))
      OR (d.status IN ('DRAFT','PUBLISHED') AND (v.direct_vote_started_at IS NOT NULL
        OR EXISTS (SELECT 1 FROM ballots b WHERE b.subject_id=d.id))))
    ORDER BY d.committee_id,d.id
  LOOP
    UPDATE documents SET status=target.next_status::proceeding_document_status,
      voting_version_id=CASE WHEN target.next_status='PUBLISHED' THEN NULL ELSE coalesce(voting_version_id,current_version_id) END,
      revision=revision+1,updated_at=now() WHERE id=target.id RETURNING revision,voting_version_id INTO next_revision,next_voting_version;
    UPDATE committees SET next_event_sequence=next_event_sequence+1
      WHERE id=target.committee_id RETURNING next_event_sequence-1 INTO event_sequence;
    INSERT INTO committee_events
      (committee_id,sequence,event_type,resource_type,resource_id,resource_revision,payload,audience)
    VALUES (target.committee_id,event_sequence,'document.status_changed','document',target.id,next_revision,
      jsonb_build_object('kind','RESOLUTION','status',target.next_status,'votingVersionId',next_voting_version,'migrationBackfill',true), 'PUBLIC');
    INSERT INTO audit_log
      (id,request_id,committee_id,actor_user_id,effective_capabilities,action,resource_type,
       resource_id,result,before_summary,after_summary)
    VALUES (gen_random_uuid(),'migration:0083',target.committee_id,NULL,'{}',
      'migration.resolution_vote_lifecycle_repaired','document',target.id,'SUCCEEDED',
      jsonb_build_object('status',target.status,'votingVersionId',target.voting_version_id,'revision',target.revision),
      jsonb_build_object('status',target.next_status,'revision',next_revision,'votingVersionId',next_voting_version));
  END LOOP;
END
$$;
-- Flush deferred version references before changing the trigger definition.
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE documents ENABLE TRIGGER documents_explicit_state_machine;

CREATE OR REPLACE FUNCTION enforce_document_state_machine() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.voting_version_id IS NOT NULL AND NEW.voting_version_id IS DISTINCT FROM OLD.voting_version_id THEN
    RAISE EXCEPTION 'document voting version is immutable';
  END IF;
  IF OLD.status='VOTING' AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
    RAISE EXCEPTION 'document under vote cannot replace its current version';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status='DRAFT' AND NEW.status='PUBLISHED') OR
    (OLD.status='DRAFT' AND NEW.status='VOTING' AND NEW.kind='RESOLUTION' AND NEW.draft_type='RESOLUTION') OR
    (OLD.status='PUBLISHED' AND NEW.status IN ('POSTPONED','VOTING')) OR
    (OLD.status='POSTPONED' AND NEW.status='PUBLISHED') OR
    (OLD.status='VOTING' AND NEW.status IN ('PASSED','FAILED','INCORPORATED','REJECTED')) OR
    (OLD.status IN ('DRAFT','PUBLISHED','POSTPONED')
      AND NEW.status IN ('PASSED','FAILED','INCORPORATED','REJECTED')) OR
    (OLD.status IN ('PASSED','FAILED') AND NEW.status IN ('PASSED','FAILED')) OR
    (OLD.status IN ('INCORPORATED','REJECTED') AND NEW.status IN ('INCORPORATED','REJECTED'))
  ) THEN RAISE EXCEPTION 'invalid document state transition'; END IF;
  RETURN NEW;
END;
$$;


UPDATE quorum_meta.runtime_metadata SET schema_compatibility=83,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=83 WHERE singleton=true;
