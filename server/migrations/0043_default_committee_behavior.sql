ALTER TABLE system_settings
  ADD COLUMN default_committee_creator_is_chair boolean NOT NULL DEFAULT true,
  ADD COLUMN default_committee_operation_mode committee_operation_mode NOT NULL DEFAULT 'CHAIR_OPERATED',
  ADD COLUMN default_committee_behavior_revision integer NOT NULL DEFAULT 1 CHECK (default_committee_behavior_revision > 0),
  ADD COLUMN default_committee_behavior_updated_at timestamptz NOT NULL DEFAULT now();

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=43,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=43 WHERE singleton=true;
