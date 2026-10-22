import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { advanceTimersByTimeAsync } from "../../../tests/testing.js";
import { RefreshScheduler, type RefreshRequest } from "./RefreshScheduler.js";

interface Call {
  key: string;
  request: RefreshRequest;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const LOCAL: RefreshRequest = { forcePullRequest: false };
const FORCED: RefreshRequest = { forcePullRequest: true };

describe("RefreshScheduler", () => {
  let calls: Call[];
  let warnings: string[];
  let scheduler: RefreshScheduler;

  const create = (concurrency = 4) => {
    scheduler = new RefreshScheduler(
      (key, request) =>
        new Promise<void>((resolve, reject) => {
          calls.push({ key, request, resolve, reject });
        }),
      { concurrency, warn: (message) => warnings.push(message) },
    );
  };

  const settle = () => advanceTimersByTimeAsync(0);

  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    warnings = [];
    create();
  });

  afterEach(() => {
    scheduler.dispose();
    vi.useRealTimers();
  });

  it("runs a request immediately when no debounce is given", async () => {
    void scheduler.request("a", LOCAL);
    expect(calls.map((call) => call.key)).toEqual(["a"]);
    expect(calls[0].request).toEqual(LOCAL);
  });

  it("collapses requests made during a run into exactly one follow-up", async () => {
    void scheduler.request("a", LOCAL);
    void scheduler.request("a", LOCAL);
    void scheduler.request("a", LOCAL);
    void scheduler.request("a", LOCAL);
    expect(calls).toHaveLength(1);

    calls[0].resolve();
    await settle();
    expect(calls).toHaveLength(2);

    calls[1].resolve();
    await settle();
    expect(calls).toHaveLength(2);
  });

  it("never runs the same key concurrently", async () => {
    void scheduler.request("a", LOCAL);
    void scheduler.request("a", FORCED);
    await settle();
    expect(calls).toHaveLength(1);
    calls[0].resolve();
    await settle();
    expect(calls).toHaveLength(2);
    calls[1].resolve();
    await settle();
    expect(calls).toHaveLength(2);
  });

  it("ORs flags across collapsed requests", async () => {
    void scheduler.request("a", LOCAL);
    void scheduler.request("a", FORCED);
    void scheduler.request("a", LOCAL);
    calls[0].resolve();
    await settle();
    expect(calls[0].request.forcePullRequest).toBe(false);
    expect(calls[1].request.forcePullRequest).toBe(true);
  });

  it("does not leak flags from a finished run into the next one", async () => {
    void scheduler.request("a", FORCED);
    calls[0].resolve();
    await settle();
    void scheduler.request("a", LOCAL);
    expect(calls[1].request.forcePullRequest).toBe(false);
  });

  it("runs different keys in parallel", () => {
    void scheduler.request("a", LOCAL);
    void scheduler.request("b", LOCAL);
    expect(calls.map((call) => call.key)).toEqual(["a", "b"]);
  });

  it("honors the global concurrency limit and starts queued keys as slots free", async () => {
    create(2);
    void scheduler.request("a", LOCAL);
    void scheduler.request("b", LOCAL);
    void scheduler.request("c", LOCAL);
    void scheduler.request("d", LOCAL);
    expect(calls.map((call) => call.key)).toEqual(["a", "b"]);

    calls[0].resolve();
    await settle();
    expect(calls.map((call) => call.key)).toEqual(["a", "b", "c"]);

    calls[1].resolve();
    await settle();
    expect(calls.map((call) => call.key)).toEqual(["a", "b", "c", "d"]);
  });

  it("never exceeds the concurrency limit while follow-ups are pending", async () => {
    scheduler.dispose();
    let running = 0;
    let peak = 0;
    const finishers: Array<() => void> = [];
    scheduler = new RefreshScheduler(
      () =>
        new Promise<void>((resolve) => {
          running += 1;
          peak = Math.max(peak, running);
          finishers.push(() => {
            running -= 1;
            resolve();
          });
        }),
      { concurrency: 1, warn: (message) => warnings.push(message) },
    );
    void scheduler.request("a", LOCAL);
    void scheduler.request("b", LOCAL);
    void scheduler.request("a", LOCAL);
    void scheduler.request("b", LOCAL);
    for (let i = 0; i < 3; i += 1) {
      await settle();
      finishers[i]();
    }
    await settle();
    expect(finishers).toHaveLength(3);
    expect(peak).toBe(1);
  });

  it("merges flags into a key that is queued behind the concurrency limit", async () => {
    create(1);
    void scheduler.request("a", LOCAL);
    void scheduler.request("b", LOCAL);
    void scheduler.request("b", FORCED);
    calls[0].resolve();
    await settle();
    expect(calls.map((call) => call.key)).toEqual(["a", "b"]);
    expect(calls[1].request.forcePullRequest).toBe(true);
  });

