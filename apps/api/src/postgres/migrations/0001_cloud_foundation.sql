BEGIN;

CREATE SCHEMA IF NOT EXISTS careeros;
CREATE TABLE IF NOT EXISTS careeros.schema_migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL DEFAULT '',
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION careeros.touch_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.revision := OLD.revision + 1;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION careeros.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TABLE IF NOT EXISTS workspaces (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE TABLE IF NOT EXISTS workspace_users (
  id text PRIMARY KEY,
  auth_subject uuid NOT NULL UNIQUE,
  email text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  avatar_url text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE TABLE IF NOT EXISTS workspace_memberships (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES workspace_users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','editor','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,user_id)
);

CREATE OR REPLACE FUNCTION careeros.current_actor_id() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT users.id
  FROM workspace_users users
  WHERE users.id = nullif(current_setting('app.user_id', true), '')
    AND users.deleted_at IS NULL
    AND users.auth_subject::text = COALESCE(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('app.auth_subject', true), '')
    )
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION careeros.can_access_workspace(target_workspace_id text, require_write boolean DEFAULT false)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM workspace_memberships membership
    JOIN workspaces workspace ON workspace.id=membership.workspace_id AND workspace.deleted_at IS NULL
    WHERE membership.workspace_id=target_workspace_id
      AND membership.user_id=careeros.current_actor_id()
      AND (NOT require_write OR membership.role IN ('owner','editor'))
  )
$$;

CREATE OR REPLACE FUNCTION careeros.is_workspace_owner(target_workspace_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM workspace_memberships
    WHERE workspace_id=target_workspace_id AND user_id=careeros.current_actor_id() AND role='owner'
  )
$$;

