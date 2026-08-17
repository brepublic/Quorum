ALTER TABLE users
  ALTER COLUMN email DROP NOT NULL;

DELETE FROM sessions
WHERE user_id IN (SELECT id FROM users WHERE status = 'ANONYMIZED');

DELETE FROM user_credentials
WHERE user_id IN (SELECT id FROM users WHERE status = 'ANONYMIZED');

UPDATE users
SET email = NULL,
    display_name = '匿名账号',
    must_change_password = false,
    disabled_at = COALESCE(disabled_at, updated_at),
    anonymized_at = COALESCE(anonymized_at, updated_at)
WHERE status = 'ANONYMIZED';

ALTER TABLE users
  ADD CONSTRAINT users_anonymized_identity_cleared CHECK (
    (status = 'ANONYMIZED' AND email IS NULL AND display_name = '匿名账号'
      AND anonymized_at IS NOT NULL AND disabled_at IS NOT NULL AND must_change_password = false)
    OR
    (status <> 'ANONYMIZED' AND email IS NOT NULL AND anonymized_at IS NULL)
  );

ALTER TABLE committee_templates
  DROP CONSTRAINT committee_templates_owner_user_id_country_template_id_fkey,
  ADD CONSTRAINT committee_templates_owner_country_template_fk
    FOREIGN KEY (owner_user_id, country_template_id)
    REFERENCES country_templates(owner_user_id, id)
    DEFERRABLE INITIALLY IMMEDIATE;

CREATE TABLE identity_idempotency_keys (
  actor_user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  response_body jsonb NOT NULL CHECK (jsonb_typeof(response_body) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_user_id, idempotency_key)
);

CREATE FUNCTION prevent_anonymized_user_restore() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'ANONYMIZED' AND (
    NEW.status <> OLD.status OR NEW.email IS DISTINCT FROM OLD.email
    OR NEW.display_name <> OLD.display_name OR NEW.anonymized_at IS DISTINCT FROM OLD.anonymized_at
    OR NEW.is_system_admin <> OLD.is_system_admin OR NEW.must_change_password <> OLD.must_change_password
  ) THEN
    RAISE EXCEPTION 'anonymized users cannot be restored';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_anonymized_irreversible
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION prevent_anonymized_user_restore();

UPDATE quorum_meta.runtime_metadata
SET schema_compatibility = 25,
    updated_at = now()
WHERE singleton = true;

UPDATE system_settings
SET schema_compatibility = 25
WHERE singleton = true;
