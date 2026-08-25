ALTER TABLE meeting_sessions
  ADD COLUMN formal_debate_open boolean NOT NULL DEFAULT false;

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=44,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=44 WHERE singleton=true;
