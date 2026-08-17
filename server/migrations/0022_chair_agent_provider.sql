CREATE TYPE file_sync_state AS ENUM ('PENDING_HOST_COMMIT', 'SYNCED', 'OUT_OF_SYNC');
CREATE TYPE agent_upload_commit_state AS ENUM ('PENDING_HOST_COMMIT', 'HOST_COMMITTED', 'CONFLICT');
CREATE TYPE storage_agent_change_kind AS ENUM ('UPSERT', 'RENAME', 'DELETE');
CREATE TYPE storage_agent_change_status AS ENUM ('PENDING_CONTENT', 'COMPLETED', 'CONFLICT');
CREATE TYPE storage_agent_conflict_status AS ENUM ('PENDING', 'RESOLVED');

ALTER TABLE storage_hosts ADD CONSTRAINT storage_hosts_committee_id_id_unique UNIQUE (committee_id,id);
ALTER TABLE storage_bindings ADD COLUMN storage_host_id uuid;
ALTER TABLE storage_bindings ADD CONSTRAINT storage_bindings_storage_host_fk
  FOREIGN KEY (committee_id,storage_host_id) REFERENCES storage_hosts(committee_id,id);
ALTER TABLE storage_bindings DROP CONSTRAINT storage_bindings_provider_config_required;
ALTER TABLE storage_bindings ADD CONSTRAINT storage_bindings_provider_target_required CHECK (
  (provider_type='SERVER_VOLUME' AND provider_config_id IS NULL AND storage_host_id IS NULL)
  OR (provider_type='CHAIR_AGENT' AND provider_config_id IS NULL AND storage_host_id IS NOT NULL)
  OR (provider_type='S3_COMPATIBLE' AND provider_config_id IS NOT NULL AND storage_host_id IS NULL)
);

ALTER TABLE file_entries
  ADD COLUMN sync_state file_sync_state NOT NULL DEFAULT 'SYNCED';

ALTER TABLE file_uploads
  ADD COLUMN agent_commit_state agent_upload_commit_state,
  ADD COLUMN agent_task_id uuid,
  ADD COLUMN agent_host_id uuid,
  ADD COLUMN agent_lease_generation bigint CHECK (agent_lease_generation IS NULL OR agent_lease_generation > 0);

ALTER TABLE storage_agent_tasks
  ADD COLUMN source_upload_id uuid;

ALTER TABLE file_uploads ADD CONSTRAINT file_uploads_agent_host_fk
  FOREIGN KEY (committee_id,agent_host_id) REFERENCES storage_hosts(committee_id,id);
ALTER TABLE storage_agent_tasks
  DROP CONSTRAINT storage_agent_tasks_committee_id_file_entry_id_fkey;

