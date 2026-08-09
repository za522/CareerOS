import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPendingBackupRestore } from "./backup-bundle.js";
import { repairLegacyMergedDiscoveryPostings } from "./discovery-repair.js";

const apiModuleDir = dirname(fileURLToPath(import.meta.url));
const defaultDataDir = join(apiModuleDir, "..", "..", "..", "data");
export const dataDir = process.env.CAREEROS_DATA_DIR ?? defaultDataDir;
export const pendingRestorePath = join(dirname(dataDir), `.${basename(dataDir)}-restore-pending.json`);
export let startupRestoreReadOnly = false;
const explicitProvider = process.env.CAREEROS_DATA_PROVIDER?.trim().toLowerCase();
export const sqliteCompatibilityMode = explicitProvider === "postgres" || (!explicitProvider && (process.env.CAREEROS_HOSTED === "1" || process.env.NODE_ENV === "production"));

if (!sqliteCompatibilityMode && existsSync(pendingRestorePath)) {
  try {
    const result = applyPendingBackupRestore({
      markerPath: pendingRestorePath,
      destinationDataDirectory: dataDir,
      expectedSchemaVersion: 4,
      expectedApplicationVersion: "0.1.0",
    });
    console.info("[CareerOS API] Verified backup restore applied before database startup.");
    if (result.recoveryRetained) console.warn(`[CareerOS API] Restored data is active; previous data remains safely retained at ${result.recoveryRetained}.`);
  } catch (error) {
    if (typeof error === "object" && error && "restoreFatal" in error && error.restoreFatal === true) throw error;
    if (typeof error === "object" && error && "restoreApplied" in error && error.restoreApplied === true) {
      startupRestoreReadOnly = true;
      console.error("[CareerOS API] Restored data is active, but restore finalization will be retried at the next startup.", error);
    } else {
      const failedPath = `${pendingRestorePath}.failed-${Date.now()}`;
      renameSync(pendingRestorePath, failedPath);
      console.error(`[CareerOS API] Backup restore was rejected without changing current data. Preserved at ${failedPath}.`, error);
    }
  }
}
if (!sqliteCompatibilityMode) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const secureDataTree = (directory: string) => {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("CareerOS data storage must be a real directory.");
    chmodSync(directory, 0o700);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const entryStat = lstatSync(path);
      if (entryStat.isSymbolicLink()) throw new Error("CareerOS data storage contains an unsafe symbolic link.");
      if (entryStat.isDirectory()) secureDataTree(path);
      else if (entryStat.isFile()) chmodSync(path, 0o600);
      else throw new Error("CareerOS data storage contains an unsupported filesystem entry.");
    }
  };
  secureDataTree(dataDir);
}

const sqlitePath = join(dataDir, "careeros.sqlite");
// PostgreSQL mode keeps legacy module construction inert without opening or creating a local SQLite file.
export const sqlite = new Database(sqliteCompatibilityMode ? ":memory:" : sqlitePath);
if (!sqliteCompatibilityMode) chmodSync(sqlitePath, 0o600);
if (!sqliteCompatibilityMode) sqlite.pragma("journal_mode = WAL");
sqlite.pragma("busy_timeout = 5000");
sqlite.pragma("foreign_keys = ON");
if (!sqliteCompatibilityMode) for (const path of [`${sqlitePath}-wal`, `${sqlitePath}-shm`]) if (existsSync(path)) chmodSync(path, 0o600);

export const db = drizzle(sqlite);

function addColumnIfMissing(table: string, definition: string) {
  const column = definition.trim().split(/\s+/, 1)[0];
  const columns = sqlite.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all() as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) sqlite.exec(`ALTER TABLE "${table.replaceAll('"', '""')}" ADD COLUMN ${definition}`);
}

