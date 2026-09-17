-- Only live configuration changes; audit and formal ballot snapshots remain immutable.
UPDATE committee_seats SET rank='STANDARD' WHERE rank='VETO';
UPDATE committee_template_members SET rank='STANDARD' WHERE rank='VETO';
ALTER TABLE committee_seats ALTER COLUMN rank DROP DEFAULT;
ALTER TYPE seat_rank RENAME TO seat_rank_old;
CREATE TYPE seat_rank AS ENUM ('STANDARD', 'NGO', 'OBSERVER');
ALTER TABLE committee_seats ALTER COLUMN rank TYPE seat_rank USING rank::text::seat_rank;
ALTER TABLE committee_template_members ALTER COLUMN rank TYPE seat_rank USING rank::text::seat_rank;
ALTER TABLE committee_seats ALTER COLUMN rank SET DEFAULT 'STANDARD';
DROP TYPE seat_rank_old;
-- Existing editors could leave dependent flags set after disabling voting.
UPDATE committee_seats SET can_vote=true WHERE has_veto AND NOT can_vote;
UPDATE committee_template_members SET can_vote=true WHERE has_veto AND NOT can_vote;
UPDATE committee_seats SET must_vote=false WHERE NOT can_vote;
UPDATE committee_template_members SET must_vote=false WHERE NOT can_vote;
ALTER TABLE committee_seats ADD CONSTRAINT seat_voting_capabilities CHECK (can_vote OR (NOT has_veto AND NOT must_vote));
ALTER TABLE committee_template_members ADD CONSTRAINT template_voting_capabilities CHECK (can_vote OR (NOT has_veto AND NOT must_vote));
UPDATE quorum_meta.runtime_metadata SET schema_compatibility=54,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=54 WHERE singleton=true;
