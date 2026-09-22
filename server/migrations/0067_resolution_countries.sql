CREATE TABLE resolution_countries (
  resolution_document_id uuid NOT NULL REFERENCES resolutions(document_id),
  seat_id uuid NOT NULL REFERENCES committee_seats(id),
  role text NOT NULL CHECK (role IN ('PROPOSER','SECONDER')),
  PRIMARY KEY (resolution_document_id,seat_id)
);
INSERT INTO resolution_countries (resolution_document_id,seat_id,role)
  SELECT document_id,proposer_seat_id,'PROPOSER' FROM resolutions WHERE proposer_seat_id IS NOT NULL;
INSERT INTO resolution_countries (resolution_document_id,seat_id,role)
  SELECT document_id,seconder_seat_id,'SECONDER' FROM resolutions WHERE seconder_seat_id IS NOT NULL
  ON CONFLICT DO NOTHING;
ALTER TABLE resolutions DROP COLUMN proposer_seat_id, DROP COLUMN seconder_seat_id;
UPDATE quorum_meta.runtime_metadata SET schema_compatibility=67,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=67 WHERE singleton=true;
