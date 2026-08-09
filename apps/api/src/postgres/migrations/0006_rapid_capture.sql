BEGIN;

ALTER TABLE capture_queue_items
  ADD COLUMN IF NOT EXISTS created_by_user_id text,
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

ALTER TABLE capture_queue_items
  DROP CONSTRAINT IF EXISTS capture_queue_creator_workspace_fk;
ALTER TABLE capture_queue_items
  ADD CONSTRAINT capture_queue_creator_workspace_fk
  FOREIGN KEY(created_by_user_id)
  REFERENCES workspace_users(id) ON DELETE SET NULL;

ALTER TABLE source_documents
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1);

ALTER TABLE field_evidence
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1);

CREATE INDEX IF NOT EXISTS capture_queue_claim_idx
  ON capture_queue_items(state,created_at,id)
  WHERE deleted_at IS NULL AND state='Queued';
CREATE INDEX IF NOT EXISTS capture_queue_lease_idx
  ON capture_queue_items(lease_expires_at)
  WHERE deleted_at IS NULL AND state='Extracting';
CREATE INDEX IF NOT EXISTS capture_queue_workspace_page_idx
  ON capture_queue_items(workspace_id,created_at DESC,id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS capture_drafts_workspace_page_idx
  ON capture_drafts(workspace_id,updated_at DESC,id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS import_runs_workspace_state_idx
  ON import_runs(workspace_id,state,updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS source_documents_workspace_hash_idx
  ON source_documents(workspace_id,content_hash)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS field_evidence_entity_idx
  ON field_evidence(workspace_id,entity_type,entity_id,field_path)
  WHERE deleted_at IS NULL;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['source_documents','import_runs','field_evidence','capture_drafts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS workspace_read ON %I', table_name);
    EXECUTE format('CREATE POLICY workspace_read ON %I FOR SELECT USING (careeros.can_access_workspace(workspace_id))', table_name);
    EXECUTE format('DROP POLICY IF EXISTS workspace_write ON %I', table_name);
    EXECUTE format('CREATE POLICY workspace_write ON %I FOR ALL USING (careeros.can_access_workspace(workspace_id,true)) WITH CHECK (careeros.can_access_workspace(workspace_id,true))', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS touch_revision ON %I', table_name);
    EXECUTE format('CREATE TRIGGER touch_revision BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION careeros.touch_revision()', table_name);
  END LOOP;
END $$;

GRANT SELECT,INSERT,UPDATE,DELETE ON source_documents,import_runs,field_evidence,capture_drafts TO careeros_runtime;

COMMIT;
