ALTER TABLE document_versions
  ADD COLUMN content_file_entry_id uuid REFERENCES file_entries(id),
  ADD CONSTRAINT document_versions_content_source CHECK (
    content_file_entry_id IS NULL OR content='');

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=35,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=35 WHERE singleton=true;