CREATE TABLE IF NOT EXISTS workspace_invites (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('editor','viewer')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_by_user_id text NOT NULL REFERENCES workspace_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_invite_sessions (
  id_hash text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invite_id text NOT NULL REFERENCES workspace_invites(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_comments (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  author_user_id text NOT NULL REFERENCES workspace_users(id),
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  target_path text NOT NULL DEFAULT '',
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE TABLE IF NOT EXISTS workspace_presence (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES workspace_users(id) ON DELETE CASCADE,
  connection_id text NOT NULL,
  route text NOT NULL DEFAULT '',
  entity_type text NOT NULL DEFAULT '',
  entity_id text NOT NULL DEFAULT '',
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,user_id,connection_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id text REFERENCES workspace_users(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  summary text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS companies (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  snapshot text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE(workspace_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS companies_workspace_name_unique ON companies(workspace_id,lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS job_postings (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id text NOT NULL,
  title text NOT NULL,
  requisition_id text NOT NULL DEFAULT '', location text NOT NULL DEFAULT '', country text NOT NULL DEFAULT '', region text NOT NULL DEFAULT '',
  work_mode text NOT NULL DEFAULT '', employment_type text NOT NULL DEFAULT '', seniority text NOT NULL DEFAULT '', sector text NOT NULL DEFAULT '', role_family text NOT NULL DEFAULT '',
  division text NOT NULL DEFAULT '', team text NOT NULL DEFAULT '', summary text NOT NULL DEFAULT '', description text NOT NULL DEFAULT '',
  required_requirements jsonb NOT NULL DEFAULT '[]'::jsonb, preferred_requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
  process_summary text NOT NULL DEFAULT '', visa_requirements text NOT NULL DEFAULT '', source_url text NOT NULL DEFAULT '', apply_url text NOT NULL DEFAULT '',
  referral_source text NOT NULL DEFAULT '', recruiter_contact text NOT NULL DEFAULT '', application_deadline date, posting_date date, expiry_date date,
  last_checked_at timestamptz, posting_state text NOT NULL DEFAULT 'Active', notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,company_id) REFERENCES companies(workspace_id,id)
);
CREATE INDEX IF NOT EXISTS job_postings_workspace_company_idx ON job_postings(workspace_id,company_id);

CREATE TABLE IF NOT EXISTS applications (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_posting_id text NOT NULL,
  current_status text NOT NULL DEFAULT 'Saved', applied_at timestamptz, priority text NOT NULL DEFAULT 'Medium',
  next_action text, follow_up_date date, notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,job_posting_id) REFERENCES job_postings(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS application_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  application_id text NOT NULL,
  type text NOT NULL, status_after text NOT NULL, occurred_at timestamptz NOT NULL, note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,application_id) REFERENCES applications(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS documents (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_type text NOT NULL, title text NOT NULL, relative_path text NOT NULL DEFAULT '', checksum text NOT NULL DEFAULT '', mime_type text NOT NULL DEFAULT '', size_bytes bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS document_versions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id text NOT NULL, job_posting_id text, parent_version_id text,
  version integer NOT NULL CHECK (version >= 1), relative_path text NOT NULL DEFAULT '', checksum text NOT NULL DEFAULT '', checkpoint_name text NOT NULL DEFAULT '', submitted_at timestamptz,
  content_json jsonb NOT NULL DEFAULT '{}'::jsonb, plain_text text NOT NULL DEFAULT '', accepted_change_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  proposal_changes jsonb NOT NULL DEFAULT '[]'::jsonb, proposal_decisions jsonb NOT NULL DEFAULT '{}'::jsonb, change_summary text NOT NULL DEFAULT '', provider text NOT NULL DEFAULT 'manual', model text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1), UNIQUE(workspace_id,id), UNIQUE(workspace_id,document_id,version),
  FOREIGN KEY(workspace_id,document_id) REFERENCES documents(workspace_id,id),
  FOREIGN KEY(workspace_id,job_posting_id) REFERENCES job_postings(workspace_id,id),
  FOREIGN KEY(workspace_id,parent_version_id) REFERENCES document_versions(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS document_drafts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id text NOT NULL, job_posting_id text NOT NULL,
  content_json jsonb NOT NULL DEFAULT '{}'::jsonb, proposal_state_json jsonb NOT NULL DEFAULT '{"turns":[],"activeTurnId":null}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1), UNIQUE(workspace_id,document_id,job_posting_id),
  FOREIGN KEY(workspace_id,document_id) REFERENCES documents(workspace_id,id),
  FOREIGN KEY(workspace_id,job_posting_id) REFERENCES job_postings(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS application_materials (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  application_id text NOT NULL, document_id text, document_version_id text,
  material_type text NOT NULL, title text NOT NULL, notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY(workspace_id,application_id) REFERENCES applications(workspace_id,id),
  FOREIGN KEY(workspace_id,document_id) REFERENCES documents(workspace_id,id),
  FOREIGN KEY(workspace_id,document_version_id) REFERENCES document_versions(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS capture_queue_items (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_type text NOT NULL, source_url text NOT NULL DEFAULT '', apply_url text NOT NULL DEFAULT '', raw_text text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT 'Queued', progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100), progress_message text,
  attempt_count integer NOT NULL DEFAULT 0, import_run_id text, draft_json jsonb, duplicates_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  enrichment_json jsonb, error text, started_at timestamptz, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE TABLE IF NOT EXISTS discovery_sources (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL, kind text NOT NULL, company_name text NOT NULL, source_url text NOT NULL, external_key text NOT NULL DEFAULT '', enabled boolean NOT NULL DEFAULT true,
  check_interval_minutes integer NOT NULL DEFAULT 180 CHECK (check_interval_minutes >= 1), last_checked_at timestamptz, last_successful_at timestamptz,
  last_error text NOT NULL DEFAULT '', successful_inventory_count integer NOT NULL DEFAULT 0, lease_until timestamptz, lease_token uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1), UNIQUE(workspace_id,id), UNIQUE(workspace_id,kind,external_key)
);
CREATE INDEX IF NOT EXISTS discovery_sources_due_idx ON discovery_sources(workspace_id,enabled,last_checked_at) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS discovery_runs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id text NOT NULL, lease_token uuid NOT NULL, state text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  duration_ms integer NOT NULL DEFAULT 0, found_count integer NOT NULL DEFAULT 0, new_count integer NOT NULL DEFAULT 0, changed_count integer NOT NULL DEFAULT 0, missing_count integer NOT NULL DEFAULT 0, error text NOT NULL DEFAULT '',
  UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,source_id) REFERENCES discovery_sources(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS discovered_postings (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id text NOT NULL, external_id text NOT NULL, canonical_url text NOT NULL, apply_url text NOT NULL,
  company_name text NOT NULL, title text NOT NULL, location text NOT NULL DEFAULT '', programme text NOT NULL DEFAULT '', sector text NOT NULL DEFAULT '', firm_type text NOT NULL DEFAULT '',
  role_family text NOT NULL DEFAULT '', work_mode text NOT NULL DEFAULT 'Not stated', sponsorship text NOT NULL DEFAULT 'Not stated', side text NOT NULL DEFAULT 'unknown', description text NOT NULL DEFAULT '',
  source_posted_at timestamptz, deadline_at timestamptz, first_seen_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL, last_checked_at timestamptz NOT NULL,
  removed_at timestamptz, availability text NOT NULL DEFAULT 'Open', missing_count integer NOT NULL DEFAULT 0, content_hash text NOT NULL DEFAULT '',
  saved_job_posting_id text, hidden_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1), UNIQUE(workspace_id,id), UNIQUE(workspace_id,source_id,external_id),
  FOREIGN KEY(workspace_id,source_id) REFERENCES discovery_sources(workspace_id,id),
  FOREIGN KEY(workspace_id,saved_job_posting_id) REFERENCES job_postings(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS discovery_observations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  discovered_posting_id text NOT NULL, discovery_run_id text NOT NULL,
  state text NOT NULL, content_hash text NOT NULL DEFAULT '', note text NOT NULL DEFAULT '', observed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,discovered_posting_id) REFERENCES discovered_postings(workspace_id,id),
  FOREIGN KEY(workspace_id,discovery_run_id) REFERENCES discovery_runs(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS discovery_posting_aliases (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id text NOT NULL, external_id text NOT NULL, discovered_posting_id text NOT NULL,
  first_seen_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL, last_checked_at timestamptz NOT NULL, removed_at timestamptz,
  availability text NOT NULL DEFAULT 'Open', missing_count integer NOT NULL DEFAULT 0, content_hash text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,source_id,external_id),
  FOREIGN KEY(workspace_id,source_id) REFERENCES discovery_sources(workspace_id,id),
  FOREIGN KEY(workspace_id,discovered_posting_id) REFERENCES discovered_postings(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL, enabled boolean NOT NULL DEFAULT true, criteria_json jsonb NOT NULL DEFAULT '{}'::jsonb, telegram_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1), UNIQUE(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS alert_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rule_id text, discovered_posting_id text, event_type text NOT NULL,
  title text NOT NULL, body text NOT NULL, direct_url text NOT NULL DEFAULT '', deduplication_key text NOT NULL, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id), UNIQUE(workspace_id,deduplication_key),
  FOREIGN KEY(workspace_id,rule_id) REFERENCES alert_rules(workspace_id,id),
  FOREIGN KEY(workspace_id,discovered_posting_id) REFERENCES discovered_postings(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  alert_event_id text NOT NULL, provider text NOT NULL, state text NOT NULL DEFAULT 'Pending', attempt_count integer NOT NULL DEFAULT 0,
  last_error text NOT NULL DEFAULT '', provider_message_id text NOT NULL DEFAULT '', next_attempt_at timestamptz, claim_token uuid, claimed_until timestamptz,
  delivered_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,alert_event_id,provider), FOREIGN KEY(workspace_id,alert_event_id) REFERENCES alert_events(workspace_id,id)
);

CREATE INDEX IF NOT EXISTS comments_entity_idx ON workspace_comments(workspace_id,entity_type,entity_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS audit_workspace_idx ON audit_events(workspace_id,created_at DESC);
CREATE INDEX IF NOT EXISTS capture_queue_state_idx ON capture_queue_items(workspace_id,state,created_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS discovery_postings_seen_idx ON discovered_postings(workspace_id,first_seen_at DESC,availability) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS notification_due_idx ON notification_deliveries(workspace_id,state,next_attempt_at) WHERE delivered_at IS NULL;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspaces','workspace_users','workspace_memberships','workspace_invites','workspace_invite_sessions','workspace_comments','workspace_presence','audit_events',
    'companies','job_postings','applications','application_events','documents','document_versions','document_drafts','application_materials','capture_queue_items',
    'discovery_sources','discovery_runs','discovered_postings','discovery_observations','discovery_posting_aliases','alert_rules','alert_events','notification_deliveries'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END $$;

DROP POLICY IF EXISTS workspace_select ON workspaces;
CREATE POLICY workspace_select ON workspaces FOR SELECT USING (careeros.can_access_workspace(id));
DROP POLICY IF EXISTS workspace_update ON workspaces;
CREATE POLICY workspace_update ON workspaces FOR UPDATE USING (careeros.is_workspace_owner(id)) WITH CHECK (careeros.is_workspace_owner(id));

DROP POLICY IF EXISTS user_select ON workspace_users;
CREATE POLICY user_select ON workspace_users FOR SELECT USING (
  id=careeros.current_actor_id() OR EXISTS (
    SELECT 1 FROM workspace_memberships actor_membership
    JOIN workspace_memberships subject_membership ON subject_membership.workspace_id=actor_membership.workspace_id
    WHERE actor_membership.user_id=careeros.current_actor_id() AND subject_membership.user_id=workspace_users.id
  )
);
DROP POLICY IF EXISTS user_update ON workspace_users;
CREATE POLICY user_update ON workspace_users FOR UPDATE USING (id=careeros.current_actor_id()) WITH CHECK (id=careeros.current_actor_id());

DROP POLICY IF EXISTS membership_select ON workspace_memberships;
CREATE POLICY membership_select ON workspace_memberships FOR SELECT USING (careeros.can_access_workspace(workspace_id));
DROP POLICY IF EXISTS membership_owner_write ON workspace_memberships;
CREATE POLICY membership_owner_write ON workspace_memberships FOR ALL USING (careeros.is_workspace_owner(workspace_id)) WITH CHECK (careeros.is_workspace_owner(workspace_id));

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspace_comments','audit_events',
    'companies','job_postings','applications','documents','document_versions','document_drafts','application_materials','capture_queue_items',
    'discovery_sources','discovery_runs','discovered_postings','discovery_posting_aliases','alert_rules','alert_events','notification_deliveries'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS workspace_read ON %I', table_name);
    EXECUTE format('CREATE POLICY workspace_read ON %I FOR SELECT USING (careeros.can_access_workspace(workspace_id))', table_name);
    EXECUTE format('DROP POLICY IF EXISTS workspace_write ON %I', table_name);
    EXECUTE format('CREATE POLICY workspace_write ON %I FOR ALL USING (careeros.can_access_workspace(workspace_id,true)) WITH CHECK (careeros.can_access_workspace(workspace_id,true))', table_name);
  END LOOP;
END $$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['workspace_invites','workspace_invite_sessions'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS owner_read ON %I', table_name);
    EXECUTE format('CREATE POLICY owner_read ON %I FOR SELECT USING (careeros.is_workspace_owner(workspace_id))', table_name);
    EXECUTE format('DROP POLICY IF EXISTS owner_write ON %I', table_name);
    EXECUTE format('CREATE POLICY owner_write ON %I FOR ALL USING (careeros.is_workspace_owner(workspace_id)) WITH CHECK (careeros.is_workspace_owner(workspace_id))', table_name);
  END LOOP;
END $$;

DROP POLICY IF EXISTS presence_read ON workspace_presence;
CREATE POLICY presence_read ON workspace_presence FOR SELECT USING (careeros.can_access_workspace(workspace_id));
DROP POLICY IF EXISTS presence_own_write ON workspace_presence;
CREATE POLICY presence_own_write ON workspace_presence FOR ALL
USING (careeros.can_access_workspace(workspace_id) AND user_id=careeros.current_actor_id())
WITH CHECK (careeros.can_access_workspace(workspace_id) AND user_id=careeros.current_actor_id());

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['application_events','discovery_observations'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS workspace_read ON %I', table_name);
    EXECUTE format('CREATE POLICY workspace_read ON %I FOR SELECT USING (careeros.can_access_workspace(workspace_id))', table_name);
    EXECUTE format('DROP POLICY IF EXISTS workspace_insert ON %I', table_name);
    EXECUTE format('CREATE POLICY workspace_insert ON %I FOR INSERT WITH CHECK (careeros.can_access_workspace(workspace_id,true))', table_name);
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS application_events_immutable ON application_events;
CREATE TRIGGER application_events_immutable BEFORE UPDATE OR DELETE ON application_events FOR EACH ROW EXECUTE FUNCTION careeros.reject_mutation();
DROP TRIGGER IF EXISTS audit_events_immutable ON audit_events;
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION careeros.reject_mutation();
DROP TRIGGER IF EXISTS discovery_observations_immutable ON discovery_observations;
CREATE TRIGGER discovery_observations_immutable BEFORE UPDATE OR DELETE ON discovery_observations FOR EACH ROW EXECUTE FUNCTION careeros.reject_mutation();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspaces','workspace_users','workspace_comments','companies','job_postings','applications','documents','document_versions','document_drafts',
    'application_materials','capture_queue_items','discovery_sources','discovered_postings','alert_rules'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS touch_revision ON %I', table_name);
    EXECUTE format('CREATE TRIGGER touch_revision BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION careeros.touch_revision()', table_name);
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='careeros_runtime') THEN
    CREATE ROLE careeros_runtime NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
  EXECUTE format('GRANT careeros_runtime TO %I', current_user);
END $$;
GRANT USAGE ON SCHEMA public,careeros TO careeros_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO careeros_runtime;
REVOKE ALL ON FUNCTION careeros.current_actor_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION careeros.can_access_workspace(text,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION careeros.is_workspace_owner(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION careeros.current_actor_id() TO careeros_runtime;
GRANT EXECUTE ON FUNCTION careeros.can_access_workspace(text,boolean) TO careeros_runtime;
GRANT EXECUTE ON FUNCTION careeros.is_workspace_owner(text) TO careeros_runtime;

INSERT INTO careeros.schema_migrations(version) VALUES ('0001_cloud_foundation') ON CONFLICT DO NOTHING;
COMMIT;
