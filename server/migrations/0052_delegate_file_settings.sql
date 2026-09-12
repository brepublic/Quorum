ALTER TABLE system_settings
  ADD COLUMN default_file_rejection_types jsonb NOT NULL DEFAULT '[{"id": "format", "label": "内容格式不合要求", "message": "文件内容格式不合要求，请参阅《学术指引》修改后重新提交。", "custom": false}, {"id": "duplicate", "label": "重复提交", "message": "此文件已被提交过，请勿重复提交", "custom": false}, {"id": "other", "label": "其他", "message": "", "custom": true}]'::jsonb,
  ADD COLUMN file_rejection_revision integer NOT NULL DEFAULT 1 CHECK (file_rejection_revision > 0);
ALTER TABLE committees
  ADD COLUMN delegate_file_settings jsonb NOT NULL DEFAULT '{"rejectionTypes": [{"id": "format", "label": "内容格式不合要求", "message": "文件内容格式不合要求，请参阅《学术指引》修改后重新提交。", "custom": false}, {"id": "duplicate", "label": "重复提交", "message": "此文件已被提交过，请勿重复提交", "custom": false}, {"id": "other", "label": "其他", "message": "", "custom": true}], "allowedExtensions": {"WORKING_PAPER": ["docx", "doc", "pdf", "odt", "rtf", "txt", "md", "xlsx", "xls", "ods", "csv", "pptx", "ppt", "odp"], "DIRECTIVE_DRAFT": ["docx", "doc", "pdf", "odt", "rtf", "txt", "md", "xlsx", "xls", "ods", "csv", "pptx", "ppt", "odp"], "RESOLUTION_DRAFT": ["docx", "doc", "pdf", "odt", "rtf", "txt", "md", "xlsx", "xls", "ods", "csv", "pptx", "ppt", "odp"]}}'::jsonb,
  ADD COLUMN delegate_file_settings_revision integer NOT NULL DEFAULT 1 CHECK (delegate_file_settings_revision > 0);
UPDATE quorum_meta.runtime_metadata SET schema_compatibility=52,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=52 WHERE singleton=true;
