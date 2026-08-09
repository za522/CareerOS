ALTER TABLE notification_deliveries
  ADD COLUMN IF NOT EXISTS provider_attempt_count integer NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_workspace_id_unique
  ON notification_deliveries(workspace_id, id);

CREATE TABLE IF NOT EXISTS notification_delivery_attempts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  delivery_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  state text NOT NULL,
  error text NOT NULL DEFAULT '',
  provider_message_id text NOT NULL DEFAULT '',
  retry_after_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(workspace_id, id),
  UNIQUE(workspace_id, delivery_id, sequence),
  FOREIGN KEY(workspace_id, delivery_id) REFERENCES notification_deliveries(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS notification_delivery_attempts_delivery_idx
  ON notification_delivery_attempts(workspace_id, delivery_id, sequence DESC);

ALTER TABLE notification_delivery_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_delivery_attempts_workspace_access ON notification_delivery_attempts;
CREATE POLICY notification_delivery_attempts_workspace_access ON notification_delivery_attempts
  USING (workspace_id = current_setting('careeros.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('careeros.workspace_id', true));

GRANT SELECT, INSERT ON notification_delivery_attempts TO careeros_runtime;

DROP TRIGGER IF EXISTS notification_delivery_attempts_immutable ON notification_delivery_attempts;
CREATE TRIGGER notification_delivery_attempts_immutable
  BEFORE UPDATE OR DELETE ON notification_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION careeros.reject_mutation();
