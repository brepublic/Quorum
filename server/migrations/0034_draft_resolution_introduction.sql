ALTER TABLE document_versions
  DROP CONSTRAINT document_versions_content_length,
  ADD CONSTRAINT document_versions_content_length CHECK (length(content) BETWEEN 0 AND 200000);

ALTER TABLE documents
  ALTER COLUMN created_on_behalf_of_seat_id DROP NOT NULL;

ALTER TABLE document_versions
  ALTER COLUMN created_on_behalf_of_seat_id DROP NOT NULL;

ALTER TABLE resolutions
  ALTER COLUMN proposer_seat_id DROP NOT NULL;

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=34,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=34 WHERE singleton=true;
