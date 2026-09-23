-- Chair-operated points already accept an optional reason at the service boundary.
-- Delegate-operated points continue to require nonempty content in Stage4Service.
ALTER TABLE points DROP CONSTRAINT points_content_check;
ALTER TABLE points ADD CONSTRAINT points_content_check CHECK (length(content) <= 4000);
UPDATE quorum_meta.runtime_metadata SET schema_compatibility=68,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=68 WHERE singleton=true;
