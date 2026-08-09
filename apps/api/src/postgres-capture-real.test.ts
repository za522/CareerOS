import { randomUUID } from "node:crypto";
import { jobDraftSchema, type ImportDraftResponse, type JobDraft } from "@careeros/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discoverCloudMigrations } from "./postgres/migrations.js";
import { PostgresCaptureRepository } from "./postgres-capture-repository.js";
import { PostgresCloudDataProvider } from "./postgres/provider.js";

const connectionString = process.env.CAREEROS_REAL_POSTGRES_URL?.trim() ?? "";
const describeReal = connectionString ? describe : describe.skip;

describeReal("Rapid Capture on a real PostgreSQL server", () => {
  const workspaceId = "00000000-0000-4000-8000-000000000096";
  const userId = "10000000-0000-4000-8000-000000000096";
  const context = { workspaceId, userId, authSubject: userId };
  let provider: PostgresCloudDataProvider;
  let repository: PostgresCaptureRepository;

  beforeAll(async () => {
    provider = new PostgresCloudDataProvider({
      connectionString,
      pool: { max: 8, ssl: false, connectionTimeoutMillis: 5_000 },
      applicationName: "careeros-real-postgres-capture-test",
    });
    await provider.migrateVersions(await discoverCloudMigrations());
    await provider.administrativeTransaction(async (tx) => {
      await tx.query("INSERT INTO workspaces(id,name) VALUES($1,'Real PostgreSQL Capture') ON CONFLICT(id) DO NOTHING", [workspaceId]);
      await tx.query("INSERT INTO workspace_users(id,auth_subject,email) VALUES($1,$2::uuid,'real-postgres-owner@example.com') ON CONFLICT(id) DO NOTHING", [userId, userId]);
      await tx.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner') ON CONFLICT(workspace_id,user_id) DO UPDATE SET role='owner'", [workspaceId, userId]);
      await tx.query("DELETE FROM capture_queue_items WHERE workspace_id=$1", [workspaceId]);
      await tx.query("DELETE FROM job_postings WHERE workspace_id=$1", [workspaceId]);
      await tx.query("DELETE FROM companies WHERE workspace_id=$1", [workspaceId]);
    });
    repository = new PostgresCaptureRepository(provider);
  }, 60_000);

  afterAll(async () => {
    await provider?.close();
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

  it("uses row locks to claim distinct work across simultaneous real connections", async () => {
    await repository.enqueue(context, Array.from({ length: 24 }, (_, index) => ({ kind: "text", text: `Real concurrent role ${index}` })));
    const claims = await Promise.all(Array.from({ length: 12 }, () => repository.claimNext()));
    expect(claims.every(Boolean)).toBe(true);
    expect(new Set(claims.map((claim) => claim!.id)).size).toBe(12);
    await Promise.all(claims.map((claim) => repository.finish(claim!.id, claim!.leaseToken, "Failed", null, "test cleanup")));
  }, 30_000);

  it("serializes equivalent commits and persists exactly one posting", async () => {
    await provider.administrativeTransaction((tx) => tx.query("UPDATE capture_queue_items SET state='Failed',lease_token=NULL,lease_expires_at=NULL WHERE workspace_id=$1 AND state IN ('Queued','Extracting')", [workspaceId]));
    const draft = jobDraftSchema.parse({
      title: "Real Concurrent Quant Trading Graduate",
      companyName: "Real Concurrent Capital",
      location: "London",
      sourceUrl: "https://example.com/jobs/real-concurrent-quant",
      applyUrl: "https://example.com/jobs/real-concurrent-quant/apply",
      requiredRequirements: ["Python"],
    });
    const first = await reviewed(draft);
    const second = await reviewed(draft);
    const results = await Promise.allSettled([
      repository.commit(context, [{ id: first }]),
      repository.commit(context, [{ id: second }]),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ status: "rejected", reason: { duplicates: [expect.objectContaining({ title: draft.title })] } });
    const count = await provider.administrativeTransaction(async (tx) => Number((await tx.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM job_postings WHERE workspace_id=$1 AND title=$2", [workspaceId, draft.title],
    )).rows[0]?.count ?? 0));
    expect(count).toBe(1);
  }, 30_000);
});
