DROP TYPE delegate_file_type;

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=73,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=73 WHERE singleton=true;
