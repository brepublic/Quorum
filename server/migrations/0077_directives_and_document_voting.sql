ALTER TABLE documents ADD COLUMN draft_type text NOT NULL DEFAULT 'RESOLUTION'
  CHECK (draft_type IN ('RESOLUTION','DIRECTIVE') AND (kind='RESOLUTION' OR draft_type='RESOLUTION'));
ALTER TABLE meeting_sessions ADD COLUMN next_directive_ordinal integer NOT NULL DEFAULT 1 CHECK (next_directive_ordinal > 0);
DROP INDEX documents_resolution_ordinal;
CREATE UNIQUE INDEX documents_draft_ordinal ON documents(meeting_session_id,draft_type,ordinal) WHERE kind='RESOLUTION';
CREATE OR REPLACE FUNCTION allocate_document_ordinal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.ordinal IS NOT NULL THEN
      RAISE EXCEPTION 'document ordinal is allocated by the database' USING ERRCODE='23514';
    END IF;
    PERFORM 1 FROM committees WHERE id=NEW.committee_id FOR UPDATE;
    IF NEW.kind='RESOLUTION' AND NEW.draft_type='DIRECTIVE' THEN
      UPDATE meeting_sessions SET next_directive_ordinal=next_directive_ordinal+1
        WHERE id=NEW.meeting_session_id AND committee_id=NEW.committee_id
        RETURNING next_directive_ordinal-1 INTO NEW.ordinal;
    ELSIF NEW.kind='RESOLUTION' THEN
      UPDATE meeting_sessions SET next_resolution_ordinal=next_resolution_ordinal+1
        WHERE id=NEW.meeting_session_id AND committee_id=NEW.committee_id
        RETURNING next_resolution_ordinal-1 INTO NEW.ordinal;
    ELSE
      UPDATE committees SET next_amendment_ordinal=next_amendment_ordinal+1 WHERE id=NEW.committee_id
        RETURNING next_amendment_ordinal-1 INTO NEW.ordinal;
    END IF;
  ELSIF (NEW.committee_id,NEW.meeting_session_id,NEW.kind,NEW.draft_type,NEW.ordinal)
    IS DISTINCT FROM (OLD.committee_id,OLD.meeting_session_id,OLD.kind,OLD.draft_type,OLD.ordinal) THEN
    RAISE EXCEPTION 'document identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION guard_directive_counter() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.next_directive_ordinal < OLD.next_directive_ordinal THEN
    RAISE EXCEPTION 'directive ordinals cannot be reused' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sessions_directive_counter_guard BEFORE UPDATE ON meeting_sessions
  FOR EACH ROW EXECUTE FUNCTION guard_directive_counter();

CREATE TABLE document_voting (
  document_id uuid PRIMARY KEY REFERENCES documents(id),
  direct_vote_majority resolution_direct_vote_majority NOT NULL DEFAULT 'TWO_THIRDS',
  direct_vote_started_at timestamptz,
  direct_vote_revision integer NOT NULL DEFAULT 1 CHECK (direct_vote_revision > 0),
  direct_vote_cast_revision integer NOT NULL DEFAULT 0 CHECK (direct_vote_cast_revision >= 0),
  direct_vote_completed_at timestamptz
);
INSERT INTO document_voting SELECT document_id,direct_vote_majority,direct_vote_started_at,
  direct_vote_revision,direct_vote_cast_revision,direct_vote_completed_at FROM resolutions;
INSERT INTO document_voting(document_id,direct_vote_majority)
  SELECT document_id,'SIMPLE_MAJORITY' FROM amendments WHERE amendment_type='UNFRIENDLY';
ALTER TABLE resolutions DROP COLUMN direct_vote_majority, DROP COLUMN direct_vote_started_at,
  DROP COLUMN direct_vote_revision, DROP COLUMN direct_vote_cast_revision, DROP COLUMN direct_vote_completed_at;
ALTER TABLE resolution_direct_votes RENAME TO document_direct_votes;
ALTER TABLE document_direct_votes RENAME COLUMN resolution_document_id TO document_id;
ALTER TABLE document_direct_votes DROP CONSTRAINT resolution_direct_votes_resolution_document_id_fkey;
ALTER TABLE document_direct_votes ADD FOREIGN KEY (document_id) REFERENCES document_voting(document_id);
ALTER TABLE resolution_direct_vote_revisions RENAME TO document_direct_vote_revisions;
ALTER TABLE document_direct_vote_revisions RENAME COLUMN resolution_document_id TO document_id;
ALTER TABLE document_direct_vote_revisions DROP CONSTRAINT resolution_direct_vote_revisions_resolution_document_id_fkey;
ALTER TABLE document_direct_vote_revisions ADD FOREIGN KEY (document_id) REFERENCES document_voting(document_id);
CREATE OR REPLACE FUNCTION enforce_amendment_type_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subtype text;
BEGIN
  IF NEW.kind='AMENDMENT' AND NEW.status IS DISTINCT FROM OLD.status THEN
    SELECT amendment_type INTO subtype FROM amendments WHERE document_id=NEW.id;
    IF subtype='FRIENDLY' AND NOT (OLD.status='DRAFT' AND NEW.status='INCORPORATED') THEN
      RAISE EXCEPTION 'friendly amendments are adopted without voting';
    END IF;
    IF subtype='UNFRIENDLY' AND NEW.status IN ('INCORPORATED','REJECTED') AND OLD.status<>'VOTING'
      AND NOT (OLD.status IN ('INCORPORATED','REJECTED') AND EXISTS (
        SELECT 1 FROM document_voting WHERE document_id=NEW.id AND direct_vote_completed_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'unfriendly amendments require a ballot result';
    END IF;
  END IF;
  RETURN NEW;
END $$;
UPDATE quorum_meta.runtime_metadata SET schema_compatibility=77,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=77 WHERE singleton=true;
