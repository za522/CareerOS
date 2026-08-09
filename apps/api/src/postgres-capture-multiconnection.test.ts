import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { jobDraftSchema, type ImportDraftResponse, type JobDraft } from "@careeros/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discoverCloudMigrations } from "./postgres/migrations.js";
import { PostgresCaptureRepository } from "./postgres-capture-repository.js";
import { PostgresCloudDataProvider } from "./postgres/provider.js";

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a PostgreSQL test port.");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe("PostgreSQL rapid capture with genuine concurrent connections", () => {
  const workspaceId = "00000000-0000-4000-8000-000000000091";
  const userId = "10000000-0000-4000-8000-000000000091";
  const context = { workspaceId, userId, authSubject: userId };
  let root = "";
  let database: PGlite;
  let socket: PGLiteSocketServer;
  let provider: PostgresCloudDataProvider;
  let repository: PostgresCaptureRepository;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "careeros-pg-concurrency-"));
    database = await PGlite.create(join(root, "database"));
    for (const migration of await discoverCloudMigrations()) await database.exec(migration.sql);
    await database.query("INSERT INTO workspaces(id,name) VALUES($1,'Concurrent Capture')", [workspaceId]);
    await database.query("INSERT INTO workspace_users(id,auth_subject,email) VALUES($1,$2::uuid,'owner@example.com')", [userId, userId]);
    await database.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, userId]);
    const port = await freePort();
    socket = new PGLiteSocketServer({ db: database, host: "127.0.0.1", port, maxConnections: 8 });
    await socket.start();
    provider = new PostgresCloudDataProvider({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
      pool: { max: 6, ssl: false, connectionTimeoutMillis: 5_000 },
      applicationName: "careeros-capture-concurrency-test",
    });
    repository = new PostgresCaptureRepository(provider);
  }, 60_000);

  afterAll(async () => {
    await provider?.close();
    await socket?.stop();
    await database?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function reviewed(draft: JobDraft) {
    const [queued] = await repository.enqueue(context, [{ kind: "text", text: `${draft.title}\nCompany: ${draft.companyName}` }]);
    const claim = await repository.claimNext();
    expect(claim?.id).toBe(queued?.id);
    const importId = randomUUID();
    const response: ImportDraftResponse = {
      importRun: { id: importId, state: "Needs Review", sourceType: "pasted_text", sourceUrl: null, error: null },
      draft,
      duplicates: [],
      enrichment: { mode: "deterministic", provider: null, model: null, warning: null, evidenceCount: 1, aiRunId: null, durationMs: 1, totalDurationMs: 1 },
      fieldEvidence: [{ fieldPath: "title", excerpt: draft.title, confidence: 0.9, method: "deterministic" }],
    };
    await repository.createImport(claim!, {
      sourceType: "pasted_text", url: null, rawText: draft.title, contentHash: randomUUID(), metadata: {},
    }, response, [{ fieldPath: "title", excerpt: draft.title, suggestedValue: draft.title, confidence: 0.9, method: "deterministic" }]);
    await repository.finish(claim!.id, claim!.leaseToken, "Needs Review", { response }, null);
    return claim!.id;
  }

  it("claims distinct work across simultaneous PostgreSQL transactions", async () => {
    await repository.enqueue(context, Array.from({ length: 12 }, (_, index) => ({ kind: "text", text: `Concurrent role ${index}` })));
    const claims = await Promise.all(Array.from({ length: 6 }, () => repository.claimNext()));
    expect(claims.every(Boolean)).toBe(true);
    expect(new Set(claims.map((claim) => claim!.id)).size).toBe(6);
    await Promise.all(claims.map((claim) => repository.finish(claim!.id, claim!.leaseToken, "Failed", null, "test cleanup")));
    const remaining = await Promise.all(Array.from({ length: 6 }, () => repository.claimNext()));
    expect(new Set(remaining.map((claim) => claim!.id)).size).toBe(6);
    await Promise.all(remaining.map((claim) => repository.finish(claim!.id, claim!.leaseToken, "Failed", null, "test cleanup")));
  }, 30_000);

  it("serializes simultaneous equivalent commits and saves exactly one posting", async () => {
    const draft = jobDraftSchema.parse({
      title: "Concurrent Quant Trading Graduate",
      companyName: "Concurrent Capital",
      location: "London",
      sourceUrl: "https://example.com/jobs/concurrent-quant",
      applyUrl: "https://example.com/jobs/concurrent-quant/apply",
      requiredRequirements: ["Python"],
    });
    const first = await reviewed(draft);
    const second = await reviewed(draft);
    const results = await Promise.allSettled([
      repository.commit(context, [{ id: first }]),
      repository.commit(context, [{ id: second }]),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ duplicates: [expect.objectContaining({ title: draft.title })] });
    const count = await provider.administrativeTransaction(async (tx) => Number((await tx.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM job_postings WHERE workspace_id=$1 AND title=$2", [workspaceId, draft.title],
    )).rows[0]?.count ?? 0));
    expect(count).toBe(1);
  }, 30_000);
});
