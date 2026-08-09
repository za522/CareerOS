import type { CaptureProcessResult } from "./capture-queue.js";
import { CaptureBlockedError } from "./capture-queue.js";
import { PostgresCaptureRepository, type ClaimedCapture } from "./postgres-capture-repository.js";

export type PostgresCaptureProcessor = (job: ClaimedCapture, context: {
  signal: AbortSignal;
  reportProgress(progress: number, message?: string): Promise<void>;
}) => Promise<CaptureProcessResult>;

export class PostgresCaptureWorker {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pumping: Promise<void> | null = null;
  private pumpRequested = false;
  private recovering: Promise<void> | null = null;
  private lastRecoveryAt = 0;
  private lastFailure: { message: string; at: string } | null = null;
  private lastSuccessfulPumpAt: string | null = null;
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void>; leaseToken: string }>();

  constructor(
    private readonly repository: PostgresCaptureRepository,
    private readonly processor: PostgresCaptureProcessor,
    private readonly concurrency = 3,
    private readonly timing: { pollMs?: number; heartbeatMs?: number; recoveryMs?: number; onError?: (error: unknown) => void } = {},
  ) {}

  status() { return { running: this.running, active: this.active.size, lastFailure: this.lastFailure, lastSuccessfulPumpAt: this.lastSuccessfulPumpAt }; }

  private recordFailure(error: unknown) {
    this.lastFailure = { message: error instanceof Error ? error.message : "Capture worker failed.", at: new Date().toISOString() };
    this.timing.onError?.(error);
  }

  async start() {
    if (this.running) return;
    this.running = true;
    await this.repository.recoverExpired();
    this.lastRecoveryAt = Date.now();
    this.timer = setInterval(() => this.schedulePump(), this.timing.pollMs ?? 1_000);
    this.timer.unref?.();
    this.schedulePump();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.pumping) await Promise.allSettled([this.pumping]);
    const interrupted = [...this.active.entries()];
    for (const [, item] of interrupted) item.controller.abort();
    // Revoke owned leases before waiting for processors to unwind. A slow fetch or
    // extraction must not leave durable work stuck if the process receives SIGTERM.
    await Promise.allSettled(interrupted.map(([id, item]) => this.repository.releaseClaim(id, item.leaseToken)));
    await Promise.allSettled(interrupted.map(([, item]) => item.promise));
  }

  kick() { this.schedulePump(); }

  private schedulePump() {
    if (this.pumping) {
      this.pumpRequested = true;
      return;
    }
    void this.pump().catch((error) => this.recordFailure(error));
  }

  private pump() {
    if (!this.running || this.pumping) return this.pumping ?? Promise.resolve();
    const run = this.fillSlots().then(() => { this.lastSuccessfulPumpAt = new Date().toISOString(); }).finally(() => {
      if (this.pumping === run) this.pumping = null;
      const shouldPumpAgain = this.pumpRequested;
      this.pumpRequested = false;
      if (shouldPumpAgain && this.running) this.schedulePump();
    });
    this.pumping = run;
    return run;
  }

  private async fillSlots() {
    if (Date.now() - this.lastRecoveryAt >= (this.timing.recoveryMs ?? 30_000) && !this.recovering) {
      const recovery = this.repository.recoverExpired().then(() => { this.lastRecoveryAt = Date.now(); });
      const tracked = recovery.finally(() => { if (this.recovering === tracked) this.recovering = null; });
      this.recovering = tracked;
      await tracked;
    }
    while (this.running && this.active.size < Math.max(1, Math.min(this.concurrency, 8))) {
      const claimed = await this.repository.claimNext();
      if (!claimed) break;
      if (!this.running) {
        await this.repository.releaseClaim(claimed.id, claimed.leaseToken);
        break;
      }
      const controller = new AbortController();
      const promise = this.process(claimed, controller).finally(() => {
        this.active.delete(claimed.id);
        if (this.running) this.schedulePump();
      });
      this.active.set(claimed.id, { controller, promise, leaseToken: claimed.leaseToken });
    }
  }

  private async process(job: ClaimedCapture, controller: AbortController) {
    let leaseLost = false;
    let currentProgress = job.progress;
    const assertLease = async (progress: number, message: string | null) => {
      const owned = await this.repository.heartbeat(job.id, job.leaseToken, progress, message);
      if (!owned) {
        leaseLost = true;
        controller.abort(new Error("Capture lease ownership was lost."));
        throw new Error("Capture lease ownership was lost.");
      }
      currentProgress = progress;
    };
    const keepAlive = setInterval(() => {
      void assertLease(Math.max(0, currentProgress), "Extraction in progress").catch(() => {
        leaseLost = true;
        controller.abort(new Error("Capture lease heartbeat failed."));
      });
    }, this.timing.heartbeatMs ?? 30_000);
    keepAlive.unref?.();
    try {
      const result = await this.processor(job, {
        signal: controller.signal,
        reportProgress: async (progress, message) => {
          if (!Number.isFinite(progress) || progress < 0 || progress > 1) throw new Error("Capture progress must be between 0 and 1.");
          await assertLease(progress, message ?? null);
        },
      });
      if (controller.signal.aborted) return;
      const finished = await this.repository.finish(job.id, job.leaseToken, result.status, result.result ?? null, result.status === "Blocked" ? result.message ?? "Capture was blocked." : null);
      if (!finished) {
        leaseLost = true;
        controller.abort(new Error("Capture lease ownership was lost before completion."));
      }
    } catch (error) {
      if (controller.signal.aborted || leaseLost) return;
      const blocked = error instanceof CaptureBlockedError;
      await this.repository.finish(job.id, job.leaseToken, blocked ? "Blocked" : "Failed", null, error instanceof Error ? error.message : "Capture failed.").catch((finishError) => this.recordFailure(finishError));
    } finally {
      clearInterval(keepAlive);
    }
  }
}
