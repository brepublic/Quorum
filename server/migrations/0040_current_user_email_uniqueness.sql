DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM users
    WHERE status <> 'ANONYMIZED'
    GROUP BY email
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'current user email addresses must be unique';
  END IF;
END;
$$;

ALTER TABLE users DROP CONSTRAINT users_email_key;

CREATE UNIQUE INDEX users_current_email_unique
  ON users (email)
  WHERE status <> 'ANONYMIZED';

UPDATE quorum_meta.runtime_metadata
SET schema_compatibility = 40,
    updated_at = now()
WHERE singleton = true;

UPDATE system_settings
SET schema_compatibility = 40
WHERE singleton = true;
