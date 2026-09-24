CREATE TABLE manual_country_search_terms (
  owner_user_id uuid NOT NULL REFERENCES users(id),
  country_template_key text NOT NULL,
  country_stable_key text NOT NULL,
  term text NOT NULL CHECK (length(term) BETWEEN 1 AND 64),
  normalized_term text NOT NULL,
  PRIMARY KEY (owner_user_id, country_template_key, country_stable_key, normalized_term)
);

CREATE TABLE search_index_generations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  algorithm_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz
);

CREATE TABLE generated_search_terms (
  generation_id bigint NOT NULL REFERENCES search_index_generations(id) ON DELETE CASCADE,
  subject_kind text NOT NULL,
  subject_key text NOT NULL,
  source_hash text NOT NULL,
  terms jsonb NOT NULL CHECK (jsonb_typeof(terms) = 'array'),
  PRIMARY KEY (generation_id, subject_kind, subject_key)
);

CREATE TABLE search_index_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  active_generation_id bigint REFERENCES search_index_generations(id),
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO search_index_state(singleton) VALUES (true);

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=70,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=70 WHERE singleton=true;
