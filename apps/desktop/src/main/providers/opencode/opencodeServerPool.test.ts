import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { OpencodeServerPool, type ServerHandle } from "./opencodeServerPool.js";

const ROOT = "C:\\fake\\project";
const HANDLE: ServerHandle = { port: 40001, authHeader: "x" };

type StartServerFn = NonNullable<NonNullable<ConstructorParameters<typeof OpencodeServerPool>[1]>["startServer"]>;

function fakeProc(): ChildProcess {
  return { pid: undefined } as unknown as ChildProcess;
}

function makePool(startServer: StartServerFn): OpencodeServerPool {
  return new OpencodeServerPool(() => "opencode", { startServer });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("OpencodeServerPool ensure", () => {
  it("dedupes concurrent ensure calls for the same rootPath", async () => {
    let calls = 0;
    const startServer = vi.fn(() => {
      calls += 1;
      return new Promise<{ proc: ChildProcess; handle: ServerHandle }>((resolve) => {
        setTimeout(() => resolve({ proc: fakeProc(), handle: HANDLE }), 20);
      });
    });
    const pool = makePool(startServer);

    const [a, b] = await Promise.all([pool.ensure(ROOT), pool.ensure(ROOT)]);

    expect(calls).toBe(1);
    expect(startServer).toHaveBeenCalledTimes(1);
    expect(a).toBe(HANDLE);
    expect(b).toBe(HANDLE);
    expect(a.port).toBe(b.port);
    pool.dispose();
  });

  it("clears the pending entry on failure so a retry re-spawns", async () => {
    let calls = 0;
    const startServer = vi.fn((): Promise<{ proc: ChildProcess; handle: ServerHandle }> => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("spawn failed"));
      return Promise.resolve({ proc: fakeProc(), handle: HANDLE });
    });
    const pool = makePool(startServer);

    await expect(pool.ensure(ROOT)).rejects.toThrow("spawn failed");
    const handle = await pool.ensure(ROOT);

    expect(handle).toBe(HANDLE);
    expect(calls).toBe(2);
    expect(startServer).toHaveBeenCalledTimes(2);
    pool.dispose();
  });

  it("reuses the servers-map cache after a successful ensure", async () => {
    const startServer = vi.fn(
      (): Promise<{ proc: ChildProcess; handle: ServerHandle }> => Promise.resolve({ proc: fakeProc(), handle: HANDLE })
    );
    const pool = makePool(startServer);

    const first = await pool.ensure(ROOT);
    const second = await pool.ensure(ROOT);

    expect(second).toBe(first);
    expect(second.port).toBe(first.port);
    expect(startServer).toHaveBeenCalledTimes(1);
    pool.dispose();
  });
});
