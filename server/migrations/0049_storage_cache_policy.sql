CREATE TYPE storage_cache_state AS ENUM
  ('REVIEW_PINNED','READY','MISSING','FETCHING','EVICTING','FAILED');

ALTER TYPE storage_agent_task_type ADD VALUE IF NOT EXISTS 'FETCH_BLOB_TO_CACHE';

ALTER TABLE system_settings
  ADD COLUMN published_cache_max_bytes bigint NOT NULL DEFAULT 10737418240 CHECK (published_cache_max_bytes >= 0),
  ADD COLUMN pending_review_max_bytes bigint NOT NULL DEFAULT 5368709120 CHECK (pending_review_max_bytes >= 0),
  ADD COLUMN pending_review_committee_max_bytes bigint NOT NULL DEFAULT 1073741824 CHECK (pending_review_committee_max_bytes >= 0),
  ADD COLUMN storage_min_free_bytes bigint NOT NULL DEFAULT 10737418240 CHECK (storage_min_free_bytes >= 0),
  ADD COLUMN storage_min_free_percent integer NOT NULL DEFAULT 20 CHECK (storage_min_free_percent BETWEEN 0 AND 100),
  ADD COLUMN storage_cache_config_revision integer NOT NULL DEFAULT 1 CHECK (storage_cache_config_revision > 0),
  ADD CONSTRAINT pending_review_committee_within_global
    CHECK (pending_review_committee_max_bytes <= pending_review_max_bytes);

ALTER TABLE storage_hosts
  ADD COLUMN agent_protocol_version integer CHECK (agent_protocol_version IS NULL OR agent_protocol_version > 0),
  ADD COLUMN capabilities text[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT storage_host_capabilities_known CHECK (
    capabilities <@ ARRAY['SSE_WAKE','CACHE_REFILL']::text[]
  );

CREATE TABLE storage_cache_entries (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  file_entry_id uuid NOT NULL,
  file_version_id uuid NOT NULL UNIQUE REFERENCES file_versions(id),
  blob_id uuid NOT NULL UNIQUE REFERENCES file_blobs(id),
  state storage_cache_state NOT NULL,
  storage_key text UNIQUE CHECK (
    storage_key IS NULL OR (
      length(storage_key) BETWEEN 1 AND 512
      AND storage_key ~ '^cache/[a-f0-9]{2}/[a-f0-9-]{36}$'
    )
  ),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  cached_at timestamptz,
  last_accessed_at timestamptz,
  state_changed_at timestamptz NOT NULL DEFAULT now(),
  failure_code text CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (committee_id,file_entry_id) REFERENCES file_entries(committee_id,id),
  CHECK (
    (state IN ('REVIEW_PINNED','READY','EVICTING') AND storage_key IS NOT NULL AND cached_at IS NOT NULL AND failure_code IS NULL)
    OR (state IN ('MISSING','FETCHING') AND storage_key IS NULL AND cached_at IS NULL AND failure_code IS NULL)
    OR (state='FAILED' AND storage_key IS NULL AND cached_at IS NULL AND failure_code IS NOT NULL)
  )
);

CREATE INDEX storage_cache_entries_lru
  ON storage_cache_entries (last_accessed_at ASC NULLS FIRST,cached_at ASC,id ASC)
  WHERE state='READY';
CREATE INDEX storage_cache_entries_pending
  ON storage_cache_entries (committee_id,created_at,id) WHERE state='REVIEW_PINNED';
CREATE INDEX storage_cache_entries_state ON storage_cache_entries (state,committee_id,id);

CREATE UNIQUE INDEX storage_agent_tasks_one_active_cache_fetch
  ON storage_agent_tasks (host_id,lease_generation,blob_id,task_type)
  WHERE blob_id IS NOT NULL AND status IN ('PENDING','IN_PROGRESS','RETRY');

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=49,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=49 WHERE singleton=true;
