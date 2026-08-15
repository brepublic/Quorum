ALTER TABLE motions
  ADD COLUMN direct_vote_include_non_voting boolean NOT NULL DEFAULT true,
  ADD COLUMN direct_vote_started_at timestamptz,
  ADD COLUMN direct_vote_settings_revision integer NOT NULL DEFAULT 1 CHECK (direct_vote_settings_revision > 0);

CREATE TABLE motion_direct_votes (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  motion_id uuid NOT NULL REFERENCES motions(id),
  seat_id uuid NOT NULL REFERENCES committee_seats(id),
  seat_display_name text NOT NULL CHECK (length(seat_display_name) BETWEEN 1 AND 200),
  current_choice ballot_choice NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  on_behalf_of_seat_id uuid NOT NULL REFERENCES committee_seats(id),
  cast_at timestamptz NOT NULL DEFAULT now(),
  retracted_at timestamptz,
  retracted_by_user_id uuid REFERENCES users(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  UNIQUE (motion_id, seat_id),
  CHECK ((retracted_at IS NULL AND retracted_by_user_id IS NULL)
    OR (retracted_at IS NOT NULL AND retracted_by_user_id IS NOT NULL))
);

CREATE TABLE motion_direct_vote_revisions (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  motion_id uuid NOT NULL REFERENCES motions(id),
  vote_id uuid NOT NULL REFERENCES motion_direct_votes(id),
  seat_id uuid NOT NULL REFERENCES committee_seats(id),
  previous_choice ballot_choice,
  new_choice ballot_choice,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  on_behalf_of_seat_id uuid NOT NULL REFERENCES committee_seats(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (previous_choice IS NOT NULL OR new_choice IS NOT NULL)
);

CREATE TABLE motion_direct_vote_setting_revisions (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  motion_id uuid NOT NULL REFERENCES motions(id),
  previous_include_non_voting boolean NOT NULL,
  new_include_non_voting boolean NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (previous_include_non_voting <> new_include_non_voting)
);

CREATE FUNCTION prevent_motion_direct_vote_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'motion direct vote history is append-only';
END;
$$;

CREATE TRIGGER motion_direct_vote_revisions_append_only
BEFORE UPDATE OR DELETE ON motion_direct_vote_revisions
FOR EACH ROW EXECUTE FUNCTION prevent_motion_direct_vote_history_mutation();

CREATE TRIGGER motion_direct_vote_setting_revisions_append_only
BEFORE UPDATE OR DELETE ON motion_direct_vote_setting_revisions
FOR EACH ROW EXECUTE FUNCTION prevent_motion_direct_vote_history_mutation();

CREATE INDEX motion_direct_votes_motion_current
  ON motion_direct_votes (motion_id, seat_id) WHERE retracted_at IS NULL;

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=30,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=30 WHERE singleton=true;
