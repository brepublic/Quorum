DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT conname FROM pg_constraint
    WHERE conrelid='storage_agent_tasks'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%task_type%'
  LOOP
    EXECUTE format('ALTER TABLE storage_agent_tasks DROP CONSTRAINT %I', item.conname);
  END LOOP;
END;
$$;

ALTER TABLE storage_agent_tasks ADD CONSTRAINT storage_agent_tasks_blob_shape CHECK (
  (task_type IN ('STORE_BLOB','UPLOAD_BLOB','FETCH_BLOB_TO_CACHE') AND blob_id IS NOT NULL
    AND expected_size_bytes IS NOT NULL AND expected_sha256 IS NOT NULL)
  OR (task_type='HOST_COMMIT_BLOB' AND blob_id IS NOT NULL AND source_upload_id IS NOT NULL
    AND expected_size_bytes IS NOT NULL AND expected_sha256 IS NOT NULL)
  OR (task_type='DELETE_FILE' AND blob_id IS NULL
    AND expected_size_bytes IS NULL AND expected_sha256 IS NULL)
);
ALTER TABLE storage_agent_tasks ADD CONSTRAINT storage_agent_tasks_content_key_shape CHECK (
  (task_type IN ('UPLOAD_BLOB','FETCH_BLOB_TO_CACHE') AND content_staging_key IS NOT NULL)
  OR (task_type NOT IN ('UPLOAD_BLOB','FETCH_BLOB_TO_CACHE') AND content_staging_key IS NULL)
);
ALTER TABLE storage_agent_tasks ADD CONSTRAINT storage_agent_tasks_content_state_shape CHECK (
  (content_state='NONE' AND received_size_bytes IS NULL AND actual_sha256 IS NULL)
  OR (content_state='RECEIVING' AND task_type IN ('UPLOAD_BLOB','FETCH_BLOB_TO_CACHE')
    AND received_size_bytes IS NULL AND actual_sha256 IS NULL)
  OR (content_state='STAGED' AND task_type IN ('UPLOAD_BLOB','FETCH_BLOB_TO_CACHE')
    AND received_size_bytes=expected_size_bytes AND actual_sha256=expected_sha256)
);

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=50,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=50 WHERE singleton=true;
