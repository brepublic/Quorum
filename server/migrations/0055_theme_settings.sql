ALTER TABLE system_settings
  ADD COLUMN themes_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN theme_settings_revision integer NOT NULL DEFAULT 1 CHECK (theme_settings_revision > 0);

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=55,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=55 WHERE singleton=true;
