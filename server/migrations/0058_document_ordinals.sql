DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM documents) THEN
    RAISE EXCEPTION 'COMMITTEE_CONTENT_REBUILD_REQUIRED: remove old documents before schema 58';
  END IF;
END $$;
ALTER TABLE committees ADD COLUMN next_amendment_ordinal integer NOT NULL DEFAULT 1 CHECK (next_amendment_ordinal > 0);
ALTER TABLE meeting_sessions ADD COLUMN next_resolution_ordinal integer NOT NULL DEFAULT 1 CHECK (next_resolution_ordinal > 0);
ALTER TABLE documents DROP COLUMN title,
  ADD COLUMN custom_title text CHECK (custom_title IS NULL OR length(btrim(custom_title)) BETWEEN 1 AND 500),
  ADD COLUMN ordinal integer NOT NULL CHECK (ordinal > 0);
CREATE UNIQUE INDEX documents_resolution_ordinal ON documents(meeting_session_id,ordinal) WHERE kind='RESOLUTION';
CREATE UNIQUE INDEX documents_amendment_ordinal ON documents(committee_id,ordinal) WHERE kind='AMENDMENT';
CREATE FUNCTION allocate_document_ordinal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.ordinal IS NOT NULL THEN
      RAISE EXCEPTION 'document ordinal is allocated by the database' USING ERRCODE='23514';
    END IF;
    -- Keep committee-before-session lock order for both kinds.
    PERFORM 1 FROM committees WHERE id=NEW.committee_id FOR UPDATE;
    IF NEW.kind='RESOLUTION' THEN
      UPDATE meeting_sessions SET next_resolution_ordinal=next_resolution_ordinal+1
        WHERE id=NEW.meeting_session_id AND committee_id=NEW.committee_id
        RETURNING next_resolution_ordinal-1 INTO NEW.ordinal;
    ELSE
      UPDATE committees SET next_amendment_ordinal=next_amendment_ordinal+1 WHERE id=NEW.committee_id
        RETURNING next_amendment_ordinal-1 INTO NEW.ordinal;
    END IF;
  ELSIF (NEW.committee_id,NEW.meeting_session_id,NEW.kind,NEW.ordinal)
    IS DISTINCT FROM (OLD.committee_id,OLD.meeting_session_id,OLD.kind,OLD.ordinal) THEN
    RAISE EXCEPTION 'document identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER documents_ordinal_guard BEFORE INSERT OR UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION allocate_document_ordinal();
CREATE FUNCTION guard_document_counter() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='committees' THEN
    IF NEW.next_amendment_ordinal < OLD.next_amendment_ordinal THEN
      RAISE EXCEPTION 'amendment ordinals cannot be reused' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.next_resolution_ordinal < OLD.next_resolution_ordinal THEN
    RAISE EXCEPTION 'resolution ordinals cannot be reused' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER committees_document_counter_guard BEFORE UPDATE ON committees FOR EACH ROW EXECUTE FUNCTION guard_document_counter();
CREATE TRIGGER sessions_document_counter_guard BEFORE UPDATE ON meeting_sessions FOR EACH ROW EXECUTE FUNCTION guard_document_counter();
UPDATE quorum_meta.runtime_metadata SET schema_compatibility=58,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=58 WHERE singleton=true;
