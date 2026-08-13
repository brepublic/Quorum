CREATE TYPE storage_provider_type_v2 AS ENUM ('SERVER_VOLUME', 'CHAIR_AGENT', 'S3_COMPATIBLE');

ALTER TABLE storage_bindings
  DROP CONSTRAINT IF EXISTS storage_bindings_check,
  DROP CONSTRAINT storage_bindings_provider_config_required;
ALTER TABLE storage_provider_configs
  DROP CONSTRAINT storage_provider_configs_provider_type_check;
ALTER TABLE storage_bindings ALTER COLUMN provider_type TYPE storage_provider_type_v2
  USING provider_type::text::storage_provider_type_v2;
ALTER TABLE storage_provider_configs ALTER COLUMN provider_type TYPE storage_provider_type_v2
  USING provider_type::text::storage_provider_type_v2;
DROP TYPE storage_provider_type;
ALTER TYPE storage_provider_type_v2 RENAME TO storage_provider_type;
ALTER TABLE storage_bindings ADD CONSTRAINT storage_bindings_provider_config_required CHECK (
  (provider_type IN ('SERVER_VOLUME','CHAIR_AGENT') AND provider_config_id IS NULL)
  OR (provider_type='S3_COMPATIBLE' AND provider_config_id IS NOT NULL)
);
ALTER TABLE storage_provider_configs ADD CONSTRAINT storage_provider_configs_provider_type_check
  CHECK (provider_type='S3_COMPATIBLE');

