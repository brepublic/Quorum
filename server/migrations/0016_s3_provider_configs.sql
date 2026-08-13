CREATE TYPE storage_provider_config_status AS ENUM ('ACTIVE', 'DISABLED');

CREATE TABLE storage_provider_configs (
  id uuid PRIMARY KEY,
  provider_type storage_provider_type NOT NULL CHECK (provider_type = 'S3_COMPATIBLE'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  endpoint text NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 2048),
  region text NOT NULL CHECK (region ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  bucket text NOT NULL CHECK (bucket ~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'),
  key_prefix text NOT NULL DEFAULT '' CHECK (
    length(key_prefix) <= 256
    AND (key_prefix = '' OR key_prefix ~ '^[a-z0-9]([a-z0-9/_-]*[a-z0-9_-])?$')
    AND key_prefix !~ '(^|/)\.\.(/|$)'
  ),
  force_path_style boolean NOT NULL DEFAULT true,
  allow_private_network boolean NOT NULL DEFAULT false,
  status storage_provider_config_status NOT NULL DEFAULT 'ACTIVE',
  credentials_ciphertext bytea NOT NULL CHECK (octet_length(credentials_ciphertext) > 0),
  credentials_nonce bytea NOT NULL CHECK (octet_length(credentials_nonce) = 12),
  credentials_auth_tag bytea NOT NULL CHECK (octet_length(credentials_auth_tag) = 16),
  credential_key_version integer NOT NULL CHECK (credential_key_version > 0),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE storage_bindings ADD CONSTRAINT storage_bindings_provider_config_fk
  FOREIGN KEY (provider_config_id) REFERENCES storage_provider_configs(id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE storage_bindings ADD CONSTRAINT storage_bindings_provider_config_required CHECK (
  (provider_type = 'SERVER_VOLUME' AND provider_config_id IS NULL)
  OR (provider_type = 'S3_COMPATIBLE' AND provider_config_id IS NOT NULL)
);

CREATE INDEX storage_provider_configs_active_s3
  ON storage_provider_configs (provider_type, display_name, id) WHERE status = 'ACTIVE';

UPDATE quorum_meta.runtime_metadata
SET schema_compatibility = 16, updated_at = now()
WHERE singleton = true;

UPDATE system_settings SET schema_compatibility = 16 WHERE singleton = true;
