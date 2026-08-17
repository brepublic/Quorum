ALTER TABLE motions
  DROP CONSTRAINT motions_check,
  ADD COLUMN destination_path text,
  ADD CONSTRAINT motions_decision_fields_match_status CHECK (
    (status IN ('PASSED','FAILED','WITHDRAWN') AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL)
    OR (status NOT IN ('PASSED','FAILED','WITHDRAWN') AND decided_by_user_id IS NULL AND decided_at IS NULL)
  ),
  ADD CONSTRAINT motions_destination_is_local CHECK (
    destination_path IS NULL OR destination_path ~ '^/committees/[0-9a-f-]{36}/'
  );

ALTER TABLE document_versions
  DROP CONSTRAINT document_versions_content_check,
  ADD CONSTRAINT document_versions_content_length CHECK (length(content) <= 200000);

UPDATE quorum_meta.runtime_metadata SET schema_compatibility = 29, updated_at = now() WHERE singleton = true;
UPDATE system_settings SET schema_compatibility = 29 WHERE singleton = true;
