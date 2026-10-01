ALTER TYPE seat_rank ADD VALUE 'MEDIA';
ALTER TABLE committee_seats ADD COLUMN can_procedural_vote boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT seat_procedural_voting CHECK (NOT can_vote OR can_procedural_vote);
ALTER TABLE committee_template_members ADD COLUMN can_procedural_vote boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT template_procedural_voting CHECK (NOT can_vote OR can_procedural_vote);

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=79,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=79 WHERE singleton=true;
