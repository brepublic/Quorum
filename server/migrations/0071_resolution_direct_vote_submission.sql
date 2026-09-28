ALTER TABLE resolutions
  ADD COLUMN direct_vote_cast_revision integer NOT NULL DEFAULT 0 CHECK (direct_vote_cast_revision >= 0),
  ADD COLUMN direct_vote_completed_at timestamptz;

UPDATE resolutions r SET direct_vote_completed_at = now()
FROM documents d
WHERE d.id = r.document_id AND r.direct_vote_started_at IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM committee_seats s JOIN current_attendance a
      ON a.seat_id = s.id AND a.meeting_session_id = d.meeting_session_id AND a.state = 'PRESENT'
    WHERE s.committee_id = d.committee_id AND s.active = true AND s.can_vote = true
  )
  AND NOT EXISTS (
    SELECT 1 FROM committee_seats s JOIN current_attendance a
      ON a.seat_id = s.id AND a.meeting_session_id = d.meeting_session_id AND a.state = 'PRESENT'
    WHERE s.committee_id = d.committee_id AND s.active = true AND s.can_vote = true
      AND NOT EXISTS (
        SELECT 1 FROM resolution_direct_votes v WHERE v.resolution_document_id = d.id
          AND v.seat_id = s.id AND v.retracted_at IS NULL
      )
  );

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=71,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=71 WHERE singleton=true;
