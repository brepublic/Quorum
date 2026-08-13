CREATE TYPE file_blob_delete_job_status AS ENUM ('PENDING', 'IN_PROGRESS', 'RETRY', 'COMPLETED');

ALTER TABLE file_entries
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN published_at timestamptz,
  ADD COLUMN published_by_user_id uuid REFERENCES users(id);

ALTER TABLE file_entries ADD CONSTRAINT file_entries_review_state CHECK (
  (status = 'UPLOAD_COMPLETE' AND submitted_at IS NULL AND published_at IS NULL AND published_by_user_id IS NULL)
  OR (status = 'PENDING_REVIEW' AND submitted_at IS NOT NULL AND published_at IS NULL AND published_by_user_id IS NULL)
  OR (status = 'PUBLISHED' AND submitted_at IS NOT NULL AND published_at IS NOT NULL AND published_by_user_id IS NOT NULL)
  OR status = 'DELETED'
);

CREATE FUNCTION enforce_file_review_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id AND NEW.status <> 'UPLOAD_COMPLETE' THEN
    RAISE EXCEPTION 'new file version must return to upload complete';
  END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF OLD.status = 'UPLOAD_COMPLETE' AND NEW.status IN ('PENDING_REVIEW', 'DELETED') THEN RETURN NEW; END IF;
  IF OLD.status = 'PENDING_REVIEW' AND NEW.status IN ('PUBLISHED', 'DELETED') THEN RETURN NEW; END IF;
  IF OLD.status = 'PENDING_REVIEW' AND NEW.status = 'UPLOAD_COMPLETE'
    AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN RETURN NEW; END IF;
  IF OLD.status = 'PUBLISHED' AND NEW.status = 'DELETED' THEN RETURN NEW; END IF;
  IF OLD.status = 'PUBLISHED' AND NEW.status = 'UPLOAD_COMPLETE'
    AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid file review transition';
END;
$$;

CREATE TRIGGER file_entries_review_transition
BEFORE UPDATE ON file_entries
FOR EACH ROW EXECUTE FUNCTION enforce_file_review_transition();

CREATE TABLE file_blob_delete_jobs (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  file_entry_id uuid NOT NULL,
  blob_id uuid NOT NULL,
  status file_blob_delete_job_status NOT NULL DEFAULT 'PENDING',
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claim_token uuid,
  completed_at timestamptz,
  failure_code text CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 80),
  failure_reason text CHECK (failure_reason IS NULL OR length(failure_reason) BETWEEN 1 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (committee_id, file_entry_id) REFERENCES file_entries(committee_id, id),
  FOREIGN KEY (committee_id, blob_id) REFERENCES file_blobs(committee_id, id),
  UNIQUE (blob_id),
  CHECK ((status = 'COMPLETED' AND completed_at IS NOT NULL AND failure_code IS NULL AND failure_reason IS NULL)
    OR (status <> 'COMPLETED' AND completed_at IS NULL)),
  CHECK ((status = 'IN_PROGRESS' AND claimed_at IS NOT NULL AND claim_token IS NOT NULL)
    OR (status <> 'IN_PROGRESS' AND claimed_at IS NULL AND claim_token IS NULL))
);

CREATE INDEX file_blob_delete_jobs_ready
  ON file_blob_delete_jobs (next_attempt_at, created_at, id) WHERE status IN ('PENDING', 'RETRY');

CREATE INDEX file_blob_delete_jobs_stale_claim
  ON file_blob_delete_jobs (claimed_at, id) WHERE status = 'IN_PROGRESS';

UPDATE quorum_meta.runtime_metadata
SET schema_compatibility = 17, updated_at = now()
WHERE singleton = true;

UPDATE system_settings SET schema_compatibility = 17 WHERE singleton = true;
