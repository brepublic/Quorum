CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE user_status AS ENUM ('ACTIVE', 'DISABLED', 'ANONYMIZED');

CREATE TABLE system_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  initialized_at timestamptz,
  bootstrap_secret_hash bytea,
  registration_policy text NOT NULL DEFAULT 'ADMIN_ONLY'
    CHECK (registration_policy IN ('ADMIN_ONLY', 'SELF_REGISTRATION_WITH_APPROVAL')),
  schema_compatibility integer NOT NULL DEFAULT 2,
  CHECK (initialized_at IS NULL OR bootstrap_secret_hash IS NULL)
);

INSERT INTO system_settings (singleton, bootstrap_secret_hash)
VALUES (true, NULL)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email citext UNIQUE NOT NULL,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  status user_status NOT NULL DEFAULT 'ACTIVE',
  is_system_admin boolean NOT NULL DEFAULT false,
  session_version integer NOT NULL DEFAULT 1 CHECK (session_version > 0),
  must_change_password boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  anonymized_at timestamptz
);

CREATE UNIQUE INDEX users_single_system_admin
  ON users (is_system_admin)
  WHERE is_system_admin = true;

CREATE TABLE user_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  password_hash text NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash bytea UNIQUE NOT NULL CHECK (octet_length(token_hash) = 32),
  session_version integer NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  ip_hash bytea CHECK (ip_hash IS NULL OR octet_length(ip_hash) = 32),
  user_agent_summary text
);

CREATE INDEX sessions_active_user ON sessions (user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE registration_requests (
  id uuid PRIMARY KEY,
  email citext NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by_user_id uuid REFERENCES users(id)
);

CREATE TABLE identity_audit_log (
  id uuid PRIMARY KEY,
  request_id text NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  action text NOT NULL,
  target_user_id uuid REFERENCES users(id),
  result text NOT NULL CHECK (result IN ('SUCCEEDED', 'DENIED', 'FAILED')),
  source_ip_hash bytea CHECK (source_ip_hash IS NULL OR octet_length(source_ip_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION prevent_identity_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'identity audit records are append-only';
END;
$$;

CREATE TRIGGER identity_audit_log_append_only
BEFORE UPDATE OR DELETE ON identity_audit_log
FOR EACH ROW EXECUTE FUNCTION prevent_identity_audit_mutation();

UPDATE quorum_meta.runtime_metadata
SET schema_compatibility = 2,
    updated_at = now()
WHERE singleton = true;
