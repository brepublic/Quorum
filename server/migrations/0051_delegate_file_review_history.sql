ALTER TYPE file_entry_status ADD VALUE IF NOT EXISTS 'REJECTED';
ALTER TABLE file_entries DROP CONSTRAINT file_entries_review_state;
ALTER TABLE file_entries ADD CONSTRAINT file_entries_review_state CHECK (
  (status = 'UPLOAD_COMPLETE' AND submitted_at IS NULL AND published_at IS NULL AND published_by_user_id IS NULL)
  OR (status = 'PENDING_REVIEW' AND submitted_at IS NOT NULL AND published_at IS NULL AND published_by_user_id IS NULL)
  OR (status = 'PUBLISHED' AND submitted_at IS NOT NULL AND published_at IS NOT NULL AND published_by_user_id IS NOT NULL)
  OR (status::text = 'REJECTED' AND published_at IS NULL AND published_by_user_id IS NULL)
  OR status = 'DELETED'
);
ALTER TABLE delegate_file_metadata ADD COLUMN rejection_reason text CHECK (length(rejection_reason)<=2000);
ALTER TABLE delegate_file_metadata ADD COLUMN rejected_at timestamptz;

CREATE OR REPLACE FUNCTION enforce_file_review_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id
    AND NEW.status NOT IN ('UPLOAD_COMPLETE', 'DELETED') THEN
    RAISE EXCEPTION 'new file version must return to upload complete';
  END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF OLD.status = 'UPLOAD_COMPLETE' AND NEW.status IN ('PENDING_REVIEW', 'PUBLISHED', 'REJECTED', 'DELETED') THEN RETURN NEW; END IF;
  IF OLD.status = 'PENDING_REVIEW' AND NEW.status IN ('PUBLISHED', 'REJECTED', 'DELETED') THEN RETURN NEW; END IF;
  IF OLD.status = 'PENDING_REVIEW' AND NEW.status = 'UPLOAD_COMPLETE'
    AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN RETURN NEW; END IF;
  IF OLD.status = 'REJECTED' AND NEW.status = 'DELETED' THEN RETURN NEW; END IF;
  IF OLD.status = 'PUBLISHED' AND NEW.status = 'DELETED' THEN RETURN NEW; END IF;
  IF OLD.status = 'PUBLISHED' AND NEW.status = 'UPLOAD_COMPLETE'
    AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid file review transition';
END;
$$;

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=51,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=51 WHERE singleton=true;
