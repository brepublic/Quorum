ALTER TYPE point_status ADD VALUE 'WITHDRAWN';
UPDATE quorum_meta.runtime_metadata SET schema_compatibility=69,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=69 WHERE singleton=true;
