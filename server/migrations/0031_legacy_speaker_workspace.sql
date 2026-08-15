CREATE TYPE speaker_stance AS ENUM ('FOR', 'NEUTRAL', 'AGAINST');
CREATE TYPE speech_yield_decision_status AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

ALTER TABLE speaker_lists
  ADD COLUMN name text,
  ADD COLUMN delegates_can_queue boolean NOT NULL DEFAULT false;

UPDATE speaker_lists
SET name = CASE
  WHEN kind = 'GENERAL' THEN 'General Speakers'' List'
  ELSE 'untitled caucus'
END
WHERE name IS NULL;

ALTER TABLE speaker_lists
  ALTER COLUMN name SET NOT NULL,
  ADD CONSTRAINT speaker_lists_name_length CHECK (length(name) BETWEEN 1 AND 200);

ALTER TABLE speaker_queue_entries
  ADD COLUMN stance speaker_stance NOT NULL DEFAULT 'NEUTRAL',
  ADD COLUMN speech_duration_ms bigint;

UPDATE speaker_queue_entries q
SET speech_duration_ms = l.default_speech_ms
FROM speaker_lists l
WHERE l.id = q.speaker_list_id
  AND q.speech_duration_ms IS NULL;

ALTER TABLE speaker_queue_entries
  ALTER COLUMN speech_duration_ms SET NOT NULL,
  ADD CONSTRAINT speaker_queue_entries_speech_duration_positive CHECK (speech_duration_ms > 0);

ALTER TYPE speech_action_type ADD VALUE 'YIELD_OFFERED';
ALTER TYPE speech_action_type ADD VALUE 'YIELD_ACCEPTED';
ALTER TYPE speech_action_type ADD VALUE 'YIELD_REJECTED';

ALTER TABLE speeches
  ADD COLUMN yield_decision_status speech_yield_decision_status,
  ADD COLUMN interaction_target_seat_id uuid REFERENCES committee_seats(id),
  ADD CONSTRAINT speeches_yield_decision_shape CHECK (
    yield_decision_status IS NULL
    OR (yield_type = 'SEAT' AND yield_target_seat_id IS NOT NULL)
  );

UPDATE quorum_meta.runtime_metadata
SET schema_compatibility = 31,
    updated_at = now()
WHERE singleton = true;

UPDATE system_settings
SET schema_compatibility = 31
WHERE singleton = true;
