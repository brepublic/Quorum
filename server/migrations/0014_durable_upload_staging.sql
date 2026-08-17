CREATE TYPE file_upload_status AS ENUM (
  'CREATED', 'RECEIVING', 'STAGED', 'COMMITTED', 'CANCELLED', 'FAILED'
);

CREATE TABLE file_uploads (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  storage_binding_id uuid NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  logical_name text NOT NULL CHECK (length(logical_name) BETWEEN 1 AND 500),
  original_name text NOT NULL CHECK (length(original_name) BETWEEN 1 AND 500),
  media_type text NOT NULL CHECK (length(media_type) BETWEEN 1 AND 255),
  expected_size_bytes bigint NOT NULL CHECK (expected_size_bytes >= 0),
  received_size_bytes bigint NOT NULL DEFAULT 0 CHECK (received_size_bytes >= 0),
  expected_sha256 bytea NOT NULL CHECK (octet_length(expected_sha256) = 32),
  actual_sha256 bytea CHECK (actual_sha256 IS NULL OR octet_length(actual_sha256) = 32),
  staging_key text NOT NULL CHECK (
    length(staging_key) BETWEEN 1 AND 512
    AND staging_key ~ '^[a-z0-9][a-z0-9/_-]*$'
    AND staging_key !~ '(^|/)\.\.(/|$)'
  ),
  status file_upload_status NOT NULL DEFAULT 'CREATED',
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  content_idempotency_key text CHECK (
    content_idempotency_key IS NULL OR length(content_idempotency_key) BETWEEN 1 AND 200
  ),
  receiving_started_at timestamptz,
  staged_at timestamptz,
  committed_at timestamptz,
  cancelled_at timestamptz,
  failed_at timestamptz,
  expires_at timestamptz NOT NULL,
  failure_code text CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 80),
  failure_reason text CHECK (failure_reason IS NULL OR length(failure_reason) BETWEEN 1 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (committee_id, storage_binding_id)
    REFERENCES storage_bindings(committee_id, id),
  UNIQUE (staging_key),
  CHECK (expires_at > created_at),
  CHECK (received_size_bytes <= expected_size_bytes OR status = 'FAILED'),
  CHECK (
    (status = 'CREATED' AND receiving_started_at IS NULL AND staged_at IS NULL
      AND committed_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL
      AND actual_sha256 IS NULL AND failure_code IS NULL AND failure_reason IS NULL)
    OR (status = 'RECEIVING' AND receiving_started_at IS NOT NULL AND staged_at IS NULL
      AND committed_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL
      AND actual_sha256 IS NULL AND failure_code IS NULL AND failure_reason IS NULL)
    OR (status = 'STAGED' AND receiving_started_at IS NOT NULL AND staged_at IS NOT NULL
      AND committed_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL
      AND received_size_bytes = expected_size_bytes AND actual_sha256 = expected_sha256
      AND failure_code IS NULL AND failure_reason IS NULL)
    OR (status = 'COMMITTED' AND staged_at IS NOT NULL AND committed_at IS NOT NULL
      AND cancelled_at IS NULL AND failed_at IS NULL
      AND received_size_bytes = expected_size_bytes AND actual_sha256 = expected_sha256
      AND failure_code IS NULL AND failure_reason IS NULL)
    OR (status = 'CANCELLED' AND committed_at IS NULL AND cancelled_at IS NOT NULL
      AND failed_at IS NULL AND failure_code IS NULL AND failure_reason IS NULL)
    OR (status = 'FAILED' AND staged_at IS NULL AND committed_at IS NULL
      AND cancelled_at IS NULL AND failed_at IS NOT NULL
      AND failure_code IS NOT NULL AND failure_reason IS NOT NULL)
  )
);

CREATE INDEX file_uploads_commit_queue
  ON file_uploads (storage_binding_id, created_at)
  WHERE status = 'STAGED';

CREATE INDEX file_uploads_cleanup_candidates
  ON file_uploads (status, expires_at)
  WHERE status IN ('COMMITTED', 'CANCELLED', 'FAILED');

UPDATE quorum_meta.runtime_metadata
SET schema_compatibility = 14, updated_at = now()
WHERE singleton = true;

UPDATE system_settings SET schema_compatibility = 14 WHERE singleton = true;
