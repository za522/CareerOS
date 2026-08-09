import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QueryExecutor, QueryResult, SqlValue, TransactionManager, WorkspaceContext } from "./postgres/contracts.js";
import { PostgresDiscoveryQueryRepository } from "./postgres-discovery-query.js";
import { discoverCloudMigrations } from "./postgres/migrations.js";

const context: WorkspaceContext = { workspaceId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222" };
let database: PGlite;

const executor = (): QueryExecutor => ({ async query<Row extends Record<string, unknown>>(text: string, values: readonly SqlValue[] = []) {
  const result = await database.query<Row>(text, values as unknown[]);
  return { rows: result.rows, rowCount: result.rows.length || (result.affectedRows ?? 0) } satisfies QueryResult<Row>;
} });

const transactions: TransactionManager = { async transaction<T>(_context: WorkspaceContext, work: (tx: QueryExecutor) => Promise<T>) { return work(executor()); } };

describe("hosted discovery query volume", () => {
  beforeAll(async () => {
    database = new PGlite();
    for (const migration of await discoverCloudMigrations()) await database.exec(migration.sql);
    await database.exec(`
      INSERT INTO workspaces(id,name) VALUES ('${context.workspaceId}','Performance');
      INSERT INTO workspace_users(id,auth_subject,email) VALUES ('${context.userId}','33333333-3333-4333-8333-333333333333','owner@example.com');
      INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES ('${context.workspaceId}','${context.userId}','owner');
      INSERT INTO discovery_sources(id,workspace_id,name,kind,company_name,source_url,external_key)
      VALUES ('source-volume','${context.workspaceId}','Volume','greenhouse','Volume Capital','https://boards-api.greenhouse.io/v1/boards/volume/jobs','volume');
      INSERT INTO discovered_postings(id,workspace_id,source_id,external_id,canonical_url,apply_url,company_name,title,location,role_family,description,first_seen_at,last_seen_at,last_checked_at,availability,content_hash)
      SELECT 'posting-'||g,'${context.workspaceId}','source-volume','external-'||g,'https://example.com/jobs/'||g,'https://example.com/jobs/'||g,
        CASE WHEN g=42424 THEN 'Needle Capital' ELSE 'Volume Capital' END,
        CASE WHEN g=42424 THEN 'Rare Quantum Markets Analyst' ELSE 'Graduate Analyst '||g END,
        CASE WHEN g%2=0 THEN 'London' ELSE 'Singapore' END,'Trading','Finance role '||g,
        now()-(g||' seconds')::interval,now(),now(),'Open',md5(g::text)
      FROM generate_series(1,50000) g;
      ANALYZE discovered_postings;
    `);
  }, 30_000);

  afterAll(async () => database.close());

  it("searches and paginates 50,000 hosted postings within an operational bound", async () => {
    const started = performance.now();
    const workspace = await new PostgresDiscoveryQueryRepository(transactions).workspace(context, { q: "Rare Quantum", location: "London", limit: 100 });
    expect(workspace.postingTotal).toBe(1);
    expect(workspace.postings[0]).toMatchObject({ companyName: "Needle Capital", title: "Rare Quantum Markets Analyst" });
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
