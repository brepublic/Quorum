ALTER TABLE users DROP CONSTRAINT users_anonymized_identity_cleared,
  DROP CONSTRAINT users_display_name_check;
ALTER TABLE users DISABLE TRIGGER users_anonymized_irreversible;
UPDATE users SET display_name='' WHERE status='ANONYMIZED';
ALTER TABLE users ENABLE TRIGGER users_anonymized_irreversible;
ALTER TABLE users ADD CONSTRAINT users_display_name_check CHECK (
  (status='ANONYMIZED' AND display_name='') OR
  (status<>'ANONYMIZED' AND length(display_name) BETWEEN 1 AND 120)),
  ADD CONSTRAINT users_anonymized_identity_cleared CHECK (
    (status='ANONYMIZED' AND email IS NULL AND display_name=''
      AND anonymized_at IS NOT NULL AND disabled_at IS NOT NULL AND must_change_password=false)
    OR (status<>'ANONYMIZED' AND email IS NOT NULL AND anonymized_at IS NULL));
ALTER TABLE delegate_file_metadata DROP CONSTRAINT delegate_file_metadata_check,
  ADD CONSTRAINT delegate_file_metadata_check CHECK (
    submission_source IN ('LEGACY','CHAIR') OR submitter_display_name IS NOT NULL);
UPDATE delegate_file_metadata SET submitter_display_name=NULL WHERE submission_source='CHAIR';
UPDATE quorum_meta.runtime_metadata SET schema_compatibility=62,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=62 WHERE singleton=true;
