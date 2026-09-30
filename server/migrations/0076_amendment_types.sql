ALTER TABLE amendments ADD COLUMN amendment_type text NOT NULL DEFAULT 'UNFRIENDLY'
  CHECK (amendment_type IN ('FRIENDLY','UNFRIENDLY')),
  ADD COLUMN type_ordinal integer CHECK (type_ordinal > 0);
WITH numbered AS (
  SELECT a.document_id,row_number() OVER (PARTITION BY a.resolution_document_id ORDER BY d.ordinal)::integer AS ordinal
  FROM amendments a JOIN documents d ON d.id=a.document_id
) UPDATE amendments a SET type_ordinal=n.ordinal FROM numbered n WHERE n.document_id=a.document_id;
ALTER TABLE amendments ALTER COLUMN type_ordinal SET NOT NULL;
CREATE UNIQUE INDEX amendments_type_ordinal ON amendments(resolution_document_id,amendment_type,type_ordinal);
CREATE FUNCTION allocate_amendment_type_ordinal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM 1 FROM documents WHERE id=NEW.resolution_document_id FOR UPDATE;
    IF NEW.type_ordinal IS NOT NULL THEN
      RAISE EXCEPTION 'amendment ordinal is allocated by the database' USING ERRCODE='23514';
    END IF;
    SELECT coalesce(max(type_ordinal),0)+1 INTO NEW.type_ordinal FROM amendments
      WHERE resolution_document_id=NEW.resolution_document_id AND amendment_type=NEW.amendment_type;
  ELSIF (NEW.document_id,NEW.resolution_document_id,NEW.amendment_type,NEW.type_ordinal)
    IS DISTINCT FROM (OLD.document_id,OLD.resolution_document_id,OLD.amendment_type,OLD.type_ordinal) THEN
    RAISE EXCEPTION 'amendment identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER amendments_identity_guard BEFORE INSERT OR UPDATE ON amendments
  FOR EACH ROW EXECUTE FUNCTION allocate_amendment_type_ordinal();
CREATE FUNCTION enforce_amendment_type_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subtype text;
BEGIN
  IF NEW.kind='AMENDMENT' AND NEW.status IS DISTINCT FROM OLD.status THEN
    SELECT amendment_type INTO subtype FROM amendments WHERE document_id=NEW.id;
    IF subtype='FRIENDLY' AND NOT (OLD.status='DRAFT' AND NEW.status='INCORPORATED') THEN
      RAISE EXCEPTION 'friendly amendments are adopted without voting';
    END IF;
    IF subtype='UNFRIENDLY' AND NEW.status IN ('INCORPORATED','REJECTED') AND OLD.status<>'VOTING' THEN
      RAISE EXCEPTION 'unfriendly amendments require a ballot result';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER documents_amendment_type_state BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION enforce_amendment_type_state();
UPDATE quorum_meta.runtime_metadata SET schema_compatibility=76,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=76 WHERE singleton=true;