ALTER TABLE file_uploads ADD CONSTRAINT file_uploads_agent_target_integrity CHECK (
  (agent_commit_state IS NULL AND agent_task_id IS NULL AND agent_host_id IS NULL AND agent_lease_generation IS NULL)
  OR (agent_commit_state IS NOT NULL AND agent_task_id IS NOT NULL
    AND agent_host_id IS NOT NULL AND agent_lease_generation IS NOT NULL)
);
ALTER TABLE file_uploads ADD CONSTRAINT file_uploads_agent_task_fk
  FOREIGN KEY (agent_task_id) REFERENCES storage_agent_tasks(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE storage_agent_tasks ADD CONSTRAINT storage_agent_tasks_source_upload_fk
  FOREIGN KEY (source_upload_id) REFERENCES file_uploads(id) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX file_uploads_agent_task_once ON file_uploads(agent_task_id) WHERE agent_task_id IS NOT NULL;
CREATE UNIQUE INDEX storage_agent_tasks_source_upload_once
  ON storage_agent_tasks(source_upload_id) WHERE source_upload_id IS NOT NULL
    AND status NOT IN ('COMPLETED','FAILED','CANCELLED');

CREATE TABLE storage_agent_change_requests (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  host_id uuid NOT NULL REFERENCES storage_hosts(id),
  lease_generation bigint NOT NULL CHECK (lease_generation > 0),
  request_id uuid NOT NULL,
  manifest_sequence bigint NOT NULL CHECK (manifest_sequence >= 0),
  kind storage_agent_change_kind NOT NULL,
  file_entry_id uuid,
  base_revision integer CHECK (base_revision IS NULL OR base_revision > 0),
  logical_name text CHECK (logical_name IS NULL OR length(logical_name) BETWEEN 1 AND 500),
  original_name text CHECK (original_name IS NULL OR length(original_name) BETWEEN 1 AND 500),
  media_type text CHECK (media_type IS NULL OR length(media_type) BETWEEN 1 AND 255),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  sha256 bytea CHECK (sha256 IS NULL OR octet_length(sha256)=32),
  upload_id uuid REFERENCES file_uploads(id),
  task_id uuid REFERENCES storage_agent_tasks(id),
  status storage_agent_change_status NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (host_id, request_id),
  CHECK ((kind='UPSERT' AND logical_name IS NOT NULL AND original_name IS NOT NULL AND media_type IS NOT NULL
      AND size_bytes IS NOT NULL AND sha256 IS NOT NULL)
    OR (kind='RENAME' AND file_entry_id IS NOT NULL AND base_revision IS NOT NULL AND logical_name IS NOT NULL
      AND original_name IS NULL AND media_type IS NULL AND size_bytes IS NULL AND sha256 IS NULL)
    OR (kind='DELETE' AND file_entry_id IS NOT NULL AND base_revision IS NOT NULL AND logical_name IS NULL
      AND original_name IS NULL AND media_type IS NULL AND size_bytes IS NULL AND sha256 IS NULL)),
  CHECK ((status='PENDING_CONTENT' AND kind='UPSERT' AND upload_id IS NOT NULL AND task_id IS NOT NULL
      AND completed_at IS NULL)
    OR (status='COMPLETED' AND completed_at IS NOT NULL)
    OR (status='CONFLICT' AND completed_at IS NOT NULL))
);

CREATE TABLE storage_agent_conflicts (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  host_id uuid NOT NULL REFERENCES storage_hosts(id),
  change_request_id uuid NOT NULL UNIQUE REFERENCES storage_agent_change_requests(id),
  file_entry_id uuid,
  server_revision integer,
  local_base_revision integer,
  reason_code text NOT NULL CHECK (reason_code IN
    ('MANIFEST_STALE','FILE_DELETED','REVISION_CONFLICT','NAME_CONFLICT','HOST_TRANSFERRED')),
  status storage_agent_conflict_status NOT NULL DEFAULT 'PENDING',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by_user_id uuid REFERENCES users(id),
  CHECK ((status='PENDING' AND resolved_at IS NULL AND resolved_by_user_id IS NULL)
    OR (status='RESOLVED' AND resolved_at IS NOT NULL AND resolved_by_user_id IS NOT NULL))
);

CREATE FUNCTION prevent_storage_agent_change_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'storage Agent changes cannot be deleted'; END IF;
  IF NEW.id<>OLD.id OR NEW.committee_id<>OLD.committee_id OR NEW.host_id<>OLD.host_id
    OR NEW.lease_generation<>OLD.lease_generation OR NEW.request_id<>OLD.request_id
    OR NEW.manifest_sequence<>OLD.manifest_sequence OR NEW.kind<>OLD.kind
    OR NEW.file_entry_id IS DISTINCT FROM OLD.file_entry_id OR NEW.base_revision IS DISTINCT FROM OLD.base_revision
    OR NEW.logical_name IS DISTINCT FROM OLD.logical_name OR NEW.original_name IS DISTINCT FROM OLD.original_name
    OR NEW.media_type IS DISTINCT FROM OLD.media_type OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
    OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.upload_id IS DISTINCT FROM OLD.upload_id
    OR NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'storage Agent change identity is immutable';
  END IF;
  IF OLD.status IN ('COMPLETED','CONFLICT') THEN RAISE EXCEPTION 'terminal storage Agent change is immutable'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storage_agent_changes_lifecycle
BEFORE UPDATE OR DELETE ON storage_agent_change_requests
FOR EACH ROW EXECUTE FUNCTION prevent_storage_agent_change_mutation();

CREATE OR REPLACE FUNCTION enforce_storage_agent_task_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'storage Agent tasks cannot be deleted'; END IF;
  IF NEW.id<>OLD.id OR NEW.committee_id<>OLD.committee_id OR NEW.host_id<>OLD.host_id
    OR NEW.lease_generation<>OLD.lease_generation OR NEW.sequence<>OLD.sequence OR NEW.task_type<>OLD.task_type
    OR NEW.file_entry_id<>OLD.file_entry_id OR NEW.file_revision<>OLD.file_revision
    OR NEW.blob_id IS DISTINCT FROM OLD.blob_id OR NEW.expected_size_bytes IS DISTINCT FROM OLD.expected_size_bytes
    OR NEW.expected_sha256 IS DISTINCT FROM OLD.expected_sha256
    OR NEW.content_staging_key IS DISTINCT FROM OLD.content_staging_key
    OR NEW.source_upload_id IS DISTINCT FROM OLD.source_upload_id OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'storage Agent task identity is immutable';
  END IF;
  IF OLD.status IN ('COMPLETED','FAILED','CANCELLED') THEN
    RAISE EXCEPTION 'terminal storage Agent task is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enqueue_storage_agent_manifest_task() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_host storage_hosts%ROWTYPE;
  blob_provider storage_provider_type;
  binding_host_id uuid;
  allocated_sequence bigint;
  task_id uuid;
BEGIN
  SELECT * INTO current_host FROM storage_hosts
    WHERE committee_id=NEW.committee_id AND status IN ('ACTIVE','DEGRADED');
  IF current_host.id IS NULL THEN RETURN NEW; END IF;
  IF NEW.kind='UPSERT' THEN
    SELECT binding.provider_type,binding.storage_host_id INTO blob_provider,binding_host_id
      FROM file_blobs blob JOIN storage_bindings binding ON binding.id=blob.storage_binding_id
      WHERE blob.id=NEW.blob_id;
    IF blob_provider='CHAIR_AGENT' AND binding_host_id=current_host.id THEN RETURN NEW; END IF;
  END IF;
  UPDATE committees SET next_storage_agent_task_sequence=next_storage_agent_task_sequence+1
    WHERE id=NEW.committee_id RETURNING next_storage_agent_task_sequence-1 INTO allocated_sequence;
  task_id := gen_random_uuid();
  IF NEW.kind='UPSERT' THEN
    INSERT INTO storage_agent_tasks
      (id,committee_id,host_id,lease_generation,sequence,task_type,file_entry_id,file_revision,
       blob_id,expected_size_bytes,expected_sha256)
    VALUES (task_id,NEW.committee_id,current_host.id,current_host.lease_generation,allocated_sequence,
      'STORE_BLOB',NEW.file_entry_id,NEW.file_revision,NEW.blob_id,NEW.size_bytes,NEW.sha256);
  ELSE
    INSERT INTO storage_agent_tasks
      (id,committee_id,host_id,lease_generation,sequence,task_type,file_entry_id,file_revision)
    VALUES (task_id,NEW.committee_id,current_host.id,current_host.lease_generation,allocated_sequence,
      'DELETE_FILE',NEW.file_entry_id,NEW.file_revision);
  END IF;
  RETURN NEW;
END;
$$;

UPDATE quorum_meta.runtime_metadata
SET schema_compatibility=22,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=22 WHERE singleton=true;
