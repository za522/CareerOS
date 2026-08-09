import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";
import type { QueryExecutor, QueryResult, SqlValue, WorkspaceContext } from "./postgres/contracts.js";
import { discoverCloudMigrations } from "./postgres/migrations.js";
import type { DiscoveryService } from "./discovery-service.js";
import type { PostgresDiscoveryService } from "./postgres-discovery-service.js";

function executor(database: PGlite): QueryExecutor {
  return { async query<Row extends Record<string, unknown>>(text: string, values: readonly SqlValue[] = []) {
    const result = await database.query<Row>(text, values as unknown[]);
    return { rows: result.rows, rowCount: result.rows.length || (result.affectedRows ?? 0) } satisfies QueryResult<Row>;
  } };
}

class LifecycleProvider {
  #tail: Promise<void> = Promise.resolve();
  readonly provider = "postgresql" as const;
  constructor(readonly database: PGlite) {}
  async transaction<T>(context: WorkspaceContext, work: (tx: QueryExecutor) => Promise<T>) {
    return this.serial(async () => {
      await this.database.exec("BEGIN");
      try {
        await this.database.exec("SET LOCAL ROLE careeros_runtime");
        await this.database.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.user_id',$2,true),set_config('app.auth_subject',$3,true)", [context.workspaceId, context.userId, context.authSubject ?? ""]);
        const result = await work(executor(this.database));
        await this.database.exec("COMMIT");
        return result;
      } catch (error) {
        await this.database.exec("ROLLBACK");
        throw error;
      }
    });
  }
  async administrativeTransaction<T>(work: (tx: QueryExecutor) => Promise<T>) {
    return this.serial(async () => {
      await this.database.exec("BEGIN");
      try {
        const result = await work(executor(this.database));
        await this.database.exec("COMMIT");
        return result;
      } catch (error) {
        await this.database.exec("ROLLBACK");
        throw error;
      }
    });
  }
  async close() {}
  private serial<T>(work: () => Promise<T>) {
    const run = this.#tail.then(work, work);
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

describe("PostgreSQL Fastify lifecycle", () => {
  const database = new PGlite();
  const provider = new LifecycleProvider(database);
  let app: Awaited<typeof import("./server.js")>["app"];
  let discoveryRunDue: MockInstance<DiscoveryService["runDue"]>;
  let hostedDiscoveryRunDue: MockInstance<PostgresDiscoveryService["runDue"]>;
  let hostedDispatchTelegram: MockInstance<PostgresDiscoveryService["dispatchTelegram"]>;
  let telegramStatus = 200;
  let appUrlReachable = true;
  const originalFetch = globalThis.fetch;
  const authorization = { authorization: "Bearer owner" };

  beforeAll(async () => {
    for (const migration of await discoverCloudMigrations()) await database.exec(migration.sql);
    await database.exec(`
      INSERT INTO workspaces(id,name) VALUES ('00000000-0000-4000-8000-000000000001','Lifecycle Workspace');
      INSERT INTO workspace_users(id,auth_subject,email,display_name)
        VALUES ('90000000-0000-4000-8000-000000000009','90000000-0000-4000-8000-000000000009','scheduler@example.com','Scheduler Owner');
      INSERT INTO workspace_memberships(workspace_id,user_id,role)
        VALUES ('00000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000009','owner');
    `);
    process.env.CAREEROS_DATA_PROVIDER = "postgres";
    process.env.CAREEROS_HOSTED = "1";
    process.env.NODE_ENV = "test";
    process.env.CAREEROS_E2E_AUTH = "1";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon";
    process.env.CAREEROS_OWNER_EMAIL = "owner@example.com";
    process.env.CAREEROS_REALTIME_ENABLED = "0";
    process.env.CAREEROS_CAPTURE_CONCURRENCY = "1";
    process.env.CAREEROS_SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.CAREEROS_BACKUP_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
    process.env.CAREEROS_INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    process.env.CAREEROS_APP_URL = "https://careeros.example/app";
    process.env.CAREEROS_BACKUP_INTERVAL_HOURS = "24";
    process.env.PORT = "0";
    delete process.env.CAREEROS_SKIP_LISTEN;
    delete process.env.CAREEROS_DISABLE_DISCOVERY_SCHEDULER;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith("https://api.telegram.org/")) {
        return new Response(telegramStatus === 200 ? JSON.stringify({ ok: true, result: { message_id: 42 } }) : JSON.stringify({ ok: false }), {
          status: telegramStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input, init);
    });

    const discoveryModule = await import("./discovery-service.js");
    discoveryRunDue = vi.spyOn(discoveryModule.DiscoveryService.prototype, "runDue");
    const hostedDiscoveryModule = await import("./postgres-discovery-service.js");
    hostedDiscoveryRunDue = vi.spyOn(hostedDiscoveryModule.PostgresDiscoveryService.prototype, "runDue");
    hostedDispatchTelegram = vi.spyOn(hostedDiscoveryModule.PostgresDiscoveryService.prototype, "dispatchTelegram");
    vi.doMock("./runtime-data-provider.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./runtime-data-provider.js")>()),
      createRuntimeDataProvider: async () => ({ name: "postgres" as const, postgres: provider }),
    }));
    vi.doMock("./public-app-url.js", () => ({
      preflightPublicAppUrl: vi.fn(async (value: string) => {
        if (!appUrlReachable) throw new Error("The public CareerOS address could not be reached safely. The source returned HTTP 503.");
        return { url: value, reachable: true as const };
      }),
    }));
    app = (await import("./server.js")).app;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await database.close();
    vi.doUnmock("./runtime-data-provider.js");
    vi.unstubAllGlobals();
  });

  it("starts the hosted scheduler path and never starts the SQLite discovery scheduler", async () => {
    await vi.waitFor(() => expect(hostedDiscoveryRunDue).toHaveBeenCalled(), { timeout: 5_000 });
    await vi.waitFor(() => expect(hostedDispatchTelegram).toHaveBeenCalled(), { timeout: 5_000 });
    await vi.waitFor(async () => {
      const response = await app.inject({ method: "GET", url: "/api/meta", headers: authorization });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ sectors: [], locations: [] });
    }, { timeout: 5_000 });
    expect(discoveryRunDue).not.toHaveBeenCalled();
  });

  it("allows the authenticated browser to preview a downloaded PDF blob", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-security-policy"]).toContain("frame-src 'self' blob:");
  });

  it("seeds hosted discovery and reports never-successful and overdue sources as unhealthy", async () => {
    const seeded = await app.inject({ method: "GET", url: "/api/discovery?limit=100", headers: authorization });
    expect(seeded.statusCode).toBe(200);
    expect(seeded.json().sources.length).toBeGreaterThan(20);
    expect(seeded.json().sources.every((source: { kind: string }) => ["greenhouse", "lever", "ashby"].includes(source.kind))).toBe(true);

    const neverSuccessful = await app.inject({ method: "GET", url: "/api/system/health", headers: authorization });
    expect(neverSuccessful.json().discovery).toMatchObject({ enabledSources: seeded.json().sources.length, unhealthySources: seeded.json().sources.length, lastSuccessfulAt: null });

    await provider.administrativeTransaction(async (tx) => {
      await tx.query("UPDATE discovery_sources SET last_checked_at=now(),last_successful_at=now(),last_error='' WHERE workspace_id=$1", ["00000000-0000-4000-8000-000000000001"]);
    });
    expect((await app.inject({ method: "GET", url: "/api/system/health", headers: authorization })).json().discovery.unhealthySources).toBe(0);

    await provider.administrativeTransaction(async (tx) => {
      await tx.query("UPDATE discovery_sources SET last_successful_at=now()-interval '7 hours' WHERE workspace_id=$1 AND id=(SELECT id FROM discovery_sources WHERE workspace_id=$1 ORDER BY id LIMIT 1)", ["00000000-0000-4000-8000-000000000001"]);
    });
    expect((await app.inject({ method: "GET", url: "/api/system/health", headers: authorization })).json().discovery.unhealthySources).toBe(1);
  });

  it("returns the exact job detail contract with persisted evidence and salary data", async () => {
    const created = await app.inject({ method: "POST", url: "/api/jobs", headers: authorization, payload: { title: "Quant Trader", companyName: "Exact Capital", sector: "Finance", location: "London" } });
    expect(created.statusCode).toBe(201);
    const jobId = created.json().id as string;
    await provider.administrativeTransaction(async (tx) => {
      await tx.query("INSERT INTO field_evidence(id,workspace_id,entity_type,entity_id,field_path,method,suggested_value,confidence,user_confirmed,captured_at) VALUES('evidence-1',$1,'JobPosting',$2,'location','manual','London',1,true,now())", ["00000000-0000-4000-8000-000000000001", jobId]);
      await tx.query("INSERT INTO salary_estimates(id,workspace_id,job_posting_id,estimate_type,min_amount,max_amount,currency,payment_period,source_name,confidence) VALUES('salary-1',$1,$2,'researched',60000,80000,'GBP','annual','Public source',0.8)", ["00000000-0000-4000-8000-000000000001", jobId]);
      await tx.query("INSERT INTO salary_research_evidence(id,workspace_id,salary_estimate_id,source_name,source_url,currency,excerpt,confidence) VALUES('salary-evidence-1',$1,'salary-1','Public source','https://example.com/salary','GBP','Comparable role',0.8)", ["00000000-0000-4000-8000-000000000001"]);
    });
    const detail = await app.inject({ method: "GET", url: `/api/jobs/${jobId}`, headers: authorization });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id: jobId,
      evidenceCount: 1,
      evidence: [{ id: "evidence-1", fieldPath: "location", suggestedValue: "London" }],
      salaries: [{ id: "salary-1", estimateType: "researched", minAmount: 60000, maxAmount: 80000, evidence: [{ sourceName: "Public source" }] }],
    });
    expect(detail.json()).not.toHaveProperty("salaryEstimates");
  });

  it("creates and commits salary estimates through hosted PostgreSQL routes", async () => {
    const createdJob = await app.inject({
      method: "POST",
      url: "/api/jobs",
      headers: authorization,
      payload: { title: "Graduate Software Engineer", companyName: "Salary Capital", sector: "Technology", location: "London" },
    });
    expect(createdJob.statusCode).toBe(201);
    const jobId = createdJob.json().id as string;

    const manual = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/salary-estimates`,
      headers: authorization,
      payload: { estimateType: "researched", minAmount: 55_000, maxAmount: 70_000, currency: "GBP", sourceName: "Public salary survey" },
    });
    expect(manual.statusCode).toBe(201);
    expect(manual.json()).toMatchObject({ estimateType: "researched", minAmount: 55_000, maxAmount: 70_000, currency: "GBP" });

    const proposal = {
      jobPostingId: jobId,
      inferredRoleTitle: "Graduate Software Engineer",
      inferredLevel: "Graduate",
      estimate: {
        estimateType: "ai_assisted",
        baseMinAmount: 60_000,
        baseMaxAmount: 78_000,
        totalCompMinAmount: 65_000,
        totalCompMaxAmount: 90_000,
        currency: "GBP",
        paymentPeriod: "annual",
        sourceName: "CareerOS salary research",
        sourceUrl: "https://example.com/salary",
        confidence: 0.8,
        researchNotes: "Comparable graduate software roles in London.",
      },
      evidence: [{
        sourceName: "Public salary survey",
        sourceUrl: "https://example.com/salary",
        sourceDate: "Reposted 2 weeks ago",
        roleTitle: "Graduate Software Engineer",
        location: "London",
        seniority: "Graduate",
        compensationScope: "base",
        minAmount: 60_000,
        maxAmount: 78_000,
        currency: "GBP",
        paymentPeriod: "annual",
        excerpt: "Comparable graduate software engineer salary range.",
        confidence: 0.8,
      }],
      confidence: 0.8,
      rationale: "A public comparable supports this directional estimate.",
      warnings: ["The employer did not publish compensation."],
      provider: "openai",
      model: "test-model",
      researchedAt: "2026-08-09T12:00:00.000Z",
      durationMs: 100,
    };
    const committed = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/salary-research/commit`,
      headers: authorization,
      payload: proposal,
    });
    expect(committed.statusCode).toBe(201);
    expect(committed.json()).toMatchObject({ estimateType: "ai_assisted", baseMinAmount: 60_000, baseMaxAmount: 78_000 });
    expect(committed.json().evidence).toEqual([expect.objectContaining({ sourceName: "Public salary survey", minAmount: 60_000 })]);

    const detail = await app.inject({ method: "GET", url: `/api/jobs/${jobId}`, headers: authorization });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().salaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ estimateType: "researched", minAmount: 55_000 }),
      expect.objectContaining({ estimateType: "ai_assisted", baseMinAmount: 60_000, evidence: [expect.objectContaining({ sourceName: "Public salary survey", sourceDate: null })] }),
    ]));
  });

  it("runs the hosted capture lifecycle through PostgreSQL with durable review and duplicate handling", async () => {
    const payload = { items: [{ sourceType: "pasted_text", text: "Quant Trading Graduate\nCompany: Lifecycle Capital\nLocation: London\nRole requirements: Python and probability." }] };
    const queued = await app.inject({ method: "POST", url: "/api/capture-queue", headers: authorization, payload });
    expect(queued.statusCode).toBe(202);
    const id = queued.json()[0].id as string;
    let review: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await app.inject({ method: "GET", url: `/api/capture-queue/${id}`, headers: authorization });
      review = response.json();
      if (["Needs Review", "Duplicate", "Failed", "Blocked"].includes(String(review.state))) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(review).toMatchObject({ state: "Needs Review", sourceText: expect.stringContaining("Lifecycle Capital") });
    expect((review.fieldEvidence as unknown) ?? review.draft).toBeTruthy();
    const committed = await app.inject({ method: "POST", url: `/api/capture-queue/${id}/commit`, headers: authorization, payload: { draft: review.draft } });
    expect(committed.statusCode).toBe(201);
    const activeQueue = await app.inject({ method: "GET", url: "/api/capture-queue?includeSaved=false", headers: authorization });
    expect(activeQueue.statusCode).toBe(200);
    expect(activeQueue.json().items.some((item: { id: string }) => item.id === id)).toBe(false);
    const queueHistory = await app.inject({ method: "GET", url: "/api/capture-queue", headers: authorization });
    expect(queueHistory.json().items.some((item: { id: string }) => item.id === id)).toBe(true);

    const duplicateQueue = await app.inject({ method: "POST", url: "/api/capture-queue", headers: authorization, payload });
    const duplicateId = duplicateQueue.json()[0].id as string;
    let duplicate: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 100; attempt += 1) {
      duplicate = (await app.inject({ method: "GET", url: `/api/capture-queue/${duplicateId}`, headers: authorization })).json();
      if (["Needs Review", "Duplicate", "Failed", "Blocked"].includes(String(duplicate.state))) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(duplicate.state).toBe("Duplicate");
    const rejected = await app.inject({ method: "POST", url: `/api/capture-queue/${duplicateId}/commit`, headers: authorization, payload: { draft: duplicate.draft } });
    expect(rejected.statusCode).toBe(409);
  });

  it("accepts 100 hosted captures and rejects stale concurrent capture-draft writes", async () => {
    const batch = await app.inject({ method: "POST", url: "/api/capture-queue", headers: authorization, payload: { items: [
      { sourceType: "pasted_text", text: "Lifecycle Operations Intern\nCompany: Batch One Capital\nLocation: London" },
      { sourceType: "pasted_text", text: "Lifecycle Research Intern\nCompany: Batch Two Capital\nLocation: London" },
    ] } });
    const batchIds = (batch.json() as Array<{ id:string }>).map((item) => item.id);
    for (const id of batchIds) for (let attempt=0;attempt<100;attempt+=1) {
      const state=String((await app.inject({method:"GET",url:`/api/capture-queue/${id}`,headers:authorization})).json().state);
      if (["Needs Review","Duplicate","Failed","Blocked"].includes(state)) break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    const lateDuplicate = await app.inject({ method: "POST", url: "/api/jobs", headers: authorization, payload: {
      title: "Lifecycle Research Intern", companyName: "Batch Two Capital", location: "London",
    } });
    expect(lateDuplicate.statusCode).toBe(201);
    const duplicateConflict = await app.inject({ method: "POST", url: "/api/capture-queue/commit-batch", headers: authorization, payload: {
      items: batchIds.map((id) => ({ id })),
    } });
    expect(duplicateConflict.statusCode).toBe(409);
    expect(duplicateConflict.json().conflicts).toMatchObject([{ id: batchIds[1] }]);
    expect((await app.inject({ method: "GET", url: `/api/capture-queue/${batchIds[0]}`, headers: authorization })).json().state).toBe("Needs Review");
    const rolledBack=await app.inject({method:"POST",url:"/api/capture-queue/commit-batch",headers:authorization,payload:{items:[{id:batchIds[0]},{id:"00000000-0000-4000-8000-000000000000"}]}});
    expect(rolledBack.statusCode).toBe(409);
    expect((await app.inject({method:"GET",url:`/api/capture-queue/${batchIds[0]}`,headers:authorization})).json().state).toBe("Needs Review");
    const committedBatch=await app.inject({method:"POST",url:"/api/capture-queue/commit-batch",headers:authorization,payload:{items:batchIds.map((id,index)=>({id,...(index===1?{duplicateAction:"create_anyway"}:{})}))}});
    expect(committedBatch.statusCode).toBe(201);expect(committedBatch.json()).toHaveLength(2);

    const items = Array.from({ length: 100 }, (_, index) => ({ sourceType: "pasted_text", text: `Lifecycle batch role ${index}\nCompany: Batch Capital ${index}\nLocation: London` }));
    const queued = await app.inject({ method: "POST", url: "/api/capture-queue", headers: authorization, payload: { items } });
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toHaveLength(100);

    const id = "60000000-0000-4000-8000-000000000006";
    const created = await app.inject({ method: "PUT", url: `/api/capture-drafts/${id}`, headers: authorization, payload: { sourceType: "pasted_text", value: "Original shared text" } });
    expect(created.statusCode).toBe(200);
    const [first, second] = await Promise.all([
      app.inject({ method: "PUT", url: `/api/capture-drafts/${id}`, headers: authorization, payload: { sourceType: "pasted_text", value: "First writer", expectedRevision: 1 } }),
      app.inject({ method: "PUT", url: `/api/capture-drafts/${id}`, headers: authorization, payload: { sourceType: "pasted_text", value: "Second writer", expectedRevision: 1 } }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
  });

  it("serves hosted discovery filters, review-save, alerts, delivery history, and retry states", async () => {
    const source = await app.inject({ method: "POST", url: "/api/discovery/sources", headers: authorization, payload: {
      name: "Lifecycle Greenhouse", kind: "greenhouse", companyName: "Lifecycle Markets",
      sourceUrl: "https://boards-api.greenhouse.io/v1/boards/lifecycle/jobs", externalKey: "lifecycle", enabled: true, checkIntervalMinutes: 180,
    } });
    expect(source.statusCode).toBe(201);
    const rule = await app.inject({ method: "POST", url: "/api/alerts/rules", headers: authorization, payload: {
      name: "London quant", enabled: true, companies: ["Lifecycle"], side: "either", roleFamilies: ["Trading"],
      programmes: [], locations: ["London"], keywords: ["quant"], newWithinHours: 24, telegramEnabled: true,
    } });
    expect(rule.statusCode).toBe(201);
    const postingId = "71000000-0000-4000-8000-000000000007";
    await database.query(`INSERT INTO discovered_postings
      (id,workspace_id,source_id,external_id,canonical_url,apply_url,company_name,title,location,programme,sector,firm_type,role_family,work_mode,sponsorship,side,description,first_seen_at,last_seen_at,last_checked_at,availability,content_hash)
      VALUES($1,'00000000-0000-4000-8000-000000000001',$2,'role-1','https://example.com/quant-role','https://example.com/quant-role','Lifecycle Markets','Quant Trading Graduate','London','Graduate','Financial services','Bank','Trading','Hybrid','Not stated','sell_side','Quant trading role',now(),now(),now(),'Open','hash')`,
    [postingId, source.json().id]);
    await database.query(`INSERT INTO discovered_postings
      (id,workspace_id,source_id,external_id,canonical_url,apply_url,company_name,title,location,programme,sector,firm_type,role_family,work_mode,sponsorship,side,description,first_seen_at,last_seen_at,last_checked_at,availability,content_hash)
      VALUES('71000000-0000-4000-8000-000000000008','00000000-0000-4000-8000-000000000001',$1,'role-spring','https://example.com/spring-role','https://example.com/spring-role','Lifecycle Markets','Markets Spring Week','London','Spring week','Financial services','Bank','Trading','On-site','No','sell_side','Spring insight programme',now(),now(),now(),'Open','spring-hash')`,
    [source.json().id]);

    const feed = await app.inject({ method: "GET", url: "/api/discovery?q=quant&roleFamily=Trading&location=London", headers: authorization });
    expect(feed.statusCode).toBe(200);
    expect(feed.json()).toMatchObject({ postingTotal: 1, postings: [{ id: postingId, title: "Quant Trading Graduate" }] });
    const earlyCareer = await app.inject({ method: "GET", url: "/api/discovery?earlyCareerOnly=true", headers: authorization });
    expect(earlyCareer.json()).toMatchObject({ postingTotal: 1, openPostingTotal: 1, postings: [{ id: postingId }] });
    const hidden = await app.inject({ method: "PATCH", url: `/api/discovery/postings/${postingId}/hidden`, headers: authorization, payload: { hidden: true } });
    expect(hidden.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/discovery?q=quant", headers: authorization })).json().postingTotal).toBe(0);
    expect((await app.inject({ method: "PATCH", url: `/api/discovery/postings/${postingId}/hidden`, headers: authorization, payload: { hidden: false, expectedRevision: hidden.json().revision } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/discovery/postings/${postingId}/issues`, headers: authorization, payload: { reason: "Location needs verification" } })).statusCode).toBe(201);

    const review = await app.inject({ method: "POST", url: `/api/discovery/postings/${postingId}/save`, headers: authorization });
    expect(review.statusCode).toBe(200);
    expect(review.json()).toMatchObject({ discoveryPostingId: postingId, draft: { companyName: "Lifecycle Markets" } });
    const committed = await app.inject({ method: "POST", url: `/api/imports/${encodeURIComponent(review.json().importRun.id)}/commit`, headers: authorization, payload: { draft: review.json().draft } });
    expect(committed.statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: "/api/discovery?tracked=saved", headers: authorization })).json().postingTotal).toBe(1);

    const unconfigured = await app.inject({ method: "POST", url: "/api/alerts/test", headers: authorization });
    expect(unconfigured.statusCode).toBe(409);
    expect(unconfigured.json().error).toMatch(/Configure Telegram/i);
    expect((await app.inject({ method: "GET", url: "/api/system/health", headers: authorization })).json().notifications.configured).toBe(false);
    const configured = await app.inject({ method: "PUT", url: "/api/settings/telegram", headers: authorization, payload: { botToken: "123456789:test-token-value", chatId: "workspace-owner-chat" } });
    expect(configured.statusCode).toBe(200);
    expect(configured.json()).toMatchObject({ configured: true, chatIdHint: "••••chat" });
    expect(JSON.stringify(configured.json())).not.toContain("test-token-value");
    expect((await app.inject({ method: "GET", url: "/api/system/health", headers: authorization })).json().notifications.configured).toBe(true);
    const validAppUrl = process.env.CAREEROS_APP_URL;
    delete process.env.CAREEROS_APP_URL;
    expect((await app.inject({ method: "POST", url: "/api/alerts/test", headers: authorization })).statusCode).toBe(503);
    process.env.CAREEROS_APP_URL = "javascript:alert(1)";
    expect((await app.inject({ method: "POST", url: "/api/alerts/test", headers: authorization })).statusCode).toBe(503);
    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM alert_events WHERE event_type='test'")).rows[0].count).toBe(0);
    process.env.CAREEROS_APP_URL = validAppUrl;
    appUrlReachable = false;
    const unreachable = await app.inject({ method: "POST", url: "/api/alerts/test", headers: authorization });
    expect(unreachable.statusCode).toBe(503);
    expect(unreachable.json().error).toMatch(/could not be reached safely/i);
    expect((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM alert_events WHERE event_type='test'")).rows[0].count).toBe(0);
    appUrlReachable = true;
    await database.query(`INSERT INTO alert_events(id,workspace_id,event_type,title,body,direct_url,deduplication_key)
      VALUES('backlog-alert','00000000-0000-4000-8000-000000000001','test','Older queued alert','Body','https://careeros.example/older','backlog-dedup')`);
    await database.query(`INSERT INTO notification_deliveries(id,workspace_id,alert_event_id,provider,state,next_attempt_at)
      VALUES('backlog-delivery','00000000-0000-4000-8000-000000000001','backlog-alert','telegram','Pending',now()-interval '1 minute')`);
    telegramStatus = 400;
    const failedTest = await app.inject({ method: "POST", url: "/api/alerts/test", headers: authorization });
    expect(failedTest.statusCode).toBe(502);
    expect((await database.query<{ state: string }>("SELECT state FROM notification_deliveries WHERE id='backlog-delivery'")).rows[0].state).toBe("Pending");
    expect((await app.inject({ method: "GET", url: "/api/settings/telegram", headers: authorization })).json()).toMatchObject({ lastTestedAt: expect.any(String), lastSuccessfulTestAt: null });
    const failedDeliveries = await app.inject({ method: "GET", url: "/api/alerts/deliveries?limit=10", headers: authorization });
    const failedDelivery = failedDeliveries.json().items.find((item: { state: string }) => item.state === "Failed");
    expect(failedDelivery).toMatchObject({ state: "Failed", lastError: expect.any(String) });
    telegramStatus = 200;
    const retriedDelivery = await app.inject({ method: "POST", url: `/api/alerts/deliveries/${failedDelivery.id}/retry`, headers: authorization, payload: {} });
    expect(retriedDelivery.statusCode).toBe(200);
    expect(retriedDelivery.json()).toMatchObject({ id: failedDelivery.id, state: "Delivered", lastError: "" });
    expect((await database.query<{ state: string }>("SELECT state FROM notification_deliveries WHERE id='backlog-delivery'")).rows[0].state).toBe("Pending");
    const testAlert = await app.inject({ method: "POST", url: "/api/alerts/test", headers: authorization });
    expect(testAlert.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/settings/telegram", headers: authorization })).json()).toMatchObject({ lastSuccessfulTestAt: expect.any(String), lastError: "" });
    const deliveries = await app.inject({ method: "GET", url: "/api/alerts/deliveries?limit=10", headers: authorization });
    expect(deliveries.statusCode).toBe(200);
    expect(deliveries.json().items[0]).toMatchObject({ state: "Delivered", directUrl: expect.stringMatching(/^https:/) });
  });

  it("autosaves, reopens, snapshots, exports, and links the exact hosted CV version", async () => {
    const createdJob = await app.inject({ method: "POST", url: "/api/jobs", headers: authorization, payload: { title: "Application Studio Role", companyName: "Studio Capital", location: "London" } });
    const jobId = createdJob.json().id as string;
    const application = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/applications`, headers: authorization, payload: { priority: "High", notes: "Lifecycle" } });
    const applicationId = application.json().applicationId as string;
    const documentId = "72000000-0000-4000-8000-000000000007";
    await database.query(`INSERT INTO documents(id,workspace_id,document_type,title,mime_type)
      VALUES($1,'00000000-0000-4000-8000-000000000001','cv','Lifecycle CV','application/pdf')`, [documentId]);
    await database.query(`INSERT INTO source_documents(id,workspace_id,source_type,raw_text,content_hash,captured_at,metadata)
      VALUES('source-studio','00000000-0000-4000-8000-000000000001','profile_document','Zain Ahmad\nDesign Engineer\nBuilt reliable systems.','studio',now(),$1::jsonb)`,
    [JSON.stringify({ documentId, extractionWarning: null })]);
    const profile = (await app.inject({ method: "GET", url: "/api/profile", headers: authorization })).json();
    const importedEvidenceId = "73000000-0000-4000-8000-000000000007";
    await database.query(`INSERT INTO profile_evidence(id,workspace_id,profile_id,evidence_type,title,content)
      VALUES($1,'00000000-0000-4000-8000-000000000001',$2,'experience','Krislite','Designed and prototyped fibre-optic lighting systems.')`, [importedEvidenceId, profile.id]);
    await database.query(`INSERT INTO field_evidence(id,workspace_id,entity_type,entity_id,field_path,source_document_id,excerpt,method,suggested_value,confidence,user_confirmed,captured_at)
      VALUES('74000000-0000-4000-8000-000000000007','00000000-0000-4000-8000-000000000001','ProfileEvidence',$1,'content','source-studio','Built reliable systems.','ai_generated','Designed and prototyped fibre-optic lighting systems.',0.9,true,now())`, [importedEvidenceId]);
    const sectionId = "source:source-studio";
    const content = { name: "Zain Ahmad", headline: "Design Engineer", intro: "Focused introduction.", contact: { email: "zain@example.com", phone: "", website: "https://example.com" }, sections: [{ id: sectionId, evidenceType: "other", title: "Imported CV", content: "Zain Ahmad\nDesign Engineer\nBuilt reliable systems.", sourceEvidenceIds: [] }] };
    const initial = await app.inject({ method: "PUT", url: `/api/jobs/${jobId}/document-drafts`, headers: authorization, payload: { documentId, content, proposalState: { turns: [], activeTurnId: null }, expectedRevision: null } });
    expect(initial.statusCode).toBe(200);
    const updatedContent = { ...content, intro: "Newer shared introduction." };
    expect((await app.inject({ method: "PUT", url: `/api/jobs/${jobId}/document-drafts`, headers: authorization, payload: { documentId, content: updatedContent, proposalState: { turns: [], activeTurnId: null }, expectedRevision: 1 } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: `/api/jobs/${jobId}/document-drafts`, headers: authorization, payload: { documentId, content, proposalState: { turns: [], activeTurnId: null }, expectedRevision: 1 } })).statusCode).toBe(409);
    const reopened = await app.inject({ method: "GET", url: `/api/jobs/${jobId}/application-studio`, headers: authorization });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().documents[0]).toMatchObject({ draftRevision: 2, draftContent: { intro: "Newer shared introduction.", sections: [{ id: importedEvidenceId, title: "Krislite" }] } });
    expect(reopened.json().documents[0].baseContent.sections).toEqual([
      expect.objectContaining({ id: importedEvidenceId, evidenceType: "experience", title: "Krislite" }),
    ]);
    expect(reopened.json().documents[0].baseContent.sections).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Imported CV" }),
    ]));
    const snapshot = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/document-versions`, headers: authorization, payload: {
      documentId, parentVersionId: null, expectedDraftRevision: 2, checkpointName: "Submitted lifecycle CV", content: updatedContent,
      acceptedChangeIds: [], proposalChanges: [], proposalDecisions: {}, changeSummary: "Lifecycle", provider: "manual", model: "",
    } });
    expect(snapshot.statusCode).toBe(201);
    const versionId = snapshot.json().id as string;
    const exported = await app.inject({ method: "POST", url: `/api/document-versions/${versionId}/pdf`, headers: authorization, payload: {
      pageSectionIds: [[sectionId]], markAsSubmitted: true, applicationId,
    } });
    expect(exported.statusCode).toBe(200);
    expect(exported.json()).toMatchObject({ id: versionId, submittedAt: expect.any(String), relativePath: expect.stringContaining(".pdf") });
    const materials = await database.query<{ document_version_id: string }>("SELECT document_version_id FROM application_materials WHERE application_id=$1", [applicationId]);
    expect(materials.rows).toEqual([{ document_version_id: versionId }]);
    expect((await app.inject({ method: "GET", url: `/api/document-versions/${versionId}/pdf`, headers: authorization })).headers["content-type"]).toContain("application/pdf");
  }, 30_000);

  it("exports, schedules, lists, and restores hosted PostgreSQL backups over HTTP", async () => {
    const exported = await app.inject({ method: "GET", url: "/api/export", headers: authorization });
    expect(exported.statusCode).toBe(200);
    expect(exported.json()).toMatchObject({ manifest: { format: "careeros-postgres-workspace" } });

    const run = await app.inject({ method: "POST", url: "/api/backups/run", headers: authorization });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({ path: expect.stringMatching(/^backups\/.+\.careeros\.enc$/), checksum: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const history = await app.inject({ method: "GET", url: "/api/backups", headers: authorization });
    expect(history.statusCode).toBe(200);
    expect(history.json().backups[0]).toMatchObject({ path: run.json().path, checksum: run.json().checksum });

    const transient = await app.inject({ method: "POST", url: "/api/jobs", headers: authorization, payload: { title: "Delete on restore", companyName: "Transient Backup Test" } });
    expect(transient.statusCode).toBe(201);
    const restored = await app.inject({ method: "POST", url: `/api/backups/${history.json().backups[0].id}/restore`, headers: authorization });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json()).toMatchObject({ accepted: true, restartRequired: false, message: expect.stringContaining("ready") });
    expect((await app.inject({ method: "GET", url: `/api/jobs/${transient.json().id}`, headers: authorization })).statusCode).toBe(404);

    const manualTransient = await app.inject({ method: "POST", url: "/api/jobs", headers: authorization, payload: { title: "Manual restore transient", companyName: "Manual Restore Test" } });
    expect(manualTransient.statusCode).toBe(201);
    const manualRestore = await app.inject({ method: "POST", url: "/api/restore", headers: authorization, payload: exported.json() });
    expect(manualRestore.statusCode).toBe(200);
    expect(manualRestore.json()).toMatchObject({ accepted: true, restartRequired: false, message: expect.any(String) });
    expect((await app.inject({ method: "GET", url: `/api/jobs/${manualTransient.json().id}`, headers: authorization })).statusCode).toBe(404);
  }, 60_000);

  it("rolls back a mutation when its atomic audit row cannot be written", async () => {
    await database.exec(`
      CREATE OR REPLACE FUNCTION reject_atomic_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='job.created' THEN RAISE EXCEPTION 'forced audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_atomic_test_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_atomic_test_audit();
    `);
    const response = await app.inject({ method: "POST", url: "/api/jobs", headers: authorization, payload: { title: "Must Roll Back", companyName: "Rollback Capital" } });
    expect(response.statusCode).toBe(500);
    const persisted = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM job_postings WHERE title='Must Roll Back'");
    expect(persisted.rows[0]?.count).toBe(0);
  });
});
