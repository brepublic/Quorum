CREATE TYPE storage_provider_type AS ENUM ('SERVER_VOLUME', 'S3_COMPATIBLE');
CREATE TYPE storage_binding_status AS ENUM ('PENDING', 'ACTIVE', 'MIGRATING', 'FAILED', 'RETIRED');
CREATE TYPE file_entry_status AS ENUM ('UPLOAD_COMPLETE', 'PENDING_REVIEW', 'PUBLISHED', 'DELETED');
CREATE TYPE file_blob_durability_state AS ENUM ('COMMITTED', 'DELETE_PENDING', 'DELETED', 'FAILED');

CREATE TABLE storage_bindings (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  provider_type storage_provider_type NOT NULL,
  provider_config_id uuid,
  status storage_binding_status NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((provider_type = 'SERVER_VOLUME' AND provider_config_id IS NULL)
    OR provider_type = 'S3_COMPATIBLE'),
  UNIQUE (committee_id, id)
);

CREATE UNIQUE INDEX storage_bindings_one_active_per_committee
  ON storage_bindings (committee_id) WHERE status = 'ACTIVE';

ALTER TABLE committees ADD COLUMN active_storage_binding_id uuid;
ALTER TABLE committees ADD CONSTRAINT committees_active_storage_binding_fk
  FOREIGN KEY (id, active_storage_binding_id)
  REFERENCES storage_bindings(committee_id, id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE file_entries (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  logical_name text NOT NULL CHECK (length(logical_name) BETWEEN 1 AND 500),
  media_type text NOT NULL CHECK (length(media_type) BETWEEN 1 AND 255),
  status file_entry_status NOT NULL,
  current_version_id uuid,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK ((status = 'DELETED' AND current_version_id IS NULL AND deleted_at IS NOT NULL)
    OR (status <> 'DELETED' AND current_version_id IS NOT NULL AND deleted_at IS NULL)),
  UNIQUE (committee_id, id)
);

CREATE TABLE file_blobs (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL,
  storage_binding_id uuid NOT NULL,
  storage_key text NOT NULL CHECK (
    length(storage_key) BETWEEN 1 AND 512
    AND storage_key ~ '^[a-z0-9][a-z0-9/_-]*$'
    AND storage_key !~ '(^|/)\.\.(/|$)'
  ),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
  durability_state file_blob_durability_state NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (committee_id, storage_binding_id)
    REFERENCES storage_bindings(committee_id, id),
  UNIQUE (committee_id, id),
  UNIQUE (storage_binding_id, storage_key)
);

CREATE TABLE file_versions (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL,
  file_entry_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  blob_id uuid NOT NULL,
  original_name text NOT NULL CHECK (length(original_name) BETWEEN 1 AND 500),
  media_type text NOT NULL CHECK (length(media_type) BETWEEN 1 AND 255),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (committee_id, file_entry_id)
    REFERENCES file_entries(committee_id, id),
  FOREIGN KEY (committee_id, blob_id)
    REFERENCES file_blobs(committee_id, id),
  UNIQUE (file_entry_id, version_number),
  UNIQUE (committee_id, file_entry_id, id)
);

ALTER TABLE file_entries ADD CONSTRAINT file_entries_current_version_fk
  FOREIGN KEY (committee_id, id, current_version_id)
  REFERENCES file_versions(committee_id, file_entry_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE file_tombstones (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL,
  file_entry_id uuid NOT NULL,
  last_content_revision integer NOT NULL CHECK (last_content_revision > 0),
  deleted_by_user_id uuid NOT NULL REFERENCES users(id),
  deleted_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (committee_id, file_entry_id)
    REFERENCES file_entries(committee_id, id),
  UNIQUE (file_entry_id)
);

CREATE FUNCTION enforce_file_version_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  blob_record file_blobs%ROWTYPE;
BEGIN
  IF EXISTS (SELECT 1 FROM file_tombstones WHERE file_entry_id = NEW.file_entry_id) THEN
    RAISE EXCEPTION 'deleted file cannot receive a new version';
  END IF;
  SELECT * INTO blob_record FROM file_blobs
    WHERE id = NEW.blob_id AND committee_id = NEW.committee_id FOR KEY SHARE;
  IF NOT FOUND OR blob_record.durability_state <> 'COMMITTED'
    OR blob_record.size_bytes <> NEW.size_bytes
    OR blob_record.sha256 <> NEW.sha256 THEN
    RAISE EXCEPTION 'file version blob integrity mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER file_versions_integrity
BEFORE INSERT ON file_versions
FOR EACH ROW EXECUTE FUNCTION enforce_file_version_integrity();

CREATE FUNCTION enforce_file_entry_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'logical files cannot be physically deleted';
  END IF;
  IF OLD.status = 'DELETED' THEN
    RAISE EXCEPTION 'deleted file cannot be revived';
  END IF;
  IF NEW.committee_id <> OLD.committee_id
    OR NEW.created_by_user_id <> OLD.created_by_user_id
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'file identity fields are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER file_entries_lifecycle
BEFORE UPDATE OR DELETE ON file_entries
FOR EACH ROW EXECUTE FUNCTION enforce_file_entry_lifecycle();

CREATE FUNCTION enforce_file_tombstone_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry_status file_entry_status;
  entry_revision integer;
BEGIN
  SELECT status, revision INTO entry_status, entry_revision
  FROM file_entries WHERE id = NEW.file_entry_id AND committee_id = NEW.committee_id FOR KEY SHARE;
  IF NOT FOUND OR entry_status <> 'DELETED' OR NEW.last_content_revision <> entry_revision - 1 THEN
    RAISE EXCEPTION 'file tombstone does not match a deleted file';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER file_tombstones_integrity
BEFORE INSERT ON file_tombstones
FOR EACH ROW EXECUTE FUNCTION enforce_file_tombstone_integrity();

CREATE FUNCTION prevent_file_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'file versions and tombstones are append-only';
END;
$$;

CREATE TRIGGER file_versions_append_only
BEFORE UPDATE OR DELETE ON file_versions
FOR EACH ROW EXECUTE FUNCTION prevent_file_history_mutation();

CREATE TRIGGER file_tombstones_append_only
BEFORE UPDATE OR DELETE ON file_tombstones
FOR EACH ROW EXECUTE FUNCTION prevent_file_history_mutation();

UPDATE quorum_meta.runtime_metadata
SET schema_compatibility = 13, updated_at = now()
WHERE singleton = true;

UPDATE system_settings SET schema_compatibility = 13 WHERE singleton = true;
