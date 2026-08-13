CREATE TYPE proceeding_document_kind AS ENUM ('RESOLUTION', 'AMENDMENT');
CREATE TYPE proceeding_document_status AS ENUM
  ('DRAFT', 'PUBLISHED', 'POSTPONED', 'VOTING', 'PASSED', 'FAILED', 'INCORPORATED', 'REJECTED');

CREATE TABLE documents (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  meeting_session_id uuid NOT NULL,
  kind proceeding_document_kind NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  status proceeding_document_status NOT NULL DEFAULT 'DRAFT',
  rule_package_version_id uuid NOT NULL REFERENCES rule_package_versions(id),
  current_version_id uuid,
  voting_version_id uuid,
  is_public boolean NOT NULL DEFAULT false,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_on_behalf_of_seat_id uuid NOT NULL REFERENCES committee_seats(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (committee_id,meeting_session_id) REFERENCES meeting_sessions(committee_id,id),
  UNIQUE (committee_id,id)
);

CREATE TABLE document_versions (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES documents(id),
  version_number integer NOT NULL CHECK (version_number > 0),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 200000),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_on_behalf_of_seat_id uuid NOT NULL REFERENCES committee_seats(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id,id),
  UNIQUE (document_id,version_number)
);

ALTER TABLE documents ADD CONSTRAINT documents_current_version_fk
  FOREIGN KEY (id,current_version_id) REFERENCES document_versions(document_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE documents ADD CONSTRAINT documents_voting_version_fk
  FOREIGN KEY (id,voting_version_id) REFERENCES document_versions(document_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE documents ADD CONSTRAINT documents_versions_required
  CHECK (current_version_id IS NOT NULL AND (status<>'VOTING' OR voting_version_id IS NOT NULL));

CREATE TABLE resolutions (
  document_id uuid PRIMARY KEY REFERENCES documents(id),
  proposer_seat_id uuid NOT NULL REFERENCES committee_seats(id)
);

CREATE TABLE amendments (
  document_id uuid PRIMARY KEY REFERENCES documents(id),
  resolution_document_id uuid NOT NULL REFERENCES resolutions(document_id),
  proposer_seat_id uuid NOT NULL REFERENCES committee_seats(id)
);

CREATE TABLE discussion_entries (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  document_id uuid NOT NULL REFERENCES documents(id),
  seat_id uuid NOT NULL REFERENCES committee_seats(id),
  seat_display_name text NOT NULL,
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 10000),
  rule_stable_id text NOT NULL CHECK (length(rule_stable_id) BETWEEN 1 AND 128),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  on_behalf_of_seat_id uuid NOT NULL REFERENCES committee_seats(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id,id)
);

CREATE TABLE document_actions (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  document_id uuid NOT NULL REFERENCES documents(id),
  action text NOT NULL,
  from_status proceeding_document_status NOT NULL,
  to_status proceeding_document_status NOT NULL,
  rule_stable_id text NOT NULL CHECK (length(rule_stable_id) BETWEEN 1 AND 128),
  rule_evaluation jsonb NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION enforce_document_state_machine() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.voting_version_id IS NOT NULL AND NEW.voting_version_id IS DISTINCT FROM OLD.voting_version_id THEN
    RAISE EXCEPTION 'document voting version is immutable';
  END IF;
  IF OLD.status='VOTING' AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
    RAISE EXCEPTION 'document under vote cannot replace its current version';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status='DRAFT' AND NEW.status='PUBLISHED') OR
    (OLD.status='PUBLISHED' AND NEW.status IN ('POSTPONED','VOTING')) OR
    (OLD.status='POSTPONED' AND NEW.status='PUBLISHED') OR
    (OLD.status='VOTING' AND NEW.status IN ('PASSED','FAILED','INCORPORATED','REJECTED'))
  ) THEN RAISE EXCEPTION 'invalid document state transition'; END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER documents_explicit_state_machine BEFORE UPDATE ON documents
FOR EACH ROW EXECUTE FUNCTION enforce_document_state_machine();

CREATE FUNCTION prevent_document_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'document history is append-only'; END; $$;
CREATE TRIGGER document_versions_append_only BEFORE UPDATE OR DELETE ON document_versions
FOR EACH ROW EXECUTE FUNCTION prevent_document_history_mutation();
CREATE TRIGGER discussion_entries_append_only BEFORE UPDATE OR DELETE ON discussion_entries
FOR EACH ROW EXECUTE FUNCTION prevent_document_history_mutation();
CREATE TRIGGER document_actions_append_only BEFORE UPDATE OR DELETE ON document_actions
FOR EACH ROW EXECUTE FUNCTION prevent_document_history_mutation();

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=12,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=12 WHERE singleton=true;
