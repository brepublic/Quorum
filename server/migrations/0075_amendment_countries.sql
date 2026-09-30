CREATE TABLE amendment_countries (
  amendment_document_id uuid NOT NULL REFERENCES amendments(document_id),
  seat_id uuid NOT NULL REFERENCES committee_seats(id),
  role text NOT NULL CHECK (role IN ('PROPOSER','SECONDER')),
  PRIMARY KEY (amendment_document_id,seat_id)
);
ALTER TABLE amendments DROP COLUMN proposer_seat_id;
UPDATE quorum_meta.runtime_metadata SET schema_compatibility=75,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=75 WHERE singleton=true;
