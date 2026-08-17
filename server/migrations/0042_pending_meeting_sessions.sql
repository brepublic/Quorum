DO $$
DECLARE
  status_constraint text;
BEGIN
  SELECT conname INTO status_constraint
  FROM pg_constraint
  WHERE conrelid = 'meeting_sessions'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%closed_at%';

  IF status_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE meeting_sessions DROP CONSTRAINT %I', status_constraint);
  END IF;
END $$;

ALTER TABLE meeting_sessions
  ADD CONSTRAINT meeting_sessions_status_closed_at CHECK (
    (status = 'PENDING' AND closed_at IS NULL)
    OR (status = 'OPEN' AND closed_at IS NULL)
    OR (status = 'CLOSED' AND closed_at IS NOT NULL)
  );
