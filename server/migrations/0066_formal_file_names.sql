-- Formal names are exact, case-sensitive, trimmed business identifiers. Pending names do not reserve them.
ALTER TABLE file_entries ADD COLUMN formal_name text COLLATE "C";
ALTER TABLE file_entries ADD COLUMN merged_into_file_entry_id uuid;
ALTER TABLE file_entries ADD CONSTRAINT file_merge_target_fk FOREIGN KEY (committee_id,merged_into_file_entry_id)
  REFERENCES file_entries(committee_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE file_entries ADD CONSTRAINT file_merge_not_self CHECK (merged_into_file_entry_id IS NULL OR merged_into_file_entry_id<>id);
ALTER TABLE file_versions ADD COLUMN source_file_entry_id uuid;
ALTER TABLE file_versions ADD CONSTRAINT file_version_source_fk FOREIGN KEY (committee_id,source_file_entry_id)
  REFERENCES file_entries(committee_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE delegate_file_metadata ADD COLUMN approved_at timestamptz;
ALTER TABLE delegate_file_metadata ADD COLUMN approved_by_user_id uuid REFERENCES users(id);
ALTER TABLE delegate_file_metadata ADD COLUMN approved_name text;

-- Match JavaScript trim(), without case folding, Unicode normalization or internal-space changes.
CREATE FUNCTION formal_file_name(value text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT btrim(value, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
$$;
DO $$ DECLARE conflicts jsonb; BEGIN
  SELECT jsonb_agg(row_to_json(c)) INTO conflicts FROM (
    SELECT e.committee_id,formal_file_name(e.logical_name) COLLATE "C" AS name,array_agg(e.id) AS files,
      (SELECT jsonb_agg(jsonb_build_object('documentId',v.document_id,'fileId',v.content_file_entry_id))
        FROM document_versions v WHERE v.content_file_entry_id=ANY(array_agg(e.id))) AS references
    FROM file_entries e WHERE e.status<>'DELETED' AND e.published_at IS NOT NULL
    GROUP BY e.committee_id,formal_file_name(e.logical_name) COLLATE "C" HAVING count(*)>1
  ) c;
  IF conflicts IS NOT NULL THEN RAISE EXCEPTION 'Formal file name conflicts require review: %',conflicts; END IF;
END $$;
UPDATE file_entries SET formal_name=formal_file_name(logical_name),logical_name=formal_file_name(logical_name)
 WHERE status<>'DELETED' AND published_at IS NOT NULL;
UPDATE delegate_file_metadata m SET approved_at=e.published_at,approved_by_user_id=e.published_by_user_id,
 approved_name=e.logical_name FROM file_entries e WHERE e.id=m.file_entry_id AND e.published_at IS NOT NULL;
CREATE UNIQUE INDEX file_entries_formal_name_unique ON file_entries(committee_id,formal_name)
 WHERE status<>'DELETED' AND formal_name IS NOT NULL;

CREATE FUNCTION enforce_formal_file_name() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='UPDATE' AND OLD.formal_name IS NOT NULL AND NEW.logical_name IS DISTINCT FROM OLD.logical_name THEN
    RAISE EXCEPTION 'Formal files must be updated through review';
  END IF;
  IF NEW.merged_into_file_entry_id IS NOT NULL THEN NEW.formal_name=NULL;
  ELSIF NEW.status='PUBLISHED' THEN NEW.logical_name=formal_file_name(NEW.logical_name); NEW.formal_name=NEW.logical_name;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER file_entries_formal_name BEFORE INSERT OR UPDATE ON file_entries
 FOR EACH ROW EXECUTE FUNCTION enforce_formal_file_name();

CREATE OR REPLACE FUNCTION enforce_file_review_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.formal_name IS NOT NULL AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id AND NEW.status<>'DELETED' THEN
    IF NEW.status<>'PUBLISHED' OR NOT EXISTS (SELECT 1 FROM file_versions v JOIN file_entries source
      ON source.id=v.source_file_entry_id WHERE v.id=NEW.current_version_id AND v.file_entry_id=NEW.id
      AND source.merged_into_file_entry_id=NEW.id AND source.status='PUBLISHED') THEN
      RAISE EXCEPTION 'Formal files must be replaced through confirmed review';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id
    AND NEW.status NOT IN ('UPLOAD_COMPLETE','PENDING_REVIEW','DELETED') THEN RAISE EXCEPTION 'new file version must await review'; END IF;
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id AND NEW.status='PENDING_REVIEW' AND OLD.status<>'DELETED' THEN RETURN NEW; END IF;
  IF NEW.status=OLD.status THEN RETURN NEW; END IF;
  IF OLD.status IN ('UPLOAD_COMPLETE','PENDING_REVIEW') AND NEW.status IN ('PENDING_REVIEW','PUBLISHED','REJECTED','DELETED') THEN RETURN NEW; END IF;
  IF OLD.status IN ('PENDING_REVIEW','PUBLISHED') AND NEW.status='UPLOAD_COMPLETE' AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN RETURN NEW; END IF;
  IF OLD.status IN ('REJECTED','PUBLISHED') AND NEW.status='DELETED' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid file review transition';
END $$;

-- Web submissions need distinct local paths even when their original names are identical.
-- Existing uploads retain their old path; this does not rename already paired folders.
ALTER TABLE file_uploads ADD COLUMN agent_relative_path text;
CREATE FUNCTION file_agent_path(file_id uuid, fallback_name text) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT u.agent_relative_path FROM storage_agent_tasks task JOIN file_uploads u ON u.id=task.source_upload_id
   WHERE task.file_entry_id=file_id AND u.agent_relative_path IS NOT NULL ORDER BY task.created_at DESC LIMIT 1),fallback_name);
$$;

-- Review replacements emit their manifest after the target revision has been updated.
CREATE OR REPLACE FUNCTION append_storage_manifest_file_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry file_entries%ROWTYPE; allocated_sequence bigint;
BEGIN
  IF NEW.source_file_entry_id IS NOT NULL THEN RETURN NEW; END IF;
  SELECT * INTO entry FROM file_entries WHERE id=NEW.file_entry_id AND committee_id=NEW.committee_id;
  IF entry.id IS NULL THEN RAISE EXCEPTION 'manifest file entry is unavailable'; END IF;
  UPDATE committees SET next_storage_manifest_sequence=next_storage_manifest_sequence+1 WHERE id=NEW.committee_id
    RETURNING next_storage_manifest_sequence-1 INTO allocated_sequence;
  INSERT INTO storage_manifest_events (committee_id,sequence,kind,file_entry_id,file_revision,version_id,blob_id,
    logical_name,original_name,media_type,size_bytes,sha256,created_at)
  VALUES (NEW.committee_id,allocated_sequence,'UPSERT',NEW.file_entry_id,entry.revision,NEW.id,NEW.blob_id,
    file_agent_path(entry.id,entry.logical_name),NEW.original_name,NEW.media_type,NEW.size_bytes,NEW.sha256,NEW.created_at);
  RETURN NEW;
END $$;
UPDATE quorum_meta.runtime_metadata SET schema_compatibility=66,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=66 WHERE singleton=true;

ALTER TABLE storage_agent_conflicts DROP CONSTRAINT storage_agent_conflicts_reason_code_check;
ALTER TABLE storage_agent_conflicts ADD CHECK (reason_code IN
  ('MANIFEST_STALE','FILE_DELETED','REVISION_CONFLICT','NAME_CONFLICT','HOST_TRANSFERRED','REVIEW_REQUIRED'));
