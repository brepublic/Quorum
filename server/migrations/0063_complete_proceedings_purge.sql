-- Preserve append-only history except within the existing claimed committee purge.
CREATE OR REPLACE FUNCTION prevent_motion_direct_vote_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND quorum_meta.committee_purge_allowed(OLD.committee_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'motion direct vote history is append-only';
END;
$$;

CREATE OR REPLACE FUNCTION prevent_legacy_document_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND quorum_meta.committee_purge_allowed(OLD.committee_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'legacy document history is append-only';
END;
$$;

-- SCHEMA_VERSION
UPDATE quorum_meta.runtime_metadata SET schema_compatibility=63,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=63 WHERE singleton=true;
