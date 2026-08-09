import { randomUUID } from "node:crypto";

export const captureQueueStatuses = [
  "Queued",
  "Extracting",
  "Needs Review",
  "Duplicate",
  "Blocked",
  "Failed",
  "Saved",
] as const;

export type CaptureQueueStatus = (typeof captureQueueStatuses)[number];

export type CaptureInput =
  | { kind: "text"; text: string; applyUrl?: string }
  | { kind: "url"; url: string; applyUrl?: string };

export type CaptureProcessResult =
  | { status: "Needs Review"; result?: Record<string, unknown> }
  | { status: "Duplicate"; result?: Record<string, unknown> }
  | { status: "Blocked"; result?: Record<string, unknown>; message?: string }
  | { status: "Saved"; result?: Record<string, unknown> };

export type CaptureQueueJob = {
  id: string;
  input: CaptureInput;
  status: CaptureQueueStatus;
  attempts: number;
  progress: number;
  progressMessage: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type CaptureQueueJobUpdate = Partial<
  Pick<
    CaptureQueueJob,
    | "status"
    | "attempts"
    | "progress"
    | "progressMessage"
    | "result"
    | "error"
    | "updatedAt"
    | "startedAt"
    | "finishedAt"
  >
>;

/** Implementations must apply update atomically only when the current status matches. */
export interface CaptureQueueStore {
  create(job: CaptureQueueJob): Promise<void>;
  createMany(jobs: CaptureQueueJob[], capacity?: number, onPersist?: () => void): Promise<void>;
  get(id: string): Promise<CaptureQueueJob | null>;
  list(): Promise<CaptureQueueJob[]>;
  countPending(): Promise<number>;
  summary(): Promise<CaptureQueueSummary>;
  claimNext(updatedAt: string, startedAt: string): Promise<CaptureQueueJob | null>;
  update(
    id: string,
    expectedStatuses: readonly CaptureQueueStatus[],
    update: CaptureQueueJobUpdate,
  ): Promise<CaptureQueueJob | null>;
  requeueStale(cutoffTimestamp: string, updatedAt: string): Promise<number>;
}

export type CaptureProcessorContext = {
  signal: AbortSignal;
  reportProgress(progress: number, message?: string): Promise<void>;
};

export interface CaptureQueueProcessor {
  process(job: CaptureQueueJob, context: CaptureProcessorContext): Promise<CaptureProcessResult>;
}

export type CaptureQueueSummary = {
  total: number;
  pending: number;
  completed: number;
  overallProgress: number;
  counts: Record<CaptureQueueStatus, number>;
};

export type CaptureQueueOptions = {
  concurrency?: number;
  capacity?: number;
  createId?: () => string;
  now?: () => Date;
  staleAfterMs?: number;
  heartbeatMs?: number;
  acquireMutation?: () => Promise<() => void>;
};

export class CaptureQueueCapacityError extends Error {
  constructor(capacity: number) {
    super(`Capture queue capacity of ${capacity} pending jobs has been reached.`);
    this.name = "CaptureQueueCapacityError";
  }
}

export class CaptureBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureBlockedError";
  }
}

const pendingStatuses: readonly CaptureQueueStatus[] = ["Queued", "Extracting"];
const retryableStatuses: readonly CaptureQueueStatus[] = ["Failed", "Blocked"];

export class CaptureQueueService {
  private readonly concurrency: number;
  private readonly capacity: number;
  private readonly createId: () => string;
  private readonly now: () => Date;
  private readonly workers = new Set<Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly idleWaiters = new Set<() => void>();
  private running = false;
  private pumpPromise: Promise<void> | null = null;
  private pumpRequested = false;
  private enqueueLock: Promise<void> = Promise.resolve();
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly staleAfterMs: number;
  private readonly heartbeatMs: number;
  private readonly acquireMutation: () => Promise<() => void>;

