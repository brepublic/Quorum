ALTER TABLE file_blobs ADD COLUMN admin_cleared_at timestamptz;
CREATE TABLE server_volume_cleanup_batches (
  id uuid PRIMARY KEY,
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  scope text NOT NULL CHECK (scope IN ('ALL','ARCHIVED','SELECTED')),
  status text NOT NULL DEFAULT 'PREVIEW' CHECK (status IN ('PREVIEW','RUNNING','COMPLETED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  completed_at timestamptz
);
CREATE TABLE server_volume_cleanup_items (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES server_volume_cleanup_batches(id),
  storage_key text NOT NULL,
  blob_id uuid,
  committee_id uuid REFERENCES committees(id) ON DELETE CASCADE,
  file_snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RETRY','COMPLETED')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  failure_code text,
  completed_at timestamptz,
  UNIQUE (batch_id, storage_key)
);
CREATE INDEX server_volume_cleanup_pending ON server_volume_cleanup_items(next_attempt_at) WHERE status<>'COMPLETED';
UPDATE quorum_meta.runtime_metadata SET schema_compatibility=91,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=91 WHERE singleton=true;
