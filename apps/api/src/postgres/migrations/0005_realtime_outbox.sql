CREATE TABLE IF NOT EXISTS realtime_membership_outbox (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  auth_subject uuid NOT NULL,
  email text NOT NULL DEFAULT '',
  operation text NOT NULL CHECK (operation IN ('upsert','delete')),
  role text CHECK (role IN ('owner','editor','viewer')),
  state text NOT NULL DEFAULT 'Pending' CHECK (state IN ('Pending','Processing','Delivered','Failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  delivered_at timestamptz,
  last_error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id)
);

CREATE INDEX IF NOT EXISTS realtime_membership_outbox_pending_idx
  ON realtime_membership_outbox(state,available_at,created_at)
  WHERE state IN ('Pending','Processing');

ALTER TABLE realtime_membership_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE realtime_membership_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realtime_membership_outbox_owner_select ON realtime_membership_outbox;
CREATE POLICY realtime_membership_outbox_owner_select ON realtime_membership_outbox
  FOR SELECT USING (careeros.is_workspace_owner(workspace_id));
DROP POLICY IF EXISTS realtime_membership_outbox_no_runtime_write ON realtime_membership_outbox;
CREATE POLICY realtime_membership_outbox_no_runtime_write ON realtime_membership_outbox
  FOR ALL USING (false) WITH CHECK (false);

GRANT SELECT,INSERT,UPDATE,DELETE ON realtime_membership_outbox TO careeros_runtime;
