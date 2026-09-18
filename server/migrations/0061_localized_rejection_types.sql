-- Development cutover: old rejection settings are replaced explicitly, never inferred from strings.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM committees) THEN
    RAISE EXCEPTION 'COMMITTEE_CONTENT_REBUILD_REQUIRED: remove old committees before schema 61';
  END IF;
END $$;
ALTER TABLE system_settings ALTER COLUMN default_file_rejection_types SET DEFAULT '[{"id": "format", "label": {"zh-CN": "内容格式不合要求", "en": "Content format does not meet requirements"}, "message": {"zh-CN": "文件内容格式不合要求，请参阅《学术指引》修改后重新提交。", "en": "The content format does not meet requirements. Please revise it according to the Academic Guide and resubmit."}, "custom": false}, {"id": "duplicate", "label": {"zh-CN": "重复提交", "en": "Duplicate submission"}, "message": {"zh-CN": "此文件已被提交过，请勿重复提交", "en": "This file has already been submitted. Please do not submit it again."}, "custom": false}, {"id": "other", "label": {"zh-CN": "其他", "en": "Other"}, "message": {}, "custom": true}]'::jsonb;
UPDATE system_settings SET default_file_rejection_types='[{"id": "format", "label": {"zh-CN": "内容格式不合要求", "en": "Content format does not meet requirements"}, "message": {"zh-CN": "文件内容格式不合要求，请参阅《学术指引》修改后重新提交。", "en": "The content format does not meet requirements. Please revise it according to the Academic Guide and resubmit."}, "custom": false}, {"id": "duplicate", "label": {"zh-CN": "重复提交", "en": "Duplicate submission"}, "message": {"zh-CN": "此文件已被提交过，请勿重复提交", "en": "This file has already been submitted. Please do not submit it again."}, "custom": false}, {"id": "other", "label": {"zh-CN": "其他", "en": "Other"}, "message": {}, "custom": true}]'::jsonb,
  file_rejection_revision=file_rejection_revision+1 WHERE singleton=true;
ALTER TABLE committees ALTER COLUMN delegate_file_settings SET DEFAULT '{"rejectionTypes": [], "allowedExtensions": {"WORKING_PAPER": ["docx","doc","pdf","odt","rtf","txt","md","xlsx","xls","ods","csv","pptx","ppt","odp"], "DIRECTIVE_DRAFT": ["docx","doc","pdf","odt","rtf","txt","md","xlsx","xls","ods","csv","pptx","ppt","odp"], "RESOLUTION_DRAFT": ["docx","doc","pdf","odt","rtf","txt","md","xlsx","xls","ods","csv","pptx","ppt","odp"]}}'::jsonb;
UPDATE quorum_meta.runtime_metadata SET schema_compatibility=61,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=61 WHERE singleton=true;
