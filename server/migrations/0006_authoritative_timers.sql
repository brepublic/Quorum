CREATE TYPE timer_owner_type AS ENUM ('COMMITTEE', 'SPEAKER_LIST', 'CAUCUS', 'SPEECH');

CREATE TABLE timer_states (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  owner_type timer_owner_type NOT NULL,
  owner_id uuid NOT NULL,
  running boolean NOT NULL DEFAULT false,
  started_at timestamptz,
  remaining_at_start_ms bigint NOT NULL CHECK (remaining_at_start_ms >= 0),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  expired_at timestamptz,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((running AND started_at IS NOT NULL AND remaining_at_start_ms > 0 AND expired_at IS NULL)
    OR (NOT running AND started_at IS NULL)),
  UNIQUE (committee_id, owner_type, owner_id),
  UNIQUE (committee_id, id)
);

UPDATE quorum_meta.runtime_metadata
SET schema_compatibility = 6,
    updated_at = now()
WHERE singleton = true;

UPDATE system_settings
SET schema_compatibility = 6
WHERE singleton = true;
