ALTER TABLE system_settings ADD COLUMN server_volume_disabled boolean NOT NULL DEFAULT false;
ALTER TABLE system_settings ADD COLUMN server_volume_policy_revision integer NOT NULL DEFAULT 1;
UPDATE quorum_meta.runtime_metadata SET schema_compatibility=90,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=90 WHERE singleton=true;
