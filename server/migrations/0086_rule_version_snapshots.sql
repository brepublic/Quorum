-- The startup runner executes this migration in one transaction. Keep original
-- version IDs and historical rows; move published definitions out of the catalog.
LOCK TABLE rule_package_versions IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE rule_version_snapshots (
  id uuid PRIMARY KEY,
  package_id uuid NOT NULL REFERENCES rule_packages(id),
  version integer NOT NULL CHECK (version > 0),
  status rule_version_status NOT NULL CHECK (status='PUBLISHED'),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object'),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  validation_result jsonb,
  created_by_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL,
  published_at timestamptz NOT NULL,
  UNIQUE (package_id,version)
);

INSERT INTO rule_version_snapshots SELECT * FROM rule_package_versions WHERE status='PUBLISHED';

CREATE FUNCTION capture_published_rule_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO rule_version_snapshots VALUES
    (NEW.id,NEW.package_id,NEW.version,NEW.status,NEW.definition,NEW.schema_version,
     NEW.validation_result,NEW.created_by_user_id,NEW.created_at,NEW.published_at);
  RETURN NEW;
END $$;
CREATE TRIGGER rule_package_versions_snapshot
AFTER INSERT OR UPDATE ON rule_package_versions FOR EACH ROW
WHEN (NEW.status='PUBLISHED') EXECUTE FUNCTION capture_published_rule_snapshot();

CREATE FUNCTION prevent_rule_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE purge_committee_id uuid;
BEGIN
  IF TG_OP='DELETE' THEN
    SELECT committee_id INTO purge_committee_id FROM rule_packages WHERE id=OLD.package_id;
    IF purge_committee_id IS NOT NULL AND quorum_meta.committee_purge_allowed(purge_committee_id) THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION 'rule snapshots are immutable';
END $$;
CREATE TRIGGER rule_version_snapshots_immutable BEFORE UPDATE OR DELETE ON rule_version_snapshots
FOR EACH ROW EXECUTE FUNCTION prevent_rule_snapshot_mutation();

-- All existing historical references now resolve to immutable snapshots. New
-- publications are captured before any committee/proceeding can reference them.
DO $$
DECLARE reference record;
BEGIN
  FOR reference IN SELECT conrelid::regclass AS table_name,conname,pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE contype='f' AND confrelid='rule_package_versions'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',reference.table_name,reference.conname);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s',reference.table_name,reference.conname,
      replace(reference.definition,'REFERENCES rule_package_versions','REFERENCES rule_version_snapshots'));
  END LOOP;
END $$;
-- The normal committee purge removes its private rules before the committee.
ALTER TABLE committees ALTER CONSTRAINT committees_active_rule_package_version_id_fkey
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE rule_package_versions DISABLE TRIGGER rule_package_versions_published_immutable;

DO $$
DECLARE
  latest record;
  target record;
  previous_sessions jsonb;
  retired_ids jsonb;
  old_default text;
  event_sequence bigint;
  next_revision integer;
