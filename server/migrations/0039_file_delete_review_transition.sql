CREATE OR REPLACE FUNCTION enforce_file_review_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id
    AND NEW.status NOT IN ('UPLOAD_COMPLETE', 'DELETED') THEN
    RAISE EXCEPTION 'new file version must return to upload complete';
  END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF OLD.status = 'UPLOAD_COMPLETE' AND NEW.status IN ('PENDING_REVIEW', 'DELETED') THEN RETURN NEW; END IF;
  IF OLD.status = 'PENDING_REVIEW' AND NEW.status IN ('PUBLISHED', 'DELETED') THEN RETURN NEW; END IF;
  IF OLD.status = 'PENDING_REVIEW' AND NEW.status = 'UPLOAD_COMPLETE'
    AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN RETURN NEW; END IF;
  IF OLD.status = 'PUBLISHED' AND NEW.status = 'DELETED' THEN RETURN NEW; END IF;
  IF OLD.status = 'PUBLISHED' AND NEW.status = 'UPLOAD_COMPLETE'
    AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid file review transition';
END;
$$;

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=39,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=39 WHERE singleton=true;
