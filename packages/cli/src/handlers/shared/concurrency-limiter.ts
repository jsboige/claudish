/**
 * ConcurrencyLimiter — per-instance async semaphore for remote provider transports.
 *
 * WHY THIS EXISTS (not LocalModelQueue):
 * LocalModelQueue is a process-wide singleton with a SINGLE shared maxParallel that
 * a concurrency override MUTATES (local-queue.ts). Capping a second provider through
 * it would tangle the two: vllm-myia's override:1 would also clamp gc@glm-5.2 to 1
 * (collapsing the primary model's throughput). It is built for local single-GPU
 * backends (ollama/lmstudio/vllm-local).
 *
 * This limiter is owned by ONE transport instance. Because the handler (and thus its
 * transport) is cached as a singleton per provider+model (proxy-server.ts
 * remoteProviderHandlers), one limiter instance gates ALL requests to that provider —
 * independent of every other provider's cap.
 *
 * Semantics:
 *  - max > 0: at most `max` tasks run concurrently; extras QUEUE (FIFO) and resume
 *    as slots free. Never rejects — preserves the never-hang priority.
 *  - The caller decides whether to construct a limiter at all (max=0/undefined → no
 *    limiter, unbounded, unchanged default behavior).
 *  - #431: `run(task, waitBudgetMs)` bounds the QUEUE wait, not the task. A budget
 *    that expires before a slot frees rejects with StepBusyError — for a cascade
 *    step attempt only; without a budget (the default, and every pre-#431 caller)
 *    the FIFO wait stays unbounded, exactly as before.
 */
export class StepBusyError extends Error {
  constructor(
    readonly label: string,
    readonly waitedMs: number
  ) {
    super(`ConcurrencyLimiter("${label}"): no slot freed within the ${waitedMs}ms bounded wait`);
    this.name = "StepBusyError";
  }
}

export class ConcurrencyLimiter {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(
    private readonly max: number,
    private readonly label: string
  ) {
    if (max <= 0) throw new Error(`ConcurrencyLimiter("${label}"): max must be > 0, got ${max}`);
  }

  /**
   * Run `task` under the cap. If at capacity, waits for a slot (FIFO order) before
   * starting. Resolves/rejects with whatever `task` produces.
   *
   * `waitBudgetMs` (#431, optional): bound on the QUEUE wait. When it expires
   * before a slot frees, rejects with StepBusyError and — critically — removes
   * our own resolver from `waiting`: a freed slot that wakes an abandoned
   * promise decrements `active` for a waiter that will never increment it,
   * permanently leaking the slot it meant to hand over.
   */
  async run<T>(task: () => Promise<T>, waitBudgetMs?: number): Promise<T> {
    if (this.active >= this.max) {
      let slot!: () => void;
      const queued = new Promise<void>((resolve) => {
        slot = resolve;
        this.waiting.push(resolve);
      });
      if (waitBudgetMs !== undefined && waitBudgetMs > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const raced = await Promise.race([
          queued.then(() => "slot" as const),
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), waitBudgetMs);
          }),
        ]).finally(() => {
          if (timer !== undefined) clearTimeout(timer);
        });
        if (raced === "timeout") {
          const i = this.waiting.indexOf(slot);
          if (i >= 0) this.waiting.splice(i, 1);
          throw new StepBusyError(this.label, waitBudgetMs);
        }
      } else {
        await queued;
      }
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      const next = this.waiting.shift();
      if (next) next();
    }
  }

  /** For tests/diagnostics: current in-flight count. */
  get activeCount(): number {
    return this.active;
  }

  /** For tests/diagnostics: current queued count. */
  get queuedCount(): number {
    return this.waiting.length;
  }
}
