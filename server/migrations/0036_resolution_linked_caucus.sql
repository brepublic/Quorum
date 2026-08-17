ALTER TABLE speaker_lists
  ADD COLUMN linked_resolution_document_id uuid REFERENCES resolutions(document_id);

CREATE UNIQUE INDEX speaker_lists_one_caucus_per_resolution
  ON speaker_lists(linked_resolution_document_id)
  WHERE linked_resolution_document_id IS NOT NULL;

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=36,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=36 WHERE singleton=true;
