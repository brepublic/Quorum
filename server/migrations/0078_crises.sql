ALTER TYPE timer_owner_type ADD VALUE 'CRISIS';
ALTER TABLE committees ADD COLUMN crisis_auto_start_delay_minutes double precision NOT NULL DEFAULT 5
  CHECK (crisis_auto_start_delay_minutes > '-Infinity'::double precision AND crisis_auto_start_delay_minutes < 'Infinity'::double precision);
ALTER TABLE meeting_sessions ADD COLUMN next_crisis_ordinal integer NOT NULL DEFAULT 1 CHECK (next_crisis_ordinal > 0);
ALTER TABLE file_uploads ADD COLUMN chair_file_type text;
ALTER TABLE delegate_file_metadata ADD COLUMN crisis_name_edited boolean NOT NULL DEFAULT false;

CREATE TABLE crisis_groups (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  meeting_session_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  next_update_ordinal integer NOT NULL DEFAULT 1 CHECK (next_update_ordinal > 0),
  timer_id uuid NOT NULL REFERENCES timer_states(id),
  auto_start_at timestamptz,
  ended_at timestamptz,
  manually_ended boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meeting_session_id,ordinal),
  UNIQUE (committee_id,id),
  FOREIGN KEY (committee_id,meeting_session_id) REFERENCES meeting_sessions(committee_id,id),
  CHECK (ended_at IS NULL OR auto_start_at IS NULL)
);
CREATE TABLE crisis_updates (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  group_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  title text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'UNPUBLISHED' CHECK (status IN ('UNPUBLISHED','PENDING','SUPERSEDED','ENDED')),
  status_before_end text CHECK (status_before_end IN ('UNPUBLISHED','PENDING','SUPERSEDED')),
  handling_duration_ms bigint CHECK (handling_duration_ms > 0),
  notice_file_id uuid UNIQUE,
  notice_version_id uuid REFERENCES file_versions(id),
  notice_name text,
  published_at timestamptz,
  published_by_user_id uuid REFERENCES users(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id,ordinal),
  UNIQUE (group_id,id),
  FOREIGN KEY (committee_id,group_id) REFERENCES crisis_groups(committee_id,id),
  FOREIGN KEY (committee_id,notice_file_id) REFERENCES file_entries(committee_id,id)
);
CREATE UNIQUE INDEX crisis_one_unpublished ON crisis_updates(group_id) WHERE status='UNPUBLISHED';
CREATE UNIQUE INDEX crisis_one_pending ON crisis_updates(group_id) WHERE status='PENDING';
CREATE INDEX crisis_auto_start_due ON crisis_groups(auto_start_at) WHERE auto_start_at IS NOT NULL;

CREATE FUNCTION allocate_crisis_ordinal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.ordinal IS NOT NULL THEN RAISE EXCEPTION 'crisis ordinal is allocated by the database' USING ERRCODE='23514'; END IF;
    PERFORM 1 FROM committees WHERE id=NEW.committee_id FOR UPDATE;
    IF TG_TABLE_NAME='crisis_groups' THEN
      UPDATE meeting_sessions SET next_crisis_ordinal=next_crisis_ordinal+1 WHERE id=NEW.meeting_session_id
        AND committee_id=NEW.committee_id RETURNING next_crisis_ordinal-1 INTO NEW.ordinal;
    ELSE
      UPDATE crisis_groups SET next_update_ordinal=next_update_ordinal+1 WHERE id=NEW.group_id
        AND committee_id=NEW.committee_id RETURNING next_update_ordinal-1 INTO NEW.ordinal;
    END IF;
  ELSIF (NEW.committee_id,NEW.ordinal) IS DISTINCT FROM (OLD.committee_id,OLD.ordinal)
    OR (TG_TABLE_NAME='crisis_groups' AND to_jsonb(NEW)->'meeting_session_id' IS DISTINCT FROM to_jsonb(OLD)->'meeting_session_id')
    OR (TG_TABLE_NAME='crisis_updates' AND to_jsonb(NEW)->'group_id' IS DISTINCT FROM to_jsonb(OLD)->'group_id') THEN
    RAISE EXCEPTION 'crisis identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crisis_group_number BEFORE INSERT OR UPDATE ON crisis_groups FOR EACH ROW EXECUTE FUNCTION allocate_crisis_ordinal();
CREATE TRIGGER crisis_update_number BEFORE INSERT OR UPDATE ON crisis_updates FOR EACH ROW EXECUTE FUNCTION allocate_crisis_ordinal();

ALTER TABLE document_voting ADD COLUMN crisis_group_id uuid REFERENCES crisis_groups(id),
  ADD COLUMN crisis_update_id uuid,
  ADD COLUMN crisis_invalidated_at timestamptz,
  ADD COLUMN completed_outcome text CHECK (completed_outcome IN ('PASSED','FAILED','VETOED')),
  ADD FOREIGN KEY (crisis_group_id,crisis_update_id) REFERENCES crisis_updates(group_id,id),
  ADD CHECK ((crisis_group_id IS NULL) = (crisis_update_id IS NULL));

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=78,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=78 WHERE singleton=true;
