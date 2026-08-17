CREATE TYPE storage_agent_conflict_resolution AS ENUM ('KEEP_SERVER','ACCEPT_LOCAL','SAVE_AS_NEW');

ALTER TABLE storage_agent_conflicts
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN resolution_action storage_agent_conflict_resolution,
  ADD COLUMN resolution_logical_name text CHECK
    (resolution_logical_name IS NULL OR length(resolution_logical_name) BETWEEN 1 AND 500),
  ADD COLUMN resolution_lease_generation bigint CHECK
    (resolution_lease_generation IS NULL OR resolution_lease_generation > 0),
  ADD COLUMN resolution_file_revision integer CHECK
    (resolution_file_revision IS NULL OR resolution_file_revision > 0),
  ADD CONSTRAINT storage_agent_conflict_resolution_complete CHECK (
    (status='PENDING' AND resolution_action IS NULL AND resolution_logical_name IS NULL
      AND resolution_lease_generation IS NULL AND resolution_file_revision IS NULL)
    OR (status='RESOLVED' AND resolution_action IS NOT NULL AND resolution_lease_generation IS NOT NULL
      AND ((resolution_action='SAVE_AS_NEW' AND resolution_logical_name IS NOT NULL)
        OR resolution_action<>'SAVE_AS_NEW'))
  );

ALTER TABLE storage_agent_tasks
  ADD COLUMN resolution_conflict_id uuid REFERENCES storage_agent_conflicts(id);
CREATE UNIQUE INDEX storage_agent_resolution_task_once
  ON storage_agent_tasks(resolution_conflict_id) WHERE resolution_conflict_id IS NOT NULL
    AND status NOT IN ('FAILED','CANCELLED');

CREATE OR REPLACE FUNCTION enforce_storage_agent_task_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'storage Agent tasks cannot be deleted'; END IF;
  IF NEW.id<>OLD.id OR NEW.committee_id<>OLD.committee_id OR NEW.host_id<>OLD.host_id
    OR NEW.lease_generation<>OLD.lease_generation OR NEW.sequence<>OLD.sequence OR NEW.task_type<>OLD.task_type
    OR NEW.file_entry_id<>OLD.file_entry_id OR NEW.file_revision<>OLD.file_revision
    OR NEW.blob_id IS DISTINCT FROM OLD.blob_id OR NEW.expected_size_bytes IS DISTINCT FROM OLD.expected_size_bytes
    OR NEW.expected_sha256 IS DISTINCT FROM OLD.expected_sha256
    OR NEW.content_staging_key IS DISTINCT FROM OLD.content_staging_key
    OR NEW.source_upload_id IS DISTINCT FROM OLD.source_upload_id
    OR NEW.resolution_conflict_id IS DISTINCT FROM OLD.resolution_conflict_id OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'storage Agent task identity is immutable';
  END IF;
  IF OLD.status IN ('COMPLETED','FAILED','CANCELLED') THEN
    RAISE EXCEPTION 'terminal storage Agent task is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION prevent_storage_agent_conflict_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'storage Agent conflicts cannot be deleted'; END IF;
  IF NEW.id<>OLD.id OR NEW.committee_id<>OLD.committee_id OR NEW.host_id<>OLD.host_id
    OR NEW.change_request_id<>OLD.change_request_id OR NEW.file_entry_id IS DISTINCT FROM OLD.file_entry_id
    OR NEW.server_revision IS DISTINCT FROM OLD.server_revision
    OR NEW.local_base_revision IS DISTINCT FROM OLD.local_base_revision OR NEW.reason_code<>OLD.reason_code
    OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'storage Agent conflict identity is immutable';
  END IF;
  IF OLD.status='RESOLVED' THEN RAISE EXCEPTION 'resolved storage Agent conflict is immutable'; END IF;
  IF NEW.status<>'RESOLVED' OR NEW.revision<>OLD.revision+1 THEN
    RAISE EXCEPTION 'storage Agent conflict transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storage_agent_conflicts_lifecycle
BEFORE UPDATE OR DELETE ON storage_agent_conflicts
FOR EACH ROW EXECUTE FUNCTION prevent_storage_agent_conflict_mutation();

CREATE TABLE storage_agent_conflict_applications (
  conflict_id uuid PRIMARY KEY REFERENCES storage_agent_conflicts(id),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION prevent_storage_agent_conflict_application_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'storage Agent conflict applications are immutable';
END;
$$;

CREATE TRIGGER storage_agent_conflict_applications_immutable
BEFORE UPDATE OR DELETE ON storage_agent_conflict_applications
FOR EACH ROW EXECUTE FUNCTION prevent_storage_agent_conflict_application_mutation();

UPDATE quorum_meta.runtime_metadata
SET schema_compatibility=23,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=23 WHERE singleton=true;
