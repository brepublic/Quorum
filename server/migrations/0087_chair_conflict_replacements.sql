-- A published local replacement is attributable to exactly one explicit Chair decision.
ALTER TABLE file_versions ADD COLUMN resolution_conflict_id uuid REFERENCES storage_agent_conflicts(id);
CREATE UNIQUE INDEX file_versions_resolution_conflict_unique ON file_versions(resolution_conflict_id)
  WHERE resolution_conflict_id IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_file_review_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.formal_name IS NOT NULL AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id AND NEW.status<>'DELETED' THEN
    IF NEW.status=OLD.status AND NEW.logical_name=OLD.logical_name AND NEW.revision=OLD.revision+1
      AND EXISTS (SELECT 1 FROM file_versions v
        JOIN storage_agent_conflicts conflict ON conflict.id=v.resolution_conflict_id
        JOIN storage_agent_conflict_applications application ON application.conflict_id=conflict.id
        JOIN storage_agent_change_requests change ON change.request_id=application.request_id
          AND change.host_id=conflict.host_id AND change.committee_id=conflict.committee_id
        JOIN storage_agent_tasks task ON task.id=change.task_id
        JOIN storage_hosts host ON host.id=conflict.host_id
        JOIN committees committee ON committee.id=conflict.committee_id
        WHERE v.id=NEW.current_version_id AND v.file_entry_id=NEW.id AND v.committee_id=NEW.committee_id
          AND conflict.file_entry_id=NEW.id AND conflict.status='RESOLVED' AND conflict.resolution_action='ACCEPT_LOCAL'
          AND conflict.resolution_file_revision=OLD.revision AND conflict.resolution_lease_generation=committee.storage_lease_generation
          AND host.status IN ('ACTIVE','DEGRADED') AND host.lease_generation=conflict.resolution_lease_generation
          AND change.kind='UPSERT' AND change.status='PENDING_CONTENT' AND change.file_entry_id=NEW.id
          AND change.lease_generation=conflict.resolution_lease_generation
          AND task.host_id=host.id AND task.lease_generation=host.lease_generation
          AND task.file_entry_id=NEW.id AND task.file_revision=NEW.revision
          AND task.source_upload_id=change.upload_id AND task.blob_id=v.blob_id
          AND task.expected_sha256=v.sha256 AND task.expected_size_bytes=v.size_bytes
          AND change.sha256=v.sha256 AND change.size_bytes=v.size_bytes) THEN RETURN NEW;
    END IF;
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


CREATE OR REPLACE FUNCTION append_storage_manifest_file_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry file_entries%ROWTYPE; allocated_sequence bigint;
BEGIN
  IF NEW.source_file_entry_id IS NOT NULL OR NEW.resolution_conflict_id IS NOT NULL THEN RETURN NEW; END IF;
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
UPDATE quorum_meta.runtime_metadata SET schema_compatibility=87,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=87 WHERE singleton=true;
