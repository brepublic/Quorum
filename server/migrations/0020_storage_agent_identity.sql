CREATE TYPE storage_pairing_purpose AS ENUM ('INITIAL', 'TRANSFER');
CREATE TYPE storage_host_status AS ENUM ('ACTIVE', 'DEGRADED', 'REVOKED');

ALTER TABLE committees
  ADD COLUMN storage_lease_generation bigint NOT NULL DEFAULT 0 CHECK (storage_lease_generation >= 0);

CREATE TABLE storage_pairing_codes (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  code_hash bytea NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32),
  purpose storage_pairing_purpose NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK (used_at IS NULL OR revoked_at IS NULL)
);

CREATE UNIQUE INDEX storage_pairing_codes_one_pending_per_committee
  ON storage_pairing_codes (committee_id)
  WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE INDEX storage_pairing_codes_expiry
  ON storage_pairing_codes (expires_at)
  WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE TABLE storage_hosts (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  device_id uuid NOT NULL UNIQUE,
  device_label text NOT NULL CHECK (length(device_label) BETWEEN 1 AND 120),
  device_public_key bytea NOT NULL UNIQUE CHECK (octet_length(device_public_key) = 32),
  credential_hash bytea NOT NULL UNIQUE CHECK (octet_length(credential_hash) = 32),
  paired_by_user_id uuid NOT NULL REFERENCES users(id),
  lease_generation bigint NOT NULL CHECK (lease_generation > 0),
  status storage_host_status NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_seen_at timestamptz,
  paired_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'REVOKED' AND revoked_at IS NOT NULL)
    OR (status <> 'REVOKED' AND revoked_at IS NULL)),
  UNIQUE (committee_id, lease_generation)
);

CREATE UNIQUE INDEX storage_hosts_one_current_per_committee
  ON storage_hosts (committee_id)
  WHERE status IN ('ACTIVE', 'DEGRADED');

CREATE INDEX storage_hosts_offline_candidates
  ON storage_hosts (last_seen_at, paired_at, id)
  WHERE status = 'ACTIVE';

CREATE FUNCTION enforce_storage_pairing_code_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'storage pairing codes cannot be deleted';
  END IF;
  IF NEW.id <> OLD.id OR NEW.committee_id <> OLD.committee_id OR NEW.code_hash <> OLD.code_hash
    OR NEW.purpose <> OLD.purpose OR NEW.created_by_user_id <> OLD.created_by_user_id
    OR NEW.expires_at <> OLD.expires_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'storage pairing code identity is immutable';
  END IF;
  IF (OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at)
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'storage pairing code terminal state is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storage_pairing_codes_lifecycle
BEFORE UPDATE OR DELETE ON storage_pairing_codes
FOR EACH ROW EXECUTE FUNCTION enforce_storage_pairing_code_lifecycle();

CREATE FUNCTION enforce_storage_host_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'storage hosts cannot be deleted';
  END IF;
  IF NEW.id <> OLD.id OR NEW.committee_id <> OLD.committee_id OR NEW.device_id <> OLD.device_id
    OR NEW.device_label <> OLD.device_label OR NEW.device_public_key <> OLD.device_public_key
    OR NEW.credential_hash <> OLD.credential_hash OR NEW.paired_by_user_id <> OLD.paired_by_user_id
    OR NEW.lease_generation <> OLD.lease_generation OR NEW.paired_at <> OLD.paired_at
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'storage host identity is immutable';
  END IF;
  IF OLD.status = 'REVOKED' THEN
    RAISE EXCEPTION 'revoked storage host is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storage_hosts_lifecycle
BEFORE UPDATE OR DELETE ON storage_hosts
FOR EACH ROW EXECUTE FUNCTION enforce_storage_host_lifecycle();

UPDATE quorum_meta.runtime_metadata
SET schema_compatibility = 20, updated_at = now()
WHERE singleton = true;

UPDATE system_settings SET schema_compatibility = 20 WHERE singleton = true;
