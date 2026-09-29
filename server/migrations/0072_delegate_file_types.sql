ALTER TABLE delegate_file_upload_contexts ALTER COLUMN file_type TYPE text USING file_type::text;
ALTER TABLE delegate_file_metadata ALTER COLUMN file_type TYPE text USING file_type::text;

ALTER TABLE delegate_file_upload_contexts ADD CONSTRAINT delegate_upload_file_type_valid
  CHECK (file_type IN ('WORKING_PAPER', 'DIRECTIVE_DRAFT', 'RESOLUTION_DRAFT', 'NEWS', 'CRISIS_NOTICE', 'INSTANT_MESSAGE')
    OR (file_type LIKE 'CUSTOM:%' AND length(file_type) BETWEEN 8 AND 107 AND length(btrim(substring(file_type FROM 8))) > 0));
ALTER TABLE delegate_file_metadata ADD CONSTRAINT delegate_metadata_file_type_valid
  CHECK (file_type IS NULL OR file_type IN ('WORKING_PAPER', 'DIRECTIVE_DRAFT', 'RESOLUTION_DRAFT', 'NEWS', 'CRISIS_NOTICE', 'INSTANT_MESSAGE')
    OR (file_type LIKE 'CUSTOM:%' AND length(file_type) BETWEEN 8 AND 107 AND length(btrim(substring(file_type FROM 8))) > 0));

ALTER TABLE committees ALTER COLUMN delegate_file_settings SET DEFAULT
  jsonb_set(jsonb_set(jsonb_set(jsonb_set(
    '{"rejectionTypes": [], "allowedExtensions": {"WORKING_PAPER": ["docx","doc","pdf","odt","rtf","txt","md","xlsx","xls","ods","csv","pptx","ppt","odp"], "DIRECTIVE_DRAFT": ["docx","doc","pdf","odt","rtf","txt","md","xlsx","xls","ods","csv","pptx","ppt","odp"], "RESOLUTION_DRAFT": ["docx","doc","pdf","odt","rtf","txt","md","xlsx","xls","ods","csv","pptx","ppt","odp"]}}'::jsonb,
    '{allowedExtensions,NEWS}', '["docx","doc","pdf","odt","rtf","txt","md","xlsx","xls","ods","csv","pptx","ppt","odp"]'::jsonb),
    '{allowedExtensions,CRISIS_NOTICE}', '["docx","doc","pdf","odt","rtf","txt","md","xlsx","xls","ods","csv","pptx","ppt","odp"]'::jsonb),
    '{allowedExtensions,INSTANT_MESSAGE}', '["docx","doc","pdf","odt","rtf","txt","md","xlsx","xls","ods","csv","pptx","ppt","odp"]'::jsonb),
    '{allowedExtensions,OTHER}', '["docx","doc","pdf","odt","rtf","txt","md","xlsx","xls","ods","csv","pptx","ppt","odp"]'::jsonb);

UPDATE committees SET delegate_file_settings = jsonb_set(jsonb_set(jsonb_set(jsonb_set(
  delegate_file_settings,
  '{allowedExtensions,NEWS}', COALESCE(delegate_file_settings #> '{allowedExtensions,NEWS}', delegate_file_settings #> '{allowedExtensions,WORKING_PAPER}')),
  '{allowedExtensions,CRISIS_NOTICE}', COALESCE(delegate_file_settings #> '{allowedExtensions,CRISIS_NOTICE}', delegate_file_settings #> '{allowedExtensions,WORKING_PAPER}')),
  '{allowedExtensions,INSTANT_MESSAGE}', COALESCE(delegate_file_settings #> '{allowedExtensions,INSTANT_MESSAGE}', delegate_file_settings #> '{allowedExtensions,WORKING_PAPER}')),
  '{allowedExtensions,OTHER}', COALESCE(delegate_file_settings #> '{allowedExtensions,OTHER}', delegate_file_settings #> '{allowedExtensions,WORKING_PAPER}'));

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=72,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=72 WHERE singleton=true;
