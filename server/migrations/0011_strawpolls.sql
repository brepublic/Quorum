CREATE TYPE strawpoll_voting_mode AS ENUM ('ANONYMOUS', 'SEAT_AUTHENTICATED');
CREATE TYPE strawpoll_status AS ENUM ('OPEN', 'CLOSED');

CREATE TABLE strawpolls (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  meeting_session_id uuid NOT NULL,
  question text NOT NULL CHECK (length(question) BETWEEN 1 AND 1000),
  voting_mode strawpoll_voting_mode NOT NULL,
  multiple_choice boolean NOT NULL DEFAULT false,
  status strawpoll_status NOT NULL DEFAULT 'OPEN',
  anonymous_access_token_hash bytea CHECK (anonymous_access_token_hash IS NULL OR octet_length(anonymous_access_token_hash)=32),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  FOREIGN KEY (committee_id, meeting_session_id) REFERENCES meeting_sessions(committee_id, id),
  CHECK ((voting_mode='ANONYMOUS' AND anonymous_access_token_hash IS NOT NULL)
    OR (voting_mode='SEAT_AUTHENTICATED' AND anonymous_access_token_hash IS NULL)),
  CHECK ((status='OPEN' AND closed_at IS NULL) OR (status='CLOSED' AND closed_at IS NOT NULL)),
  UNIQUE (committee_id,id)
);

CREATE TABLE strawpoll_options (
  id uuid PRIMARY KEY,
  strawpoll_id uuid NOT NULL REFERENCES strawpolls(id),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 500),
  sort_order integer NOT NULL,
  UNIQUE (strawpoll_id,id),
  UNIQUE (strawpoll_id,sort_order)
);

CREATE TABLE strawpoll_seat_votes (
  id uuid PRIMARY KEY,
  strawpoll_id uuid NOT NULL REFERENCES strawpolls(id),
  seat_id uuid NOT NULL REFERENCES committee_seats(id),
  option_ids uuid[] NOT NULL CHECK (cardinality(option_ids)>0),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  on_behalf_of_seat_id uuid NOT NULL REFERENCES committee_seats(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (strawpoll_id,seat_id)
);

-- Anonymous credentials and selections are deliberately stored in separate tables with no shared identifier or timestamp.
CREATE TABLE strawpoll_anonymous_receipts (
  strawpoll_id uuid NOT NULL REFERENCES strawpolls(id),
  credential_hash bytea NOT NULL CHECK (octet_length(credential_hash)=32),
  PRIMARY KEY (strawpoll_id,credential_hash)
);

CREATE TABLE strawpoll_anonymous_votes (
  id uuid PRIMARY KEY,
  strawpoll_id uuid NOT NULL REFERENCES strawpolls(id),
  option_ids uuid[] NOT NULL CHECK (cardinality(option_ids)>0)
);

CREATE FUNCTION prevent_strawpoll_vote_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'strawpoll votes are append-only'; END; $$;

CREATE TRIGGER strawpoll_seat_votes_append_only BEFORE UPDATE OR DELETE ON strawpoll_seat_votes
FOR EACH ROW EXECUTE FUNCTION prevent_strawpoll_vote_mutation();
CREATE TRIGGER strawpoll_anonymous_votes_append_only BEFORE UPDATE OR DELETE ON strawpoll_anonymous_votes
FOR EACH ROW EXECUTE FUNCTION prevent_strawpoll_vote_mutation();
CREATE TRIGGER strawpoll_anonymous_receipts_append_only BEFORE UPDATE OR DELETE ON strawpoll_anonymous_receipts
FOR EACH ROW EXECUTE FUNCTION prevent_strawpoll_vote_mutation();

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=11,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=11 WHERE singleton=true;
