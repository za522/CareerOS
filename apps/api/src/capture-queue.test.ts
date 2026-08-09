import { describe, expect, it } from "vitest";
import {
  CaptureQueueCapacityError,
  CaptureQueueService,
  type CaptureProcessResult,
  type CaptureQueueJob,
  type CaptureQueueJobUpdate,
  type CaptureQueueProcessor,
  type CaptureQueueStatus,
  type CaptureQueueStore,
} from "./capture-queue.js";
import { ProcessMutationGate } from "./mutation-gate.js";

class MemoryCaptureQueueStore implements CaptureQueueStore {
  private readonly jobs = new Map<string, CaptureQueueJob>();

  async create(job: CaptureQueueJob): Promise<void> {
    if (this.jobs.has(job.id)) throw new Error(`Duplicate job id ${job.id}.`);
    this.jobs.set(job.id, structuredClone(job));
  }

  async createMany(jobs: CaptureQueueJob[], capacity?: number, onPersist?: () => void): Promise<void> {
    if (capacity !== undefined && [...this.jobs.values()].filter((job) => ["Queued", "Extracting"].includes(job.status)).length + jobs.length > capacity) throw new CaptureQueueCapacityError(capacity);
    if (jobs.some((job) => this.jobs.has(job.id))) throw new Error("Duplicate job id in batch.");
    const before = new Map(this.jobs);
    try {
      for (const job of jobs) this.jobs.set(job.id, structuredClone(job));
      onPersist?.();
    } catch (error) {
      this.jobs.clear();
      for (const [id, job] of before) this.jobs.set(id, job);
      throw error;
    }
  }

  async get(id: string): Promise<CaptureQueueJob | null> {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : null;
  }

  async list(): Promise<CaptureQueueJob[]> {
    return [...this.jobs.values()].map((job) => structuredClone(job));
  }

  async countPending(): Promise<number> {
    return [...this.jobs.values()].filter((job) => ["Queued", "Extracting"].includes(job.status)).length;
  }

  async summary() {
    const jobs = [...this.jobs.values()];
    const counts = Object.fromEntries(["Queued", "Extracting", "Needs Review", "Duplicate", "Blocked", "Failed", "Saved"].map((status) => [status, 0])) as Record<CaptureQueueStatus, number>;
    let progress = 0;
    for (const job of jobs) { counts[job.status] += 1; progress += ["Queued", "Extracting"].includes(job.status) ? job.progress : 1; }
    const pending = counts.Queued + counts.Extracting;
    return { total: jobs.length, pending, completed: jobs.length - pending, overallProgress: jobs.length ? Math.round(progress / jobs.length * 10_000) / 10_000 : 1, counts };
  }

  async claimNext(updatedAt: string, startedAt: string): Promise<CaptureQueueJob | null> {
    const queued = [...this.jobs.values()].filter((job) => job.status === "Queued").sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!queued) return null;
    return this.update(queued.id, ["Queued"], { status: "Extracting", attempts: queued.attempts + 1, progress: 0, progressMessage: "Starting extraction", error: null, updatedAt, startedAt, finishedAt: null });
  }

  async update(
    id: string,
    expectedStatuses: readonly CaptureQueueStatus[],
    update: CaptureQueueJobUpdate,
  ): Promise<CaptureQueueJob | null> {
    const current = this.jobs.get(id);
    if (!current || !expectedStatuses.includes(current.status)) return null;
    const updated = { ...current, ...structuredClone(update) };
    this.jobs.set(id, updated);
    return structuredClone(updated);
  }

  async requeueStale(cutoffTimestamp: string, updatedAt: string): Promise<number> {
    let count = 0;
    for (const [id, job] of this.jobs) {
      if (job.status !== "Extracting" || job.updatedAt > cutoffTimestamp) continue;
      this.jobs.set(id, { ...job, status: "Queued", progress: 0, progressMessage: "Resuming interrupted capture", updatedAt, startedAt: null });
      count += 1;
    }
    return count;
  }
}

