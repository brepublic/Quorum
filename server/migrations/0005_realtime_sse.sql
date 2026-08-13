ALTER TABLE committees
  ADD COLUMN events_retained_from_sequence bigint NOT NULL DEFAULT 1
    CHECK (events_retained_from_sequence > 0 AND events_retained_from_sequence <= next_event_sequence);

CREATE INDEX committee_events_created_at
  ON committee_events (committee_id, created_at);

UPDATE quorum_meta.runtime_metadata
SET schema_compatibility = 5,
    updated_at = now()
WHERE singleton = true;

UPDATE system_settings
SET schema_compatibility = 5
WHERE singleton = true;
