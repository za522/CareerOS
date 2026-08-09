import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import type { QueryExecutor, SqlValue } from "./contracts.js";
import { discoverCloudMigrations } from "./migrations.js";
import { migrateSqliteToPostgres, sqliteUserMappingsFromEnvironment, type AdministrativeTransactionManager } from "./sqlite-to-postgres.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const HOSTED_USER_ID = "22222222-2222-4222-8222-222222222222";
const HOSTED_GOOGLE_SUBJECT = "33333333-3333-4333-8333-333333333333";
const createdDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(createdDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function destination(database: PGlite): Promise<AdministrativeTransactionManager> {
  for (const migration of await discoverCloudMigrations()) await database.exec(migration.sql);
  return {
    async administrativeTransaction<T>(work: (transaction: QueryExecutor) => Promise<T>): Promise<T> {
      await database.exec("BEGIN");
      try {
        const result = await work({
          async query<Row extends Record<string, unknown>>(text: string, values: readonly SqlValue[] = []) {
            const response = await database.query<Row>(text, values as unknown[]);
            return { rows: response.rows, rowCount: response.rows.length || Number(response.affectedRows ?? 0) };
          },
        });
        await database.exec("COMMIT");
        return result;
      } catch (error) {
        await database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

async function fixture(): Promise<{ path: string; checksum: string }> {
  const directory = await mkdtemp(join(tmpdir(), "careeros-cloud-copy-"));
  createdDirectories.push(directory);
  const path = join(directory, "careeros.sqlite");
  const sqlite = new Database(path);
  sqlite.exec(`
    CREATE TABLE workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,revision INTEGER NOT NULL);
    CREATE TABLE companies(id TEXT PRIMARY KEY,name TEXT NOT NULL,snapshot TEXT NOT NULL,description TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,revision INTEGER NOT NULL);
    CREATE TABLE job_postings(id TEXT PRIMARY KEY,company_id TEXT NOT NULL,title TEXT NOT NULL,required_requirements TEXT NOT NULL,preferred_requirements TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,revision INTEGER NOT NULL);
    CREATE TABLE applications(id TEXT PRIMARY KEY,job_posting_id TEXT NOT NULL,current_status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,revision INTEGER NOT NULL);
    CREATE TABLE application_events(id TEXT PRIMARY KEY,application_id TEXT NOT NULL,type TEXT NOT NULL,status_after TEXT NOT NULL,occurred_at TEXT NOT NULL,note TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE source_documents(id TEXT PRIMARY KEY,source_type TEXT NOT NULL,url TEXT,raw_text TEXT NOT NULL,content_hash TEXT NOT NULL,captured_at TEXT NOT NULL,metadata TEXT NOT NULL);
    CREATE TABLE import_runs(id TEXT PRIMARY KEY,source_type TEXT NOT NULL,source_url TEXT,state TEXT NOT NULL,source_document_id TEXT,discovery_posting_id TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,revision INTEGER NOT NULL);
    CREATE TABLE tags(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,revision INTEGER NOT NULL);
    CREATE TABLE job_tags(job_posting_id TEXT NOT NULL,tag_id TEXT NOT NULL,PRIMARY KEY(job_posting_id,tag_id));
    CREATE TABLE documents(id TEXT PRIMARY KEY,document_type TEXT NOT NULL,title TEXT NOT NULL,relative_path TEXT NOT NULL,checksum TEXT NOT NULL,mime_type TEXT NOT NULL,size_bytes INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,revision INTEGER NOT NULL);
    CREATE TABLE capture_drafts(id TEXT PRIMARY KEY,source_type TEXT NOT NULL,value TEXT NOT NULL,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,revision INTEGER NOT NULL);
    CREATE TABLE backup_records(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,object_path TEXT NOT NULL UNIQUE,checksum TEXT NOT NULL,size_bytes INTEGER NOT NULL,created_at TEXT NOT NULL);
    INSERT INTO workspaces VALUES ('local-workspace','Local CareerOS','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z',NULL,1);
    INSERT INTO companies VALUES ('company-1','Amazon','','','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z',NULL,1);
    INSERT INTO job_postings VALUES ('job-1','company-1','Software Engineer','["TypeScript"]','[]','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z',NULL,1);
    INSERT INTO applications VALUES ('application-1','job-1','Applied','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z',NULL,1);
    INSERT INTO application_events VALUES ('event-1','application-1','Application submitted','Applied','2026-08-01T00:00:00Z','','2026-08-01T00:00:00Z');
    INSERT INTO source_documents VALUES ('source-1','pasted_text',NULL,'Job text','hash','2026-08-01T00:00:00Z','{"safe":true}');
    INSERT INTO import_runs VALUES ('import-1','pasted_text',NULL,'Committed','source-1',NULL,NULL,'2026-08-01T00:00:00Z','2026-08-01T00:00:00Z',NULL,1);
    INSERT INTO tags VALUES ('tag-1','Big tech','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z',NULL,1);
    INSERT INTO job_tags VALUES ('job-1','tag-1');
    INSERT INTO documents VALUES ('document-1','cv','Base CV','documents/base.pdf','abc','application/pdf',123,'2026-08-01T00:00:00Z','2026-08-01T00:00:00Z',NULL,1);
    INSERT INTO capture_drafts VALUES ('draft-1','pasted_text','Queued text',NULL,'2026-08-01T00:00:00Z','2026-08-01T00:00:00Z',NULL,1);
    INSERT INTO backup_records VALUES ('backup-1','local-workspace','backups/2026-08-01.careeros.enc','backup-checksum',456,'2026-08-01T00:00:00Z');
    INSERT INTO backup_records VALUES ('backup-other','other-workspace','backups/other.careeros.enc','other-checksum',999,'2026-08-01T00:00:00Z');
  `);
  sqlite.close();
  return { path, checksum: createHash("sha256").update(await readFile(path)).digest("hex") };
}

async function localIdentityFixture(): Promise<{ path: string; checksum: string }> {
  const directory = await mkdtemp(join(tmpdir(), "careeros-cloud-identity-copy-"));
  createdDirectories.push(directory);
  const path = join(directory, "careeros.sqlite");
  const sqlite = new Database(path);
  sqlite.exec(`
    CREATE TABLE workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,revision INTEGER NOT NULL);
    CREATE TABLE workspace_users(id TEXT PRIMARY KEY,auth_subject TEXT NOT NULL UNIQUE,email TEXT NOT NULL,display_name TEXT NOT NULL,avatar_url TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,revision INTEGER NOT NULL);
    CREATE TABLE workspace_memberships(workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(workspace_id,user_id));
    CREATE TABLE workspace_invites(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,email TEXT NOT NULL,role TEXT NOT NULL,token_hash TEXT NOT NULL,expires_at TEXT NOT NULL,accepted_at TEXT,revoked_at TEXT,created_by_user_id TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE workspace_comments(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,author_user_id TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,target_path TEXT NOT NULL,body TEXT NOT NULL,resolved_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,revision INTEGER NOT NULL);
    CREATE TABLE audit_events(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,actor_user_id TEXT,action TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,summary TEXT NOT NULL,metadata_json TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE capture_queue_items(id TEXT PRIMARY KEY,source_type TEXT NOT NULL,progress INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,revision INTEGER NOT NULL);
    INSERT INTO workspaces VALUES ('local-workspace','Local CareerOS','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z',NULL,1);
    INSERT INTO workspace_users VALUES ('local-development-user','local-development-user','owner@example.com','Local Owner','','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z',NULL,1);
    INSERT INTO workspace_memberships VALUES ('local-workspace','local-development-user','owner','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z');
    INSERT INTO workspace_invites VALUES ('invite-1','local-workspace','dad@example.com','editor','hash','2026-09-01T00:00:00Z',NULL,NULL,'local-development-user','2026-08-01T00:00:00Z');
    INSERT INTO workspace_comments VALUES ('comment-1','local-workspace','local-development-user','job_posting','job-1','','Review this',NULL,'2026-08-01T00:00:00Z','2026-08-01T00:00:00Z',NULL,1);
    INSERT INTO audit_events VALUES ('audit-1','local-workspace','local-development-user','created','workspace','local-workspace','','{}','2026-08-01T00:00:00Z');
    INSERT INTO capture_queue_items VALUES ('capture-1','pasted_text',10000,'2026-08-01T00:00:00Z','2026-08-01T00:00:00Z',NULL,1);
  `);
  sqlite.close();
  return { path, checksum: createHash("sha256").update(await readFile(path)).digest("hex") };
}

const identityMapping = [{
  localUserId: "local-development-user",
  hostedUserId: HOSTED_USER_ID,
  hostedGoogleSubject: HOSTED_GOOGLE_SUBJECT,
}];

describe("non-destructive SQLite to PostgreSQL migration", { timeout: 15_000 }, () => {
  it("parses single-user and multi-user identity mapping environment variables safely", () => {
    expect(sqliteUserMappingsFromEnvironment({
      CAREEROS_MIGRATION_LOCAL_USER_ID: "local-development-user",
      CAREEROS_MIGRATION_HOSTED_USER_ID: HOSTED_USER_ID,
      CAREEROS_MIGRATION_HOSTED_GOOGLE_SUBJECT: HOSTED_GOOGLE_SUBJECT,
    })).toEqual(identityMapping);
    expect(sqliteUserMappingsFromEnvironment({
      CAREEROS_MIGRATION_USER_MAPPINGS: JSON.stringify(identityMapping),
    })).toEqual(identityMapping);
    expect(() => sqliteUserMappingsFromEnvironment({
      CAREEROS_MIGRATION_LOCAL_USER_ID: "local-development-user",
    })).toThrow(/requires .*HOSTED_USER_ID.*HOSTED_GOOGLE_SUBJECT/i);
    expect(() => sqliteUserMappingsFromEnvironment({
      CAREEROS_MIGRATION_USER_MAPPINGS: "not-json",
    })).toThrow(/valid JSON/i);
  });

  it("copies representative launch data, validates every source key, and is idempotent", async () => {
    const source = await fixture();
    const database = new PGlite();
    const target = await destination(database);
    const first = await migrateSqliteToPostgres(target, { sqlitePath: source.path, workspaceId: WORKSPACE_ID });
    const second = await migrateSqliteToPostgres(target, { sqlitePath: source.path, workspaceId: WORKSPACE_ID });
    expect(first.totalRows).toBe(11);
    expect(first.tables.every((table) => table.sourceCount === table.validatedCount)).toBe(true);
    expect(second.totalRows).toBe(first.totalRows);
    expect(createHash("sha256").update(await readFile(source.path)).digest("hex")).toBe(source.checksum);
    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM job_postings WHERE workspace_id=$1", [WORKSPACE_ID])).rows[0].count).toBe(1);
    expect((await database.query<{ value: unknown }>("SELECT required_requirements AS value FROM job_postings WHERE id='job-1'")).rows[0].value).toEqual(["TypeScript"]);
    expect((await database.query<{ object_path: string }>("SELECT object_path FROM backup_records WHERE workspace_id=$1", [WORKSPACE_ID])).rows)
      .toEqual([{ object_path: "backups/2026-08-01.careeros.enc" }]);
    await database.close();
  }, 15_000);

  it("rolls cloud changes back on validation failure and never mutates SQLite", async () => {
    const source = await fixture();
    const database = new PGlite();
    const realTarget = await destination(database);
    const failing: AdministrativeTransactionManager = {
      administrativeTransaction: (work) => realTarget.administrativeTransaction(async (transaction) => work({
        query: (text, values) => text.startsWith('INSERT INTO "applications"') ? Promise.reject(new Error("simulated cloud failure")) : transaction.query(text, values),
      })),
    };
    await expect(migrateSqliteToPostgres(failing, { sqlitePath: source.path, workspaceId: WORKSPACE_ID })).rejects.toThrow("simulated cloud failure");
    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM workspaces")).rows[0].count).toBe(0);
    expect(createHash("sha256").update(await readFile(source.path)).digest("hex")).toBe(source.checksum);
    await database.close();
  });

  it("rejects an existing key with divergent content and rolls back every new row", async () => {
    const source = await fixture();
    const database = new PGlite();
    const target = await destination(database);
    await database.exec(`
      INSERT INTO workspaces(id,name,created_at,updated_at,revision)
      VALUES ('${WORKSPACE_ID}','Local CareerOS','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z',1);
      INSERT INTO companies(id,workspace_id,name,snapshot,description,created_at,updated_at,revision)
      VALUES ('company-1','${WORKSPACE_ID}','Conflicting name','','','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z',1);
    `);
    await expect(migrateSqliteToPostgres(target, { sqlitePath: source.path, workspaceId: WORKSPACE_ID }))
      .rejects.toThrow(/content conflict for companies/i);
    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM job_postings")).rows[0].count).toBe(0);
    expect((await database.query<{ name: string }>("SELECT name FROM companies WHERE id='company-1'")).rows[0].name).toBe("Conflicting name");
    expect(createHash("sha256").update(await readFile(source.path)).digest("hex")).toBe(source.checksum);
    await database.close();
  });

  it("fails before writing when a current local-development-user mapping is missing or invalid", async () => {
    const source = await localIdentityFixture();
    let transactionCalls = 0;
    const destinationProbe: AdministrativeTransactionManager = {
      async administrativeTransaction<T>(): Promise<T> {
        transactionCalls += 1;
        throw new Error("destination must not be reached");
      },
    };
    await expect(migrateSqliteToPostgres(destinationProbe, { sqlitePath: source.path, workspaceId: WORKSPACE_ID }))
      .rejects.toThrow(/explicit local-user mapping/i);
    await expect(migrateSqliteToPostgres(destinationProbe, {
      sqlitePath: source.path,
      workspaceId: WORKSPACE_ID,
      userMappings: [{ ...identityMapping[0], hostedGoogleSubject: "not-a-uuid" }],
    })).rejects.toThrow(/Google subject.*UUID/i);
    expect(transactionCalls).toBe(0);
    expect(createHash("sha256").update(await readFile(source.path)).digest("hex")).toBe(source.checksum);
  });

  it("remaps the local user and every user foreign key consistently, supports 10000 progress, and is idempotent", async () => {
    const source = await localIdentityFixture();
    const database = new PGlite();
    const target = await destination(database);
    const options = { sqlitePath: source.path, workspaceId: WORKSPACE_ID, userMappings: identityMapping };
    const first = await migrateSqliteToPostgres(target, options);
    const second = await migrateSqliteToPostgres(target, options);
    expect(second.totalRows).toBe(first.totalRows);
    expect(first.tables.every((table) => table.sourceCount === table.validatedCount)).toBe(true);
    expect((await database.query<{ id: string; auth_subject: string }>("SELECT id,auth_subject::text AS auth_subject FROM workspace_users")).rows)
      .toEqual([{ id: HOSTED_USER_ID, auth_subject: HOSTED_GOOGLE_SUBJECT }]);
    expect((await database.query<{ user_id: string }>("SELECT user_id FROM workspace_memberships WHERE workspace_id=$1", [WORKSPACE_ID])).rows[0].user_id).toBe(HOSTED_USER_ID);
    expect((await database.query<{ created_by_user_id: string }>("SELECT created_by_user_id FROM workspace_invites")).rows[0].created_by_user_id).toBe(HOSTED_USER_ID);
    expect((await database.query<{ author_user_id: string }>("SELECT author_user_id FROM workspace_comments")).rows[0].author_user_id).toBe(HOSTED_USER_ID);
    expect((await database.query<{ actor_user_id: string }>("SELECT actor_user_id FROM audit_events")).rows[0].actor_user_id).toBe(HOSTED_USER_ID);
    expect((await database.query<{ progress: number }>("SELECT progress FROM capture_queue_items")).rows[0].progress).toBe(10000);
    expect(createHash("sha256").update(await readFile(source.path)).digest("hex")).toBe(source.checksum);
    await database.close();
  });

  it("rolls back a mapped local-user migration failure and leaves the SQLite source unchanged", async () => {
    const source = await localIdentityFixture();
    const database = new PGlite();
    const realTarget = await destination(database);
    const failing: AdministrativeTransactionManager = {
      administrativeTransaction: (work) => realTarget.administrativeTransaction(async (transaction) => work({
        query: (text, values) => text.startsWith('INSERT INTO "workspace_comments"') ? Promise.reject(new Error("simulated mapped migration failure")) : transaction.query(text, values),
      })),
    };
    await expect(migrateSqliteToPostgres(failing, {
      sqlitePath: source.path,
      workspaceId: WORKSPACE_ID,
      userMappings: identityMapping,
    })).rejects.toThrow("simulated mapped migration failure");
    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM workspaces")).rows[0].count).toBe(0);
    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM workspace_users")).rows[0].count).toBe(0);
    expect(createHash("sha256").update(await readFile(source.path)).digest("hex")).toBe(source.checksum);
    await database.close();
  });
});