function idFactory() {
  let nextId = 0;
  return () => `capture-${++nextId}`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for queue state.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("CaptureQueueService", () => {
  it("holds the process mutation gate for the full lifetime of an active capture worker", async () => {
    const gate = new ProcessMutationGate();
    const processing = deferred<CaptureProcessResult>();
    const store = new MemoryCaptureQueueStore();
    const service = new CaptureQueueService(store, { process: async () => processing.promise }, {
      createId: idFactory(),
      acquireMutation: () => gate.acquire({ waitForExclusive: true }),
    });
    await service.start();
    const queued = await service.enqueue({ kind: "text", text: "Active background capture" });
    await waitUntil(async () => (await service.get(queued.id))?.status === "Extracting");

    let restoreAccepted = false;
    const restore = gate.exclusive(async () => { restoreAccepted = true; }, { sealOnSuccess: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(restoreAccepted).toBe(false);

    processing.resolve({ status: "Needs Review" });
    await restore;
    expect(await service.get(queued.id)).toMatchObject({ status: "Needs Review" });
    await expect(gate.acquire({ waitForExclusive: true })).rejects.toThrow(/read-only/);
    await service.stop();
  });

  it("immediately resumes every interrupted extraction after process restart", async () => {
    const store = new MemoryCaptureQueueStore();
    await store.create({
      id: "interrupted", input: { kind: "text", text: "Interrupted role" }, status: "Extracting",
      progress: 0.5, progressMessage: "Old worker", attempts: 1, result: null, error: null,
      createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:01.000Z",
      startedAt: "2026-08-09T00:00:01.000Z", finishedAt: null,
    });
    const service = new CaptureQueueService(store, { process: async () => ({ status: "Saved" }) }, {
      now: () => new Date("2026-08-09T00:00:02.000Z"),
    });
    await service.start();
    await service.waitForIdle();
    expect(await service.get("interrupted")).toMatchObject({ status: "Saved", attempts: 2 });
    await service.stop();
  });

  it("accepts and normalises pasted text and HTTP(S) URL inputs", async () => {
    const store = new MemoryCaptureQueueStore();
    const service = new CaptureQueueService(store, {
      process: async () => ({ status: "Saved" }),
    }, { createId: idFactory() });

    const text = await service.enqueue({ kind: "text", text: "  Senior designer role  " });
    const url = await service.enqueue({ kind: "url", url: "https://example.com/jobs/42" });

    expect(text.input).toEqual({ kind: "text", text: "Senior designer role" });
    expect(url.input).toEqual({ kind: "url", url: "https://example.com/jobs/42" });
    await expect(service.enqueue({ kind: "text", text: "   " })).rejects.toThrow("cannot be empty");
    await expect(service.enqueue({ kind: "url", url: "file:///tmp/job.txt" })).rejects.toThrow("HTTP or HTTPS");
  });

  it("bounds pending capacity even across concurrent enqueue calls", async () => {
    const service = new CaptureQueueService(
      new MemoryCaptureQueueStore(),
      { process: async () => ({ status: "Saved" }) },
      { capacity: 2, createId: idFactory() },
    );

    const attempts = await Promise.allSettled([
      service.enqueue({ kind: "text", text: "one" }),
      service.enqueue({ kind: "text", text: "two" }),
      service.enqueue({ kind: "text", text: "three" }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(2);
    const rejection = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejection?.status === "rejected" && rejection.reason).toBeInstanceOf(CaptureQueueCapacityError);

    await service.cancel("capture-1");
    await service.enqueue({ kind: "text", text: "replacement" });
    await expect(service.retry("capture-1")).rejects.toBeInstanceOf(CaptureQueueCapacityError);
  });

  it("rejects an over-capacity batch without enqueueing any of it", async () => {
    const store = new MemoryCaptureQueueStore();
    const service = new CaptureQueueService(store, { process: async () => ({ status: "Saved" }) }, {
      capacity: 3,
      createId: idFactory(),
    });
    await service.enqueue({ kind: "text", text: "existing" });
    await expect(service.enqueueBatch([
      { kind: "text", text: "one" },
      { kind: "text", text: "two" },
      { kind: "text", text: "three" },
    ])).rejects.toBeInstanceOf(CaptureQueueCapacityError);
    expect(await service.list()).toHaveLength(1);
  });

  it("preserves a separately supplied apply URL", async () => {
    const service = new CaptureQueueService(new MemoryCaptureQueueStore(), { process: async () => ({ status: "Saved" }) });
    const job = await service.enqueue({ kind: "text", text: "Role copy", applyUrl: "https://apply.example/jobs/9" });
    expect(job.input.applyUrl).toBe("https://apply.example/jobs/9");
  });

  it("maps processor outcomes to every non-error terminal state", async () => {
    const outcomes: CaptureProcessResult[] = [
      { status: "Saved", result: { postingId: "posting-1" } },
      { status: "Needs Review", result: { confidence: 0.4 } },
      { status: "Duplicate", result: { existingId: "posting-1" } },
      { status: "Blocked", message: "Login required" },
    ];
    const service = new CaptureQueueService(
      new MemoryCaptureQueueStore(),
      { process: async () => outcomes.shift()! },
      { concurrency: 1, createId: idFactory() },
    );
    await Promise.all(["save", "review", "duplicate", "blocked"].map((text) => service.enqueue({ kind: "text", text })));

    await service.start();
    await service.waitForIdle();

    expect((await service.list()).map((job) => job.status)).toEqual([
      "Saved",
      "Needs Review",
      "Duplicate",
      "Blocked",
    ]);
    expect((await service.get("capture-4"))?.error).toBe("Login required");
  });

  it("processes 100 jobs with bounded concurrency and independent failure", async () => {
    let active = 0;
    let peakActive = 0;
    const processor: CaptureQueueProcessor = {
      process: async (job, context) => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        try {
          await context.reportProgress(0.5, "Extracted source");
          await new Promise((resolve) => setTimeout(resolve, Number(job.id.split("-")[1]) % 3));
          if (job.id === "capture-37") throw new Error("Malformed source");
          return { status: "Saved", result: { sourceKind: job.input.kind } };
        } finally {
          active -= 1;
        }
      },
    };
    const service = new CaptureQueueService(new MemoryCaptureQueueStore(), processor, {
      concurrency: 7,
      capacity: 100,
      createId: idFactory(),
    });
    await Promise.all(Array.from({ length: 100 }, (_, index) => index % 2 === 0
      ? service.enqueue({ kind: "text", text: `Job description ${index}` })
      : service.enqueue({ kind: "url", url: `https://example.com/jobs/${index}` })));

    await service.start();
    await service.waitForIdle();

    const summary = await service.summary();
    expect(peakActive).toBe(7);
    expect(summary).toMatchObject({ total: 100, pending: 0, completed: 100, overallProgress: 1 });
    expect(summary.counts.Saved).toBe(99);
    expect(summary.counts.Failed).toBe(1);
    expect((await service.get("capture-37"))?.error).toBe("Malformed source");
    expect((await service.get("capture-38"))?.status).toBe("Saved");
  });

  it("reports partial progress and retries failed work", async () => {
    const gate = deferred<CaptureProcessResult>();
    let shouldFail = true;
    const service = new CaptureQueueService(
      new MemoryCaptureQueueStore(),
      {
        process: async (_job, context) => {
          await context.reportProgress(0.25, "Reading source");
          if (shouldFail) throw new Error("Temporary extraction error");
          return gate.promise;
        },
      },
      { concurrency: 1, createId: idFactory() },
    );
    const job = await service.enqueue({ kind: "text", text: "Retry me" });
    await service.start();
    await service.waitForIdle();

    expect(await service.summary()).toMatchObject({ completed: 1, overallProgress: 1 });
    expect((await service.get(job.id))?.attempts).toBe(1);

    shouldFail = false;
    await service.retry(job.id);
    await waitUntil(async () => (await service.get(job.id))?.progress === 0.25);
    expect(await service.summary()).toMatchObject({ pending: 1, completed: 0, overallProgress: 0.25 });
    gate.resolve({ status: "Saved" });
    await service.waitForIdle();

    expect(await service.get(job.id)).toMatchObject({ status: "Saved", attempts: 2, error: null });
  });

  it("cancels in-flight work without allowing a late result to overwrite Blocked", async () => {
    const started = deferred<void>();
    const finish = deferred<CaptureProcessResult>();
    let observedAbort = false;
    const service = new CaptureQueueService(
      new MemoryCaptureQueueStore(),
      {
        process: async (_job, context) => {
          context.signal.addEventListener("abort", () => { observedAbort = true; });
          started.resolve();
          return finish.promise;
        },
      },
      { createId: idFactory() },
    );
    const job = await service.enqueue({ kind: "url", url: "https://example.com/job" });
    await service.start();
    await started.promise;

    await service.cancel(job.id);
    finish.resolve({ status: "Saved", result: { postingId: "too-late" } });
    await service.waitForIdle();

    expect(observedAbort).toBe(true);
    expect(await service.get(job.id)).toMatchObject({
      status: "Blocked",
      progressMessage: "Cancelled",
      result: null,
    });
  });

  it("requeues interrupted extraction on stop and resumes it on restart", async () => {
    const firstStarted = deferred<void>();
    let calls = 0;
    const service = new CaptureQueueService(
      new MemoryCaptureQueueStore(),
      {
        process: async (_job, context) => {
          calls += 1;
          if (calls === 1) {
            firstStarted.resolve();
            await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
            throw new Error("aborted");
          }
          return { status: "Saved" };
        },
      },
      { createId: idFactory() },
    );
    const job = await service.enqueue({ kind: "text", text: "Resume me" });
    await service.start();
    await firstStarted.promise;
    await service.stop();

    expect(await service.get(job.id)).toMatchObject({ status: "Queued", attempts: 1 });
    await service.start();
    await service.waitForIdle();
    expect(await service.get(job.id)).toMatchObject({ status: "Saved", attempts: 2 });
  });
});
