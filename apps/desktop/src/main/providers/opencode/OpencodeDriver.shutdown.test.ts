import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@cw-code/contracts";
import { OpencodeDriver } from "./OpencodeDriver.js";
import type { OpencodeServerPool } from "./opencodeServerPool.js";

function stubFetch(abortDelayMs: number, calls: string[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/event")) return Promise.resolve({ ok: false, status: 500, body: null });
      if (init?.method === "POST") {
        calls.push(url);
        if (!url.includes("/abort")) return new Promise(() => {});
        return new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200 }), abortDelayMs));
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => (url.includes("/message") ? [] : {})
      });
    })
  );
}

function makeDriver() {
  const pool = {
    disposed: 0,
    ensure: async () => ({ port: 41234, authHeader: "auth" }),
    beginTurn: () => {},
    endTurn: () => {},
    invalidate: () => {},
    ownedProcessCount: () => 1,
    dispose() {
      this.disposed += 1;
    }
  };
  const driver = new OpencodeDriver(
    () => {},
    () => ({ opencodeBinaryPath: "opencode" }) as AppSettings,
    pool as unknown as OpencodeServerPool
  );
  return { driver, pool };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpencodeDriver shutdown", () => {
  it("disposes its server pool right away when no turn is running", async () => {
    const { driver, pool } = makeDriver();
    expect(driver.activity()).toEqual({ busySessionIds: [], ownedProcesses: 1, backgroundTurns: 0 });
    expect(await driver.shutdown({ timeoutMs: 100 })).toEqual({ timedOut: false });
    expect(pool.disposed).toBe(1);
  });

  it("aborts running turns on the server and waits for the abort before stopping the server", async () => {
    const calls: string[] = [];
    stubFetch(30, calls);
    const { driver, pool } = makeDriver();
    driver.startTurn({ sessionId: "sess_1", cwd: "C:\\proj", prompt: "hello", resumeCursor: "native-1" });
    driver.startTurn({ sessionId: "title:sess_1", cwd: "C:\\titles", prompt: "title", resumeCursor: "native-2" });
    await new Promise((r) => setTimeout(r, 200));
    expect(driver.activity()).toEqual({ busySessionIds: ["sess_1"], ownedProcesses: 1, backgroundTurns: 1 });
    expect(await driver.shutdown({ timeoutMs: 1000 })).toEqual({ timedOut: false });
    expect(calls.filter((url) => url.includes("/abort"))).toHaveLength(2);
    expect(pool.disposed).toBe(1);
    expect(driver.activity().busySessionIds).toEqual([]);
  });

  it("reports a timeout and leaves the server for a forced dispose when aborts do not settle in time", async () => {
    const calls: string[] = [];
    stubFetch(400, calls);
    const { driver, pool } = makeDriver();
    driver.startTurn({ sessionId: "sess_1", cwd: "C:\\proj", prompt: "hello", resumeCursor: "native-1" });
    await new Promise((r) => setTimeout(r, 200));
    expect(await driver.shutdown({ timeoutMs: 20 })).toEqual({ timedOut: true });
    expect(pool.disposed).toBe(0);
    driver.dispose();
    expect(pool.disposed).toBe(1);
  });
});
