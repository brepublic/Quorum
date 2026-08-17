CREATE TYPE committee_visibility AS ENUM ('PUBLIC', 'PRIVATE');
CREATE TYPE committee_operation_mode AS ENUM ('DELEGATE_OPERATED', 'CHAIR_OPERATED');
CREATE TYPE committee_status AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED', 'DELETING');
CREATE TYPE committee_membership_status AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'LEFT');
CREATE TYPE seat_assignment_status AS ENUM ('ACTIVE', 'ENDED');
CREATE TYPE rule_package_scope AS ENUM ('BUILTIN', 'SYSTEM', 'COMMITTEE');
CREATE TYPE rule_package_status AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE rule_version_status AS ENUM ('DRAFT', 'PUBLISHED');
CREATE TYPE event_audience AS ENUM ('PUBLIC', 'MEMBER', 'CHAIR');

CREATE TABLE rule_packages (
  id uuid PRIMARY KEY,
  scope rule_package_scope NOT NULL,
  owner_user_id uuid REFERENCES users(id),
  committee_id uuid,
  stable_key text NOT NULL,
  status rule_package_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'SYSTEM' AND owner_user_id IS NOT NULL AND committee_id IS NULL)
    OR (scope = 'COMMITTEE' AND owner_user_id IS NOT NULL AND committee_id IS NOT NULL)
    OR (scope = 'BUILTIN' AND owner_user_id IS NULL AND committee_id IS NULL)),
  UNIQUE (scope, stable_key)
);

CREATE TABLE rule_package_versions (
  id uuid PRIMARY KEY,
  package_id uuid NOT NULL REFERENCES rule_packages(id),
  version integer NOT NULL CHECK (version > 0),
  status rule_version_status NOT NULL DEFAULT 'DRAFT',
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  validation_result jsonb,
  created_by_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CHECK ((status = 'PUBLISHED' AND published_at IS NOT NULL)
    OR (status = 'DRAFT' AND published_at IS NULL)),
  UNIQUE (package_id, version)
);

CREATE TABLE committees (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  chair_label text NOT NULL DEFAULT '',
  topic text NOT NULL DEFAULT '',
  conference text NOT NULL DEFAULT '',
  visibility committee_visibility NOT NULL,
  operation_mode committee_operation_mode NOT NULL,
  status committee_status NOT NULL DEFAULT 'ACTIVE',
  active_rule_package_version_id uuid NOT NULL REFERENCES rule_package_versions(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  next_event_sequence bigint NOT NULL DEFAULT 1 CHECK (next_event_sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

ALTER TABLE rule_packages
  ADD CONSTRAINT rule_packages_committee_fk
  FOREIGN KEY (committee_id) REFERENCES committees(id);

CREATE TABLE committee_memberships (
  committee_id uuid NOT NULL REFERENCES committees(id),
  user_id uuid NOT NULL REFERENCES users(id),
  status committee_membership_status NOT NULL DEFAULT 'ACTIVE',
  joined_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (committee_id, user_id)
);

CREATE TABLE committee_capabilities (
  committee_id uuid NOT NULL REFERENCES committees(id),
  user_id uuid NOT NULL REFERENCES users(id),
  capability text NOT NULL CHECK (capability = 'CHAIR'),
  granted_by_user_id uuid NOT NULL REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (committee_id, user_id, capability)
);

CREATE INDEX committee_capabilities_active
  ON committee_capabilities (committee_id, user_id)
  WHERE revoked_at IS NULL;

CREATE TABLE committee_seats (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  stable_key text NOT NULL CHECK (length(stable_key) BETWEEN 1 AND 128),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  rank text,
  can_vote boolean NOT NULL DEFAULT true,
  has_veto boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (committee_id, stable_key),
  UNIQUE (committee_id, id)
);

CREATE TABLE seat_assignments (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  seat_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  status seat_assignment_status NOT NULL DEFAULT 'ACTIVE',
  assigned_by_user_id uuid NOT NULL REFERENCES users(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  CHECK ((status = 'ACTIVE' AND ended_at IS NULL) OR (status = 'ENDED' AND ended_at IS NOT NULL)),
  FOREIGN KEY (committee_id, seat_id) REFERENCES committee_seats(committee_id, id)
);

CREATE UNIQUE INDEX seat_assignments_one_active_per_user_committee
  ON seat_assignments (committee_id, user_id)
  WHERE status = 'ACTIVE';

CREATE TABLE seat_invitations (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  seat_id uuid NOT NULL,
  code_hash bytea UNIQUE NOT NULL CHECK (octet_length(code_hash) = 32),
  max_uses integer NOT NULL CHECK (max_uses > 0),
  use_count integer NOT NULL DEFAULT 0 CHECK (use_count >= 0 AND use_count <= max_uses),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (committee_id, seat_id) REFERENCES committee_seats(committee_id, id)
);

CREATE TABLE committee_rule_bindings (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  package_version_id uuid NOT NULL REFERENCES rule_package_versions(id),
  effective_from_event_sequence bigint NOT NULL CHECK (effective_from_event_sequence > 0),
  activated_by_user_id uuid NOT NULL REFERENCES users(id),
  activated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (committee_id, effective_from_event_sequence)
);

CREATE TABLE chair_rule_overrides (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  scope text NOT NULL CHECK (scope IN ('ONCE', 'FUTURE')),
  stable_rule_id text NOT NULL,
  value jsonb NOT NULL,
  operation_key text,
  source_package_version_id uuid NOT NULL REFERENCES rule_package_versions(id),
  created_package_version_id uuid REFERENCES rule_package_versions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'ONCE' AND operation_key IS NOT NULL AND created_package_version_id IS NULL)
    OR (scope = 'FUTURE' AND operation_key IS NULL AND created_package_version_id IS NOT NULL))
);

CREATE TABLE committee_events (
  committee_id uuid NOT NULL REFERENCES committees(id),
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  resource_revision integer NOT NULL CHECK (resource_revision > 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  audience event_audience NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (committee_id, sequence)
);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY,
  request_id text NOT NULL,
  committee_id uuid REFERENCES committees(id),
  actor_user_id uuid REFERENCES users(id),
  effective_capabilities text[] NOT NULL DEFAULT '{}',
  on_behalf_of_seat_id uuid REFERENCES committee_seats(id),
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  result text NOT NULL CHECK (result IN ('SUCCEEDED', 'DENIED', 'FAILED')),
  reason text,
  before_summary jsonb,
  after_summary jsonb,
  source_ip_hash bytea CHECK (source_ip_hash IS NULL OR octet_length(source_ip_hash) = 32),
  user_agent_summary text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION prevent_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit records are append-only';
END;
$$;

CREATE TRIGGER audit_log_append_only
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

CREATE FUNCTION prevent_published_rule_version_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'PUBLISHED' THEN
    RAISE EXCEPTION 'published rule versions are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rule_package_versions_published_immutable
BEFORE UPDATE OR DELETE ON rule_package_versions
FOR EACH ROW EXECUTE FUNCTION prevent_published_rule_version_mutation();

UPDATE quorum_meta.runtime_metadata
SET schema_compatibility = 3,
    updated_at = now()
WHERE singleton = true;

UPDATE system_settings
SET schema_compatibility = 3
WHERE singleton = true;
