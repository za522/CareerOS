import { describe, expect, it, vi } from "vitest";
import type { CaptureQueueJob } from "./capture-queue.js";
import { PostgresCaptureWorker, type PostgresCaptureProcessor } from "./postgres-capture-worker.js";
import type { ClaimedCapture, PostgresCaptureRepository } from "./postgres-capture-repository.js";

const waitFor = async (assertion: () => void, timeout = 500) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { assertion(); return; } catch { await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  assertion();
};

function claim(id = "capture-1"): ClaimedCapture {
  const base: CaptureQueueJob = { id,input:{kind:"text",text:"Role: Engineer"},status:"Extracting",attempts:1,progress:0,progressMessage:null,result:null,error:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),startedAt:new Date().toISOString(),finishedAt:null };
  return {...base,workspaceId:"workspace-1",userId:"user-1",authSubject:"subject-1",leaseToken:"11111111-1111-4111-8111-111111111111"};
}

function repository(overrides: Record<string, unknown> = {}) {
  return {
    recoverExpired: vi.fn().mockResolvedValue(0),
    claimNext: vi.fn().mockResolvedValue(null),
    heartbeat: vi.fn().mockResolvedValue({ id:"capture-1" }),
    finish: vi.fn().mockResolvedValue({ id:"capture-1" }),
    releaseClaim: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as PostgresCaptureRepository;
}

describe("PostgreSQL capture worker reliability", () => {
  it("contains transient claim failures and processes work on a later pump", async () => {
    const job=claim();
    const repo=repository({claimNext:vi.fn().mockRejectedValueOnce(new Error("temporary database outage")).mockResolvedValueOnce(job).mockResolvedValue(null)});
    const processor=vi.fn().mockResolvedValue({status:"Needs Review",result:{ok:true}});
    const worker=new PostgresCaptureWorker(repo,processor,1,{pollMs:5,recoveryMs:1000,heartbeatMs:1000});
    await expect(worker.start()).resolves.toBeUndefined();
    await waitFor(()=>expect(processor).toHaveBeenCalledTimes(1));
    await worker.stop();
    expect(repo.finish).toHaveBeenCalledWith(job.id,job.leaseToken,"Needs Review",{ok:true},null);
    expect(worker.status().lastFailure?.message).toBe("temporary database outage");
    expect(worker.status().lastSuccessfulPumpAt).not.toBeNull();
    expect(worker.status().lastSuccessfulPumpAt! >= worker.status().lastFailure!.at).toBe(true);
  });

  it("aborts processing and never finalises after heartbeat ownership is lost", async () => {
    const job=claim();
    const repo=repository({claimNext:vi.fn().mockResolvedValueOnce(job).mockResolvedValue(null),heartbeat:vi.fn().mockResolvedValue(null)});
    const processor=vi.fn(async (_job,context)=>{await context.reportProgress(0.2,"Reading");return{status:"Needs Review" as const,result:{}};});
    const worker=new PostgresCaptureWorker(repo,processor,1,{pollMs:5,recoveryMs:1000,heartbeatMs:5});
    await worker.start();
    await waitFor(()=>expect(repo.heartbeat).toHaveBeenCalled());
    await worker.stop();
    expect(repo.finish).not.toHaveBeenCalled();
  });

  it("recovers expired leases periodically rather than only at startup", async () => {
    const repo=repository();
    const worker=new PostgresCaptureWorker(repo,vi.fn(),1,{pollMs:5,recoveryMs:10,heartbeatMs:1000});
    await worker.start();
    await waitFor(()=>expect(repo.recoverExpired).toHaveBeenCalledTimes(2));
    await worker.stop();
  });

  it("does not lose the next pump when fast work completes during slot filling", async () => {
    const jobs = Array.from({ length: 8 }, (_, index) => claim(`capture-${index + 1}`));
    const claimNext = vi.fn(async () => jobs.shift() ?? null);
    const processor = vi.fn().mockResolvedValue({ status: "Needs Review", result: { ok: true } });
    const repo = repository({ claimNext });
    const worker = new PostgresCaptureWorker(repo, processor, 1, { pollMs: 60_000, recoveryMs: 60_000, heartbeatMs: 60_000 });

    await worker.start();
    await waitFor(() => expect(processor).toHaveBeenCalledTimes(8));
    await worker.stop();

    expect(repo.finish).toHaveBeenCalledTimes(8);
  });

  it("releases its active lease immediately during graceful shutdown", async () => {
    const job = claim("interrupted-capture");
    const repo = repository({ claimNext: vi.fn().mockResolvedValueOnce(job).mockResolvedValue(null) });
    const processor: PostgresCaptureProcessor = vi.fn(async (_job, context) => new Promise<{ status: "Needs Review"; result: Record<string, unknown> }>((resolve) => {
      context.signal.addEventListener("abort", () => resolve({ status: "Needs Review" as const, result: {} }), { once: true });
    }));
    const worker = new PostgresCaptureWorker(repo, processor, 1, { pollMs: 60_000, heartbeatMs: 60_000, recoveryMs: 60_000 });

    await worker.start();
    await waitFor(() => expect(processor).toHaveBeenCalledTimes(1));
    await worker.stop();

    expect(repo.releaseClaim).toHaveBeenCalledWith(job.id, job.leaseToken);
    expect(repo.finish).not.toHaveBeenCalled();
  });

  it("releases the lease before waiting for an aborted processor to unwind", async () => {
    const job = claim("slow-interrupted-capture");
    let finishUnwinding!: () => void;
    const unwinding = new Promise<void>((resolve) => { finishUnwinding = resolve; });
    let released = false;
    const repo = repository({
      claimNext: vi.fn().mockResolvedValueOnce(job).mockResolvedValue(null),
      releaseClaim: vi.fn(async () => { released = true; return true; }),
    });
    const processor: PostgresCaptureProcessor = vi.fn(async (_job, context) => {
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", resolve, { once: true }));
      await unwinding;
      return { status: "Needs Review" as const, result: {} };
    });
    const worker = new PostgresCaptureWorker(repo, processor, 1, { pollMs: 60_000, heartbeatMs: 60_000, recoveryMs: 60_000 });

    await worker.start();
    await waitFor(() => expect(processor).toHaveBeenCalledTimes(1));
    const stopping = worker.stop();
    await waitFor(() => expect(released).toBe(true));
    finishUnwinding();
    await stopping;

    expect(repo.releaseClaim).toHaveBeenCalledWith(job.id, job.leaseToken);
    expect(repo.finish).not.toHaveBeenCalled();
  });

  it("releases a database claim that completes while shutdown is in progress", async () => {
    const job = claim("claim-during-stop");
    let resolveClaim!: (value: ClaimedCapture) => void;
    const pendingClaim = new Promise<ClaimedCapture>((resolve) => { resolveClaim = resolve; });
    const repo = repository({ claimNext: vi.fn().mockReturnValueOnce(pendingClaim).mockResolvedValue(null) });
    const processor: PostgresCaptureProcessor = vi.fn();
    const worker = new PostgresCaptureWorker(repo, processor, 1, { pollMs: 60_000, heartbeatMs: 60_000, recoveryMs: 60_000 });

    await worker.start();
    await waitFor(() => expect(repo.claimNext).toHaveBeenCalledTimes(1));
    const stopping = worker.stop();
    resolveClaim(job);
    await stopping;

    expect(repo.releaseClaim).toHaveBeenCalledWith(job.id, job.leaseToken);
    expect(processor).not.toHaveBeenCalled();
  });
});
