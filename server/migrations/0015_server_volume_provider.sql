ALTER TABLE file_uploads
  ADD COLUMN provider_blob_id uuid,
  ADD COLUMN provider_storage_key text,
  ADD COLUMN committed_blob_id uuid,
  ADD COLUMN committed_file_entry_id uuid,
  ADD COLUMN committed_file_version_id uuid;

ALTER TABLE file_uploads ADD CONSTRAINT file_uploads_committed_blob_fk
  FOREIGN KEY (committed_blob_id) REFERENCES file_blobs(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE file_uploads ADD CONSTRAINT file_uploads_committed_entry_fk
  FOREIGN KEY (committed_file_entry_id) REFERENCES file_entries(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE file_uploads ADD CONSTRAINT file_uploads_committed_version_fk
  FOREIGN KEY (committed_file_version_id) REFERENCES file_versions(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE file_uploads ADD CONSTRAINT file_uploads_provider_key_integrity CHECK (
  (provider_blob_id IS NULL AND provider_storage_key IS NULL)
  OR (provider_blob_id IS NOT NULL AND provider_storage_key IS NOT NULL
    AND length(provider_storage_key) BETWEEN 1 AND 512
    AND provider_storage_key ~ '^[a-z0-9][a-z0-9/_-]*$'
    AND provider_storage_key !~ '(^|/)\.\.(/|$)')
);

ALTER TABLE file_uploads ADD CONSTRAINT file_uploads_committed_target_integrity CHECK (
  (status = 'COMMITTED' AND provider_blob_id IS NOT NULL
    AND committed_blob_id = provider_blob_id
    AND committed_file_entry_id IS NOT NULL AND committed_file_version_id IS NOT NULL)
  OR (status <> 'COMMITTED' AND committed_blob_id IS NULL
    AND committed_file_entry_id IS NULL AND committed_file_version_id IS NULL)
);

CREATE UNIQUE INDEX file_uploads_provider_blob_once
  ON file_uploads (provider_blob_id) WHERE provider_blob_id IS NOT NULL;

UPDATE quorum_meta.runtime_metadata
SET schema_compatibility = 15, updated_at = now()
WHERE singleton = true;

UPDATE system_settings SET schema_compatibility = 15 WHERE singleton = true;
