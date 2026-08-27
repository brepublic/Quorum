ALTER TYPE storage_agent_task_type ADD VALUE IF NOT EXISTS 'HOST_COMMIT_BLOB';

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=46,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=46 WHERE singleton=true;
