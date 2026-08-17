ALTER TYPE meeting_session_status ADD VALUE IF NOT EXISTS 'PENDING';

ALTER TABLE meeting_sessions ADD COLUMN name text;

WITH numbered_sessions AS (
  SELECT id, row_number() OVER (PARTITION BY committee_id ORDER BY created_at,id) AS ordinal
  FROM meeting_sessions
)
UPDATE meeting_sessions AS session
SET name = U&'\7B2C' || numbered_sessions.ordinal || U&'\4F1A\671F'
FROM numbered_sessions
WHERE session.id = numbered_sessions.id;

ALTER TABLE meeting_sessions
  ALTER COLUMN name SET NOT NULL,
  ADD CONSTRAINT meeting_sessions_name_length CHECK (length(name) BETWEEN 1 AND 200),
  ADD CONSTRAINT meeting_sessions_committee_name_unique UNIQUE (committee_id,name);
