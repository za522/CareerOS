BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workspace_invites_workspace_id_id_key') THEN
    ALTER TABLE workspace_invites ADD CONSTRAINT workspace_invites_workspace_id_id_key UNIQUE(workspace_id,id);
  END IF;
END $$;
ALTER TABLE workspace_invite_sessions DROP CONSTRAINT IF EXISTS workspace_invite_sessions_invite_id_fkey;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workspace_invite_sessions_workspace_invite_fk') THEN
    ALTER TABLE workspace_invite_sessions ADD CONSTRAINT workspace_invite_sessions_workspace_invite_fk
      FOREIGN KEY(workspace_id,invite_id) REFERENCES workspace_invites(workspace_id,id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS source_documents (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_type text NOT NULL,
  url text,
  raw_text text NOT NULL DEFAULT '',
  content_hash text NOT NULL DEFAULT '',
  captured_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS import_runs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_type text NOT NULL,
  source_url text,
  state text NOT NULL,
  source_document_id text,
  discovery_posting_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,source_document_id) REFERENCES source_documents(workspace_id,id),
  FOREIGN KEY(workspace_id,discovery_posting_id) REFERENCES discovered_postings(workspace_id,id)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='capture_queue_import_run_workspace_fk') THEN
    ALTER TABLE capture_queue_items
      ADD CONSTRAINT capture_queue_import_run_workspace_fk
      FOREIGN KEY(workspace_id,import_run_id) REFERENCES import_runs(workspace_id,id);
  END IF;
END $$;

ALTER TABLE discovery_runs ALTER COLUMN lease_token DROP NOT NULL;

