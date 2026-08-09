import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { DiscoveryService } from "./discovery-service.js";
import { CaptureQueueService, captureQueueStatuses, type CaptureQueueJob, type CaptureQueueJobUpdate, type CaptureQueueStatus, type CaptureQueueStore } from "./capture-queue.js";
import { EncryptedBackupScheduler } from "./encrypted-backup.js";
import { ProcessMutationGate } from "./mutation-gate.js";

function database() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE discovery_sources (id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,company_name TEXT NOT NULL,source_url TEXT NOT NULL,external_key TEXT NOT NULL DEFAULT '',enabled INTEGER NOT NULL DEFAULT 1,check_interval_minutes INTEGER NOT NULL DEFAULT 180,last_checked_at TEXT,last_successful_at TEXT,last_error TEXT NOT NULL DEFAULT '',successful_inventory_count INTEGER NOT NULL DEFAULT 0,lease_until TEXT,lease_token TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE discovery_runs (id TEXT PRIMARY KEY,source_id TEXT NOT NULL,state TEXT NOT NULL,started_at TEXT NOT NULL,completed_at TEXT,duration_ms INTEGER NOT NULL DEFAULT 0,found_count INTEGER NOT NULL DEFAULT 0,new_count INTEGER NOT NULL DEFAULT 0,changed_count INTEGER NOT NULL DEFAULT 0,missing_count INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '');
    CREATE TABLE discovered_postings (id TEXT PRIMARY KEY,source_id TEXT NOT NULL,external_id TEXT NOT NULL,canonical_url TEXT NOT NULL,apply_url TEXT NOT NULL,company_name TEXT NOT NULL,title TEXT NOT NULL,location TEXT NOT NULL DEFAULT '',programme TEXT NOT NULL DEFAULT '',sector TEXT NOT NULL DEFAULT '',firm_type TEXT NOT NULL DEFAULT '',role_family TEXT NOT NULL DEFAULT '',work_mode TEXT NOT NULL DEFAULT 'Not stated',sponsorship TEXT NOT NULL DEFAULT 'Not stated',side TEXT NOT NULL DEFAULT 'unknown',description TEXT NOT NULL DEFAULT '',source_posted_at TEXT,deadline_at TEXT,first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,last_checked_at TEXT NOT NULL,removed_at TEXT,availability TEXT NOT NULL DEFAULT 'Open',missing_count INTEGER NOT NULL DEFAULT 0,content_hash TEXT NOT NULL DEFAULT '',saved_job_posting_id TEXT,hidden_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,revision INTEGER NOT NULL DEFAULT 1,UNIQUE(source_id,external_id));
    CREATE TABLE discovery_posting_aliases (source_id TEXT NOT NULL,external_id TEXT NOT NULL,discovered_posting_id TEXT NOT NULL,first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,last_checked_at TEXT NOT NULL,removed_at TEXT,availability TEXT NOT NULL DEFAULT 'Open',missing_count INTEGER NOT NULL DEFAULT 0,content_hash TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,PRIMARY KEY(source_id,external_id));
    CREATE TABLE discovery_observations (id TEXT PRIMARY KEY,discovered_posting_id TEXT NOT NULL,discovery_run_id TEXT NOT NULL,state TEXT NOT NULL,content_hash TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',observed_at TEXT NOT NULL);
    CREATE TABLE alert_rules (id TEXT PRIMARY KEY,name TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,criteria_json TEXT NOT NULL DEFAULT '{}',telegram_enabled INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE alert_events (id TEXT PRIMARY KEY,rule_id TEXT,discovered_posting_id TEXT,event_type TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,direct_url TEXT NOT NULL DEFAULT '',deduplication_key TEXT NOT NULL UNIQUE,read_at TEXT,created_at TEXT NOT NULL);
    CREATE TABLE notification_deliveries (id TEXT PRIMARY KEY,alert_event_id TEXT NOT NULL,provider TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'Pending',attempt_count INTEGER NOT NULL DEFAULT 0,provider_attempt_count INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',provider_message_id TEXT NOT NULL DEFAULT '',next_attempt_at TEXT,claim_token TEXT,claimed_until TEXT,delivered_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(alert_event_id,provider));
    CREATE TABLE notification_delivery_attempts (id TEXT PRIMARY KEY,delivery_id TEXT NOT NULL,sequence INTEGER NOT NULL,state TEXT NOT NULL,error TEXT NOT NULL DEFAULT '',provider_message_id TEXT NOT NULL DEFAULT '',retry_after_at TEXT,started_at TEXT NOT NULL,completed_at TEXT,UNIQUE(delivery_id,sequence));
    CREATE TRIGGER notification_delivery_attempts_immutable_update BEFORE UPDATE ON notification_delivery_attempts BEGIN SELECT RAISE(ABORT, 'notification delivery attempts are immutable'); END;
    CREATE TRIGGER notification_delivery_attempts_immutable_delete BEFORE DELETE ON notification_delivery_attempts BEGIN SELECT RAISE(ABORT, 'notification delivery attempts are immutable'); END;
    CREATE TABLE discovery_issues (id TEXT PRIMARY KEY,discovered_posting_id TEXT NOT NULL,reason TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'Open',created_at TEXT NOT NULL,resolved_at TEXT);
  `);
  return sqlite;
}

function source(service: DiscoveryService, suffix: string, companyName = "Acme") {
  return service.createSource({
    name: `${companyName} ${suffix}`,
    kind: "greenhouse",
    companyName,
    sourceUrl: `https://boards-api.greenhouse.io/v1/boards/${suffix}/jobs`,
    externalKey: suffix,
    enabled: true,
    checkIntervalMinutes: 60,
  });
}

function response(id = "role-1", description = "Applications close 12 August 2026.") {
  return new Response(JSON.stringify({ jobs: [{
    id, title: "Quantitative Trading Intern", absolute_url: `https://jobs.example/apply?job=${id}&locale=en`,
    location: { name: "London" }, created_at: "2026-08-01T09:00:00Z", content: description,
  }] }), { status: 200, headers: { "content-type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function captureStore(): CaptureQueueStore {
  const jobs = new Map<string, CaptureQueueJob>();
  const copy = (job: CaptureQueueJob) => structuredClone(job);
  return {
    async create(job) { jobs.set(job.id, copy(job)); },
    async createMany(items) { for (const job of items) jobs.set(job.id, copy(job)); },
    async get(id) { return jobs.has(id) ? copy(jobs.get(id)!) : null; },
    async list() { return [...jobs.values()].map(copy); },
    async countPending() { return [...jobs.values()].filter((job) => ["Queued", "Extracting"].includes(job.status)).length; },
    async summary() {
      const counts = Object.fromEntries(captureQueueStatuses.map((state) => [state, 0])) as Record<CaptureQueueStatus, number>;
      for (const job of jobs.values()) counts[job.status] += 1;
      const total = jobs.size;
      return { total, pending: counts.Queued + counts.Extracting, completed: total - counts.Queued - counts.Extracting, overallProgress: total ? [...jobs.values()].reduce((sum, job) => sum + job.progress, 0) / total : 0, counts };
    },
    async claimNext(updatedAt, startedAt) {
      const job = [...jobs.values()].find((item) => item.status === "Queued");
      if (!job) return null;
      Object.assign(job, { status: "Extracting", attempts: job.attempts + 1, updatedAt, startedAt });
      return copy(job);
    },
    async update(id, expectedStatuses, update: CaptureQueueJobUpdate) {
      const job = jobs.get(id);
      if (!job || !expectedStatuses.includes(job.status)) return null;
      Object.assign(job, update);
      return copy(job);
    },
    async requeueStale() { return 0; },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("discovery service integration", () => {
  it("seeds the approved finance starter list exactly once", () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    expect(service.seedFinanceSources()).toHaveLength(7);
    expect(service.seedFinanceSources()).toHaveLength(0);
    expect(service.workspace().sources).toHaveLength(7);
    sqlite.close();
  });

  it("upgrades a legacy Optiver source even when its URL is already current", () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    const timestamp = new Date().toISOString();
    sqlite.prepare(`INSERT INTO discovery_sources
      (id,name,kind,company_name,source_url,external_key,enabled,check_interval_minutes,last_error,created_at,updated_at,revision)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`).run(
      "legacy-optiver", "Optiver careers", "greenhouse", "Optiver", "https://optiver.com/en/api/v1/jobs", "legacy", 1, 180, "", timestamp, timestamp,
    );

    service.seedFinanceSources();

    expect(sqlite.prepare("SELECT kind,source_url,external_key FROM discovery_sources WHERE id='legacy-optiver'").get()).toEqual({
      kind: "optiver", source_url: "https://optiver.com/en/api/v1/jobs", external_key: "optiver-official",
    });
    expect(sqlite.prepare("SELECT count(*) AS count FROM discovery_sources WHERE lower(company_name)='optiver'").get()).toEqual({ count: 1 });
    sqlite.close();
  });

  it("coalesces overlapping checks into one durable run", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    const item = source(service, "acme");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetch = vi.fn(async () => { await gate; return response(); });
    vi.stubGlobal("fetch", fetch);
    const first = service.run(item.id);
    const second = service.run(item.id);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a[0].id).toBe(b[0].id);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT count(*) AS count FROM discovery_runs").get()).toEqual({ count: 1 });
    sqlite.close();
  });

  it("deduplicates the same role across approved sources and retains functional query parameters", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    source(service, "acme-a");
    source(service, "acme-b");
    vi.stubGlobal("fetch", vi.fn(async () => response("shared-requisition")));
    await service.run();
    const workspace = service.workspace();
    expect(workspace.postings).toHaveLength(1);
    expect(workspace.postings[0].applyUrl).toContain("?job=");
    expect(sqlite.prepare("SELECT count(*) AS count FROM discovery_posting_aliases").get()).toEqual({ count: 2 });
    sqlite.close();
  });

  it("does not merge separate requisitions that merely share company, title, and location", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    source(service, "distinct-a");
    source(service, "distinct-b");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => response(url.includes("distinct-a") ? "req-a" : "req-b")));
    await service.run();
    expect(service.workspace().postings).toHaveLength(2);
    sqlite.close();
  });

  it("keeps distinct same-source requisitions separate even when their visible details match", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    const item = source(service, "same-source-distinct");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ jobs: [
      { id: "REQ-100", title: "Quantitative Trading Intern", absolute_url: "https://jobs.example/REQ-100", location: { name: "London" }, content: "The same role description." },
      { id: "REQ-200", title: "Quantitative Trading Intern", absolute_url: "https://jobs.example/REQ-200", location: { name: "London" }, content: "The same role description." },
    ] }))));

    await service.run(item.id);

    expect(service.workspace().postings).toHaveLength(2);
    expect(sqlite.prepare("SELECT count(*) AS count FROM discovery_posting_aliases").get()).toEqual({ count: 2 });
    sqlite.close();
  });

  it("merges a cross-provider role with the same requisition id even when its URLs differ", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    source(service, "cross-provider-greenhouse");
    service.createSource({ name: "Acme Lever", kind: "lever", companyName: "Acme", sourceUrl: "https://api.lever.co/v0/postings/acme?mode=json", externalKey: "acme", enabled: true, checkIntervalMinutes: 60 });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).includes("lever.co")
      ? new Response(JSON.stringify([{ id: "REQ-4242", text: "Quantitative Trading Intern", hostedUrl: "https://jobs.lever.co/acme/REQ-4242", applyUrl: "https://jobs.lever.co/acme/REQ-4242/apply", categories: { location: "London" }, descriptionPlain: "Applications close 12 August 2026." }]))
      : response("REQ-4242")));
    await service.run();
    expect(service.workspace().postings).toHaveLength(1);
    expect(sqlite.prepare("SELECT count(*) AS count FROM discovery_posting_aliases").get()).toEqual({ count: 2 });
    sqlite.close();
  });

  it("does not treat short generic provider ids as cross-source requisition evidence", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    source(service, "generic-id-greenhouse");
    service.createSource({ name: "Acme Lever", kind: "lever", companyName: "Acme", sourceUrl: "https://api.lever.co/v0/postings/generic?mode=json", externalKey: "generic", enabled: true, checkIntervalMinutes: 60 });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).includes("lever.co")
      ? new Response(JSON.stringify([{ id: "1", text: "Different Operations Role", hostedUrl: "https://jobs.lever.co/acme/one", categories: { location: "Paris" }, descriptionPlain: "Different work." }]))
      : response("1")));
    await service.run();
    expect(service.workspace().postings).toHaveLength(2);
    sqlite.close();
  });

  it("merges only a unique high-similarity cross-provider identity and avoids ambiguous false merges", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    const greenhouse = source(service, "identity-greenhouse");
    vi.stubGlobal("fetch", vi.fn(async () => response("GH-1", "Build trading systems with Python, market data, and production risk controls.")));
    await service.run(greenhouse.id);
    service.createSource({ name: "Acme Lever", kind: "lever", companyName: "Acme", sourceUrl: "https://api.lever.co/v0/postings/acme?mode=json", externalKey: "acme", enabled: true, checkIntervalMinutes: 60 });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).includes("lever.co")
      ? new Response(JSON.stringify([{ id: "LEV-9", text: "Quantitative Trading Intern", hostedUrl: "https://jobs.lever.co/acme/LEV-9", categories: { location: "London" }, descriptionPlain: "Build trading systems with Python, market data, and production risk controls." }]))
      : response("GH-1", "Build trading systems with Python, market data, and production risk controls.")));
    await service.run();
    expect(service.workspace().postings).toHaveLength(1);

    sqlite.prepare("INSERT INTO discovered_postings SELECT 'ambiguous',source_id,'other',canonical_url || '/other',apply_url || '/other',company_name,title,location,programme,sector,firm_type,role_family,work_mode,sponsorship,side,description,source_posted_at,deadline_at,first_seen_at,last_seen_at,last_checked_at,removed_at,availability,missing_count,'other',saved_job_posting_id,hidden_at,created_at,updated_at,deleted_at,1 FROM discovered_postings LIMIT 1").run();
    sqlite.prepare("INSERT INTO discovery_posting_aliases SELECT source_id,'other','ambiguous',first_seen_at,last_seen_at,last_checked_at,removed_at,availability,missing_count,'other',created_at FROM discovery_posting_aliases LIMIT 1").run();
    const secondLever = service.createSource({ name: "Acme Lever mirror", kind: "lever", companyName: "Acme", sourceUrl: "https://api.lever.co/v0/postings/acme-mirror?mode=json", externalKey: "acme-mirror", enabled: true, checkIntervalMinutes: 60 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ id: "LEV-10", text: "Quantitative Trading Intern", hostedUrl: "https://jobs.lever.co/acme/LEV-10", categories: { location: "London" }, descriptionPlain: "Build trading systems with Python, market data, and production risk controls." }]))));
    await service.run(secondLever.id);
    expect(service.workspace().postings).toHaveLength(3);
    sqlite.close();
  });

  it("tracks disappearance per alias and keeps a canonical role open while another source still sees it", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    const first = source(service, "alias-a");
    const second = source(service, "alias-b");
    let emptySource = "__none__";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).includes(emptySource) ? new Response(JSON.stringify({ jobs: [] })) : response("shared")));
    await service.run();
    emptySource = "alias-a";
    await service.run(first.id);
    await service.run(first.id);
    await service.run(first.id);
    await service.run(first.id);
    expect(service.workspace().postings[0].availability).toBe("Open");
    expect(sqlite.prepare("SELECT availability,missing_count FROM discovery_posting_aliases WHERE source_id=?").get(first.id)).toEqual({ availability: "Removed", missing_count: 3 });
    expect(sqlite.prepare("SELECT state,note FROM discovery_observations WHERE state='Removed' ORDER BY observed_at DESC LIMIT 1").get()).toEqual({
      state: "Removed",
      note: expect.stringContaining("availability changed"),
    });
    emptySource = "alias-b";
    await service.run(second.id);
    await service.run(second.id);
    await service.run(second.id);
    await service.run(second.id);
    expect(service.workspace().postings[0].availability).toBe("Removed");
    sqlite.close();
  });

  it("records explicit changed and restored observations with auditable context", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    const item = source(service, "observation-history");
    let mode: "open" | "changed" | "empty" = "open";
    vi.stubGlobal("fetch", vi.fn(async () => mode === "empty"
      ? new Response(JSON.stringify({ jobs: [] }))
      : response("role-1", mode === "changed" ? "Applications close 12 August 2026. Python and C++ required." : "Applications close 12 August 2026.")));

    await service.run(item.id);
    mode = "changed";
    await service.run(item.id);
    expect(sqlite.prepare("SELECT state,note FROM discovery_observations WHERE state='Changed' ORDER BY observed_at DESC LIMIT 1").get()).toEqual({
      state: "Changed",
      note: expect.stringMatching(/Previous hash: .+ Current hash: .+/),
    });

    mode = "empty";
    await service.run(item.id);
    await service.run(item.id);
    await service.run(item.id);
    await service.run(item.id);
    expect(service.workspace().postings[0].availability).toBe("Removed");

    mode = "changed";
    await service.run(item.id);
    expect(service.workspace().postings[0].availability).toBe("Open");
    expect(sqlite.prepare("SELECT state,note FROM discovery_observations WHERE state='Restored' ORDER BY observed_at DESC LIMIT 1").get()).toEqual({
      state: "Restored",
      note: expect.stringMatching(/Removed to Open/),
    });
    sqlite.close();
  });

  it("records an expired observation when a confirmed removal follows its deadline", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    const item = source(service, "expired-history");
    let available = true;
    vi.stubGlobal("fetch", vi.fn(async () => available ? response("expired-role", "Applications close 12 August 2020.") : new Response(JSON.stringify({ jobs: [] }))));

    await service.run(item.id);
    available = false;
    await service.run(item.id);
    await service.run(item.id);
    await service.run(item.id);
    await service.run(item.id);

    expect(service.workspace().postings[0].availability).toBe("Expired");
    expect(sqlite.prepare("SELECT state,note FROM discovery_observations WHERE state='Expired' ORDER BY observed_at DESC LIMIT 1").get()).toEqual({
      state: "Expired",
      note: expect.stringMatching(/to Expired/),
    });
    sqlite.close();
  });

  it("renews a token-owned lease so another service cannot overlap a live run", async () => {
    const sqlite = database();
    const firstService = new DiscoveryService(sqlite, { leaseDurationMs: 60, heartbeatMs: 10 });
    const secondService = new DiscoveryService(sqlite, { leaseDurationMs: 60, heartbeatMs: 10 });
    const item = source(firstService, "leased");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetch = vi.fn(async () => { await gate; return response(); });
    vi.stubGlobal("fetch", fetch);
    const first = firstService.run(item.id);
    await new Promise((resolve) => setTimeout(resolve, 90));
    const second = secondService.run(item.id);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a[0].id).toBe(b[0].id);
    expect(fetch).toHaveBeenCalledTimes(1);
    sqlite.close();
  });

  it("emits deduplicated new, changed, and deadline alerts with direct links", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    source(service, "alerts");
    service.createRule({ name: "London quant", enabled: true, telegramEnabled: false, companies: [], side: "either", roleFamilies: [], programmes: [], locations: ["London"], keywords: ["trading"], newWithinHours: 720 });
    const fetch = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetch);
    await service.run();
    fetch.mockImplementation(async () => response("role-1", "Updated trading role. Applications close 12 August 2026."));
    await service.run();
    await service.run();
    const events = service.workspace().alerts;
    expect(events.filter((event) => event.eventType === "new_match")).toHaveLength(1);
    expect(events.filter((event) => event.eventType === "posting_changed")).toHaveLength(1);
    expect(events.filter((event) => event.eventType === "deadline_soon")).toHaveLength(1);
    expect(events.every((event) => event.eventType === "test" || event.directUrl.includes("?job="))).toBe(true);
    expect(events.every((event) => ["Company:", "Role:", "Location:", "Detected:", "Reason:", "Direct link:"].every((label) => event.body.includes(label)))).toBe(true);
    sqlite.close();
  });

  it("does not report a material change when only tracking parameters change", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    const item = source(service, "tracking-url");
    const feed = (campaign: string) => new Response(JSON.stringify({ jobs: [{
      id: "role-1", title: "Quantitative Trading Intern", absolute_url: `https://jobs.example/role-1?utm_campaign=${campaign}&gh_src=${campaign}`,
      location: { name: "London" }, created_at: "2026-08-01T09:00:00Z", content: "Stable trading role description.",
    }] }));
    vi.stubGlobal("fetch", vi.fn(async () => feed("first")));
    await service.run(item.id);
    vi.stubGlobal("fetch", vi.fn(async () => feed("second")));
    const [run] = await service.run(item.id);
    expect(run.changedCount).toBe(0);
    expect(service.workspace().alerts.filter((event) => event.eventType === "posting_changed")).toHaveLength(0);
    sqlite.close();
  });

  it("compares material changes against each alias across unchanged consecutive runs", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    const greenhouse = source(service, "alias-hash-greenhouse");
    const lever = service.createSource({ name: "Acme Lever", kind: "lever", companyName: "Acme", sourceUrl: "https://api.lever.co/v0/postings/acme?mode=json", externalKey: "acme", enabled: true, checkIntervalMinutes: 60 });
    let greenhouseDescription = "Stable Greenhouse description.";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).includes("lever.co")
      ? new Response(JSON.stringify([{ id: "REQ-4242", text: "Quantitative Trading Intern", hostedUrl: "https://jobs.lever.co/acme/REQ-4242", applyUrl: "https://jobs.lever.co/acme/REQ-4242/apply", categories: { location: "London" }, descriptionPlain: "Different stable Lever description." }]))
      : response("REQ-4242", greenhouseDescription)));

    await service.run(greenhouse.id);
    await service.run(lever.id);
    const [unchangedAfterOtherAlias] = await service.run(greenhouse.id);
    const [unchangedConsecutive] = await service.run(greenhouse.id);
    greenhouseDescription = "A legitimate material Greenhouse update.";
    const [changed] = await service.run(greenhouse.id);
    const [unchangedAfterChange] = await service.run(greenhouse.id);

    expect(unchangedAfterOtherAlias.changedCount).toBe(0);
    expect(unchangedConsecutive.changedCount).toBe(0);
    expect(changed.changedCount).toBe(1);
    expect(unchangedAfterChange.changedCount).toBe(0);
    expect(sqlite.prepare("SELECT count(*) AS count FROM discovered_postings").get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT count(*) AS count FROM discovery_posting_aliases").get()).toEqual({ count: 2 });
    sqlite.close();
  });

  it("persists Telegram work without waiting for provider delivery and preserves alert deduplication", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    source(service, "durable-alerts");
    service.createRule({ name: "All quant", enabled: true, telegramEnabled: true, companies: [], side: "either", roleFamilies: [], programmes: [], locations: [], keywords: ["trading"], newWithinHours: 720 });
    let telegramCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("api.telegram.org")) {
        telegramCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }));
      }
      return response("role-1", "Applications remain open while vacancies last.");
    }));
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "test-chat";

    const started = Date.now();
    await service.run();
    expect(Date.now() - started).toBeLessThan(90);
    expect(telegramCalls).toBe(0);
    expect(sqlite.prepare("SELECT state,attempt_count FROM notification_deliveries WHERE provider='telegram'").get()).toEqual({ state: "Pending", attempt_count: 0 });

    await service.run();
    expect(sqlite.prepare("SELECT count(*) AS count FROM alert_events WHERE event_type='new_match'").get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT count(*) AS count FROM notification_deliveries WHERE provider='telegram'").get()).toEqual({ count: 1 });
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    sqlite.close();
  });

  it("commits discovery and its alerts atomically", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    const item = source(service, "atomic-alert");
    service.createRule({ name: "All trading", enabled: true, telegramEnabled: false, companies: [], side: "either", roleFamilies: [], programmes: [], locations: [], keywords: ["trading"], newWithinHours: 720 });
    sqlite.exec(`CREATE TRIGGER reject_alert_insert BEFORE INSERT ON alert_events BEGIN SELECT RAISE(ABORT, 'simulated alert persistence failure'); END;`);
    vi.stubGlobal("fetch", vi.fn(async () => response("atomic-role")));

    const [run] = await service.run(item.id);

    expect(run.state).toBe("Failed");
    expect(sqlite.prepare("SELECT count(*) AS count FROM discovered_postings").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT count(*) AS count FROM discovery_observations").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT count(*) AS count FROM alert_events").get()).toEqual({ count: 0 });
    sqlite.close();
  });

  it("emits every recurring A to B to A to B material transition once", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    const item = source(service, "recurring-change-alert");
    service.createRule({ name: "All trading", enabled: true, telegramEnabled: false, companies: [], side: "either", roleFamilies: [], programmes: [], locations: [], keywords: ["trading"], newWithinHours: 720 });
    let description = "Version A trading responsibilities.";
    vi.stubGlobal("fetch", vi.fn(async () => response("role-1", description)));

    await service.run(item.id);
    description = "Version B trading responsibilities.";
    await service.run(item.id);
    description = "Version A trading responsibilities.";
    await service.run(item.id);
    description = "Version B trading responsibilities.";
    await service.run(item.id);

    const changes = service.workspace().alerts.filter((event) => event.eventType === "posting_changed");
    expect(changes).toHaveLength(3);
    expect(new Set(changes.map((event) => event.deduplicationKey)).size).toBe(3);
    sqlite.close();
  });

  it("marks an expired in-flight Telegram claim ambiguous and requires an explicit duplicate confirmation", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite, { deliveryLeaseMs: 1_000 });
    const item = source(service, "ambiguous-alert");
    service.createRule({ name: "All trading", enabled: true, telegramEnabled: true, companies: [], side: "either", roleFamilies: [], programmes: [], locations: [], keywords: ["trading"], newWithinHours: 720 });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input).includes("api.telegram.org")
      ? new Response(JSON.stringify({ ok: true, result: { message_id: 91 } }))
      : response("role-1")));
    await service.run(item.id);
    const delivery = sqlite.prepare("SELECT id FROM notification_deliveries WHERE provider='telegram'").get() as { id: string };
    sqlite.prepare("UPDATE notification_deliveries SET state='Sending',claim_token='lost',claimed_until='2000-01-01T00:00:00.000Z'").run();

    const restarted = new DiscoveryService(sqlite);
    expect(sqlite.prepare("SELECT state FROM notification_deliveries WHERE id=?").get(delivery.id)).toEqual({ state: "Ambiguous" });
    await expect(restarted.retryTelegramDelivery(delivery.id)).rejects.toThrow(/may already have delivered/i);

    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "test-chat";
    await restarted.retryTelegramDelivery(delivery.id, true);
    expect(sqlite.prepare("SELECT state,provider_attempt_count FROM notification_deliveries WHERE id=?").get(delivery.id)).toEqual({ state: "Delivered", provider_attempt_count: 1 });
    expect((sqlite.prepare("SELECT state FROM notification_delivery_attempts WHERE delivery_id=? ORDER BY sequence").all(delivery.id) as Array<{ state: string }>).map((row) => row.state))
      .toEqual(["Ambiguous", "Started", "Delivered"]);
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    sqlite.close();
  });

  it("retains configuration failures and automatically delivers when credentials appear", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    const item = source(service, "credential-recovery");
    service.createRule({ name: "All trading", enabled: true, telegramEnabled: true, companies: [], side: "either", roleFamilies: [], programmes: [], locations: [], keywords: ["trading"], newWithinHours: 720 });
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input).includes("api.telegram.org")
      ? new Response(JSON.stringify({ ok: true, result: { message_id: 92 } }))
      : response("role-1")));
    await service.run(item.id);
    await service.processNotificationDeliveries();
    const delivery = sqlite.prepare("SELECT id,state FROM notification_deliveries WHERE provider='telegram'").get() as { id: string; state: string };
    expect(delivery.state).toBe("ConfigurationRequired");

    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "test-chat";
    await service.processNotificationDeliveries();

    expect(sqlite.prepare("SELECT state,attempt_count,last_error FROM notification_deliveries WHERE id=?").get(delivery.id)).toEqual({ state: "Delivered", attempt_count: 1, last_error: "" });
    const history = sqlite.prepare("SELECT state,error FROM notification_delivery_attempts WHERE delivery_id=? ORDER BY sequence").all(delivery.id) as Array<{ state: string; error: string }>;
    expect(history.map((row) => row.state)).toEqual(["ConfigurationRequired", "Started", "Delivered"]);
    expect(history[0].error).toBe("Telegram is not configured.");
    expect(() => sqlite.prepare("UPDATE notification_delivery_attempts SET error='erased' WHERE delivery_id=?").run(delivery.id)).toThrow(/immutable/);
    expect(() => sqlite.prepare("DELETE FROM notification_delivery_attempts WHERE delivery_id=?").run(delivery.id)).toThrow(/immutable/);
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    sqlite.close();
  });

  it("keeps permanent failures terminal, respects Retry-After, and pages immutable delivery history", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "test-chat";
    let responseStatus = 401;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false }), {
      status: responseStatus,
      headers: responseStatus === 429 ? { "retry-after": "120" } : {},
    })));

    await expect(service.sendTestAlert()).rejects.toThrow("HTTP 401");
    const failed = sqlite.prepare("SELECT id,state,next_attempt_at FROM notification_deliveries WHERE provider='telegram'").get() as { id: string; state: string; next_attempt_at: string | null };
    expect(failed).toMatchObject({ state: "Failed", next_attempt_at: null });

    responseStatus = 429;
    await expect(service.sendTestAlert()).rejects.toThrow("HTTP 429");
    const rateLimited = sqlite.prepare("SELECT state,next_attempt_at FROM notification_deliveries WHERE provider='telegram' ORDER BY created_at DESC,id DESC LIMIT 1").get() as { state: string; next_attempt_at: string };
    expect(rateLimited.state).toBe("Pending");
    expect(new Date(rateLimited.next_attempt_at).getTime() - Date.now()).toBeGreaterThan(110_000);

    for (let index = 0; index < 28; index += 1) {
      const timestamp = new Date(Date.now() - (index + 1) * 1_000).toISOString();
      const alertId = `page-alert-${index}`;
      sqlite.prepare("INSERT INTO alert_events (id,event_type,title,body,direct_url,deduplication_key,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(alertId, "test", `Page ${index}`, "Body", `https://jobs.example/${index}`, `page-${index}`, timestamp);
      sqlite.prepare("INSERT INTO notification_deliveries (id,alert_event_id,provider,state,created_at,updated_at) VALUES (?,?,?,?,?,?)")
        .run(`page-delivery-${index}`, alertId, "telegram", "Delivered", timestamp, timestamp);
    }
    const first = service.listNotificationDeliveries({ limit: 10 });
    const second = service.listNotificationDeliveries({ limit: 10, cursor: first.nextCursor ?? undefined });
    expect(first.items).toHaveLength(10);
    expect(second.items).toHaveLength(10);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(20);
    expect(first.nextCursor).toBeTruthy();
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    sqlite.close();
  });

  it("dispatches Telegram promptly after an on-demand discovery run", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    const item = source(service, "prompt-dispatch");
    service.createRule({ name: "All trading", enabled: true, telegramEnabled: true, companies: [], side: "either", roleFamilies: [], programmes: [], locations: [], keywords: ["trading"], newWithinHours: 720 });
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "test-chat";
    let telegramCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("api.telegram.org")) { telegramCalls += 1; return new Response(JSON.stringify({ ok: true, result: { message_id: 93 } })); }
      return response("role-1", "Trading role with no listed deadline.");
    }));

    await service.run(item.id);
    await vi.waitFor(() => expect(telegramCalls).toBe(1));
    expect(sqlite.prepare("SELECT state FROM notification_deliveries WHERE provider='telegram'").get()).toEqual({ state: "Delivered" });
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    sqlite.close();
  });

  it("claims Telegram deliveries atomically with bounded concurrency", async () => {
    const sqlite = database();
    const serviceA = new DiscoveryService(sqlite, { deliveryConcurrency: 2 });
    const serviceB = new DiscoveryService(sqlite, { deliveryConcurrency: 2 });
    source(serviceA, "claim-alerts");
    serviceA.createRule({ name: "All quant", enabled: true, telegramEnabled: true, companies: [], side: "either", roleFamilies: [], programmes: [], locations: [], keywords: ["trading"], newWithinHours: 720 });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input).includes("api.telegram.org")
      ? new Response(JSON.stringify({ ok: true, result: { message_id: 8 } }))
      : response("role-1", "Applications remain open while vacancies last.")));
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "test-chat";
    await serviceA.run();

    await Promise.all([serviceA.processNotificationDeliveries(), serviceB.processNotificationDeliveries()]);

    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => String(url).includes("api.telegram.org"))).toHaveLength(1);
    expect(sqlite.prepare("SELECT state,attempt_count,claim_token,claimed_until FROM notification_deliveries WHERE provider='telegram'").get())
      .toEqual({ state: "Delivered", attempt_count: 1, claim_token: null, claimed_until: null });
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    sqlite.close();
  });

  it("requires explicit confirmation before retrying an ambiguous delivery after restart", async () => {
    const sqlite = database();
    const firstService = new DiscoveryService(sqlite);
    source(firstService, "retry-alerts");
    firstService.createRule({ name: "All quant", enabled: true, telegramEnabled: true, companies: [], side: "either", roleFamilies: [], programmes: [], locations: [], keywords: ["trading"], newWithinHours: 720 });
    let telegramAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (!String(input).includes("api.telegram.org")) return response("role-1", "Applications remain open while vacancies last.");
      telegramAttempts += 1;
      if (telegramAttempts === 1) throw new Error("temporary failure");
      return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }));
    }));
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "test-chat";
    await firstService.run();
    await firstService.processNotificationDeliveries();
    expect(sqlite.prepare("SELECT state,attempt_count FROM notification_deliveries WHERE provider='telegram'").get()).toEqual({ state: "Ambiguous", attempt_count: 1 });
    const delivery = sqlite.prepare("SELECT id FROM notification_deliveries WHERE provider='telegram'").get() as { id: string };

    const restartedService = new DiscoveryService(sqlite);
    await expect(restartedService.retryTelegramDelivery(delivery.id)).rejects.toThrow(/may already have delivered/i);
    await restartedService.retryTelegramDelivery(delivery.id, true);

    expect(telegramAttempts).toBe(2);
    expect(sqlite.prepare("SELECT state,attempt_count,claim_token FROM notification_deliveries WHERE provider='telegram'").get())
      .toEqual({ state: "Delivered", attempt_count: 2, claim_token: null });
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    sqlite.close();
  });

  it("does not reset a Telegram delivery while another worker owns its claim", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    source(service, "manual-retry-claim");
    service.createRule({ name: "All quant", enabled: true, telegramEnabled: true, companies: [], side: "either", roleFamilies: [], programmes: [], locations: [], keywords: ["trading"], newWithinHours: 720 });
    vi.stubGlobal("fetch", vi.fn(async () => response("role-1", "Applications remain open while vacancies last.")));
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "test-chat";
    await service.run();
    const delivery = sqlite.prepare("SELECT id FROM notification_deliveries WHERE provider='telegram'").get() as { id: string };
    sqlite.prepare("UPDATE notification_deliveries SET state='Failed',claim_token='active-worker',claimed_until=? WHERE id=?")
      .run("2999-01-01T00:00:00.000Z", delivery.id);

    await expect(service.retryTelegramDelivery(delivery.id)).rejects.toThrow(/already pending or being sent/i);
    expect(sqlite.prepare("SELECT state,claim_token FROM notification_deliveries WHERE id=?").get(delivery.id))
      .toEqual({ state: "Failed", claim_token: "active-worker" });
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    sqlite.close();
  });

  it("allows an explicit manual retry after the automatic attempt cap without erasing history", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    source(service, "manual-after-cap");
    service.createRule({ name: "All trading", enabled: true, telegramEnabled: true, companies: [], side: "either", roleFamilies: [], programmes: [], locations: [], keywords: ["trading"], newWithinHours: 720 });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input).includes("api.telegram.org")
      ? new Response(JSON.stringify({ ok: true, result: { message_id: 101 } }))
      : response("role-1", "Trading role without a deadline.")));
    await service.run();
    const delivery = sqlite.prepare("SELECT id FROM notification_deliveries WHERE provider='telegram'").get() as { id: string };
    sqlite.prepare("UPDATE notification_deliveries SET state='Failed',attempt_count=3,provider_attempt_count=3,last_error='Three prior failures.' WHERE id=?").run(delivery.id);
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      sqlite.prepare("INSERT INTO notification_delivery_attempts (id,delivery_id,sequence,state,error,started_at,completed_at) VALUES (?,?,?,?,?,?,?)")
        .run(`prior-${sequence}`, delivery.id, sequence, "Failed", `Failure ${sequence}`, `2026-08-08T10:0${sequence}:00.000Z`, `2026-08-08T10:0${sequence}:01.000Z`);
    }
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "test-chat";

    await service.retryTelegramDelivery(delivery.id);

    expect(sqlite.prepare("SELECT state,attempt_count FROM notification_deliveries WHERE id=?").get(delivery.id)).toEqual({ state: "Delivered", attempt_count: 4 });
    expect(sqlite.prepare("SELECT count(*) AS count FROM notification_delivery_attempts WHERE delivery_id=?").get(delivery.id)).toEqual({ count: 5 });
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    sqlite.close();
  });

  it("quarantines an anomalous mass-empty feed without incrementing missing counts", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    const item = source(service, "mass-empty");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ jobs: Array.from({ length: 6 }, (_, index) => ({
      id: `role-${index}`, title: `Quantitative Trading Intern ${index}`, absolute_url: `https://jobs.example/${index}`,
      location: { name: "London" }, created_at: "2026-08-01T09:00:00Z", content: "Applications close 12 August 2026.",
    })) }))));
    await service.run(item.id);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ jobs: [] }))));

    const [run] = await service.run(item.id);

    expect(run.state).toBe("Failed");
    expect(run.error).toContain("Inventory drop needs confirmation");
    expect(sqlite.prepare("SELECT count(*) AS count FROM discovery_posting_aliases WHERE missing_count<>0 OR availability<>'Open'").get()).toEqual({ count: 0 });
    expect(service.workspace().postings.every((posting) => posting.availability === "Open")).toBe(true);
    sqlite.close();
  });

  it("keeps a live alias open despite an old deadline and clears a removed deadline", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    const item = source(service, "deadline-refresh");
    vi.stubGlobal("fetch", vi.fn(async () => response("role-1", "Applications close 12 August 2020.")));
    await service.run(item.id);
    expect(service.workspace().postings[0]).toMatchObject({ availability: "Open", deadlineAt: "2020-08-12T00:00:00.000Z" });

    vi.stubGlobal("fetch", vi.fn(async () => response("role-1", "Applications remain open while vacancies last.")));
    await service.run(item.id);

    expect(service.workspace().postings[0]).toMatchObject({ availability: "Open", deadlineAt: null });
    sqlite.close();
  });

  it("updates, deletes, and reads alerts with stale-write protection", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    source(service, "rule-management");
    const rule = service.createRule({ name: "Original", enabled: true, telegramEnabled: false, companies: [], side: "either", roleFamilies: [], programmes: [], locations: [], keywords: ["trading"], newWithinHours: 24 });
    const updated = service.updateRule(rule.id, { expectedRevision: rule.revision, name: "Updated", enabled: false })!;
    expect(updated).toMatchObject({ name: "Updated", enabled: false, revision: 2 });
    expect(() => service.updateRule(rule.id, { expectedRevision: 1, name: "Stale" })).toThrow(/changed since/);
    expect(() => service.deleteRule(rule.id, 1)).toThrow(/changed since/);
    service.deleteRule(rule.id, updated.revision);
    expect(service.workspace().alertRules).toHaveLength(0);

    const active = service.createRule({ name: "Active", enabled: true, telegramEnabled: false, companies: [], side: "either", roleFamilies: [], programmes: [], locations: [], keywords: ["trading"], newWithinHours: 720 });
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    await service.run();
    const alert = service.workspace().alerts.find((item) => item.ruleId === active.id)!;
    expect(service.markAlertRead(alert.id, true)!.readAt).toBeTruthy();
    expect(service.markAlertRead(alert.id, false)!.readAt).toBeNull();
    sqlite.close();
  });

  it("checks 100 sources with bounded parallelism instead of sequentially", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    for (let index = 0; index < 100; index += 1) source(service, `source-${index}`, `Company ${index}`);
    let active = 0;
    let peak = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return response(url.match(/source-(\d+)/)?.[1] ?? randomId());
    }));
    const started = Date.now();
    const runs = await service.run();
    expect(runs).toHaveLength(100);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);
    expect(Date.now() - started).toBeLessThan(1_500);
    sqlite.close();
  });

  it("uses the approved paginated Optiver endpoint and imports every returned role", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    const item = service.createSource({
      name: "Optiver careers", kind: "optiver", companyName: "Optiver",
      sourceUrl: "https://optiver.com/en/api/v1/jobs", externalKey: "optiver-official", enabled: true, checkIntervalMinutes: 180,
    });
    const roles = Array.from({ length: 34 }, (_, index) => ({
      title: index === 29 ? "Quantitative Research Intern" : `Trading role ${index}`,
      location: index % 2 ? "London" : "Amsterdam", experience: index === 29 ? "Internship" : "Experienced",
      domain: index === 29 ? "Trading" : "Technology", href: `/join-us/jobs/trading/location/role-${index}/`, componentID: 10_000 + index,
    }));
    const fetch = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      const from = Number(url.searchParams.get("from") ?? 0);
      return new Response(JSON.stringify({ items: roles.slice(from, from + 16), totalCount: roles.length }));
    });
    vi.stubGlobal("fetch", fetch);

    const [run] = await service.run(item.id);

    expect(run).toMatchObject({ state: "Completed", foundCount: 34, newCount: 34 });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(service.workspace({ limit: 10, q: "Quantitative Research" }).postings).toHaveLength(1);
    expect(service.workspace().sources[0]).toMatchObject({ successfulInventoryCount: 34, lastError: "" });
    sqlite.close();
  });

  it("rejects a truncated Optiver inventory without mutating availability or source health", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    const item = service.createSource({ name: "Optiver careers", kind: "optiver", companyName: "Optiver", sourceUrl: "https://optiver.com/en/api/v1/jobs", externalKey: "optiver-official", enabled: true, checkIntervalMinutes: 180 });
    const roles = Array.from({ length: 16 }, (_, index) => ({ title: `Role ${index}`, location: "London", href: `/join-us/jobs/role-${index}/`, componentID: index + 1 }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: roles, totalCount: 40 }))));
    const [run] = await service.run(item.id);
    expect(run).toMatchObject({ state: "Failed", foundCount: 0, missingCount: 0 });
    expect(run.error).toContain("Incomplete inventory");
    expect(service.workspace().sources[0]).toMatchObject({ lastSuccessfulAt: null, lastError: expect.stringContaining("Incomplete inventory") });
    sqlite.close();
  });

  it("rejects Optiver pagination when totalCount changes between pages", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    const item = service.createSource({ name: "Optiver careers", kind: "optiver", companyName: "Optiver", sourceUrl: "https://optiver.com/en/api/v1/jobs", externalKey: "optiver-official", enabled: true, checkIntervalMinutes: 180 });
    const fetch = vi.fn(async (input: string | URL) => {
      const from = Number(new URL(String(input)).searchParams.get("from") ?? 0);
      const items = Array.from({ length: 16 }, (_, index) => ({ title: `Role ${from + index}`, location: "London", href: `/join-us/jobs/role-${from + index}/`, componentID: from + index + 1 }));
      return new Response(JSON.stringify({ items, totalCount: from ? 31 : 32 }));
    });
    vi.stubGlobal("fetch", fetch);
    const [run] = await service.run(item.id);
    expect(run).toMatchObject({ state: "Failed", missingCount: 0 });
    expect(run.error).toContain("changed totalCount");
    sqlite.close();
  });

  it("quarantines small and large inventory drops once before accepting a repeated complete count", async () => {
    for (const initialCount of [1, 20]) {
      const sqlite = database();
      const service = new DiscoveryService(sqlite);
      const item = source(service, `drop-${initialCount}`);
      let count = initialCount;
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ jobs: Array.from({ length: count }, (_, index) => ({ id: `role-${index}`, title: `Trading Analyst ${index}`, absolute_url: `https://jobs.example/${index}`, location: { name: "London" }, content: "Trading systems role." })) }))));
      await service.run(item.id);
      count = initialCount === 1 ? 0 : 10;
      const [quarantined] = await service.run(item.id);
      expect(quarantined).toMatchObject({ state: "Failed", foundCount: count, missingCount: 0 });
      expect(sqlite.prepare("SELECT MAX(missing_count) AS misses FROM discovery_posting_aliases").get()).toEqual({ misses: 0 });
      const [confirmed] = await service.run(item.id);
      expect(confirmed).toMatchObject({ state: "Completed", foundCount: count });
      expect(sqlite.prepare("SELECT MAX(missing_count) AS misses FROM discovery_posting_aliases").get()).toEqual({ misses: 1 });
      sqlite.close();
    }
  });

  it("classifies placement and entry-level programmes and filters by career track", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    const item = source(service, "programmes");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ jobs: [
      { id: "placement", title: "Software Engineering Industrial Placement", absolute_url: "https://jobs.example/placement", location: { name: "London" }, content: "Technology role." },
      { id: "entry", title: "Junior Risk Analyst Entry-Level", absolute_url: "https://jobs.example/entry", location: { name: "London" }, content: "Risk role." },
    ] }))));
    await service.run(item.id);
    expect(service.workspace({ limit: 10, programme: "Placement", careerTrack: "Technology" }).postings).toEqual([expect.objectContaining({ programme: "Placement", careerTrack: "Technology" })]);
    expect(service.workspace({ limit: 10, programme: "Entry-level", careerTrack: "Financial institutions" }).postings).toEqual([expect.objectContaining({ programme: "Entry-level", careerTrack: "Financial institutions" })]);
    sqlite.close();
  });

  it("does not label a never-productive empty source as successful", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    const item = source(service, "stale-empty");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ jobs: [] }))));

    const [run] = await service.run(item.id);

    expect(run.state).toBe("Failed");
    expect(run.error).toContain("has never yielded inventory");
    expect(service.workspace().sources[0]).toMatchObject({ lastSuccessfulAt: null, successfulInventoryCount: 0 });
    sqlite.close();
  });

  it("records the Telegram test with a safe working direct URL even when delivery is not configured", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chat = process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    try {
      await expect(service.sendTestAlert()).rejects.toThrow("TELEGRAM_BOT_TOKEN");
      const alert = service.workspace().alerts[0];
      expect(alert.directUrl).toBe("https://optiver.com/join-us/jobs/");
      expect(alert.body).toContain("Direct link: https://optiver.com/join-us/jobs/");
      expect(alert.deliveries.find((delivery) => delivery.provider === "telegram")).toMatchObject({ state: "ConfigurationRequired" });
    } finally {
      if (token) process.env.TELEGRAM_BOT_TOKEN = token; else delete process.env.TELEGRAM_BOT_TOKEN;
      if (chat) process.env.TELEGRAM_CHAT_ID = chat; else delete process.env.TELEGRAM_CHAT_ID;
      sqlite.close();
    }
  });

  it("filters beyond page one with stable keyset pagination without loading 50k records", () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    const insert = sqlite.prepare(`INSERT INTO discovered_postings
      (id,source_id,external_id,canonical_url,apply_url,company_name,title,location,programme,sector,firm_type,role_family,work_mode,sponsorship,side,description,first_seen_at,last_seen_at,last_checked_at,availability,content_hash,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    sqlite.transaction(() => {
      for (let index = 0; index < 50_000; index += 1) {
        const id = index.toString().padStart(8, "0");
        const seen = new Date(Date.UTC(2026, 7, 9, 0, 0, 0, index)).toISOString();
        const description = `Finance markets role ${id}. ${"Pricing risk execution research controls and client analytics. ".repeat(12)}`;
        insert.run(id, "source", `external-${id}`, `https://jobs.example/${id}`, `https://jobs.example/${id}`, index === 49_500 ? "Needle Capital" : "Example Capital", `Role ${id}`, index % 2 ? "London" : "Singapore", "Graduate", "Financial services", "Hedge fund", "Trading", "Hybrid", "Not stated", "buy_side", description, seen, seen, seen, "Open", id, seen, seen);
      }
    })();
    const started = performance.now();
    const first = service.workspace({ limit: 100, side: "buy_side" });
    const second = service.workspace({ limit: 100, side: "buy_side", cursor: first.nextCursor ?? undefined });
    const searched = service.workspace({ limit: 25, q: "Needle Capital" });
    const elapsed = performance.now() - started;

    expect(first.postings).toHaveLength(100);
    expect(second.postings).toHaveLength(100);
    expect(new Set([...first.postings, ...second.postings].map((posting) => posting.id)).size).toBe(200);
    expect(searched.postingTotal).toBe(1);
    expect(searched.postings[0].companyName).toBe("Needle Capital");
    expect(elapsed).toBeLessThan(1_000);
    sqlite.close();
  }, 15_000);

  it("persists hidden feed choices and incorrect-data reports", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    source(service, "feedback");
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    await service.run();
    const posting = service.workspace().postings[0];

    expect(service.setHidden(posting.id, true)?.hiddenAt).toBeTruthy();
    expect(service.reportIssue(posting.id, "The programme classification is incorrect.")).toMatchObject({ id: expect.any(String) });
    expect(sqlite.prepare("SELECT reason,state FROM discovery_issues").get()).toEqual({ reason: "The programme classification is incorrect.", state: "Open" });
    expect(service.setHidden(posting.id, false)?.hiddenAt).toBeNull();
    sqlite.close();
  });

  it("releases the source lease and records a failed run when persistence fails", async () => {
    const sqlite = database();
    const service = new DiscoveryService(sqlite);
    const item = source(service, "persistence-failure");
    sqlite.exec("CREATE TRIGGER reject_observation BEFORE INSERT ON discovery_observations BEGIN SELECT RAISE(ABORT, 'fixture persistence failure'); END;");
    vi.stubGlobal("fetch", vi.fn(async () => response()));

    const [run] = await service.run(item.id);

    expect(run.state).toBe("Failed");
    expect(run.error).toContain("fixture persistence failure");
    expect(sqlite.prepare("SELECT lease_until AS leaseUntil,last_error AS lastError FROM discovery_sources WHERE id=?").get(item.id))
      .toEqual({ leaseUntil: null, lastError: "fixture persistence failure" });
    sqlite.close();
  });

  it("drains concurrent capture, discovery, Telegram and backup workers before sealing restore", async () => {
    const sqlite = database();
    const gate = new ProcessMutationGate();
    const captureRelease = deferred<{ status: "Saved" }>();
    const discoveryRelease = deferred<void>();
    const telegramRelease = deferred<void>();
    const backupRelease = deferred<Uint8Array>();
    const capture = new CaptureQueueService(captureStore(), { process: async () => captureRelease.promise }, {
      acquireMutation: () => gate.acquire({ waitForExclusive: true }),
    });
    const discovery = new DiscoveryService(sqlite, { runMutation: (work) => gate.run(work, { waitForExclusive: true }) });
    const discoverySource = source(discovery, "gate-drain");
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "test-chat";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("api.telegram.org")) {
        await telegramRelease.promise;
        return new Response(JSON.stringify({ ok: true, result: { message_id: 88 } }), { status: 200 });
      }
      await discoveryRelease.promise;
      return response("gate-role");
    }));
    let backupEntered = false;
    const backup = new EncryptedBackupScheduler({
      storage: { upload: async (input) => ({ workspaceId: input.workspaceId, path: input.path, checksum: "hash", sizeBytes: input.bytes.byteLength }), read: async () => { throw new Error("unused"); }, delete: async () => undefined },
      workspaceId: "workspace-a", key: Buffer.alloc(32, 3), intervalMs: 60_000,
      createBundle: () => { backupEntered = true; return backupRelease.promise; },
      runExclusive: (work) => gate.exclusive(work),
    });

    try {
      await capture.start();
      const queued = await capture.enqueue({ kind: "text", text: "Concurrent capture" });
      while ((await capture.get(queued.id))?.status !== "Extracting") await new Promise((resolve) => setTimeout(resolve, 1));
      const discoveryRun = discovery.run(discoverySource.id);
      const telegramRun = discovery.sendTestAlert();
      const activeDeadline = Date.now() + 2_000;
      while (gate.activeCount < 3 && Date.now() < activeDeadline) await new Promise((resolve) => setTimeout(resolve, 1));
      expect(gate.activeCount).toBeGreaterThanOrEqual(3);

      const backupRun = backup.run();
      let restoreApplied = false;
      const restore = gate.exclusive(async () => { restoreApplied = true; }, { sealOnSuccess: true });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(backupEntered).toBe(false);
      expect(restoreApplied).toBe(false);

      captureRelease.resolve({ status: "Saved" });
      discoveryRelease.resolve();
      telegramRelease.resolve();
      await Promise.all([discoveryRun, telegramRun]);
      const captureDeadline = Date.now() + 2_000;
      while ((await capture.get(queued.id))?.status !== "Saved" && Date.now() < captureDeadline) await new Promise((resolve) => setTimeout(resolve, 1));
      expect((await capture.get(queued.id))?.status).toBe("Saved");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(backupEntered).toBe(true);
      expect(restoreApplied).toBe(false);

      backupRelease.resolve(Buffer.from("durable encrypted backup input"));
      await backupRun;
      await restore;
      await capture.waitForIdle();
      expect(restoreApplied).toBe(true);
      expect(gate.sealed).toBe(true);
      await expect(discovery.run(discoverySource.id)).rejects.toThrow(/read-only/);
    } finally {
      captureRelease.resolve({ status: "Saved" });
      discoveryRelease.resolve();
      telegramRelease.resolve();
      backupRelease.resolve(Buffer.from("cleanup"));
      await capture.stop();
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;
      sqlite.close();
    }
  }, 20_000);
});

function randomId() {
  return Math.random().toString(36).slice(2);
}
