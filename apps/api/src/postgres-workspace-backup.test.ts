import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPostgresWorkspaceBundle,
  encodePostgresWorkspaceBundle,
  POSTGRES_SECRET_TABLES,
  restorePostgresWorkspaceBundle,
  type PostgresWorkspaceBundle,
} from "./postgres-workspace-backup.js";
import type { CloudDataProvider, QueryExecutor, QueryResult, SqlValue, TransactionOptions, WorkspaceContext } from "./postgres/contracts.js";
import { discoverCloudMigrations } from "./postgres/migrations.js";
import { ObjectStorageError, sha256, type ObjectStorageAdapter, type StoredObject, type StoredObjectMetadata } from "./storage/object-storage.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const SUBJECT = "33333333-3333-4333-8333-333333333333";
const context = { workspaceId: WORKSPACE, userId: USER, authSubject: SUBJECT };
const SCHEMA_VERSION = "0010_discovery_reliability";
const APP_VERSION = "0.1.0";

function executor(database: PGlite): QueryExecutor {
  return {
    async query<Row extends Record<string, unknown>>(text: string, values: readonly SqlValue[] = []) {
      const result = await database.query<Row>(text, values as unknown[]);
      return { rows: result.rows, rowCount: result.rows.length || (result.affectedRows ?? 0) } satisfies QueryResult<Row>;
    },
  };
}

class PgliteProvider implements CloudDataProvider {
  readonly provider = "postgresql" as const;
  constructor(readonly database: PGlite) {}
  readonly transactionOptions: TransactionOptions[] = [];
  async transaction<T>(workspace: WorkspaceContext, work: (tx: QueryExecutor) => Promise<T>, options: TransactionOptions = {}) {
    this.transactionOptions.push(options);
    await this.database.exec("BEGIN");
    try {
      await this.database.exec("SET LOCAL ROLE careeros_runtime");
      await this.database.query(
        "SELECT set_config('app.workspace_id',$1,true),set_config('app.user_id',$2,true),set_config('app.auth_subject',$3,true)",
        [workspace.workspaceId, workspace.userId, workspace.authSubject ?? ""],
      );
      const result = await work(executor(this.database));
      await this.database.exec("COMMIT");
      return result;
    } catch (error) {
      await this.database.exec("ROLLBACK");
      throw error;
    }
  }
  async close() { await this.database.close(); }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}

function hashJson(value: unknown) { return createHash("sha256").update(stableJson(value)).digest("hex"); }

function rehashBundle(bundle: PostgresWorkspaceBundle) {
  for (const table of bundle.tables) table.sha256 = hashJson(table.rows);
  bundle.manifest.tables = bundle.tables.map((table) => ({ name: table.name, rowCount: table.rows.length, sha256: table.sha256 }));
  bundle.manifest.structuredDataSha256 = hashJson(bundle.tables.map(({ name, rows }) => ({ name, rows })));
}

class MemoryObjectStorage implements ObjectStorageAdapter {
  readonly objects = new Map<string, StoredObject>();
  key(workspaceId: string, path: string) { return `${workspaceId}:${path}`; }
  async upload(input: { workspaceId: string; path: string; bytes: Uint8Array; contentType?: string }): Promise<StoredObjectMetadata> {
    const key = this.key(input.workspaceId, input.path);
    const checksum = sha256(input.bytes);
    const existing = this.objects.get(key);
    if (existing && existing.checksum !== checksum) throw new ObjectStorageError("conflict", "Object already exists.");
    const stored = { ...input, bytes: new Uint8Array(input.bytes), checksum, sizeBytes: input.bytes.byteLength };
    this.objects.set(key, stored);
    const { bytes: _bytes, ...metadata } = stored;
    return metadata;
  }
  async read(input: { workspaceId: string; path: string; expectedChecksum: string }): Promise<StoredObject> {
    const object = this.objects.get(this.key(input.workspaceId, input.path));
    if (!object) throw new ObjectStorageError("not_found", "Object not found.");
    if (object.checksum !== input.expectedChecksum) throw new ObjectStorageError("checksum_mismatch", "Checksum mismatch.");
    return { ...object, bytes: new Uint8Array(object.bytes) };
  }
  async delete(input: { workspaceId: string; path: string }) { this.objects.delete(this.key(input.workspaceId, input.path)); }
}

