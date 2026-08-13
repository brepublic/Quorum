CREATE TYPE speech_kind AS ENUM ('ORIGINAL', 'INHERITED');
CREATE TYPE speech_status AS ENUM ('READY', 'RUNNING', 'PAUSED', 'COMPLETED');
CREATE TYPE yield_type AS ENUM ('CHAIR', 'SEAT', 'QUESTIONS', 'COMMENTS');
CREATE TYPE speech_action_type AS ENUM ('STARTED', 'PAUSED', 'RESUMED', 'COMPLETED', 'YIELDED',
  'QUESTION_RECORDED', 'COMMENT_RECORDED');
CREATE TYPE speech_contribution_type AS ENUM ('QUESTION', 'COMMENT');

CREATE TABLE speeches (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  speaker_list_id uuid NOT NULL REFERENCES speaker_lists(id),
  queue_entry_id uuid NOT NULL REFERENCES speaker_queue_entries(id),
  seat_id uuid NOT NULL REFERENCES committee_seats(id),
  seat_display_name text NOT NULL CHECK (length(seat_display_name) BETWEEN 1 AND 200),
  kind speech_kind NOT NULL,
  status speech_status NOT NULL DEFAULT 'READY',
  inherited_from_speech_id uuid REFERENCES speeches(id),
  inherited_time_ms bigint CHECK (inherited_time_ms > 0),
  can_yield boolean NOT NULL,
  yield_type yield_type,
  yield_target_seat_id uuid REFERENCES committee_seats(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  on_behalf_of_seat_id uuid NOT NULL REFERENCES committee_seats(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'ORIGINAL' AND inherited_from_speech_id IS NULL AND inherited_time_ms IS NULL AND can_yield)
    OR (kind = 'INHERITED' AND inherited_from_speech_id IS NOT NULL AND inherited_time_ms IS NOT NULL AND NOT can_yield)),
  CHECK ((yield_type = 'SEAT' AND yield_target_seat_id IS NOT NULL)
    OR (yield_type IS DISTINCT FROM 'SEAT' AND yield_target_seat_id IS NULL))
);

CREATE UNIQUE INDEX speeches_one_active_per_list
  ON speeches (speaker_list_id) WHERE status IN ('READY', 'RUNNING', 'PAUSED');

CREATE TABLE speech_actions (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  speech_id uuid NOT NULL REFERENCES speeches(id),
  action speech_action_type NOT NULL,
  remaining_ms bigint NOT NULL CHECK (remaining_ms >= 0),
  target_type yield_type,
  target_seat_id uuid REFERENCES committee_seats(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  on_behalf_of_seat_id uuid NOT NULL REFERENCES committee_seats(id),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((target_type = 'SEAT' AND target_seat_id IS NOT NULL)
    OR (target_type IS DISTINCT FROM 'SEAT' AND target_seat_id IS NULL))
);

CREATE TABLE speech_contributions (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  speech_id uuid NOT NULL REFERENCES speeches(id),
  type speech_contribution_type NOT NULL,
  seat_id uuid NOT NULL REFERENCES committee_seats(id),
  seat_display_name text NOT NULL CHECK (length(seat_display_name) BETWEEN 1 AND 200),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  on_behalf_of_seat_id uuid NOT NULL REFERENCES committee_seats(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION prevent_speech_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'speech history is append-only';
END;
$$;

CREATE TRIGGER speech_actions_append_only
BEFORE UPDATE OR DELETE ON speech_actions
FOR EACH ROW EXECUTE FUNCTION prevent_speech_history_mutation();

CREATE TRIGGER speech_contributions_append_only
BEFORE UPDATE OR DELETE ON speech_contributions
FOR EACH ROW EXECUTE FUNCTION prevent_speech_history_mutation();

UPDATE quorum_meta.runtime_metadata
SET schema_compatibility = 8,
    updated_at = now()
WHERE singleton = true;

UPDATE system_settings
SET schema_compatibility = 8
WHERE singleton = true;
