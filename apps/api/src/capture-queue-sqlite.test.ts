import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CaptureQueueCapacityError, CaptureQueueService, type CaptureQueueJob } from "./capture-queue.js";
import { SqliteCaptureQueueStore } from "./capture-queue-sqlite.js";

const databases: Database.Database[] = [];

function createStore() {
  const sqlite = new Database(":memory:");
  databases.push(sqlite);
  sqlite.exec(`CREATE TABLE capture_queue_items (
    id TEXT PRIMARY KEY, source_type TEXT NOT NULL, source_url TEXT NOT NULL DEFAULT '',
    apply_url TEXT NOT NULL DEFAULT '', raw_text TEXT NOT NULL DEFAULT '', state TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0, progress_message TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
    import_run_id TEXT, draft_json TEXT, duplicates_json TEXT NOT NULL DEFAULT '[]', enrichment_json TEXT,
    error TEXT, started_at TEXT, completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    deleted_at TEXT, revision INTEGER NOT NULL DEFAULT 1
  )`);
  return { sqlite, store: new SqliteCaptureQueueStore(sqlite) };
}

afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close();
});

describe("SqliteCaptureQueueStore", () => {
  it("atomically inserts a complete batch and preserves apply URL and progress copy", async () => {
    const { sqlite, store } = createStore();
    const timestamp = "2026-08-08T12:00:00.000Z";
    const jobs: CaptureQueueJob[] = [
      { id: "one", input: { kind: "text", text: "First", applyUrl: "https://apply.example/one" }, status: "Queued", attempts: 0, progress: 0, progressMessage: "Waiting", result: null, error: null, createdAt: timestamp, updatedAt: timestamp, startedAt: null, finishedAt: null },
      { id: "two", input: { kind: "url", url: "https://jobs.example/two" }, status: "Queued", attempts: 0, progress: 0, progressMessage: null, result: null, error: null, createdAt: timestamp, updatedAt: timestamp, startedAt: null, finishedAt: null },
    ];
    await store.createMany(jobs);
    await store.update("one", ["Queued"], { status: "Extracting", progress: 0.4, progressMessage: "Reading source" });
    expect(await store.get("one")).toMatchObject({ input: jobs[0]!.input, progress: 0.4, progressMessage: "Reading source" });

    await expect(store.createMany([{ ...jobs[0]!, id: "three" }, { ...jobs[1]!, id: "one" }])).rejects.toThrow();
    expect((sqlite.prepare("SELECT COUNT(*) AS count FROM capture_queue_items").get() as { count: number }).count).toBe(2);
  });

  it("recovers an interrupted SQLite-backed job after a service restart", async () => {
    const { store } = createStore();
    const first = new CaptureQueueService(store, { process: async () => ({ status: "Saved" }) }, { createId: () => "restart-job" });
    await first.enqueue({ kind: "text", text: "Restart test" });
    await store.update("restart-job", ["Queued"], { status: "Extracting", progress: 0.6, progressMessage: "Interrupted process", updatedAt: "2000-01-01T00:00:00.000Z" });

    const restarted = new CaptureQueueService(store, { process: async () => ({ status: "Needs Review" }) });
    await restarted.start();
    await restarted.waitForIdle();
    expect(await store.get("restart-job")).toMatchObject({ status: "Needs Review", attempts: 1, progress: 1 });
  });

  it("keeps an over-capacity SQLite batch all-or-nothing", async () => {
    const { store } = createStore();
    const service = new CaptureQueueService(store, { process: async () => ({ status: "Saved" }) }, { capacity: 2 });
    await service.enqueue({ kind: "text", text: "Existing" });
    await expect(service.enqueueBatch([{ kind: "text", text: "A" }, { kind: "text", text: "B" }])).rejects.toBeInstanceOf(CaptureQueueCapacityError);
    expect(await store.list()).toHaveLength(1);
  });

  it("rolls back the queue and handoff mutation together when either side fails", async () => {
    const { sqlite, store } = createStore();
    sqlite.exec("CREATE TABLE capture_drafts (id TEXT PRIMARY KEY, deleted_at TEXT)");
    sqlite.prepare("INSERT INTO capture_drafts (id,deleted_at) VALUES (?,NULL)").run("draft-1");
    const timestamp = "2026-08-08T12:00:00.000Z";
    const job: CaptureQueueJob = { id: "atomic-job", input: { kind: "text", text: "Atomic handoff" }, status: "Queued", attempts: 0, progress: 0, progressMessage: null, result: null, error: null, createdAt: timestamp, updatedAt: timestamp, startedAt: null, finishedAt: null };

    await expect(store.createMany([job], 100, () => {
      sqlite.prepare("UPDATE capture_drafts SET deleted_at=? WHERE id=?").run(timestamp, "draft-1");
      throw new Error("simulated handoff interruption");
    })).rejects.toThrow(/interruption/);

    expect(await store.get("atomic-job")).toBeNull();
    expect(sqlite.prepare("SELECT deleted_at AS deletedAt FROM capture_drafts WHERE id=?").get("draft-1")).toEqual({ deletedAt: null });
  });

  it("allows only one of two workers to claim the same durable job", async () => {
    const { store } = createStore();
    let calls = 0;
    const processor = { process: async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return { status: "Needs Review" as const }; } };
    const first = new CaptureQueueService(store, processor, { concurrency: 1, createId: () => "shared-job" });
    const second = new CaptureQueueService(store, processor, { concurrency: 1 });
    await first.enqueue({ kind: "text", text: "One durable job" });
    await Promise.all([first.start(), second.start()]);
    const deadline = Date.now() + 2_000;
    while ((await store.get("shared-job"))?.status !== "Needs Review") {
      if (Date.now() > deadline) throw new Error("Shared worker test timed out.");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(calls).toBe(1);
    expect(await store.get("shared-job")).toMatchObject({ status: "Needs Review", attempts: 1 });
    await Promise.all([first.stop(), second.stop()]);
  });

  it("compares queued duplicate candidates across pasted-text and URL capture modes", async () => {
    const { store } = createStore();
    const earlier: CaptureQueueJob = {
      id: "text-capture", input: { kind: "text", text: "Quant Trader\nCompany: Example Capital" }, status: "Needs Review", attempts: 1,
      progress: 1, progressMessage: "Ready", result: null, error: null, createdAt: "2026-08-08T12:00:00.000Z", updatedAt: "2026-08-08T12:00:01.000Z", startedAt: null, finishedAt: null,
    };
    const later: CaptureQueueJob = {
      id: "url-capture", input: { kind: "url", url: "https://jobs.example/quant-trader" }, status: "Extracting", attempts: 1,
      progress: 0.5, progressMessage: "Comparing", result: null, error: null, createdAt: "2026-08-08T12:01:00.000Z", updatedAt: "2026-08-08T12:01:01.000Z", startedAt: null, finishedAt: null,
    };
    await store.createMany([earlier, later]);
    expect(await store.findPotentialDuplicates(later, "Quant Trader", "Example Capital"))
      .toEqual([expect.objectContaining({ id: earlier.id, input: expect.objectContaining({ kind: "text" }) })]);
  });

  it("pages 100 realistic captures with a stable keyset without loading full source text", async () => {
    const { store } = createStore();
    const longText = "LinkedIn job description with requirements and company context. ".repeat(1_200);
    const jobs = Array.from({ length: 100 }, (_, index): CaptureQueueJob => {
      const timestamp = new Date(Date.UTC(2026, 7, 8, 12, 0, index)).toISOString();
      return { id: `job-${String(index).padStart(3, "0")}`, input: { kind: "text", text: `${longText}${index}` }, status: "Queued", attempts: 0, progress: 0, progressMessage: null, result: null, error: null, createdAt: timestamp, updatedAt: timestamp, startedAt: null, finishedAt: null };
    });
    await store.createMany(jobs);
    const started = performance.now();
    const first = await store.listPage({ limit: 40 });
    const second = await store.listPage({ limit: 40, cursor: first.nextCursor ?? undefined });
    const third = await store.listPage({ limit: 40, cursor: second.nextCursor ?? undefined });
    expect([...first.jobs, ...second.jobs, ...third.jobs].map((job) => job.id)).toHaveLength(100);
    expect(new Set([...first.jobs, ...second.jobs, ...third.jobs].map((job) => job.id)).size).toBe(100);
    expect(first.jobs[0]?.input.kind === "text" && first.jobs[0].input.text.length).toBeLessThanOrEqual(500);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