async function databaseWithWorkspace() {
  const database = new PGlite();
  for (const migration of await discoverCloudMigrations()) await database.exec(migration.sql);
  await database.query("INSERT INTO workspaces(id,name) VALUES($1,'CareerOS')", [WORKSPACE]);
  await database.query("INSERT INTO workspace_users(id,auth_subject,email,display_name) VALUES($1,$2::uuid,'zain@example.com','Zain')", [USER, SUBJECT]);
  await database.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')", [WORKSPACE, USER]);
  return database;
}

async function seedWorkspace(database: PGlite, storage: MemoryObjectStorage) {
  const cv = Buffer.from("private cv bytes");
  const snapshot = Buffer.from("immutable submitted cv");
  await storage.upload({ workspaceId: WORKSPACE, path: "documents/master.pdf", bytes: cv, contentType: "application/pdf" });
  await storage.upload({ workspaceId: WORKSPACE, path: "documents/submitted.pdf", bytes: snapshot, contentType: "application/pdf" });
  await database.query("INSERT INTO companies(id,workspace_id,name,snapshot) VALUES('company-1',$1,'Acme','Finance')", [WORKSPACE]);
  await database.query("INSERT INTO job_postings(id,workspace_id,company_id,title,source_url) VALUES('job-1',$1,'company-1','Quant Trader','https://example.com/job')", [WORKSPACE]);
  await database.query("INSERT INTO applications(id,workspace_id,job_posting_id,current_status) VALUES('application-1',$1,'job-1','Applied')", [WORKSPACE]);
  await database.query("INSERT INTO application_events(id,workspace_id,application_id,type,status_after,occurred_at,note) VALUES('event-1',$1,'application-1','Application submitted','Applied','2026-08-09T10:00:00Z','Submitted')", [WORKSPACE]);
  await database.query("INSERT INTO profiles(id,workspace_id,name,headline,summary) VALUES('profile-1',$1,'Zain Ahmad','Design Engineer','Profile')", [WORKSPACE]);
  await database.query("INSERT INTO documents(id,workspace_id,document_type,title,relative_path,checksum,mime_type,size_bytes) VALUES('document-1',$1,'cv','Master CV','documents/master.pdf',$2,'application/pdf',$3)", [WORKSPACE, sha256(cv), cv.byteLength]);
  await database.query("INSERT INTO document_versions(id,workspace_id,document_id,job_posting_id,version,relative_path,checksum,plain_text) VALUES('version-1',$1,'document-1','job-1',1,'documents/submitted.pdf',$2,'Submitted CV')", [WORKSPACE, sha256(snapshot)]);
  await database.query("INSERT INTO application_materials(id,workspace_id,application_id,document_id,document_version_id,material_type,title) VALUES('material-1',$1,'application-1','document-1','version-1','cv','Submitted CV')", [WORKSPACE]);
  await database.query("INSERT INTO workspace_invites(id,workspace_id,email,role,token_hash,expires_at,created_by_user_id) VALUES('invite-secret',$1,'private@example.com','viewer','secret-hash',now()+interval '1 day',$2)", [WORKSPACE, USER]);
}

async function bundleFrom(database: PGlite, storage: MemoryObjectStorage) {
  return createPostgresWorkspaceBundle({ provider: new PgliteProvider(database), storage, context, schemaVersion: SCHEMA_VERSION, applicationVersion: APP_VERSION, exportedAt: "2026-08-09T12:00:00.000Z" });
}

