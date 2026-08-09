BEGIN;

CREATE TABLE IF NOT EXISTS telegram_integrations (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  bot_token_ciphertext text NOT NULL,
  bot_token_iv text NOT NULL,
  bot_token_tag text NOT NULL,
  chat_id_ciphertext text NOT NULL,
  chat_id_iv text NOT NULL,
  chat_id_tag text NOT NULL,
  chat_id_hint text NOT NULL DEFAULT '',
  key_fingerprint text NOT NULL,
  configured_by_user_id text NOT NULL REFERENCES workspace_users(id),
  last_tested_at timestamptz,
  last_error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

ALTER TABLE telegram_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_integrations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS telegram_integrations_owner_access ON telegram_integrations;
CREATE POLICY telegram_integrations_owner_access ON telegram_integrations
  USING (careeros.is_workspace_owner(workspace_id))
  WITH CHECK (careeros.is_workspace_owner(workspace_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON telegram_integrations TO careeros_runtime;
DROP TRIGGER IF EXISTS touch_revision ON telegram_integrations;
CREATE TRIGGER touch_revision BEFORE UPDATE ON telegram_integrations
  FOR EACH ROW EXECUTE FUNCTION careeros.touch_revision();

DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    EXECUTE 'CREATE INDEX IF NOT EXISTS discovered_postings_workspace_search_trgm_idx ON discovered_postings
      USING gin ((company_name || '' '' || title || '' '' || location || '' '' || description) gin_trgm_ops)
      WHERE deleted_at IS NULL';
  EXCEPTION WHEN feature_not_supported OR undefined_file OR insufficient_privilege THEN
    RAISE NOTICE 'pg_trgm is unavailable; continuing with structured discovery indexes';
  END;
END $$;
CREATE INDEX IF NOT EXISTS discovered_postings_workspace_filters_idx ON discovered_postings
  (workspace_id,availability,side,programme,role_family,first_seen_at DESC,id DESC)
  WHERE deleted_at IS NULL;

COMMIT;
