CREATE TABLE quorum_meta.runtime_metadata (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  schema_compatibility integer NOT NULL CHECK (schema_compatibility > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO quorum_meta.runtime_metadata (singleton, schema_compatibility)
VALUES (true, 1);
