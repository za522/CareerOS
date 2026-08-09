import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it, vi } from "vitest";
import type { QueryExecutor, QueryResult, SqlValue, TransactionManager, WorkspaceContext } from "./contracts.js";
import { PostgresDiscoveryLeaseRepository } from "./discovery-leases.js";
import { CLOUD_FOUNDATION_MIGRATION, discoverCloudMigrations } from "./migrations.js";
import { PostgresRevisionRepository } from "./revision-repository.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const RECORD_ID = "33333333-3333-4333-8333-333333333333";

function result<Row extends Record<string, unknown>>(rows: Row[] = [], rowCount = rows.length): QueryResult<Row> {
  return { rows, rowCount };
}

describe("PostgreSQL cloud foundation migration", () => {
  async function applyAll(database: PGlite) {
    for (const migration of await discoverCloudMigrations()) {
      await database.exec(migration.sql);
      await database.query(
        `INSERT INTO careeros.schema_migrations(version,checksum) VALUES ($1,$2)
         ON CONFLICT(version) DO UPDATE SET checksum=excluded.checksum`,
        [migration.version, migration.checksum],
      );
    }
  }

  it("executes twice against an embedded PostgreSQL engine", async () => {
    const database = new PGlite();
    const sql = await readFile(CLOUD_FOUNDATION_MIGRATION, "utf8");
    await expect(database.exec(sql)).resolves.toBeDefined();
    await expect(database.exec(sql)).resolves.toBeDefined();
    const migration = await database.query<{ version: string }>("SELECT version FROM careeros.schema_migrations");
    expect(migration.rows).toEqual([{ version: "0001_cloud_foundation" }]);
    const policies = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_policies WHERE schemaname='public'");
    expect(policies.rows[0].count).toBeGreaterThanOrEqual(40);
    await database.close();
  }, 20_000);

  it("enforces workspace isolation and viewer write denial through RLS", async () => {
    const database = new PGlite();
    await database.exec(await readFile(CLOUD_FOUNDATION_MIGRATION, "utf8"));
    await database.exec(`
      INSERT INTO workspaces(id,name) VALUES ('workspace-a','A'),('workspace-b','B');
      INSERT INTO workspace_users(id,auth_subject,email) VALUES
        ('${USER_ID}','44444444-4444-4444-8444-444444444444','viewer@example.com');
      INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES ('workspace-a','${USER_ID}','viewer');
      INSERT INTO companies(id,workspace_id,name) VALUES ('company-a','workspace-a','Visible'),('company-b','workspace-b','Hidden');
      SET ROLE careeros_runtime;
      SELECT set_config('app.user_id','${USER_ID}',false);
      SELECT set_config('app.auth_subject','44444444-4444-4444-8444-444444444444',false);
    `);
    const visible = await database.query<{ name: string }>("SELECT name FROM companies ORDER BY name");
    expect(visible.rows).toEqual([{ name: "Visible" }]);
    const denied = await database.exec("UPDATE companies SET name='Changed' WHERE id='company-a'");
    expect(denied[0].affectedRows).toBe(0);
    expect((await database.query<{ name: string }>("SELECT name FROM companies WHERE id='company-a'")).rows).toEqual([{ name: "Visible" }]);
    await database.exec("RESET ROLE");
    await database.close();
  });

  it("rejects cross-workspace foreign-key relationships for an authorised editor", async () => {
    const database = new PGlite();
    await database.exec(await readFile(CLOUD_FOUNDATION_MIGRATION, "utf8"));
    await database.exec(`
      INSERT INTO workspaces(id,name) VALUES ('workspace-a','A'),('workspace-b','B');
      INSERT INTO workspace_users(id,auth_subject,email) VALUES ('${USER_ID}','44444444-4444-4444-8444-444444444444','editor@example.com');
      INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES ('workspace-a','${USER_ID}','editor');
      INSERT INTO companies(id,workspace_id,name) VALUES ('company-b','workspace-b','Hidden parent');
      INSERT INTO job_postings(id,workspace_id,company_id,title) VALUES ('job-b','workspace-b','company-b','Other workspace job');
      SET ROLE careeros_runtime;
      SELECT set_config('app.user_id','${USER_ID}',false);
      SELECT set_config('app.auth_subject','44444444-4444-4444-8444-444444444444',false);
    `);
    await expect(database.exec("INSERT INTO applications(id,workspace_id,job_posting_id) VALUES ('app-a','workspace-a','job-b')"))
      .rejects.toThrow(/foreign key|violates/i);
    await database.exec("RESET ROLE");
    await database.close();
  });

  it("workspace-scopes every launch-critical shared table and forces RLS", async () => {
    const sql = await readFile(CLOUD_FOUNDATION_MIGRATION, "utf8");
    const tables = [
      "workspace_memberships", "workspace_invites", "workspace_comments", "workspace_presence", "audit_events",
      "companies", "job_postings", "applications", "application_events", "documents", "document_versions", "document_drafts",
      "application_materials", "capture_queue_items", "discovery_sources", "discovery_runs", "discovered_postings",
      "discovery_observations", "discovery_posting_aliases", "alert_rules", "alert_events", "notification_deliveries",
    ];
    for (const table of tables) {
      const definition = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`))?.[1] ?? "";
      expect(definition, `${table} definition`).toContain("workspace_id text NOT NULL");
      expect(sql).toContain(`'${table}'`);
    }
    expect(sql).toContain("ALTER TABLE %I ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE %I FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("request.jwt.claim.sub");
    expect(sql).toContain("careeros.can_access_workspace");
    expect(sql).toContain("application_events_immutable");
    expect(sql).toContain("discovery_observations_immutable");
  });

  it("keeps invitation secrets owner-only and presence writes actor-owned", async () => {
    const sql = await readFile(CLOUD_FOUNDATION_MIGRATION, "utf8");
    expect(sql).toContain("ARRAY['workspace_invites','workspace_invite_sessions']");
    expect(sql).toContain("careeros.is_workspace_owner(workspace_id)");
    expect(sql).toContain("user_id=careeros.current_actor_id()");
    expect(sql).toContain("'workspace_comments','audit_events'");
  });

  it("covers every persistent SQLite table and forces workspace RLS", async () => {
    const database = new PGlite();
    await applyAll(database);
    const expectedTables = [
      "companies", "job_postings", "applications", "application_events", "source_documents", "import_runs", "ai_runs", "field_evidence",
      "tasks", "salary_estimates", "salary_research_evidence", "contacts", "application_contacts", "tags", "job_tags", "career_tracks",
      "job_tracks", "skills", "job_skills", "projects", "project_skills", "project_tracks", "learning_items", "learning_skills", "goals",
      "profiles", "profile_evidence", "documents", "document_versions", "document_drafts", "application_materials", "capture_queue_items",
      "capture_drafts", "discovery_sources", "discovery_runs", "discovered_postings", "discovery_observations", "discovery_posting_aliases",
      "discovery_issues", "alert_rules", "alert_events", "notification_deliveries", "notification_delivery_attempts", "backup_records", "workspaces", "workspace_users", "workspace_memberships",
      "workspace_invites", "workspace_invite_sessions", "workspace_comments", "audit_events",
      "realtime_membership_outbox",
      "telegram_integrations",
    ];
    const tables = await database.query<{ table_name: string; rowsecurity: boolean; forcerowsecurity: boolean }>(`
      SELECT c.relname AS table_name,c.relrowsecurity AS rowsecurity,c.relforcerowsecurity AS forcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r'
    `);
    const byName = new Map(tables.rows.map((row) => [row.table_name, row]));
    for (const table of expectedTables) {
      expect(byName.has(table), `${table} exists`).toBe(true);
      expect(byName.get(table)?.rowsecurity, `${table} RLS enabled`).toBe(true);
      expect(byName.get(table)?.forcerowsecurity, `${table} RLS forced`).toBe(true);
    }
    const migrations = await database.query<{ version: string; checksum: string }>("SELECT version,checksum FROM careeros.schema_migrations ORDER BY version");
    expect(migrations.rows.map((row) => row.version)).toEqual([
      "0001_cloud_foundation",
      "0002_complete_workspace",
      "0003_notification_delivery_history",
      "0004_schema_identity_repairs",
      "0005_realtime_outbox",
      "0006_rapid_capture",
      "0007_realtime_membership_attempts",
      "0008_workspace_telegram_discovery_hardening",
      "0009_telegram_delivery_safety",
      "0010_discovery_reliability",
      "0011_discovery_backoff",
      "0012_document_version_immutability",
      "0013_document_version_pdf_atomicity",
    ]);
    expect(migrations.rows.every((row) => /^[a-f0-9]{64}$/.test(row.checksum))).toBe(true);
    await database.close();
  });

  it("rejects cross-workspace links in newly added relationship tables", async () => {
    const database = new PGlite();
    await applyAll(database);
    await database.exec(`
      INSERT INTO workspaces(id,name) VALUES ('workspace-a','A'),('workspace-b','B');
      INSERT INTO workspace_users(id,auth_subject,email) VALUES ('${USER_ID}','44444444-4444-4444-8444-444444444444','editor@example.com');
      INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES ('workspace-a','${USER_ID}','editor');
      INSERT INTO companies(id,workspace_id,name) VALUES ('company-a','workspace-a','A'),('company-b','workspace-b','B');
      INSERT INTO job_postings(id,workspace_id,company_id,title) VALUES ('job-a','workspace-a','company-a','A'),('job-b','workspace-b','company-b','B');
      INSERT INTO tags(id,workspace_id,name) VALUES ('tag-b','workspace-b','Hidden');
      SET ROLE careeros_runtime;
      SELECT set_config('app.user_id','${USER_ID}',false);
      SELECT set_config('app.auth_subject','44444444-4444-4444-8444-444444444444',false);
    `);
    await expect(database.exec("INSERT INTO job_tags(workspace_id,job_posting_id,tag_id) VALUES ('workspace-a','job-a','tag-b')"))
      .rejects.toThrow(/foreign key|violates/i);
    await database.exec("RESET ROLE");
    await database.close();
  });

  it("prevents invite sessions from referencing an invite in another workspace", async () => {
    const database = new PGlite();
    await applyAll(database);
    await database.exec(`
      INSERT INTO workspaces(id,name) VALUES ('workspace-a','A'),('workspace-b','B');
      INSERT INTO workspace_users(id,auth_subject,email) VALUES ('${USER_ID}','44444444-4444-4444-8444-444444444444','owner@example.com');
      INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES ('workspace-b','${USER_ID}','owner');
      INSERT INTO workspace_invites(id,workspace_id,email,role,token_hash,expires_at,created_by_user_id)
      VALUES ('invite-b','workspace-b','guest@example.com','viewer','hash-b',now() + interval '1 day','${USER_ID}');
    `);
    await expect(database.exec(`
      INSERT INTO workspace_invite_sessions(id_hash,workspace_id,invite_id,expires_at)
      VALUES ('session-a','workspace-a','invite-b',now() + interval '1 day')
    `)).rejects.toThrow(/foreign key|violates/i);
    await database.close();
  });

  it("replays the complete ordered migration set without schema drift", async () => {
    const database = new PGlite();
    await applyAll(database);
    await expect(applyAll(database)).resolves.toBeUndefined();
    const versions = await database.query<{ version: string }>("SELECT version FROM careeros.schema_migrations ORDER BY version");
    expect(versions.rows.map((row) => row.version)).toEqual([
      "0001_cloud_foundation",
      "0002_complete_workspace",
      "0003_notification_delivery_history",
      "0004_schema_identity_repairs",
      "0005_realtime_outbox",
      "0006_rapid_capture",
      "0007_realtime_membership_attempts",
      "0008_workspace_telegram_discovery_hardening",
      "0009_telegram_delivery_safety",
      "0010_discovery_reliability",
      "0011_discovery_backoff",
      "0012_document_version_immutability",
      "0013_document_version_pdf_atomicity",
    ]);
    await database.close();
  });

  it("keeps document snapshots immutable and finalises PDF metadata atomically", async () => {
    const database = new PGlite();
    await applyAll(database);
    await database.exec(`
      INSERT INTO workspaces(id,name) VALUES ('workspace-a','A');
      INSERT INTO companies(id,workspace_id,name) VALUES ('company-a','workspace-a','A');
      INSERT INTO job_postings(id,workspace_id,company_id,title) VALUES ('job-a','workspace-a','company-a','Role');
      INSERT INTO documents(id,workspace_id,document_type,title) VALUES ('document-a','workspace-a','cv','CV');
      INSERT INTO document_versions(id,workspace_id,document_id,job_posting_id,version,plain_text,checksum)
      VALUES ('version-a','workspace-a','document-a','job-a',1,'Original',repeat('c',64));
    `);
    await expect(database.exec("UPDATE document_versions SET plain_text='Changed' WHERE id='version-a'"))
      .rejects.toThrow(/immutable/i);
    await expect(database.exec("UPDATE document_versions SET checksum=repeat('a',64) WHERE id='version-a'"))
      .rejects.toThrow(/atomically/i);
    await expect(database.exec("UPDATE document_versions SET relative_path='documents/version-a.pdf',checksum='' WHERE id='version-a'"))
      .rejects.toThrow(/atomically/i);
    await expect(database.exec("UPDATE document_versions SET relative_path='documents/version-a.pdf',checksum=repeat('a',64) WHERE id='version-a'"))
      .resolves.toBeDefined();
    await expect(database.exec("UPDATE document_versions SET checksum=repeat('b',64) WHERE id='version-a'"))
      .rejects.toThrow(/atomically/i);
    await expect(database.exec("UPDATE document_versions SET submitted_at=now() WHERE id='version-a'"))
      .resolves.toBeDefined();
    await expect(database.exec("UPDATE document_versions SET submitted_at=NULL WHERE id='version-a'"))
      .rejects.toThrow(/submission is immutable/i);
    await expect(database.exec("DELETE FROM document_versions WHERE id='version-a'"))
      .rejects.toThrow(/immutable/i);
    await database.close();
  });

  it("uses SQLite progress units and scopes notification attempts with app.workspace_id", async () => {
    const database = new PGlite();
    await applyAll(database);
    await database.exec(`
      INSERT INTO workspaces(id,name) VALUES ('workspace-a','A'),('workspace-b','B');
      INSERT INTO workspace_users(id,auth_subject,email) VALUES ('${USER_ID}','44444444-4444-4444-8444-444444444444','editor@example.com');
      INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES ('workspace-a','${USER_ID}','editor');
      INSERT INTO capture_queue_items(id,workspace_id,source_type,progress) VALUES ('capture-a','workspace-a','pasted_text',10000);
      INSERT INTO alert_events(id,workspace_id,event_type,title,body,deduplication_key,created_at)
      VALUES ('alert-a','workspace-a','New','A','A','dedupe-a',now()),('alert-b','workspace-b','New','B','B','dedupe-b',now());
      INSERT INTO notification_deliveries(id,workspace_id,alert_event_id,provider,created_at,updated_at)
      VALUES ('delivery-a','workspace-a','alert-a','telegram',now(),now()),('delivery-b','workspace-b','alert-b','telegram',now(),now());
      INSERT INTO notification_delivery_attempts(id,workspace_id,delivery_id,sequence,state)
      VALUES ('attempt-a','workspace-a','delivery-a',1,'Delivered'),('attempt-b','workspace-b','delivery-b',1,'Delivered');
    `);
    await expect(database.exec("INSERT INTO capture_queue_items(id,workspace_id,source_type,progress) VALUES ('capture-b','workspace-a','pasted_text',10001)"))
      .rejects.toThrow(/check constraint|violates/i);
    await database.exec(`
      SET ROLE careeros_runtime;
      SELECT set_config('app.user_id','${USER_ID}',false);
      SELECT set_config('app.auth_subject','44444444-4444-4444-8444-444444444444',false);
      SELECT set_config('app.workspace_id','workspace-b',false);
    `);
    expect((await database.query<{ id: string }>("SELECT id FROM notification_delivery_attempts")).rows).toEqual([]);
    await database.exec("SELECT set_config('app.workspace_id','workspace-a',false)");
    expect((await database.query<{ id: string }>("SELECT id FROM notification_delivery_attempts")).rows).toEqual([{ id: "attempt-a" }]);
    await database.exec("RESET ROLE");
    await database.close();
  });

  it("workspace-isolates immutable backup recovery history and keeps object paths unique per workspace", async () => {
    const database = new PGlite();
    await applyAll(database);
    await database.exec(`
      INSERT INTO workspaces(id,name) VALUES ('workspace-a','A'),('workspace-b','B');
      INSERT INTO workspace_users(id,auth_subject,email) VALUES ('${USER_ID}','44444444-4444-4444-8444-444444444444','editor@example.com');
      INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES ('workspace-a','${USER_ID}','editor');
      INSERT INTO backup_records(id,workspace_id,object_path,checksum,size_bytes)
      VALUES ('backup-a','workspace-a','backups/a.enc','hash-a',10),('backup-b','workspace-b','backups/b.enc','hash-b',20);
      SET ROLE careeros_runtime;
      SELECT set_config('app.user_id','${USER_ID}',false);
      SELECT set_config('app.auth_subject','44444444-4444-4444-8444-444444444444',false);
    `);
    expect((await database.query<{ id: string }>("SELECT id FROM backup_records ORDER BY id")).rows).toEqual([{ id: "backup-a" }]);
    const update = await database.exec("UPDATE backup_records SET checksum='changed' WHERE id='backup-a'");
    expect(update[0].affectedRows).toBe(0);
    expect((await database.query<{ checksum: string }>("SELECT checksum FROM backup_records WHERE id='backup-a'")).rows[0].checksum).toBe("hash-a");
    await expect(database.exec("INSERT INTO backup_records(id,workspace_id,object_path,checksum,size_bytes) VALUES ('wrong','workspace-b','backups/c.enc','hash',1)"))
      .rejects.toThrow(/row-level security|policy/i);
    await database.exec("RESET ROLE");
    await expect(database.exec("INSERT INTO backup_records(id,workspace_id,object_path,checksum,size_bytes) VALUES ('same-path-other-workspace','workspace-b','backups/a.enc','hash',1)"))
      .resolves.toBeDefined();
    await expect(database.exec("INSERT INTO backup_records(id,workspace_id,object_path,checksum,size_bytes) VALUES ('duplicate','workspace-a','backups/a.enc','hash',1)"))
      .rejects.toThrow(/unique|duplicate/i);
    await database.close();
  });
});

describe("revision-aware PostgreSQL repository", () => {
  type RecordRow = {
    id: string; workspaceId: string; name: string; createdAt: Date; updatedAt: Date; deletedAt: Date | null; revision: number;
  };
  const map = (row: Record<string, unknown>): RecordRow => ({
    id: String(row.id), workspaceId: String(row.workspace_id), name: String(row.name),
    createdAt: new Date(String(row.created_at)), updatedAt: new Date(String(row.updated_at)),
    deletedAt: row.deleted_at ? new Date(String(row.deleted_at)) : null, revision: Number(row.revision),
  });
  const repository = new PostgresRevisionRepository<RecordRow, { id: string; name: string }, { name?: string }>({
    table: "companies", createColumns: ["id", "name"], mutableColumns: ["name"], mapRow: map,
  });

  it("uses workspace and expected revision in one atomic update", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly SqlValue[]) => result([{
      id: RECORD_ID, workspace_id: WORKSPACE_ID, name: "New", created_at: "2026-08-09T00:00:00Z",
      updated_at: "2026-08-09T00:01:00Z", deleted_at: null, revision: 4,
    }]));
    const updated = await repository.update({ query } as QueryExecutor, WORKSPACE_ID, RECORD_ID, 3, { name: "New" });
    expect(updated).toMatchObject({ status: "updated", record: { revision: 4, name: "New" } });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain("workspace_id=$2 AND id=$3 AND revision=$4");
    expect(query.mock.calls[0][1]).toEqual(["New", WORKSPACE_ID, RECORD_ID, 3]);
  });

  it("distinguishes a stale revision from a missing record", async () => {
    const stale = vi.fn()
      .mockResolvedValueOnce(result([], 0))
      .mockResolvedValueOnce(result([{ revision: 8 }]));
    await expect(repository.update({ query: stale } as QueryExecutor, WORKSPACE_ID, RECORD_ID, 7, { name: "Stale" }))
      .resolves.toEqual({ status: "conflict", currentRevision: 8 });

    const missing = vi.fn().mockResolvedValue(result([], 0));
    await expect(repository.update({ query: missing } as QueryExecutor, WORKSPACE_ID, RECORD_ID, 7, { name: "Missing" }))
      .resolves.toEqual({ status: "not_found" });
  });

  it("rejects unapproved columns before sending SQL", async () => {
    const query = vi.fn();
    await expect(repository.update({ query } as unknown as QueryExecutor, WORKSPACE_ID, RECORD_ID, 1, { revision: 100 } as never))
      .rejects.toThrow("Unsupported revision fields");
    expect(query).not.toHaveBeenCalled();
  });
});

describe("lease-safe PostgreSQL discovery scheduling", () => {
  const context: WorkspaceContext = { workspaceId: WORKSPACE_ID, userId: USER_ID, authSubject: "44444444-4444-4444-8444-444444444444" };

  it("claims due sources with row locks, skip-locked behavior, and token ownership", async () => {
    const query = vi.fn(async (_sql: string, values?: readonly SqlValue[]) => result([{
      source_id: "source-1", lease_token: values?.[2], lease_until: "2026-08-09T12:05:00Z", revision: 2,
    }]));
    const manager: TransactionManager = { transaction: async (_context, work) => work({ query } as QueryExecutor) };
    const leases = await new PostgresDiscoveryLeaseRepository(manager).claimDue(context, { limit: 5, leaseSeconds: 120, token: "55555555-5555-4555-8555-555555555555" });
    expect(leases).toEqual([{ sourceId: "source-1", leaseToken: "55555555-5555-4555-8555-555555555555", leaseUntil: new Date("2026-08-09T12:05:00Z"), revision: 2 }]);
    expect(query.mock.calls[0][0]).toContain("FOR UPDATE SKIP LOCKED");
    expect(query.mock.calls[0][0]).toContain("lease_until IS NULL OR lease_until <= now()");
    expect(query.mock.calls[0][1]).toEqual([WORKSPACE_ID, 5, "55555555-5555-4555-8555-555555555555", 120]);
  });

  it("renews and releases only the caller's live lease token", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce(result([], 1))
      .mockResolvedValueOnce(result([], 0));
    const executor = { query } as QueryExecutor;
    const manager: TransactionManager = { transaction: async (_context, work) => work(executor) };
    const leases = new PostgresDiscoveryLeaseRepository(manager);
    await expect(leases.renew(executor, WORKSPACE_ID, "source-1", "owned-token", 60)).resolves.toBe(true);
    await expect(leases.release(executor, WORKSPACE_ID, "source-1", "wrong-token")).resolves.toBe(false);
    expect(query.mock.calls[0][0]).toContain("lease_token=$3 AND lease_until > now()");
    expect(query.mock.calls[1][0]).toContain("lease_token=$3");
  });
});
