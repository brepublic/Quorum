ALTER TYPE storage_agent_task_type ADD VALUE 'MIGRATE_BLOB';
ALTER TYPE storage_agent_task_type ADD VALUE 'VERIFY_MIGRATION_BLOB';
ALTER TYPE storage_agent_task_type ADD VALUE 'DELETE_MIGRATION_BLOB';

ALTER TABLE storage_hosts DROP CONSTRAINT storage_host_capabilities_known;
ALTER TABLE storage_hosts ADD CONSTRAINT storage_host_capabilities_known CHECK (
  capabilities <@ ARRAY['SSE_WAKE','CACHE_REFILL','STORAGE_MIGRATION']::text[]
);

ALTER TABLE storage_migrations
  ADD COLUMN confirmation_user_id uuid REFERENCES users(id),
  ADD COLUMN confirmation_request_id text,
  ADD COLUMN confirmation_requested_at timestamptz;

ALTER TABLE storage_migration_items
  ADD COLUMN progress_phase text NOT NULL DEFAULT 'WAITING'
    CHECK (progress_phase IN ('WAITING','TRANSFERRING','VERIFYING','IDLE')),
  ADD COLUMN received_bytes bigint NOT NULL DEFAULT 0 CHECK (received_bytes >= 0 AND received_bytes <= size_bytes),
  ADD COLUMN progress_updated_at timestamptz,
  ADD COLUMN transfer_started_at timestamptz,
  ADD COLUMN bytes_per_second double precision CHECK (bytes_per_second > 0),
  ADD COLUMN verified_at timestamptz;

ALTER TABLE storage_migration_items ADD CONSTRAINT storage_migration_items_committee_identity UNIQUE (committee_id,id);
ALTER TABLE storage_agent_tasks ADD COLUMN migration_item_id uuid;
ALTER TABLE storage_agent_tasks ADD CONSTRAINT storage_agent_tasks_migration_item_fk
  FOREIGN KEY (committee_id,migration_item_id) REFERENCES storage_migration_items(committee_id,id);
CREATE INDEX storage_agent_tasks_migration_item ON storage_agent_tasks(migration_item_id,sequence DESC)
  WHERE migration_item_id IS NOT NULL;

CREATE FUNCTION preserve_storage_migration_task_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.migration_item_id IS DISTINCT FROM OLD.migration_item_id THEN
    RAISE EXCEPTION 'storage migration task identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER storage_agent_tasks_migration_identity BEFORE UPDATE ON storage_agent_tasks
  FOR EACH ROW EXECUTE FUNCTION preserve_storage_migration_task_reference();

ALTER TABLE storage_agent_tasks DROP CONSTRAINT storage_agent_tasks_blob_shape;
ALTER TABLE storage_agent_tasks ADD CONSTRAINT storage_agent_tasks_blob_shape CHECK (
  (task_type::text IN ('STORE_BLOB','UPLOAD_BLOB','FETCH_BLOB_TO_CACHE','MIGRATE_BLOB',
    'VERIFY_MIGRATION_BLOB','DELETE_MIGRATION_BLOB') AND blob_id IS NOT NULL
    AND expected_size_bytes IS NOT NULL AND expected_sha256 IS NOT NULL)
  OR (task_type::text='HOST_COMMIT_BLOB' AND blob_id IS NOT NULL AND source_upload_id IS NOT NULL
    AND expected_size_bytes IS NOT NULL AND expected_sha256 IS NOT NULL)
  OR (task_type::text='DELETE_FILE' AND blob_id IS NULL
    AND expected_size_bytes IS NULL AND expected_sha256 IS NULL)
);
ALTER TABLE storage_agent_tasks ADD CONSTRAINT storage_agent_tasks_migration_shape CHECK (
  (task_type::text IN ('MIGRATE_BLOB','VERIFY_MIGRATION_BLOB','DELETE_MIGRATION_BLOB'))
    = (migration_item_id IS NOT NULL)
);

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=87,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=87 WHERE singleton=true;
