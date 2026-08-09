BEGIN;

DO $$
DECLARE constraint_name text;
BEGIN
  SELECT candidate.conname INTO constraint_name
  FROM pg_constraint candidate
  JOIN pg_class relation ON relation.oid = candidate.conrelid
  JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relname = 'capture_queue_items'
    AND candidate.contype = 'c'
    AND pg_get_constraintdef(candidate.oid) LIKE '%progress%'
  LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE capture_queue_items DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE capture_queue_items
  DROP CONSTRAINT IF EXISTS capture_queue_items_progress_units_check;
ALTER TABLE capture_queue_items
  ADD CONSTRAINT capture_queue_items_progress_units_check
  CHECK (progress BETWEEN 0 AND 10000);

ALTER TABLE notification_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_delivery_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_delivery_attempts_workspace_access ON notification_delivery_attempts;
DROP POLICY IF EXISTS notification_delivery_attempts_workspace_read ON notification_delivery_attempts;
DROP POLICY IF EXISTS notification_delivery_attempts_workspace_insert ON notification_delivery_attempts;
CREATE POLICY notification_delivery_attempts_workspace_read ON notification_delivery_attempts
  FOR SELECT
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')
    AND careeros.can_access_workspace(workspace_id)
  );
CREATE POLICY notification_delivery_attempts_workspace_insert ON notification_delivery_attempts
  FOR INSERT
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')
    AND careeros.can_access_workspace(workspace_id, true)
  );

GRANT SELECT, INSERT ON notification_delivery_attempts TO careeros_runtime;

COMMIT;