describe("PostgreSQL workspace backup and restore", () => {
  it("explicitly excludes workspace Telegram credentials from portable backups", () => {
    expect(POSTGRES_SECRET_TABLES.has("telegram_integrations")).toBe(true);
  });

  const databases: PGlite[] = [];
  let source: PGlite;
  let sourceStorage: MemoryObjectStorage;

  beforeEach(async () => {
    source = await databaseWithWorkspace();
    databases.push(source);
    sourceStorage = new MemoryObjectStorage();
    await seedWorkspace(source, sourceStorage);
  }, 30_000);

  afterEach(async () => { await Promise.all(databases.splice(0).map((database) => database.close())); });

  async function target() {
    const database = await databaseWithWorkspace();
    databases.push(database);
    return { database, provider: new PgliteProvider(database), storage: new MemoryObjectStorage() };
  }

  it("round-trips structured data, immutable history, and associated document bytes", async () => {
    const first = await bundleFrom(source, sourceStorage);
    const destination = await target();
    const result = await restorePostgresWorkspaceBundle({ provider: destination.provider, storage: destination.storage, context, bundle: encodePostgresWorkspaceBundle(first), expectedSchemaVersion: SCHEMA_VERSION, expectedApplicationVersion: APP_VERSION, restoreId: "round-trip" });
    expect(result).toMatchObject({ restoredFiles: 2, restoredTables: first.tables.length });
    expect((await destination.database.query<{ note: string }>("SELECT note FROM application_events WHERE workspace_id=$1", [WORKSPACE])).rows).toEqual([{ note: "Submitted" }]);
    expect((await destination.database.query<{ relative_path: string }>("SELECT relative_path FROM document_versions WHERE id='version-1'", [])).rows[0].relative_path).toBe("restores/round-trip/documents/submitted.pdf");
    await expect(destination.storage.read({ workspaceId: WORKSPACE, path: "restores/round-trip/documents/master.pdf", expectedChecksum: first.manifest.files.find((file) => file.path === "documents/master.pdf")!.sha256 })).resolves.toMatchObject({ sizeBytes: 16 });
    const second = await bundleFrom(destination.database, destination.storage);
    const withoutPaths = (bundle: PostgresWorkspaceBundle) => bundle.tables.map((table) => ({ name: table.name, rows: table.rows.map((row) => ({ ...row, ...(row.relative_path ? { relative_path: String(row.relative_path).replace("restores/round-trip/", "") } : {}) })) }));
    expect(withoutPaths(second)).toEqual(withoutPaths(first));
    expect(first.tables.some((table) => table.name === "workspace_invites")).toBe(false);
    expect(JSON.stringify(first)).not.toContain("secret-hash");
  }, 30_000);

  it("rejects tampered structured data before database or object writes", async () => {
    const bundle = await bundleFrom(source, sourceStorage);
    const company = bundle.tables.find((table) => table.name === "companies")!;
    company.rows[0].name = "Tampered";
    const destination = await target();
    await expect(restorePostgresWorkspaceBundle({ provider: destination.provider, storage: destination.storage, context, bundle, expectedSchemaVersion: SCHEMA_VERSION, expectedApplicationVersion: APP_VERSION })).rejects.toThrow(/checksum/i);
    expect((await destination.database.query<{ count: number }>("SELECT count(*)::int AS count FROM companies WHERE workspace_id=$1", [WORKSPACE])).rows[0].count).toBe(0);
    expect(destination.storage.objects.size).toBe(0);
  });

  it("rejects unsafe restored alert links during non-destructive preflight", async () => {
    await source.query(`INSERT INTO alert_events(id,workspace_id,event_type,title,body,direct_url,deduplication_key)
      VALUES('unsafe-alert',$1,'test','Test','Body','https://example.com/safe','unsafe-link-test')`, [WORKSPACE]);
    const bundle = await bundleFrom(source, sourceStorage);
    const alerts = bundle.tables.find((table) => table.name === "alert_events")!;
    alerts.rows.find((row) => row.id === "unsafe-alert")!.direct_url = "javascript:alert(document.cookie)";
    rehashBundle(bundle);
    const destination = await target();
    await expect(restorePostgresWorkspaceBundle({
      provider: destination.provider, storage: destination.storage, context, bundle,
      expectedSchemaVersion: SCHEMA_VERSION, expectedApplicationVersion: APP_VERSION,
    })).rejects.toThrow(/unsafe alert link/i);
    expect((await destination.database.query<{ count: number }>("SELECT count(*)::int AS count FROM alert_events WHERE workspace_id=$1", [WORKSPACE])).rows[0].count).toBe(0);
    expect(destination.storage.objects.size).toBe(0);
  });

  it("rejects schema and application version mismatches before writes", async () => {
    const bundle = await bundleFrom(source, sourceStorage);
    const destination = await target();
    await expect(restorePostgresWorkspaceBundle({ provider: destination.provider, storage: destination.storage, context, bundle, expectedSchemaVersion: "0008_future", expectedApplicationVersion: APP_VERSION })).rejects.toThrow(/schema version/i);
    await expect(restorePostgresWorkspaceBundle({ provider: destination.provider, storage: destination.storage, context, bundle, expectedSchemaVersion: SCHEMA_VERSION, expectedApplicationVersion: "9.0.0" })).rejects.toThrow(/application version/i);
    expect(destination.storage.objects.size).toBe(0);
  });

  it("rejects a missing associated file before writes", async () => {
    const bundle = await bundleFrom(source, sourceStorage);
    delete bundle.files["documents/master.pdf"];
    const destination = await target();
    await expect(restorePostgresWorkspaceBundle({ provider: destination.provider, storage: destination.storage, context, bundle, expectedSchemaVersion: SCHEMA_VERSION, expectedApplicationVersion: APP_VERSION })).rejects.toThrow(/file|unlisted|incomplete/i);
    expect((await destination.database.query<{ count: number }>("SELECT count(*)::int AS count FROM documents WHERE workspace_id=$1", [WORKSPACE])).rows[0].count).toBe(0);
    expect(destination.storage.objects.size).toBe(0);
  });

  it("refuses nested credential-shaped values and inconsistent document sizes during export", async () => {
    await source.query("INSERT INTO source_documents(id,workspace_id,source_type,raw_text,content_hash,captured_at,metadata) VALUES('source-secret',$1,'paste','text','hash',now(),$2::jsonb)", [WORKSPACE, JSON.stringify({ integration: { api_key: "must-not-export" } })]);
    await expect(bundleFrom(source, sourceStorage)).rejects.toThrow(/secret field api_key/i);
    await source.query("DELETE FROM source_documents WHERE id='source-secret'").catch(async () => {
      // The record is intentionally immutable; isolate the size check in a fresh source below.
    });
    const clean = await databaseWithWorkspace();
    databases.push(clean);
    const storage = new MemoryObjectStorage();
    await seedWorkspace(clean, storage);
    await clean.query("UPDATE documents SET size_bytes=size_bytes+1 WHERE id='document-1'");
    await expect(bundleFrom(clean, storage)).rejects.toThrow(/recorded size/i);
  }, 30_000);

  it("rejects broad secret-key variants while allowing harmless token metrics", async () => {
    await source.query("INSERT INTO source_documents(id,workspace_id,source_type,raw_text,content_hash,captured_at,metadata) VALUES('source-metrics',$1,'paste','text','hash',now(),$2::jsonb)", [WORKSPACE, JSON.stringify({ token_count: 42, authorization_url: "https://example.com/oauth" })]);
    await expect(bundleFrom(source, sourceStorage)).resolves.toBeTruthy();
    const variants = ["apiKey", "github_access_token", "databasePassword", "service-role-key", "clientSecret", "credentials", "auth_subject"];
    for (const [index, key] of variants.entries()) {
      const database = await databaseWithWorkspace();
      databases.push(database);
      const storage = new MemoryObjectStorage();
      await seedWorkspace(database, storage);
      await database.query("INSERT INTO source_documents(id,workspace_id,source_type,raw_text,content_hash,captured_at,metadata) VALUES($1,$2,'paste','text','hash',now(),$3::jsonb)", [`variant-${index}`, WORKSPACE, JSON.stringify({ nested: { [key]: "must-not-export" } })]);
      await expect(bundleFrom(database, storage)).rejects.toThrow(/secret field/i);
    }
  }, 30_000);

  it("rejects duplicate row IDs before uploading any object", async () => {
    const bundle = await bundleFrom(source, sourceStorage);
    const companies = bundle.tables.find((table) => table.name === "companies")!;
    companies.rows.push({ ...companies.rows[0] });
    rehashBundle(bundle);
    const destination = await target();
    await expect(restorePostgresWorkspaceBundle({ provider: destination.provider, storage: destination.storage, context, bundle, expectedSchemaVersion: SCHEMA_VERSION, expectedApplicationVersion: APP_VERSION })).rejects.toThrow(/duplicate row ID/i);
    expect(destination.storage.objects.size).toBe(0);
  });

  it("remaps missing collaborative user references to the authenticated restoring owner", async () => {
    await source.query("INSERT INTO workspace_comments(id,workspace_id,author_user_id,entity_type,entity_id,body) VALUES('comment-1',$1,$2,'JobPosting','job-1','Review this')", [WORKSPACE, USER]);
    await source.query("INSERT INTO audit_events(id,workspace_id,actor_user_id,action,entity_type,entity_id,summary) VALUES('audit-1',$1,$2,'test','JobPosting','job-1','Changed')", [WORKSPACE, USER]);
    await source.query("INSERT INTO capture_queue_items(id,workspace_id,source_type,raw_text,created_by_user_id) VALUES('capture-1',$1,'pasted_text','Role text',$2)", [WORKSPACE, USER]);
    const bundle = await bundleFrom(source, sourceStorage);
    const targetDatabase = new PGlite();
    databases.push(targetDatabase);
    for (const migration of await discoverCloudMigrations()) await targetDatabase.exec(migration.sql);
    const targetUser = "99999999-9999-4999-8999-999999999999";
    const targetSubject = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await targetDatabase.query("INSERT INTO workspaces(id,name) VALUES($1,'CareerOS')", [WORKSPACE]);
    await targetDatabase.query("INSERT INTO workspace_users(id,auth_subject,email,display_name) VALUES($1,$2::uuid,'owner@example.com','Owner')", [targetUser, targetSubject]);
    await targetDatabase.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')", [WORKSPACE, targetUser]);
    const provider = new PgliteProvider(targetDatabase);
    await restorePostgresWorkspaceBundle({ provider, storage: new MemoryObjectStorage(), context: { workspaceId: WORKSPACE, userId: targetUser, authSubject: targetSubject }, bundle, expectedSchemaVersion: SCHEMA_VERSION, expectedApplicationVersion: APP_VERSION, restoreId: "identity-remap" });
    expect((await targetDatabase.query<{ author_user_id: string }>("SELECT author_user_id FROM workspace_comments WHERE id='comment-1'")).rows[0].author_user_id).toBe(targetUser);
    expect((await targetDatabase.query<{ actor_user_id: string }>("SELECT actor_user_id FROM audit_events WHERE id='audit-1'")).rows[0].actor_user_id).toBe(targetUser);
    expect((await targetDatabase.query<{ created_by_user_id: string }>("SELECT created_by_user_id FROM capture_queue_items WHERE id='capture-1'")).rows[0].created_by_user_id).toBe(targetUser);
    expect(provider.transactionOptions.at(-1)?.workspaceLock).toBe("exclusive");
  }, 30_000);

  it("restores an in-flight capture as queued work instead of a lease-less extracting row", async () => {
    await source.query(`INSERT INTO capture_queue_items(id,workspace_id,source_type,raw_text,created_by_user_id,state,progress,progress_message,started_at,lease_token,lease_expires_at)
      VALUES('capture-active',$1,'pasted_text','Active role',$2,'Extracting',2500,'Extracting job details',now(),'11111111-1111-4111-8111-111111111111',now()+interval '2 minutes')`, [WORKSPACE, USER]);
    const bundle = await bundleFrom(source, sourceStorage);
    const destination = await target();
    await restorePostgresWorkspaceBundle({ provider: destination.provider, storage: destination.storage, context, bundle, expectedSchemaVersion: SCHEMA_VERSION, expectedApplicationVersion: APP_VERSION, restoreId: "active-capture" });
    const row = (await destination.database.query<{ state: string; progress: number; lease_token: string | null; lease_expires_at: string | null }>(
      "SELECT state,progress,lease_token,lease_expires_at FROM capture_queue_items WHERE id='capture-active'",
    )).rows[0];
    expect(row).toMatchObject({ state: "Queued", progress: 0, lease_token: null, lease_expires_at: null });
  }, 30_000);

  it("rolls back every database row and staged object when restore fails mid-transaction", async () => {
    const bundle = await bundleFrom(source, sourceStorage);
    const destination = await target();
    const failingProvider: CloudDataProvider = {
      provider: "postgresql",
      close: () => destination.provider.close(),
      transaction: (workspace, work, options) => destination.provider.transaction(workspace, (tx) => work({
        query: (sql, values) => sql.startsWith("INSERT INTO applications ") ? Promise.reject(new Error("Injected restore failure")) : tx.query(sql, values),
      }), options),
    };
    await expect(restorePostgresWorkspaceBundle({ provider: failingProvider, storage: destination.storage, context, bundle, expectedSchemaVersion: SCHEMA_VERSION, expectedApplicationVersion: APP_VERSION, restoreId: "rollback" })).rejects.toThrow("Injected restore failure");
    expect((await destination.database.query<{ count: number }>("SELECT count(*)::int AS count FROM companies WHERE workspace_id=$1", [WORKSPACE])).rows[0].count).toBe(0);
    expect((await destination.database.query<{ count: number }>("SELECT count(*)::int AS count FROM job_postings WHERE workspace_id=$1", [WORKSPACE])).rows[0].count).toBe(0);
    expect(destination.storage.objects.size).toBe(0);
  }, 30_000);

  it("does not delete a pre-existing matching restore object and surfaces cleanup failures", async () => {
    const bundle = await bundleFrom(source, sourceStorage);
    const destination = await target();
    const firstFile = bundle.manifest.files[0];
    const path = `restores/preexisting/${firstFile.path}`;
    await destination.storage.upload({ workspaceId: WORKSPACE, path, bytes: Buffer.from(bundle.files[firstFile.path], "base64"), contentType: firstFile.contentType });
    const failingProvider: CloudDataProvider = {
      provider: "postgresql", close: () => destination.provider.close(),
      transaction: (workspace, work, options) => destination.provider.transaction(workspace, (tx) => work({
        query: (sql, values) => sql.startsWith("INSERT INTO applications ") ? Promise.reject(new Error("Injected failure")) : tx.query(sql, values),
      }), options),
    };
    await expect(restorePostgresWorkspaceBundle({ provider: failingProvider, storage: destination.storage, context, bundle, expectedSchemaVersion: SCHEMA_VERSION, expectedApplicationVersion: APP_VERSION, restoreId: "preexisting" })).rejects.toThrow("Injected failure");
    await expect(destination.storage.read({ workspaceId: WORKSPACE, path, expectedChecksum: firstFile.sha256 })).resolves.toMatchObject({ checksum: firstFile.sha256 });

    const cleanupFailingStorage: ObjectStorageAdapter = {
      upload: (input) => destination.storage.upload(input), read: (input) => destination.storage.read(input),
      delete: async () => { throw new Error("cleanup unavailable"); },
    };
    await expect(restorePostgresWorkspaceBundle({ provider: failingProvider, storage: cleanupFailingStorage, context, bundle, expectedSchemaVersion: SCHEMA_VERSION, expectedApplicationVersion: APP_VERSION, restoreId: "cleanup-failure" }))
      .rejects.toMatchObject({ cleanupFailures: expect.arrayContaining([expect.stringContaining("cleanup unavailable")]) });
  }, 30_000);

  it("round-trips a realistic workspace volume", async () => {
    const values: unknown[] = [];
    const tuples = Array.from({ length: 500 }, (_, index) => {
      values.push(`volume-company-${index}`, WORKSPACE, `Company ${index}`);
      const offset = index * 3;
      return `($${offset + 1},$${offset + 2},$${offset + 3})`;
    });
    await source.query(`INSERT INTO companies(id,workspace_id,name) VALUES ${tuples.join(",")}`, values);
    const bundle = await bundleFrom(source, sourceStorage);
    const destination = await target();
    const result = await restorePostgresWorkspaceBundle({ provider: destination.provider, storage: destination.storage, context, bundle, expectedSchemaVersion: SCHEMA_VERSION, expectedApplicationVersion: APP_VERSION, restoreId: "volume" });
    expect(result.restoredRows).toBeGreaterThan(500);
    expect((await destination.database.query<{ count: number }>("SELECT count(*)::int AS count FROM companies WHERE workspace_id=$1", [WORKSPACE])).rows[0].count).toBe(501);
  }, 30_000);

  it("supports explicit replacement of mutable workspace data", async () => {
    const bundle = await bundleFrom(source, sourceStorage);
    const destination = await target();
    await destination.database.query("INSERT INTO companies(id,workspace_id,name) VALUES('stale-company',$1,'Stale')", [WORKSPACE]);
    const result = await restorePostgresWorkspaceBundle({ provider: destination.provider, storage: destination.storage, context, bundle, expectedSchemaVersion: SCHEMA_VERSION, expectedApplicationVersion: APP_VERSION, mode: "replace", restoreId: "replace" });
    expect(result.restoredRows).toBeGreaterThan(0);
    expect((await destination.database.query<{ id: string }>("SELECT id FROM companies WHERE workspace_id=$1 AND deleted_at IS NULL ORDER BY id", [WORKSPACE])).rows).toEqual([{ id: "company-1" }]);
    expect((await destination.database.query<{ deleted_at: Date | null }>("SELECT deleted_at FROM companies WHERE workspace_id=$1 AND id='stale-company'", [WORKSPACE])).rows[0]?.deleted_at).not.toBeNull();
    expect((await destination.database.query<{ type: string }>("SELECT type FROM application_events WHERE workspace_id=$1", [WORKSPACE])).rows).toEqual([{ type: "Application submitted" }]);
  }, 30_000);

  it("rejects a preserved delivery ID whose alert relationship conflicts with the backup", async () => {
    await source.query("INSERT INTO alert_events(id,workspace_id,event_type,title,body,direct_url,deduplication_key) VALUES('alert-source',$1,'test','Source alert','Body','https://example.com/job','source-dedup')", [WORKSPACE]);
    await source.query("INSERT INTO notification_deliveries(id,workspace_id,alert_event_id,provider,state) VALUES('delivery-collision',$1,'alert-source','telegram','Delivered')", [WORKSPACE]);
    await source.query("INSERT INTO notification_delivery_attempts(id,workspace_id,delivery_id,sequence,state) VALUES('attempt-source',$1,'delivery-collision',1,'Delivered')", [WORKSPACE]);
    const bundle = await bundleFrom(source, sourceStorage);
    const destination = await target();
    await destination.database.query("INSERT INTO alert_events(id,workspace_id,event_type,title,body,direct_url,deduplication_key) VALUES('alert-other',$1,'test','Other alert','Body','https://example.com/other','other-dedup')", [WORKSPACE]);
    await destination.database.query("INSERT INTO notification_deliveries(id,workspace_id,alert_event_id,provider,state) VALUES('delivery-collision',$1,'alert-other','telegram','Delivered')", [WORKSPACE]);

    await expect(restorePostgresWorkspaceBundle({
      provider: destination.provider,
      storage: destination.storage,
      context,
      bundle,
      expectedSchemaVersion: SCHEMA_VERSION,
      expectedApplicationVersion: APP_VERSION,
      mode: "replace",
      restoreId: "identity-conflict",
    })).rejects.toThrow(/identity conflict.*notification_deliveries/i);
    expect((await destination.database.query<{ alert_event_id: string }>("SELECT alert_event_id FROM notification_deliveries WHERE id='delivery-collision'", [])).rows[0]?.alert_event_id).toBe("alert-other");
  }, 30_000);

  it("preserves newer delivery state while verifying the same parent identity", async () => {
    await source.query("INSERT INTO alert_events(id,workspace_id,event_type,title,body,direct_url,deduplication_key) VALUES('alert-stable',$1,'test','Stable alert','Body','https://example.com/job','stable-dedup')", [WORKSPACE]);
    await source.query("INSERT INTO notification_deliveries(id,workspace_id,alert_event_id,provider,state) VALUES('delivery-stable',$1,'alert-stable','telegram','Pending')", [WORKSPACE]);
    const bundle = await bundleFrom(source, sourceStorage);
    const destination = await target();
    await destination.database.query("INSERT INTO alert_events(id,workspace_id,event_type,title,body,direct_url,deduplication_key) VALUES('alert-stable',$1,'test','Stable alert','Body','https://example.com/job','stable-dedup')", [WORKSPACE]);
    await destination.database.query("INSERT INTO notification_deliveries(id,workspace_id,alert_event_id,provider,state,delivered_at) VALUES('delivery-stable',$1,'alert-stable','telegram','Delivered',now())", [WORKSPACE]);

    await restorePostgresWorkspaceBundle({
      provider: destination.provider,
      storage: destination.storage,
      context,
      bundle,
      expectedSchemaVersion: SCHEMA_VERSION,
      expectedApplicationVersion: APP_VERSION,
      mode: "replace",
      restoreId: "newer-delivery-state",
    });
    expect((await destination.database.query<{ state: string }>("SELECT state FROM notification_deliveries WHERE id='delivery-stable'", [])).rows[0]?.state).toBe("Delivered");
  }, 30_000);
});