  constructor(
    private readonly store: CaptureQueueStore,
    private readonly processor: CaptureQueueProcessor,
    options: CaptureQueueOptions = {},
  ) {
    this.concurrency = positiveInteger(options.concurrency ?? 4, "concurrency");
    this.capacity = positiveInteger(options.capacity ?? 100, "capacity");
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.staleAfterMs = positiveInteger(options.staleAfterMs ?? 120_000, "staleAfterMs");
    this.heartbeatMs = positiveInteger(options.heartbeatMs ?? 15_000, "heartbeatMs");
    this.acquireMutation = options.acquireMutation ?? (async () => () => {});
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // A newly started process cannot have a live worker from the previous process.
    // Reclaim every interrupted extraction immediately instead of waiting for its old lease.
    await this.withMutation(() => this.store.requeueStale(new Date(this.now().getTime() + 1).toISOString(), this.timestamp()));
    this.recoveryTimer = setInterval(() => {
      void this.withMutation(() => this.recoverStale()).then(() => this.schedulePump()).catch(() => undefined);
    }, Math.max(this.heartbeatMs, 5_000));
    this.recoveryTimer.unref?.();

    await this.pump();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.workers]);
    await this.pumpPromise;
    await this.notifyIfIdle();
  }

  async enqueue(input: CaptureInput): Promise<CaptureQueueJob> {
    return (await this.enqueueBatch([input]))[0]!;
  }

  async enqueueBatch(inputs: CaptureInput[], onPersist?: () => void): Promise<CaptureQueueJob[]> {
    if (inputs.length === 0) throw new Error("Capture batch cannot be empty.");
    const normalisedInputs = inputs.map(normaliseInput);
    return this.withEnqueueLock(async () => {
      const pending = await this.store.countPending();
      if (pending + normalisedInputs.length > this.capacity) throw new CaptureQueueCapacityError(this.capacity);

      const baseTimestamp = this.now().getTime();
      const created = normalisedInputs.map((input, index): CaptureQueueJob => {
        const timestamp = new Date(baseTimestamp + index).toISOString();
        return {
          id: this.createId(),
          input,
          status: "Queued",
          attempts: 0,
          progress: 0,
          progressMessage: null,
          result: null,
          error: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          startedAt: null,
          finishedAt: null,
        };
      });
      await this.store.createMany(created, this.capacity, onPersist);
      this.schedulePump();
      return created;
    });
  }

  async retry(id: string): Promise<CaptureQueueJob> {
    return this.withEnqueueLock(async () => {
      const job = await this.requireJob(id);
      if (!retryableStatuses.includes(job.status)) {
        throw new Error(`Job ${id} cannot be retried from ${job.status}.`);
      }
      const pending = await this.store.countPending();
      if (pending >= this.capacity) throw new CaptureQueueCapacityError(this.capacity);

      const retried = await this.store.update(id, retryableStatuses, {
        status: "Queued",
        progress: 0,
        progressMessage: null,
        result: null,
        error: null,
        updatedAt: this.timestamp(),
        startedAt: null,
        finishedAt: null,
      });
      if (!retried) throw new Error(`Job ${id} changed before it could be retried.`);
      this.schedulePump();
      return retried;
    });
  }

  async cancel(id: string): Promise<CaptureQueueJob> {
    const job = await this.requireJob(id);
    if (!pendingStatuses.includes(job.status)) return job;

    this.controllers.get(id)?.abort();
    const cancelled = await this.store.update(id, pendingStatuses, {
      status: "Blocked",
      progressMessage: "Cancelled",
      error: "Capture was cancelled.",
      updatedAt: this.timestamp(),
      finishedAt: this.timestamp(),
    });
    return cancelled ?? this.requireJob(id);
  }

  get(id: string): Promise<CaptureQueueJob | null> {
    return this.store.get(id);
  }

  list(): Promise<CaptureQueueJob[]> {
    return this.store.list();
  }

  async summary(): Promise<CaptureQueueSummary> {
    return this.store.summary();
  }

  async waitForIdle(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onIdle = () => resolve();
      this.idleWaiters.add(onIdle);
      void this.isIdle().then((idle) => {
        if (idle && this.idleWaiters.delete(onIdle)) resolve();
      }, (error: unknown) => {
        this.idleWaiters.delete(onIdle);
        reject(error);
      });
    });
  }

  private schedulePump(): void {
    if (!this.running) return;
    if (this.pumpPromise) {
      this.pumpRequested = true;
      return;
    }
    void this.pump();
  }

  private pump(): Promise<void> {
    if (this.pumpPromise) return this.pumpPromise;
    const pumping = this.pumpJobs();
    this.pumpPromise = pumping;
    const settlePump = () => {
      if (this.pumpPromise === pumping) this.pumpPromise = null;
      const shouldPumpAgain = this.pumpRequested;
      this.pumpRequested = false;
      if (shouldPumpAgain) this.schedulePump();
      void this.notifyIfIdle();
    };
    void pumping.then(settlePump, settlePump);
    return pumping;
  }

  private async pumpJobs(): Promise<void> {
    while (this.running && this.workers.size < this.concurrency) {
      let release: () => void;
      try {
        release = await this.acquireMutation();
      } catch {
        break;
      }
      const claimed = await this.claimNext().catch((error) => {
        release();
        throw error;
      });
      if (!claimed) {
        release();
        break;
      }

      const worker = this.process(claimed).finally(release);
      this.workers.add(worker);
      const settleWorker = () => {
        this.workers.delete(worker);
        this.schedulePump();
        void this.notifyIfIdle();
      };
      void worker.then(settleWorker, settleWorker);
    }
    await this.notifyIfIdle();
  }

  private async claimNext(): Promise<CaptureQueueJob | null> {
    const timestamp = this.timestamp();
    return this.store.claimNext(timestamp, timestamp);
  }

  private async process(job: CaptureQueueJob): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const heartbeat = setInterval(() => {
      if (!controller.signal.aborted) void this.store.update(job.id, ["Extracting"], { updatedAt: this.timestamp() });
    }, this.heartbeatMs);
    heartbeat.unref?.();
    try {
      const outcome = await this.processor.process(job, {
        signal: controller.signal,
        reportProgress: async (progress, message) => {
          if (controller.signal.aborted) return;
          await this.store.update(job.id, ["Extracting"], {
            progress: roundProgress(progress),
            progressMessage: message ?? null,
            updatedAt: this.timestamp(),
          });
        },
      });

      if (controller.signal.aborted) {
        await this.requeueInterrupted(job.id);
        return;
      }
      await this.store.update(job.id, ["Extracting"], {
        status: outcome.status,
        progress: 1,
        progressMessage: null,
        result: outcome.result ?? null,
        error: outcome.status === "Blocked" ? outcome.message ?? "Capture was blocked." : null,
        updatedAt: this.timestamp(),
        finishedAt: this.timestamp(),
      });
    } catch (error) {
      if (controller.signal.aborted) {
        await this.requeueInterrupted(job.id);
      } else if (error instanceof CaptureBlockedError) {
        await this.store.update(job.id, ["Extracting"], {
          status: "Blocked",
          progressMessage: null,
          error: error.message,
          updatedAt: this.timestamp(),
          finishedAt: this.timestamp(),
        });
      } else {
        await this.store.update(job.id, ["Extracting"], {
          status: "Failed",
          progressMessage: null,
          error: errorMessage(error),
          updatedAt: this.timestamp(),
          finishedAt: this.timestamp(),
        });
      }
    } finally {
      clearInterval(heartbeat);
      this.controllers.delete(job.id);
    }
  }

  private async requeueInterrupted(id: string): Promise<void> {
    await this.store.update(id, ["Extracting"], {
      status: "Queued",
      progress: 0,
      progressMessage: "Interrupted; ready to resume",
      updatedAt: this.timestamp(),
      startedAt: null,
    });
  }

  private async requireJob(id: string): Promise<CaptureQueueJob> {
    const job = await this.store.get(id);
    if (!job) throw new Error(`Capture queue job ${id} was not found.`);
    return job;
  }

  private async isIdle(): Promise<boolean> {
    if (this.workers.size > 0 || this.pumpPromise) return false;
    return (await this.store.countPending()) === 0;
  }

  private async notifyIfIdle(): Promise<void> {
    if (this.idleWaiters.size === 0 || !(await this.isIdle())) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private async recoverStale(): Promise<void> {
    const cutoff = new Date(this.now().getTime() - this.staleAfterMs).toISOString();
    await this.store.requeueStale(cutoff, this.timestamp());
  }

  private async withEnqueueLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.enqueueLock;
    let release = () => {};
    this.enqueueLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireMutation();
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function normaliseInput(input: CaptureInput): CaptureInput {
  const applyUrl = normaliseOptionalUrl(input.applyUrl, "Apply URL");
  if (input.kind === "text") {
    const text = input.text.trim();
    if (!text) throw new Error("Pasted text cannot be empty.");
    return { kind: "text", text, ...(applyUrl ? { applyUrl } : {}) };
  }

  let parsed: URL;
  try {
    parsed = new URL(input.url.trim());
  } catch {
    throw new Error("Capture URL must be a valid HTTP(S) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Capture URL must use HTTP or HTTPS.");
  }
  return { kind: "url", url: parsed.toString(), ...(applyUrl ? { applyUrl } : {}) };
}

function normaliseOptionalUrl(value: string | undefined, label: string): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    return parsed.toString();
  } catch {
    throw new Error(`${label} must be a valid HTTP(S) URL.`);
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function roundProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
