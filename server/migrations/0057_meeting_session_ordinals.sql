-- Do not infer historical identity from names or timestamps.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM meeting_sessions) THEN
    RAISE EXCEPTION 'COMMITTEE_CONTENT_REBUILD_REQUIRED: remove old meeting data before schema 57';
  END IF;
END $$;
ALTER TABLE committees ADD COLUMN next_session_ordinal integer NOT NULL DEFAULT 1 CHECK (next_session_ordinal > 0);
ALTER TABLE meeting_sessions DROP COLUMN name,
  ADD COLUMN ordinal integer NOT NULL CHECK (ordinal > 0),
  ADD CONSTRAINT meeting_sessions_committee_ordinal_unique UNIQUE (committee_id,ordinal);

CREATE FUNCTION allocate_meeting_session_ordinal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.ordinal IS NOT NULL THEN
      RAISE EXCEPTION 'meeting session ordinal is allocated by the database' USING ERRCODE='23514';
    END IF;
    UPDATE committees SET next_session_ordinal=next_session_ordinal+1 WHERE id=NEW.committee_id
      RETURNING next_session_ordinal-1 INTO NEW.ordinal;
  ELSIF (NEW.committee_id,NEW.ordinal) IS DISTINCT FROM (OLD.committee_id,OLD.ordinal) THEN
    RAISE EXCEPTION 'meeting session identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER meeting_sessions_ordinal_guard BEFORE INSERT OR UPDATE ON meeting_sessions
  FOR EACH ROW EXECUTE FUNCTION allocate_meeting_session_ordinal();

CREATE FUNCTION guard_meeting_session_counter() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.next_session_ordinal < OLD.next_session_ordinal THEN
    RAISE EXCEPTION 'meeting session ordinals cannot be reused' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER committees_session_counter_guard BEFORE UPDATE ON committees
  FOR EACH ROW EXECUTE FUNCTION guard_meeting_session_counter();
UPDATE quorum_meta.runtime_metadata SET schema_compatibility=57,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=57 WHERE singleton=true;
