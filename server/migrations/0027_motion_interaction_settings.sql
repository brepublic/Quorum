ALTER TABLE committees
  ADD COLUMN delegate_motion_proposals_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN delegate_motion_voting_enabled boolean NOT NULL DEFAULT false;

UPDATE quorum_meta.runtime_metadata SET schema_compatibility = 27, updated_at = now() WHERE singleton = true;
UPDATE system_settings SET schema_compatibility = 27 WHERE singleton = true;
