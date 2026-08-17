ALTER TABLE documents
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by_user_id uuid REFERENCES users(id);

ALTER TABLE documents ADD CONSTRAINT documents_deletion_metadata_complete
  CHECK ((deleted_at IS NULL AND deleted_by_user_id IS NULL)
    OR (deleted_at IS NOT NULL AND deleted_by_user_id IS NOT NULL));

CREATE INDEX documents_visible_committee_created_idx
  ON documents (committee_id,created_at,id) WHERE deleted_at IS NULL;

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=37,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=37 WHERE singleton=true;
