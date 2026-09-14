import { describe, expect, it, vi } from "vitest";
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

  it("reuses an existing env-spawned server when a later ensure specifies no env", async () => {
    const startServer = vi.fn(
      (): Promise<{ proc: ChildProcess; handle: ServerHandle }> => Promise.resolve({ proc: fakeProc(), handle: HANDLE })
    );
    const pool = makePool(startServer);

    await pool.ensure(ROOT, { CW_TEST: "1" });
    const second = await pool.ensure(ROOT);

    expect(second).toBe(HANDLE);
    expect(startServer).toHaveBeenCalledTimes(1);
    pool.dispose();
  });

  it("spawns a fresh server when a concurrent caller requests a different env", async () => {
    let calls = 0;
    const handles: ServerHandle[] = [
      { port: 40001, authHeader: "a" },
      { port: 40002, authHeader: "b" }
    ];
    const startServer = vi.fn(() => {
      calls += 1;
      const handle = handles[calls - 1];
      return new Promise<{ proc: ChildProcess; handle: ServerHandle }>((resolve) => {
        setTimeout(() => resolve({ proc: fakeProc(), handle }), 20);
      });
    });
    const pool = makePool(startServer);

    const [plain, bridged] = await Promise.all([pool.ensure(ROOT), pool.ensure(ROOT, { CW_BRIDGE: "1" })]);

    expect(calls).toBe(2);
    expect(plain.port).toBe(40001);
    expect(bridged.port).toBe(40002);
    pool.dispose();
  });

  it("shares one spawn when multiple concurrent callers request the same different env", async () => {
    let calls = 0;
    const handles: ServerHandle[] = [
      { port: 40001, authHeader: "a" },
      { port: 40002, authHeader: "b" },
      { port: 40003, authHeader: "c" }
    ];
    const startServer = vi.fn(() => {
      calls += 1;
      const handle = handles[calls - 1];
      return new Promise<{ proc: ChildProcess; handle: ServerHandle }>((resolve) => {
        setTimeout(() => resolve({ proc: fakeProc(), handle }), 20);
      });
    });
    const pool = makePool(startServer);
    const env = { CW_BRIDGE: "1" };

    const [plain, first, second] = await Promise.all([
      pool.ensure(ROOT),
      pool.ensure(ROOT, env),
      pool.ensure(ROOT, env)
    ]);

    expect(calls).toBe(2);
    expect(plain.port).toBe(40001);
    expect(second).toBe(first);
    expect(first.port).toBe(40002);
    pool.dispose();
  });

  it("shares one server when concurrent ensures differ only by session-unique env", async () => {
    const startServer = vi.fn(
      (_rootPath: string, _binary: string, env: Record<string, string> | undefined): Promise<{ proc: ChildProcess; handle: ServerHandle }> =>
        Promise.resolve({ proc: fakeProc(), handle: HANDLE })
    );
    const pool = makePool(startServer);

    const [a, b] = await Promise.all([
      pool.ensure(ROOT, { CW_WORKTREE_PATH: ROOT, CW_SESSION_ID: "s1" }),
      pool.ensure(ROOT, { CW_WORKTREE_PATH: ROOT, CW_SESSION_ID: "s2" })
    ]);

    expect(startServer).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(startServer.mock.calls[0][2]).toEqual({ CW_WORKTREE_PATH: ROOT });
    pool.dispose();
  });

  it("does not retain raw env values in the pool key", async () => {
    const startServer = vi.fn(
      (): Promise<{ proc: ChildProcess; handle: ServerHandle }> => Promise.resolve({ proc: fakeProc(), handle: HANDLE })
    );
    const pool = makePool(startServer);

    await pool.ensure(ROOT, { CW_TOKEN: "super-secret" });

    const entry = [...(pool as unknown as { servers: Map<string, { envKey: string }> }).servers.values()][0];
    expect(entry.envKey).not.toContain("super-secret");
    pool.dispose();
  });

  it("evicts a server idle beyond the threshold on the next ensure", async () => {
    const startServer = vi.fn(
      (rootPath: string, _binary: string, _env: Record<string, string> | undefined): Promise<{ proc: ChildProcess; handle: ServerHandle }> =>
        Promise.resolve({ proc: fakeProc(), handle: HANDLE })
    );
    const pool = new OpencodeServerPool(() => "opencode", { startServer, idleTimeoutMs: -1 });

    await pool.ensure(ROOT);
    await pool.ensure("C:\\fake\\other");

    expect(startServer).toHaveBeenCalledTimes(2);
    expect(startServer.mock.calls.map((call) => call[0])).toEqual([ROOT, "C:\\fake\\other"]);
    await pool.ensure(ROOT);
    expect(startServer).toHaveBeenCalledTimes(3);
    pool.dispose();
  });

  it("caps total servers with LRU eviction", async () => {
    const startServer = vi.fn(
      (): Promise<{ proc: ChildProcess; handle: ServerHandle }> => Promise.resolve({ proc: fakeProc(), handle: HANDLE })
    );
    const pool = new OpencodeServerPool(() => "opencode", { startServer, maxServers: 1 });

    const first = await pool.ensure("C:\\fake\\a");
    const second = await pool.ensure("C:\\fake\\b");
    expect(second).toBe(first);

    await pool.ensure("C:\\fake\\a");
    expect(startServer).toHaveBeenCalledTimes(3);
    pool.dispose();
  });

  it("never evicts a server with an in-flight turn", async () => {
    const startServer = vi.fn(
      (): Promise<{ proc: ChildProcess; handle: ServerHandle }> => Promise.resolve({ proc: fakeProc(), handle: HANDLE })
    );
    const pool = new OpencodeServerPool(() => "opencode", { startServer, maxServers: 1, idleTimeoutMs: -1 });

    await pool.ensure("C:\\fake\\a");
    pool.beginTurn("C:\\fake\\a");
    await pool.ensure("C:\\fake\\b");
    expect(startServer).toHaveBeenCalledTimes(2);

    await pool.ensure("C:\\fake\\a");
    expect(startServer).toHaveBeenCalledTimes(2);
    pool.endTurn("C:\\fake\\a");
    pool.dispose();
  });

  it("reuses a server with mismatched env while a turn is in flight", async () => {
    const handles: ServerHandle[] = [
      { port: 40001, authHeader: "a" },
      { port: 40002, authHeader: "b" }
    ];
    let calls = 0;
    const startServer = vi.fn(() => {
      calls += 1;
      return Promise.resolve({ proc: fakeProc(), handle: handles[calls - 1] });
    });
    const pool = makePool(startServer);

    await pool.ensure(ROOT);
    pool.beginTurn(ROOT);
    const duringTurn = await pool.ensure(ROOT, { CW_BRIDGE: "1" });
    expect(duringTurn.port).toBe(40001);
    expect(startServer).toHaveBeenCalledTimes(1);

    pool.endTurn(ROOT);
    const afterTurn = await pool.ensure(ROOT, { CW_BRIDGE: "1" });
    expect(afterTurn.port).toBe(40002);
    expect(startServer).toHaveBeenCalledTimes(2);
    pool.dispose();
  });

  it("rejects an in-flight spawn when disposed and never caches it", async () => {
    const startServer = vi.fn(
      (): Promise<{ proc: ChildProcess; handle: ServerHandle }> =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ proc: fakeProc(), handle: HANDLE }), 50);
        })
    );
    const pool = makePool(startServer);

    const inFlight = pool.ensure(ROOT);
    pool.dispose();
    await expect(inFlight).rejects.toThrow("opencode server pool disposed");
    await expect(pool.ensure(ROOT)).rejects.toThrow("opencode server pool disposed");
    expect(startServer).toHaveBeenCalledTimes(1);
  });
});
