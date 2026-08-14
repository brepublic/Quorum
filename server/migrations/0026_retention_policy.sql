CREATE TABLE operations_retention_runs (
  id uuid PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('COMPLETED', 'FAILED')),
  deleted_counts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(deleted_counts) = 'object'),
  failure_code text CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 80),
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  CHECK ((status = 'COMPLETED' AND failure_code IS NULL) OR (status = 'FAILED' AND failure_code IS NOT NULL))
);

CREATE FUNCTION prevent_retention_run_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'retention run records are append-only';
END;
$$;

CREATE TRIGGER operations_retention_runs_append_only
BEFORE UPDATE OR DELETE ON operations_retention_runs
FOR EACH ROW EXECUTE FUNCTION prevent_retention_run_mutation();

CREATE INDEX sessions_retention_candidates ON sessions (COALESCE(revoked_at, expires_at));
CREATE INDEX identity_idempotency_keys_retention ON identity_idempotency_keys (created_at);
CREATE INDEX registration_requests_retention ON registration_requests (decided_at)
  WHERE status IN ('APPROVED', 'REJECTED', 'CANCELLED');

UPDATE quorum_meta.runtime_metadata SET schema_compatibility = 26, updated_at = now() WHERE singleton = true;
UPDATE system_settings SET schema_compatibility = 26 WHERE singleton = true;
