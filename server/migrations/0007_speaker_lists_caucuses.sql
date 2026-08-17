CREATE TYPE speaker_list_kind AS ENUM ('GENERAL', 'MODERATED_CAUCUS');
CREATE TYPE speaker_list_status AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE speaker_queue_status AS ENUM ('QUEUED', 'CURRENT', 'COMPLETED', 'SKIPPED');
CREATE TYPE caucus_status AS ENUM ('OPEN', 'CLOSED');

CREATE TABLE speaker_lists (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  meeting_session_id uuid NOT NULL,
  kind speaker_list_kind NOT NULL,
  status speaker_list_status NOT NULL DEFAULT 'OPEN',
  topic text NOT NULL DEFAULT '' CHECK (length(topic) <= 500),
  default_speech_ms bigint NOT NULL CHECK (default_speech_ms > 0),
  rule_package_version_id uuid NOT NULL REFERENCES rule_package_versions(id),
  current_entry_id uuid,
  speech_timer_id uuid NOT NULL REFERENCES timer_states(id),
  total_timer_id uuid REFERENCES timer_states(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CHECK ((status = 'OPEN' AND closed_at IS NULL) OR (status = 'CLOSED' AND closed_at IS NOT NULL)),
  CHECK ((kind = 'GENERAL' AND total_timer_id IS NULL) OR (kind = 'MODERATED_CAUCUS' AND total_timer_id IS NOT NULL)),
  FOREIGN KEY (committee_id, meeting_session_id) REFERENCES meeting_sessions(committee_id, id),
  UNIQUE (committee_id, id)
);

CREATE TABLE speaker_queue_entries (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  speaker_list_id uuid NOT NULL,
  seat_id uuid NOT NULL REFERENCES committee_seats(id),
  seat_display_name text NOT NULL CHECK (length(seat_display_name) BETWEEN 1 AND 200),
  position integer NOT NULL CHECK (position > 0),
  status speaker_queue_status NOT NULL DEFAULT 'QUEUED',
  actor_user_id uuid NOT NULL REFERENCES users(id),
  on_behalf_of_seat_id uuid NOT NULL REFERENCES committee_seats(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (committee_id, speaker_list_id) REFERENCES speaker_lists(committee_id, id),
  CHECK ((status IN ('QUEUED', 'CURRENT') AND completed_at IS NULL)
    OR (status IN ('COMPLETED', 'SKIPPED') AND completed_at IS NOT NULL)),
  UNIQUE (speaker_list_id, id)
);

CREATE UNIQUE INDEX speaker_queue_unique_active_position
  ON speaker_queue_entries (speaker_list_id, position) WHERE status IN ('QUEUED', 'CURRENT');

CREATE UNIQUE INDEX speaker_queue_one_current
  ON speaker_queue_entries (speaker_list_id) WHERE status = 'CURRENT';

ALTER TABLE speaker_lists
  ADD CONSTRAINT speaker_lists_current_entry_fk
  FOREIGN KEY (id, current_entry_id) REFERENCES speaker_queue_entries(speaker_list_id, id);

CREATE TABLE caucuses (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  meeting_session_id uuid NOT NULL,
  speaker_list_id uuid NOT NULL UNIQUE REFERENCES speaker_lists(id),
  topic text NOT NULL CHECK (length(topic) BETWEEN 1 AND 500),
  status caucus_status NOT NULL DEFAULT 'OPEN',
  total_timer_id uuid NOT NULL REFERENCES timer_states(id),
  speech_timer_id uuid NOT NULL REFERENCES timer_states(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CHECK ((status = 'OPEN' AND closed_at IS NULL) OR (status = 'CLOSED' AND closed_at IS NOT NULL)),
  FOREIGN KEY (committee_id, meeting_session_id) REFERENCES meeting_sessions(committee_id, id)
);

UPDATE quorum_meta.runtime_metadata
SET schema_compatibility = 7,
    updated_at = now()
WHERE singleton = true;

UPDATE system_settings
SET schema_compatibility = 7
WHERE singleton = true;
