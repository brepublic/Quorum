DO $$
DECLARE constraint_name text;
BEGIN
  SELECT conname INTO constraint_name FROM pg_constraint
  WHERE conrelid='storage_agent_tasks'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%STORE_BLOB%'
  LIMIT 1;
  IF constraint_name IS NULL THEN RAISE EXCEPTION 'storage Agent task content constraint is missing'; END IF;
  EXECUTE format('ALTER TABLE storage_agent_tasks DROP CONSTRAINT %I', constraint_name);
END;
$$;

ALTER TABLE storage_agent_tasks ADD CONSTRAINT storage_agent_tasks_content_metadata_check CHECK (
  (task_type IN ('STORE_BLOB','HOST_COMMIT_BLOB','UPLOAD_BLOB') AND blob_id IS NOT NULL
    AND expected_size_bytes IS NOT NULL AND expected_sha256 IS NOT NULL)
  OR (task_type='DELETE_FILE' AND blob_id IS NULL
    AND expected_size_bytes IS NULL AND expected_sha256 IS NULL)
);
ALTER TABLE storage_agent_tasks ADD CONSTRAINT storage_agent_tasks_host_commit_source_check CHECK (
  task_type<>'HOST_COMMIT_BLOB' OR source_upload_id IS NOT NULL
);

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=47,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=47 WHERE singleton=true;
