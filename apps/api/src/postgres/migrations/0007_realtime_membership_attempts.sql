CREATE TABLE IF NOT EXISTS realtime_membership_attempts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  outbox_id text,
  user_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('upsert','delete')),
  outcome text NOT NULL CHECK (outcome IN ('Delivered','Failed','TimedOut')),
  error text NOT NULL DEFAULT '',
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS realtime_membership_attempts_member_idx
  ON realtime_membership_attempts(workspace_id,user_id,created_at DESC,id DESC);

ALTER TABLE realtime_membership_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE realtime_membership_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realtime_membership_attempts_owner_select ON realtime_membership_attempts;
CREATE POLICY realtime_membership_attempts_owner_select ON realtime_membership_attempts
  FOR SELECT USING (careeros.is_workspace_owner(workspace_id));
DROP POLICY IF EXISTS realtime_membership_attempts_no_runtime_write ON realtime_membership_attempts;
CREATE POLICY realtime_membership_attempts_no_runtime_write ON realtime_membership_attempts
  FOR ALL USING (false) WITH CHECK (false);

DROP TRIGGER IF EXISTS immutable_record ON realtime_membership_attempts;
CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON realtime_membership_attempts
  FOR EACH ROW EXECUTE FUNCTION careeros.reject_mutation();

GRANT SELECT ON realtime_membership_attempts TO careeros_runtime;
