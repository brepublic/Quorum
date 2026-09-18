DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM speaker_lists) THEN
    RAISE EXCEPTION 'COMMITTEE_CONTENT_REBUILD_REQUIRED: remove old speaker lists before schema 60';
  END IF;
END $$;
ALTER TABLE speaker_lists DROP COLUMN name,
  ADD COLUMN custom_title text CHECK (custom_title IS NULL OR length(btrim(custom_title)) BETWEEN 1 AND 200);
UPDATE quorum_meta.runtime_metadata SET schema_compatibility=60,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=60 WHERE singleton=true;