CREATE TYPE storage_manifest_event_kind AS ENUM ('UPSERT', 'DELETE');
CREATE TYPE storage_agent_task_type AS ENUM ('STORE_BLOB', 'UPLOAD_BLOB', 'DELETE_FILE');
CREATE TYPE storage_agent_task_status AS ENUM ('PENDING', 'IN_PROGRESS', 'RETRY', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE storage_agent_content_state AS ENUM ('NONE', 'RECEIVING', 'STAGED');

ALTER TABLE committees
  ADD COLUMN next_storage_manifest_sequence bigint NOT NULL DEFAULT 1 CHECK (next_storage_manifest_sequence > 0),
  ADD COLUMN next_storage_agent_task_sequence bigint NOT NULL DEFAULT 1 CHECK (next_storage_agent_task_sequence > 0);

CREATE TABLE storage_manifest_events (
  committee_id uuid NOT NULL REFERENCES committees(id),
  sequence bigint NOT NULL CHECK (sequence > 0),
  kind storage_manifest_event_kind NOT NULL,
  file_entry_id uuid NOT NULL,
  file_revision integer NOT NULL CHECK (file_revision > 0),
  version_id uuid,
  blob_id uuid,
  logical_name text CHECK (logical_name IS NULL OR length(logical_name) BETWEEN 1 AND 500),
  original_name text CHECK (original_name IS NULL OR length(original_name) BETWEEN 1 AND 500),
  media_type text CHECK (media_type IS NULL OR length(media_type) BETWEEN 1 AND 255),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  sha256 bytea CHECK (sha256 IS NULL OR octet_length(sha256) = 32),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (committee_id, sequence),
  FOREIGN KEY (committee_id, file_entry_id) REFERENCES file_entries(committee_id, id),
  CHECK ((kind = 'UPSERT' AND version_id IS NOT NULL AND blob_id IS NOT NULL
      AND logical_name IS NOT NULL AND original_name IS NOT NULL AND media_type IS NOT NULL
      AND size_bytes IS NOT NULL AND sha256 IS NOT NULL AND deleted_at IS NULL)
    OR (kind = 'DELETE' AND version_id IS NULL AND blob_id IS NULL
      AND logical_name IS NULL AND original_name IS NULL AND media_type IS NULL
      AND size_bytes IS NULL AND sha256 IS NULL AND deleted_at IS NOT NULL))
);

WITH source AS (
  SELECT e.committee_id,e.id AS file_entry_id,e.revision AS file_revision,'UPSERT'::storage_manifest_event_kind AS kind,
    v.id AS version_id,v.blob_id,e.logical_name,v.original_name,v.media_type,v.size_bytes,v.sha256,
    NULL::timestamptz AS deleted_at,v.created_at
  FROM file_entries e JOIN file_versions v ON v.id=e.current_version_id WHERE e.status<>'DELETED'
  UNION ALL
  SELECT t.committee_id,t.file_entry_id,t.last_content_revision+1,'DELETE'::storage_manifest_event_kind,
    NULL,NULL,NULL,NULL,NULL,NULL,NULL,t.deleted_at,t.deleted_at
  FROM file_tombstones t
), numbered AS (
  SELECT source.*,row_number() OVER (PARTITION BY committee_id ORDER BY created_at,file_entry_id,kind)::bigint AS sequence
  FROM source
)
INSERT INTO storage_manifest_events
  (committee_id,sequence,kind,file_entry_id,file_revision,version_id,blob_id,logical_name,original_name,
   media_type,size_bytes,sha256,deleted_at,created_at)
SELECT committee_id,sequence,kind,file_entry_id,file_revision,version_id,blob_id,logical_name,original_name,
  media_type,size_bytes,sha256,deleted_at,created_at FROM numbered;

UPDATE committees committee SET next_storage_manifest_sequence=manifest.next_sequence
FROM (SELECT committee_id,max(sequence)+1 AS next_sequence FROM storage_manifest_events GROUP BY committee_id) manifest
WHERE committee.id=manifest.committee_id;

CREATE FUNCTION append_storage_manifest_file_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry file_entries%ROWTYPE;
  allocated_sequence bigint;
BEGIN
  SELECT * INTO entry FROM file_entries WHERE id=NEW.file_entry_id AND committee_id=NEW.committee_id;
  IF entry.id IS NULL THEN RAISE EXCEPTION 'manifest file entry is unavailable'; END IF;
  UPDATE committees SET next_storage_manifest_sequence=next_storage_manifest_sequence+1
    WHERE id=NEW.committee_id RETURNING next_storage_manifest_sequence-1 INTO allocated_sequence;
  INSERT INTO storage_manifest_events
    (committee_id,sequence,kind,file_entry_id,file_revision,version_id,blob_id,logical_name,original_name,
     media_type,size_bytes,sha256,created_at)
  VALUES (NEW.committee_id,allocated_sequence,'UPSERT',NEW.file_entry_id,entry.revision,NEW.id,NEW.blob_id,
    entry.logical_name,NEW.original_name,NEW.media_type,NEW.size_bytes,NEW.sha256,NEW.created_at);
  RETURN NEW;
END;
$$;

CREATE TRIGGER file_versions_storage_manifest
AFTER INSERT ON file_versions
FOR EACH ROW EXECUTE FUNCTION append_storage_manifest_file_version();

CREATE FUNCTION append_storage_manifest_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allocated_sequence bigint;
BEGIN
  UPDATE committees SET next_storage_manifest_sequence=next_storage_manifest_sequence+1
    WHERE id=NEW.committee_id RETURNING next_storage_manifest_sequence-1 INTO allocated_sequence;
  INSERT INTO storage_manifest_events
    (committee_id,sequence,kind,file_entry_id,file_revision,deleted_at,created_at)
  VALUES (NEW.committee_id,allocated_sequence,'DELETE',NEW.file_entry_id,NEW.last_content_revision+1,
    NEW.deleted_at,NEW.deleted_at);
  RETURN NEW;
END;
$$;

CREATE TRIGGER file_tombstones_storage_manifest
AFTER INSERT ON file_tombstones
FOR EACH ROW EXECUTE FUNCTION append_storage_manifest_tombstone();

CREATE FUNCTION prevent_storage_manifest_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'storage manifest events are append-only';
END;
$$;

CREATE TRIGGER storage_manifest_events_append_only
BEFORE UPDATE OR DELETE ON storage_manifest_events
FOR EACH ROW EXECUTE FUNCTION prevent_storage_manifest_mutation();

CREATE TABLE storage_agent_tasks (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  host_id uuid NOT NULL REFERENCES storage_hosts(id),
  lease_generation bigint NOT NULL CHECK (lease_generation > 0),
  sequence bigint NOT NULL CHECK (sequence > 0),
  task_type storage_agent_task_type NOT NULL,
  file_entry_id uuid NOT NULL,
  file_revision integer NOT NULL CHECK (file_revision > 0),
  blob_id uuid,
  expected_size_bytes bigint CHECK (expected_size_bytes IS NULL OR expected_size_bytes >= 0),
  expected_sha256 bytea CHECK (expected_sha256 IS NULL OR octet_length(expected_sha256) = 32),
  content_staging_key text UNIQUE CHECK (
    content_staging_key IS NULL OR (
      length(content_staging_key) BETWEEN 1 AND 512
      AND content_staging_key ~ '^[a-z0-9][a-z0-9/_-]*$'
      AND content_staging_key !~ '(^|/)\.\.(/|$)'
    )
  ),
  content_state storage_agent_content_state NOT NULL DEFAULT 'NONE',
  received_size_bytes bigint,
  actual_sha256 bytea CHECK (actual_sha256 IS NULL OR octet_length(actual_sha256) = 32),
  status storage_agent_task_status NOT NULL DEFAULT 'PENDING',
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claim_request_id uuid,
  claim_token uuid,
  terminal_request_id uuid,
  terminal_outcome text CHECK (terminal_outcome IS NULL OR terminal_outcome IN ('COMPLETED','FAILED')),
  completed_at timestamptz,
  cancelled_at timestamptz,
  failure_code text CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 80),
  failure_reason text CHECK (failure_reason IS NULL OR length(failure_reason) BETWEEN 1 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (committee_id, file_entry_id) REFERENCES file_entries(committee_id, id),
  UNIQUE (committee_id, sequence),
  CHECK ((task_type IN ('STORE_BLOB','UPLOAD_BLOB') AND blob_id IS NOT NULL
      AND expected_size_bytes IS NOT NULL AND expected_sha256 IS NOT NULL)
    OR (task_type='DELETE_FILE' AND blob_id IS NULL
      AND expected_size_bytes IS NULL AND expected_sha256 IS NULL)),
  CHECK ((task_type='UPLOAD_BLOB' AND content_staging_key IS NOT NULL)
    OR (task_type<>'UPLOAD_BLOB' AND content_staging_key IS NULL)),
  CHECK ((content_state='NONE' AND received_size_bytes IS NULL AND actual_sha256 IS NULL)
    OR (content_state='RECEIVING' AND received_size_bytes IS NULL AND actual_sha256 IS NULL)
    OR (content_state='STAGED' AND task_type='UPLOAD_BLOB'
      AND received_size_bytes=expected_size_bytes AND actual_sha256=expected_sha256)),
  CHECK ((status='IN_PROGRESS' AND claimed_at IS NOT NULL AND claim_request_id IS NOT NULL AND claim_token IS NOT NULL)
    OR (status<>'IN_PROGRESS' AND claimed_at IS NULL AND claim_request_id IS NULL AND claim_token IS NULL)),
  CHECK ((status='COMPLETED' AND completed_at IS NOT NULL AND cancelled_at IS NULL
      AND terminal_request_id IS NOT NULL AND terminal_outcome='COMPLETED' AND failure_code IS NULL)
    OR (status='CANCELLED' AND completed_at IS NULL AND cancelled_at IS NOT NULL)
    OR (status='FAILED' AND completed_at IS NULL AND cancelled_at IS NULL
      AND terminal_request_id IS NOT NULL AND terminal_outcome='FAILED' AND failure_code IS NOT NULL)
    OR (status IN ('PENDING','IN_PROGRESS','RETRY') AND completed_at IS NULL AND cancelled_at IS NULL))
);

CREATE INDEX storage_agent_tasks_ready
  ON storage_agent_tasks (committee_id,next_attempt_at,sequence,id)
  WHERE status IN ('PENDING','RETRY');

CREATE INDEX storage_agent_tasks_stale_claim
  ON storage_agent_tasks (claimed_at,id) WHERE status='IN_PROGRESS';

CREATE FUNCTION enforce_storage_agent_task_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'storage Agent tasks cannot be deleted'; END IF;
  IF NEW.id<>OLD.id OR NEW.committee_id<>OLD.committee_id OR NEW.host_id<>OLD.host_id
    OR NEW.lease_generation<>OLD.lease_generation OR NEW.sequence<>OLD.sequence OR NEW.task_type<>OLD.task_type
    OR NEW.file_entry_id<>OLD.file_entry_id OR NEW.file_revision<>OLD.file_revision
    OR NEW.blob_id IS DISTINCT FROM OLD.blob_id OR NEW.expected_size_bytes IS DISTINCT FROM OLD.expected_size_bytes
    OR NEW.expected_sha256 IS DISTINCT FROM OLD.expected_sha256
    OR NEW.content_staging_key IS DISTINCT FROM OLD.content_staging_key OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'storage Agent task identity is immutable';
  END IF;
  IF OLD.status IN ('COMPLETED','FAILED','CANCELLED') THEN
    RAISE EXCEPTION 'terminal storage Agent task is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storage_agent_tasks_lifecycle
BEFORE UPDATE OR DELETE ON storage_agent_tasks
FOR EACH ROW EXECUTE FUNCTION enforce_storage_agent_task_identity();

CREATE FUNCTION enqueue_storage_agent_manifest_task() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_host storage_hosts%ROWTYPE;
  allocated_sequence bigint;
  task_id uuid;
BEGIN
  SELECT * INTO current_host FROM storage_hosts
    WHERE committee_id=NEW.committee_id AND status IN ('ACTIVE','DEGRADED');
  IF current_host.id IS NULL THEN RETURN NEW; END IF;
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

CREATE TRIGGER storage_manifest_events_enqueue_task
AFTER INSERT ON storage_manifest_events
FOR EACH ROW EXECUTE FUNCTION enqueue_storage_agent_manifest_task();

UPDATE quorum_meta.runtime_metadata
SET schema_compatibility = 21, updated_at = now()
WHERE singleton = true;

UPDATE system_settings SET schema_compatibility = 21 WHERE singleton = true;
