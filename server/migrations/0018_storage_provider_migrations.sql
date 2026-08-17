CREATE TYPE storage_migration_status AS ENUM ('COPYING', 'READY_TO_CONFIRM', 'FAILED', 'COMPLETED', 'CANCELLED');
CREATE TYPE storage_migration_item_status AS ENUM ('PENDING', 'IN_PROGRESS', 'RETRY', 'COMPLETED', 'CANCELLED');

ALTER TABLE committees
  ADD COLUMN file_manifest_revision integer NOT NULL DEFAULT 1 CHECK (file_manifest_revision > 0);

ALTER TABLE storage_provider_configs
  ADD COLUMN verified_revision integer CHECK (verified_revision > 0),
  ADD COLUMN verified_at timestamptz,
  ADD CONSTRAINT storage_provider_configs_verification_state CHECK (
    (verified_revision IS NULL AND verified_at IS NULL)
    OR (verified_revision IS NOT NULL AND verified_at IS NOT NULL)
  );

CREATE TABLE storage_migrations (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  source_binding_id uuid NOT NULL,
  target_binding_id uuid NOT NULL,
  status storage_migration_status NOT NULL DEFAULT 'COPYING',
  manifest_revision integer NOT NULL CHECK (manifest_revision > 0),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  failure_code text CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 80),
  failure_reason text CHECK (failure_reason IS NULL OR length(failure_reason) BETWEEN 1 AND 240),
  ready_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (committee_id, source_binding_id) REFERENCES storage_bindings(committee_id, id),
  FOREIGN KEY (committee_id, target_binding_id) REFERENCES storage_bindings(committee_id, id),
  CHECK (source_binding_id <> target_binding_id),
  CHECK ((status = 'READY_TO_CONFIRM' AND ready_at IS NOT NULL AND completed_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'COMPLETED' AND ready_at IS NOT NULL AND completed_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status = 'CANCELLED' AND completed_at IS NULL AND cancelled_at IS NOT NULL)
    OR (status IN ('COPYING', 'FAILED') AND ready_at IS NULL AND completed_at IS NULL AND cancelled_at IS NULL)),
  UNIQUE (committee_id, id)
);

CREATE UNIQUE INDEX storage_migrations_one_open_per_committee
  ON storage_migrations (committee_id)
  WHERE status IN ('COPYING', 'READY_TO_CONFIRM', 'FAILED');

CREATE TABLE storage_migration_items (
  id uuid PRIMARY KEY,
  migration_id uuid NOT NULL,
  committee_id uuid NOT NULL,
  content_blob_id uuid NOT NULL,
  source_blob_id uuid NOT NULL,
  target_blob_id uuid NOT NULL UNIQUE,
  staging_key text NOT NULL UNIQUE CHECK (
    length(staging_key) BETWEEN 1 AND 512
    AND staging_key ~ '^[a-z0-9][a-z0-9/_-]*$'
    AND staging_key !~ '(^|/)\.\.(/|$)'
  ),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
  status storage_migration_item_status NOT NULL DEFAULT 'PENDING',
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claim_token uuid,
  completed_at timestamptz,
  failure_code text CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 80),
  failure_reason text CHECK (failure_reason IS NULL OR length(failure_reason) BETWEEN 1 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (committee_id, migration_id) REFERENCES storage_migrations(committee_id, id),
  FOREIGN KEY (committee_id, content_blob_id) REFERENCES file_blobs(committee_id, id),
  FOREIGN KEY (committee_id, source_blob_id) REFERENCES file_blobs(committee_id, id),
  UNIQUE (migration_id, content_blob_id),
  CHECK ((status = 'IN_PROGRESS' AND claimed_at IS NOT NULL AND claim_token IS NOT NULL)
    OR (status <> 'IN_PROGRESS' AND claimed_at IS NULL AND claim_token IS NULL)),
  CHECK ((status = 'COMPLETED' AND completed_at IS NOT NULL AND failure_code IS NULL AND failure_reason IS NULL)
    OR (status <> 'COMPLETED' AND completed_at IS NULL))
);

CREATE INDEX storage_migration_items_ready
  ON storage_migration_items (next_attempt_at, created_at, id) WHERE status IN ('PENDING', 'RETRY');
CREATE INDEX storage_migration_items_stale_claim
  ON storage_migration_items (claimed_at, id) WHERE status = 'IN_PROGRESS';

CREATE TABLE file_blob_copies (
  committee_id uuid NOT NULL,
  content_blob_id uuid NOT NULL,
  copy_blob_id uuid NOT NULL,
  storage_binding_id uuid NOT NULL,
  migration_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (content_blob_id, storage_binding_id),
  FOREIGN KEY (committee_id, content_blob_id) REFERENCES file_blobs(committee_id, id),
  FOREIGN KEY (committee_id, copy_blob_id) REFERENCES file_blobs(committee_id, id),
  FOREIGN KEY (committee_id, storage_binding_id) REFERENCES storage_bindings(committee_id, id),
  FOREIGN KEY (committee_id, migration_id) REFERENCES storage_migrations(committee_id, id),
  UNIQUE (copy_blob_id)
);

CREATE FUNCTION enforce_file_blob_copy_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  content file_blobs%ROWTYPE;
  replica file_blobs%ROWTYPE;
BEGIN
  SELECT * INTO content FROM file_blobs WHERE id=NEW.content_blob_id AND committee_id=NEW.committee_id FOR KEY SHARE;
  SELECT * INTO replica FROM file_blobs WHERE id=NEW.copy_blob_id AND committee_id=NEW.committee_id FOR KEY SHARE;
  IF content.id IS NULL OR replica.id IS NULL OR content.id = replica.id
    OR content.size_bytes <> replica.size_bytes OR content.sha256 <> replica.sha256
    OR replica.storage_binding_id <> NEW.storage_binding_id OR replica.durability_state <> 'COMMITTED' THEN
    RAISE EXCEPTION 'file blob copy integrity mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER file_blob_copies_integrity
BEFORE INSERT OR UPDATE ON file_blob_copies
FOR EACH ROW EXECUTE FUNCTION enforce_file_blob_copy_integrity();

UPDATE quorum_meta.runtime_metadata
SET schema_compatibility = 18, updated_at = now()
WHERE singleton = true;

UPDATE system_settings SET schema_compatibility = 18 WHERE singleton = true;