  describe("debounce", () => {
    it("delays the run until the debounce window elapses", async () => {
      void scheduler.request("a", LOCAL, 250);
      await advanceTimersByTimeAsync(249);
      expect(calls).toHaveLength(0);
      await advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(1);
    });

    it("coalesces a burst into one run and extends the window on each request", async () => {
      void scheduler.request("a", LOCAL, 250);
      await advanceTimersByTimeAsync(200);
      void scheduler.request("a", LOCAL, 250);
      await advanceTimersByTimeAsync(200);
      void scheduler.request("a", FORCED, 250);
      await advanceTimersByTimeAsync(249);
      expect(calls).toHaveLength(0);
      await advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(1);
      expect(calls[0].request.forcePullRequest).toBe(true);
    });

    it("lets an undebounced request run the pending work right away", async () => {
      void scheduler.request("a", LOCAL, 250);
      void scheduler.request("a", FORCED);
      expect(calls).toHaveLength(1);
      expect(calls[0].request.forcePullRequest).toBe(true);
      calls[0].resolve();
      await advanceTimersByTimeAsync(1000);
      expect(calls).toHaveLength(1);
    });

    it("keeps debouncing keys independently", async () => {
      void scheduler.request("a", LOCAL, 100);
      void scheduler.request("b", LOCAL, 300);
      await advanceTimersByTimeAsync(100);
      expect(calls.map((call) => call.key)).toEqual(["a"]);
      await advanceTimersByTimeAsync(200);
      expect(calls.map((call) => call.key)).toEqual(["a", "b"]);
    });

    it("waits out the debounce for a follow-up requested during a run", async () => {
      void scheduler.request("a", LOCAL);
      void scheduler.request("a", LOCAL, 250);
      calls[0].resolve();
      await advanceTimersByTimeAsync(249);
      expect(calls).toHaveLength(1);
      await advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(2);
    });

    it("runs the follow-up as soon as the run ends when the debounce already elapsed", async () => {
      void scheduler.request("a", LOCAL);
      void scheduler.request("a", LOCAL, 100);
      await advanceTimersByTimeAsync(500);
      expect(calls).toHaveLength(1);
      calls[0].resolve();
      await settle();
      expect(calls).toHaveLength(2);
    });
  });

  describe("completion promise", () => {
    it("resolves when the run covering the request finishes", async () => {
      let done = false;
      void scheduler.request("a", LOCAL).then(() => {
        done = true;
      });
      await settle();
      expect(done).toBe(false);
      calls[0].resolve();
      await settle();
      expect(done).toBe(true);
    });

    it("resolves every collapsed request only after the follow-up run, not the in-flight one", async () => {
      const done: string[] = [];
      void scheduler.request("a", LOCAL).then(() => done.push("first"));
      void scheduler.request("a", LOCAL).then(() => done.push("second"));
      void scheduler.request("a", LOCAL).then(() => done.push("third"));
      calls[0].resolve();
      await settle();
      expect(done).toEqual(["first"]);
      calls[1].resolve();
      await settle();
      expect(done).toEqual(["first", "second", "third"]);
    });

    it("resolves debounced requests after their run finishes", async () => {
      let done = false;
      void scheduler.request("a", LOCAL, 100).then(() => {
        done = true;
      });
      await advanceTimersByTimeAsync(100);
      expect(done).toBe(false);
      calls[0].resolve();
      await settle();
      expect(done).toBe(true);
    });

    it("resolves instead of rejecting when the run fails", async () => {
      const outcome = scheduler.request("a", LOCAL).then(
        () => "resolved",
        () => "rejected",
      );
      calls[0].reject(new Error("boom"));
      await expect(outcome).resolves.toBe("resolved");
    });
  });

  describe("errors", () => {
    it("warns with the key and message when a run rejects", async () => {
      void scheduler.request("a", LOCAL);
      calls[0].reject(new Error("git exploded"));
      await settle();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("a");
      expect(warnings[0]).toContain("git exploded");
    });

    it("warns for non-Error rejections", async () => {
      void scheduler.request("a", LOCAL);
      calls[0].reject("plain failure");
      await settle();
      expect(warnings[0]).toContain("plain failure");
    });

    it("keeps the key working after a failure", async () => {
      void scheduler.request("a", LOCAL);
      calls[0].reject(new Error("boom"));
      await settle();
      void scheduler.request("a", LOCAL);
      expect(calls).toHaveLength(2);
      calls[1].resolve();
      await settle();
      expect(warnings).toHaveLength(1);
    });

    it("still runs the pending follow-up and frees the slot after a failure", async () => {
      create(1);
      void scheduler.request("a", LOCAL);
      void scheduler.request("a", FORCED);
      void scheduler.request("b", LOCAL);
      calls[0].reject(new Error("boom"));
      await settle();
      calls[1].resolve();
      await settle();
      expect(calls.map((call) => call.key)).toEqual(["a", "b", "a"]);
      expect(calls[2].request.forcePullRequest).toBe(true);
    });

    it("warns when run throws synchronously", async () => {
      scheduler = new RefreshScheduler(
        () => {
          throw new Error("sync boom");
        },
        { concurrency: 1, warn: (message) => warnings.push(message) },
      );
      await expect(scheduler.request("a", LOCAL)).resolves.toBeUndefined();
      expect(warnings[0]).toContain("sync boom");
    });
  });

  describe("dispose", () => {
    it("cancels debounce timers", async () => {
      void scheduler.request("a", LOCAL, 250);
      scheduler.dispose();
      await advanceTimersByTimeAsync(1000);
      expect(calls).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("drops pending follow-up work and resolves its waiters", async () => {
      void scheduler.request("a", LOCAL);
      let done = false;
      void scheduler.request("a", LOCAL).then(() => {
        done = true;
      });
      scheduler.dispose();
      await settle();
      expect(done).toBe(true);
      calls[0].resolve();
      await settle();
      expect(calls).toHaveLength(1);
    });

    it("drops work queued behind the concurrency limit", async () => {
      create(1);
      void scheduler.request("a", LOCAL);
      void scheduler.request("b", LOCAL);
      scheduler.dispose();
      calls[0].resolve();
      await settle();
      expect(calls.map((call) => call.key)).toEqual(["a"]);
    });

    it("ignores requests after dispose and resolves them", async () => {
      scheduler.dispose();
      await expect(scheduler.request("a", LOCAL)).resolves.toBeUndefined();
      await expect(scheduler.request("a", LOCAL, 100)).resolves.toBeUndefined();
      await advanceTimersByTimeAsync(1000);
      expect(calls).toHaveLength(0);
    });
  });
});
