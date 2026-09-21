-- A failed provider copy remains STAGED so the verified bytes can be retried.
ALTER TABLE file_uploads ADD COLUMN provider_commit_failed boolean NOT NULL DEFAULT false;

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=65,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=65 WHERE singleton=true;
