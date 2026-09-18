-- Old names cannot reveal whether their author intended automatic or custom text.
-- Rebuild development committee data explicitly before this breaking upgrade.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM committees) THEN
    RAISE EXCEPTION 'COMMITTEE_CONTENT_REBUILD_REQUIRED: remove old committee business data before schema 56; accounts and system configuration may be retained';
  END IF;
END $$;

ALTER TABLE committees
  ADD COLUMN committee_language text NOT NULL CHECK (committee_language IN ('zh-CN','en')),
  ADD COLUMN content_snapshot jsonb NOT NULL;

CREATE FUNCTION validate_committee_content_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb; source jsonb;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.committee_language IS DISTINCT FROM OLD.committee_language
      OR NEW.content_snapshot IS DISTINCT FROM OLD.content_snapshot THEN
      RAISE EXCEPTION 'committee language and content snapshot are immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  source := NEW.content_snapshot;
  IF jsonb_typeof(source) IS DISTINCT FROM 'object'
    OR (source->>'schemaVersion') IS DISTINCT FROM '1'
    OR jsonb_typeof(source->'countryTemplate'->'countries') IS DISTINCT FROM 'array'
    OR (source->>'initialRulePackageVersionId') IS DISTINCT FROM NEW.active_rule_package_version_id::text
    OR NOT (source ? 'committeeTemplate')
    OR (source->'committeeTemplate' <> 'null'::jsonb
      AND jsonb_typeof(source->'committeeTemplate'->'members') IS DISTINCT FROM 'array') THEN
    RAISE EXCEPTION 'invalid committee content snapshot' USING ERRCODE='23514';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(source->'countryTemplate'->'countries')
    UNION ALL SELECT value FROM jsonb_array_elements(coalesce(source->'committeeTemplate'->'members','[]'::jsonb))
  LOOP
    IF nullif(btrim(item->>'stableKey'),'') IS NULL
      OR nullif(btrim(item->'names'->>NEW.committee_language),'') IS NULL
      OR jsonb_typeof(item->'flag') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'incomplete fixed member definition' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF EXISTS (SELECT value->>'stableKey' FROM jsonb_array_elements(source->'countryTemplate'->'countries')
    GROUP BY value->>'stableKey' HAVING count(*)>1)
    OR EXISTS (SELECT value->>'stableKey' FROM jsonb_array_elements(coalesce(source->'committeeTemplate'->'members','[]'::jsonb))
    GROUP BY value->>'stableKey' HAVING count(*)>1) THEN
    RAISE EXCEPTION 'duplicate fixed member identity' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER committees_content_snapshot_guard BEFORE INSERT OR UPDATE ON committees
  FOR EACH ROW EXECUTE FUNCTION validate_committee_content_snapshot();

CREATE FUNCTION validate_fixed_seat_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source jsonb; language text; definition jsonb;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (NEW.committee_id,NEW.stable_key,NEW.display_name,NEW.flag_type,NEW.flag_value)
      IS DISTINCT FROM (OLD.committee_id,OLD.stable_key,OLD.display_name,OLD.flag_type,OLD.flag_value) THEN
      RAISE EXCEPTION 'seat identity is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT content_snapshot,committee_language INTO source,language FROM committees WHERE id=NEW.committee_id;
  SELECT value INTO definition FROM jsonb_array_elements(coalesce(source->'committeeTemplate'->'members','[]'::jsonb))
    WHERE value->>'stableKey'=NEW.stable_key;
  IF definition IS NULL THEN
    SELECT value INTO definition FROM jsonb_array_elements(source->'countryTemplate'->'countries')
      WHERE value->>'stableKey'=NEW.stable_key;
  END IF;
  IF definition IS NULL OR NEW.display_name IS DISTINCT FROM (definition->'names'->>language)
    OR NEW.flag_type::text IS DISTINCT FROM (definition->'flag'->>'type')
    OR NEW.flag_value IS DISTINCT FROM (definition->'flag'->>'value') THEN
    RAISE EXCEPTION 'seat must use a fixed committee definition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER committee_seats_fixed_identity BEFORE INSERT OR UPDATE ON committee_seats
  FOR EACH ROW EXECUTE FUNCTION validate_fixed_seat_identity();

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=56,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=56 WHERE singleton=true;