BEGIN
  FOR latest IN SELECT DISTINCT ON (p.id) p.id AS package_id,v.id,v.version
    FROM rule_packages p JOIN rule_package_versions v ON v.package_id=p.id
    WHERE p.scope='BUILTIN' AND p.stable_key='builtin:beijing-academic' AND v.status='PUBLISHED'
    ORDER BY p.id,v.version DESC
  LOOP
    FOR target IN SELECT c.id,c.active_rule_package_version_id AS previous_id
      FROM committees c JOIN rule_version_snapshots old ON old.id=c.active_rule_package_version_id
      WHERE c.status IN ('ACTIVE','PAUSED') AND old.package_id=latest.package_id
        AND (old.version<latest.version OR EXISTS (
          SELECT 1 FROM meeting_sessions s JOIN rule_version_snapshots v ON v.id=s.active_rule_package_version_id
          WHERE s.committee_id=c.id AND s.status IN ('OPEN','PENDING')
            AND v.package_id=latest.package_id AND v.version<latest.version))
      ORDER BY c.id
    LOOP
      SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'versionId',s.active_rule_package_version_id)
        ORDER BY s.id),'[]'::jsonb) INTO previous_sessions
      FROM meeting_sessions s JOIN rule_version_snapshots v ON v.id=s.active_rule_package_version_id
      WHERE s.committee_id=target.id AND s.status IN ('OPEN','PENDING')
        AND v.package_id=latest.package_id AND v.version<latest.version;
      UPDATE committees SET active_rule_package_version_id=latest.id,revision=revision+1,
        next_event_sequence=next_event_sequence+1,updated_at=now() WHERE id=target.id
        RETURNING revision,next_event_sequence-1 INTO next_revision,event_sequence;
      UPDATE meeting_sessions s SET active_rule_package_version_id=latest.id,revision=s.revision+1
      FROM rule_version_snapshots v WHERE s.committee_id=target.id AND s.status IN ('OPEN','PENDING')
        AND v.id=s.active_rule_package_version_id AND v.package_id=latest.package_id AND v.version<latest.version;
      INSERT INTO committee_events
        (committee_id,sequence,event_type,resource_type,resource_id,resource_revision,payload,audience)
      VALUES(target.id,event_sequence,'rule_package.activated','rule_package_version',latest.id,next_revision,
        jsonb_build_object('versionId',latest.id,'migrationBackfill',true,'meetingSessions',previous_sessions),'PUBLIC');
      INSERT INTO audit_log(id,request_id,committee_id,actor_user_id,effective_capabilities,action,
        resource_type,resource_id,result,before_summary,after_summary)
      VALUES(gen_random_uuid(),'migration:0086',target.id,NULL,'{}','migration.beijing_rules_upgraded',
        'rule_package_version',latest.id,'SUCCEEDED',
        jsonb_build_object('versionId',target.previous_id,'meetingSessions',previous_sessions),
        jsonb_build_object('versionId',latest.id,'revision',next_revision));
    END LOOP;

    SELECT committee_creation_defaults->>'defaultRulePackageVersionId' INTO old_default FROM system_settings;
    UPDATE system_settings SET committee_creation_defaults=jsonb_set(committee_creation_defaults,
      '{defaultRulePackageVersionId}',to_jsonb(latest.id::text)),
      default_committee_behavior_revision=default_committee_behavior_revision+1,
      default_committee_behavior_updated_at=now()
    WHERE singleton=true AND EXISTS(SELECT 1 FROM rule_version_snapshots v
      WHERE v.id::text=old_default AND v.package_id=latest.package_id AND v.version<latest.version);

    SELECT coalesce(jsonb_agg(v.id ORDER BY v.version),'[]'::jsonb) INTO retired_ids
    FROM rule_package_versions v WHERE v.package_id=latest.package_id AND v.status='PUBLISHED' AND v.version<latest.version;
    IF retired_ids<>'[]'::jsonb THEN
      -- Verify the exact content and metadata before removing catalog rows.
      -- Snapshot guards remain enabled throughout this transaction.
      IF EXISTS(SELECT 1 FROM rule_package_versions v LEFT JOIN rule_version_snapshots s ON s.id=v.id
        WHERE v.package_id=latest.package_id AND v.status='PUBLISHED' AND v.version<latest.version
          AND to_jsonb(s) IS DISTINCT FROM to_jsonb(v)) THEN
        RAISE EXCEPTION 'rule snapshot verification failed';
      END IF;
      DELETE FROM rule_package_versions v USING rule_packages p
      WHERE v.package_id=p.id AND p.id=latest.package_id AND p.scope='BUILTIN'
        AND p.stable_key='builtin:beijing-academic' AND v.status='PUBLISHED' AND v.version<latest.version;
      INSERT INTO audit_log(id,request_id,actor_user_id,effective_capabilities,action,resource_type,
        resource_id,result,before_summary,after_summary)
      VALUES(gen_random_uuid(),'migration:0086',NULL,'{}','migration.beijing_rules_snapshotted','rule_package',
        latest.package_id,'SUCCEEDED',jsonb_build_object('retiredVersionIds',retired_ids,'defaultVersionId',old_default),
        jsonb_build_object('retainedVersionId',latest.id,'historicalDefinitionsPreserved',true));
    END IF;
  END LOOP;
END $$;

ALTER TABLE rule_package_versions ENABLE TRIGGER rule_package_versions_published_immutable;

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=86,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=86 WHERE singleton=true;
