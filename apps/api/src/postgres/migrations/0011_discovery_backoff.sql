BEGIN;

ALTER TABLE discovery_sources
  ADD COLUMN IF NOT EXISTS consecutive_failure_count integer NOT NULL DEFAULT 0 CHECK (consecutive_failure_count >= 0),
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

CREATE INDEX IF NOT EXISTS discovery_sources_due_retry_idx
  ON discovery_sources(workspace_id, enabled, next_attempt_at)
  WHERE deleted_at IS NULL;

COMMIT;
