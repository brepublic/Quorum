CREATE OR REPLACE FUNCTION enforce_file_version_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  blob_record file_blobs%ROWTYPE;
BEGIN
  IF EXISTS (SELECT 1 FROM file_tombstones WHERE file_entry_id = NEW.file_entry_id) THEN
    RAISE EXCEPTION 'deleted file cannot receive a new version';
  END IF;
  SELECT * INTO blob_record FROM file_blobs
    WHERE id = NEW.blob_id AND committee_id = NEW.committee_id FOR KEY SHARE;
  IF FOUND AND blob_record.durability_state <> 'COMMITTED' THEN
    SELECT replica.* INTO blob_record FROM file_blob_copies location
      JOIN committees committee ON committee.id=location.committee_id
        AND committee.active_storage_binding_id=location.storage_binding_id
      JOIN storage_bindings binding ON binding.id=location.storage_binding_id AND binding.status='ACTIVE'
      JOIN file_blobs replica ON replica.id=location.copy_blob_id
      WHERE location.content_blob_id=NEW.blob_id AND location.committee_id=NEW.committee_id
      FOR KEY SHARE OF replica;
  END IF;
  IF blob_record.id IS NULL OR blob_record.durability_state <> 'COMMITTED'
    OR blob_record.size_bytes <> NEW.size_bytes
    OR blob_record.sha256 <> NEW.sha256 THEN
    RAISE EXCEPTION 'file version blob integrity mismatch';
  END IF;
  RETURN NEW;
END;
$$;

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=88,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=88 WHERE singleton=true;
