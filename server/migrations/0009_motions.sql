CREATE TYPE motion_status AS ENUM ('PENDING', 'SECONDED', 'VOTING', 'PASSED', 'FAILED', 'WITHDRAWN', 'SUPERSEDED');

CREATE TABLE motions (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  meeting_session_id uuid NOT NULL,
  motion_type_id text NOT NULL CHECK (length(motion_type_id) BETWEEN 1 AND 128),
  proposed_by_seat_id uuid NOT NULL REFERENCES committee_seats(id),
  proposed_by_seat_display_name text NOT NULL CHECK (length(proposed_by_seat_display_name) BETWEEN 1 AND 200),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  on_behalf_of_seat_id uuid NOT NULL REFERENCES committee_seats(id),
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(parameters) = 'object'),
  status motion_status NOT NULL DEFAULT 'PENDING',
  rule_package_version_id uuid NOT NULL REFERENCES rule_package_versions(id),
  rule_evaluation jsonb NOT NULL CHECK (jsonb_typeof(rule_evaluation) = 'object'),
  required_second_count integer NOT NULL CHECK (required_second_count >= 0),
  decided_by_user_id uuid REFERENCES users(id),
  decided_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (committee_id, meeting_session_id) REFERENCES meeting_sessions(committee_id, id),
  CHECK ((status IN ('PASSED','FAILED') AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL)
    OR (status NOT IN ('PASSED','FAILED') AND decided_by_user_id IS NULL AND decided_at IS NULL)),
  UNIQUE (committee_id, id)
);

CREATE TABLE motion_seconds (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  motion_id uuid NOT NULL REFERENCES motions(id),
  seat_id uuid NOT NULL REFERENCES committee_seats(id),
  seat_display_name text NOT NULL CHECK (length(seat_display_name) BETWEEN 1 AND 200),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  on_behalf_of_seat_id uuid NOT NULL REFERENCES committee_seats(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (motion_id, seat_id)
);

CREATE FUNCTION enforce_motion_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.motion_type_id <> OLD.motion_type_id
    OR NEW.proposed_by_seat_id <> OLD.proposed_by_seat_id
    OR NEW.rule_package_version_id <> OLD.rule_package_version_id
    OR NEW.rule_evaluation <> OLD.rule_evaluation
    OR NEW.required_second_count <> OLD.required_second_count THEN
    RAISE EXCEPTION 'frozen motion fields are immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'PENDING' AND NEW.status IN ('SECONDED','VOTING','PASSED','FAILED','WITHDRAWN','SUPERSEDED'))
    OR (OLD.status = 'SECONDED' AND NEW.status IN ('VOTING','PASSED','FAILED','WITHDRAWN','SUPERSEDED'))
    OR (OLD.status = 'VOTING' AND NEW.status IN ('PASSED','FAILED'))
  ) THEN
    RAISE EXCEPTION 'invalid motion state transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER motions_explicit_state_machine
BEFORE UPDATE ON motions
FOR EACH ROW EXECUTE FUNCTION enforce_motion_transition();

UPDATE quorum_meta.runtime_metadata
SET schema_compatibility = 9,
    updated_at = now()
WHERE singleton = true;

UPDATE system_settings
SET schema_compatibility = 9
WHERE singleton = true;
