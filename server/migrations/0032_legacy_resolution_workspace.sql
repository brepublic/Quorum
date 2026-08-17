CREATE TYPE resolution_direct_vote_majority AS ENUM
  ('SIMPLE_MAJORITY', 'TWO_THIRDS', 'TWO_THIRDS_NON_ABSTAINING');

ALTER TABLE resolutions
  ADD COLUMN seconder_seat_id uuid REFERENCES committee_seats(id),
  ADD COLUMN delegates_can_amend boolean NOT NULL DEFAULT false,
  ADD COLUMN direct_vote_majority resolution_direct_vote_majority NOT NULL DEFAULT 'SIMPLE_MAJORITY',
  ADD COLUMN direct_vote_started_at timestamptz,
  ADD COLUMN direct_vote_revision integer NOT NULL DEFAULT 1 CHECK (direct_vote_revision > 0);

CREATE TABLE resolution_direct_votes (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  resolution_document_id uuid NOT NULL REFERENCES resolutions(document_id),
  seat_id uuid NOT NULL REFERENCES committee_seats(id),
  seat_display_name text NOT NULL CHECK (length(seat_display_name) BETWEEN 1 AND 200),
  current_choice ballot_choice NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  on_behalf_of_seat_id uuid NOT NULL REFERENCES committee_seats(id),
  cast_at timestamptz NOT NULL DEFAULT now(),
  retracted_at timestamptz,
  retracted_by_user_id uuid REFERENCES users(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  UNIQUE (resolution_document_id, seat_id),
  CHECK ((retracted_at IS NULL AND retracted_by_user_id IS NULL)
    OR (retracted_at IS NOT NULL AND retracted_by_user_id IS NOT NULL))
);

CREATE TABLE resolution_direct_vote_revisions (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  resolution_document_id uuid NOT NULL REFERENCES resolutions(document_id),
  vote_id uuid NOT NULL REFERENCES resolution_direct_votes(id),
  seat_id uuid NOT NULL REFERENCES committee_seats(id),
  previous_choice ballot_choice,
  new_choice ballot_choice,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  on_behalf_of_seat_id uuid NOT NULL REFERENCES committee_seats(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (previous_choice IS NOT NULL OR new_choice IS NOT NULL)
);

CREATE TABLE resolution_setting_revisions (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  resolution_document_id uuid NOT NULL REFERENCES resolutions(document_id),
  before_value jsonb NOT NULL,
  after_value jsonb NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (before_value <> after_value)
);

CREATE TABLE document_result_decisions (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  document_id uuid NOT NULL REFERENCES documents(id),
  previous_status proceeding_document_status NOT NULL,
  new_status proceeding_document_status NOT NULL,
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 2000),
  corrects_decision_id uuid REFERENCES document_result_decisions(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (previous_status <> new_status)
);

CREATE FUNCTION prevent_legacy_document_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'legacy document history is append-only';
END;
$$;

CREATE TRIGGER resolution_direct_vote_revisions_append_only
BEFORE UPDATE OR DELETE ON resolution_direct_vote_revisions
FOR EACH ROW EXECUTE FUNCTION prevent_legacy_document_history_mutation();

CREATE TRIGGER resolution_setting_revisions_append_only
BEFORE UPDATE OR DELETE ON resolution_setting_revisions
FOR EACH ROW EXECUTE FUNCTION prevent_legacy_document_history_mutation();

CREATE TRIGGER document_result_decisions_append_only
BEFORE UPDATE OR DELETE ON document_result_decisions
FOR EACH ROW EXECUTE FUNCTION prevent_legacy_document_history_mutation();

DROP TRIGGER documents_explicit_state_machine ON documents;
DROP FUNCTION enforce_document_state_machine();

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
    (OLD.status='VOTING' AND NEW.status IN ('PASSED','FAILED','INCORPORATED','REJECTED')) OR
    (OLD.status IN ('DRAFT','PUBLISHED','POSTPONED')
      AND NEW.status IN ('PASSED','FAILED','INCORPORATED','REJECTED')) OR
    (OLD.status IN ('PASSED','FAILED') AND NEW.status IN ('PASSED','FAILED')) OR
    (OLD.status IN ('INCORPORATED','REJECTED') AND NEW.status IN ('INCORPORATED','REJECTED'))
  ) THEN RAISE EXCEPTION 'invalid document state transition'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER documents_explicit_state_machine BEFORE UPDATE ON documents
FOR EACH ROW EXECUTE FUNCTION enforce_document_state_machine();

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=32,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=32 WHERE singleton=true;
