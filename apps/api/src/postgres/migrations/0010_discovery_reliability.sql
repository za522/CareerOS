BEGIN;

ALTER TABLE discovered_postings
  ADD COLUMN IF NOT EXISTS source_updated_at timestamptz;

ALTER TABLE discovery_sources
  ADD COLUMN IF NOT EXISTS trusted_inventory_count integer NOT NULL DEFAULT 0 CHECK (trusted_inventory_count >= 0),
  ADD COLUMN IF NOT EXISTS candidate_inventory_count integer CHECK (candidate_inventory_count >= 0),
  ADD COLUMN IF NOT EXISTS candidate_inventory_streak integer NOT NULL DEFAULT 0 CHECK (candidate_inventory_streak >= 0);

UPDATE discovery_sources
SET trusted_inventory_count=successful_inventory_count
WHERE trusted_inventory_count=0 AND successful_inventory_count>0;

COMMIT;
