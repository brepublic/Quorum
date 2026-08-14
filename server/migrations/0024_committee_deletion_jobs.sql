CREATE TYPE committee_deletion_job_status AS ENUM ('PENDING', 'IN_PROGRESS', 'RETRY', 'COMPLETED');

CREATE TABLE committee_deletion_jobs (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL UNIQUE,
  requested_by_user_id uuid,
  confirmation_name_sha256 bytea NOT NULL CHECK (octet_length(confirmation_name_sha256)=32),
  status committee_deletion_job_status NOT NULL DEFAULT 'PENDING',
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claim_token uuid,
  completed_at timestamptz,
  failure_code text CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 80),
  failure_reason text CHECK (failure_reason IS NULL OR length(failure_reason) BETWEEN 1 AND 240),
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status='COMPLETED' AND completed_at IS NOT NULL AND claimed_at IS NULL AND claim_token IS NULL)
    OR (status='IN_PROGRESS' AND completed_at IS NULL AND claimed_at IS NOT NULL AND claim_token IS NOT NULL)
    OR (status IN ('PENDING','RETRY') AND completed_at IS NULL AND claimed_at IS NULL AND claim_token IS NULL))
);

CREATE INDEX committee_deletion_jobs_ready ON committee_deletion_jobs(next_attempt_at,requested_at,id)
  WHERE status IN ('PENDING','RETRY');
CREATE INDEX committee_deletion_jobs_stale_claim ON committee_deletion_jobs(claimed_at,id)
  WHERE status='IN_PROGRESS';

CREATE TABLE committee_deletion_agent_tasks (
  deletion_job_id uuid NOT NULL REFERENCES committee_deletion_jobs(id),
  task_id uuid NOT NULL UNIQUE,
  PRIMARY KEY (deletion_job_id,task_id)
);

ALTER TABLE storage_agent_tasks
  ADD COLUMN staging_deleted_at timestamptz,
  ADD COLUMN cleanup_attempts integer NOT NULL DEFAULT 0 CHECK (cleanup_attempts>=0),
  ADD COLUMN cleanup_next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN cleanup_claimed_at timestamptz,
  ADD COLUMN cleanup_claim_token uuid,
  ADD COLUMN cleanup_failure_code text CHECK (cleanup_failure_code IS NULL OR length(cleanup_failure_code) BETWEEN 1 AND 80),
  ADD COLUMN cleanup_failure_reason text CHECK (cleanup_failure_reason IS NULL OR length(cleanup_failure_reason) BETWEEN 1 AND 240),
  ADD CONSTRAINT storage_agent_tasks_cleanup_claim_state CHECK (
    (cleanup_claimed_at IS NULL AND cleanup_claim_token IS NULL)
    OR (cleanup_claimed_at IS NOT NULL AND cleanup_claim_token IS NOT NULL)
  );

CREATE INDEX storage_agent_tasks_cleanup_candidates
  ON storage_agent_tasks(cleanup_next_attempt_at,created_at,id)
  WHERE content_staging_key IS NOT NULL AND staging_deleted_at IS NULL
    AND status IN ('COMPLETED','FAILED','CANCELLED');

