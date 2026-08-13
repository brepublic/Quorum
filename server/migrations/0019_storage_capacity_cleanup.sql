ALTER TABLE file_uploads
  ADD COLUMN staging_deleted_at timestamptz,
  ADD COLUMN cleanup_attempts integer NOT NULL DEFAULT 0 CHECK (cleanup_attempts >= 0),
  ADD COLUMN cleanup_next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN cleanup_claimed_at timestamptz,
  ADD COLUMN cleanup_claim_token uuid,
  ADD COLUMN cleanup_failure_code text CHECK (cleanup_failure_code IS NULL OR length(cleanup_failure_code) BETWEEN 1 AND 80),
  ADD COLUMN cleanup_failure_reason text CHECK (cleanup_failure_reason IS NULL OR length(cleanup_failure_reason) BETWEEN 1 AND 240),
  ADD CONSTRAINT file_uploads_cleanup_claim_state CHECK (
    (cleanup_claimed_at IS NULL AND cleanup_claim_token IS NULL)
    OR (cleanup_claimed_at IS NOT NULL AND cleanup_claim_token IS NOT NULL)
  );

ALTER TABLE storage_migration_items
  ADD COLUMN staging_deleted_at timestamptz,
  ADD COLUMN cleanup_attempts integer NOT NULL DEFAULT 0 CHECK (cleanup_attempts >= 0),
  ADD COLUMN cleanup_next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN cleanup_claimed_at timestamptz,
  ADD COLUMN cleanup_claim_token uuid,
  ADD COLUMN cleanup_failure_code text CHECK (cleanup_failure_code IS NULL OR length(cleanup_failure_code) BETWEEN 1 AND 80),
  ADD COLUMN cleanup_failure_reason text CHECK (cleanup_failure_reason IS NULL OR length(cleanup_failure_reason) BETWEEN 1 AND 240),
  ADD CONSTRAINT storage_migration_items_cleanup_claim_state CHECK (
    (cleanup_claimed_at IS NULL AND cleanup_claim_token IS NULL)
    OR (cleanup_claimed_at IS NOT NULL AND cleanup_claim_token IS NOT NULL)
  );

CREATE INDEX file_uploads_staging_cleanup_ready
  ON file_uploads (cleanup_next_attempt_at, created_at, id)
  WHERE staging_deleted_at IS NULL AND status IN ('COMMITTED', 'CANCELLED', 'FAILED');

CREATE INDEX storage_migration_items_staging_cleanup_ready
  ON storage_migration_items (cleanup_next_attempt_at, created_at, id)
  WHERE staging_deleted_at IS NULL AND status IN ('COMPLETED', 'CANCELLED');

CREATE TABLE storage_cleanup_audit (
  id bigserial PRIMARY KEY,
  resource_type text NOT NULL CHECK (resource_type IN ('FILE_UPLOAD_STAGING', 'MIGRATION_STAGING', 'BLOB_DELETE')),
  resource_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('SUCCEEDED', 'FAILED')),
  failure_code text CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((outcome = 'SUCCEEDED' AND failure_code IS NULL) OR (outcome = 'FAILED' AND failure_code IS NOT NULL))
);

CREATE FUNCTION prevent_storage_cleanup_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'storage cleanup audit records are append-only';
END;
$$;

CREATE TRIGGER storage_cleanup_audit_append_only
BEFORE UPDATE OR DELETE ON storage_cleanup_audit
FOR EACH ROW EXECUTE FUNCTION prevent_storage_cleanup_audit_mutation();

UPDATE quorum_meta.runtime_metadata
SET schema_compatibility = 19, updated_at = now()
WHERE singleton = true;

UPDATE system_settings SET schema_compatibility = 19 WHERE singleton = true;
