BEGIN;

-- User-scoped requests always SET LOCAL ROLE careeros_runtime, where RLS remains
-- enforced. The database owner performs migrations and explicit administrative
-- transactions; forcing RLS onto that owner recursively invokes policy helpers.
DO $$
DECLARE table_name text;
BEGIN
  FOR table_name IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public'
      AND c.relkind IN ('r','p')
      AND c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END $$;

COMMIT;