ALTER TABLE storage_agent_change_requests
  DROP CONSTRAINT storage_agent_change_requests_task_id_fkey,
  ADD CONSTRAINT storage_agent_change_requests_task_id_fkey FOREIGN KEY (task_id)
    REFERENCES storage_agent_tasks(id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE storage_agent_conflicts
  DROP CONSTRAINT storage_agent_conflicts_change_request_id_fkey,
  ADD CONSTRAINT storage_agent_conflicts_change_request_id_fkey FOREIGN KEY (change_request_id)
    REFERENCES storage_agent_change_requests(id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE storage_agent_tasks
  DROP CONSTRAINT storage_agent_tasks_resolution_conflict_id_fkey,
  ADD CONSTRAINT storage_agent_tasks_resolution_conflict_id_fkey FOREIGN KEY (resolution_conflict_id)
    REFERENCES storage_agent_conflicts(id) DEFERRABLE INITIALLY IMMEDIATE;

CREATE FUNCTION quorum_meta.committee_purge_allowed(p_committee_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT p_committee_id::text=current_setting('quorum.committee_purge_id',true)
    AND EXISTS (
      SELECT 1 FROM committee_deletion_jobs job
      WHERE job.committee_id=p_committee_id AND job.status='IN_PROGRESS'
        AND job.claim_token::text=current_setting('quorum.committee_purge_token',true)
    )
$$;

CREATE OR REPLACE FUNCTION prevent_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND OLD.committee_id IS NOT NULL
    AND quorum_meta.committee_purge_allowed(OLD.committee_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'audit records are append-only';
END; $$;

CREATE OR REPLACE FUNCTION prevent_attendance_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND quorum_meta.committee_purge_allowed(OLD.committee_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'attendance events are append-only';
END; $$;

CREATE OR REPLACE FUNCTION prevent_speech_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND quorum_meta.committee_purge_allowed(OLD.committee_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'speech history is append-only';
END; $$;

CREATE OR REPLACE FUNCTION prevent_ballot_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE purge_committee_id uuid;
BEGIN
  IF TG_OP='DELETE' THEN
    SELECT committee_id INTO purge_committee_id FROM ballots WHERE id=OLD.ballot_id;
    IF quorum_meta.committee_purge_allowed(purge_committee_id) THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION 'ballot vote history is append-only';
END; $$;

CREATE OR REPLACE FUNCTION prevent_strawpoll_vote_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE purge_committee_id uuid;
BEGIN
  IF TG_OP='DELETE' THEN
    SELECT committee_id INTO purge_committee_id FROM strawpolls WHERE id=OLD.strawpoll_id;
    IF quorum_meta.committee_purge_allowed(purge_committee_id) THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION 'strawpoll votes are append-only';
END; $$;

CREATE OR REPLACE FUNCTION prevent_document_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE purge_committee_id uuid;
BEGIN
  IF TG_OP='DELETE' THEN
    IF TG_TABLE_NAME IN ('discussion_entries','document_actions') THEN
      purge_committee_id := OLD.committee_id;
    ELSE
      SELECT committee_id INTO purge_committee_id FROM documents WHERE id=OLD.document_id;
    END IF;
    IF quorum_meta.committee_purge_allowed(purge_committee_id) THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION 'document history is append-only';
END; $$;

CREATE OR REPLACE FUNCTION enforce_file_entry_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF quorum_meta.committee_purge_allowed(OLD.committee_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'logical files cannot be physically deleted';
  END IF;
  IF OLD.status='DELETED' THEN RAISE EXCEPTION 'deleted file cannot be revived'; END IF;
  IF NEW.committee_id<>OLD.committee_id OR NEW.created_by_user_id<>OLD.created_by_user_id
    OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'file identity fields are immutable'; END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION prevent_file_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND quorum_meta.committee_purge_allowed(OLD.committee_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'file versions and tombstones are append-only';
END; $$;

CREATE OR REPLACE FUNCTION enforce_storage_pairing_code_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF quorum_meta.committee_purge_allowed(OLD.committee_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'storage pairing codes cannot be deleted';
  END IF;
  IF NEW.id<>OLD.id OR NEW.committee_id<>OLD.committee_id OR NEW.code_hash<>OLD.code_hash
    OR NEW.purpose<>OLD.purpose OR NEW.created_by_user_id<>OLD.created_by_user_id
    OR NEW.expires_at<>OLD.expires_at OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'storage pairing code identity is immutable';
  END IF;
  IF (OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at)
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'storage pairing code terminal state is immutable';
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION enforce_storage_host_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF quorum_meta.committee_purge_allowed(OLD.committee_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'storage hosts cannot be deleted';
  END IF;
  IF NEW.id<>OLD.id OR NEW.committee_id<>OLD.committee_id OR NEW.device_id<>OLD.device_id
    OR NEW.device_label<>OLD.device_label OR NEW.device_public_key<>OLD.device_public_key
    OR NEW.credential_hash<>OLD.credential_hash OR NEW.paired_by_user_id<>OLD.paired_by_user_id
    OR NEW.lease_generation<>OLD.lease_generation OR NEW.paired_at<>OLD.paired_at OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'storage host identity is immutable';
  END IF;
  IF OLD.status='REVOKED' THEN RAISE EXCEPTION 'revoked storage host is immutable'; END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION prevent_storage_manifest_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND quorum_meta.committee_purge_allowed(OLD.committee_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'storage manifest events are append-only';
END; $$;

CREATE OR REPLACE FUNCTION enforce_storage_agent_task_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF quorum_meta.committee_purge_allowed(OLD.committee_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'storage Agent tasks cannot be deleted';
  END IF;
  IF NEW.id<>OLD.id OR NEW.committee_id<>OLD.committee_id OR NEW.host_id<>OLD.host_id
    OR NEW.lease_generation<>OLD.lease_generation OR NEW.sequence<>OLD.sequence OR NEW.task_type<>OLD.task_type
    OR NEW.file_entry_id<>OLD.file_entry_id OR NEW.file_revision<>OLD.file_revision
    OR NEW.blob_id IS DISTINCT FROM OLD.blob_id OR NEW.expected_size_bytes IS DISTINCT FROM OLD.expected_size_bytes
    OR NEW.expected_sha256 IS DISTINCT FROM OLD.expected_sha256 OR NEW.content_staging_key IS DISTINCT FROM OLD.content_staging_key
    OR NEW.source_upload_id IS DISTINCT FROM OLD.source_upload_id
    OR NEW.resolution_conflict_id IS DISTINCT FROM OLD.resolution_conflict_id OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'storage Agent task identity is immutable';
  END IF;
  IF OLD.status IN ('COMPLETED','FAILED','CANCELLED') THEN
    IF (to_jsonb(NEW)-ARRAY['staging_deleted_at','cleanup_attempts','cleanup_next_attempt_at','cleanup_claimed_at',
      'cleanup_claim_token','cleanup_failure_code','cleanup_failure_reason','updated_at'])
      =(to_jsonb(OLD)-ARRAY['staging_deleted_at','cleanup_attempts','cleanup_next_attempt_at','cleanup_claimed_at',
      'cleanup_claim_token','cleanup_failure_code','cleanup_failure_reason','updated_at']) THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'terminal storage Agent task is immutable';
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION prevent_storage_agent_change_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF quorum_meta.committee_purge_allowed(OLD.committee_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'storage Agent changes cannot be deleted';
  END IF;
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
END; $$;

CREATE OR REPLACE FUNCTION prevent_storage_agent_conflict_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF quorum_meta.committee_purge_allowed(OLD.committee_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'storage Agent conflicts cannot be deleted';
  END IF;
  IF NEW.id<>OLD.id OR NEW.committee_id<>OLD.committee_id OR NEW.host_id<>OLD.host_id
    OR NEW.change_request_id<>OLD.change_request_id OR NEW.file_entry_id IS DISTINCT FROM OLD.file_entry_id
    OR NEW.server_revision IS DISTINCT FROM OLD.server_revision OR NEW.local_base_revision IS DISTINCT FROM OLD.local_base_revision
    OR NEW.reason_code<>OLD.reason_code OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'storage Agent conflict identity is immutable';
  END IF;
  IF OLD.status='RESOLVED' THEN RAISE EXCEPTION 'resolved storage Agent conflict is immutable'; END IF;
  IF NEW.status<>'RESOLVED' OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'storage Agent conflict transition is invalid'; END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION prevent_storage_agent_conflict_application_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE purge_committee_id uuid;
BEGIN
  IF TG_OP='DELETE' THEN
    SELECT committee_id INTO purge_committee_id FROM storage_agent_conflicts WHERE id=OLD.conflict_id;
    IF quorum_meta.committee_purge_allowed(purge_committee_id) THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION 'storage Agent conflict applications are immutable';
END; $$;

CREATE OR REPLACE FUNCTION prevent_published_rule_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE purge_committee_id uuid;
BEGIN
  IF TG_OP='DELETE' THEN
    SELECT committee_id INTO purge_committee_id FROM rule_packages WHERE id=OLD.package_id;
    IF purge_committee_id IS NOT NULL AND quorum_meta.committee_purge_allowed(purge_committee_id) THEN RETURN OLD; END IF;
  END IF;
  IF OLD.status='PUBLISHED' THEN RAISE EXCEPTION 'published rule versions are immutable'; END IF;
  RETURN NEW;
END; $$;

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=24,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=24 WHERE singleton=true;