CREATE TABLE IF NOT EXISTS ai_runs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation text NOT NULL,
  context_id text NOT NULL,
  source_type text NOT NULL,
  state text NOT NULL,
  provider text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  duration_ms integer NOT NULL DEFAULT 0,
  total_duration_ms integer NOT NULL DEFAULT 0,
  evidence_count integer NOT NULL DEFAULT 0,
  warning text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS field_evidence (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  field_path text NOT NULL,
  source_document_id text,
  excerpt text NOT NULL DEFAULT '',
  method text NOT NULL,
  suggested_value text NOT NULL DEFAULT '',
  confidence double precision NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  user_confirmed boolean NOT NULL DEFAULT false,
  captured_at timestamptz NOT NULL,
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,source_document_id) REFERENCES source_documents(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title text NOT NULL,
  task_type text NOT NULL DEFAULT 'follow_up',
  priority text NOT NULL DEFAULT 'Medium',
  due_date date,
  completed_at timestamptz,
  notes text NOT NULL DEFAULT '',
  entity_type text,
  entity_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS salary_estimates (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_posting_id text NOT NULL,
  estimate_type text NOT NULL DEFAULT 'manual',
  min_amount double precision,
  max_amount double precision,
  base_min_amount double precision,
  base_max_amount double precision,
  total_comp_min_amount double precision,
  total_comp_max_amount double precision,
  currency text NOT NULL DEFAULT '',
  payment_period text NOT NULL DEFAULT 'annual',
  base_salary double precision,
  bonus double precision,
  equity text NOT NULL DEFAULT '',
  other_compensation text NOT NULL DEFAULT '',
  country text NOT NULL DEFAULT '',
  region text NOT NULL DEFAULT '',
  seniority_assumptions text NOT NULL DEFAULT '',
  source_name text NOT NULL DEFAULT '',
  source_url text NOT NULL DEFAULT '',
  evidence_excerpt text NOT NULL DEFAULT '',
  source_date date,
  confidence double precision NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  annualised_equivalent double precision,
  normalised_currency text NOT NULL DEFAULT '',
  exchange_rate_date date,
  research_notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,job_posting_id) REFERENCES job_postings(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS salary_research_evidence (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  salary_estimate_id text NOT NULL,
  source_name text NOT NULL,
  source_url text NOT NULL,
  source_date date,
  role_title text NOT NULL DEFAULT '',
  location text NOT NULL DEFAULT '',
  seniority text NOT NULL DEFAULT '',
  compensation_scope text NOT NULL DEFAULT 'unknown',
  min_amount double precision,
  max_amount double precision,
  currency text NOT NULL,
  payment_period text NOT NULL DEFAULT 'annual',
  excerpt text NOT NULL,
  confidence double precision NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,salary_estimate_id) REFERENCES salary_estimates(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS contacts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  contact_type text NOT NULL DEFAULT 'recruiter',
  email text NOT NULL DEFAULT '',
  company_id text,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,company_id) REFERENCES companies(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS application_contacts (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  application_id text NOT NULL,
  contact_id text NOT NULL,
  notes text NOT NULL DEFAULT '',
  PRIMARY KEY(workspace_id,application_id,contact_id),
  FOREIGN KEY(workspace_id,application_id) REFERENCES applications(workspace_id,id),
  FOREIGN KEY(workspace_id,contact_id) REFERENCES contacts(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS tags (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE(workspace_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS tags_workspace_name_unique ON tags(workspace_id,lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS job_tags (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_posting_id text NOT NULL,
  tag_id text NOT NULL,
  PRIMARY KEY(workspace_id,job_posting_id,tag_id),
  FOREIGN KEY(workspace_id,job_posting_id) REFERENCES job_postings(workspace_id,id),
  FOREIGN KEY(workspace_id,tag_id) REFERENCES tags(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS career_tracks (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS job_tracks (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_posting_id text NOT NULL,
  career_track_id text NOT NULL,
  PRIMARY KEY(workspace_id,job_posting_id,career_track_id),
  FOREIGN KEY(workspace_id,job_posting_id) REFERENCES job_postings(workspace_id,id),
  FOREIGN KEY(workspace_id,career_track_id) REFERENCES career_tracks(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS skills (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS job_skills (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_posting_id text NOT NULL,
  skill_id text NOT NULL,
  requirement_type text NOT NULL DEFAULT 'required',
  PRIMARY KEY(workspace_id,job_posting_id,skill_id),
  FOREIGN KEY(workspace_id,job_posting_id) REFERENCES job_postings(workspace_id,id),
  FOREIGN KEY(workspace_id,skill_id) REFERENCES skills(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  summary text NOT NULL DEFAULT '',
  url text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS project_skills (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  skill_id text NOT NULL,
  PRIMARY KEY(workspace_id,project_id,skill_id),
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id),
  FOREIGN KEY(workspace_id,skill_id) REFERENCES skills(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS project_tracks (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  career_track_id text NOT NULL,
  PRIMARY KEY(workspace_id,project_id,career_track_id),
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id),
  FOREIGN KEY(workspace_id,career_track_id) REFERENCES career_tracks(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS learning_items (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title text NOT NULL,
  item_type text NOT NULL DEFAULT 'course',
  category text NOT NULL DEFAULT '',
  estimated_hours double precision,
  classification text NOT NULL DEFAULT 'realistic',
  due_date date,
  progress double precision NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS learning_skills (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  learning_item_id text NOT NULL,
  skill_id text NOT NULL,
  PRIMARY KEY(workspace_id,learning_item_id,skill_id),
  FOREIGN KEY(workspace_id,learning_item_id) REFERENCES learning_items(workspace_id,id),
  FOREIGN KEY(workspace_id,skill_id) REFERENCES skills(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS goals (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  target_date date,
  progress double precision NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS profiles (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT '',
  headline text NOT NULL DEFAULT '',
  summary text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS profile_evidence (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_id text NOT NULL,
  evidence_type text NOT NULL,
  title text NOT NULL,
  content text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,profile_id) REFERENCES profiles(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS capture_drafts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_type text NOT NULL,
  value text NOT NULL DEFAULT '',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS discovery_issues (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  discovered_posting_id text NOT NULL,
  reason text NOT NULL,
  state text NOT NULL DEFAULT 'Open',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,discovered_posting_id) REFERENCES discovered_postings(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS backup_records (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  object_path text NOT NULL,
  checksum text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,object_path)
);

CREATE UNIQUE INDEX IF NOT EXISTS applications_workspace_job_unique ON applications(workspace_id,job_posting_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS evidence_entity_workspace_idx ON field_evidence(workspace_id,entity_type,entity_id);
CREATE INDEX IF NOT EXISTS tasks_entity_workspace_idx ON tasks(workspace_id,entity_type,entity_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS salary_estimates_job_workspace_idx ON salary_estimates(workspace_id,job_posting_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ai_runs_created_workspace_idx ON ai_runs(workspace_id,created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS capture_drafts_updated_workspace_idx ON capture_drafts(workspace_id,updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS discovery_issues_posting_workspace_idx ON discovery_issues(workspace_id,discovered_posting_id,created_at DESC);
CREATE INDEX IF NOT EXISTS backup_records_created_workspace_idx ON backup_records(workspace_id,created_at DESC);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'source_documents','import_runs','ai_runs','field_evidence','tasks','salary_estimates','salary_research_evidence',
    'contacts','application_contacts','tags','job_tags','career_tracks','job_tracks','skills','job_skills','projects',
    'project_skills','project_tracks','learning_items','learning_skills','goals','profiles','profile_evidence','capture_drafts','discovery_issues','backup_records'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS workspace_read ON %I', table_name);
    EXECUTE format('CREATE POLICY workspace_read ON %I FOR SELECT USING (careeros.can_access_workspace(workspace_id))', table_name);
    EXECUTE format('DROP POLICY IF EXISTS workspace_write ON %I', table_name);
    EXECUTE format('CREATE POLICY workspace_write ON %I FOR ALL USING (careeros.can_access_workspace(workspace_id,true)) WITH CHECK (careeros.can_access_workspace(workspace_id,true))', table_name);
  END LOOP;
END $$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'import_runs','ai_runs','tasks','salary_estimates','contacts','tags','career_tracks','skills','projects',
    'learning_items','goals','profiles','profile_evidence','capture_drafts'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS touch_revision ON %I', table_name);
    EXECUTE format('CREATE TRIGGER touch_revision BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION careeros.touch_revision()', table_name);
  END LOOP;
END $$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['source_documents','salary_research_evidence','backup_records'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS workspace_write ON %I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS workspace_insert ON %I', table_name);
    EXECUTE format('CREATE POLICY workspace_insert ON %I FOR INSERT WITH CHECK (careeros.can_access_workspace(workspace_id,true))', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS immutable_record ON %I', table_name);
    EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION careeros.reject_mutation()', table_name);
  END LOOP;
END $$;

GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO careeros_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO careeros_runtime;

INSERT INTO careeros.schema_migrations(version) VALUES ('0002_complete_workspace') ON CONFLICT DO NOTHING;
COMMIT;
