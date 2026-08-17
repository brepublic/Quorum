CREATE TYPE seat_rank AS ENUM ('STANDARD', 'VETO', 'NGO', 'OBSERVER');
CREATE TYPE flag_type AS ENUM ('STANDARD', 'EMOJI', 'IMAGE');
CREATE TYPE meeting_session_status AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE roll_call_status AS ENUM ('IN_PROGRESS', 'COMPLETED', 'ABANDONED');
CREATE TYPE attendance_event_type AS ENUM ('PRESENT', 'TEMPORARILY_LEFT', 'RETURNED', 'ABSENT');
CREATE TYPE attendance_state AS ENUM ('PRESENT', 'TEMPORARILY_LEFT', 'ABSENT');
CREATE TYPE point_status AS ENUM ('PENDING', 'UPHELD', 'OVERRULED', 'ANSWERED', 'RESOLVED', 'REJECTED');

CREATE TABLE country_templates (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  names jsonb NOT NULL CHECK (jsonb_typeof(names) = 'object' AND names <> '{}'::jsonb),
  default_language text NOT NULL CHECK (length(default_language) BETWEEN 2 AND 35),
  country_languages text[] NOT NULL CHECK (cardinality(country_languages) BETWEEN 1 AND 32),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, id)
);

CREATE TABLE country_template_countries (
  id uuid PRIMARY KEY,
  country_template_id uuid NOT NULL REFERENCES country_templates(id),
  stable_key text NOT NULL CHECK (length(stable_key) BETWEEN 1 AND 128),
  names jsonb NOT NULL CHECK (jsonb_typeof(names) = 'object' AND names <> '{}'::jsonb),
  default_language text NOT NULL CHECK (length(default_language) BETWEEN 2 AND 35),
  continent text,
  sort_order integer NOT NULL DEFAULT 0,
  flag_type flag_type NOT NULL,
  flag_value text NOT NULL CHECK (length(flag_value) BETWEEN 1 AND 400000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (country_template_id, stable_key),
  UNIQUE (country_template_id, id)
);

CREATE TABLE committee_templates (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  names jsonb NOT NULL CHECK (jsonb_typeof(names) = 'object' AND names <> '{}'::jsonb),
  default_language text NOT NULL CHECK (length(default_language) BETWEEN 2 AND 35),
  country_template_key text NOT NULL CHECK (length(country_template_key) BETWEEN 1 AND 200),
  country_template_id uuid,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, id),
  FOREIGN KEY (owner_user_id, country_template_id) REFERENCES country_templates(owner_user_id, id),
  CHECK ((country_template_key = 'builtin:default' AND country_template_id IS NULL)
    OR (country_template_key = 'custom:' || country_template_id::text AND country_template_id IS NOT NULL))
);

CREATE INDEX committee_templates_country_template
  ON committee_templates (owner_user_id, country_template_id)
  WHERE country_template_id IS NOT NULL;

