import { describe, expect, it } from "vitest";
import { MutationGateBlockedError, ProcessMutationGate } from "./mutation-gate.js";

describe("process-wide mutation gate", () => {
  it("can start sealed when startup restore finalization must remain read-only", async () => {
    const gate = new ProcessMutationGate(true);
    expect(gate.sealed).toBe(true);
    await expect(gate.acquire()).rejects.toThrow(/read-only/);
  });

  it("drains active background work before restore seals every later writer", async () => {
    const gate = new ProcessMutationGate();
    let finishBackground = () => {};
    const backgroundCanFinish = new Promise<void>((resolve) => { finishBackground = resolve; });
    let backgroundStarted = () => {};
    const backgroundDidStart = new Promise<void>((resolve) => { backgroundStarted = resolve; });

    const background = gate.run(async () => {
      backgroundStarted();
      await backgroundCanFinish;
    }, { waitForExclusive: true });
    await backgroundDidStart;

    let restored = false;
    const restore = gate.exclusive(async () => { restored = true; }, { sealOnSuccess: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(restored).toBe(false);

    finishBackground();
    await Promise.all([background, restore]);
    expect(gate.sealed).toBe(true);
    await expect(gate.run(async () => undefined, { waitForExclusive: true })).rejects.toBeInstanceOf(MutationGateBlockedError);
  });
});
