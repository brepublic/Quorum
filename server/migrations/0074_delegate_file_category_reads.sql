CREATE TABLE delegate_file_category_reads (
  committee_id uuid NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
  seat_id uuid NOT NULL REFERENCES committee_seats(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN (
    'WORKING_PAPER', 'DIRECTIVE_DRAFT', 'RESOLUTION_DRAFT',
    'NEWS', 'CRISIS_NOTICE', 'INSTANT_MESSAGE', 'OTHER')),
  opened_at timestamptz NOT NULL,
  PRIMARY KEY (committee_id, seat_id, category)
);

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=74,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=74 WHERE singleton=true;
