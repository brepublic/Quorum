ALTER TABLE committees ADD COLUMN meeting_ended_at timestamptz;

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=53,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=53 WHERE singleton=true;
