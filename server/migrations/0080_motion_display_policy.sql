ALTER TABLE committees ADD COLUMN show_motions_on_demand boolean NOT NULL DEFAULT true;

-- Preserve published rules and motion history; upgrade current Beijing v11 bindings only.
INSERT INTO rule_package_versions
  (id,package_id,version,status,definition,schema_version,validation_result,published_at)
SELECT gen_random_uuid(),v.package_id,12,'PUBLISHED',
  jsonb_set(v.definition,'{motions}',(
    SELECT jsonb_agg(motion ORDER BY position)
    FROM jsonb_array_elements(v.definition->'motions') WITH ORDINALITY AS items(motion,position)
    WHERE motion->>'id' NOT IN ('suspend-debate','resume-debate')
  )),v.schema_version,v.validation_result,now()
FROM rule_package_versions v JOIN rule_packages p ON p.id=v.package_id
WHERE p.scope='BUILTIN' AND p.stable_key='builtin:beijing-academic'
  AND v.version=11 AND v.status='PUBLISHED'
ON CONFLICT (package_id,version) DO NOTHING;

DO $$
DECLARE
  target record;
  event_sequence bigint;
  next_revision integer;
BEGIN
  FOR target IN
    SELECT c.id,c.active_rule_package_version_id AS previous_version_id,new.id AS version_id
    FROM committees c
    JOIN rule_package_versions old ON old.id=c.active_rule_package_version_id
    JOIN rule_packages p ON p.id=old.package_id
    JOIN rule_package_versions new ON new.package_id=p.id AND new.version=12 AND new.status='PUBLISHED'
    WHERE p.scope='BUILTIN' AND p.stable_key='builtin:beijing-academic' AND old.version=11
      AND c.status IN ('ACTIVE','PAUSED')
  LOOP
    UPDATE committees SET active_rule_package_version_id=target.version_id,revision=revision+1,
      next_event_sequence=next_event_sequence+1,updated_at=now()
    WHERE id=target.id RETURNING revision,next_event_sequence-1 INTO next_revision,event_sequence;

    UPDATE meeting_sessions SET active_rule_package_version_id=target.version_id,revision=revision+1
    WHERE committee_id=target.id AND active_rule_package_version_id=target.previous_version_id
      AND status IN ('OPEN','PENDING');

    INSERT INTO committee_events
      (committee_id,sequence,event_type,resource_type,resource_id,resource_revision,payload,audience)
    VALUES (target.id,event_sequence,'rule_package.activated','rule_package_version',target.version_id,
      next_revision,jsonb_build_object('versionId',target.version_id,'migrationBackfill',true),'PUBLIC');

    INSERT INTO audit_log
      (id,request_id,committee_id,actor_user_id,effective_capabilities,action,resource_type,
       resource_id,result,before_summary,after_summary)
    VALUES (gen_random_uuid(),'migration:0080',target.id,NULL,'{}','migration.motion_display_rules_upgraded',
      'rule_package_version',target.version_id,'SUCCEEDED',
      jsonb_build_object('versionId',target.previous_version_id),
      jsonb_build_object('versionId',target.version_id,'revision',next_revision));
  END LOOP;
END
$$;

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=80,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=80 WHERE singleton=true;