CREATE TABLE committee_template_members (
  id uuid PRIMARY KEY,
  committee_template_id uuid NOT NULL REFERENCES committee_templates(id),
  stable_key text NOT NULL CHECK (length(stable_key) BETWEEN 1 AND 128),
  names jsonb NOT NULL CHECK (jsonb_typeof(names) = 'object' AND names <> '{}'::jsonb),
  default_language text NOT NULL CHECK (length(default_language) BETWEEN 2 AND 35),
  rank seat_rank NOT NULL,
  can_vote boolean NOT NULL,
  has_veto boolean NOT NULL,
  must_vote boolean NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  flag_type flag_type NOT NULL,
  flag_value text NOT NULL CHECK (length(flag_value) BETWEEN 1 AND 400000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (committee_template_id, stable_key)
);

ALTER TABLE committees
  ADD COLUMN source_committee_template_id uuid REFERENCES committee_templates(id) ON DELETE SET NULL,
  ADD COLUMN country_template_key text NOT NULL DEFAULT 'builtin:default'
    CHECK (length(country_template_key) BETWEEN 1 AND 200),
  ADD COLUMN temporary_template boolean NOT NULL DEFAULT true;

ALTER TABLE committee_seats
  ALTER COLUMN rank TYPE seat_rank USING CASE lower(coalesce(rank, 'standard'))
    WHEN 'veto' THEN 'VETO'::seat_rank
    WHEN 'ngo' THEN 'NGO'::seat_rank
    WHEN 'observer' THEN 'OBSERVER'::seat_rank
    ELSE 'STANDARD'::seat_rank END,
  ALTER COLUMN rank SET DEFAULT 'STANDARD',
  ALTER COLUMN rank SET NOT NULL,
  ADD COLUMN must_vote boolean NOT NULL DEFAULT false,
  ADD COLUMN flag_type flag_type NOT NULL DEFAULT 'EMOJI',
  ADD COLUMN flag_value text NOT NULL DEFAULT '🏳️' CHECK (length(flag_value) BETWEEN 1 AND 400000),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE committee_notes (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  title text NOT NULL DEFAULT '' CHECK (length(title) <= 200),
  content text NOT NULL CHECK (length(content) <= 100000),
  sort_order integer NOT NULL DEFAULT 0,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (committee_id, id)
);

CREATE TABLE committee_text_posts (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  title text NOT NULL DEFAULT '' CHECK (length(title) <= 200),
  content text NOT NULL CHECK (length(content) <= 20000),
  sort_order integer NOT NULL DEFAULT 0,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  author_seat_id uuid REFERENCES committee_seats(id),
  author_display_name text NOT NULL CHECK (length(author_display_name) BETWEEN 1 AND 200),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (committee_id, id)
);

CREATE TABLE meeting_sessions (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  phase_id text NOT NULL CHECK (length(phase_id) BETWEEN 1 AND 128),
  active_rule_package_version_id uuid NOT NULL REFERENCES rule_package_versions(id),
  status meeting_session_status NOT NULL DEFAULT 'OPEN',
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CHECK ((status = 'OPEN' AND closed_at IS NULL) OR (status = 'CLOSED' AND closed_at IS NOT NULL)),
  UNIQUE (committee_id, id)
);

CREATE UNIQUE INDEX meeting_sessions_one_open_per_committee
  ON meeting_sessions (committee_id) WHERE status = 'OPEN';

CREATE TABLE roll_calls (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  meeting_session_id uuid NOT NULL,
  status roll_call_status NOT NULL DEFAULT 'IN_PROGRESS',
  current_seat_id uuid,
  rule_package_version_id uuid NOT NULL REFERENCES rule_package_versions(id),
  allowed_responses text[] NOT NULL CHECK (cardinality(allowed_responses) > 0),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  started_by_user_id uuid NOT NULL REFERENCES users(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((status = 'COMPLETED' AND completed_at IS NOT NULL)
    OR (status <> 'COMPLETED' AND completed_at IS NULL)),
  FOREIGN KEY (committee_id, meeting_session_id) REFERENCES meeting_sessions(committee_id, id),
  FOREIGN KEY (committee_id, current_seat_id) REFERENCES committee_seats(committee_id, id),
  UNIQUE (committee_id, id)
);

CREATE UNIQUE INDEX roll_calls_one_in_progress_per_session
  ON roll_calls (meeting_session_id) WHERE status = 'IN_PROGRESS';

CREATE TABLE roll_call_seats (
  roll_call_id uuid NOT NULL REFERENCES roll_calls(id),
  seat_id uuid NOT NULL REFERENCES committee_seats(id),
  seat_display_name text NOT NULL CHECK (length(seat_display_name) BETWEEN 1 AND 200),
  sort_order integer NOT NULL,
  PRIMARY KEY (roll_call_id, seat_id),
  UNIQUE (roll_call_id, sort_order)
);

CREATE TABLE roll_call_entries (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  roll_call_id uuid NOT NULL,
  seat_id uuid NOT NULL REFERENCES committee_seats(id),
  seat_display_name text NOT NULL CHECK (length(seat_display_name) BETWEEN 1 AND 200),
  response text NOT NULL CHECK (length(response) BETWEEN 1 AND 128),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  on_behalf_of_seat_id uuid NOT NULL REFERENCES committee_seats(id),
  rule_package_version_id uuid NOT NULL REFERENCES rule_package_versions(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz,
  FOREIGN KEY (committee_id, roll_call_id) REFERENCES roll_calls(committee_id, id)
);

CREATE UNIQUE INDEX roll_call_entries_one_active_response
  ON roll_call_entries (roll_call_id, seat_id) WHERE undone_at IS NULL;

CREATE TABLE attendance_events (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  meeting_session_id uuid NOT NULL,
  seat_id uuid NOT NULL REFERENCES committee_seats(id),
  seat_display_name text NOT NULL CHECK (length(seat_display_name) BETWEEN 1 AND 200),
  type attendance_event_type NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  on_behalf_of_seat_id uuid NOT NULL REFERENCES committee_seats(id),
  source_roll_call_entry_id uuid REFERENCES roll_call_entries(id),
  source_point_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (committee_id, meeting_session_id) REFERENCES meeting_sessions(committee_id, id)
);

CREATE TABLE current_attendance (
  committee_id uuid NOT NULL REFERENCES committees(id),
  meeting_session_id uuid NOT NULL,
  seat_id uuid NOT NULL REFERENCES committee_seats(id),
  state attendance_state NOT NULL,
  last_event_id uuid NOT NULL REFERENCES attendance_events(id),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (meeting_session_id, seat_id),
  FOREIGN KEY (committee_id, meeting_session_id) REFERENCES meeting_sessions(committee_id, id)
);

CREATE TABLE points (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  meeting_session_id uuid NOT NULL,
  point_type_id text NOT NULL CHECK (length(point_type_id) BETWEEN 1 AND 128),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  raised_by_seat_id uuid NOT NULL REFERENCES committee_seats(id),
  raised_by_seat_display_name text NOT NULL CHECK (length(raised_by_seat_display_name) BETWEEN 1 AND 200),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  on_behalf_of_seat_id uuid NOT NULL REFERENCES committee_seats(id),
  interrupt_requested boolean NOT NULL,
  status point_status NOT NULL DEFAULT 'PENDING',
  chair_response text NOT NULL DEFAULT '' CHECK (length(chair_response) <= 4000),
  resolved_by_user_id uuid REFERENCES users(id),
  rule_package_version_id uuid NOT NULL REFERENCES rule_package_versions(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK ((status = 'PENDING' AND resolved_by_user_id IS NULL AND resolved_at IS NULL)
    OR (status <> 'PENDING' AND resolved_by_user_id IS NOT NULL AND resolved_at IS NOT NULL)),
  FOREIGN KEY (committee_id, meeting_session_id) REFERENCES meeting_sessions(committee_id, id),
  UNIQUE (committee_id, id)
);

ALTER TABLE attendance_events
  ADD CONSTRAINT attendance_events_source_point_fk
  FOREIGN KEY (source_point_id) REFERENCES points(id);

CREATE TABLE idempotency_keys (
  user_id uuid NOT NULL REFERENCES users(id),
  route text NOT NULL CHECK (length(route) BETWEEN 1 AND 300),
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  response_status integer NOT NULL CHECK (response_status BETWEEN 200 AND 599),
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, route, key)
);

CREATE FUNCTION prevent_attendance_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'attendance events are append-only';
END;
$$;

CREATE TRIGGER attendance_events_append_only
BEFORE UPDATE OR DELETE ON attendance_events
FOR EACH ROW EXECUTE FUNCTION prevent_attendance_event_mutation();

UPDATE quorum_meta.runtime_metadata
SET schema_compatibility = 4,
    updated_at = now()
WHERE singleton = true;

UPDATE system_settings
SET schema_compatibility = 4
WHERE singleton = true;
