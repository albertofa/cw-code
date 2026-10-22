export interface RefreshRequest {
  forcePullRequest: boolean;
}

interface PendingRun {
  request: RefreshRequest;
  waiters: Array<() => void>;
}

interface KeyState {
  running: boolean;
  queued: boolean;
  ready: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  pending: PendingRun | null;
}

export class RefreshScheduler {
  private readonly keys = new Map<string, KeyState>();
  private readonly queue: string[] = [];
  private readonly concurrency: number;
  private readonly warn: (message: string) => void;
  private active = 0;
  private disposed = false;

  constructor(
    private readonly run: (key: string, request: RefreshRequest) => Promise<void>,
    opts: { concurrency: number; warn?: (message: string) => void },
  ) {
    this.concurrency = Number.isFinite(opts.concurrency) ? Math.max(1, Math.floor(opts.concurrency)) : 1;
    this.warn = opts.warn ?? ((message) => console.warn(message));
  }

  request(key: string, request: RefreshRequest, debounceMs = 0): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const state = this.stateFor(key);
    return new Promise<void>((resolve) => {
      if (state.pending) {
        state.pending.request = mergeRequests(state.pending.request, request);
        state.pending.waiters.push(resolve);
      } else {
        state.pending = { request: { ...request }, waiters: [resolve] };
      }
      if (debounceMs > 0) {
        if (!state.ready) this.armTimer(key, state, debounceMs);
        return;
      }
      this.clearTimer(state);
      state.ready = true;
      this.enqueue(key, state);
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const state of this.keys.values()) {
      this.clearTimer(state);
      state.pending?.waiters.forEach((resolve) => resolve());
      state.pending = null;
      state.ready = false;
    }
    this.queue.length = 0;
  }

  private stateFor(key: string): KeyState {
    let state = this.keys.get(key);
    if (!state) {
      state = { running: false, queued: false, ready: false, timer: null, pending: null };
      this.keys.set(key, state);
    }
    return state;
  }

  private armTimer(key: string, state: KeyState, debounceMs: number): void {
    this.clearTimer(state);
    state.timer = setTimeout(() => {
      state.timer = null;
      state.ready = true;
      this.enqueue(key, state);
    }, debounceMs);
  }

  private clearTimer(state: KeyState): void {
    if (state.timer === null) return;
    clearTimeout(state.timer);
    state.timer = null;
  }

  private enqueue(key: string, state: KeyState): void {
    if (state.ready && !state.running && !state.queued) {
      state.queued = true;
      this.queue.push(key);
    }
    this.pump();
  }

  private pump(): void {
    while (!this.disposed && this.active < this.concurrency && this.queue.length > 0) {
      const key = this.queue.shift() as string;
      const state = this.keys.get(key);
      if (!state) continue;
      state.queued = false;
      void this.start(key, state);
    }
  }

  private async start(key: string, state: KeyState): Promise<void> {
    const pending = state.pending;
    if (!pending) return;
    state.pending = null;
    state.ready = false;
    state.running = true;
    this.active += 1;
    try {
      await this.run(key, pending.request);
    } catch (error) {
      this.warn(`[refresh-scheduler] run failed for ${key}: ${describeError(error)}`);
    } finally {
      state.running = false;
      this.active -= 1;
      pending.waiters.forEach((resolve) => resolve());
      if (state.pending) this.enqueue(key, state);
      else if (state.timer === null) this.keys.delete(key);
      this.pump();
    }
  }
}

function mergeRequests(a: RefreshRequest, b: RefreshRequest): RefreshRequest {
  return { forcePullRequest: a.forcePullRequest || b.forcePullRequest };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
