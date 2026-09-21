-- Storage availability affects operations, not the lifetime of a share or its credentials.
CREATE OR REPLACE FUNCTION end_delegate_file_share_when_unavailable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.operation_mode <> 'CHAIR_OPERATED' OR NEW.status IN ('ARCHIVED','DELETING') THEN
    UPDATE delegate_file_shares SET status='ENDED',revision=revision+1,ended_at=now()
      WHERE committee_id=NEW.id AND status='ACTIVE';
    UPDATE delegate_file_sessions SET revoked_at=now()
      WHERE share_id IN (SELECT id FROM delegate_file_shares WHERE committee_id=NEW.id AND status='ENDED')
        AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION enforce_file_review_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id
    AND NEW.status NOT IN ('UPLOAD_COMPLETE', 'PENDING_REVIEW', 'DELETED') THEN
    RAISE EXCEPTION 'new file version must await review';
  END IF;
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id AND NEW.status='PENDING_REVIEW' AND OLD.status<>'DELETED' THEN RETURN NEW; END IF;
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

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=64,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=64 WHERE singleton=true;
