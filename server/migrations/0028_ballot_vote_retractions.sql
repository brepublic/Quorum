ALTER TABLE ballot_votes
  ADD COLUMN retracted_at timestamptz,
  ADD COLUMN retracted_by_user_id uuid REFERENCES users(id),
  ADD CONSTRAINT ballot_votes_retraction_complete CHECK (
    (retracted_at IS NULL AND retracted_by_user_id IS NULL)
    OR (retracted_at IS NOT NULL AND retracted_by_user_id IS NOT NULL)
  );

ALTER TABLE ballot_vote_revisions
  ALTER COLUMN new_choice DROP NOT NULL,
  ADD CONSTRAINT ballot_vote_revisions_has_state CHECK (
    previous_choice IS NOT NULL OR new_choice IS NOT NULL
  );

UPDATE quorum_meta.runtime_metadata SET schema_compatibility = 28, updated_at = now() WHERE singleton = true;
UPDATE system_settings SET schema_compatibility = 28 WHERE singleton = true;
