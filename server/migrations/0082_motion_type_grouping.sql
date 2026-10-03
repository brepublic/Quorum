ALTER TABLE committees ADD COLUMN group_motion_types boolean NOT NULL DEFAULT true;

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=82,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=82 WHERE singleton=true;