export function migrate() {
  const runMigration = sqlite.transaction(() => {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      snapshot TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS job_postings (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id),
      title TEXT NOT NULL,
      requisition_id TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      country TEXT NOT NULL DEFAULT '',
      region TEXT NOT NULL DEFAULT '',
      work_mode TEXT NOT NULL DEFAULT '',
      employment_type TEXT NOT NULL DEFAULT '',
      seniority TEXT NOT NULL DEFAULT '',
      sector TEXT NOT NULL DEFAULT '',
      role_family TEXT NOT NULL DEFAULT '',
      division TEXT NOT NULL DEFAULT '',
      team TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      required_requirements TEXT NOT NULL DEFAULT '[]',
      preferred_requirements TEXT NOT NULL DEFAULT '[]',
      process_summary TEXT NOT NULL DEFAULT '',
      visa_requirements TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '',
      apply_url TEXT NOT NULL DEFAULT '',
      referral_source TEXT NOT NULL DEFAULT '',
      recruiter_contact TEXT NOT NULL DEFAULT '',
      application_deadline TEXT NOT NULL DEFAULT '',
      posting_date TEXT NOT NULL DEFAULT '',
      expiry_date TEXT NOT NULL DEFAULT '',
      last_checked_at TEXT NOT NULL DEFAULT '',
      posting_state TEXT NOT NULL DEFAULT 'Active',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      job_posting_id TEXT NOT NULL UNIQUE REFERENCES job_postings(id),
      current_status TEXT NOT NULL DEFAULT 'Saved',
      applied_at TEXT,
      priority TEXT NOT NULL DEFAULT 'Medium',
      next_action TEXT,
      follow_up_date TEXT,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS application_events (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES applications(id),
      type TEXT NOT NULL,
      status_after TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_documents (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      url TEXT,
      raw_text TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL DEFAULT '',
      captured_at TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS import_runs (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_url TEXT,
      state TEXT NOT NULL,
      source_document_id TEXT REFERENCES source_documents(id),
      discovery_posting_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS ai_runs (
      id TEXT PRIMARY KEY,
      operation TEXT NOT NULL,
      context_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      state TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      duration_ms INTEGER NOT NULL DEFAULT 0,
      total_duration_ms INTEGER NOT NULL DEFAULT 0,
      evidence_count INTEGER NOT NULL DEFAULT 0,
      warning TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS field_evidence (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      field_path TEXT NOT NULL,
      source_document_id TEXT REFERENCES source_documents(id),
      excerpt TEXT NOT NULL DEFAULT '',
      method TEXT NOT NULL,
      suggested_value TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 0,
      user_confirmed INTEGER NOT NULL DEFAULT 0,
      captured_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      task_type TEXT NOT NULL DEFAULT 'follow_up',
      priority TEXT NOT NULL DEFAULT 'Medium',
      due_date TEXT,
      completed_at TEXT,
      notes TEXT NOT NULL DEFAULT '',
      entity_type TEXT,
      entity_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS salary_estimates (
      id TEXT PRIMARY KEY,
      job_posting_id TEXT NOT NULL REFERENCES job_postings(id),
      estimate_type TEXT NOT NULL DEFAULT 'manual',
      min_amount REAL,
      max_amount REAL,
      base_min_amount REAL,
      base_max_amount REAL,
      total_comp_min_amount REAL,
      total_comp_max_amount REAL,
      currency TEXT NOT NULL DEFAULT '',
      payment_period TEXT NOT NULL DEFAULT 'annual',
      base_salary REAL,
      bonus REAL,
      equity TEXT NOT NULL DEFAULT '',
      other_compensation TEXT NOT NULL DEFAULT '',
      country TEXT NOT NULL DEFAULT '',
      region TEXT NOT NULL DEFAULT '',
      seniority_assumptions TEXT NOT NULL DEFAULT '',
      source_name TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '',
      evidence_excerpt TEXT NOT NULL DEFAULT '',
      source_date TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 0,
      annualised_equivalent REAL,
      normalised_currency TEXT NOT NULL DEFAULT '',
      exchange_rate_date TEXT NOT NULL DEFAULT '',
      research_notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS salary_research_evidence (
      id TEXT PRIMARY KEY,
      salary_estimate_id TEXT NOT NULL REFERENCES salary_estimates(id),
      source_name TEXT NOT NULL,
      source_url TEXT NOT NULL,
      source_date TEXT NOT NULL DEFAULT '',
      role_title TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      seniority TEXT NOT NULL DEFAULT '',
      compensation_scope TEXT NOT NULL DEFAULT 'unknown',
      min_amount REAL,
      max_amount REAL,
      currency TEXT NOT NULL,
      payment_period TEXT NOT NULL DEFAULT 'annual',
      excerpt TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      contact_type TEXT NOT NULL DEFAULT 'recruiter',
      email TEXT NOT NULL DEFAULT '',
      company_id TEXT REFERENCES companies(id),
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS application_contacts (
      application_id TEXT NOT NULL REFERENCES applications(id),
      contact_id TEXT NOT NULL REFERENCES contacts(id),
      notes TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (application_id, contact_id)
    );
    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS job_tags (
      job_posting_id TEXT NOT NULL REFERENCES job_postings(id),
      tag_id TEXT NOT NULL REFERENCES tags(id),
      PRIMARY KEY (job_posting_id, tag_id)
    );
    CREATE TABLE IF NOT EXISTS career_tracks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS job_tracks (
      job_posting_id TEXT NOT NULL REFERENCES job_postings(id),
      career_track_id TEXT NOT NULL REFERENCES career_tracks(id),
      PRIMARY KEY (job_posting_id, career_track_id)
    );
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS job_skills (
      job_posting_id TEXT NOT NULL REFERENCES job_postings(id),
      skill_id TEXT NOT NULL REFERENCES skills(id),
      requirement_type TEXT NOT NULL DEFAULT 'required',
      PRIMARY KEY (job_posting_id, skill_id)
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS project_skills (
      project_id TEXT NOT NULL REFERENCES projects(id),
      skill_id TEXT NOT NULL REFERENCES skills(id),
      PRIMARY KEY (project_id, skill_id)
    );
    CREATE TABLE IF NOT EXISTS project_tracks (
      project_id TEXT NOT NULL REFERENCES projects(id),
      career_track_id TEXT NOT NULL REFERENCES career_tracks(id),
      PRIMARY KEY (project_id, career_track_id)
    );
    CREATE TABLE IF NOT EXISTS learning_items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      item_type TEXT NOT NULL DEFAULT 'course',
      category TEXT NOT NULL DEFAULT '',
      estimated_hours REAL,
      classification TEXT NOT NULL DEFAULT 'realistic',
      due_date TEXT,
      progress REAL NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS learning_skills (
      learning_item_id TEXT NOT NULL REFERENCES learning_items(id),
      skill_id TEXT NOT NULL REFERENCES skills(id),
      PRIMARY KEY (learning_item_id, skill_id)
    );
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      target_date TEXT,
      progress REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      headline TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS profile_evidence (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id),
      evidence_type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      document_type TEXT NOT NULL,
      title TEXT NOT NULL,
      relative_path TEXT NOT NULL DEFAULT '',
      checksum TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS document_versions (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id),
      job_posting_id TEXT REFERENCES job_postings(id),
      parent_version_id TEXT REFERENCES document_versions(id),
      version INTEGER NOT NULL,
      relative_path TEXT NOT NULL DEFAULT '',
      checksum TEXT NOT NULL DEFAULT '',
      checkpoint_name TEXT NOT NULL DEFAULT '',
      submitted_at TEXT,
      content_json TEXT NOT NULL DEFAULT '{}',
      plain_text TEXT NOT NULL DEFAULT '',
      accepted_change_ids TEXT NOT NULL DEFAULT '[]',
      proposal_changes TEXT NOT NULL DEFAULT '[]',
      proposal_decisions TEXT NOT NULL DEFAULT '{}',
      change_summary TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT 'manual',
      model TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      UNIQUE (document_id, version)
    );
    CREATE TABLE IF NOT EXISTS document_drafts (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id),
      job_posting_id TEXT NOT NULL REFERENCES job_postings(id),
      content_json TEXT NOT NULL DEFAULT '{}',
      proposal_state_json TEXT NOT NULL DEFAULT '{"turns":[],"activeTurnId":null}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      UNIQUE (document_id, job_posting_id)
    );
    CREATE TABLE IF NOT EXISTS application_materials (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES applications(id),
      document_id TEXT REFERENCES documents(id),
      document_version_id TEXT REFERENCES document_versions(id),
      material_type TEXT NOT NULL,
      title TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS capture_queue_items (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_url TEXT NOT NULL DEFAULT '',
      apply_url TEXT NOT NULL DEFAULT '',
      raw_text TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'Queued',
      progress INTEGER NOT NULL DEFAULT 0,
      progress_message TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      import_run_id TEXT REFERENCES import_runs(id),
      draft_json TEXT,
      duplicates_json TEXT NOT NULL DEFAULT '[]',
      enrichment_json TEXT,
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS capture_drafts (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      value TEXT NOT NULL DEFAULT '',
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS discovery_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      company_name TEXT NOT NULL,
      source_url TEXT NOT NULL,
      external_key TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      check_interval_minutes INTEGER NOT NULL DEFAULT 180,
      last_checked_at TEXT,
      last_successful_at TEXT,
      last_error TEXT NOT NULL DEFAULT '',
      successful_inventory_count INTEGER NOT NULL DEFAULT 0,
      lease_until TEXT,
      lease_token TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS discovery_runs (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES discovery_sources(id),
      state TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      found_count INTEGER NOT NULL DEFAULT 0,
      new_count INTEGER NOT NULL DEFAULT 0,
      changed_count INTEGER NOT NULL DEFAULT 0,
      missing_count INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS discovered_postings (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES discovery_sources(id),
      external_id TEXT NOT NULL,
      canonical_url TEXT NOT NULL,
      apply_url TEXT NOT NULL,
      company_name TEXT NOT NULL,
      title TEXT NOT NULL,
      location TEXT NOT NULL DEFAULT '',
      programme TEXT NOT NULL DEFAULT '',
      sector TEXT NOT NULL DEFAULT '',
      firm_type TEXT NOT NULL DEFAULT '',
      role_family TEXT NOT NULL DEFAULT '',
      work_mode TEXT NOT NULL DEFAULT 'Not stated',
      sponsorship TEXT NOT NULL DEFAULT 'Not stated',
      side TEXT NOT NULL DEFAULT 'unknown',
      description TEXT NOT NULL DEFAULT '',
      source_posted_at TEXT,
      deadline_at TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_checked_at TEXT NOT NULL,
      removed_at TEXT,
      availability TEXT NOT NULL DEFAULT 'Open',
      missing_count INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL DEFAULT '',
      saved_job_posting_id TEXT REFERENCES job_postings(id),
      hidden_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      UNIQUE(source_id, external_id)
    );
    CREATE TABLE IF NOT EXISTS discovery_observations (
      id TEXT PRIMARY KEY,
      discovered_posting_id TEXT NOT NULL REFERENCES discovered_postings(id),
      discovery_run_id TEXT NOT NULL REFERENCES discovery_runs(id),
      state TEXT NOT NULL,
      content_hash TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      observed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS discovery_posting_aliases (
      source_id TEXT NOT NULL REFERENCES discovery_sources(id),
      external_id TEXT NOT NULL,
      discovered_posting_id TEXT NOT NULL REFERENCES discovered_postings(id),
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_checked_at TEXT NOT NULL,
      removed_at TEXT,
      availability TEXT NOT NULL DEFAULT 'Open',
      missing_count INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      PRIMARY KEY(source_id, external_id)
    );
    CREATE TABLE IF NOT EXISTS discovery_issues (
      id TEXT PRIMARY KEY,
      discovered_posting_id TEXT NOT NULL REFERENCES discovered_postings(id),
      reason TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'Open',
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS alert_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      criteria_json TEXT NOT NULL DEFAULT '{}',
      telegram_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS alert_events (
      id TEXT PRIMARY KEY,
      rule_id TEXT REFERENCES alert_rules(id),
      discovered_posting_id TEXT REFERENCES discovered_postings(id),
      event_type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      direct_url TEXT NOT NULL DEFAULT '',
      deduplication_key TEXT NOT NULL UNIQUE,
      read_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id TEXT PRIMARY KEY,
      alert_event_id TEXT NOT NULL REFERENCES alert_events(id),
      provider TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'Pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      provider_attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      provider_message_id TEXT NOT NULL DEFAULT '',
      next_attempt_at TEXT,
      claim_token TEXT,
      claimed_until TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(alert_event_id, provider)
    );
    CREATE TABLE IF NOT EXISTS notification_delivery_attempts (
      id TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL REFERENCES notification_deliveries(id),
      sequence INTEGER NOT NULL,
      state TEXT NOT NULL,
      error TEXT NOT NULL DEFAULT '',
      provider_message_id TEXT NOT NULL DEFAULT '',
      retry_after_at TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(delivery_id, sequence)
    );
    CREATE TRIGGER IF NOT EXISTS notification_delivery_attempts_immutable_update
      BEFORE UPDATE ON notification_delivery_attempts
      BEGIN SELECT RAISE(ABORT, 'notification delivery attempts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS notification_delivery_attempts_immutable_delete
      BEFORE DELETE ON notification_delivery_attempts
      BEGIN SELECT RAISE(ABORT, 'notification delivery attempts are immutable'); END;
    CREATE TABLE IF NOT EXISTS backup_records (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      object_path TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS workspace_users (
      id TEXT PRIMARY KEY,
      auth_subject TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      avatar_url TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS workspace_memberships (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      user_id TEXT NOT NULL REFERENCES workspace_users(id),
      role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS workspace_invites (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      accepted_at TEXT,
      revoked_at TEXT,
      created_by_user_id TEXT NOT NULL REFERENCES workspace_users(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_invite_sessions (
      id_hash TEXT PRIMARY KEY,
      invite_id TEXT NOT NULL REFERENCES workspace_invites(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_comments (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      author_user_id TEXT NOT NULL REFERENCES workspace_users(id),
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      target_path TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      resolved_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      actor_user_id TEXT REFERENCES workspace_users(id),
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS job_postings_company_idx ON job_postings(company_id);
    CREATE INDEX IF NOT EXISTS applications_job_idx ON applications(job_posting_id);
    CREATE INDEX IF NOT EXISTS events_application_idx ON application_events(application_id, occurred_at);
    CREATE INDEX IF NOT EXISTS evidence_entity_idx ON field_evidence(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS tasks_entity_idx ON tasks(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS salary_evidence_estimate_idx ON salary_research_evidence(salary_estimate_id);
    CREATE INDEX IF NOT EXISTS ai_runs_created_idx ON ai_runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS document_drafts_job_idx ON document_drafts(job_posting_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS capture_queue_state_idx ON capture_queue_items(state, created_at);
    CREATE INDEX IF NOT EXISTS capture_drafts_updated_idx ON capture_drafts(updated_at DESC);
    CREATE INDEX IF NOT EXISTS discovery_sources_due_idx ON discovery_sources(enabled, last_checked_at);
    CREATE INDEX IF NOT EXISTS discovered_postings_seen_idx ON discovered_postings(first_seen_at DESC, availability);
    CREATE INDEX IF NOT EXISTS discovered_postings_keyset_idx ON discovered_postings(first_seen_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS discovery_observations_posting_idx ON discovery_observations(discovered_posting_id, observed_at DESC);
    CREATE INDEX IF NOT EXISTS discovery_posting_aliases_posting_idx ON discovery_posting_aliases(discovered_posting_id);
    CREATE INDEX IF NOT EXISTS discovery_issues_posting_idx ON discovery_issues(discovered_posting_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS alert_events_created_idx ON alert_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS notification_deliveries_state_idx ON notification_deliveries(state, next_attempt_at);
    CREATE INDEX IF NOT EXISTS notification_delivery_attempts_delivery_idx ON notification_delivery_attempts(delivery_id, sequence DESC);
    CREATE INDEX IF NOT EXISTS backup_records_created_idx ON backup_records(created_at DESC);
    CREATE INDEX IF NOT EXISTS workspace_comments_entity_idx ON workspace_comments(workspace_id, entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS audit_events_workspace_idx ON audit_events(workspace_id, created_at DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
      entity_id UNINDEXED,
      entity_type UNINDEXED,
      content,
      tokenize = 'unicode61'
    );
  `);
  addColumnIfMissing("import_runs", "deleted_at TEXT");
  addColumnIfMissing("job_postings", "last_checked_at TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing("salary_estimates", "estimate_type TEXT NOT NULL DEFAULT 'manual'");
  const salaryCompatibilityColumns = [
    "base_min_amount REAL",
    "base_max_amount REAL",
    "total_comp_min_amount REAL",
    "total_comp_max_amount REAL",
  ];
  for (const column of salaryCompatibilityColumns) {
    addColumnIfMissing("salary_estimates", column);
  }
  const documentVersionCompatibilityColumns = [
    "job_posting_id TEXT REFERENCES job_postings(id)",
    "parent_version_id TEXT REFERENCES document_versions(id)",
    "content_json TEXT NOT NULL DEFAULT '{}'",
    "plain_text TEXT NOT NULL DEFAULT ''",
    "accepted_change_ids TEXT NOT NULL DEFAULT '[]'",
    "proposal_changes TEXT NOT NULL DEFAULT '[]'",
    "proposal_decisions TEXT NOT NULL DEFAULT '{}'",
    "change_summary TEXT NOT NULL DEFAULT ''",
    "provider TEXT NOT NULL DEFAULT 'manual'",
    "model TEXT NOT NULL DEFAULT ''",
    "checkpoint_name TEXT NOT NULL DEFAULT ''",
    "submitted_at TEXT",
  ];
  for (const column of documentVersionCompatibilityColumns) {
    addColumnIfMissing("document_versions", column);
  }
  addColumnIfMissing("document_drafts", "proposal_state_json TEXT NOT NULL DEFAULT '{\"turns\":[],\"activeTurnId\":null}'");
  addColumnIfMissing("application_materials", "document_version_id TEXT REFERENCES document_versions(id)");
  addColumnIfMissing("capture_queue_items", "progress_message TEXT");
  addColumnIfMissing("discovery_sources", "lease_until TEXT");
  addColumnIfMissing("discovery_sources", "lease_token TEXT");
  addColumnIfMissing("import_runs", "discovery_posting_id TEXT");
  const discoveryAliasCompatibilityColumns = [
    "first_seen_at TEXT NOT NULL DEFAULT ''",
    "last_seen_at TEXT NOT NULL DEFAULT ''",
    "last_checked_at TEXT NOT NULL DEFAULT ''",
    "removed_at TEXT",
    "availability TEXT NOT NULL DEFAULT 'Open'",
    "missing_count INTEGER NOT NULL DEFAULT 0",
    "content_hash TEXT NOT NULL DEFAULT ''",
  ];
  for (const column of discoveryAliasCompatibilityColumns) {
    addColumnIfMissing("discovery_posting_aliases", column);
  }
  sqlite.exec(`UPDATE discovery_posting_aliases SET
    first_seen_at = COALESCE(NULLIF(first_seen_at, ''), created_at),
    last_seen_at = COALESCE(NULLIF(last_seen_at, ''), created_at),
    last_checked_at = COALESCE(NULLIF(last_checked_at, ''), created_at)`);
  addColumnIfMissing("discovered_postings", "hidden_at TEXT");
  for (const column of [
    "firm_type TEXT NOT NULL DEFAULT ''",
    "work_mode TEXT NOT NULL DEFAULT 'Not stated'",
    "sponsorship TEXT NOT NULL DEFAULT 'Not stated'",
  ]) {
    addColumnIfMissing("discovered_postings", column);
  }
  addColumnIfMissing("discovery_sources", "successful_inventory_count INTEGER NOT NULL DEFAULT 0");
  const discoveryRepair = repairLegacyMergedDiscoveryPostings(sqlite);
  if (discoveryRepair.canonicalRowsCreated > 0) {
    console.info(`[CareerOS API] Repaired ${discoveryRepair.canonicalRowsRepaired} legacy discovery merges into ${discoveryRepair.canonicalRowsCreated} canonical postings.`);
  }
  sqlite.exec(`UPDATE discovered_postings SET
    role_family = CASE
      WHEN lower(title || ' ' || description) GLOB '*quant*' OR lower(title || ' ' || description) GLOB '*research scientist*' THEN 'Quantitative research'
      WHEN lower(title || ' ' || description) GLOB '*trad*' OR lower(title || ' ' || description) GLOB '*market mak*' THEN 'Trading'
      WHEN lower(title || ' ' || description) GLOB '*engineer*' OR lower(title || ' ' || description) GLOB '*software*' OR lower(title || ' ' || description) GLOB '*developer*' THEN 'Engineering'
      WHEN lower(title || ' ' || description) GLOB '*risk*' THEN 'Risk'
      WHEN lower(title || ' ' || description) GLOB '*finance*' THEN 'Finance'
      ELSE 'Business' END
    WHERE role_family='';
    UPDATE discovered_postings SET
      firm_type = CASE
        WHEN lower(company_name) IN ('optiver','imc','dv trading','wintermute','intropic') THEN 'Market maker / proprietary trading'
        WHEN lower(company_name) IN ('point72','schonfeld') THEN 'Hedge fund'
        ELSE 'Financial services' END
      WHERE firm_type='';
    UPDATE discovered_postings SET sector = CASE WHEN role_family='Engineering' THEN 'Technology' ELSE 'Financial services' END WHERE sector='';
    UPDATE discovered_postings SET work_mode='Not stated' WHERE work_mode='';
    UPDATE discovered_postings SET sponsorship='Not stated' WHERE sponsorship='';`);
  sqlite.exec("CREATE INDEX IF NOT EXISTS discovered_postings_keyset_idx ON discovered_postings(first_seen_at DESC, id DESC)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS discovered_postings_filters_idx ON discovered_postings(availability, hidden_at, sector, firm_type, role_family, programme, side)");
  for (const column of ["claim_token TEXT", "claimed_until TEXT", "provider_attempt_count INTEGER NOT NULL DEFAULT 0"]) {
    addColumnIfMissing("notification_deliveries", column);
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS notification_delivery_attempts (
      id TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL REFERENCES notification_deliveries(id),
      sequence INTEGER NOT NULL,
      state TEXT NOT NULL,
      error TEXT NOT NULL DEFAULT '',
      provider_message_id TEXT NOT NULL DEFAULT '',
      retry_after_at TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(delivery_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS notification_delivery_attempts_delivery_idx
      ON notification_delivery_attempts(delivery_id, sequence DESC);
    CREATE TRIGGER IF NOT EXISTS notification_delivery_attempts_immutable_update
      BEFORE UPDATE ON notification_delivery_attempts
      BEGIN SELECT RAISE(ABORT, 'notification delivery attempts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS notification_delivery_attempts_immutable_delete
      BEFORE DELETE ON notification_delivery_attempts
      BEGIN SELECT RAISE(ABORT, 'notification delivery attempts are immutable'); END;
    UPDATE notification_deliveries
      SET provider_attempt_count=attempt_count
      WHERE provider_attempt_count=0 AND attempt_count>0;
    UPDATE notification_deliveries
      SET state='ConfigurationRequired'
      WHERE provider='telegram' AND state='Failed' AND attempt_count=0 AND lower(last_error) LIKE '%not configured%';
    INSERT OR IGNORE INTO notification_delivery_attempts
      (id,delivery_id,sequence,state,error,provider_message_id,retry_after_at,started_at,completed_at)
      SELECT 'legacy-' || id,id,1,
        CASE
          WHEN state='Delivered' THEN 'Delivered'
          WHEN state='ConfigurationRequired' THEN 'ConfigurationRequired'
          WHEN state='Ambiguous' THEN 'Ambiguous'
          ELSE 'Failed'
        END,
        last_error,provider_message_id,next_attempt_at,created_at,updated_at
      FROM notification_deliveries
      WHERE attempt_count>0 OR last_error<>'';
  `);
  sqlite.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  sqlite.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (?,?)").run("0004-tonight-release", new Date().toISOString());
  sqlite.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (?,?)").run("0005-notification-delivery-history", new Date().toISOString());
  });
  runMigration();
}

export function closeDb() {
  sqlite.close();
}
