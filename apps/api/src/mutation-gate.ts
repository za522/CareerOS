export class MutationGateBlockedError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 503) {
    super(message);
    this.name = "MutationGateBlockedError";
    this.statusCode = statusCode;
  }
}

type Release = () => void;

export class ProcessMutationGate {
  #active = 0;
  #exclusive = false;
  #sealed = false;
  #stateWaiters = new Set<() => void>();
  #exclusiveQueue: Promise<void> = Promise.resolve();

  constructor(initiallySealed = false) {
    this.#sealed = initiallySealed;
  }

  get sealed() { return this.#sealed; }
  get activeCount() { return this.#active; }

  async acquire(options: { waitForExclusive?: boolean } = {}): Promise<Release> {
    while (this.#exclusive) {
      if (!options.waitForExclusive) {
        throw new MutationGateBlockedError("CareerOS is creating or restoring a protected snapshot. Try again in a moment.");
      }
      await this.#waitForStateChange();
    }
    if (this.#sealed) {
      throw new MutationGateBlockedError("A verified restore is waiting for restart. CareerOS is read-only so newer work cannot be lost.");
    }
    this.#active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active = Math.max(0, this.#active - 1);
      this.#notifyStateChange();
    };
  }

  async run<T>(work: () => Promise<T> | T, options: { waitForExclusive?: boolean } = {}): Promise<T> {
    const release = await this.acquire(options);
    try {
      return await work();
    } finally {
      release();
    }
  }

  async exclusive<T>(work: () => Promise<T> | T, options: { sealOnSuccess?: boolean } = {}): Promise<T> {
    const previous = this.#exclusiveQueue;
    let releaseQueue = () => {};
    this.#exclusiveQueue = new Promise<void>((resolve) => { releaseQueue = resolve; });
    await previous;
    try {
      if (this.#sealed) {
        throw new MutationGateBlockedError("A verified restore is already waiting for restart.", 409);
      }
      this.#exclusive = true;
      this.#notifyStateChange();
      while (this.#active > 0) await this.#waitForStateChange();
      const result = await work();
      if (options.sealOnSuccess) this.#sealed = true;
      return result;
    } finally {
      this.#exclusive = false;
      this.#notifyStateChange();
      releaseQueue();
    }
  }

  #waitForStateChange() {
    return new Promise<void>((resolve) => this.#stateWaiters.add(resolve));
  }

  #notifyStateChange() {
    const waiters = [...this.#stateWaiters];
    this.#stateWaiters.clear();
    for (const resolve of waiters) resolve();
  }
}
