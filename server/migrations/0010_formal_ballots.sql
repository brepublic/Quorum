CREATE TYPE ballot_status AS ENUM ('OPEN', 'CLOSED', 'PUBLISHED');
CREATE TYPE ballot_subject_type AS ENUM ('MOTION', 'RESOLUTION', 'AMENDMENT');
CREATE TYPE ballot_choice AS ENUM ('FOR', 'AGAINST', 'ABSTAIN');

CREATE TABLE ballots (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  meeting_session_id uuid NOT NULL,
  subject_type ballot_subject_type NOT NULL,
  subject_id uuid NOT NULL,
  status ballot_status NOT NULL DEFAULT 'OPEN',
  procedural boolean NOT NULL,
  choices ballot_choice[] NOT NULL,
  rule_package_version_id uuid NOT NULL REFERENCES rule_package_versions(id),
  rule_evaluation jsonb NOT NULL CHECK (jsonb_typeof(rule_evaluation) = 'object'),
  eligibility_snapshot jsonb NOT NULL CHECK (jsonb_typeof(eligibility_snapshot) = 'array'),
  threshold_definition jsonb NOT NULL CHECK (jsonb_typeof(threshold_definition) = 'object'),
  threshold_value integer NOT NULL CHECK (threshold_value > 0),
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  opened_by_user_id uuid NOT NULL REFERENCES users(id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  published_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  FOREIGN KEY (committee_id, meeting_session_id) REFERENCES meeting_sessions(committee_id, id),
  CHECK (cardinality(choices) >= 2),
  CHECK ((procedural AND NOT ('ABSTAIN' = ANY(choices))) OR NOT procedural),
  CHECK ((status = 'OPEN' AND closed_at IS NULL AND published_at IS NULL AND result IS NULL)
    OR (status = 'CLOSED' AND closed_at IS NOT NULL AND published_at IS NULL AND result IS NULL)
    OR (status = 'PUBLISHED' AND closed_at IS NOT NULL AND published_at IS NOT NULL AND result IS NOT NULL)),
  UNIQUE (committee_id, id)
);

CREATE TABLE ballot_votes (
  id uuid PRIMARY KEY,
  ballot_id uuid NOT NULL REFERENCES ballots(id),
  seat_id uuid NOT NULL REFERENCES committee_seats(id),
  seat_display_name text NOT NULL CHECK (length(seat_display_name) BETWEEN 1 AND 200),
  current_choice ballot_choice NOT NULL,
  cast_by_user_id uuid NOT NULL REFERENCES users(id),
  cast_on_behalf boolean NOT NULL,
  cast_at timestamptz NOT NULL DEFAULT now(),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  UNIQUE (ballot_id, seat_id)
);

CREATE TABLE ballot_vote_revisions (
  id uuid PRIMARY KEY,
  ballot_id uuid NOT NULL REFERENCES ballots(id),
  vote_id uuid NOT NULL REFERENCES ballot_votes(id),
  seat_id uuid NOT NULL REFERENCES committee_seats(id),
  previous_choice ballot_choice,
  new_choice ballot_choice NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  on_behalf_of_seat_id uuid NOT NULL REFERENCES committee_seats(id),
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION prevent_ballot_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ballot vote history is append-only';
END;
$$;

CREATE TRIGGER ballot_vote_revisions_append_only
BEFORE UPDATE OR DELETE ON ballot_vote_revisions
FOR EACH ROW EXECUTE FUNCTION prevent_ballot_history_mutation();

CREATE FUNCTION protect_ballot_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.subject_type <> OLD.subject_type OR NEW.subject_id <> OLD.subject_id OR NEW.procedural <> OLD.procedural
    OR NEW.choices <> OLD.choices OR NEW.rule_package_version_id <> OLD.rule_package_version_id
    OR NEW.rule_evaluation <> OLD.rule_evaluation OR NEW.eligibility_snapshot <> OLD.eligibility_snapshot
    OR NEW.threshold_definition <> OLD.threshold_definition OR NEW.threshold_value <> OLD.threshold_value THEN
    RAISE EXCEPTION 'ballot snapshot is immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status='OPEN' AND NEW.status='CLOSED')
    OR (OLD.status='CLOSED' AND NEW.status='PUBLISHED')) THEN
    RAISE EXCEPTION 'invalid ballot state transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ballots_frozen_state_machine
BEFORE UPDATE ON ballots
FOR EACH ROW EXECUTE FUNCTION protect_ballot_snapshot();

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=10,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=10 WHERE singleton=true;
