DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM strawpolls) THEN
    RAISE EXCEPTION 'COMMITTEE_CONTENT_REBUILD_REQUIRED: remove old strawpolls before schema 59';
  END IF;
END $$;
ALTER TABLE meeting_sessions ADD COLUMN next_strawpoll_ordinal integer NOT NULL DEFAULT 1 CHECK (next_strawpoll_ordinal > 0);
ALTER TABLE strawpolls DROP CONSTRAINT strawpolls_question_check,
  ADD CONSTRAINT strawpolls_question_check CHECK (length(question) <= 1000),
  ADD COLUMN ordinal integer NOT NULL CHECK (ordinal > 0),
  ADD CONSTRAINT strawpolls_session_ordinal_unique UNIQUE (meeting_session_id,ordinal);
CREATE FUNCTION allocate_strawpoll_ordinal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.ordinal IS NOT NULL THEN
      RAISE EXCEPTION 'strawpoll ordinal is allocated by the database' USING ERRCODE='23514';
    END IF;
    PERFORM 1 FROM committees WHERE id=NEW.committee_id FOR UPDATE;
    UPDATE meeting_sessions SET next_strawpoll_ordinal=next_strawpoll_ordinal+1
      WHERE id=NEW.meeting_session_id AND committee_id=NEW.committee_id
      RETURNING next_strawpoll_ordinal-1 INTO NEW.ordinal;
  ELSIF (NEW.committee_id,NEW.meeting_session_id,NEW.ordinal)
    IS DISTINCT FROM (OLD.committee_id,OLD.meeting_session_id,OLD.ordinal) THEN
    RAISE EXCEPTION 'strawpoll identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER strawpolls_ordinal_guard BEFORE INSERT OR UPDATE ON strawpolls FOR EACH ROW EXECUTE FUNCTION allocate_strawpoll_ordinal();
CREATE FUNCTION guard_strawpoll_counter() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.next_strawpoll_ordinal < OLD.next_strawpoll_ordinal THEN
    RAISE EXCEPTION 'strawpoll ordinals cannot be reused' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sessions_strawpoll_counter_guard BEFORE UPDATE ON meeting_sessions FOR EACH ROW EXECUTE FUNCTION guard_strawpoll_counter();
UPDATE quorum_meta.runtime_metadata SET schema_compatibility=59,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=59 WHERE singleton=true;
