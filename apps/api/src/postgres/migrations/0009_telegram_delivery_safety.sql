BEGIN;

ALTER TABLE telegram_integrations
  ADD COLUMN IF NOT EXISTS last_successful_test_at timestamptz;

COMMIT;
