CREATE TYPE strawpoll_stage AS ENUM ('PREPARING', 'VOTING', 'RESULTS');
CREATE TYPE strawpoll_medium AS ENUM ('LINK', 'MANUAL');

ALTER TABLE strawpolls
  ADD COLUMN series_id uuid,
  ADD COLUMN round_number integer NOT NULL DEFAULT 1 CHECK (round_number > 0),
  ADD COLUMN superseded_by_id uuid,
  ADD COLUMN stage strawpoll_stage,
  ADD COLUMN medium strawpoll_medium NOT NULL DEFAULT 'LINK',
  ADD COLUMN options_are_public boolean NOT NULL DEFAULT false;

UPDATE strawpolls SET series_id=id,stage=CASE WHEN status='CLOSED' THEN 'RESULTS'::strawpoll_stage
  ELSE 'VOTING'::strawpoll_stage END;

ALTER TABLE strawpolls
  ALTER COLUMN series_id SET NOT NULL,
  ALTER COLUMN stage SET NOT NULL,
  ALTER COLUMN stage SET DEFAULT 'PREPARING',
  ADD CONSTRAINT strawpolls_superseded_by_fk FOREIGN KEY (superseded_by_id) REFERENCES strawpolls(id),
  ADD CONSTRAINT strawpolls_series_round_unique UNIQUE (series_id,round_number),
  ADD CONSTRAINT strawpolls_supersession_not_self CHECK (superseded_by_id IS NULL OR superseded_by_id<>id),
  ADD CONSTRAINT strawpolls_stage_status_match CHECK (
    (stage IN ('PREPARING','VOTING') AND status='OPEN' AND closed_at IS NULL)
    OR (stage='RESULTS' AND status='CLOSED' AND closed_at IS NOT NULL));

ALTER TABLE strawpoll_options
  ADD COLUMN manual_tally integer NOT NULL DEFAULT 0 CHECK (manual_tally >= 0);

DROP TRIGGER strawpoll_seat_votes_append_only ON strawpoll_seat_votes;

ALTER TABLE strawpoll_seat_votes
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN retracted_at timestamptz,
  ADD COLUMN retracted_by_user_id uuid REFERENCES users(id),
  ADD CONSTRAINT strawpoll_seat_vote_retraction_pair CHECK (
    (retracted_at IS NULL AND retracted_by_user_id IS NULL)
    OR (retracted_at IS NOT NULL AND retracted_by_user_id IS NOT NULL));

CREATE TABLE strawpoll_seat_vote_revisions (
  id uuid PRIMARY KEY,
  strawpoll_id uuid NOT NULL REFERENCES strawpolls(id),
  vote_id uuid NOT NULL REFERENCES strawpoll_seat_votes(id),
  seat_id uuid NOT NULL REFERENCES committee_seats(id),
  previous_option_ids uuid[],
  new_option_ids uuid[],
  actor_user_id uuid NOT NULL REFERENCES users(id),
  on_behalf_of_seat_id uuid NOT NULL REFERENCES committee_seats(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (previous_option_ids IS NOT NULL OR new_option_ids IS NOT NULL)
);

INSERT INTO strawpoll_seat_vote_revisions
  (id,strawpoll_id,vote_id,seat_id,new_option_ids,actor_user_id,on_behalf_of_seat_id,created_at)
SELECT gen_random_uuid(),strawpoll_id,id,seat_id,option_ids,actor_user_id,on_behalf_of_seat_id,created_at
FROM strawpoll_seat_votes;

CREATE TABLE strawpoll_manual_tally_revisions (
  id uuid PRIMARY KEY,
  strawpoll_id uuid NOT NULL REFERENCES strawpolls(id),
  option_id uuid NOT NULL REFERENCES strawpoll_options(id),
  previous_tally integer NOT NULL CHECK (previous_tally >= 0),
  new_tally integer NOT NULL CHECK (new_tally >= 0),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (previous_tally<>new_tally)
);

CREATE TRIGGER strawpoll_seat_vote_revisions_append_only
BEFORE UPDATE OR DELETE ON strawpoll_seat_vote_revisions
FOR EACH ROW EXECUTE FUNCTION prevent_strawpoll_vote_mutation();

CREATE TRIGGER strawpoll_manual_tally_revisions_append_only
BEFORE UPDATE OR DELETE ON strawpoll_manual_tally_revisions
FOR EACH ROW EXECUTE FUNCTION prevent_strawpoll_vote_mutation();

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=33,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=33 WHERE singleton=true;
