CREATE TYPE delegate_file_share_status AS ENUM ('ACTIVE', 'ENDED');
CREATE TYPE delegate_file_type AS ENUM ('WORKING_PAPER', 'DIRECTIVE_DRAFT', 'RESOLUTION_DRAFT');
CREATE TYPE delegate_file_submission_source AS ENUM ('DELEGATE_PORTAL', 'CHAIR', 'ACCOUNT', 'LEGACY');

CREATE TABLE delegate_file_shares (
  id uuid PRIMARY KEY,
  committee_id uuid NOT NULL REFERENCES committees(id),
  capability text UNIQUE NOT NULL CHECK (capability ~ '^[A-Za-z0-9_-]{43}$'),
  status delegate_file_share_status NOT NULL DEFAULT 'ACTIVE',
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_by_user_id uuid REFERENCES users(id),
  ended_at timestamptz,
  CHECK ((status='ACTIVE' AND ended_at IS NULL AND ended_by_user_id IS NULL)
    OR (status='ENDED' AND ended_at IS NOT NULL))
);
CREATE UNIQUE INDEX delegate_file_shares_one_active
  ON delegate_file_shares (committee_id) WHERE status='ACTIVE';

CREATE TABLE delegate_file_sessions (
  id uuid PRIMARY KEY,
  share_id uuid NOT NULL REFERENCES delegate_file_shares(id),
  seat_id uuid NOT NULL REFERENCES committee_seats(id),
  seat_display_name text NOT NULL CHECK (length(seat_display_name) BETWEEN 1 AND 200),
  credential_hash bytea UNIQUE NOT NULL CHECK (octet_length(credential_hash)=32),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX delegate_file_sessions_active_share
  ON delegate_file_sessions (share_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE delegate_file_upload_contexts (
  upload_id uuid PRIMARY KEY REFERENCES file_uploads(id),
  delegate_session_id uuid NOT NULL REFERENCES delegate_file_sessions(id),
  seat_id uuid NOT NULL REFERENCES committee_seats(id),
  seat_display_name text NOT NULL CHECK (length(seat_display_name) BETWEEN 1 AND 200),
  file_type delegate_file_type NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE delegate_file_metadata (
  file_entry_id uuid PRIMARY KEY REFERENCES file_entries(id),
  submission_source delegate_file_submission_source NOT NULL,
  submitted_by_seat_id uuid REFERENCES committee_seats(id),
  submitter_display_name text CHECK (submitter_display_name IS NULL OR length(submitter_display_name) BETWEEN 1 AND 200),
  file_type delegate_file_type,
  submitted_at timestamptz,
  CHECK (submission_source='LEGACY' OR submitter_display_name IS NOT NULL)
);

CREATE FUNCTION end_delegate_file_share_when_unavailable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.operation_mode <> 'CHAIR_OPERATED'
    OR NEW.status IN ('ARCHIVED','DELETING')
    OR NEW.active_storage_binding_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM storage_bindings b WHERE b.id=NEW.active_storage_binding_id
      AND b.committee_id=NEW.id AND b.status='ACTIVE' AND b.provider_type='CHAIR_AGENT') THEN
    UPDATE delegate_file_shares SET status='ENDED',revision=revision+1,ended_at=now()
      WHERE committee_id=NEW.id AND status='ACTIVE';
    UPDATE delegate_file_sessions SET revoked_at=now()
      WHERE share_id IN (SELECT id FROM delegate_file_shares WHERE committee_id=NEW.id AND status='ENDED')
        AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER committees_end_delegate_file_share
AFTER UPDATE OF operation_mode,status,active_storage_binding_id ON committees
FOR EACH ROW EXECUTE FUNCTION end_delegate_file_share_when_unavailable();

CREATE OR REPLACE FUNCTION enforce_file_review_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id
    AND NEW.status NOT IN ('UPLOAD_COMPLETE', 'DELETED') THEN
    RAISE EXCEPTION 'new file version must return to upload complete';
  END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF OLD.status = 'UPLOAD_COMPLETE' AND NEW.status IN ('PENDING_REVIEW', 'PUBLISHED', 'DELETED') THEN RETURN NEW; END IF;
  IF OLD.status = 'PENDING_REVIEW' AND NEW.status IN ('PUBLISHED', 'DELETED') THEN RETURN NEW; END IF;
  IF OLD.status = 'PENDING_REVIEW' AND NEW.status = 'UPLOAD_COMPLETE'
    AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN RETURN NEW; END IF;
  IF OLD.status = 'PUBLISHED' AND NEW.status = 'DELETED' THEN RETURN NEW; END IF;
  IF OLD.status = 'PUBLISHED' AND NEW.status = 'UPLOAD_COMPLETE'
    AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid file review transition';
END;
$$;

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=48,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=48 WHERE singleton=true;
